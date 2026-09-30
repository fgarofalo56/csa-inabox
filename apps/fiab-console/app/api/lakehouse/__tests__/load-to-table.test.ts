/**
 * Contract tests for POST /api/lakehouse/load-to-table.
 *
 * Item scope: the lakehouse item is authorized with edit rights, the source
 * file must sit inside the item root and container, and the Delta table is
 * written under `<root>/Tables/`. Refusals read the CALL ROW SET of
 * `submitLivyBatch`, each paired with the positive arm on the same fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

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
/** Written out here rather than imported, so a change to the helper cannot also change the expectation. */
const itemDb = (id: string) => `lh_${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12)}_dbo`;

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

  it('registers the table in the lakehouse item own Spark database', async () => {
    const res = await POST(bodyReq(base));
    const j = await res.json();
    expect(res.status).toBe(200);
    const db = itemDb(LH);
    // Breaks if the bare table name is registered, or the database is not derived from the item id.
    expect(j.job.sparkTable).toBe(`${db}.sales`);
    const code = submittedCode()!;
    expect(code).toContain(`.saveAsTable("${db}.sales")`);
    expect(code).toContain('CREATE DATABASE IF NOT EXISTS `' + db + '`');
    expect(code).not.toContain('.saveAsTable("sales")');
  });

  it('two lakehouses loading the same table name register it in different databases', async () => {
    await POST(bodyReq(base));
    (resolveItemAccessByOid as any).mockResolvedValue({ ...access(true), item: { id: 'lh-two', workspaceId: 'ws-1', itemType: 'lakehouse' } });
    (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@${HOST}/lakehouses/Two--lh-two`, container: CONTAINER, root: 'lakehouses/Two--lh-two' });
    await POST(bodyReq({ ...base, lakehouseId: 'lh-two', path: 'lakehouses/Two--lh-two/Files/sales.csv' }));
    const codes = (submitLivyBatch as any).mock.calls.map((c: any[]) => c[0].code as string);
    expect(codes).toHaveLength(2);
    // Breaks if both loads register the same name; the two databases differ by construction.
    expect(itemDb(LH)).not.toBe(itemDb('lh-two'));
    expect(codes[0]).toContain(`.saveAsTable("${itemDb(LH)}.sales")`);
    expect(codes[1]).toContain(`.saveAsTable("${itemDb('lh-two')}.sales")`);
  });

  it('requires lakehouseId (400; nothing submitted)', async () => {
    const { lakehouseId: _omit, ...rest } = base;
    const res = await POST(bodyReq(rest));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_request');
    expect(submitLivyBatch).not.toHaveBeenCalled();
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('requires edit rights on the lakehouse item (403 for a read-only role)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await POST(bodyReq(base));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('read_only');
    expect(j.remediation).toMatch(/Edit/);
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(bodyReq(base));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('item_not_found');
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['a sibling root sharing the prefix', { path: `${ROOT}-archive/Files/sales.csv` }, 403, 'outside_item_root'],
    ['another lakehouse root', { path: 'lakehouses/Other--lh-x/Files/sales.csv' }, 403, 'outside_item_root'],
    ['another container', { container: 'gold' }, 403, 'outside_item_root'],
    ['a dot-dot segment', { path: `${ROOT}/../Other--lh-x/sales.csv` }, 400, 'bad_request'],
    ['an absolute path', { path: `/${INSIDE}` }, 400, 'bad_request'],
  ])('confines the source to the item root: %s', async (_label, over, status, code) => {
    const res = await POST(bodyReq({ ...base, ...over }));
    expect(res.status).toBe(status);
    const j = await res.json();
    expect(j.code).toBe(code);
    expect(typeof j.remediation).toBe('string');
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });

  it('409 when the item has no storage binding', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    const res = await POST(bodyReq(base));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_storage_binding');
    expect(submitLivyBatch).not.toHaveBeenCalled();
  });
});
