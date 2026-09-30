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
// `pathToHttpsUrlFor` is the real shape (`dfsUrl(account)/container/path`) over
// the REAL cloud-endpoints `dfsUrl`. A plain function, not a vi.fn, so
// `vi.resetAllMocks()` cannot strip it.
vi.mock('@/lib/azure/adls-client', async () => {
  const ce: any = await vi.importActual('@/lib/azure/cloud-endpoints');
  return {
    KNOWN_CONTAINERS: ['bronze', 'silver', 'gold', 'landing'],
    pathToHttpsUrl: vi.fn((c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`),
    pathToHttpsUrlFor: (a: string, c: string, p: string) => `${ce.dfsUrl(a)}/${c}/${p.replace(/^\/+/, '')}`,
  };
});
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
    lakehouseStorageWithheldFields: actual.lakehouseStorageWithheldFields,
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
/** The submitted stats code, split into lines. */
function submittedLines(): string[] {
  const call = (submitLivyStatement as any).mock.calls[0];
  return call ? String(call[2]?.code || '').split('\n') : [];
}
/** The abfss path the stats statement loads: the `_path = <string literal>` line, decoded. */
function submittedPath(): string | null {
  const line = submittedLines().find((l) => l.startsWith('_path = '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('_path = '.length));
  } catch {
    return null;
  }
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
      pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE, account: 'acct',
    });
  });

  it('loads from the item\'s bound storage account, not the deployment default', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://${CONTAINER}@extacct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT,
    });
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    const j = await res.json();
    expect(res.status).toBe(200);
    // Breaks if the URI is built from the primary account (`acct`, what
    // pathToHttpsUrl answers) or the handle drops the bound account.
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@extacct.dfs.core.windows.net/${INSIDE}`);
    expect(verifyLakehouseJobHandle(SCOPE, j.jobId)).toMatchObject({ account: 'extacct' });
    expect(pathToHttpsUrl).not.toHaveBeenCalled();
  });

  it('400 for a path holding a Spark glob character; no Spark session', async () => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(`${ROOT}/Files/{a,b}.csv`)}`));
    const j = await res.json();
    // Breaks if the route builds the URI without sparkAbfssFor (the brace
    // reaches Spark and the session is created).
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    expect(j.error).toMatch(/wildcard/);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('requires lakehouseId (400 bad_request; no Spark session)', async () => {
    const res = await GET(req(`container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    const j = await res.json();
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404 item_not_found; no Spark session)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect([res.status, (await res.json()).code]).toEqual([404, 'item_not_found']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['another lakehouse root', 'lakehouses/Other--lh-x/Tables/orders', 403, 'outside_item_root'],
    ['a dot-dot segment', `${ROOT}/../Other--lh-x/t`, 400, 'bad_request'],
  ])('confines the file to the item root: %s', async (_label, path, status, code) => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(path)}`));
    expect([res.status, (await res.json()).code]).toEqual([status, code]);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('400 for a pool name that is not a Spark pool name', async () => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}&pool=${encodeURIComponent('../x')}`));
    const j = await res.json();
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });
});

describe('table-stats — poll', () => {
  it('404 for a raw "<pool>:<session>:<stmt>" job id; nothing read from Livy', async () => {
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent('loompool:9:4')}`));
    const j = await res.json();
    // Breaks if the unknown-job refusal loses its code (it is a 404 like item_not_found).
    expect([res.status, j.code, typeof j.remediation]).toEqual([404, 'job_not_found', 'string']);
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
    expect([res.status, (await res.json()).code]).toEqual([404, 'job_not_found']);
    expect(getLivyStatement).not.toHaveBeenCalled();
  });

  it('refuses a transform-preview handle for the same item (404)', async () => {
    const jobId = mintLakehouseJobHandle({ ...SCOPE, purpose: 'transform-preview' }, { pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(404);
  });

  it('requires access to the lakehouse item on every poll (404 item_not_found)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const jobId = mintLakehouseJobHandle(SCOPE, { pool: 'loompool', sessionId: 9, stmtId: 4, container: CONTAINER, path: INSIDE });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect([res.status, (await res.json()).code]).toEqual([404, 'item_not_found']);
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

  it('submits a warming job against the bound account carried on the handle', async () => {
    const jobId = mintLakehouseJobHandle(SCOPE, {
      pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: INSIDE, account: 'extacct',
    });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(200);
    // Breaks if the poll ignores the handle's account and falls back to the
    // deployment's primary account (`acct`).
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@extacct.dfs.core.windows.net/${INSIDE}`);
  });

  // A line break in a handle path never reaches the statement: `sparkAbfssFor`
  // cannot turn that URL into an abfss URI and answers 503. (The kick-off
  // refuses control characters earlier, in `pathSegments`, so only a handle can
  // carry one.) FAILS IF the route falls back to the raw https URL when the
  // abfss rewrite does not match, as the earlier `abfssFor` did.
  it('refuses a handle path with a line break (503); nothing submitted', async () => {
    const jobId = mintLakehouseJobHandle(SCOPE, {
      pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: `${ROOT}/Tables/x\nprint(1)`,
    });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect([res.status, (await res.json()).code]).toEqual([503, 'not_configured']);
    expect(submitLivyStatement).not.toHaveBeenCalled();
  });

  // Generated code renders the path as a quoted literal. The handle path holds
  // a quote, a tab and a vertical tab. FAILS IF `_path` is written as
  // `"<path>"` with only quotes and backslashes escaped: the tab and vertical
  // tab then sit raw inside the literal.
  it('writes a handle path with a quote and control characters as one escaped _path literal', async () => {
    const odd = `${ROOT}/Tables/x"\tprint(1)\u000b#`;
    const jobId = mintLakehouseJobHandle(SCOPE, { pool: 'loompool', sessionId: 9, stmtId: null, container: CONTAINER, path: odd });
    const res = await GET(req(`lakehouseId=${LH}&jobId=${encodeURIComponent(jobId)}`));
    expect(res.status).toBe(200);
    const line = submittedLines().find((l) => l.startsWith('_path = ')) ?? '';
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    // Positive: the one `_path` line decodes back to exactly the handle path.
    expect(submittedPath()).toBe(`abfss://${CONTAINER}@acct.dfs.core.windows.net/${odd}`);
  });
});
