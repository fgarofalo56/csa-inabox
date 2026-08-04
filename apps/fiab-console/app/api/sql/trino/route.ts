/**
 * POST /api/sql/trino — the N7e **Federated SQL (Trino)** execution edge.
 *
 * Runs a statement on the Trino engine (Apache-2.0, INTERNAL-ingress in the
 * deployment's own VNet) registered against the N1 Iceberg REST Catalog +
 * external connectors — so ONE statement can join a Loom Iceberg table with an
 * external Postgres/MySQL/Kafka source. The engine is DEFAULT-ON: a push-button
 * deploy stands it up as a scale-to-zero Container App
 * (data-plane/loom-trino-aca.bicep) and wires `LOOM_TRINO_URL`. When that var
 * is unset anyway (explicit opt-out, a non-Container-Apps boundary, or the
 * loom-trino image missing from ACR) this route returns the honest **gate
 * envelope** with a Fix-it — never a fabricated result. SQL Lab stays fully
 * functional meanwhile because DuckDB (N2b) is the engine the picker starts on;
 * Trino only ADDS the "Federated SQL" choice.
 *
 * AUDIT: every execution — success, authorization DENY, or failure — writes an
 * `_auditLog` data-access row (principal, statement scope, catalogs, rows,
 * outcome, ts) and fans out through the audit stream BEFORE the response is sent.
 * There is no unaudited path to the cluster.
 *
 * AUTHORIZATION (#2678): the caller's Loom identity is resolved to the set of
 * catalogs they may reach (deny-by-default — built-in catalogs open to any
 * signed-in caller, external federation catalogs require an explicit grant in
 * LOOM_TRINO_CATALOG_POLICY). A statement referencing a catalog outside that set
 * is REFUSED 403 before the coordinator is touched. See lib/azure/trino-authz.ts.
 *
 * 200 → { ok:true, engine:'trino', columns, rows, rowCount, totalMs, catalogs, … }
 * 400 → bad request / statement error from the coordinator
 * 401 → unauthenticated
 * 403 → not authorized for a referenced catalog (deny-by-default catalog authz)
 * 503 → honest gate envelope (LOOM_TRINO_URL unset / SEALED / auth unavailable)
 * 502 → cluster unreachable
 */
import { apiError, apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { apiHonestGateError, backendGateResponse } from '@/lib/api/gate-envelope';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { recordQueryRun } from '@/lib/finops/query-run';
import {
  CATALOG_POLICY_ENV,
  authorizeTrinoCatalogs,
  builtinOpenCatalogs,
  configuredCatalogs,
  extractReferencedCatalogs,
  parseCatalogPolicy,
  resolveAllowedCatalogs,
  type TrinoPrincipal,
} from '@/lib/azure/trino-authz';
import {
  TRINO_GATE_ID,
  TrinoError,
  buildFederatedJoinSql,
  isTrinoSealed,
  logTrinoAccess,
  runTrinoQuery,
  trinoIcebergCatalog,
  type TrinoTableRef,
} from '@/lib/azure/trino-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface JoinBody {
  left?: Partial<TrinoTableRef>;
  right?: Partial<TrinoTableRef>;
  on?: Array<[string, string]>;
  columns?: string[];
  limit?: number;
}

interface Body {
  sql?: unknown;
  /** Instead of raw SQL, a structured cross-source join the BFF assembles safely. */
  join?: JoinBody;
  maxRows?: unknown;
  catalog?: unknown;
  schema?: unknown;
  itemId?: unknown;
  workspaceId?: unknown;
}

export const POST = withSession(async (req, { session }) => {
  // The engine is default-ON, but the var can still be empty (opted out, a
  // non-Container-Apps boundary, or the image not yet in ACR). Return the
  // normalized 503 gate envelope so the surface renders the honest Fix-it —
  // SQL Lab keeps working on DuckDB either way.
  const gated = backendGateResponse(TRINO_GATE_ID);
  if (gated) return gated;

  // ROUND-3 (#2641): the URL can be wired while the ENGINE is SEALED —
  // authorization enforced against a sentinel audience nothing can mint,
  // because no Entra app registration existed at deploy time. Firing the
  // statement would spend a JVM cold start to earn a 401. Return the SAME
  // normalized gate envelope (so the surface renders the honest bar + the
  // /admin/gates Fix-it) with a code that names the actual state.
  if (isTrinoSealed()) {
    return apiHonestGateError(TRINO_GATE_ID, {
      code: 'sealed',
      missing: ['LOOM_MSAL_CLIENT_ID'],
      message:
        'The Federated SQL (Trino) engine is deployed SEALED: engine-level Entra authorization is ENFORCED, '
        + 'but no app registration was available at deploy time, so the accepted audience is a sentinel value '
        + 'nothing can mint a token for. The engine is up and costs nothing (minReplicas 0); it accepts no '
        + 'caller. Run .github/workflows/csa-loom-post-deploy-bootstrap.yml, then redeploy with '
        + 'LOOM_MSAL_CLIENT_ID set (or pin loomBackends.trinoAudienceClientId). SQL Lab keeps serving on '
        + 'DuckDB / Synapse Serverless meanwhile.',
    });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  let sql = typeof body.sql === 'string' ? body.sql.trim() : '';

  // A caller may hand a STRUCTURED cross-source join; the BFF builds the SQL
  // through the quoting helpers so a browser never assembles the statement.
  if (!sql && body.join && typeof body.join === 'object') {
    try {
      const j = body.join;
      sql = buildFederatedJoinSql({
        left: {
          catalog: String(j.left?.catalog ?? trinoIcebergCatalog()),
          schema: String(j.left?.schema ?? ''),
          table: String(j.left?.table ?? ''),
        },
        right: {
          catalog: String(j.right?.catalog ?? ''),
          schema: String(j.right?.schema ?? ''),
          table: String(j.right?.table ?? ''),
        },
        on: Array.isArray(j.on) ? j.on : [],
        columns: Array.isArray(j.columns) ? j.columns.map(String) : undefined,
        limit: typeof j.limit === 'number' ? j.limit : undefined,
      });
    } catch (e) {
      if (e instanceof TrinoError) return apiError(e.message, e.status, { code: e.code });
      return apiError('That federated join could not be assembled.', 400, { code: 'invalid_join' });
    }
  }

  if (!sql) {
    return apiError(
      'A SQL statement is required. Federated SQL runs read-only cross-source queries — try '
      + 'SELECT * FROM iceberg.gold.orders o JOIN postgres.public.customers c ON o.customer_id = c.id LIMIT 100.',
      400,
    );
  }

  const maxRows = typeof body.maxRows === 'number' && Number.isFinite(body.maxRows)
    ? Math.floor(body.maxRows)
    : undefined;
  const catalog = typeof body.catalog === 'string' ? body.catalog : undefined;
  const schema = typeof body.schema === 'string' ? body.schema : undefined;
  const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;

  const tenantId = session.claims.tid || session.claims.oid;
  const audit = {
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    tenantId,
    sql,
    itemId,
    workspaceId,
  };

  // ── ENGINE-LEVEL CATALOG AUTHORIZATION (#2678) ──────────────────────────────
  // The gap that kept #2641 red for three rounds: round 3 shipped AUTHENTICATION
  // (Trino JWT authenticator) but NO authorization — the engine had no system
  // access control, so any authenticated caller could query EVERY catalog, and
  // this route ran whatever SQL it was handed. Resolve THIS caller's allowed
  // catalogs and REFUSE a statement that reaches outside them, before the
  // coordinator is touched. Deny-by-default: built-in catalogs
  // (system/jmx/memory + the Loom lake) are open to any signed-in caller;
  // external federation catalogs require an explicit grant in
  // LOOM_TRINO_CATALOG_POLICY. (The engine's own file access control is the
  // defense-in-depth floor for a direct in-VNet caller that bypasses this route.)
  const principal: TrinoPrincipal = {
    oid: session.claims.oid,
    upn: session.claims.upn,
    groups: session.claims.groups || [],
    tenantId,
    tenantAdmin: isTenantAdmin(session),
  };
  const catalogPolicy = parseCatalogPolicy(process.env[CATALOG_POLICY_ENV]);
  const builtinCatalogs = builtinOpenCatalogs(trinoIcebergCatalog());
  const allowedCatalogs = resolveAllowedCatalogs(principal, catalogPolicy, builtinCatalogs);
  const referenced = extractReferencedCatalogs(sql, { defaultCatalog: catalog });
  const decision = authorizeTrinoCatalogs({
    referenced,
    allowed: allowedCatalogs,
    configured: configuredCatalogs(catalogPolicy, builtinCatalogs),
  });
  if (decision.effect === 'deny') {
    // A denied federated query is a security event — write the audited failure
    // row (Cosmos _auditLog + audit stream) BEFORE responding. No coordinator hop.
    await logTrinoAccess({
      ...audit,
      catalogs: referenced.catalogs,
      outcome: 'failure',
      detail: `authorization denied (${decision.code}): ${decision.reason}`,
    });
    return apiError(decision.reason, 403, {
      code: decision.code,
      catalog: decision.catalog,
      allowedCatalogs: decision.allowed,
    });
  }

  try {
    const result = await runTrinoQuery(sql, {
      maxRows,
      actorUpn: session.claims.upn,
      catalog,
      schema,
      knownCatalogs: referenced.catalogs,
    });
    await logTrinoAccess({
      ...audit,
      catalogs: result.catalogs,
      outcome: 'success',
      rowCount: result.rowCount,
      elapsedMs: result.totalMs,
    });
    // B-N19e — FOCUS cost attribution (best-effort, never blocks the response).
    void recordQueryRun({
      tenantId, userOid: session.claims.oid, userName: session.claims.upn,
      engine: 'trino', statement: sql, durationMs: result.totalMs,
      rowCount: result.rowCount, itemId, itemType: 'sql-lab', workspaceId,
      resourceId: (result.catalogs || []).join(','),
    });
    return apiOk({
      engine: result.engine,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      totalMs: result.totalMs,
      truncated: result.truncated,
      maxRows: result.maxRows,
      catalogs: result.catalogs,
      note: result.note,
    });
  } catch (e) {
    await logTrinoAccess({
      ...audit,
      outcome: 'failure',
      detail: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof TrinoError) return apiError(e.message, e.status, { code: e.code });
    // A refused statement / SQL error from the coordinator is user-actionable —
    // surface it verbatim (it is the query the user typed, not internals).
    const message = e instanceof Error ? e.message : String(e);
    return apiError(message.slice(0, 600), 400, { code: 'query_failed' });
  }
});
