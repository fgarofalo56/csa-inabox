/**
 * LU-3 — the Loom Unity / Unity Catalog **audit choke point**.
 *
 * Every catalog call the Console BFF makes — against the self-hosted Loom Unity
 * (OSS Unity Catalog) server in Gov OR against Databricks Unity Catalog in
 * Commercial — funnels through ONE place: the `finally` block of `ucFetch` in
 * `lib/azure/unity-catalog-client.ts`, which calls {@link recordUnityAccess}.
 * There is exactly one outbound `fetch` in that client, so a new call site
 * physically cannot reach the catalog without producing an audit row.
 *
 * That property is enforced, not merely documented:
 * `scripts/ci/check-unity-audit-chokepoint.mjs` FAILS the build when
 *   (a) any file outside the choke point builds a Loom Unity request URL, or
 *   (b) `unity-catalog-client.ts` grows a second outbound fetch, or
 *   (c) the `recordUnityAccess(` call inside `ucFetch` disappears.
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
 *      'loom-unity'`), read back by the "Loom Unity system tables" pane and by
 *      /admin/audit-logs.
 *   2. **`LoomAudit_CL`** — fanned out through `emitAuditEvent`, the existing
 *      Azure Monitor Logs-Ingestion (DCR) stream that Sentinel/any SIEM reads.
 *      Un-provisioned DCR = silent no-op (see lib/admin/audit-stream.ts); the
 *      Cosmos trail is unaffected, so this module has NO day-one gate.
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
        // `_auditLog` is partitioned on /itemId — the securable FQN keeps one
        // object's whole access history in a single partition, exactly like the
        // Iceberg data-plane trail (iceberg-catalog-client.ts).
        itemId: scope,
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
        viaApiToken: actor.viaApiToken,
        actorOid: actor.oid,
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
      });
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
 * Await every audit write started so far. `ucFetch` fires the recorder
 * fire-and-forget (`void`), so a route that must guarantee durability before
 * responding — and every test that asserts on the trail — calls this.
 */
export async function flushUnityAudit(): Promise<void> {
  while (inFlight.size) {
    await Promise.allSettled(Array.from(inFlight));
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
  const { resources } = await c.items
    .query({
      query: `SELECT TOP @top * FROM c WHERE ${where.join(' AND ')} ORDER BY c.at DESC`,
      parameters: [...parameters, { name: '@top', value: nq.limit }],
    })
    .fetchAll();

  const lower = (v: unknown) => String(v ?? '').toLowerCase();
  let rows = resources as unknown as UnityAuditRecord[];
  if (nq.operation) rows = rows.filter((r) => lower(r.operation).includes(nq.operation!.toLowerCase()));
  if (nq.securable) rows = rows.filter((r) => lower(r.securableFqn).includes(nq.securable!.toLowerCase()));
  if (nq.actor) rows = rows.filter((r) => lower(r.actorUpn).includes(nq.actor!.toLowerCase()) || lower(r.actorOid).includes(nq.actor!.toLowerCase()));
  return rows;
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

  if (table === 'summary') {
    const s = summarizeUnityAccess(records);
    const rows: Record<string, unknown>[] = [
      { scope: 'window', key: 'all operations', calls: s.total, denied: s.denied, failed: s.failure, distinct_actors: s.actors },
      ...s.byOperation.map((o) => ({ scope: 'operation', key: o.operation, calls: o.count, denied: o.denied, failed: '', distinct_actors: '' })),
      ...s.bySecurable.map((o) => ({ scope: 'securable', key: o.securableFqn, calls: o.count, denied: o.denied, failed: '', distinct_actors: '' })),
    ];
    return {
      columns: ['scope', 'key', 'calls', 'denied', 'failed', 'distinct_actors'],
      rows,
      executionMs: Date.now() - started,
      recordCount: records.length,
      kql,
    };
  }

  return {
    columns: AUDIT_COLUMNS,
    rows: records.map(auditRow),
    executionMs: Date.now() - started,
    recordCount: records.length,
    kql,
  };
}
