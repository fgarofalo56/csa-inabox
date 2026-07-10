//! CSA Loom — Loom Direct Lake service (HYP-5 skeleton).
//!
//! An internal-ingress Azure Container App (Rust/axum) that is the Azure-native,
//! OSS outcome-equivalent of Fabric's Direct Lake: it FRAMES a Delta/Parquet
//! source (metadata-only version pin) and TRANSCODES scanned columns to an Arrow
//! IPC stream, executing the scan through Apache DataFusion. It contacts NO
//! Fabric / OneLake / Power BI service (`.claude/rules/no-fabric-dependency.md`);
//! the abfss:// Delta path reads the customer's own ADLS Gen2 via Managed
//! Identity. The bundled `fixtures/sales.parquet` + the `fixture://sales`
//! in-memory source make the CORE PATH executable in CI with zero Azure — no
//! stub, no mock frame (`.claude/rules/no-vaporware.md`).
//!
//! Endpoints (internal HTTP, port 8080 by default):
//!   GET  /healthz    liveness/readiness — 200 {"ok":true}
//!   POST /scan       { path, projection?, limit? } → { ok, stats, arrowIpcBase64 }
//!                    (or the raw Arrow IPC stream body with `?format=ipc`)
//!   POST /frame      { path } → { ok, frame }  (metadata-only version pin)
//!   GET  /residency  in-process framing registry (cross-replica Redis index is HYP-6)
//!
//! Cross-replica segment residency + a Redis coherence index is HYP-6 (NOT built
//! here); this skeleton keeps an in-process framing registry only, and says so.

mod scan;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

use scan::{execute_frame, execute_scan, ScanError, ScanRequest};

/// In-process framing registry (path → last framed Delta version + when). The
/// SHARED cross-replica residency index lives in Redis and is HYP-6 — this
/// skeleton is honest that it only tracks frames on THIS replica.
#[derive(Default)]
struct AppState {
    frames: Mutex<HashMap<String, FrameRecord>>,
}

#[derive(Clone, serde::Serialize)]
struct FrameRecord {
    source_kind: String,
    delta_version: Option<i64>,
    columns: usize,
    framed_at_unix_ms: u128,
}

/// Serialize any value to a JSON `Value` for embedding in a `json!` object —
/// explicit `to_value` (never relies on the macro's leaf conversion for custom
/// structs). Falls back to `null` if a value somehow fails to serialize.
fn v<T: serde::Serialize>(x: &T) -> serde_json::Value {
    serde_json::to_value(x).unwrap_or(serde_json::Value::Null)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("loom_directlake=info")),
        )
        .init();

    let state = Arc::new(AppState::default());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/scan", post(scan_handler))
        .route("/frame", post(frame_handler))
        .route("/residency", get(residency_handler))
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("loom-directlake listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind listener");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

async fn healthz() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "loom-directlake" }))
}

/// Map a ScanError to the right HTTP status + an honest {ok:false,error} body.
fn error_response(e: ScanError) -> Response {
    let (status, code) = match &e {
        ScanError::Gate(_) => (StatusCode::SERVICE_UNAVAILABLE, "gate"),
        ScanError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
        ScanError::Engine(_) => (StatusCode::BAD_GATEWAY, "engine_error"),
    };
    (
        status,
        Json(json!({ "ok": false, "error": e.to_string(), "code": code })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct ScanQuery {
    /// `?format=ipc` returns the raw Arrow IPC stream; default returns JSON.
    #[serde(default)]
    format: Option<String>,
}

async fn scan_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ScanQuery>,
    Json(req): Json<ScanRequest>,
) -> Response {
    match execute_scan(&req).await {
        Ok(result) => {
            // Record the frame we just scanned against (in-process registry).
            if let Ok(mut frames) = state.frames.lock() {
                frames.insert(
                    req.path.clone(),
                    FrameRecord {
                        source_kind: result.stats.source_kind.clone(),
                        delta_version: result.stats.delta_version,
                        columns: result.stats.returned_columns,
                        framed_at_unix_ms: now_ms(),
                    },
                );
            }

            if q.format.as_deref() == Some("ipc") {
                // Raw Arrow IPC stream — the caller reads it with an Arrow reader.
                // Header-tuple IntoResponse (K: TryInto<HeaderName>, V: TryInto<
                // HeaderValue>); the Vec<u8> body carries the IPC bytes.
                (
                    [
                        ("content-type", "application/vnd.apache.arrow.stream".to_string()),
                        ("x-loom-returned-rows", result.stats.returned_rows.to_string()),
                    ],
                    result.arrow_ipc,
                )
                    .into_response()
            } else {
                let b64 =
                    base64::engine::general_purpose::STANDARD.encode(&result.arrow_ipc);
                Json(json!({
                    "ok": true,
                    "stats": v(&result.stats),
                    "arrowIpcBase64": b64,
                }))
                .into_response()
            }
        }
        Err(e) => error_response(e),
    }
}

#[derive(Debug, Deserialize)]
struct FrameBody {
    path: String,
}

async fn frame_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FrameBody>,
) -> Response {
    match execute_frame(&body.path).await {
        Ok(frame) => {
            if let Ok(mut frames) = state.frames.lock() {
                frames.insert(
                    body.path.clone(),
                    FrameRecord {
                        source_kind: frame.source_kind.clone(),
                        delta_version: frame.delta_version,
                        columns: frame.columns.len(),
                        framed_at_unix_ms: now_ms(),
                    },
                );
            }
            Json(json!({ "ok": true, "frame": v(&frame) })).into_response()
        }
        Err(e) => error_response(e),
    }
}

async fn residency_handler(State(state): State<Arc<AppState>>) -> Response {
    let frames = state
        .frames
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default();
    let entries: Vec<serde_json::Value> = frames
        .iter()
        .map(|(path, rec)| json!({ "path": path, "frame": v(rec) }))
        .collect();
    Json(json!({
        "ok": true,
        "note": "In-process framing registry only. The shared cross-replica \
                 segment-residency index (cold/semiwarm/warm ladder) backed by \
                 Azure Cache for Redis is HYP-6 and is not built in this skeleton.",
        "framed": entries.len(),
        "entries": entries,
    }))
    .into_response()
}
