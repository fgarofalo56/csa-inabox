/**
 * LU-3 — the Loom Unity / Unity Catalog **audit choke point**.
 *
 * Every Unity Catalog call the Console BFF makes funnels through one of FOUR
 * audited transports, each of which calls a recorder in this file from a
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
 *   - `ucSql` in `lib/azure/uc-sql.ts` — the Databricks SQL Statement Execution
 *     transport, which carries the governance DDL (§ 3b).
 *   - `acctFetch` in `lib/azure/unity-catalog-account-client.ts` — the Databricks
 *     account plane, where metastore assignment lives (§ 3c).
 *
 * ### What this trail does NOT cover (read this before trusting it)
 *
 * `lib/azure/shortcut-credentials.ts` keeps its OWN private `ucFetch` and issues
 * storage-credential + external-location CREATE/DELETE with no row here. That
 * file sits under a repo-level credential-path write deny, so the recorder has
 * to be added by someone with write access to it; it is declared in the guard's
 * `KNOWN_UNAUDITED` map and printed on every passing run (issue #2622, gap 1).
 *
 * `lib/azure/iceberg-catalog-client.ts`'s `ircFetch` namespace/table CREATE +
 * DROP are audited, but into a DIFFERENT trail (`logIcebergAccess` →
 * `_auditLog itemType:'iceberg-catalog'`).
 *
 * ### What it DOES cover beyond UC REST (2026-08-02, issue #2622)
 *
 * Two non-REST surfaces reach Unity Catalog and now record here too:
 *
 *   - **SQL Statement Execution** — `ucSql` in `lib/azure/uc-sql.ts` wraps
 *     `executeStatement` and records via {@link recordUnitySqlAccess}. This is
 *     where the governance DDL lives: `GRANT`/`REVOKE`, ABAC `CREATE POLICY` /
 *     `DROP POLICY`, `ALTER … SET MASK` / `SET ROW FILTER` (column masks + row
 *     filters), governed tags, `SET TAGS`. The statement TEXT is never written
 *     to a row — see the § 3b header for why that is load-bearing.
 *   - **the Databricks ACCOUNT plane** — `acctFetch` in
 *     `lib/azure/unity-catalog-account-client.ts` records via
 *     {@link recordUnityAccountAccess}. Metastore ASSIGNMENT decides which
 *     metastore an entire workspace sees.
 *
 * A caveat worth stating plainly: the CI guard proves each recorder is CALLED
 * from inside its transport's `finally`. It cannot prove the call is
 * UNCONDITIONAL — `if (ok) record(…)` inside a finally still satisfies it. That
 * property is held by the specs
 * (`lib/azure/__tests__/unity-audit-sql.test.ts`), not by the guard.
 *
 * What IS enforced, not merely documented, by
 * `scripts/ci/check-unity-audit-chokepoint.mjs` (merge-blocking):
 *   (a) any file outside the allowlist that combines a Loom Unity address OR a
 *       Unity Catalog REST path with request-shaped code fails the build;
 *   (b) `unity-catalog-client.ts` growing a second outbound fetch fails;
 *   (c) `recordUnityAccess(` leaving the `finally` of EITHER `ucFetch` or
 *       `dbxFetch` fails — the check brace-matches the actual finally block
 *       rather than substring-scanning the rest of the file; the same
 *       brace-accurate check now covers `ucSql` → `recordUnitySqlAccess` and
 *       `acctFetch` → `recordUnityAccountAccess`;
 *   (d) a NEW `executeStatement(` exit in any UC-governance file fails — the
 *       per-file `SQL_EXIT_BASELINES` ratchet, now at 0 for every one of them
 *       except the audited wrapper itself.
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
 *      'loom-unity'`). NOTE: /admin/audit-logs scopes its Cosmos read to
 *      `c.tenantId = <session oid>` while these rows carry the Entra **tenant**
 *      id, so they do NOT appear on that surface. Until the tenant-admin
 *      "Loom Unity system tables" reader + pane land (SPLIT OUT of this PR —
 *      they have no in-browser E2E receipt yet, `ux-baseline.md` G1), the trail
 *      is read with {@link unityAuditKql} against the SIEM sink, or with a direct
 *      Cosmos query. The WRITE side is what this file and its CI guard are
 *      responsible for, and it is complete.
 *   2. **`LoomAudit_CL`** — fanned out through `emitAuditEvent`, the existing
 *      Azure Monitor Logs-Ingestion (DCR) stream that Sentinel/any SIEM reads.
 *      Un-provisioned DCR = silent no-op (see lib/admin/audit-stream.ts); the
 *      Cosmos trail is unaffected, so this module has NO day-one gate.
 *
 * ## Boundary egress — ONLY AN AFFIRMATIVE MUTATION LEAVES THE ESTATE
 *
 * `emitAuditEvent` additionally fans events out to any tenant-registered
 * OUTBOUND WEBHOOK (`emitLoomEvent`, lib/events/webhook-emitter.ts) — a
 * third-party URL outside the Loom boundary. A catalog READ is high-volume and
 * carries actor UPN + actor OID + securable FQN, so read rows are emitted with
 * `{ webhook: false }`: they reach Cosmos and the in-boundary SIEM stream and
 * stop there.
 *
 * The rule is stated in the AFFIRMATIVE direction and defaults to "read"
 * ({@link isUnityMutation}): a row egresses only when the method is
 * state-changing, or a safe method carries an explicit mutation verb. An
 * un-modelled operation on a GET does NOT egress. Round 2 of this item stated
 * "reads never leave the estate" while deciding read-ness from a `get|list|read`
 * suffix, which classified the LU-2 `probe.anonymous-read` GET and the
 * `unity.request` catch-all GET as mutations and shipped them to third-party
 * URLs on every health check. The heading above is now the code's actual rule,
 * not an aspiration.
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

/**
 * The persisted shape of one Loom Unity access row in `_auditLog` — what
 * {@link recordUnityAccess} writes, and therefore the contract any reader binds
 * to. Declared next to the writer so the two cannot drift.
 */
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

/** HTTP methods that cannot change catalog state. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The `method` value {@link recordUnitySqlAccess} stamps on a row that came from
 * the Databricks **SQL Statement Execution** API rather than UC REST.
 *
 * A SQL statement has NO HTTP method — the transport POSTs every statement,
 * read or write, to `/api/2.0/sql/statements`. Recording `POST` would therefore
 * mark every `SELECT … FROM information_schema` as a mutation and fan the row
 * out to tenant-registered third-party webhooks, which is the exact egress leak
 * {@link isUnityMutation} was rewritten to close. So SQL rows carry an honest
 * pseudo-method and their egress is decided by the statement VERB alone.
 */
export const SQL_PSEUDO_METHOD = 'SQL';

/**
 * Operation verbs that AFFIRMATIVELY name a state change. Used to catch a
 * mutation that arrives with a mislabelled safe method (e.g. an internal caller
 * that hands `recordUnityAccess` `method: 'GET'` for a `catalog.delete`).
 *
 * Every verb {@link classifyUnityCall} can emit for a non-safe method is here
 * (`create` / `update` / `delete` from METHOD_VERB, `vend`, grant `update`,
 * system-schema `enable` / `disable`), plus every MUTATING verb
 * {@link classifyUnitySqlStatement} and {@link classifyUnityAccountCall} emit —
 * which is what makes {@link SQL_PSEUDO_METHOD} rows safe to decide from the
 * verb alone.
 */
const MUTATION_VERBS = new Set([
  'create', 'update', 'delete', 'vend', 'enable', 'disable', 'drop', 'set', 'unset',
  'grant', 'revoke', 'assign', 'unassign', 'remove', 'rotate', 'write', 'alter', 'rename',
]);

/**
 * Is this call a MUTATION of the catalog (rather than a read)?
 *
 * This is the BOUNDARY-EGRESS decision, so it FAILS CLOSED TOWARD "read": an
 * event is allowed past the Loom boundary to a tenant-registered third-party
 * webhook only when we can AFFIRMATIVELY say it changed catalog state —
 *
 *   - a state-changing HTTP method (anything outside {@link SAFE_METHODS}), OR
 *   - a safe method carrying an explicit {@link MUTATION_VERBS} verb.
 *
 * ### Why the default flipped (2026-07-28, round-3 review)
 *
 * The first version decided a READ from the last dotted segment of `operation`
 * (`get` / `list` / `read`) and treated everything else as a mutation, on the
 * theory that "unknown → mutation" was the conservative direction. For an AUDIT
 * decision it is. For an EGRESS decision it is exactly backwards, and it leaked:
 *
 *   - `probe.anonymous-read` — the LU-2 health probe (lib/admin/health-probes.ts)
 *     — has verb `anonymous-read`, so a plain unauthenticated GET was classified
 *     as a mutation and fanned out `actorUpn` + `actorOid` + `path` to every
 *     registered third-party URL on EVERY /admin/health, /admin/readiness,
 *     self-audit and copilot-orchestrator run;
 *   - `unity.request` — the catch-all {@link classifyUnityCall} emits for an
 *     un-modelled family — has verb `request`, so an ordinary GET against a new
 *     UC family egressed too.
 *
 * A missed egress costs an external SOC one notification of a change it can
 * still see in `_auditLog` and `LoomAudit_CL`. A wrong egress puts actor
 * identity and securable names on a third-party URL and cannot be recalled. The
 * asymmetry decides the default.
 *
 * NOTE this flag ONLY drives egress and the row's `mutation` column. The audit
 * ROW is written either way — nothing here can drop a record.
 *
 * PURE — unit-tested (lib/azure/__tests__/unity-audit-security.test.ts).
 */
export function isUnityMutation(ev: Pick<UnityAccessEvent, 'method' | 'operation'>): boolean {
  const method = (ev.method || 'GET').toUpperCase();
  const verb = (ev.operation || '').split('.').pop()?.toLowerCase() || '';
  // A SQL statement carries no HTTP method (everything is a POST to
  // /api/2.0/sql/statements), so the verb is the ONLY signal — and it comes from
  // the closed vocabulary of classifyUnitySqlStatement. Same affirmative rule:
  // an un-modelled statement resolves to "read" and does NOT egress.
  if (method === SQL_PSEUDO_METHOD) return MUTATION_VERBS.has(verb);
  if (!SAFE_METHODS.has(method)) return true;
  return MUTATION_VERBS.has(verb);
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
// 3b) The SQL half — Databricks SQL Statement Execution (issue #2622, gap 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## Why the SQL statement TEXT never reaches a row
 *
 * This is the single most important rule in this section. Loom's UC governance
 * DDL is built server-side and executed on a SQL warehouse, and one of those
 * builders emits
 *
 *     CREATE CONNECTION `x` TYPE SQLSERVER OPTIONS (host '…', password '…')
 *
 * — `createUcConnection` deliberately returns `executionMs` ONLY, never the SQL,
 * "which may contain a literal password". An audit row is written to Cosmos, to
 * `LoomAudit_CL`, and — for a mutation — to every tenant-registered OUTBOUND
 * WEBHOOK. Copying the statement (or a Databricks error message, which echoes
 * the failing statement) onto that row would put a plaintext credential on a
 * third-party URL and it could not be recalled.
 *
 * So the classifier below MATCHES against the statement and RETURNS ONLY values
 * drawn from the fixed table in this file. No substring of the caller's SQL is
 * ever returned, and {@link recordUnitySqlAccess} stamps `detail` from a
 * validated Databricks `error_code` token, never from the error message. The
 * securable on the row comes from the CALLER's structured `target` hint (a
 * catalog/schema/object name it already had), not from parsing identifiers out
 * of the statement.
 *
 * Classification MAY read the message (deciding `denied` needs it); only
 * STORAGE is restricted. That split is asserted in the specs.
 */

/** Statement prefix scanned for classification. Bounds the work and the regexes. */
const SQL_HEAD_CHARS = 4096;

/**
 * Uppercased, comment-stripped, whitespace-collapsed statement head — the
 * haystack for {@link classifyUnitySqlStatement}. NEVER returned to a caller and
 * never written to a row; it exists only to be matched against.
 */
function normalizeSqlHead(sql: string): string {
  return String(sql || '')
    .slice(0, SQL_HEAD_CHARS)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[^]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** One entry of the CLOSED output vocabulary. `null` fqn === collection scope. */
interface SqlShape { operation: string; securableType: string }

/**
 * Statement head → audit shape, first match wins. Grounded in the DDL the pure
 * builders in `lib/sql/uc-security-builders.ts`, `lib/sql/metric-view-builders.ts`
 * and `lib/sql/uc-table-format-builders.ts` actually emit.
 *
 * Both fields of every entry are LITERALS in this table — that is what makes the
 * classifier incapable of leaking statement text.
 */
const SQL_PREFIX_SHAPES: Array<{ prefix: string; shape: SqlShape }> = [
  { prefix: 'GRANT ', shape: { operation: 'grant.grant', securableType: 'grant' } },
  { prefix: 'REVOKE ', shape: { operation: 'grant.revoke', securableType: 'grant' } },
  { prefix: 'DENY ', shape: { operation: 'grant.revoke', securableType: 'grant' } },
  { prefix: 'CREATE OR REPLACE POLICY ', shape: { operation: 'policy.create', securableType: 'policy' } },
  { prefix: 'CREATE POLICY ', shape: { operation: 'policy.create', securableType: 'policy' } },
  { prefix: 'DROP POLICY ', shape: { operation: 'policy.drop', securableType: 'policy' } },
  { prefix: 'SHOW EFFECTIVE POLICIES', shape: { operation: 'policy.list', securableType: 'policy' } },
  { prefix: 'SHOW POLICIES', shape: { operation: 'policy.list', securableType: 'policy' } },
  { prefix: 'DESCRIBE POLICY ', shape: { operation: 'policy.get', securableType: 'policy' } },
  { prefix: 'CREATE GOVERNED TAG ', shape: { operation: 'governed-tag.create', securableType: 'governed_tag' } },
  { prefix: 'DROP GOVERNED TAG ', shape: { operation: 'governed-tag.drop', securableType: 'governed_tag' } },
  { prefix: 'SHOW GOVERNED TAGS', shape: { operation: 'governed-tag.list', securableType: 'governed_tag' } },
  { prefix: 'DESCRIBE GOVERNED TAG ', shape: { operation: 'governed-tag.get', securableType: 'governed_tag' } },
  { prefix: 'CREATE OR REPLACE FUNCTION ', shape: { operation: 'function.create', securableType: 'function' } },
  { prefix: 'CREATE FUNCTION ', shape: { operation: 'function.create', securableType: 'function' } },
  { prefix: 'DROP FUNCTION ', shape: { operation: 'function.drop', securableType: 'function' } },
  { prefix: 'CREATE OR REPLACE VIEW ', shape: { operation: 'view.create', securableType: 'view' } },
  { prefix: 'CREATE VIEW ', shape: { operation: 'view.create', securableType: 'view' } },
  { prefix: 'DROP VIEW ', shape: { operation: 'view.drop', securableType: 'view' } },
  { prefix: 'SHOW VIEWS', shape: { operation: 'view.list', securableType: 'view' } },
  { prefix: 'CREATE FOREIGN CATALOG ', shape: { operation: 'catalog.create', securableType: 'catalog' } },
  { prefix: 'CREATE CONNECTION ', shape: { operation: 'connection.create', securableType: 'connection' } },
  { prefix: 'DROP CONNECTION ', shape: { operation: 'connection.drop', securableType: 'connection' } },
  { prefix: 'CREATE OR REPLACE TABLE ', shape: { operation: 'table.create', securableType: 'table' } },
  { prefix: 'CREATE TABLE ', shape: { operation: 'table.create', securableType: 'table' } },
  { prefix: 'DROP TABLE ', shape: { operation: 'table.drop', securableType: 'table' } },
  { prefix: 'SELECT ', shape: { operation: 'sql.select', securableType: 'table' } },
  { prefix: 'WITH ', shape: { operation: 'sql.select', securableType: 'table' } },
  { prefix: 'SHOW ', shape: { operation: 'sql.show', securableType: 'unknown' } },
  { prefix: 'DESCRIBE ', shape: { operation: 'sql.describe', securableType: 'unknown' } },
  { prefix: 'DESC ', shape: { operation: 'sql.describe', securableType: 'unknown' } },
  { prefix: 'EXPLAIN ', shape: { operation: 'sql.explain', securableType: 'unknown' } },
];

/**
 * `ALTER …` sub-verbs. Checked with `String.includes` on the bounded head rather
 * than a regex, so there is no backtracking surface. Order matters: the
 * `ALTER GOVERNED TAG …` forms end in `SET DESCRIPTION` / `SET VALUES`, so they
 * are resolved by PREFIX before the generic `SET …` scan runs.
 */
const SQL_ALTER_PREFIX_SHAPES: Array<{ prefix: string; shape: SqlShape }> = [
  { prefix: 'ALTER GOVERNED TAG ', shape: { operation: 'governed-tag.alter', securableType: 'governed_tag' } },
  { prefix: 'ALTER POLICY ', shape: { operation: 'policy.alter', securableType: 'policy' } },
];
const SQL_ALTER_CONTAINS_SHAPES: Array<{ needle: string; shape: SqlShape }> = [
  { needle: ' SET TAGS', shape: { operation: 'tag.set', securableType: 'tag' } },
  { needle: ' UNSET TAGS', shape: { operation: 'tag.unset', securableType: 'tag' } },
  { needle: ' SET TAG ', shape: { operation: 'tag.set', securableType: 'tag' } },
  { needle: ' UNSET TAG ', shape: { operation: 'tag.unset', securableType: 'tag' } },
  { needle: ' SET MASK', shape: { operation: 'column-mask.set', securableType: 'column_mask' } },
  { needle: ' DROP MASK', shape: { operation: 'column-mask.drop', securableType: 'column_mask' } },
  { needle: ' SET ROW FILTER', shape: { operation: 'row-filter.set', securableType: 'row_filter' } },
  { needle: ' DROP ROW FILTER', shape: { operation: 'row-filter.drop', securableType: 'row_filter' } },
  { needle: ' SET OWNER', shape: { operation: 'owner.set', securableType: 'unknown' } },
];

/**
 * Derive `{ operation, securableType, securableFqn }` from a SQL statement.
 *
 * PURE, and its OUTPUT ALPHABET IS CLOSED — every returned string is a literal
 * from the tables above plus {@link UNITY_SECURABLE_ALL}. An un-modelled
 * statement records as `sql.statement`, never dropped and never echoed; per the
 * affirmative-egress rule that verb is NOT in {@link MUTATION_VERBS}, so an
 * unrecognised statement stays inside the Loom boundary.
 *
 * Misclassification is possible (a string literal containing ` SET MASK` inside
 * an `ALTER TABLE` would tip that row), and is accepted: the row is still
 * written, the actor/target/outcome are still right, and the failure mode is a
 * wrong verb — never a dropped row and never a leaked secret.
 */
export function classifyUnitySqlStatement(sql: string): UnityCallDescriptor {
  const head = normalizeSqlHead(sql);
  const fallback: UnityCallDescriptor = {
    operation: 'sql.statement', securableType: 'unknown', securableFqn: UNITY_SECURABLE_ALL,
  };
  if (!head) return fallback;

  if (head.startsWith('ALTER ')) {
    for (const { prefix, shape } of SQL_ALTER_PREFIX_SHAPES) {
      if (head.startsWith(prefix)) return { ...shape, securableFqn: UNITY_SECURABLE_ALL };
    }
    for (const { needle, shape } of SQL_ALTER_CONTAINS_SHAPES) {
      if (head.includes(needle)) return { ...shape, securableFqn: UNITY_SECURABLE_ALL };
    }
    return { operation: 'sql.alter', securableType: 'unknown', securableFqn: UNITY_SECURABLE_ALL };
  }

  for (const { prefix, shape } of SQL_PREFIX_SHAPES) {
    if (head.startsWith(prefix)) return { ...shape, securableFqn: UNITY_SECURABLE_ALL };
  }
  return fallback;
}

/** A Databricks `error_code` is an uppercase enum token — safe to persist. */
const SQL_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The Databricks `error_code` off a failed statement, or `undefined`.
 *
 * Anchored at BOTH ends against a closed token shape, so a driver that put a
 * message (or a statement fragment) on `.code` yields `undefined` rather than
 * smuggling text onto the row.
 */
export function unitySqlErrorCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  if (typeof c !== 'string') return undefined;
  const token = c.trim().toUpperCase();
  return SQL_ERROR_CODE_RE.test(token) ? token : undefined;
}

/** Authorization refusals a Databricks SQL failure reports instead of a status. */
const SQL_DENIAL_RE =
  /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|INSUFFICIENT_PRIVILEGES|UNAUTHORIZED|ACCESS_DENIED|FORBIDDEN|\bfailed 401\b|\bfailed 403\b/i;

/**
 * Outcome for a failed SQL statement. `denied` is reserved for AUTHORIZATION
 * refusals, matching {@link unityOutcomeForError}'s intent on the REST half —
 * but `executeStatement` reports a UC refusal as an `error_code` /
 * message, not an HTTP status, so those are matched too.
 *
 * READS the message; the message is never STORED (see the section header).
 */
export function unitySqlOutcome(err: unknown): UnityAuditOutcome {
  if (err == null) return 'success';
  const e = err as { code?: unknown; message?: unknown; status?: unknown };
  const status = Number(e?.status || 0);
  if (status === 401 || status === 403) return 'denied';
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  return SQL_DENIAL_RE.test(`${code} ${message}`) ? 'denied' : 'failure';
}

/** Bound a caller-supplied securable so it cannot become an unbounded Cosmos
 *  partition key or carry newlines into the summary line. */
function boundSecurable(v: string | undefined): string {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Warehouse ids are opaque hex; anything else is dropped rather than recorded. */
const WAREHOUSE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The SQL half of the choke point, called from the `finally` of `ucSql`
 * (lib/azure/uc-sql.ts).
 *
 * WHY THIS EXISTS: Loom reaches Unity Catalog through the Databricks **SQL
 * Statement Execution** API as well as UC REST, and the SQL half carries the
 * governance DDL — `GRANT`/`REVOKE`, ABAC `CREATE POLICY` / `DROP POLICY`,
 * `ALTER … SET MASK` / `SET ROW FILTER` (column masks + row filters),
 * `CREATE/ALTER/DROP GOVERNED TAG`, `SET TAGS`. Before this those produced no
 * Loom row at all while the trail was advertised as covering the catalog
 * (issue #2622, gap 2).
 *
 * Never throws — same fire-and-forget contract as {@link recordUnityAccess}.
 */
export function recordUnitySqlAccess(opts: {
  sql: string;
  /** Securable the statement targets, from the CALLER's structured params. */
  target?: string;
  warehouseId?: string;
  durationMs?: number;
  error?: unknown;
}): void {
  try {
    const shape = classifyUnitySqlStatement(opts.sql);
    const failed = opts.error != null;
    const target = boundSecurable(opts.target);
    const warehouse = String(opts.warehouseId || '');
    const code = failed ? unitySqlErrorCode(opts.error) : undefined;
    void recordUnityAccess({
      ...shape,
      securableFqn: target || shape.securableFqn,
      backend: 'databricks',
      method: SQL_PSEUDO_METHOD,
      path: WAREHOUSE_ID_RE.test(warehouse) ? `sql:warehouse/${warehouse}` : 'sql:warehouse',
      status: failed ? 0 : 200,
      durationMs: opts.durationMs ?? 0,
      outcome: failed ? unitySqlOutcome(opts.error) : 'success',
      // NOT the error message. A Databricks SQL failure echoes the failing
      // statement, and one of Loom's builders emits a literal password.
      detail: failed
        ? (code ? `error_code=${code}` : 'SQL statement failed (error text withheld — it echoes the statement)')
        : undefined,
    });
  } catch {
    /* audit is never allowed to break a catalog call */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3c) The Databricks ACCOUNT plane (issue #2622, gap 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive an audit shape from a Databricks **account-plane** path — the
 * `/api/2.0/accounts/{account_id}` surface `unity-catalog-account-client.ts`
 * talks to. Paths arrive WITHOUT the `/api/2.0/accounts/{id}` prefix (that is
 * assembled by the transport), so the account id never lands on a row.
 *
 * Recognised shapes:
 *   /metastores[/{id}]                     — every metastore in the account
 *   /workspaces/{wsId}/metastore           — the assignment for one workspace
 *
 * A `PUT` on the assignment path is the account-admin mutation that binds a
 * workspace to a metastore; it records as `metastore-assignment.assign`, whose
 * verb IS in {@link MUTATION_VERBS}. PURE — unit-tested.
 */
export function classifyUnityAccountCall(method: string, path: string): UnityCallDescriptor {
  const verbUpper = (method || 'GET').toUpperCase();
  const clean = (path || '').split('?')[0].split('#')[0];
  const seg = clean.split('/').filter(Boolean).map(decodeSegment);

  if (seg[0] === 'workspaces' && seg[2] === 'metastore') {
    const op = verbUpper === 'GET' ? 'read' : verbUpper === 'DELETE' ? 'unassign' : 'assign';
    return {
      operation: `metastore-assignment.${op}`,
      securableType: 'metastore_assignment',
      securableFqn: `workspace:${boundSecurable(seg[1]) || UNITY_SECURABLE_ALL}`,
    };
  }
  if (seg[0] === 'metastores') {
    const name = boundSecurable(seg.slice(1).join('/'));
    const verb = verbUpper === 'GET' ? (name ? 'get' : 'list') : (METHOD_VERB[verbUpper] || 'request');
    return { operation: `metastore.${verb}`, securableType: 'metastore', securableFqn: name || UNITY_SECURABLE_ALL };
  }
  return {
    operation: 'account.request',
    securableType: 'databricks_account',
    securableFqn: boundSecurable(clean) || UNITY_SECURABLE_ALL,
  };
}

/**
 * The account-plane half of the choke point, called from the `finally` of
 * `acctFetch` (lib/azure/unity-catalog-account-client.ts).
 *
 * WHY THIS EXISTS: metastore ASSIGNMENT is an account-admin mutation that
 * decides which Unity Catalog metastore a whole workspace sees. It never
 * touches Loom Unity and never matches {@link isUnityCatalogPath}, so neither
 * `ucFetch` nor `dbxFetch` could ever have recorded it (issue #2622, gap 3).
 *
 * Never throws — same fire-and-forget contract as {@link recordUnityAccess}.
 */
export function recordUnityAccountAccess(opts: {
  path: string;
  method?: string;
  status?: number;
  durationMs?: number;
  error?: unknown;
  accountHost?: string;
}): void {
  try {
    const method = (opts.method || 'GET').toUpperCase();
    const status = Number(opts.status || (opts.error as { status?: number } | null)?.status || 0);
    const failed = !!opts.error || status >= 400;
    void recordUnityAccess({
      ...classifyUnityAccountCall(method, opts.path),
      backend: 'databricks',
      method,
      path: (opts.path || '').split('?')[0],
      workspaceHost: opts.accountHost || '',
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
// 4) Reading the SIEM half of the trail
// ─────────────────────────────────────────────────────────────────────────────

/** Upper bound on any row limit this module hands to a reader. */
export const MAX_LIMIT = 1000;

/**
 * The KQL the SIEM half of the trail is read with. Exported (and unit-tested) so
 * a surface can SHOW the operator the exact query to paste into Log Analytics /
 * Sentinel — the `LoomAudit_CL` rows are the same events, mirrored by
 * `emitAuditEvent`.
 *
 * Until the Cosmos-side reader + the `/catalog/unity` System-tables pane land
 * (SPLIT OUT of this PR pending a G1 in-browser E2E receipt), this is the
 * supported way to read what the choke point wrote without querying Cosmos
 * directly.
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
