/**
 * LU-3 — the Loom Unity / Unity Catalog **audit choke point**.
 *
 * Every Unity Catalog **REST** call the Console BFF makes funnels through one of
 * TWO audited transports, both of which call {@link recordUnityAccess} from a
 * `finally` block:
 *
 *   - `ucFetch` in `lib/azure/unity-catalog-client.ts` — the backend-agnostic
 *     client (Loom Unity / OSS Unity Catalog in Gov, Databricks UC in
 *     Commercial). It holds that file's only outbound fetch.
 *   - `dbxFetch` in `lib/azure/databricks-client.ts` — the Databricks workspace
 *     client. It audits the calls whose path is a Unity Catalog REST path
 *     (`/api/2.x/unity-catalog/**`, lineage-tracking), which is where catalog
 *     OWNER CHANGE (`patchUcCatalog`), catalog DELETE (`deleteUcCatalog`) and
 *     GRANT MUTATION (`updateUcPermissions`) live on the Commercial default
 *     path. Non-catalog Databricks REST (jobs, warehouses, clusters, files) is
 *     out of scope for this trail and is NOT recorded.
 *
 * ### What this trail does NOT cover (read this before trusting it)
 *
 * `unity-catalog-client.ts` also reaches the catalog through ~25
 * `executeStatement(...)` calls — the Databricks **SQL Statement Execution**
 * API, not the UC REST API. Those produce NO row here, and they include
 * governance DDL: `createUcPolicy` / `dropUcPolicy` (ABAC row filters + column
 * masks), `mutateUcGovernedTag`, and `setUcTags`. They are covered by the
 * Databricks-side `system.access.audit` table on the Commercial backend, not by
 * this trail. Tracked for choke-pointing — see the issue linked from
 * `scripts/ci/check-unity-audit-chokepoint.mjs` (`SQL_EXIT_BASELINE`), which
 * ratchets the count so a NEW un-audited SQL exit fails the build.
 *
 * What IS enforced, not merely documented, by
 * `scripts/ci/check-unity-audit-chokepoint.mjs` (merge-blocking):
 *   (a) any file outside the allowlist that combines a Loom Unity address OR a
 *       Unity Catalog REST path with request-shaped code fails the build;
 *   (b) `unity-catalog-client.ts` growing a second outbound fetch fails;
 *   (c) `recordUnityAccess(` leaving the `finally` of EITHER `ucFetch` or
 *       `dbxFetch` fails — the check brace-matches the actual finally block
 *       rather than substring-scanning the rest of the file;
 *   (d) `unity-catalog-client.ts` growing a new `executeStatement(` exit fails.
 * The guard is the point of this item; the recorder below is the easy half.
 *
 * ## What each row carries (FedRAMP AU-2/AU-3: who / what / when / outcome)
 *
 *   WHO      `actorOid` (Entra object id from the session) + `actorUpn`.
 *            Background/system callers with no request scope record
 *            `oid='system'` HONESTLY rather than borrowing the last user.
 *   WHAT     `operation` (dotted verb — `catalog.list`, `grant.update`,
 *            `temporary-credential.vend`) + `securableType` + `securableFqn`,
 *            derived from the REST path by {@link classifyUnityCall}.
 *   WHEN     `at` (ISO-8601) + `durationMs`.
 *   OUTCOME  `success` | `failure` | **`denied`**. A denial is the single most
 *            valuable audit row and the one most often dropped, so it has a
 *            dedicated classifier ({@link unityOutcomeForError}) covering both
 *            an upstream 401/403 AND the fail-closed local refusal when the
 *            Console cannot mint a Loom Unity credential (LU-2).
 *
 * ## Two sinks, one call
 *
 *   1. **Cosmos `_auditLog`** — the authoritative Loom trail (`itemType:
 *      'loom-unity'`), read back by the "Loom Unity system tables" pane. NOTE:
 *      /admin/audit-logs scopes its Cosmos read to `c.tenantId = <session oid>`
 *      while these rows carry the Entra **tenant** id, so they do NOT appear on
 *      that surface — the tenant-admin-gated system-tables pane is their reader.
 *   2. **`LoomAudit_CL`** — fanned out through `emitAuditEvent`, the existing
 *      Azure Monitor Logs-Ingestion (DCR) stream that Sentinel/any SIEM reads.
 *      Un-provisioned DCR = silent no-op (see lib/admin/audit-stream.ts); the
 *      Cosmos trail is unaffected, so this module has NO day-one gate.
 *
 * ## Boundary egress — READS NEVER LEAVE THE ESTATE
 *
 * `emitAuditEvent` additionally fans events out to any tenant-registered
 * OUTBOUND WEBHOOK (`emitLoomEvent`, lib/events/webhook-emitter.ts) — a
 * third-party URL outside the Loom boundary. A catalog READ is high-volume and
 * carries actor UPN + securable FQN, so read rows are emitted with
 * `{ webhook: false }`: they reach Cosmos and the in-boundary SIEM stream and
 * stop there. Only catalog MUTATIONS (create/update/delete/grant change,
 * credential vend) — the events an external SOC actually subscribes to — are
 * allowed past the boundary. See {@link isUnityMutation}.
 *
 * Writes are fire-and-forget by contract: an audit-store hiccup must never turn
 * a working catalog read into a 500, and must never add latency to a federation
 * loop. Nothing here throws. {@link flushUnityAudit} exists so routes and tests
 * can await the in-flight writes deterministically.
 *
 * Every import is LAZY. This module is pulled in by `unity-catalog-client.ts`,
 * which is imported by ~40 API routes and by pure capability surfaces — hoisting
 * `next/headers`, Cosmos, or the credential chain to module scope here would
 * change the static import graph of all of them.
 *
 * No Microsoft Fabric / Power BI is reachable from any path in this file
 * (.claude/rules/no-fabric-dependency.md).
 */

/** Which catalog backend served the call (lib/azure/uc-backend.ts). */
export type UnityAuditBackend = 'oss' | 'databricks';

/** Outcome of one catalog call. `denied` == an authorization refusal. */
export type UnityAuditOutcome = 'success' | 'failure' | 'denied';

/** The `_auditLog.itemType` every Loom Unity access row carries. */
export const UNITY_AUDIT_ITEM_TYPE = 'loom-unity';

/** Prefix on the dotted audit action (`unity.catalog.list`, …). */
export const UNITY_AUDIT_ACTION_PREFIX = 'unity.';

/** Collection-scope sentinel — a list call targets a family, not one securable. */
export const UNITY_SECURABLE_ALL = '*';

// ─────────────────────────────────────────────────────────────────────────────
// 1) Path → operation + securable  (pure; unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** What one Unity Catalog REST call is doing, in audit terms. */
export interface UnityCallDescriptor {
  /** Dotted verb: `<securable-family>.<verb>`, e.g. `table.get`, `grant.update`. */
  operation: string;
  /** Securable family the call targets (`catalog`, `table`, `metastore`, …). */
  securableType: string;
  /** Three-level FQN when the call names one object, else {@link UNITY_SECURABLE_ALL}. */
  securableFqn: string;
}

/**
 * REST family segment → securable type. Covers BOTH spellings of the one
 * Databricks↔OSS naming split (`storage-credentials` vs `credentials`, see
 * `ossUcRewritePath`) because the choke point classifies the path BEFORE the
 * rewrite, so the audit row reads the same on either backend.
 */
const FAMILY_SECURABLE: Record<string, string> = {
  catalogs: 'catalog',
  schemas: 'schema',
  tables: 'table',
  volumes: 'volume',
  functions: 'function',
  models: 'registered_model',
  'registered-models': 'registered_model',
  'external-locations': 'external_location',
  'storage-credentials': 'storage_credential',
  credentials: 'storage_credential',
  metastores: 'metastore',
  metastore_summary: 'metastore',
  shares: 'share',
  recipients: 'recipient',
  providers: 'provider',
  connections: 'connection',
  bindings: 'binding',
  'temporary-table-credentials': 'temporary_credential',
  'temporary-path-credentials': 'temporary_credential',
  'temporary-volume-credentials': 'temporary_credential',
  'online-tables': 'online_table',
  'clean-rooms': 'clean_room',
};

/** HTTP method → mutation verb for a family that names an object. */
const METHOD_VERB: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/**
 * Credential-vending families: a POST here hands the caller a live storage
 * token, so it is recorded as `vend` (not `create`) — the highest-signal
 * operation in the whole surface for an ATO reviewer.
 */
const VENDING_FAMILIES = new Set([
  'temporary-table-credentials',
  'temporary-path-credentials',
  'temporary-volume-credentials',
]);

function decodeSegment(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/**
 * Derive `{ operation, securableType, securableFqn }` from a Unity Catalog REST
 * method + path. PURE — no env, no I/O — so the audit vocabulary is unit-tested
 * independently of the transport.
 *
 * Recognised shapes (Databricks UC 2.1 == OSS Unity Catalog 0.5):
 *   /api/2.1/unity-catalog/{family}[/{full_name}]
 *   /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 *   /api/2.1/unity-catalog/effective-permissions/{securable_type}/{full_name}
 *   /api/2.1/unity-catalog/metastores/{id}/systemschemas[/{schema}]
 *   /api/2.0/lineage-tracking/{table|column}-lineage
 *
 * An unrecognised path is NEVER dropped — it records as `unity.request` with
 * the raw path as the securable, so an un-modelled future family still lands in
 * the audit trail (silently skipping it would be the exact failure this item
 * exists to prevent).
 */
export function classifyUnityCall(method: string, path: string): UnityCallDescriptor {
  const verbUpper = (method || 'GET').toUpperCase();
  const clean = (path || '').split('?')[0].split('#')[0];
  const segments = clean.split('/').filter(Boolean);

  // /api/2.0/lineage-tracking/table-lineage | column-lineage
  const lineageIdx = segments.indexOf('lineage-tracking');
  if (lineageIdx >= 0) {
    const kind = (segments[lineageIdx + 1] || 'table-lineage').replace(/-lineage$/, '');
    return { operation: `lineage.${kind}.read`, securableType: 'table', securableFqn: UNITY_SECURABLE_ALL };
  }

  const ucIdx = segments.indexOf('unity-catalog');
  if (ucIdx < 0) {
    return { operation: 'unity.request', securableType: 'unknown', securableFqn: clean || UNITY_SECURABLE_ALL };
  }
  const rest = segments.slice(ucIdx + 1).map(decodeSegment);
  const family = rest[0] || '';

  // /permissions/{securable_type}/{full_name}  — the grant graph.
  if (family === 'permissions' || family === 'effective-permissions') {
    const securableType = (rest[1] || 'unknown').toLowerCase();
    const fqn = rest.slice(2).join('/') || UNITY_SECURABLE_ALL;
    const prefix = family === 'permissions' ? 'grant' : 'effective-grant';
    const op = verbUpper === 'GET' ? 'read' : 'update';
    return { operation: `${prefix}.${op}`, securableType, securableFqn: fqn };
  }

  // /metastores/{id}/systemschemas[/{schema}]
  if (family === 'metastores' && rest[2] === 'systemschemas') {
    const schema = rest[3];
    const op = verbUpper === 'GET' ? (schema ? 'get' : 'list') : (verbUpper === 'DELETE' ? 'disable' : 'enable');
    return { operation: `system-schema.${op}`, securableType: 'metastore', securableFqn: rest[1] || UNITY_SECURABLE_ALL };
  }

  const securableType = FAMILY_SECURABLE[family] || family.replace(/-/g, '_') || 'unknown';
  const name = rest.slice(1).join('/');

  if (VENDING_FAMILIES.has(family)) {
    // The body names the table/path; the URL does not. Record the vend itself —
    // the securable lands on the row via the caller-supplied FQN hint.
    return { operation: 'temporary-credential.vend', securableType: 'temporary_credential', securableFqn: name || UNITY_SECURABLE_ALL };
  }

  if (verbUpper === 'GET') {
    return {
      operation: `${securableType}.${name ? 'get' : 'list'}`,
      securableType,
      securableFqn: name || UNITY_SECURABLE_ALL,
    };
  }
  const verb = METHOD_VERB[verbUpper] || 'request';
  return {
    operation: `${securableType}.${verb}`,
    securableType,
    securableFqn: name || UNITY_SECURABLE_ALL,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Outcome classification — denials are first-class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a failed catalog call to an audit outcome.
 *
 * `denied` is reserved for AUTHORIZATION refusals, because "who was told no"
 * is what an ATO reviewer actually hunts for:
 *   - the catalog answered 401 / 403, OR
 *   - the Console refused to make the call at all because it could not present
 *     a credential (LU-2 `OssUcAuthNotConfiguredError`, which fails CLOSED).
 *
 * Everything else — a 501 honest gate for a Databricks-only family, a 404, a
 * timeout, an un-deployed `LOOM_UNITY_URL` — is `failure`. Widening `denied` to
 * cover those would drown the signal it exists to carry.
 *
 * The error type is matched by `name`, not `instanceof`, so this stays free of
 * an import cycle back into uc-backend.ts.
 */
export function unityOutcomeForError(err: unknown, status?: number): UnityAuditOutcome {
  const e = err as { name?: string; status?: number } | null;
  const code = Number(status || e?.status || 0);
  if (code === 401 || code === 403) return 'denied';
  if (e?.name === 'OssUcAuthNotConfiguredError') return 'denied';
  return 'failure';
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) The recorder
// ─────────────────────────────────────────────────────────────────────────────

/** One catalog call, as handed to the choke point by `ucFetch`. */
export interface UnityAccessEvent extends UnityCallDescriptor {
  backend: UnityAuditBackend;
  /** HTTP method as issued. */
  method: string;
  /** REST path as issued (pre-rewrite, query string stripped by the recorder). */
  path: string;
  /** Databricks workspace host the call targeted (absent on the OSS backend —
   *  Loom Unity is a single server addressed by LOOM_UNITY_URL). */
  workspaceHost?: string;
  outcome: UnityAuditOutcome;
  /** Upstream HTTP status, or 0 when the call never left the BFF. */
  status: number;
  durationMs: number;
  /** Rows/objects the response carried, for aggregated list reads. */
  resultCount?: number;
  /** Honest failure text (truncated). */
  detail?: string;
}

/** A Loom Unity access row as read back by the system-tables pane. */
export interface UnityAuditRecord {
  id: string;
  at: string;
  actorOid: string;
  actorUpn: string;
  operation: string;
  securableType: string;
  securableFqn: string;
  backend: UnityAuditBackend | string;
  method: string;
  path: string;
  outcome: UnityAuditOutcome | string;
  status: number;
  durationMs: number;
  resultCount?: number | null;
  detail?: string;
  workspaceHost?: string;
  tenantId?: string;
}

/** Resolved acting principal. `system` is honest, not a placeholder. */
interface UnityActor { oid: string; upn: string; tenantId: string; viaApiToken: boolean }

const SYSTEM_ACTOR: UnityActor = { oid: 'system', upn: 'system', tenantId: 'system', viaApiToken: false };

/**
 * Best-effort actor resolution. Reads the request-scoped session when one
 * exists; a background job / warmer / startup probe has no request scope, and
 * `cookies()` throws there — that path records the SYSTEM actor rather than
 * attributing a machine call to whichever human happened to be last.
 */
async function resolveUnityActor(): Promise<UnityActor> {
  try {
    const { getSession } = await import('@/lib/auth/session');
    const s = getSession();
    if (!s) return SYSTEM_ACTOR;
    const oid = s.claims?.oid || 'unknown';
    return {
      oid,
      upn: s.claims?.upn || s.claims?.email || oid,
      tenantId: s.claims?.tid || oid,
      viaApiToken: !!s.pat,
    };
  } catch {
    return SYSTEM_ACTOR;
  }
}

/** In-flight audit writes, so {@link flushUnityAudit} can be awaited. */
const inFlight = new Set<Promise<void>>();

/**
 * Is this call a MUTATION of the catalog (rather than a read)?
 *
 * Drives the boundary-egress decision: only mutations are allowed out to
 * tenant-registered outbound webhooks. A read is decided by BOTH signals —
 * a safe HTTP method AND a read-shaped operation verb — so a mutation that
 * arrives with a mislabelled method (or an un-modelled `unity.request` on a
 * POST) is treated as a mutation and audited conservatively, never leaked as a
 * read. `temporary-credential.vend` is a mutation: it hands out a live storage
 * token and is the highest-signal row an external SOC subscribes to.
 *
 * PURE — unit-tested.
 */
export function isUnityMutation(ev: Pick<UnityAccessEvent, 'method' | 'operation'>): boolean {
  const method = (ev.method || 'GET').toUpperCase();
  const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const verb = (ev.operation || '').split('.').pop() || '';
  const readVerb = verb === 'get' || verb === 'list' || verb === 'read';
  return !(safeMethod && readVerb);
}

/**
 * Cosmos logical-partition key for one access row.
 *
 * `_auditLog` is partitioned on `/itemId` (cosmos-client.ts) with the usual
 * 20 GB / 10k RU-per-second logical-partition caps. Keying every row on the
 * securable FQN keeps one object's history together — but EVERY collection read
 * (`catalog.list`, `schema.list`, `table.list`, the LU-2 health probe) resolves
 * to the `'*'` sentinel, so the estate's highest-volume operation would pile
 * into ONE logical partition and eventually start throwing on write. Since
 * `recordUnityAccess` swallows write errors by contract, that failure would be
 * SILENT — the trail simply stops growing on the rows the pane shows by default.
 *
 * So collection-scope rows are spread across `unity:<operation>:<YYYY-MM-DD>`
 * buckets instead. Every reader here queries cross-partition on `c.itemType`
 * (never on `itemId`), so nothing depends on the sentinel value.
 *
 * PURE — unit-tested.
 */
export function unityAuditPartitionKey(securableFqn: string, operation: string, at: string): string {
  const scope = securableFqn || UNITY_SECURABLE_ALL;
  if (scope !== UNITY_SECURABLE_ALL) return scope;
  const day = (at || new Date().toISOString()).slice(0, 10);
  return `unity:${operation || 'unknown'}:${day}`;
}

/**
 * Write ONE `_auditLog` row for a catalog call and fan it out to `LoomAudit_CL`.
 * Never throws, never rejects — audit is additive telemetry on the hot path and
 * an audit-store outage must not break the catalog.
 *
 * The in-flight promise is registered SYNCHRONOUSLY (before the first `await`)
 * so a caller that fires this with `void` and then awaits {@link flushUnityAudit}
 * cannot race past a write that has not started yet.
 */
export function recordUnityAccess(ev: UnityAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const path = (ev.path || '').split('?')[0];
  const scope = ev.securableFqn || UNITY_SECURABLE_ALL;
  const action = `${UNITY_AUDIT_ACTION_PREFIX}${ev.operation}`;
  const mutation = isUnityMutation(ev);

  const write = (async () => {
    const actor = await resolveUnityActor();
    const summary =
      `Loom Unity ${ev.operation} on ${ev.securableType}:${scope} by ${actor.upn}` +
      (ev.outcome === 'denied' ? ` — DENIED (HTTP ${ev.status || 'n/a'})` : '') +
      (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '') +
      (ev.resultCount === undefined ? '' : ` (${ev.resultCount} object(s))`);

    try {
      const { auditLogContainer } = await import('@/lib/azure/cosmos-client');
      const c = await auditLogContainer();
      await c.items.create({
        id: crypto.randomUUID(),
        // `_auditLog` is partitioned on /itemId — see unityAuditPartitionKey for
        // why collection-scope rows do NOT all land on the '*' sentinel.
        itemId: unityAuditPartitionKey(scope, ev.operation, at),
        itemType: UNITY_AUDIT_ITEM_TYPE,
        tenantId: actor.tenantId,
        action,
        summary,
        operation: ev.operation,
        securableType: ev.securableType,
        securableFqn: scope,
        backend: ev.backend,
        method: (ev.method || 'GET').toUpperCase(),
        path,
        workspaceHost: ev.workspaceHost || '',
        outcome: ev.outcome,
        status: ev.status ?? 0,
        durationMs: ev.durationMs ?? 0,
        resultCount: ev.resultCount ?? null,
        mutation,
        viaApiToken: actor.viaApiToken,
        actorOid: actor.oid,
        // `actorUpn` is the field the pane + the actor filter read; `upn`/`who`
        // keep the shape the generic /admin/audit-logs rows use. Writing only
        // the latter left every `actor` cell in the pane blank.
        actorUpn: actor.upn,
        upn: actor.upn,
        who: actor.upn,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
        at,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[unity-audit] Cosmos audit row write failed:', (e as Error)?.message || e);
    }

    try {
      const { emitAuditEvent } = await import('@/lib/admin/audit-stream');
      emitAuditEvent({
        actorOid: actor.oid,
        actorUpn: actor.upn,
        action,
        targetType: `unity:${ev.securableType}`,
        targetId: scope,
        outcome: ev.outcome,
        tenantId: actor.tenantId,
        timestamp: at,
        detail: {
          backend: ev.backend,
          method: (ev.method || 'GET').toUpperCase(),
          path,
          status: ev.status ?? 0,
          durationMs: ev.durationMs ?? 0,
          resultCount: ev.resultCount ?? null,
          workspaceHost: ev.workspaceHost || '',
          viaApiToken: actor.viaApiToken,
          ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
        },
      // BOUNDARY EGRESS: reads stay inside. Only a mutation may be forwarded to
      // a tenant-registered outbound webhook (a third-party URL).
      }, { webhook: mutation });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[unity-audit] SIEM fan-out failed:', (e as Error)?.message || e);
    }
  })();

  inFlight.add(write);
  // `then(cleanup, cleanup)` rather than `.finally()` so the derived promise can
  // never surface as an unhandled rejection.
  const cleanup = () => { inFlight.delete(write); };
  void write.then(cleanup, cleanup);
  return write;
}

/**
 * Await every audit write started so far.
 *
 * Drains a SNAPSHOT, bounded — it awaits the writes that existed when it was
 * called plus at most {@link FLUSH_MAX_PASSES} follow-on generations. Looping
 * `while (inFlight.size)` would never terminate on a live server under
 * sustained catalog traffic, because each pass re-reads a set the request
 * handlers keep refilling.
 */
export const FLUSH_MAX_PASSES = 5;

export async function flushUnityAudit(): Promise<void> {
  for (let pass = 0; pass < FLUSH_MAX_PASSES; pass++) {
    const batch = Array.from(inFlight);
    if (!batch.length) return;
    await Promise.allSettled(batch);
  }
}

/**
 * Is `path` a Unity Catalog REST path? Used to pick the Unity Catalog calls out
 * of the general Databricks workspace client, which also carries jobs, clusters,
 * warehouses, SQL and Files traffic that this trail does not claim to cover.
 * PURE — unit-tested.
 */
export function isUnityCatalogPath(path: string): boolean {
  const p = (path || '').split('?')[0];
  return /\/api\/2\.\d+\/unity-catalog\//.test(p) || /\/api\/2\.\d+\/lineage-tracking\//.test(p);
}

/**
 * The Databricks-side half of the choke point, called from the `finally` of
 * `dbxFetch` (lib/azure/databricks-client.ts).
 *
 * WHY THIS EXISTS: on the Commercial DEFAULT backend the live routes call
 * `lib/azure/databricks-client.ts` directly — `patchUcCatalog` (catalog OWNER
 * TRANSFER), `deleteUcCatalog` (catalog DELETE) and `updateUcPermissions`
 * (`PATCH /api/2.1/unity-catalog/permissions/...` — a GRANT MUTATION) all live
 * there, not behind `ucFetch`. Before this, those wrote no audit row at all
 * while the trail was advertised as complete. Ownership transfer and grant
 * change are precisely the rows an ATO reviewer hunts for.
 *
 * Non-catalog Databricks REST is ignored (returns without writing) so the trail
 * stays a CATALOG access trail rather than a general workspace request log.
 * Never throws — same fire-and-forget contract as {@link recordUnityAccess}.
 */
export function recordDatabricksUnityAccess(opts: {
  path: string;
  method?: string;
  status?: number;
  durationMs?: number;
  error?: unknown;
  workspaceHost?: string;
}): void {
  try {
    if (!isUnityCatalogPath(opts.path)) return;
    const method = (opts.method || 'GET').toUpperCase();
    const status = Number(opts.status || (opts.error as { status?: number } | null)?.status || 0);
    // A non-2xx response is a failure even when fetch itself resolved — the
    // Databricks client throws on !ok downstream, but the audit row is written
    // here, before that throw, so classify from the status.
    const failed = !!opts.error || (status >= 400);
    void recordUnityAccess({
      ...classifyUnityCall(method, opts.path),
      backend: 'databricks',
      method,
      path: opts.path,
      workspaceHost: opts.workspaceHost || process.env.LOOM_DATABRICKS_HOSTNAME || '',
      status,
      durationMs: opts.durationMs ?? 0,
      outcome: failed ? unityOutcomeForError(opts.error, status) : 'success',
      detail: opts.error ? String((opts.error as Error)?.message || opts.error).slice(0, 400) : undefined,
    });
  } catch {
    /* audit is never allowed to break a catalog call */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Reader — "Loom Unity system tables"
// ─────────────────────────────────────────────────────────────────────────────

export interface UnityAuditQuery {
  /** Lower bound (ISO). Defaults to 7 days ago. */
  since?: string;
  /** Upper bound (ISO). */
  until?: string;
  /** `denied` narrows to refusals — the pane's highest-value view. */
  outcome?: UnityAuditOutcome;
  /** Substring match on the dotted operation. */
  operation?: string;
  /** Substring match on the securable FQN. */
  securable?: string;
  /** Substring match on the acting UPN / oid. */
  actor?: string;
  /** Max rows (1..1000, default 200). */
  limit?: number;
}

const MAX_LIMIT = 1000;

/** Clamp + normalize a caller-supplied query. Pure — unit-tested. */
export function normalizeUnityAuditQuery(q: UnityAuditQuery = {}): Required<Pick<UnityAuditQuery, 'since' | 'limit'>> & UnityAuditQuery {
  const limitRaw = Number(q.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : 200;
  const since = (q.since || '').trim() || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  return { ...q, since, limit };
}

/**
 * Read Loom Unity access rows from the authoritative Cosmos `_auditLog` trail.
 * Cross-partition by design: the pane asks "what happened across the catalog",
 * not "what happened to one securable".
 *
 * EVERY caller filter is pushed INTO the Cosmos query — none is applied in JS
 * after `SELECT TOP @top`. Post-filtering a truncated page is the exact
 * "auditor concludes nothing happened" failure this item exists to prevent:
 * searching for one user would return rows only if that user appeared in the
 * most recent N records of the window, and would otherwise render the pane's
 * "no catalog activity" empty state on a user who was very active.
 *
 * `CONTAINS(LOWER(...), @x)` is the Cosmos substring form; the needle is passed
 * as a bound parameter (never concatenated into the query text).
 */
export async function listUnityAccessRecords(q: UnityAuditQuery = {}): Promise<UnityAuditRecord[]> {
  const nq = normalizeUnityAuditQuery(q);
  const { auditLogContainer } = await import('@/lib/azure/cosmos-client');
  const c = await auditLogContainer();
  const where: string[] = ['c.itemType = @itemType', 'c.at >= @since'];
  const parameters: Array<{ name: string; value: string | number }> = [
    { name: '@itemType', value: UNITY_AUDIT_ITEM_TYPE },
    { name: '@since', value: nq.since },
  ];
  if (nq.until) { where.push('c.at <= @until'); parameters.push({ name: '@until', value: nq.until }); }
  if (nq.outcome) { where.push('c.outcome = @outcome'); parameters.push({ name: '@outcome', value: nq.outcome }); }
  if (nq.operation) {
    where.push('CONTAINS(LOWER(c.operation), @operation)');
    parameters.push({ name: '@operation', value: nq.operation.toLowerCase() });
  }
  if (nq.securable) {
    where.push('CONTAINS(LOWER(c.securableFqn), @securable)');
    parameters.push({ name: '@securable', value: nq.securable.toLowerCase() });
  }
  if (nq.actor) {
    where.push('(CONTAINS(LOWER(c.actorUpn), @actor) OR CONTAINS(LOWER(c.actorOid), @actor) OR CONTAINS(LOWER(c.upn), @actor))');
    parameters.push({ name: '@actor', value: nq.actor.toLowerCase() });
  }
  const { resources } = await c.items
    .query({
      query: `SELECT TOP @top * FROM c WHERE ${where.join(' AND ')} ORDER BY c.at DESC`,
      parameters: [...parameters, { name: '@top', value: nq.limit }],
    })
    .fetchAll();

  return resources as unknown as UnityAuditRecord[];
}

/** Aggregated shape backing the pane's summary strip. */
export interface UnityAuditSummary {
  total: number;
  success: number;
  failure: number;
  denied: number;
  /** Distinct acting principals in the window. */
  actors: number;
  /** Top operations by volume, densest first. */
  byOperation: Array<{ operation: string; count: number; denied: number }>;
  /** Top securables by volume. */
  bySecurable: Array<{ securableFqn: string; count: number; denied: number }>;
  /** Every denial in the window, newest first — never truncated by ranking. */
  denials: UnityAuditRecord[];
}

/**
 * Aggregate access rows for the pane. PURE — the pane's numbers are unit-tested
 * against hand-written rows rather than against whatever the reader returned.
 */
export function summarizeUnityAccess(records: UnityAuditRecord[], topN = 10): UnityAuditSummary {
  const byOp = new Map<string, { count: number; denied: number }>();
  const bySec = new Map<string, { count: number; denied: number }>();
  const actors = new Set<string>();
  let success = 0, failure = 0, denied = 0;

  for (const r of records) {
    if (r.outcome === 'denied') denied++;
    else if (r.outcome === 'failure') failure++;
    else success++;
    if (r.actorOid) actors.add(r.actorOid);

    const opKey = r.operation || 'unknown';
    const op = byOp.get(opKey) || { count: 0, denied: 0 };
    op.count++; if (r.outcome === 'denied') op.denied++;
    byOp.set(opKey, op);

    const secKey = r.securableFqn || UNITY_SECURABLE_ALL;
    const sec = bySec.get(secKey) || { count: 0, denied: 0 };
    sec.count++; if (r.outcome === 'denied') sec.denied++;
    bySec.set(secKey, sec);
  }

  const rank = (m: Map<string, { count: number; denied: number }>) =>
    Array.from(m.entries())
      .sort((a, b) => (b[1].count - a[1].count) || a[0].localeCompare(b[0]))
      .slice(0, topN);

  return {
    total: records.length,
    success,
    failure,
    denied,
    actors: actors.size,
    byOperation: rank(byOp).map(([operation, v]) => ({ operation, count: v.count, denied: v.denied })),
    bySecurable: rank(bySec).map(([securableFqn, v]) => ({ securableFqn, count: v.count, denied: v.denied })),
    denials: records.filter((r) => r.outcome === 'denied'),
  };
}

/**
 * The KQL the SIEM half of the trail is read with. Exported (and unit-tested)
 * so the pane can SHOW the operator the exact query to paste into Log Analytics
 * / Sentinel — the `LoomAudit_CL` rows are the same events, mirrored by
 * `emitAuditEvent`.
 *
 * `sinceHours` is coerced to an integer and clamped, so it can never carry a
 * caller-supplied fragment into the query text.
 */
export function unityAuditKql(opts: { sinceHours?: number; deniedOnly?: boolean; limit?: number } = {}): string {
  const hours = Math.min(24 * 90, Math.max(1, Math.floor(Number(opts.sinceHours) || 168)));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || 200)));
  const deniedFilter = opts.deniedOnly ? '\n| where Outcome == "denied"' : '';
  return [
    'LoomAudit_CL',
    `| where TimeGenerated > ago(${hours}h)`,
    '| where Action startswith "unity."',
    deniedFilter.replace(/^\n/, ''),
    '| project TimeGenerated, ActorUpn, ActorOid, Action, TargetType, TargetId, Outcome, Detail',
    '| order by TimeGenerated desc',
    `| take ${limit}`,
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) The "Loom Unity system tables" surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Views the Loom Unity system-tables surface serves. These are the OSS-backend
 * answer to Databricks' `system.access.audit` — the same question ("who touched
 * which securable, and were they allowed to"), sourced from the BFF choke point
 * instead of a Databricks-managed schema.
 */
export type UnitySystemTable = 'audit' | 'denials' | 'summary';

export const UNITY_SYSTEM_TABLES: ReadonlyArray<{ id: UnitySystemTable; label: string; description: string }> = [
  { id: 'audit', label: 'access.audit', description: 'Every catalog call the Console BFF made — actor, operation, securable, outcome, latency.' },
  { id: 'denials', label: 'access.denied', description: 'Authorization refusals only: 401/403 from the catalog, plus calls the BFF refused to make because it could not present a credential.' },
  { id: 'summary', label: 'access.summary', description: 'Volume and denial counts per operation and per securable over the window.' },
];

/** Tabular result shape — matches the existing UC audit dialog's contract. */
export interface UnitySystemTableResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs: number;
  /** How many raw access records the view was computed from. */
  recordCount: number;
  /**
   * TRUE when the read hit the row limit, so `recordCount` (and every number in
   * the `summary` view) describes the most recent `limit` records in the window
   * rather than the whole window. The pane MUST say so — "2 denials in the last
   * 7 days" is a different claim from "2 denials in the last 200 calls".
   */
  truncated: boolean;
  /** The row limit the read was capped at (what `truncated` is relative to). */
  limit: number;
  /** The equivalent KQL against `LoomAudit_CL`, for SIEM/Sentinel. */
  kql: string;
}

const AUDIT_COLUMNS = [
  'time', 'actor', 'actor_oid', 'operation', 'securable_type', 'securable',
  'outcome', 'status', 'duration_ms', 'backend', 'method', 'detail',
];

function auditRow(r: UnityAuditRecord): Record<string, unknown> {
  return {
    time: r.at,
    actor: r.actorUpn,
    actor_oid: r.actorOid,
    operation: r.operation,
    securable_type: r.securableType,
    securable: r.securableFqn,
    outcome: r.outcome,
    status: r.status,
    duration_ms: r.durationMs,
    backend: r.backend,
    method: r.method,
    detail: r.detail || '',
  };
}

/**
 * Read one Loom Unity system-table view from the authoritative Cosmos
 * `_auditLog` trail. This is the REAL backend behind the pane that replaced the
 * "system tables are not available at this boundary" gate: the rows exist
 * because {@link recordUnityAccess} wrote them at the choke point.
 */
export async function readUnitySystemTable(
  table: UnitySystemTable,
  q: UnityAuditQuery = {},
): Promise<UnitySystemTableResult> {
  const started = Date.now();
  const nq = normalizeUnityAuditQuery(q);
  const records = await listUnityAccessRecords(
    table === 'denials' ? { ...nq, outcome: 'denied' } : nq,
  );
  const sinceHours = Math.max(1, Math.round((Date.now() - new Date(nq.since).getTime()) / 3_600_000));
  const kql = unityAuditKql({ sinceHours, deniedOnly: table === 'denials', limit: nq.limit });
  // A full page means the window was cut off at `limit`, so the summary numbers
  // below are "within the most recent N records", not "within the window".
  const truncated = records.length >= nq.limit;

  if (table === 'summary') {
    const s = summarizeUnityAccess(records);
    const scopeLabel = truncated ? `most recent ${nq.limit} calls` : 'window';
    const rows: Record<string, unknown>[] = [
      { scope: scopeLabel, key: 'all operations', calls: s.total, denied: s.denied, failed: s.failure, distinct_actors: s.actors },
      ...s.byOperation.map((o) => ({ scope: 'operation', key: o.operation, calls: o.count, denied: o.denied, failed: '', distinct_actors: '' })),
      ...s.bySecurable.map((o) => ({ scope: 'securable', key: o.securableFqn, calls: o.count, denied: o.denied, failed: '', distinct_actors: '' })),
    ];
    return {
      columns: ['scope', 'key', 'calls', 'denied', 'failed', 'distinct_actors'],
      rows,
      executionMs: Date.now() - started,
      recordCount: records.length,
      truncated,
      limit: nq.limit,
      kql,
    };
  }

  return {
    columns: AUDIT_COLUMNS,
    rows: records.map(auditRow),
    executionMs: Date.now() - started,
    recordCount: records.length,
    truncated,
    limit: nq.limit,
    kql,
  };
}
