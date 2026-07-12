/**
 * Loom Direct Lake — pure scan-request normalization (HYP-5).
 *
 * Extracted from the /api/directlake/scan BFF route so the validation + clamping
 * logic is unit-testable in isolation (no fetch, no session). Keep in step with
 * the loom-directlake service's own clamps (apps/loom-directlake/src/scan.rs:
 * MAX_LIMIT). Azure-native; no Fabric/OneLake/Power BI reference.
 */

/** Mirrors the service's own limit clamp (scan.rs MAX_LIMIT). */
export const MAX_SCAN_LIMIT = 1_000_000;

export interface RawScanBody {
  path?: unknown;
  projection?: unknown;
  limit?: unknown;
}

export interface NormalizedScan {
  path: string;
  projection?: string[];
  limit?: number;
}

export type ScanNormalizeResult =
  | { ok: true; value: NormalizedScan }
  | { ok: false; error: string };

/**
 * Validate + normalize a raw scan body: require a non-empty `path`, keep only
 * non-empty string projection columns (drop the key entirely when none remain),
 * and coerce `limit` to a positive integer clamped to MAX_SCAN_LIMIT (undefined
 * when absent/invalid so the service applies its own default).
 */
export function normalizeScanBody(body: RawScanBody | null | undefined): ScanNormalizeResult {
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!path) {
    return {
      ok: false,
      error:
        "A source 'path' is required — 'fixture://sales' (bundled demo), a 'file://' Parquet path, " +
        "or an 'abfss://' Delta table on the DLZ lake.",
    };
  }

  let projection: string[] | undefined;
  if (Array.isArray(body?.projection)) {
    const cols = body.projection.filter(
      (c): c is string => typeof c === 'string' && c.trim().length > 0,
    );
    projection = cols.length ? cols : undefined;
  }

  let limit: number | undefined;
  if (typeof body?.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0) {
    limit = Math.min(Math.floor(body.limit), MAX_SCAN_LIMIT);
  }

  return { ok: true, value: { path, projection, limit } };
}

/** Build the `/scan` URL for the service base (adds https:// when scheme-less, trims a trailing slash). */
export function buildScanUrl(base: string): string {
  return buildServiceUrl(base, 'scan');
}

/**
 * Build an arbitrary loom-directlake endpoint URL for the service base (adds
 * https:// when scheme-less, trims a trailing slash). Shared by the `/scan` and
 * `/frame` proxies so both derive the target the same way.
 */
export function buildServiceUrl(base: string, endpoint: 'scan' | 'frame'): string {
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return withScheme.replace(/\/$/, '') + '/' + endpoint;
}

/** Build the `/frame` URL for the service base (metadata-only version pin). */
export function buildFrameUrl(base: string): string {
  return buildServiceUrl(base, 'frame');
}

export interface RawFrameBody {
  path?: unknown;
}

export interface NormalizedFrame {
  path: string;
}

export type FrameNormalizeResult =
  | { ok: true; value: NormalizedFrame }
  | { ok: false; error: string };

/**
 * Validate + normalize a raw frame body: require a non-empty `path`. Framing is
 * metadata-only (a Delta-log version pin) so — unlike a scan — it carries no
 * projection or limit. The path rule matches `normalizeScanBody` verbatim so the
 * two proxies reject the same malformed sources with the same message.
 */
export function normalizeFrameBody(body: RawFrameBody | null | undefined): FrameNormalizeResult {
  const path = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!path) {
    return {
      ok: false,
      error:
        "A source 'path' is required — 'fixture://sales' (bundled demo), a 'file://' Parquet path, " +
        "or an 'abfss://' Delta table on the DLZ lake.",
    };
  }
  return { ok: true, value: { path } };
}
