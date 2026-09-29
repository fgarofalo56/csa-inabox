/**
 * Contract tests for POST /api/lakehouse/load-to-table.
 *
 * Item scope: the lakehouse item is authorized with edit rights, the source
 * file must sit inside the item root and container, and the Delta table is
 * written under `<root>/Tables/`. Refusals read the CALL ROW SET of
 * `submitLivyBatch`, each paired with the positive arm on the same fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  listSparkPools: vi.fn(),
  submitLivyBatch: vi.fn(),
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

import { POST } from '../load-to-table/route';
import { getSession } from '@/lib/auth/session';
import { listSparkPools, submitLivyBatch, getLivyStatement } from '@/lib/azure/synapse-dev-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const LH = 'lh-ltt';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-ltt';
const INSIDE = `${ROOT}/Files/sales.csv`;
const HOST = 'loomacct.dfs.core.windows.net';

const bodyReq = (body: any) => ({ json: async () => body } as any);
const base = { lakehouseId: LH, container: CONTAINER, path: INSIDE, tableName: 'sales', poolName: 'loompool' };
function access(canWrite = true) {
  return { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}
const submittedCode = (): string | null => (submitLivyBatch as any).mock.calls[0]?.[0]?.code ?? null;

let savedWs: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedWs = process.env.LOOM_SYNAPSE_WORKSPACE;
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn';
  (getSession as any).mockReturnValue({ claims: { oid: 'o1', upn: 'u@x' } });
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@${HOST}/${ROOT}`, container: CONTAINER, root: ROOT });
  (listSparkPools as any).mockResolvedValue([{ name: 'loompool' }]);
  (submitLivyBatch as any).mockResolvedValue({ id: '7.0', state: 'running' });
  (getLivyStatement as any).mockResolvedValue({ state: 'available', output: { status: 'ok', data: { 'text/plain': 'LOOM_LOAD_RESULT rows=5 table=sales' } } });
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.LOOM_SYNAPSE_WORKSPACE;
  else process.env.LOOM_SYNAPSE_WORKSPACE = savedWs;
});

describe('POST /api/lakehouse/load-to-table', () => {
  it('reads the source inside the item root and writes the table under <root>/Tables/ (positive arm)', async () => {
    const res = await POST(bodyReq(base));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.job.rowCount).toBe(5);
    const code = submittedCode()!;
    expect(code).toContain(`abfss://${CONTAINER}@${HOST}/${INSIDE}`);
    // Breaks if the table lands at the container top level instead of the item root.
    expect(code).toContain(`.option("path", "abfss://${CONTAINER}@${HOST}/${ROOT}/Tables/sales")`);
  });

  it('requires lakehouseId (400; nothing submitted)', async () => {
    const { lakehouseId: _omit, ...rest } = base;
    const res = await POST(bodyReq(rest));
    expect(res.status).toBe(400);
    expect(submitLivyBatch).not.toHaveBeenCalled();
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('requires edit rights on the lakehouse item (403 for a read-only role)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await POST(bodyReq(base));
    expect(res.status).toBe(403);
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(bodyReq(base));
    expect(res.status).toBe(404);
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['a sibling root sharing the prefix', { path: `${ROOT}-archive/Files/sales.csv` }, 403],
    ['another lakehouse root', { path: 'lakehouses/Other--lh-x/Files/sales.csv' }, 403],
    ['another container', { container: 'gold' }, 403],
    ['a dot-dot segment', { path: `${ROOT}/../Other--lh-x/sales.csv` }, 400],
    ['an absolute path', { path: `/${INSIDE}` }, 400],
  ])('confines the source to the item root: %s', async (_label, over, status) => {
    const res = await POST(bodyReq({ ...base, ...over }));
    expect(res.status).toBe(status);
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });

  it('409 when the item has no storage binding', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    const res = await POST(bodyReq(base));
    expect(res.status).toBe(409);
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });
});
