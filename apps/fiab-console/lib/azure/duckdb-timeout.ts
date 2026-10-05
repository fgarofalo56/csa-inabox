/**
 * Shared cold-start timeout policy for the `loom-duckdb` serving tier
 * (#3571, deploy-integrity.md R7).
 *
 * SQL Lab and the DuckLake catalog editor both call the SAME Container App
 * (`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep`, overridden to
 * `minReplicas: 0` by its only caller — `admin-plane/main.bicep` — so the tier
 * is ~$0 at idle). Both callers therefore share ONE accurate cause statement
 * instead of each re-deriving it, which is how a hand-copied second version
 * would drift from the first over time and stop being true of one of them.
 *
 * Pure constants, no server-only imports (no Cosmos, no ARM clients) — safe to
 * import from a `'use client'` editor without pulling the server bundle in.
 */

/** A real cold start (per the bicep's own comment, ~5-15s) plus request/
 * response overhead comfortably fits inside this; the shared app-wide 20s
 * default (`lib/client-fetch.ts`) does not — that gap is exactly what made
 * SQL Lab's and the DuckLake catalog's first query after an idle period look
 * broken (#3571). */
export const DUCKDB_TIER_TIMEOUT_MS = 60_000;

export const DUCKDB_TIER_TIMEOUT_HINT =
  'The loom-duckdb serving tier is deployed scale-to-zero (minReplicas 0), and the Synapse Serverless '
  + 'fallback has a cold start of its own, so the FIRST request after an idle period pays for starting the '
  + 'engine before anything runs. Once warm it answers in milliseconds — Loom retries automatically once '
  + 'before showing an error. If it keeps timing out, the tier may genuinely be unreachable rather than cold.';
