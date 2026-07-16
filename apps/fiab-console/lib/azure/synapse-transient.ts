/**
 * synapse-transient — classify Synapse Serverless / ADLS errors that are
 * TRANSIENT right after an upload or an idle period, so BFF routes can tell
 * the editor "retry in a moment" instead of dumping a raw SQL error.
 *
 * Diagnosed live 2026-07-16 (operator receipt): CSVs uploaded into a fresh
 * container previewed fine ~10 minutes later, but the first attempts errored —
 * two independent warm-up windows stack right after an upload:
 *   1. Serverless SQL cold start — the first OPENROWSET after idle can take
 *      30-60s+ (driver surfaces login/connection timeouts).
 *   2. Storage visibility/RBAC propagation — a just-created container or a
 *      just-granted role can 403/404 the serverless reader for a few minutes.
 * Both self-heal; the fix is honest retry guidance, not an error wall.
 */

export interface TransientClassification {
  /** stable machine code the editor keys retry behavior on */
  code: 'synapse_cold_start' | 'storage_propagating' | 'file_not_ready';
  /** user-facing, honest explanation */
  friendly: string;
  /** suggested client retry delay */
  retryAfterMs: number;
}

export function classifyTransientSynapseError(raw: string): TransientClassification | null {
  const msg = (raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  if (/login timeout|timeout expired|connection (was )?closed|ETIMEOUT|ESOCKET|ELOGIN|websocket|cold.?start|paused/i.test(msg)) {
    return {
      code: 'synapse_cold_start',
      friendly:
        'The serverless SQL pool is warming up (first query after idle can take up to a minute). Retrying automatically…',
      retryAfterMs: 10_000,
    };
  }
  if (/access is denied|access rights|forbidden|\b403\b|authoriz|permission|credential|cannot be listed/i.test(msg)) {
    return {
      code: 'storage_propagating',
      friendly:
        'Storage permissions are still propagating to the SQL engine (typical after creating a container or granting a role — up to ~5 minutes). Retrying automatically…',
      retryAfterMs: 20_000,
    };
  }
  if (/does not exist|cannot be opened|could not be opened|used by another process|no files found/i.test(msg)) {
    return {
      code: 'file_not_ready',
      friendly:
        'The file is not yet visible to the SQL engine (uploads become queryable a few moments after they complete). Retrying automatically…',
      retryAfterMs: 8_000,
    };
  }
  return null;
}
