/**
 * Contract tests for GET /api/lakehouse/preview.
 *
 *   ITEM FORM (`lakehouseId`)  — read access to the item; path inside its root.
 *   REFERENCE FORM (`refId`)   — read access to the referenced item; path inside
 *                                its root; its storage account from the item.
 *   STORAGE FORM (neither)     — tenant admin only.
 *
 * Refusals read the `executeQuery` CALL ROW SET, paired with a positive arm.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return {
    ...actual,
    pathToHttpsUrl: vi.fn((c: string, p: string) => `https://primary.dfs.core.windows.net/${c}/${p}`),
    pathToHttpsUrlFor: vi.fn((a: string, c: string, p: string) => `https://${a}.dfs.core.windows.net/${c}/${p}`),
  };
});
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(),
  serverlessTarget: vi.fn(() => ({ server: 's', database: 'master' })),
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

import { GET } from '../preview/route';
import { getSession } from '@/lib/auth/session';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const ADMIN_OID = 'oid-admin';
const LH = 'lh-pv';
const REF = 'lh-ref';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-pv';
const REF_ROOT = 'lakehouses/AgencyB--lh-ref';
const INSIDE = `${ROOT}/Files/a.parquet`;
const REF_INSIDE = `${REF_ROOT}/Files/b.parquet`;

const req = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/preview?${qs}`) } as any);
const queried = (): string[] => (executeQuery as any).mock.calls.map((c: any[]) => c[1]);

function access(id: string, state: Record<string, unknown> = {}) {
  return { item: { id, workspaceId: 'ws-1', itemType: 'lakehouse', state }, role: 'Viewer', via: 'workspace', canWrite: false };
}

let savedAdmin: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedAdmin = process.env.LOOM_TENANT_ADMIN_OID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  (getSession as any).mockReturnValue({ claims: { oid: 'oid-member', upn: 'm@x' } });
  (resolveItemAccessByOid as any).mockImplementation(async (_s: any, id: string) => access(id, id === REF ? { storageAccount: 'stateacct' } : {}));
  (resolveLakehouseAbfss as any).mockImplementation(async (id: string) => (id === REF
    ? { abfss: `abfss://${CONTAINER}@extacct.dfs.core.windows.net/${REF_ROOT}`, container: CONTAINER, root: REF_ROOT }
    : { abfss: `abfss://${CONTAINER}@primary.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT }));
  (executeQuery as any).mockResolvedValue({ columns: [{ name: 'a' }], rows: [[1]], rowCount: 1 });
});

afterEach(() => {
  if (savedAdmin === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdmin;
});

describe('preview — item form', () => {
  it('previews a file inside the item root (read access is enough)', async () => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(200);
    expect(queried()).toHaveLength(1);
    expect(queried()[0]).toContain(`https://primary.dfs.core.windows.net/${CONTAINER}/${INSIDE}`);
  });

  it('previews on the item\'s bound storage account, not the deployment default', async () => {
    (resolveLakehouseAbfss as any).mockImplementation(async () => (
      { abfss: `abfss://${CONTAINER}@extacct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT }));
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(200);
    // Breaks if the item form drops the bound account and reads the primary
    // account (`primary`, what pathToHttpsUrl answers).
    expect(queried()[0]).toContain(`https://extacct.dfs.core.windows.net/${CONTAINER}/${INSIDE}`);
    expect(queried()[0]).not.toContain('primary.dfs');
  });

  it('requires access to the lakehouse item (404; nothing queried)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(404);
    expect(queried()).toEqual([]);
  });

  it.each([
    ['another lakehouse root', 'lakehouses/Other--lh-x/Files/a.parquet', 403],
    ['a sibling root sharing the prefix', `${ROOT}-archive/Files/a.parquet`, 403],
    ['a dot-dot segment', `${ROOT}/../Other--lh-x/a.parquet`, 400],
  ])('confines the path to the item root: %s', async (_label, path, status) => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(path)}`));
    expect(res.status).toBe(status);
    // Breaks if the item-form refusal loses its code (scopeItemPath instead of scopeItem).
    expect((await res.json()).code).toBe(status === 400 ? 'bad_request' : 'outside_item_root');
    expect(queried()).toEqual([]);
  });
});

describe('preview — a percent sign in the path', () => {
  // The BULK URL is the path as-is, and a reader that decodes it once would
  // turn these segments into '/..' or '..'. Each is inside the root as a raw
  // string, so the root check alone passes it; what the test names is the
  // decoded path.
  const decodedLeavesRoot = (p: string) => {
    const segs: string[] = [];
    for (const s of decodeURIComponent(p).split('/')) {
      if (s === '..') segs.pop(); else if (s !== '.' && s !== '') segs.push(s);
    }
    return !segs.join('/').startsWith(`${ROOT}/`);
  };
  const CASES: Array<[string, string]> = [
    ['an encoded dot-dot segment', `${ROOT}/%2e%2e/Other--lh-x/a.parquet`],
    ['an encoded slash with dot-dots', `${ROOT}/Files%2F..%2F..%2FOther--lh-x/a.parquet`],
  ];

  it.each(CASES)('fixture witness: %s decodes to a path outside the item root', (_l, p) => {
    // Breaks if the fixture stops decoding outside the root; the refusal test
    // below would then prove nothing about the decoded path.
    expect([p.startsWith(`${ROOT}/`), decodedLeavesRoot(p)]).toEqual([true, true]);
  });

  it.each(CASES)('item form: %s is refused (400, nothing queried)', async (_l, p) => {
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(p)}`));
    // Breaks if the '%' refusal is removed: the route answers 200 and queries a
    // BULK URL whose decoded path leaves the root.
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_request');
    expect(queried()).toEqual([]);
  });

  it('reference form: an encoded dot-dot segment is refused (400, nothing queried)', async () => {
    const p = `${REF_ROOT}/%2e%2e/Other--lh-x/b.parquet`;
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&path=${encodeURIComponent(p)}`));
    // Breaks if the refusal sits inside the item-form branch only.
    expect(res.status).toBe(400);
    expect(queried()).toEqual([]);
  });

  it('a path without a percent sign still previews, and its decoded path stays in the root (positive arm)', async () => {
    const p = `${ROOT}/Files/a b.parquet`;
    const res = await GET(req(`lakehouseId=${LH}&container=${CONTAINER}&path=${encodeURIComponent(p)}`));
    expect(res.status).toBe(200);
    // Breaks if the refusal is widened to any non-alphanumeric character.
    expect(queried()[0]).toContain(`https://primary.dfs.core.windows.net/${CONTAINER}/${p}`);
    expect(decodedLeavesRoot(p)).toBe(false);
  });
});

describe('preview — reference form', () => {
  it('previews a file inside the referenced item root, on its own storage account', async () => {
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&path=${encodeURIComponent(REF_INSIDE)}`));
    expect(res.status).toBe(200);
    // The binding host (extacct) and state.storageAccount (stateacct) differ on purpose.
    // Breaks if the account is taken from the request, from item state, or the primary account is used.
    expect(queried()[0]).toContain(`https://extacct.dfs.core.windows.net/${CONTAINER}/${REF_INSIDE}`);
    expect(queried()[0]).not.toContain('stateacct');
  });

  it('requires access to the referenced lakehouse item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&path=${encodeURIComponent(REF_INSIDE)}`));
    expect(res.status).toBe(404);
    expect(queried()).toEqual([]);
  });

  it('confines the path to the referenced item root (403 for the primary root)', async () => {
    const res = await GET(req(`refId=${REF}&container=${CONTAINER}&path=${encodeURIComponent(INSIDE)}`));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('outside_item_root');
    expect(typeof j.remediation).toBe('string');
    expect(queried()).toEqual([]);
  });

  it('refuses another container in the reference form (403; preview does not list empty)', async () => {
    const res = await GET(req(`refId=${REF}&container=gold&path=${encodeURIComponent(REF_INSIDE)}`));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('outside_item_root');
    expect(queried()).toEqual([]);
  });

  it('refuses an account parameter outside the reference form (400)', async () => {
    const res = await GET(req(`container=${CONTAINER}&path=a.parquet&account=extacct`));
    expect(res.status).toBe(400);
    expect(queried()).toEqual([]);
  });
});

describe('preview — storage form', () => {
  it('requires tenant-admin (403 for a member; nothing queried)', async () => {
    const res = await GET(req(`container=${CONTAINER}&path=staging/a.parquet`));
    expect(res.status).toBe(403);
    expect(queried()).toEqual([]);
  });

  it('a tenant admin can name a container path directly (positive arm)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: ADMIN_OID, upn: 'a@x' } });
    const res = await GET(req(`container=${CONTAINER}&path=staging/a.parquet`));
    expect(res.status).toBe(200);
    expect(queried()[0]).toContain(`https://primary.dfs.core.windows.net/${CONTAINER}/staging/a.parquet`);
  });
});
