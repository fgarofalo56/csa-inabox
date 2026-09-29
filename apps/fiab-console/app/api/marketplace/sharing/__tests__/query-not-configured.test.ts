/**
 * #4776 — POST /api/marketplace/sharing/query's not-configured body carries
 * `code: 'not_configured'`, which is what the share explorer's surfaceGateFrom
 * keys on to render the registry gate for the missing var. Breaks if the code
 * is dropped (the panel would then fall to its plain query-error bar).
 *
 * The REAL warehouseConfigGate runs: only the session is mocked, and with
 * LOOM_DATABRICKS_HOSTNAME unset the route answers before touching the body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1', upn: 'u@x' } }) }));

import { POST } from '../query/route';

beforeEach(() => {
  vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', '');
  vi.stubEnv('LOOM_DATABRICKS_SQL_WAREHOUSE_ID', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('sharing/query — not-configured body', () => {
  it('503 with code not_configured + the missing var, so the panel renders the gate', async () => {
    const res = await POST(new NextRequest('http://localhost/api/marketplace/sharing/query', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalog: 'shared_gold', sql: 'SHOW SCHEMAS' }),
    }));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j).toMatchObject({ ok: false, gate: true, code: 'not_configured', missing: 'LOOM_DATABRICKS_HOSTNAME' });
  });
});
