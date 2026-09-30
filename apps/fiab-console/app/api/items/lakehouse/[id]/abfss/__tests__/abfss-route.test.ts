/**
 * GET /api/items/lakehouse/[id]/abfss — the path is reported only for a
 * lakehouse the caller can reach, and is resolved in the ITEM's own workspace.
 *
 * Every refusal reads the resolver CALL ROW SET as well as the status, and is
 * paired with the positive owner arm: "the resolver was not called" alone is
 * satisfied by deleting the route.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
// `resolveLakehouseStorage` is a plain function (not a vi.fn, so a
// resetAllMocks cannot clear it) that DELEGATES to the `resolveLakehouseAbfss`
// mock: a bound value is `{ ok: true, bound }`, null is `no-storage`, and
// `{ withheld: <reason> }` is that withheld reason. The message function is
// the REAL one, so asserted text is the resolver module's own wording.
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    lakehouseStorageWithheldFields: actual.lakehouseStorageWithheldFields,
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const session = { claims: { oid: 'oid-1', upn: 'u@x', tid: 't' } };
const ABFSS = 'abfss://landing@acct.dfs.core.windows.net/lakehouses/Sales--lh-1';

const call = (id: string, qs = '') =>
  GET(
    { nextUrl: new URL(`http://x/api/items/lakehouse/${id}/abfss${qs}`) } as any,
    { params: Promise.resolve({ id }) } as any,
  );

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(session);
  (resolveItemAccessByOid as any).mockResolvedValue({
    item: { id: 'lh-1', workspaceId: 'ws-owning', itemType: 'lakehouse' },
    role: 'Viewer',
    via: 'workspace',
    canWrite: false,
  });
  (resolveLakehouseAbfss as any).mockResolvedValue({
    abfss: ABFSS,
    container: 'landing',
    root: 'lakehouses/Sales--lh-1',
  });
});

describe('GET /api/items/lakehouse/[id]/abfss', () => {
  // POSITIVE: a caller who can see the item (read access is enough) gets its
  // path, resolved in the item's OWN workspace. The two workspace ids differ on
  // purpose. FAILS IF the route resolves against `?workspaceId=` (the recorded
  // row becomes ['lh-1','ws-caller']), or asks for write access (403 here).
  it('reports the path for a caller who can see the item, resolved in its own workspace', async () => {
    const res = await call('lh-1', '?workspaceId=ws-caller');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, resolved: true, abfss: ABFSS });
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([['lh-1', 'ws-owning']]);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([[session, 'lh-1', 'lakehouse']]);
  });

  // FAILS IF the item authorization is dropped (status 200 and the resolver row
  // set 1, as on the pre-change route) or answered 403 (the status).
  it('answers 404 for a lakehouse the caller cannot reach, with no resolver call', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await call('lh-other', '?workspaceId=ws-other');
    expect(res.status).toBe(404);
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([]);
    expect(JSON.stringify(await res.json())).not.toContain('abfss://');
  });

  it('401 with no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await call('lh-1');
    expect(res.status).toBe(401);
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([]);
  });

  // FAILS IF a withheld location is reported as resolved (resolved:true with an
  // abfss) or worded as unconfigured storage (the hint would name LOOM_LANDING_URL
  // and `reason` would be absent). The hint is lifted from the resolver module.
  // Also FAILS IF root-shared loses the page that resolves it (`fixHref`), or
  // root-unverified (retried, no page) gains one.
  it('reports a withheld location as unresolved, with its reason and the resolver wording', async () => {
    const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
    const expected = actual.lakehouseStorageWithheldMessage('root-shared');
    expect(expected, 'the resolver must word root-shared').toBeTruthy();
    (resolveLakehouseAbfss as any).mockResolvedValue({ withheld: 'root-shared' });
    const res = await call('lh-1');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, resolved: false, reason: 'root-shared', hint: expected, fixHref: '/admin/readiness' });
    (resolveLakehouseAbfss as any).mockResolvedValue({ withheld: 'root-unverified' });
    const unverified = await (await call('lh-1')).json();
    expect(unverified).toEqual({
      ok: true, resolved: false, reason: 'root-unverified', hint: actual.lakehouseStorageWithheldMessage('root-unverified'),
    });
  });

  // FAILS IF resolver `not-found` is reported as the unconfigured-storage hint
  // (status 200) rather than 404.
  it('answers 404 when the resolver no longer finds the item', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue({ withheld: 'not-found' });
    const res = await call('lh-1');
    expect(res.status).toBe(404);
  });

  // POSITIVE twin for the unconfigured case: no storage keeps the env hint and
  // carries no `reason`. FAILS IF no-storage is sent down the withheld branch.
  it('keeps the storage-configuration hint when no storage is configured', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    const body = await (await call('lh-1')).json();
    expect(body.resolved).toBe(false);
    expect(body.hint).toContain('LOOM_LANDING_URL');
    expect('reason' in body).toBe(false);
  });
});
