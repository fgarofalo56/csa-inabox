/**
 * GHSA-v8r7-c2p5-mjf2 — unit specs for the SQL/PostgreSQL server-scope module.
 *
 * These cover the pure admission functions (Layer 3). The wrapper (Layers 1+2)
 * is covered per-route in each route's own `__tests__`, because the thing worth
 * asserting there is that the ROUTE never reaches its Azure client with a
 * caller-chosen coordinate — which only the route file can prove.
 *
 * Every spec names the MUTATION that turns it red. `tsc` is NOT a control on
 * this class: the scoped value and the raw request value are both `string`, so
 * every coordinate-rebinding edit compiles clean (measured on the ADX
 * equivalent, `_lib/adx-item-scope.ts`). These specs are the control.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  admitGovernedServer,
  admitReplicaServer,
  admitBoundRoleAssignmentId,
  admitBoundServerChild,
  boundConnection,
  serverRefsMatch,
} from '../sql-server-scope';

const GOVERNED = '11111111-1111-1111-1111-111111111111';
const DLZ = '22222222-2222-2222-2222-222222222222';
const FOREIGN = '99999999-9999-9999-9999-999999999999';

const sqlId = (sub: string, name = 'srv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${name}`;
const pgId = (sub: string, name = 'pgsrv') =>
  `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.DBforPostgreSQL/flexibleServers/${name}`;

const ENV_KEYS = [
  'LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_SUBSCRIPTION_ID', 'LOOM_DLZ_SUB',
  'LOOM_ASA_SUB', 'LOOM_EVENTHUB_SUB', 'LOOM_AI_SEARCH_SUB', 'LOOM_FOUNDRY_SUB',
  'LOOM_KUSTO_SUB', 'LOOM_EXTRA_SUBSCRIPTIONS', 'LOOM_COST_SUBSCRIPTIONS',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.LOOM_SUBSCRIPTION_ID = GOVERNED;
  process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('admitGovernedServer — the subscription pin (Layer 3)', () => {
  // THE ADVISORY'S CORE PRIMITIVE. Every client branches
  // `ref.startsWith('/') ? ref : <compose from LOOM_SUBSCRIPTION_ID>`, so a full
  // ARM id skipped the pin entirely and reached any subscription the UAMI held a
  // role in — including a brownfield customer's pre-existing servers.
  //   MUTATION: drop the `governed.some(...)` check in admitGovernedServer.
  it('REFUSES a full ARM id in a subscription this deployment does not govern', () => {
    const r = admitGovernedServer(sqlId(FOREIGN), 'sql');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(403);
    expect(r.code).toBe('server_not_governed');
  });

  // The legitimate-owner direction. A fix that refuses real users is not a fix.
  it('ADMITS a full ARM id in the admin subscription', () => {
    const r = admitGovernedServer(sqlId(GOVERNED), 'sql');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.server).toBe(sqlId(GOVERNED));
  });

  // Multi-sub / DLZ estates are first-class (loom-subscriptions.ts): the DLZ RG
  // lives in its own subscription, so pinning to LOOM_SUBSCRIPTION_ID alone
  // would refuse every DLZ-hosted server.
  //   MUTATION: pin to adminSubscriptionId() instead of loomSubscriptionScope().
  it('ADMITS a server in the DLZ subscription (multi-sub estates)', () => {
    expect(admitGovernedServer(sqlId(DLZ), 'sql').ok).toBe(true);
  });

  it('is case-insensitive on the subscription GUID', () => {
    expect(admitGovernedServer(sqlId(GOVERNED.toUpperCase()), 'sql').ok).toBe(true);
  });

  // FAIL CLOSED. With no governed set there is nothing to admit against, so an
  // ARM id must be refused rather than waved through.
  //   MUTATION: `if (!governed.length) return { ok: true, server: scoped(raw) }`.
  it('FAILS CLOSED when the deployment declares no governed subscription', () => {
    delete process.env.LOOM_SUBSCRIPTION_ID;
    delete process.env.LOOM_DLZ_SUBSCRIPTION_ID;
    const r = admitGovernedServer(sqlId(GOVERNED), 'sql');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('server_not_governed');
  });

  // A caller cannot point a Microsoft.Sql route at another provider's resource.
  //   MUTATION: drop the providerPath comparison.
  it('REFUSES an ARM id of the wrong provider/type for the route', () => {
    const r = admitGovernedServer(pgId(GOVERNED), 'sql');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('server_type_mismatch');
  });

  it('admits the PostgreSQL provider on a postgres route, and refuses SQL there', () => {
    expect(admitGovernedServer(pgId(GOVERNED), 'postgres').ok).toBe(true);
    const r = admitGovernedServer(sqlId(GOVERNED), 'postgres');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('server_type_mismatch');
  });

  // A bare name carries NO subscription, so the clients resolve it by listing
  // servers in LOOM_SUBSCRIPTION_ID — pinned by construction.
  it('ADMITS a bare server name and returns it unchanged', () => {
    const r = admitGovernedServer('sql-loom-prod', 'sql');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.server).toBe('sql-loom-prod');
  });

  it('reduces an FQDN to its first DNS label (cloud-agnostic)', () => {
    const r = admitGovernedServer('sql-loom-prod.database.usgovcloudapi.net', 'sql');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.server).toBe('sql-loom-prod');
  });

  // The value is interpolated into ARM paths by the clients, so anything that
  // could re-shape the path is refused rather than escaped.
  //   MUTATION: loosen SERVER_NAME_RE to /^[^/]+$/.
  it.each([
    ['path traversal', '../../subscriptions/other/resourceGroups/x'],
    ['embedded slash', 'srv/databases/master'],
    ['query string', 'srv?api-version=2023-08-01'],
    ['whitespace', 'srv name'],
    ['leading hyphen', '-srv'],
    ['trailing hyphen', 'srv-'],
    ['empty', ''],
  ])('REFUSES a bare name with %s', (_label, value) => {
    expect(admitGovernedServer(value, 'sql').ok).toBe(false);
  });

  it('REFUSES a partial / malformed ARM id', () => {
    const r = admitGovernedServer(`/subscriptions/${GOVERNED}/resourceGroups/rg-loom`, 'sql');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('malformed_server_id');
  });

  it('REFUSES a non-string reference', () => {
    expect(admitGovernedServer(undefined, 'sql').ok).toBe(false);
    expect(admitGovernedServer({ toString: () => sqlId(FOREIGN) } as unknown, 'sql').ok).toBe(false);
  });
});

describe('admitReplicaServer — the geo-replication destination', () => {
  // The SECOND ARM coordinate on `replication`. `enableReplication` resolves
  // `replicaServer` through the identical startsWith('/') branch, so pinning the
  // primary alone still left an ARM PUT pointed at any subscription.
  //   MUTATION: pass `replicaServer` straight through in replication/route.ts.
  it('REFUSES a replica server in an ungoverned subscription', () => {
    const r = admitReplicaServer(sqlId(FOREIGN, 'attacker'), 'sql');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('server_not_governed');
  });

  it('ADMITS a governed replica server (a legitimate user pick)', () => {
    expect(admitReplicaServer('sql-loom-dr', 'sql').ok).toBe(true);
  });

  it('reports a MISSING replica as a 400, not a 409 no-binding', () => {
    const r = admitReplicaServer('', 'sql');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(400);
  });
});

describe('admitBoundRoleAssignmentId — the revoke primitive', () => {
  const assignment = (server: string, db: string, sub = GOVERNED) =>
    `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${server}/databases/${db}` +
    '/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // `revokeDatabaseRoleAssignment` issues a raw ARM DELETE on whatever id it is
  // handed, at ANY scope — broader than the grant half it sits beside.
  //   MUTATION: pass the raw `assignmentId` query param to the client.
  it('REFUSES an assignment on a DIFFERENT database', () => {
    const r = admitBoundRoleAssignmentId(assignment('srv', 'victim-db'), 'srv', 'my-db');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(403);
    expect(r.code).toBe('assignment_out_of_scope');
  });

  it('REFUSES an assignment on a DIFFERENT server', () => {
    const r = admitBoundRoleAssignmentId(assignment('victim-srv', 'my-db'), 'srv', 'my-db');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('assignment_out_of_scope');
  });

  it('REFUSES an assignment in an ungoverned subscription', () => {
    const r = admitBoundRoleAssignmentId(assignment('srv', 'my-db', FOREIGN), 'srv', 'my-db');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('server_not_governed');
  });

  // Not a database scope at all — e.g. a subscription- or RG-scoped assignment,
  // which is where the genuinely dangerous grants live.
  it('REFUSES an assignment that is not at a database scope', () => {
    const r = admitBoundRoleAssignmentId(
      `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv` +
      '/providers/Microsoft.Authorization/roleAssignments/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'srv', 'my-db',
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('assignment_out_of_scope');
  });

  it('ADMITS an assignment on the item’s OWN bound database', () => {
    const id = assignment('srv', 'my-db');
    const r = admitBoundRoleAssignmentId(id, 'srv', 'my-db');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.assignmentId).toBe(id);
  });

  it('matches an ARM-id binding against the assignment’s server segment', () => {
    expect(admitBoundRoleAssignmentId(assignment('srv', 'my-db'), sqlId(GOVERNED, 'srv'), 'my-db').ok).toBe(true);
  });
});

describe('admitBoundServerChild — the restorable-dropped-database id', () => {
  const dropped = (server: string, sub = GOVERNED) =>
    `/subscriptions/${sub}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/${server}` +
    '/restorableDroppedDatabases/victim,1700000000000';

  // `startPointInTimeRestore` copies this id verbatim into
  // `properties.sourceDatabaseId`, so an id from another subscription restored
  // THAT subscription's dropped database onto the pinned server.
  //   MUTATION: pass body.restorableDroppedDatabaseId straight through.
  it('REFUSES a dropped-database id on a different server', () => {
    const r = admitBoundServerChild(dropped('victim-srv'), 'srv', 'sql', 'restorableDroppedDatabases');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('child_out_of_scope');
  });

  it('REFUSES a dropped-database id in an ungoverned subscription', () => {
    const r = admitBoundServerChild(dropped('srv', FOREIGN), 'srv', 'sql', 'restorableDroppedDatabases');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('server_not_governed');
  });

  it('REFUSES a different child type on the right server', () => {
    const r = admitBoundServerChild(
      `/subscriptions/${GOVERNED}/resourceGroups/rg-loom/providers/Microsoft.Sql/servers/srv/databases/other`,
      'srv', 'sql', 'restorableDroppedDatabases',
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('child_out_of_scope');
  });

  it('ADMITS a dropped database on the item’s OWN bound server', () => {
    const id = dropped('srv');
    const r = admitBoundServerChild(id, 'srv', 'sql', 'restorableDroppedDatabases');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.id).toBe(id);
  });
});

describe('boundConnection / serverRefsMatch', () => {
  it('reads the shape POST /connect persists, trimming', () => {
    expect(boundConnection({ state: { connection: { family: 'azure-sql', server: ' srv ', database: ' db ' } } } as any))
      .toEqual({ server: 'srv', database: 'db', family: 'azure-sql' });
  });

  it('reports an unbound item as empty strings (never undefined)', () => {
    expect(boundConnection({ state: {} } as any)).toEqual({ server: '', database: '', family: '' });
    expect(boundConnection(null)).toEqual({ server: '', database: '', family: '' });
    expect(boundConnection({ state: { connection: { server: 42 } } } as any).server).toBe('');
  });

  it('treats an EMPTY submitted value as "no conflict"', () => {
    expect(serverRefsMatch('', 'srv')).toBe(true);
  });

  it('matches bare vs FQDN vs ARM id for the same logical server', () => {
    expect(serverRefsMatch('srv', 'srv')).toBe(true);
    expect(serverRefsMatch('SRV.database.windows.net', 'srv')).toBe(true);
    expect(serverRefsMatch(sqlId(GOVERNED, 'srv'), 'srv')).toBe(true);
    expect(serverRefsMatch('srv', sqlId(GOVERNED, 'srv'))).toBe(true);
  });

  it('does NOT match a different server', () => {
    expect(serverRefsMatch('attacker', 'srv')).toBe(false);
    expect(serverRefsMatch(sqlId(FOREIGN, 'attacker'), 'srv')).toBe(false);
  });
});
