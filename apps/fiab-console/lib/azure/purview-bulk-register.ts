/**
 * purview-bulk-register — pure helpers for the "Auto-add all Loom sources"
 * bulk-register flow (purview-panel AutoAddAllDialog) so the per-item outcome
 * classification + the summary aggregation are unit-testable without React.
 *
 * Semantics (partial success, never all-or-nothing):
 *   - 2xx                                  → 'ok'        (registered)
 *   - 409 / DataSource_Duplicate           → 'exists'    (already registered —
 *     the scan plane keys sources by TARGET endpoint, so re-running auto-add
 *     over an estate that's partially registered is expected + safe)
 *   - anything else                        → 'error' with the REAL upstream
 *     message (never "unknown error"; the BFF propagates the Purview body).
 *
 * Client-safe: no server-only imports.
 */

export type BulkRegisterStatus = 'ok' | 'exists' | 'error';

export interface BulkRegisterOutcome {
  status: BulkRegisterStatus;
  /** Human message for the row (real upstream error / duplicate note). */
  detail?: string;
}

/** Duplicate-registration signals from the Purview scan plane. */
const DUPLICATE_RE = /DataSource_Duplicate|already exists for this target/i;

/**
 * Classify one bulk-register BFF response (`POST /api/admin/security/purview/sources`).
 * `json` is the parsed response body ({ ok, error?, code?, body? }).
 */
export function classifyBulkRegisterResponse(httpStatus: number, json: any): BulkRegisterOutcome {
  if (httpStatus >= 200 && httpStatus < 300 && json?.ok !== false) return { status: 'ok' };
  const message: string =
    (typeof json?.error === 'string' && json.error) ||
    (typeof json?.body?.error?.message === 'string' && json.body.error.message) ||
    `HTTP ${httpStatus}`;
  if (httpStatus === 409 || DUPLICATE_RE.test(message)) {
    return { status: 'exists', detail: 'already registered (same target endpoint)' };
  }
  return { status: 'error', detail: message };
}

export interface BulkRegisterSummary {
  total: number;
  ok: number;
  exists: number;
  errors: number;
}

/** Aggregate per-item outcomes into the progress/summary counts. */
export function summarizeBulkRegister(outcomes: { status: BulkRegisterStatus }[]): BulkRegisterSummary {
  return {
    total: outcomes.length,
    ok: outcomes.filter((o) => o.status === 'ok').length,
    exists: outcomes.filter((o) => o.status === 'exists').length,
    errors: outcomes.filter((o) => o.status === 'error').length,
  };
}
