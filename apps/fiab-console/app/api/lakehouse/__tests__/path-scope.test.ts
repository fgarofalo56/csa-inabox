/**
 * Input-validation contract for `/api/lakehouse/path` — the container + path a
 * DELETE (hard delete) or POST (mkdir) is allowed to act on.
 *
 * WHAT THIS PINS. Both verbs used to check PRESENCE only: that `container` and
 * `path` were non-empty and that `container` was one of `KNOWN_CONTAINERS`.
 * `path` was tied to no item, so the pair handed to `deletePath` /
 * `createDirectory` was the one the query string named, validated against
 * nothing the caller owns. The pair is now resolved against the caller's own
 * lakehouse: `resolveItemAccessByOid` authorizes the item,
 * `resolveLakehouseAbfss` derives its container + root, and the supplied path
 * must sit strictly BELOW that root, compared SEGMENT BY SEGMENT.
 *
 * WHAT THE ASSERTIONS READ. The MECHANISM — the `deletePath` /
 * `createDirectory` / `resolveItemAccessByOid` call row sets — not the route's
 * JSON. A route that returned 403 while still calling the ADLS client, that
 * returned the resolved pair in its body while forwarding the caller's string,
 * or that authorized the wrong item type, passes a response-only assertion and
 * fails these. Every arm names the value that makes it fail at its site, and the
 * refusals are paired with positives (arms 1, 2, 15 and 15b): "nothing reached
 * ADLS" alone is satisfied by deleting the feature.
 *
 * The containment rule is LIFTED from the route (`pathSegments`) rather than
 * transcribed, and the two trap fixtures have their shape asserted inline, so a
 * fixture that stopped triggering the rule cannot pass unnoticed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/adls-client');
  return { ...actual, deletePath: vi.fn(), createDirectory: vi.fn() };
});
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { DELETE, POST, pathSegments } from '../path/route';
import { getSession } from '@/lib/auth/session';
import { deletePath, createDirectory } from '@/lib/azure/adls-client';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const LH = 'lh-1';
const CONTAINER = 'landing';
/** The root `resolveLakehouseAbfss` reports for this lakehouse. */
const ROOT = 'lakehouses/Sales';
/** A real member of that root — the shape the editor's Files browser sends. */
const INSIDE = `${ROOT}/Files/q1.csv`;

const req = (qs: string) =>
  ({ nextUrl: new URL(`http://x/api/lakehouse/path?${qs}`) }) as any;
const session = { claims: { oid: 'oid-1', upn: 'u@x', tid: 't' } };

const del = (qs: string) => DELETE(req(qs), undefined as any);
const post = (qs: string) => POST(req(qs), undefined as any);

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(session);
  (resolveItemAccessByOid as any).mockResolvedValue({
    item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' },
    role: 'Admin',
    via: 'owner',
    canWrite: true,
  });
  (resolveLakehouseAbfss as any).mockResolvedValue({
    abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${ROOT}`,
    container: CONTAINER,
    root: ROOT,
  });
  (deletePath as any).mockResolvedValue({ ok: true });
  (createDirectory as any).mockResolvedValue({ ok: true });
});

describe('fixture shape — asserted, not reasoned about', () => {
  // The arm-4 fixture only traps a STRING-prefix containment test if it really
  // is a string prefix of the root while not being a segment-wise one. FAILS IF
  // the fixture is retyped as e.g. `lakehouses/Other/x.csv`, which every
  // implementation rejects and which would therefore witness nothing.
  it('the string-prefix fixture is a string prefix of the root but not a segment prefix', () => {
    const trap = `${ROOT}-archive/2026.csv`;
    expect(trap.startsWith(ROOT), 'a startsWith() containment test would admit this').toBe(true);
    const trapSegs = pathSegments(trap)!;
    const rootSegs = pathSegments(ROOT)!;
    expect(trapSegs[0]).toBe(rootSegs[0]);
    expect(trapSegs[1], 'segment-wise it is a DIFFERENT folder').not.toBe(rootSegs[1]);
  });

  // The arm-5 fixture only distinguishes "refuse `..`" from "fold `..` away" if
  // folding lands it BACK inside the root. FAILS IF the fixture is changed to
  // one that folds to somewhere outside, which a folding implementation would
  // reject anyway — making the arm green for the wrong reason.
  it('the ".." fixture folds back INSIDE the root, so folding would accept it', () => {
    const folded: string[] = [];
    for (const seg of `${ROOT}/Files/../q1.csv`.split('/')) {
      if (seg === '..') folded.pop();
      else folded.push(seg);
    }
    expect(folded.join('/')).toBe(`${ROOT}/q1.csv`);
  });
});

describe('DELETE /api/lakehouse/path — scope', () => {
  it('401 with no session', async () => {
    // FAILS IF withSession is dropped: the status becomes 200 and the row set 1.
    (getSession as any).mockReturnValue(null);
    const res = await del(`lakehouseId=${LH}&container=${CONTAINER}&path=${INSIDE}`);
    expect(res.status).toBe(401);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 1. POSITIVE, paired with every refusal below: a legitimate delete still
  // reaches ADLS with the exact triple. FAILS IF the containment test rejects a
  // genuine member (e.g. `<=` widened to `<` on the wrong side, or the
  // comparison run against the wrong operand) — the row set becomes [].
  // The THIRD row set pins which item the authorization was asked about: FAILS
  // IF the route asks for a different item type (`'warehouse'`) or passes
  // something other than the query-string id, both of which leave the other two
  // assertions green.
  it('deletes a path inside the lakehouse own root', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}&path=${INSIDE}&recursive=false`,
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, container: CONTAINER, path: INSIDE });
    expect((deletePath as any).mock.calls).toEqual([[CONTAINER, INSIDE, false]]);
    expect((resolveItemAccessByOid as any).mock.calls).toEqual([[session, LH, 'lakehouse']]);
  });

  // 2. POSITIVE — recursive is still the caller's option INSIDE the root, and
  // the derived spelling is what goes forward: the request spells the path with
  // doubled and trailing separators, which collapse. FAILS IF the caller's raw
  // string is forwarded (the recorded argument becomes `lakehouses/Sales//Files/`),
  // or if `recursive=true` stops being passed (the third argument becomes false).
  it('forwards the derived path spelling, not the caller string', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(`${ROOT}//Files/`)}&recursive=true`,
    );
    expect(res.status).toBe(200);
    expect((deletePath as any).mock.calls).toEqual([[CONTAINER, `${ROOT}/Files`, true]]);
  });

  // 2b. NEGATIVE — the absolute form of a path that IS inside the root, refused
  // rather than collapsed (the same choice `/api/lakehouse/upload` makes). FAILS
  // IF a leading separator is treated as an empty segment and dropped: the
  // request is accepted and the row set becomes
  // [['landing','lakehouses/Sales/Files/q1.csv',false]].
  it('refuses an absolute path form', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(`/${INSIDE}`)}&recursive=false`,
    );
    expect(res.status).toBe(400);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 3. NEGATIVE — same container, a sibling folder the lakehouse does not own.
  // FAILS IF the route forwards the caller's pair (the previous behaviour): the
  // row set becomes [['landing','lakehouses/Other/orders.parquet',true]].
  it('refuses a path outside the lakehouse own root', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}&path=lakehouses/Other/orders.parquet&recursive=true`,
    );
    expect(res.status).toBe(403);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 4. NEGATIVE — the prefix trap. `lakehouses/Sales-archive` is a STRING prefix
  // match on `lakehouses/Sales`. FAILS IF containment is a `startsWith` test
  // (the shape `isValidRolePath` in onelake-security-rules.ts uses): the row set
  // becomes [['landing','lakehouses/Sales-archive/2026.csv',false]].
  it('refuses a sibling folder that merely shares a string prefix with the root', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}&path=${ROOT}-archive/2026.csv&recursive=false`,
    );
    expect(res.status).toBe(403);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 5. NEGATIVE — a `..` segment that would fold back INSIDE the root (see the
  // fixture-shape block). FAILS IF `..` is folded away instead of refused: the
  // request is accepted and the row set becomes
  // [['landing','lakehouses/Sales/q1.csv',false]]. The 400 (not 403) pins that
  // it is refused at the path-shape step, before any scope comparison.
  it('refuses a ".." segment even when it would resolve back inside the root', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(`${ROOT}/Files/../q1.csv`)}&recursive=false`,
    );
    expect(res.status).toBe(400);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 6. NEGATIVE — the same `..` form written percent-encoded. URLSearchParams
  // decodes once before the route sees it, so `%2e%2e` arrives as `..`. FAILS IF
  // the path is read off the RAW query string instead of the decoded param:
  // `%2e%2e` is then an ordinary segment name, the request is accepted, and the
  // row set becomes [['landing','lakehouses/Sales/Files/%2e%2e/q1.csv',false]].
  it('refuses a percent-encoded ".." segment', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=lakehouses%2FSales%2FFiles%2F%2e%2e%2Fq1.csv&recursive=false`,
    );
    expect(res.status).toBe(400);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 7. NEGATIVE — a backslash-separated `..`. FAILS IF `\` is not folded to
  // `/` before the segment scan: `Files\..\q1.csv` is then one opaque segment,
  // the request is accepted, and the row set is non-empty.
  it('refuses a backslash-separated ".." segment', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(`${ROOT}\\Files\\..\\q1.csv`)}&recursive=false`,
    );
    expect(res.status).toBe(400);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 7b. NEGATIVE — a single-dot segment, the sibling of arm 5. FAILS IF `.` is
  // silently dropped rather than refused (`if (part === '.') continue;`): the
  // request is accepted and the row set becomes
  // [['landing','lakehouses/Sales/Files/q1.csv',false]].
  it('refuses a "." segment', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(`${ROOT}/Files/./q1.csv`)}&recursive=false`,
    );
    expect(res.status).toBe(400);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 7c. NEGATIVE — an embedded NUL, sent percent-encoded (`%00`) and decoded
  // by URLSearchParams before the route sees it. FAILS IF the `\0` guard is
  // dropped: the request is accepted and the row set becomes
  // [['landing','lakehouses/Sales/Files/q1.csv\u0000.txt',false]]. DISCLOSED per
  // assertion-design #5: a surviving NUL would still have to clear the
  // segment-wise containment test, so this arm pins the REFUSAL the header
  // claims — it is not evidence about scope.
  it('refuses a path containing a NUL', async () => {
    const raw = `${INSIDE}\u0000.txt`;
    // The fixture reaches the `\0` guard only if the decode really yields one.
    // FAILS IF encodeURIComponent/URLSearchParams stop round-tripping it.
    expect(new URLSearchParams(`path=${encodeURIComponent(raw)}`).get('path')).toBe(raw);
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(raw)}&recursive=false`,
    );
    expect(res.status).toBe(400);
    expect((deletePath as any).mock.calls).toEqual([]);
  });


  // `segments.length < root.length` instead of `<=`: the row set becomes
  // [['landing','lakehouses/Sales',true]], i.e. the item's whole storage.
  it('refuses the root itself as a target', async () => {
    const res = await del(
      `lakehouseId=${LH}&container=${CONTAINER}&path=${ROOT}&recursive=true`,
    );
    expect(res.status).toBe(403);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 9. NEGATIVE — a different KNOWN container, with a path that IS inside the
  // root. FAILS IF only the path is compared and the container is taken from the
  // caller: the row set becomes [['gold','lakehouses/Sales/Files/q1.csv',false]].
  it('refuses a container other than the one the lakehouse is bound to', async () => {
    const res = await del(`lakehouseId=${LH}&container=gold&path=${INSIDE}&recursive=false`);
    expect(res.status).toBe(403);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 10. NEGATIVE — no lakehouseId at all, i.e. the request shape the route used
  // to accept. FAILS IF `lakehouseId` becomes optional with any fall-through to
  // an unscoped path: the row set becomes [['landing','lakehouses/Sales/Files/q1.csv',false]].
  it('refuses a request that names no lakehouse', async () => {
    const res = await del(`container=${CONTAINER}&path=${INSIDE}&recursive=false`);
    expect(res.status).toBe(400);
    expect((resolveLakehouseAbfss as any).mock.calls).toEqual([]);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 11. NEGATIVE — a lakehouse the caller cannot reach. 404, never 403, so the
  // id is never confirmed. FAILS IF the authorization call is dropped
  // (status 200, row set 1) or answered with 403 (the status assertion).
  it('answers 404 — not 403 — for a lakehouse the caller cannot reach', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await del(`lakehouseId=${LH}&container=${CONTAINER}&path=${INSIDE}`);
    expect(res.status).toBe(404);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 12. NEGATIVE — a read-only role. FAILS IF the `canWrite` check is dropped:
  // status 200 and the row set becomes [['landing','lakehouses/Sales/Files/q1.csv',false]].
  it('refuses a caller whose role on the lakehouse is read-only', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue({
      item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' },
      role: 'ItemViewer',
      via: 'item-grant',
      canWrite: false,
    });
    const res = await del(`lakehouseId=${LH}&container=${CONTAINER}&path=${INSIDE}`);
    expect(res.status).toBe(403);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 13. NEGATIVE — no storage binding at all for this lakehouse. FAILS IF a null
  // binding degrades to "no scope" rather than a refusal: the row set becomes 1.
  // The message assertion pins WHICH of the two 409 causes was reported: FAILS
  // IF the two are merged back into one string (arm 13b then reads the same
  // text for a different condition).
  it('refuses when the lakehouse has no storage binding', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    const res = await del(`lakehouseId=${LH}&container=${CONTAINER}&path=${INSIDE}`);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/no lakehouse storage binding/i);
    expect((deletePath as any).mock.calls).toEqual([]);
  });

  // 13b. NEGATIVE — the binding EXISTS and its recorded root is not a usable
  // container-relative path. This is the arm that refuses `?? []`: with an empty
  // root, `segments.length <= root.length` compares against 0 and the
  // containment test is true for every input, so the row set becomes
  // [['landing','lakehouses/Sales/Files/q1.csv',false]] and the status 200.
  // FAILS on that mutation, and on merging the two 409 causes (the message
  // assertion). The parametrised roots are the spellings `pathSegments` refuses.
  it.each(['', '/', '//', '.', '..', '/..'])(
    'refuses a recorded root that is not a usable path (%j)',
    async (root) => {
      (resolveLakehouseAbfss as any).mockResolvedValue({
        abfss: `abfss://${CONTAINER}@acct.dfs.core.windows.net/${root}`,
        container: CONTAINER,
        root,
      });
      const res = await del(`lakehouseId=${LH}&container=${CONTAINER}&path=${INSIDE}`);
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/recorded root/i);
      expect((deletePath as any).mock.calls).toEqual([]);
    },
  );

  // 14. NEGATIVE — an unknown container still 404s, as before. FAILS IF the
  // KNOWN_CONTAINERS check is dropped while the scope check is kept (the status
  // becomes 403, since an unknown container also fails the binding comparison).
  it('answers 404 for a container this deployment does not serve', async () => {
    const res = await del(`lakehouseId=${LH}&container=nope&path=${INSIDE}`);
    expect(res.status).toBe(404);
    expect((deletePath as any).mock.calls).toEqual([]);
  });
});

describe('POST /api/lakehouse/path — scope', () => {
  // 15. POSITIVE, paired with arm 16: creating a folder inside the root still
  // works end to end and still answers 201. FAILS IF the shared resolution
  // refuses a genuine member: the row set becomes [].
  it('creates a directory inside the lakehouse own root', async () => {
    const res = await post(`lakehouseId=${LH}&container=${CONTAINER}&path=${ROOT}/Files/new`);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body).toEqual({ ok: true, container: CONTAINER, path: `${ROOT}/Files/new` });
    expect((createDirectory as any).mock.calls).toEqual([[CONTAINER, `${ROOT}/Files/new`]]);
  });

  // 15b. POSITIVE — the rebuilt spelling on the CREATE half, the twin of arm 2.
  // Without it, "the path is rebuilt" is DELETE-only evidence presented as a
  // route property. FAILS IF POST forwards `searchParams.get('path')` instead of
  // the resolved target: the recorded argument becomes `lakehouses/Sales//Files/`
  // rather than `lakehouses/Sales/Files`.
  it('forwards the derived path spelling on create, not the caller string', async () => {
    const res = await post(
      `lakehouseId=${LH}&container=${CONTAINER}`
      + `&path=${encodeURIComponent(`${ROOT}//Files/`)}`,
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body).toEqual({ ok: true, container: CONTAINER, path: `${ROOT}/Files` });
    expect((createDirectory as any).mock.calls).toEqual([[CONTAINER, `${ROOT}/Files`]]);
  });

  // 16. NEGATIVE — POST is scoped too, not just DELETE. FAILS IF only DELETE is
  // resolved against the binding: the row set becomes
  // [['landing','lakehouses/Other/new']].
  it('refuses a directory outside the lakehouse own root', async () => {
    const res = await post(`lakehouseId=${LH}&container=${CONTAINER}&path=lakehouses/Other/new`);
    expect(res.status).toBe(403);
    expect((createDirectory as any).mock.calls).toEqual([]);
  });
});
