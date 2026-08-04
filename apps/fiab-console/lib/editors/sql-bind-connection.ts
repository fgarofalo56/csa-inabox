/**
 * #2723 — client-side authority binding for the unified SQL database editor.
 *
 * The `azure-sql-database` /query and /copilot routes DERIVE their execution
 * target (server + database) from the OWNED item's bound connection — the
 * request body can only trigger a rejection, never pick the target. So before
 * the editor runs a query (or asks Copilot to ground on the schema) it must
 * PERSIST the user's current server/database selection to the item via
 * `POST /connect`. That call is what turns a freshly-picked server/database
 * into the item's bound authority.
 *
 * Extracted out of `unified-sql-database-editor.tsx` (WS-E monolith ratchet:
 * split by bounded context — this is the service-adapter slice) so the
 * security-critical binding step is independently unit-testable.
 */

/** A stable identity for one server/database selection, used to bind at most once. */
export function connectionKey(family: string, server: string, database: string): string {
  return `${family}|${server}|${database}`;
}

/** Outcome of a bind attempt. `key` is the value to cache so we don't re-bind. */
export type BindOutcome =
  | { ok: true; key: string }
  | { ok: false; error: string };

/**
 * Persist `{ family, server, database }` to the item's bound connection, unless
 * `cachedKey` already matches this selection (in which case the item is already
 * bound and we skip the round-trip).
 *
 * Returns `{ ok:true, key }` when the item is bound to this selection — the
 * caller should cache `key`. Returns `{ ok:false, error }` when the bind was
 * refused; the caller MUST NOT proceed to execute, because the route would run
 * against a stale binding (or refuse).
 *
 * `postJson` is injected so this is testable without a network — the editor
 * passes its own `fetchJson`.
 */
export async function bindItemConnection(opts: {
  id: string;
  family: string;
  server: string;
  database: string;
  cachedKey: string;
  postJson: (url: string, init: RequestInit) => Promise<any>;
}): Promise<BindOutcome> {
  const { id, family, server, database, cachedKey, postJson } = opts;
  const key = connectionKey(family, server, database);
  // Already bound to this exact selection — nothing to do.
  if (cachedKey === key) return { ok: true, key };
  // An unsaved item ('new') has no id to bind to; the caller creates it first.
  if (!id || id === 'new') return { ok: false, error: 'save this item before running a query' };

  const res = await postJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family, server, database }),
  }).catch(() => null);

  if (res?.ok) return { ok: true, key };
  return { ok: false, error: res?.error || 'could not bind the connection to this item' };
}
