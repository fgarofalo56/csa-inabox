/**
 * Contract tests for POST /api/lakehouse/upload.
 *
 *   ITEM FORM (`lakehouseId`)  — edit rights on the lakehouse; the file must sit
 *                                strictly below the item's own root.
 *   REPORT FORM (`reportId`)   — edit rights on the report (or the semantic model /
 *                                paginated report named by `reportItemType`); the file must be
 *                                landing/report-uploads/<reportId>/<file name>.
 *   STORAGE FORM (neither)     — tenant admin only.
 *
 * Every refusal reads the `uploadFile` CALL ROW SET, and each form carries a
 * positive arm, so "nothing was written" cannot be satisfied by a route that
 * never writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, uploadFile: vi.fn() };
});
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

import { POST } from '../upload/route';
import { getSession } from '@/lib/auth/session';
import { uploadFile } from '@/lib/azure/adls-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const ADMIN_OID = 'oid-admin';
const admin = { claims: { oid: ADMIN_OID, upn: 'admin@x' } };
const member = { claims: { oid: 'oid-member', upn: 'member@x' } };

const LH = 'lh-up';
const REPORT = 'rep-1';
const CONTAINER = 'landing';
const ROOT = 'lakehouses/Sales--lh-up';
const INSIDE = `${ROOT}/Files/a.csv`;

function req(fields: Record<string, string>, withFile = true) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (withFile) fd.set('file', new File([new Uint8Array([1, 2, 3])], 'a.csv', { type: 'text/csv' }));
  return { formData: async () => fd } as any;
}
function access(itemType: string, id: string, canWrite = true) {
  return { item: { id, workspaceId: 'ws-1', itemType }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}
const uploads = () => (uploadFile as any).mock.calls.map((c: any[]) => [c[0], c[1]]);

let savedAdmin: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedAdmin = process.env.LOOM_TENANT_ADMIN_OID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  (getSession as any).mockReturnValue(member);
  (resolveItemAccessByOid as any).mockImplementation(async (_s: any, id: string, type: string) => access(type, id, true));
  (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT });
  (uploadFile as any).mockResolvedValue({ size: 3, etag: 'e' });
});

afterEach(() => {
  if (savedAdmin === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdmin;
});

describe('upload — item form (lakehouseId)', () => {
  it('uploads a file inside the item root (positive arm)', async () => {
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER, path: INSIDE }));
    expect(res.status).toBe(201);
    expect(uploads()).toEqual([[CONTAINER, INSIDE]]);
  });

  it('writes to the item\'s bound storage account and reports its abfss path', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@extacct.dfs.core.windows.net/${ROOT}`, container: CONTAINER, root: ROOT });
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER, path: INSIDE }));
    expect(res.status).toBe(201);
    // Breaks if the account is not passed to uploadFile (the write lands on
    // the container's configured account) or the reported path names another account.
    expect((uploadFile as any).mock.calls[0][4]).toBe('extacct');
    expect((await res.json()).abfssPath).toBe(`abfss://${CONTAINER}@extacct.dfs.core.windows.net/${INSIDE}`);
  });

  it('requires edit rights on the lakehouse item (403 for a read-only role; nothing written)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access('lakehouse', LH, false));
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER, path: INSIDE }));
    expect(res.status).toBe(403);
    expect(uploads()).toEqual([]);
  });

  it('requires access to the lakehouse item (404; nothing written)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER, path: INSIDE }));
    expect(res.status).toBe(404);
    expect(uploads()).toEqual([]);
  });

  it.each([
    ['a sibling root sharing the prefix', `${ROOT}-archive/Files/a.csv`, 403],
    ['another lakehouse root', 'lakehouses/Other--lh-x/Files/a.csv', 403],
    ['the container top level', 'a.csv', 403],
    ['a dot-dot segment', `${ROOT}/../Other--lh-x/a.csv`, 400],
    ['an absolute path', `/${INSIDE}`, 400],
  ])('confines the target to the item root: %s', async (_label, path, status) => {
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER, path }));
    expect(res.status).toBe(status);
    expect(uploads()).toEqual([]);
  });

  it('confines the target to the item container (403 for another container)', async () => {
    const res = await POST(req({ lakehouseId: LH, container: 'gold', path: INSIDE }));
    expect(res.status).toBe(403);
    expect(uploads()).toEqual([]);
  });
});

describe('upload — report form (reportId)', () => {
  const target = `report-uploads/${REPORT}/a.csv`;

  it('uploads to the report folder after authorizing the report item (positive arm)', async () => {
    const res = await POST(req({ reportId: REPORT, container: CONTAINER, path: target }));
    expect(res.status).toBe(201);
    expect(uploads()).toEqual([[CONTAINER, target]]);
    // The report form carries no bound account: the write uses the container's
    // configured account. Breaks if an account is invented for this form.
    expect((uploadFile as any).mock.calls[0]).toHaveLength(5);
    expect((uploadFile as any).mock.calls[0][4]).toBeUndefined();
    // Breaks if the route authorizes some other item type.
    expect((resolveItemAccessByOid as any).mock.calls.map((c: any[]) => [c[1], c[2]])).toEqual([[REPORT, 'report']]);
  });

  it.each([
    ['another report folder', 'report-uploads/rep-2/a.csv', CONTAINER],
    ['a nested path in the folder', `report-uploads/${REPORT}/x/a.csv`, CONTAINER],
    ['a path outside report-uploads', `lakehouses/Sales--lh-up/Files/a.csv`, CONTAINER],
    ['another container', target, 'gold'],
  ])('403 for %s; nothing written', async (_label, path, container) => {
    const res = await POST(req({ reportId: REPORT, container, path }));
    expect(res.status).toBe(403);
    expect(uploads()).toEqual([]);
  });

  it('requires edit rights on the report (403 for a read-only role)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access('report', REPORT, false));
    const res = await POST(req({ reportId: REPORT, container: CONTAINER, path: target }));
    expect(res.status).toBe(403);
    expect(uploads()).toEqual([]);
  });

  it('requires access to the report item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(req({ reportId: REPORT, container: CONTAINER, path: target }));
    expect(res.status).toBe(404);
    expect(uploads()).toEqual([]);
  });

  it('400 for a dot-dot segment', async () => {
    const res = await POST(req({ reportId: REPORT, container: CONTAINER, path: `report-uploads/${REPORT}/../rep-2/a.csv` }));
    expect(res.status).toBe(400);
    expect(uploads()).toEqual([]);
  });

  it.each([
    ['semantic-model', 'sm-1'],
    ['paginated-report', 'pr-1'],
  ])('uploads for a %s host after authorizing that item with its own type', async (itemType, id) => {
    const path = `report-uploads/${id}/a.csv`;
    const res = await POST(req({ reportId: id, reportItemType: itemType, container: CONTAINER, path }));
    expect(res.status).toBe(201);
    expect(uploads()).toEqual([[CONTAINER, path]]);
    // Breaks if the route ignores reportItemType and looks the id up as a report.
    expect((resolveItemAccessByOid as any).mock.calls.map((c: any[]) => [c[1], c[2]])).toEqual([[id, itemType]]);
  });

  it('requires edit rights on a semantic-model host (403 read_only; nothing written)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access('semantic-model', 'sm-1', false));
    const res = await POST(req({ reportId: 'sm-1', reportItemType: 'semantic-model', container: CONTAINER, path: 'report-uploads/sm-1/a.csv' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('read_only');
    expect(j.error).toContain('semantic model');
    expect(uploads()).toEqual([]);
  });

  it('refuses an item type that does not host the gallery (400; no lookup, nothing written)', async () => {
    const res = await POST(req({ reportId: 'lh-x', reportItemType: 'lakehouse', container: CONTAINER, path: 'report-uploads/lh-x/a.csv' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_request');
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(uploads()).toEqual([]);
  });

  it.each([
    ['outside the folder', { path: 'report-uploads/rep-2/a.csv' }, 403, 'outside_upload_folder'],
    ['a read-only role', { readOnly: true }, 403, 'read_only'],
    ['no access to the item', { missing: true }, 404, 'item_not_found'],
  ])('report-form refusal carries code and remediation: %s', async (_label, over: any, status, code) => {
    if (over.readOnly) (resolveItemAccessByOid as any).mockResolvedValue(access('report', REPORT, false));
    if (over.missing) (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(req({ reportId: REPORT, container: CONTAINER, path: over.path ?? target }));
    expect(res.status).toBe(status);
    const j = await res.json();
    expect(j.code).toBe(code);
    expect(typeof j.remediation).toBe('string');
    expect(uploads()).toEqual([]);
  });
});

describe('upload — storage form (no item)', () => {
  it('requires tenant-admin (403 for a member; nothing written)', async () => {
    const res = await POST(req({ container: CONTAINER, path: 'a.csv' }));
    expect(res.status).toBe(403);
    expect(uploads()).toEqual([]);
  });

  it('a tenant admin can name a container path directly (positive arm)', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await POST(req({ container: CONTAINER, path: 'staging/a.csv' }));
    expect(res.status).toBe(201);
    expect(uploads()).toEqual([[CONTAINER, 'staging/a.csv']]);
  });
});

describe('upload — request shape', () => {
  it('400 without a path, before any authorization', async () => {
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER }));
    expect(res.status).toBe(400);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('400 without a file part (after the target is authorized)', async () => {
    const res = await POST(req({ lakehouseId: LH, container: CONTAINER, path: INSIDE }, false));
    expect(res.status).toBe(400);
    expect(uploads()).toEqual([]);
  });
});
