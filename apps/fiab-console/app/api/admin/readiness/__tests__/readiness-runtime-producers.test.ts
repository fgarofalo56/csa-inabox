/**
 * #4776 (B-7) — /admin/readiness runs the runtime producers in the replica
 * SERVING the request BEFORE it reads gate statuses.
 *
 * The produced-value store is per-process, and the probe half of this route can
 * be served from a cache another replica filled, so nothing else guarantees the
 * serving replica ever ran the producer: it would read `svc-databricks-sql`
 * blocked while a sibling replica had produced the warehouse id.
 *
 * Seam: `runRuntimeProducers` is replaced by a producer that PUBLISHES a value
 * after a macrotask (as the real resolver would after its list call). The REAL
 * gate registry and readiness derivation run.
 *
 * Breaks if the route reads `allGateStatuses()` before awaiting the producers
 * (gateStatus 'blocked'), or stops calling them at all (0 calls).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { invalidateModel } from '@/lib/azure/query-result-cache';
import { publishRuntimeValue, publishRuntimeFailure, clearRuntimeProduced } from '@/lib/azure/runtime-produced-env';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'admin-1', upn: 'admin@contoso.com', tid: 'tenant-1' },
    exp: Date.now() / 1000 + 3600,
  })),
}));
vi.mock('@/lib/auth/feature-gate', () => ({ enforceCapability: vi.fn(async () => null) }));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  detectLoomCloud: () => 'AzureCloud',
}));
vi.mock('@/lib/admin/self-audit', () => ({
  runSelfAudit: vi.fn(async () => ({ generatedAt: 'x', score: 100, summary: { pass: 0, warn: 0, fail: 0, total: 0, fixable: 0 }, results: [] })),
}));

const producers = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/lib/admin/gate-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/gate-registry')>()),
  runRuntimeProducers: () => producers.run(),
}));

const VAR = 'LOOM_DATABRICKS_SQL_WAREHOUSE_ID';

describe('GET /api/admin/readiness — runtime producers run first (B-7)', () => {
  beforeEach(() => {
    invalidateModel('readiness-v1');
    clearRuntimeProduced(VAR);
    vi.stubEnv(VAR, '');
    producers.run.mockReset();
  });

  it('a value the producer publishes during THIS request reads configured on this replica', async () => {
    producers.run.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      publishRuntimeValue(VAR, { value: 'wh-produced', source: 'created', detail: "Created 'loom-default' (wh-produced)." });
    });
    const { GET } = await import('../route');
    const j = await (await GET(new NextRequest('http://localhost/api/admin/readiness'))).json();
    expect(producers.run).toHaveBeenCalledTimes(1);
    const node = j.capabilities.find((n: any) => n.id === 'svc-databricks-sql');
    expect(node).toBeDefined();
    expect(node.gateStatus).toBe('configured');
    expect(node.missing).toEqual([]);
  });

  it('control: with no value produced the same gate reads blocked (the assertion above can fail)', async () => {
    producers.run.mockResolvedValue(undefined);
    const { GET } = await import('../route');
    const j = await (await GET(new NextRequest('http://localhost/api/admin/readiness'))).json();
    const node = j.capabilities.find((n: any) => n.id === 'svc-databricks-sql');
    expect(node.gateStatus).toBe('blocked');
    expect(node.missing).toEqual([VAR]);
  });

  it('#4776 B-6: the admin-only producer diagnostic is attached under `diagnostics`, not in the capability detail', async () => {
    producers.run.mockImplementation(async () => {
      publishRuntimeFailure(VAR, {
        kind: 'permission', message: 'refused (HTTP 403)', remediation: 'grant it',
        diagnostic: 'SCIM Me: identity uami-x (application APPID-READINESS).',
      });
    });
    const { GET } = await import('../route');
    const j = await (await GET(new NextRequest('http://localhost/api/admin/readiness'))).json();
    // Breaks if the admin route stops attaching the diagnostic.
    expect(j.diagnostics['svc-databricks-sql']).toContain('APPID-READINESS');
    // …and it is attached ONLY there: the capability nodes (built from the same
    // gate detail the non-admin self-audit shares) do not carry it.
    expect(JSON.stringify(j.capabilities)).not.toContain('APPID-READINESS');
  });
});
