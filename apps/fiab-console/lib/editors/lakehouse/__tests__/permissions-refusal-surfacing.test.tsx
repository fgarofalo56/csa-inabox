/**
 * How the lakehouse permissions hooks surface a refused request.
 *
 *   - A failed listing clears the rows of the previous listing, so the dialog
 *     never shows rows it could not confirm next to the error.
 *   - A refusal's `remediation` is shown with its `error` (the listing, the
 *     grant, the revoke and Share), in the one error string the surface
 *     renders.
 *   - A listing refused with a `code` (409, 404 item_not_found, 403
 *     outside_item_root, ...) sets `permsListRefused` (the dialog disables Grant
 *     role on it); a failure without a code does not, and a later successful
 *     listing clears it.
 *   - `permsListFailed` records whether the LISTING failed, so a grant or
 *     revoke error after a successful listing leaves it false.
 *
 * Each response is chosen per request by the test, so the value that breaks
 * each assertion is named at the assertion.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useLakehousePermissions } from '../hooks/use-lakehouse-permissions';
import { useLakehouseSecondary } from '../hooks/use-lakehouse-secondary';

const LH = 'lh-refusals';
const ROW = { id: '/subscriptions/s/ra/1', principalId: 'p1', principalType: 'User', roleName: 'Storage Blob Data Reader' };
const ERR = 'Loom found a storage binding for this lakehouse, but could not read a storage account from it.';
const FIX = 'Re-run the item provision to rewrite the binding, then retry.';
const NOT_FOUND = 'Lakehouse not found.';
const OUTSIDE = 'Container other is not this lakehouse\'s storage container (landing).';
const UPSTREAM = 'Upstream error.';

type Reply = { status: number; body: unknown };
let replies: Reply[] = [];

/**
 * Requests to /api/lakehouse/permissions take the next queued reply, in order.
 * Anything else (the Share hook's mount-time schema and reference loads) gets
 * an empty 200, so it neither consumes the queue nor fails the test.
 */
function installFetch(queue: Reply[]) {
  replies = [...queue];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }) as any;
    if (!url.includes('/api/lakehouse/permissions')) return json(200, { ok: true });
    const next = replies.shift();
    if (!next) throw new Error('unexpected request: no reply queued');
    return json(next.status, next.body);
  });
}

const ok = (rows: unknown[]): Reply => ({ status: 200, body: { ok: true, assignments: rows, knownRoles: [] } });
/** A coded refusal, as the route sends it: each status with its own code and error. */
const refused = (status: number, code: string, error: string, remediation?: string): Reply => ({
  status, body: { ok: false, error, code, ...(remediation ? { remediation } : {}) },
});
/** The 409 whose code matches ERR/FIX (the binding names no readable account). */
const unreadable = (remediation?: string) => refused(409, 'storage_account_unreadable', ERR, remediation);
/** A failure without a code (an unmapped upstream error). */
const uncoded = (status: number): Reply => ({ status, body: { ok: false, error: UPSTREAM } });

function mountPerms() {
  return renderHook(() => useLakehousePermissions({ lakehouseId: LH, activeContainer: 'landing', confirm: async () => true }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useLakehousePermissions — a refused listing', () => {
  it('a 409 clears the previous rows, shows error + remediation, and sets permsListRefused', async () => {
    installFetch([ok([ROW]), unreadable(FIX)]);
    const { result } = mountPerms();
    await act(async () => { await result.current.loadPerms(); });
    // Precondition: the first listing loaded one row, so the clear below is
    // observable (with no row here the next assertion could not fail).
    expect(result.current.permsRows).toEqual([ROW]);
    expect(result.current.permsListFailed).toBe(false);
    await act(async () => { await result.current.loadPerms(); });
    // Breaks if the catch does not call setPermsRows([]): ROW stays.
    expect(result.current.permsRows).toEqual([]);
    // Breaks if the remediation is dropped (the string is ERR alone).
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
    // Breaks if a coded 409 listing does not set the flag.
    expect(result.current.permsListRefused).toBe(true);
    // Breaks if the listing catch does not set permsListFailed.
    expect(result.current.permsListFailed).toBe(true);
  });

  it('any coded refusal sets permsListRefused; an uncoded failure does not; a success clears it', async () => {
    installFetch([
      refused(404, 'item_not_found', NOT_FOUND),
      refused(403, 'outside_item_root', OUTSIDE),
      uncoded(502),
      ok([ROW]),
    ]);
    const { result } = mountPerms();
    await act(async () => { await result.current.loadPerms(); });
    // Breaks if the flag is set only on a 409 (a 404 is not a 409).
    expect(result.current.permsListRefused).toBe(true);
    // Without a remediation the message is the error alone (no trailing space).
    expect(result.current.permsError).toBe(NOT_FOUND);
    await act(async () => { await result.current.loadPerms(); });
    // Breaks the same way for a 403: not a 409.
    expect(result.current.permsListRefused).toBe(true);
    expect(result.current.permsError).toBe(OUTSIDE);
    await act(async () => { await result.current.loadPerms(); });
    // Breaks if the flag is not reset at the start of a listing (it was true),
    // or if any failure, coded or not, sets it: this 502 carries no code.
    expect(result.current.permsListRefused).toBe(false);
    expect(result.current.permsError).toBe(UPSTREAM);
    // The listing still failed, so its rows are unknown.
    expect(result.current.permsListFailed).toBe(true);
    await act(async () => { await result.current.loadPerms(); });
    expect(result.current.permsListRefused).toBe(false);
    // Breaks if permsListFailed is not reset at the start of a listing.
    expect(result.current.permsListFailed).toBe(false);
    expect(result.current.permsError).toBeNull();
    expect(result.current.permsRows).toEqual([ROW]);
  });

  it('a grant refused after a successful empty listing leaves permsListFailed false', async () => {
    installFetch([ok([]), unreadable(FIX)]);
    const { result } = mountPerms();
    await act(async () => { await result.current.loadPerms(); });
    await act(async () => { result.current.setNewPrincipalId('p9'); });
    await act(async () => { await result.current.grantPerm(); });
    // Precondition: the grant error is shown, so a flag keyed on permsError
    // would read "failed" here.
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
    // Breaks if the grant catch sets permsListFailed: the listing succeeded.
    expect(result.current.permsListFailed).toBe(false);
    expect(result.current.permsRows).toEqual([]);
  });
});

describe('the write hooks show remediation with the error', () => {
  it('a refused grant shows error + remediation', async () => {
    installFetch([unreadable(FIX)]);
    const { result } = mountPerms();
    await act(async () => { result.current.setNewPrincipalId('p9'); });
    await act(async () => { await result.current.grantPerm(); });
    // Breaks if the grant throw reads j.error only.
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
  });

  it('a refused revoke shows error + remediation', async () => {
    installFetch([unreadable(FIX)]);
    const { result } = mountPerms();
    await act(async () => { await result.current.revokePerm(ROW.id); });
    // Breaks if the revoke throw reads j.error only.
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
  });

  it('a refused Share shows error + remediation', async () => {
    installFetch([unreadable(FIX)]);
    const { result } = renderHook(() => useLakehouseSecondary({
      id: LH, isNewItem: false, activeContainer: 'landing', shortcutLakehouseId: LH,
      schemasEnabled: false, setSchemasEnabled: () => {}, loadPaths: async () => {},
      tablesPrefix: 'Tables', confirm: async () => true,
      itemQ: { data: undefined } as any, maintainTable: '', tab: 'files',
    }));
    await act(async () => { result.current.setSharePrincipal('p9'); });
    await act(async () => { await result.current.grantShare(); });
    // Breaks if the Share throw reads j.error only.
    expect(result.current.shareError).toBe(`${ERR} ${FIX}`);
  });
});
