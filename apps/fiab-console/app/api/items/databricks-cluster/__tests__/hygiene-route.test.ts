/**
 * BFF contract tests for /api/items/databricks-cluster/hygiene. Per no-vaporware
 * these exercise the real route handlers with a mocked databricks-client (real
 * REST replaced; the enrichment + bulk-dispatch logic is real). They pin:
 *   - 401 when unauthenticated
 *   - honest gate (200 + gate) when Databricks env is unset
 *   - GET enriches every cluster + counts stale ones
 *   - POST validates action + applies each id independently (partial failure ok)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mutable state + spies live in vi.hoisted so the hoisted vi.mock factories can
// safely reference them (vitest hoists vi.mock above module-body declarations).
const h = vi.hoisted(() => ({
  authed: true,
  gateValue: null as { missing: string } | null,
  listClusters: vi.fn(async () => [] as any[]),
  terminateCluster: vi.fn(async (_id: string) => {}),
  permanentDeleteCluster: vi.fn(async (_id: string) => {}),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: () => (h.authed ? ({ claims: { oid: 'o' }, exp: Date.now() / 1000 + 3600 } as any) : null),
}));

vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () => h.gateValue,
  listClusters: (...a: any[]) => (h.listClusters as any)(...a),
  terminateCluster: (...a: any[]) => (h.terminateCluster as any)(...a),
  permanentDeleteCluster: (...a: any[]) => (h.permanentDeleteCluster as any)(...a),
}));

import { GET, POST } from '../hygiene/route';

const { listClusters, terminateCluster, permanentDeleteCluster } = h;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  h.authed = true;
  h.gateValue = null;
  listClusters.mockReset().mockResolvedValue([]);
  terminateCluster.mockReset().mockResolvedValue(undefined);
  permanentDeleteCluster.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

function post(body: unknown): NextRequest {
  return new NextRequest(new Request('http://localhost/api/items/databricks-cluster/hygiene', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('GET /hygiene', () => {
  it('401 when unauthenticated', async () => {
    h.authed = false;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns an honest gate (200) when Databricks env is unset', async () => {
    h.gateValue = { missing: 'LOOM_DATABRICKS_HOSTNAME' };
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.gate).toContain('LOOM_DATABRICKS');
    expect(listClusters).not.toHaveBeenCalled();
  });

  it('enriches every cluster and counts stale ones', async () => {
    listClusters.mockResolvedValue([
      { cluster_id: 'fresh', state: 'RUNNING', cluster_source: 'UI', last_activity_time: Date.now() },
      { cluster_id: 'stale', state: 'TERMINATED', cluster_source: 'UI', terminated_time: Date.now() - 30 * DAY },
      { cluster_id: 'job', state: 'TERMINATED', cluster_source: 'JOB', terminated_time: Date.now() - 90 * DAY },
    ]);
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rows).toHaveLength(3);
    expect(j.staleCount).toBe(1); // only the UI TERMINATED one; the JOB one is ephemeral
    const stale = j.rows.find((r: any) => r.cluster_id === 'stale');
    expect(stale.stale).toBe(true);
    expect(stale.allPurpose).toBe(true);
  });
});

describe('POST /hygiene', () => {
  it('rejects an unknown action', async () => {
    const res = await POST(post({ action: 'nuke', clusterIds: ['a'] }));
    expect(res.status).toBe(400);
  });

  it('rejects an empty clusterIds list', async () => {
    const res = await POST(post({ action: 'terminate', clusterIds: [] }));
    expect(res.status).toBe(400);
  });

  it('bulk-terminates each selected cluster', async () => {
    const res = await POST(post({ action: 'terminate', clusterIds: ['a', 'b'] }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(terminateCluster).toHaveBeenCalledTimes(2);
    expect(permanentDeleteCluster).not.toHaveBeenCalled();
    expect(j.results.map((r: any) => r.cluster_id)).toEqual(['a', 'b']);
  });

  it('bulk-deletes (permanent) and reports partial failure without aborting', async () => {
    permanentDeleteCluster.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('PERMISSION_DENIED');
    });
    const res = await POST(post({ action: 'delete', clusterIds: ['ok', 'bad'] }));
    const j = await res.json();
    expect(j.ok).toBe(false); // not all succeeded
    expect(permanentDeleteCluster).toHaveBeenCalledTimes(2);
    const bad = j.results.find((r: any) => r.cluster_id === 'bad');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('PERMISSION_DENIED');
    const good = j.results.find((r: any) => r.cluster_id === 'ok');
    expect(good.ok).toBe(true);
  });
});
