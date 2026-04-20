use std::sync::Arc;
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use log::warn;
use tokio::sync::{broadcast, watch};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::input;

#[derive(Clone)]
pub struct AppState {
    pub frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
    pub latest_rx: watch::Receiver<Option<Arc<Vec<u8>>>>,
    pub udid: Arc<String>,
}

pub fn build_router(
    frame_tx: broadcast::Sender<Arc<Vec<u8>>>,
    latest_rx: watch::Receiver<Option<Arc<Vec<u8>>>>,
    udid: String,
) -> Router {
    let state = AppState {
        frame_tx,
        latest_rx,
        udid: Arc::new(udid),
    };

    Router::new()
        .route("/stream.mjpeg", get(mjpeg_stream))
        .route("/snapshot.jpg", get(snapshot))
        .route("/api/tree", get(describe_ui_route))
        .route("/health", get(health))
        .with_state(state)
}

/// `/api/tree` — returns the raw `axe describe-ui` JSON for the booted
/// simulator. The browser polls this on boot (and on demand) to populate
/// the Layers panel with real iOS accessibility frames, without waiting
/// for the user to click-inspect a React component.
async fn describe_ui_route(State(state): State<AppState>) -> impl IntoResponse {
    match input::describe_ui(&state.udid).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .unwrap(),
        Err(e) => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(Body::from(format!("axe describe-ui failed: {}", e)))
            .unwrap(),
    }
}

/// Health check endpoint
async fn health() -> impl IntoResponse {
    "ok"
}

/// Single JPEG snapshot endpoint - uses watch channel for latest frame
async fn snapshot(State(state): State<AppState>) -> impl IntoResponse {
    // Try to get latest frame, or wait for one
    let mut rx = state.latest_rx.clone();
    // First check current value
    {
        let latest = rx.borrow().clone();
        if let Some(frame) = latest {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "image/jpeg")
                .header(header::CONTENT_LENGTH, frame.len().to_string())
                .body(Body::from(frame.as_ref().clone()))
                .unwrap();
        }
    }
    // Wait for next frame (up to 5 seconds)
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx.changed()).await {
        Ok(Ok(())) => {
            let latest = rx.borrow().clone();
            if let Some(frame) = latest {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "image/jpeg")
                    .header(header::CONTENT_LENGTH, frame.len().to_string())
                    .body(Body::from(frame.as_ref().clone()))
                    .unwrap();
            }
        }
        _ => {}
    }
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .body(Body::from("No frame available"))
        .unwrap()
}

/// MJPEG stream endpoint
async fn mjpeg_stream(State(state): State<AppState>) -> impl IntoResponse {
    let rx = state.frame_tx.subscribe();
    let stream = BroadcastStream::new(rx);

    let body_stream = stream.filter_map(|result| {
        match result {
            Ok(frame) => {
                // Build MJPEG frame with boundary
                let mut buf = Vec::with_capacity(frame.len() + 128);
                buf.extend_from_slice(b"--frame\r\n");
                buf.extend_from_slice(b"Content-Type: image/jpeg\r\n");
                buf.extend_from_slice(
                    format!("Content-Length: {}\r\n", frame.len()).as_bytes(),
                );
                buf.extend_from_slice(b"\r\n");
                buf.extend_from_slice(&frame);
                buf.extend_from_slice(b"\r\n");
                Some(Ok::<_, std::io::Error>(bytes::Bytes::from(buf)))
            }
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                warn!("MJPEG client lagged by {} frames", n);
                None
            }
        }
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "multipart/x-mixed-replace; boundary=frame",
        )
        .header(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(body_stream))
        .unwrap()
}
