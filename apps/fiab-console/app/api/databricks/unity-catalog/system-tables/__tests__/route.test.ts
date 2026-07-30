/**
 * BFF tests for the backend-aware Unity Catalog system-tables route.
 *
 * The regression this locks: before loom-apex LU-3 this route answered EVERY
 * Azure-Government request with "system tables are not available at this
 * boundary" — a dead gate on a surface that Loom Unity can now answer for real
 * from the BFF audit choke point. These tests fail if that gate ever comes back,
 * if the OSS branch silently falls through to the Databricks SQL readers (which
 * would need a warehouse that does not exist in Gov), or if the honest note for
 * a genuinely-absent family is replaced by an empty grid.
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
vi.mock('@/lib/azure/uc-backend', () => ({ isOssUc: vi.fn(() => false) }));
vi.mock('@/lib/azure/unity-audit', () => ({
  readUnitySystemTable: vi.fn(),
  UNITY_SYSTEM_TABLES: [
    { id: 'audit', label: 'access.audit', description: 'a' },
    { id: 'denials', label: 'access.denied', description: 'b' },
    { id: 'summary', label: 'access.summary', description: 'c' },
  ],
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
import { isOssUc } from '@/lib/azure/uc-backend';
import { readUnitySystemTable } from '@/lib/azure/unity-audit';
import { readAccessAudit } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
const req = (qs = '') => ({ nextUrl: new URL(`http://x/api/databricks/unity-catalog/system-tables${qs}`) }) as never;
const post = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  // The surface is tenant-admin-gated (it serves ORG-WIDE audit). The bootstrap
  // OID is the mechanism isTenantAdmin() checks; the 403 case below clears it.
  process.env.LOOM_TENANT_ADMIN_OID = 'oid-1';
  (getSession as never as ReturnType<typeof vi.fn>).mockReturnValue(SESSION);
  (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (isGovCloud as never as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (readUnitySystemTable as never as ReturnType<typeof vi.fn>).mockResolvedValue({
    columns: ['time', 'actor', 'operation', 'outcome'],
    rows: [{ time: 't', actor: 'a@x', operation: 'grant.update', outcome: 'denied' }],
    executionMs: 4,
    recordCount: 1,
    kql: 'LoomAudit_CL | take 1',
  });
});

describe('GET — Loom Unity (OSS) backend', () => {
  beforeEach(() => {
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isGovCloud as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('serves the real access audit in Gov instead of the boundary gate', async () => {
    const res = await GET(req('?table=audit&days=7&limit=50'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.gated).toBeUndefined();
    expect(j.backend).toBe('oss');
    expect(j.rows).toHaveLength(1);
    expect(j.columns).toContain('outcome');
    expect(readUnitySystemTable).toHaveBeenCalledTimes(1);
    // It must NOT reach for a Databricks SQL warehouse — there is none in Gov.
    expect(readAccessAudit).not.toHaveBeenCalled();
  });

  it('maps the denials view and forwards the caller filters', async () => {
    const res = await GET(req('?table=denials&days=1&limit=10&service=alice&action=grant'));
    const j = await res.json();
    expect(j.table).toBe('denials');
    const [view, opts] = (readUnitySystemTable as never as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(view).toBe('denials');
    expect(opts).toMatchObject({ limit: 10, actor: 'alice', operation: 'grant' });
    // days=1 must become a ~24h lower bound, not an unbounded scan.
    const sinceMs = Date.now() - new Date(opts.since).getTime();
    expect(sinceMs).toBeGreaterThan(23 * 3600 * 1000);
    expect(sinceMs).toBeLessThan(25 * 3600 * 1000);
  });

  it('answers a genuinely-absent family with an honest note naming the real surface', async () => {
    const res = await GET(req('?table=billing'));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    expect(j.error).toMatch(/\/admin\/finops/);
    expect(readUnitySystemTable).not.toHaveBeenCalled();
  });

  it('reports the Loom Unity views as always-enabled rather than a Databricks handshake', async () => {
    const res = await GET(req('?info=schemas'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('oss');
    expect(j.schemas.map((s: { schema: string }) => s.schema)).toEqual(['audit', 'denials', 'summary']);
    expect(j.schemas.every((s: { state: string }) => s.state === 'ENABLE_COMPLETED')).toBe(true);
  });

  it('rejects an unknown view instead of returning an empty grid', async () => {
    const res = await GET(req('?table=not-a-view'));
    expect(res.status).toBe(400);
  });

  it('POST enable-schema is a truthful no-op — the trail is always on', async () => {
    const res = await POST(post({ action: 'enable-schema', schema: 'audit' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.alreadyEnabled).toBe(true);
    expect(j.note).toMatch(/no enablement/i);
  });
});

describe('GET — Databricks backend is unchanged', () => {
  it('still reads system.access.audit over the SQL warehouse in Commercial', async () => {
    const res = await GET(req('?table=audit'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('databricks');
    expect(readAccessAudit).toHaveBeenCalledTimes(1);
    expect(readUnitySystemTable).not.toHaveBeenCalled();
  });

  it('still gates honestly when a Gov estate is pinned to the Databricks backend', async () => {
    (isGovCloud as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await GET(req('?table=audit'));
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.gated).toBe(true);
    // and it must point at the backend that DOES work there
    expect(j.error).toMatch(/LOOM_UC_BACKEND=oss/);
  });

  it('401s without a session', async () => {
    (getSession as never as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await GET(req('?table=audit'));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACK — authorization. This surface serves the ORG-WIDE audit trail: actor
// UPNs + Entra oids, securable FQNs, and the DENIAL rows, which are a map of
// what other people tried to reach and were refused. Neither backend scopes its
// rows to the caller, so a bare session check leaks all of it to any signed-in
// user. Proving "an admin can read it" proves nothing about the non-admin.
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

  it('403s a signed-in NON-admin on the Loom Unity access audit — and reads nothing', async () => {
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await GET(req('?table=audit&days=7'));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('admin_only');
    // The gate must fire BEFORE the trail is touched — a 403 body with the rows
    // already fetched would still have hit Cosmos with a cross-user query.
    expect(readUnitySystemTable).not.toHaveBeenCalled();
  });

  it('403s a signed-in NON-admin on the DENIALS view (who-was-refused is the most sensitive view)', async () => {
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await GET(req('?table=denials'));
    expect(res.status).toBe(403);
    expect(readUnitySystemTable).not.toHaveBeenCalled();
  });

  it('403s a signed-in NON-admin on the Databricks system.access.audit path too', async () => {
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await GET(req('?table=audit'));
    expect(res.status).toBe(403);
    expect(readAccessAudit).not.toHaveBeenCalled();
  });

  it('403s a signed-in NON-admin on the enablement-state read and on POST', async () => {
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect((await GET(req('?info=schemas'))).status).toBe(403);
    expect((await POST(post({ action: 'enable-schema', schema: 'audit' }))).status).toBe(403);
  });

  it('lets a tenant admin through (the gate is authorization, not a wall)', async () => {
    process.env.LOOM_TENANT_ADMIN_OID = 'oid-mallory';
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const res = await GET(req('?table=audit'));
    expect(res.status).toBe(200);
    expect(readUnitySystemTable).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A malformed window must be REJECTED, not answered with "nothing happened".
// ─────────────────────────────────────────────────────────────────────────────
describe('window validation', () => {
  beforeEach(() => {
    process.env.LOOM_TENANT_ADMIN_OID = 'oid-1';
    (isOssUc as never as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('400s a negative days instead of computing a future `since` and rendering the empty state', async () => {
    const res = await GET(req('?table=audit&days=-30'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/days must be a positive/);
    expect(readUnitySystemTable).not.toHaveBeenCalled();
  });

  it('400s days=0 and a non-positive limit', async () => {
    expect((await GET(req('?table=audit&days=0'))).status).toBe(400);
    expect((await GET(req('?table=audit&limit=-1'))).status).toBe(400);
    expect(readUnitySystemTable).not.toHaveBeenCalled();
  });

  it('carries a machine-readable gate code on every gated answer', async () => {
    const res = await GET(req('?table=billing'));
    const j = await res.json();
    expect(j.gated).toBe(true);
    expect(j.code).toBe('not_applicable');
  });
});
