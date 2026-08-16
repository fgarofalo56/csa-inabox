/**
 * #2723 — authority binding for the azure-sql-database execution routes.
 *
 * BEFORE: `POST /query` and `POST /copilot` read `server` + `database` from the
 * REQUEST BODY and executed as the Console managed identity, never consulting
 * the `[id]` item. The id conveyed NO authority, so any Loom-session holder
 * could point the UAMI at any server/database it could reach (a confused-deputy
 * / js/user-controlled-bypass hole — the #2658 family).
 *
 * AFTER: the caller must OWN the `[id]` item (loadOwnedItem / withWorkspaceOwner),
 * and the server + database to execute against are DERIVED from that owned item's
 * bound connection — `state.connection.{server,database}`, the exact shape the
 * sibling `POST /connect` route persists. The request body is NEVER trusted to
 * pick the target; a body that names a DIFFERENT server/database is rejected, so
 * a caller can only run SQL against the database THEIR item is bound to.
 *
 * Server-only helper (imports only types) — safe to import from a route handler.
 */
import type { WorkspaceItem } from '@/lib/types/workspace';
import { admitBoundSqlTarget } from '@/app/api/items/_lib/sql-server-scope';

/**
 * The Azure SQL server + database bound to an azure-sql-database item via the
 * `POST /connect` route (`state.connection`). Values are trimmed; a missing /
 * non-string field yields `''` (an unbound item has `server === ''`).
 */
export function boundSqlConnection(item: WorkspaceItem): { server: string; database: string } {
  const conn = (item?.state as { connection?: { server?: unknown; database?: unknown } } | undefined)?.connection;
  const server = typeof conn?.server === 'string' ? conn.server.trim() : '';
  const database = typeof conn?.database === 'string' ? conn.database.trim() : '';
  return { server, database };
}

/**
 * True when a submitted host names the SAME logical Azure SQL server as the
 * bound host. Tolerant of bare-name vs FQDN (the editor binds and queries with
 * the bare server name, but a caller could send the fully-qualified host), so
 * the comparison is on the first DNS label, case-insensitively — which keeps it
 * cloud-agnostic (Commercial and Gov SQL suffixes both compare equal). An empty
 * `submitted` is treated as "no conflict" (the caller left the target implicit).
 */
export function sqlHostsMatch(submitted: string, bound: string): boolean {
  const firstLabel = (h: string) => h.trim().toLowerCase().split('.')[0];
  const s = submitted.trim().toLowerCase();
  if (!s) return true;
  const b = bound.trim().toLowerCase();
  return s === b || firstLabel(s) === firstLabel(b);
}

/** Resolution of the target to execute against, or a refusal with an HTTP shape. */
export type SqlTargetResult =
  | { ok: true; server: string; database: string }
  | { ok: false; status: number; code: string; error: string };

/**
 * Resolve the server + database an execution route may use, given the ALREADY-
 * OWNED item and whatever the request body submitted. The returned server /
 * database are ALWAYS the item's bound values — the body is used only to REJECT
 * a mismatch, never to choose the target (#2723). Refusals:
 *   - item has no bound connection            → 409 `no_bound_connection`
 *   - binding is outside the authorized subs  → 403 `server_not_governed`
 *   - body names a different server           → 403 `server_mismatch`
 *   - body names a different database         → 403 `database_mismatch`
 *
 * GHSA-v8r7-c2p5-mjf2, second pass. This USED TO return the RAW bound string.
 * That was Layer 1 + Layer 2 only, and Layer 2 is not a boundary: `PATCH
 * /api/items/[type]/[id]` replaces `state` WHOLESALE with body JSON, so the
 * caller writes the very value this function read. Downstream that is worse
 * than the ARM routes — `azure-sql-client.getPool` composes
 * `server.includes('.') ? server : `${server}.${sqlHostSuffix()}`` and presents
 * an Entra ACCESS TOKEN for the SQL scope to the resulting host, so a bound
 * `attacker.example.com` was arbitrary SQL *plus credential egress*.
 *
 * It now delegates to `_lib/sql-server-scope.admitBoundSqlTarget`, which adds
 * Layer 3: an ARM-id binding must be in `sqlAuthorizedSubscriptions()`, and an
 * FQDN binding is reduced to its first DNS label so no bound value can name a
 * host outside this cloud's SQL suffix.
 */
export function resolveOwnedSqlTarget(
  item: WorkspaceItem,
  submitted?: { server?: unknown; database?: unknown },
): SqlTargetResult {
  const admitted = admitBoundSqlTarget(item, submitted, 'sql', { requireDatabase: true });
  if (!admitted.ok) {
    return { ok: false, status: admitted.status, code: admitted.code, error: admitted.error };
  }
  return { ok: true, server: admitted.server, database: admitted.database };
}
