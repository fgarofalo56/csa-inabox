/**
 * BFF route tests for /api/admin/spark-telemetry/audit.
 *
 * Verifies: tenant-admin gate, the honest not-configured gate (200 + gate body),
 * GET returns the audit + prior apply, and POST applies + returns a fresh audit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { MonitorNotConfiguredError, MonitorError } = vi.hoisted(() => ({
  MonitorNotConfiguredError: class extends Error {
    missing: string[];
    constructor(missing: string[]) { super('not configured'); this.missing = missing; }
  },
  MonitorError: class extends Error { status = 500; },
}));

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSession(),
  tenantScopeId: (s: any) => s.claims.tid || s.claims.oid,
}));

const requireTenantAdmin = vi.fn();
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: (s: any) => requireTenantAdmin(s) }));

const auditSparkTelemetry = vi.fn();
const applySparkTelemetry = vi.fn();
const saveLastRun = vi.fn(async () => {});
const readLastRun = vi.fn(async () => null);
vi.mock('@/lib/azure/spark-telemetry-audit', () => ({
  auditSparkTelemetry: () => auditSparkTelemetry(),
  applySparkTelemetry: (ids?: string[]) => applySparkTelemetry(ids),
  saveLastRun: (...a: unknown[]) => saveLastRun(...a),
  readLastRun: (...a: unknown[]) => readLastRun(...a),
  MonitorNotConfiguredError,
  MonitorError,
}));

import { GET, POST } from '../audit/route';

const ADMIN = { claims: { oid: 'tenant-1', tid: 'tenant-1', upn: 'admin@contoso.com' } };
const AUDIT = {
  generatedAt: '2026-07-10T00:00:00Z', lawResourceId: '/law', sessionEmitterConfigured: true,
  summary: { total: 3, covered: 1, missing: 2 }, resources: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(ADMIN);
  requireTenantAdmin.mockReturnValue(null); // admin — proceed
  auditSparkTelemetry.mockResolvedValue(AUDIT);
  applySparkTelemetry.mockResolvedValue({ appliedAt: 'x', attempted: 2, succeeded: 2, failed: 0, results: [] });
  readLastRun.mockResolvedValue(null);
});

describe('GET /api/admin/spark-telemetry/audit', () => {
  it('401 when unauthenticated', async () => {
    getSession.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the gate when the admin check fails', async () => {
    requireTenantAdmin.mockReturnValue(
      new Response(JSON.stringify({ ok: false, code: 'admin_only' }), { status: 403 }),
    );
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('returns the audit and persists the run', async () => {
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.audit.summary.missing).toBe(2);
    expect(saveLastRun).toHaveBeenCalledOnce();
  });

  it('renders the honest gate (200) when LAW resource id is unset', async () => {
    auditSparkTelemetry.mockRejectedValue(new MonitorNotConfiguredError(['LOOM_LOG_ANALYTICS_RESOURCE_ID']));
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(false);
    expect(j.gate.missing).toContain('LOOM_LOG_ANALYTICS_RESOURCE_ID');
  });
});

describe('POST /api/admin/spark-telemetry/audit', () => {
  function req(body: unknown) {
    return new NextRequest('http://localhost/api/admin/spark-telemetry/audit', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
  }

  it('applies to all missing when no ids given, returns a fresh audit', async () => {
    const res = await POST(req({}));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(applySparkTelemetry).toHaveBeenCalledWith(undefined);
    expect(j.lastApply.succeeded).toBe(2);
    expect(j.audit).toBeTruthy();
  });

  it('threads specific ids through to applySparkTelemetry', async () => {
    await POST(req({ ids: ['/sub/rg/dbx1'] }));
    expect(applySparkTelemetry).toHaveBeenCalledWith(['/sub/rg/dbx1']);
  });
});
