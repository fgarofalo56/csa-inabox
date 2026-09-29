/**
 * Contract tests for GET /api/lakehouse/table-stats (Spark column summary via
 * Livy).
 *
 * Item scope: every call needs read access to the lakehouse item. The kick-off
 * confines the file to the item root; the `jobId` is a signed handle bound to
 * the item, this route, the principal, the Spark session and the scoped path,
 * and a poll reads the path from the handle. Refusals read the Livy CALL ROW
 * SET, paired with a positive arm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.SESSION_SECRET = 'unit-test-session-secret-for-lakehouse-job-handles';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-artifacts-client', () => ({ synapseConfigGate: vi.fn(() => null) }));
vi.mock('@/lib/azure/adls-client', () => ({
  KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
  pathToHttpsUrl: vi.fn((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  createLivySessionAsync: vi.fn(),
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
}));
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    listLakehouseRootFacts: vi.fn(async () => []),
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET } from '../table-stats/route';
import { getSession } from '@/lib/auth/session';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { pathToHttpsUrl } from '@/lib/azure/adls-client';
import {
  createLivySessionAsync, getLivySession, submitLivyStatement, getLivyStatement,
} from '@/lib/azure/synapse-dev-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { mintLakehouseJobHandle, verifyLakehouseJobHandle } from '../_lib/job-handle';

const LH = 'lh-ts';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-ts';
const INSIDE = `${ROOT}/Tables/orders`;
const SCOPE = { lakehouseId: LH, purpose: 'table-stats' as const, oid: 'o1' };

const req = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/table-stats?${qs}`) } as any);
function access() {
  return { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: 'Viewer', via: 'workspace', canWrite: false };
}
/** The abfss path the stats statement loads, read out of the submitted code. */
function submittedPath(): string | null {
  const call = (submitLivyStatement as any).mock.calls[0];
  if (!call) return null;
  const m = String(call[2]?.code || '').match(/^_path = "([^"]*)"$/m);
  return m ? m[1] : null;
}

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'o1', upn: 'u@x' } });
  (synapseConfigGate as any).mockReturnValue(null);
  (pathToHttpsUrl as any).mockImplementation((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`);
  (resolveItemAccessByOid as any).mockResolvedValue(access());
  (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT });
  (createLivySessionAsync as any).mockResolvedValue({ id: 9, state: 'starting' });
  (getLivySession as any).mockResolvedValue({ id: 9, state: 'idle' });
  (submitLivyStatement as any).mockResolvedValue({ id: 4 });
  (getLivyStatement as any).mockResolvedValue({ state: 'running' });
});

describe('table-stats — kick-off', () => {
  it('runs stats on a file inside the item root and returns a signed handle (read access is enough)', async () => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toEqual({
      pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE,
    });
  });

  it('requires lakehouseId (400; no Spark session)', async () => {
    const res = await GET(req(`container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(400);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; no Spark session)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(404);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['another lakehouse root', 'lakehouses/Other--lh-x/Tables/orders', 403],
    ['a dot-dot segment', `${ROOT}/../Other--lh-x/t`, 400],
  ])('confines the file to the item root: %s', async (_label, path, status) => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(path)}`));
    expect(res.status).toBe(status);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('400 for a pool name that is not a Spark pool name', async () => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}&pool=${encodeURIComponent('../x')}`));
    expect(res.status).toBe(400);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });
});

describe('table-stats — poll', () => {
  it('404 for a raw "<pool>:<session>:<stmt>" job id; nothing read from Livy', async () => {
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent('loompool:9:4')}`));
    expect(res.status).toBe(404);
    expect(getLivyStatement).not.toHaveBeenCalled();
  });

  it('polls the statement a handle names (positive arm)', async () => {
    const jobId = mintLakehouseJobHandle(SCOPE, { pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(200);
    expect((getLivyStatement as any).mock.calls).toEqual([['loompool', 9, 4]]);
  });

  it('refuses a handle minted for another lakehouse item (404)', async () => {
    const jobId = mintLakehouseJobHandle({ ...SCOPE, lakehouseId: 'lh-other' }, { pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(404);
    expect(getLivyStatement).not.toHaveBeenCalled();
  });

  it('refuses a transform-preview handle for the same item (404)', async () => {
    const jobId = mintLakehouseJobHandle({ ...SCOPE, purpose: 'transform-preview' }, { pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(404);
  });

  it('requires access to the lakehouse item on every poll (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const jobId = mintLakehouseJobHandle(SCOPE, { pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(404);
    expect(getLivyStatement).not.toHaveBeenCalled();
  });

  it('submits a warming job over the handle path, ignoring query container/path', async () => {
    const jobId = mintLakehouseJobHandle(SCOPE, { pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}&container=gold&path=${encodeURIComponent('lakehouses/Other--lh-x/t')}`));
    const j = await res.json();
    expect(res.status).toBe(200);
    // Breaks if the warm branch reads the query's container/path.
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${INSIDE}`);
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)?.stmtId).toBe(4);
  });
});
