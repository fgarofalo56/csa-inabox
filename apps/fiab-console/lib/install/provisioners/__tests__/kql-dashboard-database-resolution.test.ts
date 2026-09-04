/**
 * #3537 — a Real-Time Dashboard's tiles must be bound to the database its
 * sibling kql-database item ACTUALLY provisions.
 *
 * The reported symptom was that every tile failed with "table not resolved"
 * while the exact same KQL succeeded when run by hand. It was not a KQL
 * problem: the dashboard was pointed at the wrong DATABASE. `kql-dashboard.ts`
 * resolved it as `content.database` → `target.kustoDatabase`
 * (LOOM_KUSTO_DEFAULT_DB) → a SLUG of the dashboard's own displayName
 * re-suffixed to guess a `"<App> KQL Database"` item name. The last fallback
 * invents a database that nothing creates, and neither fallback fails loudly —
 * the install reported 'created' either way.
 *
 * `kql-db.ts` names the real ARM database `safeAdxDatabaseName(displayName)`,
 * which is deterministic, so `provisioning-engine.ts` can compute the sibling's
 * backing name BEFORE the concurrent fan-out and hand it to the dashboard.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) In `kql-dashboard.ts` restore the old chain
 *      (`contentDb || input.target.kustoDatabase || <slug> || 'loomdb'`) -> RED:
 *        "binds to the sibling kql-database this install provisions"
 *        "the sibling wins over a bundle declaration that disagrees with it"
 *        "no database at all is an honest gate, not a slug of the dashboard name"
 *   b) Keep the sibling arm but drop the final `remediation` (fall back to
 *      `target.kustoDatabase`) -> RED: "no database at all is an honest gate…"
 *      — the arm that decides whether a dead dashboard ships as 'created'.
 *   c) In `provisioning-engine.ts` stop passing `siblingKqlDatabases` -> RED:
 *        "the engine hands the dashboard its siblings' BACKING names"
 *      which is the arm that a provisioner-only fix leaves inert.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/kusto-client', () => ({
  kustoConfigGate: vi.fn(() => null),
  executeMgmtCommand: vi.fn(async () => ({ columns: [], rows: [] })),
}));
vi.mock('@/lib/azure/fabric-client', () => ({
  fabricCall: vi.fn(async () => ({ status: 200, json: {} })),
  fabricHint: vi.fn(() => 'hint'),
  FabricError: class extends Error { status = 500; },
}));

import { kqlDashboardProvisioner } from '../kql-dashboard';
// #4315 — STATIC, deliberately. As `await import('../../provisioning-engine')`
// inside the test body this cost 18130ms of on-demand TS transform (the engine
// pulls in every provisioner and its Azure clients) against vitest's 30s
// testTimeout, measured with the import and the call timed separately:
//   TIMING import=18130ms runProvisioning=2ms
// — i.e. essentially none of it was the engine RUN. That is the exact hazard
// `vitest.config.ts` documents, and it put a new flake in a required gate
// (observed: one 30s timeout, then 11.7s and 10.9s passes). Hoisted, the
// transform happens at module load, which testTimeout does not bound, and the
// test itself measures single-digit ms. Do not turn this back into a dynamic
// import to "keep the file light" — the cost does not go away, it just moves
// onto the deadline.
import { runProvisioning } from '../../provisioning-engine';
import { safeAdxDatabaseName } from '@/lib/azure/backing-name';
import federalDataMesh from '@/lib/apps/content-bundles/app-federal-data-mesh';
import finopsCost from '@/lib/apps/content-bundles/app-finops-cost';
import fedrampTracker from '@/lib/apps/content-bundles/app-fedramp-tracker';

function input(content: any) {
  return {
    session: { claims: { oid: 'o' } },
    target: { mode: 'shared', dashboardBackend: 'adx', kustoClusterUri: 'https://adx.example.kusto.windows.net' },
    cosmosItemId: 'dash-1',
    workspaceId: 'w',
    displayName: 'Department CIO Federation & Cost',
    appId: 'app-federal-data-mesh',
    content,
  } as any;
}

const itemsOf = (b: any, t: string) => b.items.filter((i: any) => i.itemType === t);

beforeEach(() => {
  delete process.env.LOOM_KUSTO_DEFAULT_DB;
  delete process.env.LOOM_DASHBOARD_BACKEND;
});

describe('kql-dashboard — the tiles bind to the database the install provisions (#3537)', () => {
  it('binds to the sibling kql-database this install provisions', async () => {
    const r = await kqlDashboardProvisioner(input({
      kind: 'kql-dashboard',
      tiles: [{ title: 't', kql: 'CrossDomainAccess | count', viz: 'card' }],
      siblingKqlDatabases: ['FederationAudit__ADX_'],
    }));

    expect(r.status).toBe('created');
    expect(r.secondaryIds?.database).toBe('FederationAudit__ADX_');
  });

  it('a stale LOOM_KUSTO_DEFAULT_DB cannot outrank the sibling', async () => {
    // The head behaviour: with no `content.database` the dashboard silently
    // landed on the operator's default DB, which does not hold the app's tables.
    process.env.LOOM_KUSTO_DEFAULT_DB = 'loomdb';
    const r = await kqlDashboardProvisioner({
      ...input({
        kind: 'kql-dashboard',
        tiles: [{ title: 't', kql: 'CrossDomainAccess | count', viz: 'card' }],
        siblingKqlDatabases: ['FederationAudit__ADX_'],
      }),
      target: {
        mode: 'shared', dashboardBackend: 'adx',
        kustoClusterUri: 'https://adx.example.kusto.windows.net', kustoDatabase: 'loomdb',
      },
    } as any);

    expect(r.status).toBe('created');
    expect(r.secondaryIds?.database).toBe('FederationAudit__ADX_');
  });

  it('the sibling wins over a bundle declaration that disagrees with it', async () => {
    // app-federal-data-mesh hard-coded `FederationAudit` in its pipeline sinks
    // while the item provisions `FederationAudit__ADX_`. A declaration that
    // contradicts what is provisioned is the bug, not the source of truth —
    // and the receipt has to SAY which name won.
    const r = await kqlDashboardProvisioner(input({
      kind: 'kql-dashboard',
      tiles: [{ title: 't', kql: 'DomainCost | count', viz: 'card' }],
      database: 'FederationAudit',
      siblingKqlDatabases: ['FederationAudit__ADX_'],
    }));

    expect(r.status).toBe('created');
    expect(r.secondaryIds?.database).toBe('FederationAudit__ADX_');
    expect((r.steps || []).join('\n')).toMatch(/Bundle declared database 'FederationAudit'.*'FederationAudit__ADX_'/s);
  });

  it('a declared database is used when the bundle provisions no DB item', async () => {
    // app-workspace-monitoring's case: the DB exists, it is just not created by
    // a sibling item in the same bundle.
    const r = await kqlDashboardProvisioner(input({
      kind: 'kql-dashboard',
      tiles: [{ title: 't', kql: 'Usage | count', viz: 'card' }],
      database: 'LoomWorkspaceMonitoring',
      siblingKqlDatabases: [],
    }));

    expect(r.status).toBe('created');
    expect(r.secondaryIds?.database).toBe('LoomWorkspaceMonitoring');
  });

  it('no database at all is an honest gate, not a slug of the dashboard name', async () => {
    // At head this returned status:'created' bound to
    // `Department_CIO_Federation___Cost KQL Database`-ish — a name nothing
    // creates — so the install said "done" over a dashboard whose every tile
    // was going to fail.
    process.env.LOOM_KUSTO_DEFAULT_DB = 'loomdb';
    const r = await kqlDashboardProvisioner(input({
      kind: 'kql-dashboard',
      tiles: [{ title: 't', kql: 'Whatever | count', viz: 'card' }],
      siblingKqlDatabases: [],
    }));

    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toMatch(/no kql-database item.*declares no database name/s);
    expect(r.gate?.remediation).toMatch(/Add a kql-database item/);
  });

  it('two sibling databases and no declaration is ambiguous, and says so', async () => {
    const r = await kqlDashboardProvisioner(input({
      kind: 'kql-dashboard',
      tiles: [{ title: 't', kql: 'X | count', viz: 'card' }],
      siblingKqlDatabases: ['DbOne', 'DbTwo'],
    }));

    expect(r.status).toBe('remediation');
    expect(r.gate?.reason).toMatch(/provisions 2 KQL databases \(DbOne, DbTwo\)/);
    expect(r.gate?.remediation).toMatch(/DbOne, DbTwo/);
  });

  it('an ADX cluster is still the first gate — a DB name cannot save a missing cluster', async () => {
    const r = await kqlDashboardProvisioner({
      ...input({ kind: 'kql-dashboard', tiles: [], siblingKqlDatabases: ['X'] }),
      target: { mode: 'shared', dashboardBackend: 'adx' },
    } as any);
    delete process.env.LOOM_KUSTO_CLUSTER_URI;
    expect(r.status).toBe('remediation');
    expect(r.gate?.gateId).toBe('svc-adx');
  });
});

describe('kql-dashboard — every shipped bundle can resolve a database (#3537)', () => {
  it('app-federal-data-mesh declares the name its kql-database item provisions', () => {
    const db = itemsOf(federalDataMesh, 'kql-database')[0];
    const dash = itemsOf(federalDataMesh, 'kql-dashboard')[0];
    // The declaration and the provisioned name AGREE — that is the whole fix.
    expect((dash.content as any).database).toBe(safeAdxDatabaseName(db.displayName));
    expect(safeAdxDatabaseName(db.displayName)).toBe('FederationAudit__ADX_');
  });

  it('app-federal-data-mesh pipeline ADX sinks target the same provisioned name', () => {
    // The sinks hard-coded `FederationAudit`, which no item in this bundle
    // creates — so the cost ingest wrote to a database that does not exist and
    // the dashboard's cost tiles had nothing to read even once the DB resolved.
    const provisioned = safeAdxDatabaseName(itemsOf(federalDataMesh, 'kql-database')[0].displayName);
    const json = JSON.stringify(federalDataMesh);
    expect(json).not.toMatch(/"database":"FederationAudit"/);
    expect(json).toMatch(new RegExp(`"database":"${provisioned}"`));
  });

  it('app-finops-cost now ships the kql-database its billing_events tiles query', () => {
    const dbs = itemsOf(finopsCost, 'kql-database');
    expect(dbs).toHaveLength(1);
    const tables = (dbs[0].content as any).tables.map((t: any) => t.name);
    expect(tables).toContain('billing_events');
    // Every column the tiles project exists on the seeded table.
    const cols = (dbs[0].content as any).tables[0].columns.map((c: any) => c.name);
    for (const c of ['billing_time', 'billing_date', 'billed_cost', 'service_name', 'subscription_id', 'subscription_name']) {
      expect(cols).toContain(c);
    }
  });

  it('app-fedramp-tracker now ships the cyber medallion its tiles query, bracketed', () => {
    const dbs = itemsOf(fedrampTracker, 'kql-database');
    expect(dbs).toHaveLength(1);
    const tables = (dbs[0].content as any).tables.map((t: any) => t.name);
    expect(tables).toEqual([
      'bronze.stg_sentinel_alerts',
      'silver.fct_security_alerts',
      'silver.dim_mitre_techniques',
      'gold.rpt_compliance_posture',
    ]);
    // ADX has no schemas: a dotted name MUST be bracketed in the query body or
    // it does not parse as a table reference at all.
    const tileKql = itemsOf(fedrampTracker, 'kql-dashboard')[0].content.tiles
      .map((t: any) => t.kql).join('\n');
    for (const t of tables) expect(tileKql).toContain(`['${t}']`);
    expect(tileKql).not.toMatch(/(^|[\s(])bronze\.stg_sentinel_alerts/m);
    expect(tileKql).not.toMatch(/(^|[\s(])silver\.fct_security_alerts/m);
  });

  it('EVERY bundle that ships a kql-dashboard can resolve a database', () => {
    // The population check. A dashboard with neither a sibling kql-database nor
    // a declared `content.database` now GATES rather than silently binding to
    // the default DB — so a bundle in that state is a shipped dead dashboard,
    // and this test is what stops the next one from being added.
    const bundles = [federalDataMesh, finopsCost, fedrampTracker];
    for (const b of bundles) {
      const siblings = itemsOf(b, 'kql-database').map((i: any) => safeAdxDatabaseName(i.displayName));
      for (const dash of itemsOf(b, 'kql-dashboard')) {
        const declared = (dash.content as any).database;
        expect(
          siblings.length === 1 || !!declared,
          `${(b as any).appId || (b as any).id}: dashboard '${dash.displayName}' resolves no database`,
        ).toBe(true);
      }
    }
  });
});

describe('provisioning-engine — the sibling hand-off is actually wired (#3537)', () => {
  it("the engine hands the dashboard its siblings' BACKING names", async () => {
    // END-TO-END through the real engine, not a source-string check: a fix that
    // lives only in the provisioner is INERT until the engine passes the value,
    // and that is exactly the half a provisioner-only test cannot see.
    //
    // The kql-database item is included WITHOUT an id, so the engine counts it
    // as a sibling (which is all this assertion needs) and short-circuits its
    // own provisioning without touching ARM.
    //
    // `runProvisioning` is imported STATICALLY at the top of this file — see the
    // note there; as a dynamic import inside this body it cost 18.1s of module
    // transform against the 30s testTimeout and flaked (#4315).
    const report = await runProvisioning(
      { claims: { oid: 'o' } } as any,
      'app-federal-data-mesh',
      'ws-1',
      [
        { itemType: 'kql-database', displayName: 'FederationAudit (ADX)' },
        {
          itemType: 'kql-dashboard',
          id: 'dash-1',
          displayName: 'Department CIO Federation & Cost',
          content: { kind: 'kql-dashboard', tiles: [{ title: 't', kql: 'DomainCost | count', viz: 'card' }] },
        },
      ],
      { deploy: true, mode: 'shared', targetOverrides: { kustoClusterUri: 'https://adx.example.kusto.windows.net' } },
    );

    const dash = report.steps.find((s) => s.itemType === 'kql-dashboard')!;
    expect(dash.result.status).toBe('created');
    expect(dash.result.secondaryIds?.database).toBe('FederationAudit__ADX_');
  });
});
