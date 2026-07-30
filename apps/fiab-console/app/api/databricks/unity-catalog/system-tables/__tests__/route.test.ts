/**
 * BFF tests for the Unity Catalog system-tables route.
 *
 * The regression these lock is AUTHORIZATION. This route reads
 * `system.access.audit` — the whole metastore's activity, not the caller's:
 * actor UPNs, Entra oids, securable FQNs, and the DENIAL rows, which are a map of
 * what other people tried to reach and were refused. It shipped with a bare
 * `getSession()` check, so any signed-in user could read all of it. It is now
 * `withTenantAdmin` on GET **and** POST, like the sibling reader of the same
 * trail (app/api/admin/audit-logs/route.ts).
 *
 * Proving "an admin can read it" proves nothing about the non-admin, so every
 * attack below asserts BOTH the 403 and that the reader was never called — a 403
 * body with the rows already fetched would still have run a cross-user query.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(() => null),
  listWarehouses: vi.fn(async () => [{ id: 'wh-1', state: 'RUNNING' }]),
}));
// Partial mock: the route-toolkit chain pulls other cloud-endpoints exports
// (armScope et al.) through unrelated modules, so only the two the route reads
// are overridden.
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGovCloud: vi.fn(() => false),
  cloudBoundaryLabel: vi.fn(() => 'Azure Government'),
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  primaryWorkspaceHost: vi.fn(async () => 'adb-1.7.azuredatabricks.net'),
  getMetastoreSummary: vi.fn(async () => ({ metastoreId: 'm-1' })),
  listSystemSchemas: vi.fn(async () => [{ schema: 'access', state: 'ENABLE_COMPLETED' }]),
  enableSystemSchema: vi.fn(async () => undefined),
  readAccessAudit: vi.fn(async () => ({ columns: ['event_time'], rows: [], executionMs: 3 })),
  readBillingUsage: vi.fn(async () => ({ columns: [], rows: [], executionMs: 1 })),
  readQueryHistory: vi.fn(async () => ({ columns: [], rows: [], executionMs: 1 })),
}));

import { GET, POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  readAccessAudit, listSystemSchemas, enableSystemSchema,
} from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
const req = (qs = '') => ({ nextUrl: new URL(`http://x/api/databricks/unity-catalog/system-tables${qs}`) }) as never;
const post = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  // The surface is tenant-admin-gated (it serves ORG-WIDE audit). The bootstrap
  // OID is the mechanism isTenantAdmin() checks; the 403 cases below clear it.
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-1';
  (getSession as never as ReturnType<typeof vi.fn>).mockReturnValue(SESSION);
  (isGovCloud as never as ReturnType<typeof vi.fn>).mockReturnValue(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK — authorization.
// ─────────────────────────────────────────────────────────────────────────────
describe('AUTHORIZATION — org-wide audit is tenant-admin only', () => {
  beforeEach(() => {
    // A perfectly valid, signed-in, NON-admin session.
    delete process.env.LOOM_TENANT_ADMIN_OID;
    delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
    (getSession as never as ReturnType<typeof vi.fn>).mockReturnValue({
      claims: { upn: 'mallory@contoso.com', oid: 'oid-mallory', groups: [] },
      exp: 9_999_999_999,
    });
  });

  it('403s a signed-in NON-admin on system.access.audit — and reads nothing', async () => {
    const res = await GET(req('?table=audit&days=7'));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    // The gate must fire BEFORE the trail is touched.
    expect(readAccessAudit).not.toHaveBeenCalled();
  });

  it('403s a signed-in NON-admin on billing and query-history too', async () => {
    expect((await GET(req('?table=billing'))).status).toBe(403);
    expect((await GET(req('?table=query-history'))).status).toBe(403);
  });

  it('403s a signed-in NON-admin on the enablement-state read and on POST', async () => {
    expect((await GET(req('?info=schemas'))).status).toBe(403);
    expect((await POST(post({ action: 'enable-schema', schema: 'access' }))).status).toBe(403);
    expect(listSystemSchemas).not.toHaveBeenCalled();
    expect(enableSystemSchema).not.toHaveBeenCalled();
  });

  it('lets a tenant admin through (the gate is authorization, not a wall)', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'oid-mallory';
    const res = await GET(req('?table=audit'));
    expect(res.status).toBe(200);
    expect(readAccessAudit).toHaveBeenCalledTimes(1);
  });

  it('401s without a session at all', async () => {
    (getSession as never as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect((await GET(req('?table=audit'))).status).toBe(401);
    expect(readAccessAudit).not.toHaveBeenCalled();
  });
});

describe('GET — the Databricks reader is unchanged', () => {
  it('reads system.access.audit over the SQL warehouse', async () => {
    const res = await GET(req('?table=audit'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('databricks');
    expect(readAccessAudit).toHaveBeenCalledTimes(1);
  });

  it('gates honestly at the Gov boundary and names the trail that DOES work there', async () => {
    (isGovCloud as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await GET(req('?table=audit'));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    expect(j.code).toBe('uc_system_tables_boundary');
    // The LU-3 choke point writes LoomAudit_CL even in Gov, so the gate points there.
    expect(j.error).toMatch(/LoomAudit_CL/);
    expect(readAccessAudit).not.toHaveBeenCalled();
  });

  it('rejects an unknown table instead of returning an empty grid', async () => {
    expect((await GET(req('?table=not-a-table'))).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A malformed window must be REJECTED, not answered with "nothing happened".
// ─────────────────────────────────────────────────────────────────────────────
describe('window validation', () => {
  it('400s a negative days instead of computing a future lower bound and rendering empty', async () => {
    const res = await GET(req('?table=audit&days=-30'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/days must be a positive/);
    expect(readAccessAudit).not.toHaveBeenCalled();
  });

  it('400s days=0 and a non-positive limit', async () => {
    expect((await GET(req('?table=audit&days=0'))).status).toBe(400);
    expect((await GET(req('?table=audit&limit=-1'))).status).toBe(400);
    expect(readAccessAudit).not.toHaveBeenCalled();
  });

  it('carries a machine-readable gate code on every gated answer', async () => {
    (isGovCloud as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const j = await (await GET(req('?table=audit'))).json();
    expect(j.gated).toBe(true);
    expect(typeof j.code).toBe('string');
    expect(j.code.length).toBeGreaterThan(0);
  });
});
