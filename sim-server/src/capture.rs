//! Frame capture.
//!
//! Two pipelines, selected at runtime:
//!
//! **Default: `axe stream-video --format raw`** — long-lived axe
//! subprocess that spits JPEG frames on its stdout with a 4-byte length
//! prefix per frame. Runs the FBSimulatorControl screenshot loop inside
//! axe at a steady FPS. Reliable, small JPEGs already encoded, no work
//! in sim-server. This replaces our old "fork simctl every frame"
//! caveman loop and is the default because it produces frames at a
//! predictable rate even when the simulator is idle.
//!
//! **Opt-in: `axe stream-video --format bgra`** (SP_CAPTURE=bgra) — a
//! real push-based framebuffer stream via `FBVideoStreamConfiguration`
//! and `SimDeviceIOClient`. Frames arrive only when the simulator
//! actually renders, not on a timer. Huge CPU win when the app is
//! driving animations, but in practice axe's BGRA stream tends to
//! stall after the first frame when the simulator is idle (IOSurface
//! callback doesn't fire until the next real render). We keep the code
//! path behind an env var so anyone who wants 60fps push-streaming for
//! an animation-heavy app can flip it on, while the default stays
//! robust.
//!
//! Either way, sim-server emits `Arc<Vec<u8>>` JPEG bytes on the same
//! broadcast channel the HTTP layer reads from — the MJPEG stream
//! endpoint is unchanged.

use std::sync::Arc;
use std::time::{Duration, Instant};
use log::{debug, error, info, warn};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{broadcast, watch};

#[derive(Clone, Copy, Debug)]
enum CaptureMode {
    /// True framebuffer stream, BGRA → JPEG.
    Bgra,
    /// axe's screenshot-polling fallback, already-JPEG frames.
    Mjpeg,
}

impl CaptureMode {
    fn from_env() -> Self {
        match std::env::var("SP_CAPTURE").ok().as_deref() {
            Some("bgra") | Some("framebuffer") => Self::Bgra,
            _ => Self::Mjpeg,
        }
    }
}

pub async fn run_capture_loop(
    udid: String,
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: watch::Sender<Option<Arc<Vec<u8>>>>,
    fps: u32,
    quality: u8,
) -> anyhow::Result<()> {
    let mode = CaptureMode::from_env();
    info!("capture mode = {:?}", mode);

    // Default scale 0.33 = native retina / 3 = **one device-point per pixel**.
    //
    // That's the resolution the browser actually displays the sim at (our
    // preview element is ~400×870 CSS px, the iPhone 17 Pro is 402×874 pt).
    // Encoding anything bigger just wastes bytes: the browser downsamples
    // it before painting, and click / touch coordinates are carried as
    // [0, 1] ratios — they don't care about pixel count at all.
    //
    // Override with `SP_SCALE` for high-DPI recordings:
    //   0.33 = 1 pt ↔ 1 px   (default, ~0.35 MP/frame on iPhone 17 Pro)
    //   0.50 = 1.5× retina   (0.79 MP/frame)
    //   1.00 = native retina (3.16 MP/frame)
    let scale: f32 = match std::env::var("SP_SCALE").ok().and_then(|s| s.parse().ok()) {
        Some(s) if (0.1..=1.0).contains(&s) => s,
        _ => 0.33,
    };

    let mut backoff = Duration::from_millis(500);
    let mut total_frames: u64 = 0;

    loop {
        let res = match mode {
            CaptureMode::Bgra => {
                stream_bgra(&udid, fps, quality, scale, &frame_tx, &latest_tx, &mut total_frames)
                    .await
            }
            CaptureMode::Mjpeg => {
                stream_mjpeg(&udid, fps, quality, scale, &frame_tx, &latest_tx, &mut total_frames)
                    .await
            }
        };
        match res {
            Ok(()) => info!("axe stream exited cleanly; retrying in {:?}", backoff),
            Err(e) => error!("axe stream error: {} (retrying in {:?})", e, backoff),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}

// ---------------------------------------------------------------------------
// BGRA framebuffer path (preferred).
// ---------------------------------------------------------------------------

/// Probe the simulator's native pixel dimensions by taking one screenshot
/// and parsing the PNG IHDR chunk. No heavyweight image crate needed —
/// the first 24 bytes of a PNG are enough.
async fn probe_native_size(udid: &str) -> anyhow::Result<(u32, u32)> {
    let tmp = format!("/tmp/axe-probe-{}.png", std::process::id());
    let out = Command::new("axe")
        .args(["screenshot", "--udid", udid, "--output", &tmp])
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("axe screenshot failed: {}", stderr.trim());
    }
    let bytes = tokio::fs::read(&tmp).await?;
    let _ = tokio::fs::remove_file(&tmp).await;

    // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
    if bytes.len() < 24 {
        anyhow::bail!("probe PNG too short ({} bytes)", bytes.len());
    }
    const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes[..8] != PNG_SIG || &bytes[12..16] != b"IHDR" {
        anyhow::bail!("probe file is not a valid PNG");
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    Ok((w, h))
}

/// Launch a low-rate screenshot keepalive that only publishes a frame
/// when the BGRA stream has gone silent for longer than `idle_threshold`.
/// This fills the "idle sim = blank preview" gap without stepping on
/// BGRA frames during active rendering.
fn spawn_screenshot_keepalive(
    udid: String,
    last_frame_at: Arc<Mutex<Instant>>,
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: watch::Sender<Option<Arc<Vec<u8>>>>,
    idle_threshold: Duration,
) {
    tokio::spawn(async move {
        // Tick at half the idle threshold so we detect a gap quickly.
        let tick = (idle_threshold / 2).max(Duration::from_millis(120));
        let mut ticker = tokio::time::interval(tick);
        loop {
            ticker.tick().await;
            let idle = {
                let last = last_frame_at.lock().unwrap();
                last.elapsed()
            };
            if idle < idle_threshold {
                continue;
            }
            // Idle for too long — grab a screenshot so the preview doesn't
            // look frozen. axe screenshot gives us a PNG; the stream
            // consumer wants JPEG, so we convert with jpeg-encoder after
            // manually peeling pixels out of the PNG. To stay
            // dependency-light we shell out to `axe screenshot` with a
            // small on-disk cache.
            match take_screenshot_jpeg(&udid).await {
                Ok(bytes) => {
                    let arc = Arc::new(bytes);
                    let _ = frame_tx.send(arc.clone());
                    let _ = latest_tx.send(Some(arc));
                    let mut last = last_frame_at.lock().unwrap();
                    *last = Instant::now();
                    debug!("keepalive: emitted screenshot after {:?} idle", idle);
                }
                Err(e) => {
                    debug!("keepalive: screenshot failed: {}", e);
                }
            }
        }
    });
}

/// Ask axe for a PNG screenshot, decode with the `png` crate, then
/// re-encode as JPEG using `jpeg-encoder` so the keepalive frame uses
/// the same wire format (image/jpeg) as the rest of the stream. Small
/// scale is applied post-encode by just accepting whatever axe gives
/// us at native retina — keepalive fires at most once every 1.5s so
/// the extra bytes are negligible.
async fn take_screenshot_jpeg(udid: &str) -> anyhow::Result<Vec<u8>> {
    let tmp = format!("/tmp/axe-keepalive-{}.png", std::process::id());
    let out = Command::new("axe")
        .args(["screenshot", "--udid", udid, "--output", &tmp])
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("axe screenshot failed: {}", stderr.trim());
    }
    let png_bytes = tokio::fs::read(&tmp).await?;
    let _ = tokio::fs::remove_file(&tmp).await;

    tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let decoder = png::Decoder::new(std::io::Cursor::new(&png_bytes));
        let mut reader = decoder.read_info()?;
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf)?;
        // jpeg-encoder ColorType variants we might hit from axe's PNG
        // output. Common: Rgb / Rgba / Grayscale.
        let color = match info.color_type {
            png::ColorType::Rgb => jpeg_encoder::ColorType::Rgb,
            png::ColorType::Rgba => jpeg_encoder::ColorType::Rgba,
            png::ColorType::Grayscale => jpeg_encoder::ColorType::Luma,
            other => anyhow::bail!("unsupported PNG color type {:?}", other),
        };
        let mut jpeg = Vec::with_capacity(info.buffer_size() / 4);
        let encoder = jpeg_encoder::Encoder::new(&mut jpeg, 70);
        encoder.encode(&buf[..info.buffer_size()], info.width as u16, info.height as u16, color)?;
        Ok(jpeg)
    })
    .await?
}

use std::sync::Mutex;

async fn stream_bgra(
    udid: &str,
    _fps: u32,
    quality: u8,
    scale: f32,
    frame_tx: &broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: &watch::Sender<Option<Arc<Vec<u8>>>>,
    total_frames: &mut u64,
) -> anyhow::Result<()> {
    let (native_w, native_h) = probe_native_size(udid).await?;
    // axe's internal scaling rounds dimensions; match with `round()` and
    // clamp to at least 2 px on each axis.
    let w = ((native_w as f32 * scale).round() as u32).max(2);
    let h = ((native_h as f32 * scale).round() as u32).max(2);
    let frame_bytes = (w as usize) * (h as usize) * 4;
    info!(
        "BGRA stream: native={}x{} scale={} → target={}x{} ({} bytes/frame)",
        native_w, native_h, scale, w, h, frame_bytes
    );

    // Shared "last frame arrived at" timestamp. The screenshot keepalive
    // task reads this; the BGRA read loop updates it.
    //
    // Aggressive threshold (300ms = ~3fps floor) because axe's BGRA
    // push-stream is unreliable on current iOS simulators — it often
    // produces only the first frame and then stalls even under active
    // rendering. With a 300ms threshold the preview keeps refreshing via
    // screenshots whenever BGRA goes quiet; when BGRA does produce
    // frames (animation-heavy apps, scrolling) it runs much faster and
    // the keepalive stays silent.
    let last_frame_at = Arc::new(Mutex::new(Instant::now()));
    spawn_screenshot_keepalive(
        udid.to_string(),
        last_frame_at.clone(),
        frame_tx.clone(),
        latest_tx.clone(),
        Duration::from_millis(300),
    );

    let mut child = Command::new("axe")
        .args([
            "stream-video",
            "--format",
            "bgra",
            "--scale",
            &format!("{:.2}", scale),
            "--quality",
            &quality.to_string(),
            "--udid",
            udid,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("axe stdout missing"))?;

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!("[axe bgra] {}", line);
            }
        });
    }

    let mut last_log = Instant::now();
    let mut window_frames: u64 = 0;
    let mut first_frame = true;
    let mut pixel_buf = vec![0u8; frame_bytes];

    loop {
        if let Err(e) = stdout.read_exact(&mut pixel_buf).await {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                return Ok(());
            }
            return Err(e.into());
        }

        // BGRA → JPEG using a tiny pure-Rust encoder running on a blocking
        // worker. `jpeg-encoder` accepts BGRA directly; no pixel reshuffle.
        let pixels = pixel_buf.clone();
        let w16 = w as u16;
        let h16 = h as u16;
        let q = quality;
        let jpeg = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
            let mut out = Vec::with_capacity(pixels.len() / 4);
            let encoder = jpeg_encoder::Encoder::new(&mut out, q);
            encoder.encode(&pixels, w16, h16, jpeg_encoder::ColorType::Bgra)?;
            Ok(out)
        })
        .await??;

        if first_frame {
            info!(
                "First BGRA frame encoded → JPEG {} bytes — stream is live",
                jpeg.len()
            );
            first_frame = false;
        }

        let arc = Arc::new(jpeg);
        let _ = frame_tx.send(arc.clone());
        let _ = latest_tx.send(Some(arc));
        *total_frames += 1;
        window_frames += 1;
        // Reset the keepalive clock so we don't emit a redundant
        // screenshot right after a real BGRA frame.
        if let Ok(mut last) = last_frame_at.lock() {
            *last = Instant::now();
        }

        if last_log.elapsed() >= Duration::from_secs(5) {
            let actual = window_frames as f64 / last_log.elapsed().as_secs_f64();
            info!(
                "Capture FPS: {:.1} (total frames: {})",
                actual, *total_frames
            );
            last_log = Instant::now();
            window_frames = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// MJPEG / raw fallback.
// ---------------------------------------------------------------------------

async fn stream_mjpeg(
    udid: &str,
    fps: u32,
    quality: u8,
    scale: f32,
    frame_tx: &broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: &watch::Sender<Option<Arc<Vec<u8>>>>,
    total_frames: &mut u64,
) -> anyhow::Result<()> {
    // axe stream-video --format raw refuses fps > 30 (hard validation in
    // the tool). If the caller asked for higher, silently clamp — higher
    // rates require the BGRA path.
    let axe_fps = fps.min(30);
    info!(
        "MJPEG stream: fps={} (requested={}) quality={} scale={}",
        axe_fps, fps, quality, scale
    );
    let mut child = Command::new("axe")
        .args([
            "stream-video",
            "--format",
            "raw",
            "--fps",
            &axe_fps.to_string(),
            "--quality",
            &quality.to_string(),
            "--scale",
            &format!("{:.2}", scale),
            "--udid",
            udid,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("axe stdout missing"))?;

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!("[axe mjpeg] {}", line);
            }
        });
    }

    let mut last_log = Instant::now();
    let mut window_frames: u64 = 0;
    let mut first_frame = true;

    loop {
        let mut len_buf = [0u8; 4];
        if let Err(e) = stdout.read_exact(&mut len_buf).await {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                return Ok(());
            }
            return Err(e.into());
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > 64 * 1024 * 1024 {
            anyhow::bail!("bogus frame length from axe: {}", len);
        }
        let mut jpeg = vec![0u8; len];
        stdout.read_exact(&mut jpeg).await?;

        if first_frame {
            info!(
                "First axe MJPEG frame received ({} bytes) — stream is live",
                jpeg.len()
            );
            first_frame = false;
        }

        let arc = Arc::new(jpeg);
        let _ = frame_tx.send(arc.clone());
        let _ = latest_tx.send(Some(arc));
        *total_frames += 1;
        window_frames += 1;

        if last_log.elapsed() >= Duration::from_secs(5) {
            let actual = window_frames as f64 / last_log.elapsed().as_secs_f64();
            info!(
                "Capture FPS: {:.1} (total frames: {})",
                actual, *total_frames
            );
            last_log = Instant::now();
            window_frames = 0;
        }
    }
}

// Silence the dead-code warning in MJPEG-only builds.
#[allow(dead_code)]
fn _suppress() {
    let _ = warn!("");
}
