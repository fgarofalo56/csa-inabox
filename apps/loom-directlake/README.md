# loom-directlake — Direct Lake columnar cache/scan service (ACA)

Azure-native, OSS **outcome-equivalent of Microsoft Fabric's Direct Lake** — a
Rust/[axum] service that **frames** a Delta/Parquet source (metadata-only version
pin) and **transcodes** scanned columns to an **Arrow IPC stream**, executing the
scan through **Apache DataFusion**. It is the HYP-5 skeleton of Component 2 in
`PRPs/active/next-waves/PRP-loom-hyperscale-custom-components.md`.

It contacts **no Power BI / Fabric / OneLake service**
(`.claude/rules/no-fabric-dependency.md`): the `abfss://` Delta path reads the
customer's **own ADLS Gen2** via **Managed Identity** (`object_store` + `delta-rs`).
Loom cannot license VertiPaq (and AAS is Gov-scarce + on a retirement track), so
this reproduces Direct Lake's two operations — **framing** and **transcoding** —
as literal OSS code over Arrow instead of reimplementing VertiPaq.

```
apps/loom-directlake/
  Cargo.toml            # arrow 53 / parquet 53 / datafusion 43 / deltalake 0.24 (azure)
  Dockerfile            # multi-stage: rust:1.82 builder → debian-slim runtime, non-root uid 10001
  fixtures/sales.parquet# bundled tiny star-schema fact — makes /scan run with ZERO Azure
  src/
    main.rs             # axum server: /healthz, /scan, /frame, /residency
    scan.rs             # the REAL scan engine (framing + transcoding + DataFusion) + unit tests
  README.md             # this file
```

> **No vaporware** (`.claude/rules/no-vaporware.md`): `/scan` really reads a
> source, runs a **real DataFusion** projection + limit, and returns a **real
> Arrow IPC** stream. The `fixture://sales` in-memory source and the bundled
> `fixtures/sales.parquet` make the core path executable in CI with **no Azure**.
> When `LOOM_DIRECTLAKE_STORAGE_ACCOUNT` is unset, only the `abfss://` Delta path
> honest-gates (503 naming the exact env var + role); `fixture://` / `file://`
> still run. The console BFF `/api/directlake/scan` honest-gates on
> `LOOM_DIRECTLAKE_URL` when this service isn't deployed and silently falls back
> to the existing semantic backends — never a Fabric gate.

## What "Direct Lake" maps to here (grounded, and where it differs honestly)

Grounded in Microsoft Learn (`fabric/fundamentals/direct-lake-overview`,
`.../direct-lake-how-it-works`, `.../direct-lake-understand-storage`).

| Fabric Direct Lake | loom-directlake |
|---|---|
| **Framing** — pin a Delta-log version, metadata-only, no data copy | `POST /frame` opens the Delta log with `delta-rs`, returns the pinned `deltaVersion` + schema — no scan |
| **Transcoding** — load touched columns into VertiPaq segments on demand | `POST /scan` projects only requested columns, runs them through DataFusion, and serializes the result to an **Arrow IPC stream** |
| VertiPaq in-memory columnar store fed from OneLake Parquet | Arrow record batches / DataFusion over **ADLS Gen2** Delta+Parquet (customer-owned) |
| Residency ladder cold → semiwarm → warm | `GET /residency` (in-process only in this skeleton; the **shared Redis** cross-replica index is **HYP-6**) |

**HONEST LIMITS (from the PRP §6.10):** this is **not VertiPaq** — we do not
reproduce its RLE/bit-packed segment encoding or its optimizer, so a large F-SKU
Import model may still beat this on very wide/high-cardinality models. The
sub-second-warm-frame claim is a **PSR-1 benchmark** target for typical
star-schema aggregates, not universal parity. Warm-cache retention costs money at
rest (bounded by `minReplicas` tuning) — the honest trade for import-class
latency. Cross-replica segment residency + Redis coherence is **HYP-6**, NOT in
this skeleton.

## API

Internal HTTP only (`external:false` ingress; port **8080**). Reached solely by
the Console BFF on the Container Apps environment / VNet — never public.

### `GET /healthz`
Liveness/readiness — `200 {"ok":true,"service":"loom-directlake"}`.

### `POST /scan`
```jsonc
// request
{
  "path": "fixture://sales",          // fixture://sales | file:///app/fixtures/sales.parquet | abfss://<c>@<acct>.dfs.core.windows.net/<table>
  "projection": ["region", "amount"], // optional — omit for all columns
  "limit": 100                        // optional — default 10,000; clamped to 1,000,000
}
```
```jsonc
// response 200 — JSON stats + the transcoded Arrow IPC stream (base64)
{
  "ok": true,
  "stats": {
    "source_kind": "fixture",         // fixture | parquet | delta
    "returned_rows": 8,
    "returned_columns": 5,
    "column_names": ["region","product","quarter","units","amount"],
    "delta_version": null,            // the framed Delta version (delta source only)
    "elapsed_ms": 3
  },
  "arrowIpcBase64": "<base64 Arrow IPC stream>"
}
// 400 bad request · 502 engine error · 503 honest Azure gate (abfss:// without env)
```
`?format=ipc` returns the **raw** Arrow IPC stream as the body
(`content-type: application/vnd.apache.arrow.stream`) with an
`x-loom-returned-rows` header, for a caller that reads Arrow directly.

### `POST /frame`
`{ "path": "abfss://…" }` → `{ ok, frame: { source_kind, delta_version, columns[], elapsed_ms } }`
— a **metadata-only** version pin (no data scan).

### `GET /residency`
The in-process framing registry (path → framed version + when). The **shared
cross-replica** residency ladder is HYP-6; this endpoint says so.

## Environment

| Var | Required for | Meaning |
|---|---|---|
| `PORT` | no (default 8080) | Internal ingress port (matches the ACA `targetPort`). |
| `LOOM_DIRECTLAKE_STORAGE_ACCOUNT` | `abfss://` scans | The DLZ ADLS Gen2 account name. Unset ⇒ Delta path 503s honestly; fixture/file paths still run. |
| `LOOM_DIRECTLAKE_UAMI_CLIENT_ID` | multi-UAMI only | Pin a specific user-assigned MI client-id for `object_store` when more than one identity is bound. |
| `RUST_LOG` | no | Tracing filter (default `loom_directlake=info`). |

Auth to ADLS is **Managed Identity via IMDS** in-cluster — never a storage key.
The `loom-directlake` UAMI needs **Storage Blob Data Reader** on the DLZ lake and
**nothing else** (least privilege; see the bicep module).

## Build (server-side ACR Tasks — no local Docker)

```bash
az acr build -r <acr> -t loom-directlake:<tag> apps/loom-directlake
```

Pin `<tag>` to the value wired into `appImageTags.directLake` so the bicep image
ref resolves. Every crate version is pinned in `Cargo.toml`; bump deliberately,
rebuild, re-run the unit tests, then roll.

## Test (core path, no Azure)

The scan engine's unit tests run WITHOUT the heavy Azure/Delta stack:

```bash
# Fixture + parquet + DataFusion core path — asserts row/col counts + IPC round-trip.
cargo test --no-default-features --features engine
# Full build (adds delta-rs / object_store azure):
cargo test
```

Tests assert: the fixture is 8×5, projection+limit narrow the result to the
requested shape, the limit clamps without overflow, an unknown fixture is a 400,
framing is metadata-only, and the transcoded Arrow IPC stream round-trips to the
same row count.

## Deploy (bicep-sync — `no-vaporware.md`)

1. **ACA app** — `platform/fiab/bicep/modules/compute/loom-directlake-app.bicep`,
   modeled on `admin-plane/script-runner-app.bicep`: internal ingress
   `external:false`, `targetPort: 8080`, ACR pull via a dedicated UAMI, **and
   `minReplicas: 1` (NOT scale-to-zero — warm-cache retention is the point)**.
   Outputs the internal FQDN the console reads as `LOOM_DIRECTLAKE_URL`.
2. **Console env** — `admin-plane/main.bicep` invokes the module as
   `loomDirectLake` (gated on `directLakeSvcActive`, **DEFAULT-ON** via
   `loomBackends.directLake`; opt out with `'disabled'`) and binds
   `LOOM_DIRECTLAKE_URL` from the module's own `fqdn` output. No operator step.
   Set `LOOM_SEMANTIC_BACKEND=loom-columnar-cache` to route DAX-class queries here.
3. **Image** — produced by `full-app-deploy-commercial.yml` (Commercial),
   `build-fiab-images-acr-tasks.yml` (both matrices) and
   `gov-provision-dataplane-images.yml` (GCC-High / IL5). Tag key:
   `appImageTags.directLakeSvc` (**not** `directLake`, which pins the unrelated
   `loom-direct-lake-shim` image).
4. **Honest gate** — when `LOOM_DIRECTLAKE_URL` is empty the BFF returns **503**
   and the semantic-model / report layer silently falls back to its current
   backend (AAS fast-path or Synapse-Serverless cold path). Never a Fabric gate.

> **It was not always deployed (#3291).** Until that fix this module was an
> orphan: no orchestrator invoked it, `LOOM_DIRECTLAKE_URL` was hard-coded `''`,
> and **no CI lane built the image** — so the BFF's honest 503 named a
> remediation the operator could not execute, and the capability was dark from
> the day it shipped. The stated reason (`admin-plane/main.bicep` at the ARM
> 256-parameter ceiling) was measurably false: 238 params, 18 of headroom, and
> wiring the module added **zero** new params.

**Redis wiring is HYP-6** (segment-residency cross-replica index) — deliberately
NOT built here.

## Build + test gate

`.github/workflows/loom-directlake-ci.yml` runs `cargo build --locked` and
`cargo test --locked` on both feature sets (`engine`-only and the shipped
`engine + azure`), plus the `--release` profile the Dockerfile actually
compiles, on every PR touching this crate.

**That lane did not exist until #3291, and this crate had never been compiled
anywhere** — `grep -rl 'cargo ' .github/workflows` returned zero files, and the
image had no producer either. The first run found three compile errors in the
`#[cfg(test)]` module (two missing `Debug` bounds and an `E0716` borrow of a
temporary `schema()`); the shipped binary itself built clean on both feature
sets. That is the whole argument for the lane: nothing else in the repository
could ever have surfaced them.

## Known vulnerability — `thrift 0.17.0` (Dependabot #94, GHSA-2f9f-gq7v-9h6m)

**Status: open, accepted, and NOT fixable by any dependency bump available
today.** Recorded here so it is a disclosed trade rather than a surprise.

* Severity **moderate**, class *Memory Allocation with Excessive Size Value* —
  a DoS on a parser fed a malformed value. Not RCE, not information disclosure.
* The chain is `loom-directlake → deltalake 0.24 → parquet 53.4.1 → thrift 0.17`.
  `thrift` is pulled by **`parquet` and nothing else** in the lock.
* First patched `thrift` is **0.23.0**. Measured against crates.io: **every**
  `parquet` release up to and including **58.4.0** declares a non-optional
  `thrift = "^0.17"`, which cannot resolve to 0.23; `parquet` drops the `thrift`
  crate entirely only at **59.0.0**. The newest `deltalake` (**0.32.4**) pins
  `arrow ^58` / `parquet ^58`. **No published delta-rs release can reach
  parquet 59**, so there is no version combination that clears this advisory
  while the `abfss://` Delta path exists — which is the point of the service.
* **Exposure is bounded by construction**: ingress is `external: false` (the
  Console BFF over the CAE VNet is the only caller), both BFF routes are
  tenant-admin gated, the container runs non-root (uid 10001) with an ACA memory
  cap, and it parses only the customer's **own** lake files. A malformed Parquet
  file in your own lake can restart your own replica.
* **Re-check trigger**: when `deltalake` publishes a release requiring
  `arrow`/`parquet` **≥ 59**, bump this crate and regenerate `Cargo.lock`. That
  is the single condition that resolves it.

[axum]: https://github.com/tokio-rs/axum
