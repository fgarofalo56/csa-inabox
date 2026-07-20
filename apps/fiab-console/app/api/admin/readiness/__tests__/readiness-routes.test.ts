/**
 * BFF contract tests for the readiness routes (WS-H).
 *
 * Per no-vaporware.md these exercise the REAL route handlers with the self-audit
 * probe run mocked (so no live Azure calls), pinning the capability-gate, the
 * report shape (H1 + H2), and the tenant-profile export in both JSON + markdown
 * (H3) with its download headers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'admin-1', upn: 'admin@contoso.com', tid: 'tenant-1' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

const enforceCapability = vi.fn(async () => null);
vi.mock('@/lib/auth/feature-gate', () => ({
  enforceCapability: (...a: any[]) => enforceCapability(...a),
}));

vi.mock('@/lib/azure/cloud-endpoints', () => ({
  detectLoomCloud: () => 'AzureCloud',
}));

// Self-audit run is mocked: return a single passing probe so the readiness
// derivation attaches a live status without any real Azure I/O.
const runSelfAudit = vi.fn(async () => ({
  generatedAt: '2026-07-20T00:00:00.000Z',
  score: 100,
  summary: { pass: 1, warn: 0, fail: 0, total: 1, fixable: 0 },
  results: [
    { id: 'probe-cosmos', category: 'data-plane', title: 'Cosmos', severity: 'critical', status: 'pass', detail: 'reachable' },
  ],
}));
vi.mock('@/lib/admin/self-audit', () => ({
  runSelfAudit: (...a: any[]) => runSelfAudit(...a),
}));

describe('GET /api/admin/readiness', () => {
  beforeEach(() => { enforceCapability.mockClear(); runSelfAudit.mockClear(); });

  it('is capability-gated (403 propagates)', async () => {
    const { NextResponse } = await import('next/server');
    enforceCapability.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('returns the capability graph + workload scorecard with live probes', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.capabilities)).toBe(true);
    expect(j.capabilities.length).toBeGreaterThan(0);
    expect(Array.isArray(j.workloads)).toBe(true);
    expect(j.summary.score).toBeGreaterThanOrEqual(0);
    expect(j.probed).toBeGreaterThanOrEqual(1);
    expect(runSelfAudit).toHaveBeenCalled();
    // The mocked cosmos probe pass attaches to the cosmos-config capability.
    const cosmos = j.capabilities.find((n: any) => n.id === 'cosmos-config');
    expect(cosmos?.probe?.status).toBe('pass');
  });

  it('degrades honestly when the self-audit throws (config-only)', async () => {
    runSelfAudit.mockRejectedValueOnce(new Error('probe boom'));
    const { GET } = await import('../route');
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.probeError).toContain('probe boom');
    expect(j.probed).toBe(0);
  });
});

describe('GET /api/admin/readiness/export', () => {
  beforeEach(() => { enforceCapability.mockClear(); runSelfAudit.mockClear(); });

  const req = (qs = '') => new NextRequest(`http://localhost/api/admin/readiness/export${qs}`);

  it('is capability-gated', async () => {
    const { NextResponse } = await import('next/server');
    enforceCapability.mockResolvedValueOnce(NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }));
    const { GET } = await import('../export/route');
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('exports JSON with a download filename', async () => {
    const { GET } = await import('../export/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('.json');
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.profile.blockers).toBeDefined();
    expect(j.profile.environment).toBeDefined();
    expect(j.profile.workloads.length).toBeGreaterThan(0);
  });

  it('exports markdown when format=md', async () => {
    const { GET } = await import('../export/route');
    const res = await GET(req('?format=md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('.md');
    const text = await res.text();
    expect(text).toContain('# CSA Loom — Ready-to-run tenant profile');
    expect(text).toContain('## Workload readiness');
  });
});
