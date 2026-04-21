//! Frame capture.
//!
//! We don't poll `xcrun simctl io screenshot` any more. Instead we spawn
//! `axe stream-video --format raw` as a long-lived subprocess and read
//! length-prefixed JPEG frames from its stdout. `axe` uses Meta's
//! `FBSimulatorControl` framework, which in turn talks to the
//! `SimDevice`/`SimDeviceIOClient` private APIs — the same plumbing
//! `idb` uses. The net effect:
//!
//!   - one subprocess per session instead of one per frame,
//!   - no PNG → JPEG re-encode in sim-server (axe emits JPEG directly),
//!   - no temp files,
//!   - frames arrive at whatever FPS we request, without
//!     `xcrun simctl` spawning overhead.
//!
//! The even faster `--format bgra` path would give us a true push-based
//! IOSurface feed from the simulator's framebuffer (no screenshot loop
//! at all). That's a future step; this module keeps the wire protocol
//! to the HTTP layer identical (`Arc<Vec<u8>>` of JPEG bytes), so we can
//! swap in BGRA later without changing anything above.

use std::sync::Arc;
use std::time::{Duration, Instant};
use log::{debug, error, info};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{broadcast, watch};

/// Main capture loop. Spawns `axe stream-video --format raw` and relays
/// JPEG frames from its stdout into the broadcast + watch channels used
/// by the HTTP layer. Restarts the subprocess with exponential backoff
/// on unexpected exit.
pub async fn run_capture_loop(
    udid: String,
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: watch::Sender<Option<Arc<Vec<u8>>>>,
    fps: u32,
    quality: u8,
) -> anyhow::Result<()> {
    // `axe stream-video --scale` can down-res the output to save CPU /
    // bandwidth. 1.0 = native retina resolution (huge), 0.5 = half per
    // axis (quarter the bytes). Default to 0.5 unless the user asked for
    // high quality via --quality.
    let scale: f32 = if quality >= 90 { 1.0 } else { 0.5 };

    let mut backoff = Duration::from_millis(500);
    let mut total_frames: u64 = 0;

    loop {
        match stream_with_axe(&udid, fps, quality, scale, &frame_tx, &latest_tx, &mut total_frames)
            .await
        {
            Ok(()) => {
                info!("axe stream-video exited cleanly; retrying in {:?}", backoff);
            }
            Err(e) => {
                error!("axe stream-video error: {} (retrying in {:?})", e, backoff);
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(5));
    }
}

async fn stream_with_axe(
    udid: &str,
    fps: u32,
    quality: u8,
    scale: f32,
    frame_tx: &broadcast::Sender<Arc<Vec<u8>>>,
    latest_tx: &watch::Sender<Option<Arc<Vec<u8>>>>,
    total_frames: &mut u64,
) -> anyhow::Result<()> {
    info!(
        "Starting axe stream-video fps={} quality={} scale={}",
        fps, quality, scale
    );

    let mut child = Command::new("axe")
        .args([
            "stream-video",
            "--format",
            "raw",
            "--fps",
            &fps.to_string(),
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

    // Tee stderr to log so the user can see throughput / errors.
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!("[axe] {}", line);
            }
        });
    }

    let mut last_log = Instant::now();
    let mut window_frames: u64 = 0;
    let mut first_frame = true;

    loop {
        // 4-byte big-endian length header, then that many JPEG bytes.
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
                "First axe frame received ({} bytes) — stream is live",
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
