/**
 * #3904 (Fix 2) — GET /api/lakehouse/paths must translate storage failures.
 *
 * The operator saw this, under a red "List failed" banner:
 *
 *     The specified path does not exist.  RequestId:<guid> Time:<ts>
 *
 * That string is the Azure Storage SDK's, forwarded verbatim by the route
 * (`error: e?.message`). It is a `no-vaporware.md` honest-gate violation (a
 * RequestId is not a remediation) and it asserts a cause the code never
 * established (`deploy-integrity.md` R7). These specs pin the translation:
 * classified status, a remediation the user can act on, and NOTHING from the
 * SDK message in the body.
 *
 * WHY THIS SPEC LIVES HERE, next to the editor it serves, rather than under
 * app/api/lakehouse/__tests__/: the #3904 fan-out scoped this agent to
 * `lib/editors/lakehouse/**` + `app/api/lakehouse/paths/route.ts`, and sibling
 * agents were editing the api test directory concurrently. The route it
 * exercises is imported directly, so the coverage is real wherever the file
 * sits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, listPaths: vi.fn() };
});
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET, classifyListFailure } from '@/app/api/lakehouse/paths/route';
import { getSession } from '@/lib/auth/session';
import { listPaths } from '@/lib/azure/adls-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

/**
 * The real shape @azure/storage-file-datalake throws — a RestError whose
 * `message` embeds the RequestId/Time pair. The GUID here is synthetic.
 */
function restError(statusCode: number, code: string) {
  return Object.assign(
    new Error(
      `The specified path does not exist.\nRequestId:00000000-0000-0000-0000-000000000000\n`
      + `Time:2026-08-23T02:43:49.0000000Z`,
    ),
    { statusCode, code, name: 'RestError' },
  );
}

const req = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/paths?${qs}`) }) as any;
const session = { claims: { oid: 'oid-1', upn: 'u@x', tid: 't' } };
/**
 * A tenant admin (via LOOM_TENANT_ADMIN_OID). Listing a container with no
 * lakehouseId is the storage-browse form and is limited to tenant admins, so the
 * arms that exercise it run as ADMIN; the item-bound arms run as `session`.
 */
const ADMIN_OID = 'oid-tenant-admin';
const admin = { claims: { oid: ADMIN_OID, upn: 'admin@x', tid: 't' } };
let savedAdminOid: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(session);
  savedAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
});

afterEach(() => {
  if (savedAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
  else process.env.LOOM_TENANT_ADMIN_OID = savedAdminOid;
});

describe('storage-failure translation', () => {
  it('a 404 becomes an honest remediation with NO RequestId in the body', async () => {
    (getSession as any).mockReturnValue(admin);
    (listPaths as any).mockRejectedValue(restError(404, 'PathNotFound'));

    const res = await GET(req('container=bronze&prefix=Tables'), undefined as any);
    const raw = await res.text();

    expect(res.status).toBe(404);
    // THE ASSERTION THE OPERATOR'S SCREENSHOT DEMANDS.
    expect(raw, 'no storage RequestId may reach the user').not.toContain('RequestId');
    expect(raw).not.toContain('Time:2026');
    expect(raw).not.toContain('The specified path does not exist');

    const body = JSON.parse(raw);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('PathNotFound');
    expect(body.error).toContain('bronze/Tables');
    expect(body.remediation, 'the gate must say what fixes it').toBeTruthy();
    // R7 — it must not assert a cause it did not establish.
    expect(body.remediation).toMatch(/did not|not establish|only that/i);
  });

  it('a permission failure is classified as 403 with the exact role to grant', async () => {
    (getSession as any).mockReturnValue(admin);
    (listPaths as any).mockRejectedValue(restError(403, 'AuthorizationPermissionMismatch'));

    const res = await GET(req('container=gold&prefix=Tables'), undefined as any);
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(res.status).toBe(403);
    expect(raw).not.toContain('RequestId');
    expect(body.remediation).toContain('Storage Blob Data Contributor');
  });

  it('an UNCLASSIFIED failure says so — it does not invent a cause', async () => {
    (getSession as any).mockReturnValue(admin);
    (listPaths as any).mockRejectedValue(Object.assign(new Error('socket hang up RequestId:abc'), { statusCode: 500 }));

    const res = await GET(req('container=silver'), undefined as any);
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(res.status).toBe(502);
    expect(raw).not.toContain('RequestId');
    expect(raw).not.toContain('socket hang up');
    expect(body.remediation).toMatch(/cannot say what caused it/i);
  });

  it('classifyListFailure never echoes the SDK message, whatever the code', () => {
    for (const code of ['PathNotFound', 'AuthorizationPermissionMismatch', 'SomethingNew']) {
      const { body } = classifyListFailure(restError(0, code), 'landing', 'lakehouses/Foo');
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('RequestId');
      expect(serialized).not.toContain('The specified path does not exist');
      expect(serialized).toContain('landing/lakehouses/Foo');
    }
  });

  it('a RequestId smuggled through `code` is dropped, not forwarded', () => {
    // `code` is the ONE field sourced from the SDK, so it is the one remaining
    // way SDK text could reach a browser. `e.code` and `e.details.errorCode` are
    // typed `string` and nothing guarantees the short token the service
    // documents. Every other RequestId assertion in this file uses a CLEAN code,
    // so none of them can see this — which is exactly why it is asserted here.
    const dirty = 'PathNotFound RequestId:11111111-2222-3333-4444-555555555555 Time:2026-08-23';

    const viaCode = classifyListFailure(restError(404, dirty), 'landing', 'lakehouses/Foo');
    expect(JSON.stringify(viaCode.body)).not.toContain('RequestId');
    expect(viaCode.body.code).toBe('PathNotFound');   // the generic fallback token

    // Same hole, other accessor: RestError puts it on details.errorCode too.
    const viaDetails = classifyListFailure(
      Object.assign(new Error('x'), { statusCode: 403, details: { errorCode: dirty } }),
      'gold', 'Tables',
    );
    expect(JSON.stringify(viaDetails.body)).not.toContain('RequestId');
    expect(viaDetails.body.code).toBe('AuthorizationFailure');

    // A well-formed code is still passed through untouched — the bound is a
    // shape check, not a blanket redaction that would cost real diagnosis.
    const clean = classifyListFailure(restError(404, 'FilesystemNotFound'), 'landing', '');
    expect(clean.body.code).toBe('FilesystemNotFound');
  });

  it('states the CLASS as a token the UI can branch on, not as prose', () => {
    // The pane must not have to regex the English message to know whether this
    // is "not there yet" (guided) or a real error — that is a second method for
    // one decision, and it mis-fires on a path containing "not exist".
    expect(classifyListFailure(restError(404, 'PathNotFound'), 'landing', 'p').body.kind)
      .toBe('not-found');
    expect(classifyListFailure(restError(403, 'AuthorizationPermissionMismatch'), 'landing', 'p').body.kind)
      .toBe('denied');
    expect(classifyListFailure(restError(500, 'Whatever'), 'landing', 'p').body.kind)
      .toBe('unknown');
    // A DENIED failure whose text happens to contain "not exist" is still denied.
    const trap = classifyListFailure(restError(403, 'AuthorizationFailure'), 'landing', 'does not exist');
    expect(trap.body.kind).toBe('denied');
    expect(trap.status).toBe(403);
  });
});

describe('item-bound resolution', () => {
  it('resolves the lakehouse root and echoes the binding back to the client', async () => {
    // THE TWO WORKSPACE IDS DIFFER ON PURPOSE. The route must resolve against
    // the workspace the ITEM actually lives in (the authorization result), not
    // the one the caller typed. With both set to 'ws-1' — as this fixture
    // originally had them — swapping `access.item.workspaceId` for
    // `sp.get('workspaceId')` left the suite green, i.e. the spec could not
    // discriminate between the safe and the unsafe input. Test where the two
    // inputs can actually differ.
    (resolveItemAccessByOid as any).mockResolvedValue({ item: { id: 'lh-1', workspaceId: 'ws-owning' }, canWrite: true });
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: 'abfss://landing@acct.dfs.core.windows.net/lakehouses/Foo',
      container: 'landing',
      root: 'lakehouses/Foo',
    });
    (listPaths as any).mockResolvedValue([{ name: 'lakehouses/Foo/Tables', isDirectory: true, size: 0 }]);

    const res = await GET(req('lakehouseId=lh-1&workspaceId=ws-caller-supplied'), undefined as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, container: 'landing', root: 'lakehouses/Foo', prefix: 'lakehouses/Foo' });
    // Resolved against the item's OWN partition, never the caller's parameter.
    // The third argument pins that this branch opts in to persisting a probed
    // root (#4759) — the one caller that does; drop it and this goes red.
    expect(resolveLakehouseAbfss).toHaveBeenCalledWith('lh-1', 'ws-owning', { persist: true });
    expect(resolveLakehouseAbfss).not.toHaveBeenCalledWith('lh-1', 'ws-caller-supplied', expect.anything());
    expect(resolveLakehouseAbfss).toHaveBeenCalledTimes(1);
    // It listed the LAKEHOUSE root, not the container root.
    expect(listPaths).toHaveBeenCalledWith('landing', 'lakehouses/Foo', 200);
  });

  it('404s (never 403) for a lakehouse the caller cannot see — no existence oracle', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req('lakehouseId=someone-elses&workspaceId=ws-9'), undefined as any);
    expect(res.status).toBe(404);
    expect(resolveLakehouseAbfss).not.toHaveBeenCalled();
    expect(listPaths).not.toHaveBeenCalled();
  });

  it('honest-gates (200 + gate, not an error) when no storage is configured', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue({ item: { id: 'lh-1', workspaceId: 'ws-1' } });
    (resolveLakehouseAbfss as any).mockResolvedValue(null);

    const res = await GET(req('lakehouseId=lh-1&workspaceId=ws-1'), undefined as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.container).toBeNull();
    expect(body.paths).toEqual([]);
    expect(body.gate).toContain('LOOM_');
  });

  it('a tenant admin can still browse a named container directly (the container picker)', async () => {
    (getSession as any).mockReturnValue(admin);
    (listPaths as any).mockResolvedValue([]);
    const res = await GET(req('container=gold&prefix=Tables'), undefined as any);
    expect(res.status).toBe(200);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
    expect(listPaths).toHaveBeenCalledWith('gold', 'Tables', 200);
  });
});

describe('item-scoped listing', () => {
  const ROOT = 'lakehouses/Sales';
  const bindTo = (canWrite: boolean) => {
    (resolveItemAccessByOid as any).mockResolvedValue({ item: { id: 'lh-1', workspaceId: 'ws-1' }, canWrite });
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://landing@acct.dfs.core.windows.net/${ROOT}`,
      container: 'landing',
      root: ROOT,
    });
    (listPaths as any).mockResolvedValue([]);
  };

  // FAILS IF the container-only form stops requiring a tenant admin: the same
  // request the admin arm above makes would answer 200 and listPaths would be
  // called with ['gold','Tables',200].
  it('refuses a direct container listing from a caller who is not a tenant admin', async () => {
    const res = await GET(req('container=gold&prefix=Tables'), undefined as any);
    expect(res.status).toBe(403);
    expect((listPaths as any).mock.calls).toEqual([]);
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  // FAILS IF an explicit container short-circuits the item check (the storage
  // call happens, or the status is 200/403 rather than 404).
  it('answers 404 with no storage call when a named container comes with a lakehouse the caller cannot reach', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(req('lakehouseId=lh-other&container=landing&prefix=lakehouses/Sales'), undefined as any);
    expect(res.status).toBe(404);
    expect((listPaths as any).mock.calls).toEqual([]);
    expect(resolveLakehouseAbfss).not.toHaveBeenCalled();
  });

  // POSITIVE, paired with the refusals below: a sub-folder of the item's own
  // root lists. FAILS IF the containment test refuses a genuine member.
  it('lists a sub-folder inside the lakehouse root', async () => {
    bindTo(true);
    const res = await GET(req(`lakehouseId=lh-1&container=landing&prefix=${ROOT}/Files`), undefined as any);
    expect(res.status).toBe(200);
    expect((listPaths as any).mock.calls).toEqual([['landing', `${ROOT}/Files`, 200]]);
  });

  // FAILS IF containment is a string-prefix test: `lakehouses/Sales-archive`
  // starts with `lakehouses/Sales`, so the row set would become 1.
  it('refuses a prefix that only shares a string prefix with the root', async () => {
    bindTo(true);
    expect(`${ROOT}-archive`.startsWith(ROOT)).toBe(true);
    const res = await GET(req(`lakehouseId=lh-1&container=landing&prefix=${ROOT}-archive`), undefined as any);
    expect(res.status).toBe(403);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF `..` is folded rather than refused: `<root>/Files/..` folds back to
  // the root, and the row set would become [['landing','lakehouses/Sales',200]].
  it('refuses a ".." segment in the prefix', async () => {
    bindTo(true);
    const res = await GET(
      req(`lakehouseId=lh-1&container=landing&prefix=${encodeURIComponent(`${ROOT}/Files/..`)}`),
      undefined as any,
    );
    expect(res.status).toBe(400);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF the caller's container is used instead of the bound one: the row
  // set would become [['gold','lakehouses/Sales',200]].
  it('refuses a container other than the one the lakehouse is bound to', async () => {
    bindTo(true);
    const res = await GET(req(`lakehouseId=lh-1&container=gold&prefix=${ROOT}`), undefined as any);
    expect(res.status).toBe(403);
    expect((listPaths as any).mock.calls).toEqual([]);
  });

  // FAILS IF persist is passed unconditionally (the previous `{ persist: true }`):
  // the recorded third argument would be { persist: true } for a read-only
  // caller. Paired with the item-bound arm above, where canWrite is true and the
  // argument is { persist: true }.
  it('does not persist a probed root for a caller whose role is read-only', async () => {
    bindTo(false);
    const res = await GET(req('lakehouseId=lh-1'), undefined as any);
    expect(res.status).toBe(200);
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([['lh-1', 'ws-1', { persist: false }]]);
  });
});

describe('unchanged contracts', () => {
  it('401s with no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req('container=bronze'), undefined as any);
    expect(res.status).toBe(401);
  });

  it('400s with neither a container nor a lakehouseId', async () => {
    const res = await GET(req(''), undefined as any);
    expect(res.status).toBe(400);
  });

  it('404s on an unknown container', async () => {
    (getSession as any).mockReturnValue(admin);
    const res = await GET(req('container=not-a-container'), undefined as any);
    expect(res.status).toBe(404);
  });
});
