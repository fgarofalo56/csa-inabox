/**
 * #4776 (round 4, B-6) — the Console identity's SCIM detail (display name,
 * application id, entitlements, groups) must NOT reach a non-admin reader.
 *
 * The chain the round-3 re-reviews measured: the resolver published the
 * diagnostic INSIDE the runtime failure `message`; `evalEnv` puts that message
 * into the `svc-databricks-sql` check detail; `runSelfAudit` returns every
 * check; and two non-admin surfaces serve `runSelfAudit` — GET
 * /api/admin/self-audit (any signed-in user) and the Copilot `loom_self_audit`
 * tool (session-only invoke route).
 *
 * The fix keeps the diagnostic in the failure's SEPARATE `diagnostic` field,
 * which `evalEnv` never reads, and attaches it only in admin-capability routes.
 * The resolver's publish split is pinned in databricks-sql-warehouse.test.ts;
 * this file pins the READERS, from the store onward, with the REAL self-audit,
 * the REAL Copilot tool and the REAL /api/admin/gates route.
 *
 * Breaking input: publish the diagnostic inside `message` again (or have
 * `evalEnv` / self-audit read `diagnostic`), and APP_ID appears in the
 * non-admin outputs. Drop `gateAdminDiagnostic` from /api/admin/gates, and the
 * positive admin assertion goes RED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { publishRuntimeFailure, clearRuntimeProduced } from '@/lib/azure/runtime-produced-env';

const VAR = 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID';
const APP_ID = 'APPID-4776-PROBE';
const NAME = 'loom-console-uami-probe';

vi.mock('@/lib/auth/session', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/auth/session');
  // A plain signed-in user: no LOOM_TENANT_ADMIN_* env is set, so isTenantAdmin() is false.
  return { ...actual, getSession: () => ({ claims: { oid: 'plain-user', upn: 'user@contoso.com', tid: 't1' } }) };
});
vi.mock('@/lib/auth/feature-gate', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/auth/feature-gate');
  // Only for the ADMIN route below: the capability check passes (an admin caller).
  return { ...actual, enforceCapability: async () => null };
});
// The self-audit's gate checks run the runtime producer; keep it from
// re-resolving (and overwriting the failure this test publishes).
vi.mock('@/lib/azure/databricks-sql-warehouse', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/databricks-sql-warehouse');
  return { ...actual, tryResolveWarehouseId: async () => null };
});

// The support-bundle route's backends (Cosmos reachability, audit rows,
// synthetic runs) answer empty so the bundle assembles offline.
vi.mock('@/lib/azure/cosmos-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/cosmos-client');
  return {
    ...actual,
    probeCosmosReachable: async () => undefined,
    auditLogContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  };
});
vi.mock('@/lib/admin/synthetic-runs-reader', () => ({ readSyntheticRuns: async () => ({ configured: false, runs: [] }) }));

function publishPermissionFailure() {
  publishRuntimeFailure(VAR, {
    kind: 'permission',
    message: 'Databricks refused the Console identity\'s create call (HTTP 403 PERMISSION_DENIED): not allowed. Measured via SCIM Me: "allow-cluster-create" is ABSENT from the Console identity\'s direct entitlements and it is not in the admins group.',
    remediation: 'A workspace admin grants allow-cluster-create to the Console managed identity.',
    diagnostic: `SCIM Me: identity ${NAME} (application ${APP_ID}); direct entitlements [workspace-access]; groups [users].`,
  });
}

beforeEach(() => {
  vi.stubEnv(VAR, '');
  vi.stubEnv('LOOM_TENANT_ADMIN_OID', '');
  vi.stubEnv('LOOM_TENANT_ADMIN_GROUP_ID', '');
  clearRuntimeProduced(VAR);
  publishPermissionFailure();
});
afterEach(() => { clearRuntimeProduced(VAR); vi.unstubAllEnvs(); });

describe('B-6 — the SCIM identity diagnostic reaches admin readers only', () => {
  it('GET /api/admin/self-audit as a NON-admin: no application id, no identity name — the classified cause still there', async () => {
    const { GET } = await import('@/app/api/admin/self-audit/route');
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.isAdmin).toBe(false);
    const text = JSON.stringify(j);
    expect(text).not.toContain(APP_ID);
    expect(text).not.toContain(NAME);
    // Positive half: the check is present and still carries kind + remediation.
    const check = j.report.results.find((r: any) => r.id === 'svc-databricks-sql');
    expect(check).toBeDefined();
    expect(check.detail).toMatch(/failed \(permission\)/);
    expect(check.remediation).toMatch(/allow-cluster-create/);
  }, 120_000);

  it('Copilot loom_self_audit tool output: no application id, no identity name — the finding still listed', async () => {
    const { buildDefaultRegistry } = await import('@/lib/azure/copilot-orchestrator');
    const tool = buildDefaultRegistry().get('loom_self_audit');
    expect(tool).toBeDefined();
    const out = JSON.stringify(await tool!.handler({} as any));
    expect(out).not.toContain(APP_ID);
    expect(out).not.toContain(NAME);
    expect(out).toMatch(/failed \(permission\)/);
  }, 120_000);

  it('GET /api/admin/gates (admin capability): the diagnostic IS attached — and still not in `detail`', async () => {
    const { GET } = await import('@/app/api/admin/gates/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/gates'), { params: Promise.resolve({}) } as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    const g = j.gates.find((x: any) => x.id === 'svc-databricks-sql');
    // Positive pair: breaks if the admin route stops attaching the diagnostic.
    expect(g.diagnostic).toContain(APP_ID);
    expect(g.diagnostic).toContain(NAME);
    expect(String(g.detail)).not.toContain(APP_ID);
    expect(g.detail).toMatch(/failed \(permission\)/);
  });

  it('GET /api/admin/diagnostics/bundle (tenant admin): the gate posture carries the diagnostic', async () => {
    vi.stubEnv('LOOM_TENANT_ADMIN_OID', 'plain-user'); // this session IS the tenant admin here
    const { GET } = await import('@/app/api/admin/diagnostics/bundle/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/diagnostics/bundle'), { params: Promise.resolve({}) } as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    const g = j.bundle.gates.find((x: any) => x.id === 'svc-databricks-sql');
    // Breaks if the bundle route stops attaching the admin-only diagnostic.
    expect(g.diagnostic).toContain(APP_ID);
  });
});
