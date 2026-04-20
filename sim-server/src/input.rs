//! stdin-command driven simulator input.
//!
//! This module speaks the legacy wire protocol used by `server.js`:
//!
//! ```text
//! touch <tap|down|up|move> <x_ratio>,<y_ratio>
//! touch swipe <x1>,<y1> <x2>,<y2>
//! swipe <x1>,<y1> <x2>,<y2> [duration_s]
//! key [Down|Up] <hid_keycode | rotate>
//! button [Down|Up] <home|lock|power|side-button|siri|apple-pay>
//! multitask                     // app switcher (swipe-up-and-hold)
//! type <text...>                // printable chars via axe type
//! screenshot <path>
//! refresh_window                 // invalidate device-size cache
//! ```
//!
//! Coordinates are normalised [0, 1] ratios of the simulator display. The
//! `direction` tokens on `key` / `button` are optional — when present they
//! are stripped before passing the target to `axe`.
//!
//! Under the hood, every input operation shells out to [`axe`]
//! (https://github.com/cameroncooke/AXe), which drives Simulator.app via the
//! same `FBSimulatorControl` / `CoreSimulator` APIs `idb` uses. `axe` is
//! cursor-free by design: tapping the sim never moves the macOS pointer,
//! Simulator.app doesn't need to be frontmost, and the coordinate system is
//! device points, not Mac-screen pixels.
//!
//! Ratio → device-point conversion uses the root `AXFrame` returned by
//! `axe describe-ui`, cached in a `DashMap`-free `Mutex`. This makes every
//! tap self-calibrating to whichever device is booted and whatever
//! orientation it's in — no baked bezel ratios, no CGEvent, no osascript.

use log::{debug, error, info, warn};
use serde::Deserialize;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};

/// How long a cached device-size reading is considered fresh before we
/// re-run `axe describe-ui`. Rotations / app swaps are rare so a few seconds
/// is plenty.
const DEVICE_SIZE_TTL: Duration = Duration::from_secs(5);

/// Cached device screen size in device points. `None` until the first
/// successful `axe describe-ui` call.
static DEVICE_SIZE: Mutex<Option<DeviceSize>> = Mutex::new(None);

#[derive(Copy, Clone, Debug)]
struct DeviceSize {
    width: f64,
    height: f64,
    at: Instant,
}

/// Minimal AX node shape — we only need the outer frame of the root
/// Application node to map ratio → device points. The real tree has many
/// more fields; serde ignores unknown keys.
#[derive(Debug, Deserialize)]
struct AxNode {
    frame: Option<AxFrame>,
    #[serde(default)]
    children: Vec<AxNode>,
}

#[derive(Debug, Deserialize)]
struct AxFrame {
    #[allow(dead_code)]
    x: f64,
    #[allow(dead_code)]
    y: f64,
    width: f64,
    height: f64,
}

/// Run `axe describe-ui` and return the parsed tree as raw JSON bytes. We
/// expose the raw JSON through the HTTP endpoint (`/api/tree`) so the UI
/// can build its layer hierarchy without a second schema.
pub async fn describe_ui(udid: &str) -> anyhow::Result<Vec<u8>> {
    let output = tokio::process::Command::new("axe")
        .args(["describe-ui", "--udid", udid])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("axe describe-ui failed: {}", stderr.trim());
    }
    Ok(output.stdout)
}

/// Fetch the current device size in device points, honouring the TTL cache.
async fn device_size(udid: &str) -> Option<(f64, f64)> {
    {
        let cache = DEVICE_SIZE.lock().unwrap();
        if let Some(d) = *cache {
            if d.at.elapsed() < DEVICE_SIZE_TTL {
                return Some((d.width, d.height));
            }
        }
    }

    let bytes = match describe_ui(udid).await {
        Ok(b) => b,
        Err(e) => {
            warn!("axe describe-ui failed while resolving device size: {}", e);
            return None;
        }
    };

    // describe-ui returns a top-level array. The first element is the
    // Application — its frame is the device screen.
    let nodes: Vec<AxNode> = match serde_json::from_slice(&bytes) {
        Ok(n) => n,
        Err(e) => {
            warn!("Could not parse describe-ui JSON: {}", e);
            return None;
        }
    };
    let (w, h) = nodes
        .first()
        .and_then(|n| n.frame.as_ref())
        .map(|f| (f.width, f.height))
        .or_else(|| {
            // Some app setups nest the visible frame one level deeper.
            nodes
                .first()
                .and_then(|n| n.children.first())
                .and_then(|n| n.frame.as_ref())
                .map(|f| (f.width, f.height))
        })?;

    *DEVICE_SIZE.lock().unwrap() = Some(DeviceSize {
        width: w,
        height: h,
        at: Instant::now(),
    });
    info!("Device size resolved: {:.0}×{:.0} pt", w, h);
    Some((w, h))
}

/// Convert a [0, 1] sim-ratio pair to device points.
async fn ratio_to_points(udid: &str, x_ratio: f64, y_ratio: f64) -> Option<(f64, f64)> {
    let (w, h) = device_size(udid).await?;
    Some((x_ratio.clamp(0.0, 1.0) * w, y_ratio.clamp(0.0, 1.0) * h))
}

/// Run an `axe` subcommand. Logs stderr on failure, returns `Ok(())` either
/// way — failed subprocess calls shouldn't crash the server.
async fn run_axe(args: &[&str]) -> anyhow::Result<()> {
    debug!("axe {}", args.join(" "));
    let output = tokio::process::Command::new("axe")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!("axe {} failed: {}", args[0], stderr.trim());
    }
    Ok(())
}

pub async fn read_stdin_commands(udid: String) {
    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    info!("Listening for commands on stdin...");

    // Kick off device-size resolution eagerly so the first tap is instant.
    {
        let u = udid.clone();
        tokio::spawn(async move {
            let _ = device_size(&u).await;
        });
    }

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let udid = udid.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_command(&udid, &line).await {
                error!("Command error: {} (command: {})", e, line);
            }
        });
    }

    info!("Stdin closed, no more commands");
}

async fn handle_command(udid: &str, line: &str) -> anyhow::Result<()> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.is_empty() {
        return Ok(());
    }

    match parts[0] {
        "touch" => {
            // `touch <action> <coords...>`
            if parts.len() < 3 {
                return Ok(());
            }
            let action = parts[1];
            if action.eq_ignore_ascii_case("swipe") {
                if parts.len() < 4 {
                    return Ok(());
                }
                let duration = parts.get(4).and_then(|s| s.parse::<f64>().ok());
                handle_swipe(udid, parts[2], parts[3], duration).await?;
            } else {
                handle_touch(udid, action, parts[2]).await?;
            }
        }
        "swipe" => {
            if parts.len() < 3 {
                return Ok(());
            }
            let duration = parts.get(3).and_then(|s| s.parse::<f64>().ok());
            handle_swipe(udid, parts[1], parts[2], duration).await?;
        }
        "multitask" | "app-switcher" | "appswitcher" => {
            handle_multitask(udid).await?;
        }
        "type" => {
            // Everything after `type ` is the text to send. We
            // deliberately re-slice from the original line so spaces
            // and punctuation survive.
            if let Some(rest) = line.strip_prefix("type ") {
                handle_type(udid, rest).await?;
            }
        }
        "key" => {
            // `key <keycode>` or `key <Down|Up> <keycode>` (legacy direction
            // token is ignored — axe handles the press+release internally).
            let keycode = strip_direction(&parts[1..]);
            if let Some(k) = keycode {
                handle_key(udid, k).await?;
            }
        }
        "button" => {
            let button = strip_direction(&parts[1..]);
            if let Some(b) = button {
                handle_button(udid, b).await?;
            }
        }
        "rotate" => {
            // `rotate Portrait|LandscapeLeft|LandscapeRight|...`
            // axe doesn't have a first-class rotate command; fall through to
            // xcrun simctl, which does.
            if parts.len() >= 2 {
                handle_rotate(udid, parts[1]).await?;
            }
        }
        "screenshot" => {
            let path = if parts.len() >= 2 { parts[1] } else { "screenshot.png" };
            handle_screenshot(udid, path).await?;
        }
        "refresh_window" => {
            // Legacy: force a re-read of the device size on the next tap.
            *DEVICE_SIZE.lock().unwrap() = None;
            info!("Device size cache invalidated");
        }
        _ => {
            warn!("Unknown command: {}", parts[0]);
        }
    }

    Ok(())
}

/// Peel off a leading `Down`/`Up` modifier token if present. Returns the
/// primary argument (keycode / button name).
fn strip_direction<'a>(rest: &'a [&'a str]) -> Option<&'a str> {
    match rest {
        [first] => Some(*first),
        [first, second, ..] => {
            if first.eq_ignore_ascii_case("Down") || first.eq_ignore_ascii_case("Up") {
                Some(*second)
            } else {
                Some(*first)
            }
        }
        _ => None,
    }
}

async fn handle_touch(udid: &str, action: &str, coords: &str) -> anyhow::Result<()> {
    let (x_ratio, y_ratio) = parse_ratio_pair(coords)?;
    let Some((x, y)) = ratio_to_points(udid, x_ratio, y_ratio).await else {
        warn!("Cannot inject touch: device size unavailable");
        return Ok(());
    };
    debug!("touch {} at ({:.1}, {:.1}) pt", action, x, y);

    let udid_s = udid.to_string();
    let x_s = format!("{:.3}", x);
    let y_s = format!("{:.3}", y);

    match action.to_lowercase().as_str() {
        "tap" => {
            run_axe(&["tap", "-x", &x_s, "-y", &y_s, "--udid", &udid_s]).await?;
        }
        "down" => {
            run_axe(&["touch", "-x", &x_s, "-y", &y_s, "--down", "--udid", &udid_s]).await?;
        }
        "up" => {
            run_axe(&["touch", "-x", &x_s, "-y", &y_s, "--up", "--udid", &udid_s]).await?;
        }
        "move" => {
            // axe doesn't expose a bare "move" step outside a batch; emit a
            // zero-delay down+up at the new coordinate so the app sees the
            // pointer update. This isn't a true drag path — for drags, use
            // the `swipe` command.
            run_axe(&["touch", "-x", &x_s, "-y", &y_s, "--up", "--udid", &udid_s]).await?;
        }
        _ => {}
    }

    Ok(())
}

async fn handle_swipe(
    udid: &str,
    start: &str,
    end: &str,
    duration_s: Option<f64>,
) -> anyhow::Result<()> {
    let (sx, sy) = parse_ratio_pair(start)?;
    let (ex, ey) = parse_ratio_pair(end)?;
    let Some((x1, y1)) = ratio_to_points(udid, sx, sy).await else {
        warn!("Cannot inject swipe: device size unavailable");
        return Ok(());
    };
    let Some((x2, y2)) = ratio_to_points(udid, ex, ey).await else {
        warn!("Cannot inject swipe: device size unavailable");
        return Ok(());
    };
    debug!(
        "swipe ({:.1},{:.1}) → ({:.1},{:.1}) pt (dur={:?})",
        x1, y1, x2, y2, duration_s
    );
    let dur_s = duration_s.unwrap_or(0.25).to_string();
    run_axe(&[
        "swipe",
        "--start-x",
        &format!("{:.3}", x1),
        "--start-y",
        &format!("{:.3}", y1),
        "--end-x",
        &format!("{:.3}", x2),
        "--end-y",
        &format!("{:.3}", y2),
        "--duration",
        &dur_s,
        "--udid",
        udid,
    ])
    .await?;
    Ok(())
}

/// iPhone-X-style multi-task (app switcher) gesture: swipe up from the
/// bottom edge, pause mid-screen. We emulate the pause with a long
/// `--duration` and a small `--post-delay`, which is enough for SpringBoard
/// to treat it as "switch apps" rather than "go home".
async fn handle_multitask(udid: &str) -> anyhow::Result<()> {
    let Some((w, h)) = device_size(udid).await else {
        warn!("Cannot multitask: device size unavailable");
        return Ok(());
    };
    let x = w / 2.0;
    let y_start = h - 1.0;
    let y_end = h * 0.55;
    debug!("multitask swipe ({:.0},{:.0}) → ({:.0},{:.0}) pt", x, y_start, x, y_end);
    run_axe(&[
        "swipe",
        "--start-x",
        &format!("{:.2}", x),
        "--start-y",
        &format!("{:.2}", y_start),
        "--end-x",
        &format!("{:.2}", x),
        "--end-y",
        &format!("{:.2}", y_end),
        "--duration",
        "0.75",
        "--post-delay",
        "0.25",
        "--udid",
        udid,
    ])
    .await
}

/// Type a string of printable characters through axe. Only US-keyboard
/// characters survive the HID protocol (axe is explicit about this); the
/// caller should pre-filter. For special keys (Return, Backspace, arrow
/// keys) use the `key <hid_keycode>` command.
async fn handle_type(udid: &str, text: &str) -> anyhow::Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    debug!("type {:?}", text);
    // Use --stdin so we never have to worry about the shell escaping text
    // that contains quotes, semicolons, etc.
    let mut child = tokio::process::Command::new("axe")
        .args(["type", "--stdin", "--udid", udid])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(text.as_bytes()).await?;
        // Close stdin so axe stops reading and actually types.
        drop(stdin);
    }
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        warn!("axe type failed: {}", stderr.trim());
    }
    Ok(())
}

fn parse_ratio_pair(s: &str) -> anyhow::Result<(f64, f64)> {
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 2 {
        anyhow::bail!("expected x,y pair, got {:?}", s);
    }
    Ok((parts[0].trim().parse()?, parts[1].trim().parse()?))
}

async fn handle_key(udid: &str, key: &str) -> anyhow::Result<()> {
    // Accept HID keycodes numerically, or a couple of friendly aliases that
    // the old xcrun-based path understood.
    match key.to_lowercase().as_str() {
        "rotate" => {
            // Legacy UI button sends `key rotate`. There's no single "rotate"
            // keycode, so cycle through portrait → landscape-right. Applying
            // via simctl ui is the current best bet.
            let _ = tokio::process::Command::new("xcrun")
                .args(["simctl", "ui", udid, "appearance", "light"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            warn!("key rotate: no-op via axe, use the `rotate` command instead");
            Ok(())
        }
        _ => run_axe(&["key", key, "--udid", udid]).await,
    }
}

async fn handle_button(udid: &str, button: &str) -> anyhow::Result<()> {
    // Map legacy names to axe's vocabulary.
    let lower = button.to_lowercase();
    let b: &str = match lower.as_str() {
        "power" => "lock",
        _ => button,
    };
    run_axe(&["button", b, "--udid", udid]).await
}

async fn handle_rotate(udid: &str, orientation: &str) -> anyhow::Result<()> {
    // axe has no rotate command. Fall back to simctl; invalidate the device
    // size cache so the next tap picks up the new width/height.
    let _ = tokio::process::Command::new("xcrun")
        .args(["simctl", "ui", udid, "orientation", orientation])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;
    *DEVICE_SIZE.lock().unwrap() = None;
    Ok(())
}

async fn handle_screenshot(udid: &str, path: &str) -> anyhow::Result<()> {
    info!("Taking screenshot to: {}", path);
    let output = tokio::process::Command::new("axe")
        .args(["screenshot", "--udid", udid, "--output", path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    if output.status.success() {
        info!("Screenshot saved to: {}", path);
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("Screenshot failed: {}", stderr.trim());
    }
    Ok(())
}
