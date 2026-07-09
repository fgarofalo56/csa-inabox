/**
 * Azure SQL point-in-time-restore — PURE decision logic (no @azure/* deps).
 *
 * Split out so the restorable-window bounds check + target-name validation +
 * operation-status mapping can be unit-tested directly (the render harness and
 * the ARM client are not exercised here). The BFF route
 * (app/api/items/azure-sql-database/[id]/restore) and the editor panel
 * (lib/editors/components/sql-restore-panel.tsx) both import these so the
 * client-side gating and the server-side validation stay one-for-one.
 *
 * Azure control-plane facts encoded here (Microsoft Learn — Databases -
 * Create Or Update #createMode, "Restore a database from a backup in Azure SQL
 * Database"):
 *   - A point-in-time restore ALWAYS creates a NEW database (you never restore
 *     in place); the target name must therefore differ from every existing
 *     database on the server.
 *   - restorePointInTime must fall inside [earliestRestoreDate, now] — the PITR
 *     window bounded by the backup-retention period.
 */

/** Restorable window for a live database, as read from ARM. */
export interface RestorableWindow {
  /** ISO8601 — the earliest time the DB can be restored to (from ARM
   *  properties.earliestRestoreDate). */
  earliestRestoreDate: string;
  /** ISO8601 — the latest restorable time (≈ now; the most recent log backup). */
  latestRestoreDate: string;
}

/** Azure SQL database name rules (Microsoft.Sql/servers/databases). */
export const SQL_DB_NAME_MAX = 128;
// Disallowed: control chars, and the set SQL Database rejects in a db name
// (<>*%&:\/? plus trailing period/space). Keep this conservative — ARM will
// reject anything looser, but we give a precise message up front.
const INVALID_DB_NAME_CHARS = /[<>*%&:\/?"| -]/;

export interface RestoreValidationInput {
  /** The restorable window from ARM (undefined until loaded). */
  window?: RestorableWindow | null;
  /** ISO8601 restore point the user picked. */
  restorePointInTime?: string;
  /** New (target) database name the restore will create. */
  targetDatabase?: string;
  /** Existing database names on the server — the target must not collide. */
  existingNames?: string[];
  /** The source database name — restoring onto its own name is not allowed
   *  (PITR always creates a NEW database). */
  sourceDatabase?: string;
}

export interface RestoreValidation {
  ok: boolean;
  /** Field-precise error when ok === false. */
  error?: string;
}

/** Trimmed lower-case set for case-insensitive collision checks. */
function lowerSet(names?: string[]): Set<string> {
  return new Set((names || []).map((n) => n.trim().toLowerCase()).filter(Boolean));
}

/**
 * Validate a restore request against the real ARM window + naming rules.
 * Returns the FIRST failing reason so the UI can show a single precise message.
 * Pure + synchronous — safe to call on every keystroke.
 */
export function validateRestoreRequest(input: RestoreValidationInput): RestoreValidation {
  const target = (input.targetDatabase || '').trim();
  if (!target) return { ok: false, error: 'Enter a name for the restored database.' };
  if (target.length > SQL_DB_NAME_MAX) {
    return { ok: false, error: `Database name must be ${SQL_DB_NAME_MAX} characters or fewer.` };
  }
  if (INVALID_DB_NAME_CHARS.test(target)) {
    return { ok: false, error: 'Database name contains characters Azure SQL does not allow (< > * % & : \\ / ? " |).' };
  }
  if (/[ .]$/.test(target)) {
    return { ok: false, error: 'Database name cannot end with a space or period.' };
  }
  const existing = lowerSet(input.existingNames);
  if (existing.has(target.toLowerCase())) {
    return { ok: false, error: `A database named "${target}" already exists on this server. Point-in-time restore creates a NEW database — choose a different name.` };
  }
  if (input.sourceDatabase && input.sourceDatabase.trim().toLowerCase() === target.toLowerCase()) {
    return { ok: false, error: 'The target name must differ from the source database — restore always creates a new database.' };
  }

  if (!input.window) return { ok: false, error: 'Restorable window not loaded yet.' };
  const rp = input.restorePointInTime ? Date.parse(input.restorePointInTime) : NaN;
  if (Number.isNaN(rp)) return { ok: false, error: 'Pick a valid restore point in time.' };
  const earliest = Date.parse(input.window.earliestRestoreDate);
  const latest = Date.parse(input.window.latestRestoreDate);
  if (!Number.isNaN(earliest) && rp < earliest) {
    return { ok: false, error: `Restore point is before the earliest available backup (${input.window.earliestRestoreDate}).` };
  }
  if (!Number.isNaN(latest) && rp > latest) {
    return { ok: false, error: `Restore point is after the latest restorable time (${input.window.latestRestoreDate}).` };
  }
  return { ok: true };
}

/**
 * Clamp an ISO restore point to the window bounds — used to seed the time
 * picker's default (the window midpoint would be surprising; default to the
 * latest restorable time, the most common "undo the last bad change" intent).
 */
export function defaultRestorePoint(window?: RestorableWindow | null): string {
  if (!window) return new Date().toISOString();
  return window.latestRestoreDate;
}

/** Terminal + in-flight states of the restore LRO, normalized for the UI. */
export type RestoreStatus = 'InProgress' | 'Succeeded' | 'Failed' | 'Unknown';

/**
 * Map an ARM async-operation `status` (Azure-AsyncOperation payload) OR a target
 * database `properties.status` to the normalized UI status. ARM async ops report
 * InProgress / Succeeded / Failed / Canceled; a freshly-created DB reports
 * 'Creating' → 'Online'. Anything else is Unknown (keep polling).
 */
export function normalizeRestoreStatus(raw: string | undefined | null): RestoreStatus {
  const s = String(raw || '').toLowerCase();
  if (s === 'succeeded' || s === 'online') return 'Succeeded';
  if (s === 'failed' || s === 'canceled' || s === 'cancelled') return 'Failed';
  if (s === 'inprogress' || s === 'creating' || s === 'running' || s === 'pending' || s === 'accepted') return 'InProgress';
  return 'Unknown';
}
