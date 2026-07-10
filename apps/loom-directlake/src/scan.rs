//! Loom Direct Lake — scan engine (framing + transcoding as buildable ops).
//!
//! This module is the REAL core path (no stubs, per `.claude/rules/no-vaporware.md`):
//! it builds/loads a columnar source, runs a projection + limit scan through
//! Apache DataFusion, and *transcodes* the result to an Arrow IPC stream. Three
//! sources, one code path:
//!
//!   * `fixture://<name>`  — an in-memory star-schema fact built from bundled
//!     data. Makes the scan path executable in CI with NO Azure and NO files.
//!   * `file://<path>` or a bare local path — reads a local Parquet file (the
//!     bundled `fixtures/sales.parquet`) via DataFusion's Parquet reader. Proves
//!     the on-disk columnar path end-to-end without Azure.
//!   * `abfss://…` (Delta) — opens the Delta transaction log off ADLS Gen2 with
//!     delta-rs (Managed Identity), *frames* to the current Delta version, and
//!     scans through DataFusion. Runtime-gated on LOOM_DIRECTLAKE_STORAGE_ACCOUNT;
//!     built only when the `azure` feature is on.
//!
//! "Framing" here = pinning the Delta-log version (metadata only, no data copy);
//! "transcoding" = loading the scanned columns into Arrow record batches and
//! serializing them to the Arrow IPC stream the caller consumes — the two
//! operations Fabric's Direct Lake performs against VertiPaq, done as literal
//! OSS code against Arrow instead.

use std::time::Instant;

use arrow::datatypes::{DataType, Field, Schema};
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Hard caps so a single scan can never blow the columnar working set. These are
/// OUR limits (not an F-SKU guardrail — see the PRP HONEST LIMITS); a scan asking
/// for more is clamped, never silently unbounded.
pub const MAX_LIMIT: usize = 1_000_000;
const DEFAULT_LIMIT: usize = 10_000;

/// A scan request: a source path, an optional column projection, and a row limit.
#[derive(Debug, Clone, Deserialize)]
pub struct ScanRequest {
    /// `fixture://sales`, `file://…/sales.parquet`, a bare local path, or `abfss://…`.
    pub path: String,
    /// Column names to project. `None`/empty ⇒ all columns.
    #[serde(default)]
    pub projection: Option<Vec<String>>,
    /// Max rows to return. `None` ⇒ DEFAULT_LIMIT; clamped to MAX_LIMIT.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Scan statistics returned alongside the Arrow IPC payload (the JSON stats half
/// of the PRP's "Arrow IPC stream + JSON stats" contract).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ScanStats {
    /// `"fixture"`, `"parquet"`, or `"delta"`.
    pub source_kind: String,
    /// Rows returned after projection + limit.
    pub returned_rows: usize,
    /// Number of projected columns.
    pub returned_columns: usize,
    /// Projected column names, in output order.
    pub column_names: Vec<String>,
    /// The Delta-log version this scan was FRAMED against (Delta source only).
    pub delta_version: Option<i64>,
    /// Wall-clock milliseconds for the framing + transcode + scan.
    pub elapsed_ms: u128,
}

/// A completed scan: the JSON stats + the transcoded Arrow IPC stream bytes.
pub struct ScanResult {
    pub stats: ScanStats,
    pub arrow_ipc: Vec<u8>,
}

#[derive(Debug)]
pub enum ScanError {
    /// An honest infra gate — surfaced verbatim to the caller (e.g. Azure env unset).
    Gate(String),
    /// A bad request (unknown fixture, empty projection column, etc.).
    BadRequest(String),
    /// An engine/runtime failure.
    Engine(String),
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanError::Gate(m) => write!(f, "{m}"),
            ScanError::BadRequest(m) => write!(f, "{m}"),
            ScanError::Engine(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for ScanError {}

impl From<datafusion::error::DataFusionError> for ScanError {
    fn from(e: datafusion::error::DataFusionError) -> Self {
        ScanError::Engine(e.to_string())
    }
}
impl From<arrow::error::ArrowError> for ScanError {
    fn from(e: arrow::error::ArrowError) -> Self {
        ScanError::Engine(e.to_string())
    }
}

/// Classify the source URI into one of the three handled kinds.
enum Source {
    Fixture(String),
    Parquet(String),
    Delta(String),
}

fn classify(path: &str) -> Result<Source, ScanError> {
    let p = path.trim();
    if p.is_empty() {
        return Err(ScanError::BadRequest("path is required".into()));
    }
    if let Some(name) = p.strip_prefix("fixture://") {
        return Ok(Source::Fixture(name.to_string()));
    }
    if p.starts_with("abfss://") || p.starts_with("abfs://") {
        return Ok(Source::Delta(p.to_string()));
    }
    if let Some(local) = p.strip_prefix("file://") {
        return Ok(Source::Parquet(local.to_string()));
    }
    // A bare path that ends in .parquet (or a directory of parquet) is local.
    Ok(Source::Parquet(p.to_string()))
}

/// The bundled in-memory fixture — a small sales fact (region/product/quarter
/// dimensions + units/amount measures). Identical shape to `fixtures/sales.parquet`
/// so the two source paths return the same columns.
pub fn fixture_batch() -> Result<RecordBatch, ScanError> {
    use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};

    let region = StringArray::from(vec![
        "West", "East", "West", "North", "East", "South", "West", "North",
    ]);
    let product = StringArray::from(vec![
        "Alpha", "Alpha", "Beta", "Beta", "Gamma", "Gamma", "Alpha", "Beta",
    ]);
    let quarter =
        StringArray::from(vec!["Q1", "Q1", "Q1", "Q2", "Q2", "Q2", "Q3", "Q3"]);
    let units = Int64Array::from(vec![10i64, 7, 3, 12, 5, 9, 14, 2]);
    let amount =
        Float64Array::from(vec![100.0f64, 70.5, 30.0, 120.25, 50.0, 90.75, 140.0, 20.5]);

    let schema = Arc::new(Schema::new(vec![
        Field::new("region", DataType::Utf8, false),
        Field::new("product", DataType::Utf8, false),
        Field::new("quarter", DataType::Utf8, false),
        Field::new("units", DataType::Int64, false),
        Field::new("amount", DataType::Float64, false),
    ]));

    let columns: Vec<ArrayRef> = vec![
        Arc::new(region),
        Arc::new(product),
        Arc::new(quarter),
        Arc::new(units),
        Arc::new(amount),
    ];
    RecordBatch::try_new(schema, columns).map_err(Into::into)
}

/// Serialize record batches to a single Arrow IPC *stream* (the transcode step).
pub fn to_ipc_stream(schema: &Schema, batches: &[RecordBatch]) -> Result<Vec<u8>, ScanError> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut writer = StreamWriter::try_new(&mut buf, schema)?;
        for b in batches {
            writer.write(b)?;
        }
        writer.finish()?;
    }
    Ok(buf)
}

/// Execute a scan end-to-end: frame the source, apply projection + limit, run it
/// through DataFusion, and transcode the result to an Arrow IPC stream.
pub async fn execute_scan(req: &ScanRequest) -> Result<ScanResult, ScanError> {
    let started = Instant::now();
    let ctx = SessionContext::new();

    let (mut df, source_kind, delta_version): (DataFrame, &'static str, Option<i64>) =
        match classify(&req.path)? {
            Source::Fixture(name) => {
                // Only one bundled fixture today; name it honestly.
                if !name.is_empty() && name != "sales" {
                    return Err(ScanError::BadRequest(format!(
                        "unknown fixture '{name}'. The only bundled fixture is 'fixture://sales'."
                    )));
                }
                let batch = fixture_batch()?;
                ctx.register_batch("t", batch)?;
                (ctx.table("t").await?, "fixture", None)
            }
            Source::Parquet(local) => {
                let df = ctx
                    .read_parquet(local.as_str(), ParquetReadOptions::default())
                    .await?;
                (df, "parquet", None)
            }
            Source::Delta(uri) => open_delta(&ctx, &uri).await?,
        };

    // ── Projection (transcode only the touched columns) ─────────────────────────
    if let Some(cols) = &req.projection {
        let cols: Vec<&str> = cols.iter().map(|s| s.as_str()).filter(|s| !s.is_empty()).collect();
        if !cols.is_empty() {
            df = df.select_columns(&cols)?;
        }
    }

    // ── Limit (clamped) ─────────────────────────────────────────────────────────
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    df = df.limit(0, Some(limit))?;

    // Arrow schema of the projected frame (before collect, so an empty result
    // still carries the correct schema in the IPC stream).
    let arrow_schema: Schema = df.schema().as_arrow().clone();

    let batches = df.collect().await?;
    let returned_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    let column_names: Vec<String> =
        arrow_schema.fields().iter().map(|f| f.name().clone()).collect();

    let arrow_ipc = to_ipc_stream(&arrow_schema, &batches)?;

    Ok(ScanResult {
        stats: ScanStats {
            source_kind: source_kind.to_string(),
            returned_rows,
            returned_columns: column_names.len(),
            column_names,
            delta_version,
            elapsed_ms: started.elapsed().as_millis(),
        },
        arrow_ipc,
    })
}

// ── Delta (Azure) path — framing against the Delta log off ADLS ─────────────────

/// Storage options for delta-rs from the environment. Managed Identity is picked
/// up by object_store's Azure backend from IMDS in-cluster; we only pass the
/// account name (+ optional container hint). Returns an honest gate error when the
/// Azure env is unset — the caller surfaces it verbatim (no silent Fabric gate).
#[cfg(feature = "azure")]
fn delta_storage_options() -> Result<std::collections::HashMap<String, String>, ScanError> {
    let account = std::env::var("LOOM_DIRECTLAKE_STORAGE_ACCOUNT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ScanError::Gate(
                "Delta (abfss://) scans need the ADLS Gen2 account. Set \
                 LOOM_DIRECTLAKE_STORAGE_ACCOUNT (the DLZ lake storage-account name) and grant the \
                 loom-directlake UAMI Storage Blob Data Reader. No Fabric/OneLake capacity is \
                 required — this reads the customer's own ADLS. The fixture:// and file:// paths \
                 need none of this."
                    .to_string(),
            )
        })?;

    let mut opts = std::collections::HashMap::new();
    opts.insert("azure_storage_account_name".to_string(), account);
    // Use Managed Identity (IMDS) — never a key. object_store's azure backend
    // resolves the ACA/AKS-assigned UAMI token automatically in-cluster.
    opts.insert("azure_use_azure_cli".to_string(), "false".to_string());
    opts.insert("use_azure_cli".to_string(), "false".to_string());
    if let Ok(client_id) = std::env::var("LOOM_DIRECTLAKE_UAMI_CLIENT_ID") {
        if !client_id.trim().is_empty() {
            // Pin the specific user-assigned identity when more than one is present.
            opts.insert("azure_msi_client_id".to_string(), client_id);
        }
    }
    Ok(opts)
}

#[cfg(feature = "azure")]
async fn open_delta(
    ctx: &SessionContext,
    uri: &str,
) -> Result<(DataFrame, &'static str, Option<i64>), ScanError> {
    let opts = delta_storage_options()?;
    let table = deltalake::open_table_with_storage_options(uri, opts)
        .await
        .map_err(|e| ScanError::Engine(format!("failed to open Delta table {uri}: {e}")))?;
    let version = table.version();
    // DeltaTable is a DataFusion TableProvider (deltalake `datafusion` feature).
    ctx.register_table("delta_t", Arc::new(table))
        .map_err(|e| ScanError::Engine(e.to_string()))?;
    let df = ctx.table("delta_t").await?;
    Ok((df, "delta", Some(version)))
}

#[cfg(not(feature = "azure"))]
async fn open_delta(
    _ctx: &SessionContext,
    _uri: &str,
) -> Result<(DataFrame, &'static str, Option<i64>), ScanError> {
    Err(ScanError::Gate(
        "This loom-directlake build was compiled without the `azure` feature, so abfss:// Delta \
         scans are unavailable. Rebuild with `--features azure` (the default), or use a \
         fixture:// / file:// source."
            .to_string(),
    ))
}

// ── Framing (metadata-only) ─────────────────────────────────────────────────────

/// The result of a framing pass — a metadata-only version pin (no data copy).
#[derive(Debug, Clone, Serialize)]
pub struct FrameResult {
    pub source_kind: String,
    pub delta_version: Option<i64>,
    pub columns: Vec<FrameColumn>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

fn frame_columns_from_schema(schema: &Schema) -> Vec<FrameColumn> {
    schema
        .fields()
        .iter()
        .map(|f| FrameColumn {
            name: f.name().clone(),
            data_type: format!("{:?}", f.data_type()),
            nullable: f.is_nullable(),
        })
        .collect()
}

/// Frame a source: pin its current version + return its schema, WITHOUT scanning
/// any data (mirrors Direct Lake's metadata-only refresh).
pub async fn execute_frame(path: &str) -> Result<FrameResult, ScanError> {
    let started = Instant::now();
    match classify(path)? {
        Source::Fixture(_) => {
            let batch = fixture_batch()?;
            Ok(FrameResult {
                source_kind: "fixture".into(),
                delta_version: None,
                columns: frame_columns_from_schema(&batch.schema()),
                elapsed_ms: started.elapsed().as_millis(),
            })
        }
        Source::Parquet(local) => {
            let ctx = SessionContext::new();
            let df = ctx
                .read_parquet(local.as_str(), ParquetReadOptions::default())
                .await?;
            let schema: Schema = df.schema().as_arrow().clone();
            Ok(FrameResult {
                source_kind: "parquet".into(),
                delta_version: None,
                columns: frame_columns_from_schema(&schema),
                elapsed_ms: started.elapsed().as_millis(),
            })
        }
        Source::Delta(uri) => {
            let ctx = SessionContext::new();
            let (df, _kind, version) = open_delta(&ctx, &uri).await?;
            let schema: Schema = df.schema().as_arrow().clone();
            Ok(FrameResult {
                source_kind: "delta".into(),
                delta_version: version,
                columns: frame_columns_from_schema(&schema),
                elapsed_ms: started.elapsed().as_millis(),
            })
        }
    }
}

// ── Unit tests (core path — run with `cargo test --no-default-features --features engine`) ──

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::ipc::reader::StreamReader;

    fn ipc_row_count(bytes: &[u8]) -> usize {
        let reader = StreamReader::try_new(std::io::Cursor::new(bytes), None).unwrap();
        reader.map(|b| b.unwrap().num_rows()).sum()
    }

    #[test]
    fn fixture_batch_has_expected_shape() {
        let b = fixture_batch().unwrap();
        assert_eq!(b.num_rows(), 8, "fixture must have 8 rows");
        assert_eq!(b.num_columns(), 5, "fixture must have 5 columns");
        let names: Vec<&str> =
            b.schema().fields().iter().map(|f| f.name().as_str()).collect();
        assert_eq!(names, vec!["region", "product", "quarter", "units", "amount"]);
    }

    #[test]
    fn classify_routes_sources() {
        assert!(matches!(classify("fixture://sales").unwrap(), Source::Fixture(_)));
        assert!(matches!(classify("abfss://c@a.dfs/x").unwrap(), Source::Delta(_)));
        assert!(matches!(classify("file:///tmp/x.parquet").unwrap(), Source::Parquet(_)));
        assert!(matches!(classify("./sales.parquet").unwrap(), Source::Parquet(_)));
        assert!(matches!(classify("").unwrap_err(), ScanError::BadRequest(_)));
    }

    #[tokio::test]
    async fn scan_fixture_returns_all_rows_and_columns() {
        let req = ScanRequest { path: "fixture://sales".into(), projection: None, limit: None };
        let res = execute_scan(&req).await.unwrap();
        assert_eq!(res.stats.source_kind, "fixture");
        assert_eq!(res.stats.returned_rows, 8);
        assert_eq!(res.stats.returned_columns, 5);
        assert_eq!(res.stats.column_names.len(), 5);
        assert!(res.stats.delta_version.is_none());
        // The transcoded Arrow IPC stream round-trips to the same 8 rows.
        assert!(!res.arrow_ipc.is_empty());
        assert_eq!(ipc_row_count(&res.arrow_ipc), 8);
    }

    #[tokio::test]
    async fn scan_projection_and_limit_narrow_the_result() {
        let req = ScanRequest {
            path: "fixture://sales".into(),
            projection: Some(vec!["region".into(), "amount".into()]),
            limit: Some(3),
        };
        let res = execute_scan(&req).await.unwrap();
        assert_eq!(res.stats.returned_columns, 2);
        assert_eq!(res.stats.column_names, vec!["region".to_string(), "amount".to_string()]);
        assert_eq!(res.stats.returned_rows, 3, "limit must cap rows at 3");
        assert_eq!(ipc_row_count(&res.arrow_ipc), 3);
    }

    #[tokio::test]
    async fn scan_limit_is_clamped_to_max() {
        let req = ScanRequest {
            path: "fixture://sales".into(),
            projection: None,
            limit: Some(usize::MAX),
        };
        // Must not panic / overflow; the 8-row fixture just returns 8.
        let res = execute_scan(&req).await.unwrap();
        assert_eq!(res.stats.returned_rows, 8);
    }

    #[tokio::test]
    async fn scan_unknown_fixture_is_bad_request() {
        let req = ScanRequest { path: "fixture://nope".into(), projection: None, limit: None };
        assert!(matches!(execute_scan(&req).await.unwrap_err(), ScanError::BadRequest(_)));
    }

    #[tokio::test]
    async fn frame_fixture_is_metadata_only() {
        let f = execute_frame("fixture://sales").await.unwrap();
        assert_eq!(f.source_kind, "fixture");
        assert_eq!(f.columns.len(), 5);
        assert!(f.delta_version.is_none());
        assert_eq!(f.columns[0].name, "region");
    }

    #[test]
    fn ipc_stream_roundtrips() {
        let b = fixture_batch().unwrap();
        let schema = b.schema();
        let bytes = to_ipc_stream(&schema, std::slice::from_ref(&b)).unwrap();
        assert_eq!(ipc_row_count(&bytes), 8);
    }
}
