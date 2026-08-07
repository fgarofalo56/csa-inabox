/**
 * LU-11 — FOREIGN CATALOGS: the federation inventory BFF.
 *
 *   GET /api/catalog/unity/foreign-catalogs
 *     → { catalogs, sources, engine, gate? }
 *
 * `catalogs` is read from the LIVE coordinator (`system.metadata.catalogs`), so
 * it reports what the engine actually mounted and which connector backs it —
 * never the env bag (which is intent, not outcome: a catalog whose Postgres is
 * unreachable still has its env var) and never a hard-coded list. Each entry
 * carries whether THIS caller may query it, resolved with the same
 * deny-by-default authorization the query route enforces
 * (`lib/azure/trino-authz.ts`), so the tab can never imply access the query
 * path would refuse.
 *
 * `sources` is the registered Loom Connections (Linked Services) joined against
 * that live set: which are already federated, which could be, and which cannot
 * be — with the reason, so a source is never just missing from the list.
 *
 * When the engine is absent or SEALED the response carries an honest `gate`
 * instead of an empty inventory that would read as "you have no federation"
 * (`no-vaporware.md`). Nothing here is fabricated.
 */

import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import {
  runTrinoQuery,
  trinoIcebergCatalog,
  trinoConfigGate,
  isTrinoSealed,
  trinoAuthMode,
  TrinoError,
} from '@/lib/azure/trino-client';
import {
  builtinOpenCatalogs,
  configuredCatalogs,
  parseCatalogPolicy,
  resolveAllowedCatalogs,
  CATALOG_POLICY_ENV,
  type TrinoPrincipal,
} from '@/lib/azure/trino-authz';
import {
  classifyCatalog,
  buildRegisterableSources,
  type TrinoCatalogEntry,
} from '@/lib/azure/trino-catalogs';
import { listConnections } from '@/lib/azure/connections-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req, { session }) => {
  const lake = trinoIcebergCatalog();
  const principal: TrinoPrincipal = {
    oid: session.claims.oid,
    upn: session.claims.upn,
    groups: session.claims.groups || [],
    tenantId: session.claims.tid,
    tenantAdmin: isTenantAdmin(session),
  };
  const policy = parseCatalogPolicy(process.env[CATALOG_POLICY_ENV]);
  const builtins = builtinOpenCatalogs(lake);
  const allowed = resolveAllowedCatalogs(principal, policy, builtins);
  const configured = configuredCatalogs(policy, builtins);

  // Registered connections are readable regardless of engine state — a source
  // the operator has already registered is real information even when the
  // engine is down, so the tab is never blank.
  const connections = await listConnections(session).catch(() => []);

  const gateReason = trinoConfigGate()
    ? 'The Federated SQL (Trino) engine is not present in this environment (LOOM_TRINO_URL is unset). It is '
      + 'DEFAULT-ON, so this normally means the admin-plane deployment has not been re-run since the engine '
      + "shipped, the loom-trino image is not in this ACR yet, or an operator set loomBackends.trino='disabled'. "
      + 'Registered sources are listed below; none can be federated until the engine is deployed.'
    : isTrinoSealed()
      ? 'The Trino engine is deployed SEALED: engine-level Entra authorization is ENFORCED but no app '
        + 'registration was available at deploy time, so the accepted audience is a sentinel nothing can mint a '
        + 'token for. The engine is up and costs nothing; it accepts no caller, so its live catalog list cannot '
        + 'be read. Run the sign-in bootstrap and redeploy with LOOM_MSAL_CLIENT_ID set.'
      : null;

  if (gateReason) {
    return apiOk({
      catalogs: [],
      sources: buildRegisterableSources(connections, []),
      engine: { configured: !trinoConfigGate(), authMode: trinoAuthMode(), lakeCatalog: lake },
      gate: gateReason,
    });
  }

  try {
    // The engine's OWN inventory, with the connector that backs each catalog.
    // `system` is always readable (the built-in metadata catalog), so this
    // query works for any caller the engine admits.
    const res = await runTrinoQuery(
      'SELECT catalog_name, connector_name FROM system.metadata.catalogs ORDER BY catalog_name',
      { maxRows: 500, actorUpn: session.claims.upn, catalog: 'system', schema: 'metadata', knownCatalogs: ['system'] },
    );
    const nameIdx = res.columns.findIndex((c) => c.name.toLowerCase() === 'catalog_name');
    const connIdx = res.columns.findIndex((c) => c.name.toLowerCase() === 'connector_name');
    const catalogs: TrinoCatalogEntry[] = res.rows.map((row) => {
      const name = String(row[nameIdx >= 0 ? nameIdx : 0] ?? '').trim().toLowerCase();
      const connector = String(row[connIdx >= 0 ? connIdx : 1] ?? '').trim() || 'unknown';
      const kind = classifyCatalog(name, lake);
      const isAllowed = allowed.has(name);
      return {
        name,
        connector,
        kind,
        allowed: isAllowed,
        ...(isAllowed
          ? {}
          : {
            deniedReason: configured.has(name)
              ? `You are not granted this catalog. External federation catalogs are deny-by-default; access is `
                + `granted per catalog in ${CATALOG_POLICY_ENV} ("signed-in", or a groups/oids/upns principal set).`
              : `This catalog is mounted on the engine but has NO grant in ${CATALOG_POLICY_ENV}, so it is `
                + 'deny-by-default for every non-admin caller. Add a grant to make it queryable.',
        }),
      };
    });

    return apiOk({
      catalogs,
      sources: buildRegisterableSources(connections, catalogs),
      engine: {
        configured: true,
        authMode: trinoAuthMode(),
        lakeCatalog: lake,
        /** LU-7 — is Loom's compiled governance being enforced AT the engine? */
        enginePolicy: Boolean((process.env.LOOM_TRINO_POLICY_URL || '').trim()),
      },
    });
  } catch (e) {
    if (e instanceof TrinoError) {
      // The engine answered (or refused) — report THAT, never an empty list
      // that would read as "no federation configured".
      return apiOk({
        catalogs: [],
        sources: buildRegisterableSources(connections, []),
        engine: { configured: true, authMode: trinoAuthMode(), lakeCatalog: lake },
        gate: `The Trino coordinator could not list its catalogs: ${e.message}`,
      });
    }
    // Anything else is a genuine defect — let the toolkit's apiServerError
    // envelope handle it rather than dressing it up as a gate.
    throw e;
  }
});
