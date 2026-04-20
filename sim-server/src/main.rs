mod capture;
mod mjpeg;
mod input;

use std::net::SocketAddr;
use std::sync::Arc;
use clap::Parser;
use log::{info, error};
use tokio::sync::{broadcast, watch};

#[derive(Parser, Debug)]
#[command(name = "sim-server", about = "iOS Simulator MJPEG streamer")]
struct Args {
    /// Simulator UDID
    #[arg(long = "id")]
    id: String,

    /// HTTP port to serve MJPEG stream
    #[arg(long, default_value = "0")]
    port: u16,

    /// Target FPS for capture
    #[arg(long, default_value = "30")]
    fps: u32,

    /// JPEG quality (1-100)
    #[arg(long, default_value = "80")]
    quality: u8,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    let args = Args::parse();
    let udid = args.id.clone();
    let fps = args.fps;
    let quality = args.quality;

    // Broadcast channel for JPEG frames - capacity of 4 to allow some buffering
    let (frame_tx, _) = broadcast::channel::<Arc<Vec<u8>>>(4);
    // Watch channel for latest frame (snapshot endpoint)
    let (latest_tx, latest_rx) = watch::channel::<Option<Arc<Vec<u8>>>>(None);
    let frame_tx2 = frame_tx.clone();

    // Start the capture loop in a background task
    let capture_udid = udid.clone();
    tokio::spawn(async move {
        if let Err(e) = capture::run_capture_loop(capture_udid, frame_tx2, latest_tx, fps, quality).await {
            error!("Capture loop error: {}", e);
        }
    });

    // Start the stdin command reader
    let input_udid = udid.clone();
    tokio::spawn(async move {
        input::read_stdin_commands(input_udid).await;
    });

    // Build HTTP server
    let app = mjpeg::build_router(frame_tx.clone(), latest_rx, udid.clone());

    // Bind to the requested port (0 = random available port)
    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let actual_addr = listener.local_addr()?;
    let port = actual_addr.port();

    // Signal that the stream is ready
    println!("stream_ready http://127.0.0.1:{}/stream.mjpeg", port);

    info!("Serving MJPEG stream at http://127.0.0.1:{}/stream.mjpeg", port);
    info!("Simulator UDID: {}", udid);

    axum::serve(listener, app).await?;

    Ok(())
}
