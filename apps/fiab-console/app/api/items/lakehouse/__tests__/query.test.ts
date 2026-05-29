/**
 * Backend contract tests for POST /api/items/lakehouse/[id]/query — the
 * lakehouse's own SQL analytics endpoint (Synapse Serverless over the lake).
 *
 *   1. unauthenticated → 401
 *   2. missing sql → 400
 *   3. oversized sql → 413
 *   4. honest infra-gate (LOOM_SYNAPSE_WORKSPACE unset) → 503 + named env var
 *   5. happy-path runs executeQuery against the serverless target
 *   6. backend failure → 502 with structured error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-sql-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/synapse-sql-client');
  return { ...actual, executeQuery: vi.fn(), serverlessTarget: vi.fn(() => ({ server: 's', database: 'master', cacheKey: 'k' })) };
});

import { POST } from '../[id]/query/route';
import { getSession } from '@/lib/auth/session';
import { executeQuery } from '@/lib/azure/synapse-sql-client';

function req(body: any) {
  return { json: async () => body } as any;
}
const ctx = { params: Promise.resolve({ id: 'lh-1' }) };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.LOOM_SYNAPSE_WORKSPACE = 'loomsyn';
});
afterEach(() => { delete process.env.LOOM_SYNAPSE_WORKSPACE; });

describe('POST /api/items/lakehouse/[id]/query', () => {
  it('401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(401);
  });

  it('400 when sql missing', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(400);
  });

  it('413 when sql too large', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await POST(req({ sql: 'x'.repeat(70_000) }), ctx);
    expect(res.status).toBe(413);
  });

  it('503 honest infra-gate when LOOM_SYNAPSE_WORKSPACE unset', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('synapse_not_configured');
    expect(j.error).toContain('LOOM_SYNAPSE_WORKSPACE');
  });

  it('runs executeQuery and returns rows on happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u@x' } });
    (executeQuery as any).mockResolvedValue({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 5, truncated: false });
    const res = await POST(req({ sql: 'SELECT TOP 100 * FROM OPENROWSET(...) AS r' }), ctx);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.columns).toEqual(['a']);
    expect(j.endpoint).toContain('-ondemand.sql.azuresynapse.net');
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it('502 with structured error when backend throws', async () => {
    (getSession as any).mockReturnValue({ claims: { upn: 'u' } });
    (executeQuery as any).mockRejectedValue(Object.assign(new Error('TDS boom'), { code: 'ELOGIN' }));
    const res = await POST(req({ sql: 'SELECT 1' }), ctx);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('TDS boom');
    expect(j.code).toBe('ELOGIN');
  });
});
