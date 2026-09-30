/**
 * How the lakehouse permissions hooks surface a refused request.
 *
 *   - A failed listing clears the rows of the previous listing, so the dialog
 *     never shows rows it could not confirm next to the error.
 *   - A refusal's `remediation` is shown with its `error` (the listing, the
 *     grant, the revoke and Share), in the one error string the surface
 *     renders.
 *   - A 409 listing sets `permsListRefused` (the dialog disables Grant role on
 *     it); a 404 listing does not, and a later successful listing clears it.
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
const refused = (status: number, remediation?: string): Reply => ({
  status, body: { ok: false, error: ERR, code: 'storage_account_unreadable', ...(remediation ? { remediation } : {}) },
});

function mountPerms() {
  return renderHook(() => useLakehousePermissions({ lakehouseId: LH, activeContainer: 'landing', confirm: async () => true }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useLakehousePermissions — a refused listing', () => {
  it('a 409 clears the previous rows, shows error + remediation, and sets permsListRefused', async () => {
    installFetch([ok([ROW]), refused(409, FIX)]);
    const { result } = mountPerms();
    await act(async () => { await result.current.loadPerms(); });
    // Precondition: the first listing loaded one row, so the clear below is
    // observable (with no row here the next assertion could not fail).
    expect(result.current.permsRows).toEqual([ROW]);
    await act(async () => { await result.current.loadPerms(); });
    // Breaks if the catch does not call setPermsRows([]): ROW stays.
    expect(result.current.permsRows).toEqual([]);
    // Breaks if the remediation is dropped (the string is ERR alone).
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
    // Breaks if a 409 listing does not set the flag.
    expect(result.current.permsListRefused).toBe(true);
  });

  it('a 404 shows the error but does not set permsListRefused; a later success clears it', async () => {
    installFetch([refused(409), refused(404), ok([ROW])]);
    const { result } = mountPerms();
    await act(async () => { await result.current.loadPerms(); });
    expect(result.current.permsListRefused).toBe(true);
    // Without a remediation the message is the error alone (no trailing space).
    expect(result.current.permsError).toBe(ERR);
    await act(async () => { await result.current.loadPerms(); });
    // Breaks if the flag is not reset at the start of a listing, or if any
    // refusal (not only a 409) sets it.
    expect(result.current.permsListRefused).toBe(false);
    expect(result.current.permsError).toBe(ERR);
    await act(async () => { await result.current.loadPerms(); });
    expect(result.current.permsListRefused).toBe(false);
    expect(result.current.permsError).toBeNull();
    expect(result.current.permsRows).toEqual([ROW]);
  });
});

describe('the write hooks show remediation with the error', () => {
  it('a refused grant shows error + remediation', async () => {
    installFetch([refused(409, FIX)]);
    const { result } = mountPerms();
    await act(async () => { result.current.setNewPrincipalId('p9'); });
    await act(async () => { await result.current.grantPerm(); });
    // Breaks if the grant throw reads j.error only.
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
  });

  it('a refused revoke shows error + remediation', async () => {
    installFetch([refused(409, FIX)]);
    const { result } = mountPerms();
    await act(async () => { await result.current.revokePerm(ROW.id); });
    // Breaks if the revoke throw reads j.error only.
    expect(result.current.permsError).toBe(`${ERR} ${FIX}`);
  });

  it('a refused Share shows error + remediation', async () => {
    installFetch([refused(409, FIX)]);
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
