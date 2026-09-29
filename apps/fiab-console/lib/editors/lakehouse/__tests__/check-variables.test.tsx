/**
 * "Check variables" — a READ-ONLY Variable Library health check on the
 * lakehouse ribbon.
 *
 * WHAT THIS IS NOT. It is not Fabric's Lakehouse-ribbon "Update all variables"
 * (#3538). That command re-evaluates variable-bound shortcuts, which Loom's
 * lakehouse does not have, and an earlier revision of this feature borrowed its
 * name for an action that updates nothing. #3538 stays open. The copy test
 * below pins the honest description so the old claim cannot quietly return.
 *
 * WHAT EACH TEST WOULD BREAK ON (`assertion-design.md` "done" #1). Every mutation
 * named here was RUN against a committed tree, not transcribed:
 *
 *   1. the ribbon action exists and checks EVERY library — deleting the action
 *      reddens the ribbon query; checking only the first library reddens the
 *      call list; counting failed rows as resolved reddens the per-row badge;
 *      adding any write to the flow reddens the no-write assertion.
 *   2. a resolve that never LANDED reads as "not reached", not "0 failed"
 *      (`deploy-integrity.md` R7) — collapsing the catch arm reddens the badge.
 *   3. a BOUNDED list says so — dropping `truncated` reddens the warning bar.
 *   4. zero libraries is guided and the submit is disabled — enabling it
 *      reddens the `.disabled` assertion.
 *   5. the action stays DISABLED until the item's workspace is known — removing
 *      that gate reddens it, because the list call would otherwise go out with
 *      no workspace filter.
 *   6-7. the hook's own guards, driven directly through `renderHook`, because
 *      the UI cannot reach them (the ribbon and the submit are both disabled in
 *      exactly the states the guards cover). An earlier revision claimed the UI
 *      test pinned the empty-list guard; a reviewer deleted the guard and 4/4
 *      stayed green. These two are the tests that actually die.
 *
 * NOT CLAIMED. jsdom is not a G1 receipt (`ux-baseline.md`); the in-browser
 * click-walk against a live estate is still owed.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';
import { useCheckVariables, CHECK_VARIABLES_NO_WORKSPACE } from '../hooks/use-check-variables';

const ITEM = {
  id: 'lh-3538', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Contoso Sales',
  state: { provisioning: { secondaryIds: { container: 'landing', rootPath: 'lakehouses/Contoso Sales' } } },
};

const TWO_LIBRARIES = {
  ok: true,
  items: [
    { id: 'lib1', displayName: 'Shared connection strings', workspaceId: 'ws-1' },
    { id: 'lib2', displayName: 'Env switches', workspaceId: 'ws-1' },
  ],
  truncated: false,
};

/** Distinct per-library payloads so a hook that checked one twice is visible. */
const LIB1_OK = { ok: true, valueSet: 'prod', resolved: [{ name: 'sqlHost' }, { name: 'sqlDb' }] };
const LIB2_ONE_BAD = {
  ok: true,
  valueSet: 'dev',
  resolved: [{ name: 'featureFlag' }, { name: 'apiKey', error: 'secret-ref requires a Key Vault — set LOOM_KEY_VAULT_URI' }],
};

function mount(extra: Record<string, (url: string, init?: RequestInit) => unknown>, item: unknown = ITEM) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => ({ ok: true, containers: [{ name: 'landing', url: 'u' }] }),
    '/api/lakehouse/paths': () => ({ ok: true, entries: [] }),
    '/api/cosmos-items/lakehouse/lh-3538': () => item,
    ...extra,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-3538" />);
  return mock;
}

/** The ribbon action, found strictly — it is outside any modal. */
function findRibbonAction() {
  return screen.findByRole('button', { name: /^Check variables$/i }, { timeout: 5000 });
}

/**
 * Open the dialog from the ribbon. Returns the submit once the list resolved.
 *
 * `hidden: true` on the DIALOG query, measured in round 1: without it the first
 * of these tests failed in a full-file run and passed alone — Fluent's modal
 * bookkeeping marks the live surface aria-hidden (the #4685 / #4698 shape). The
 * RIBBON query stays strict.
 */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  const btn = await findRibbonAction();
  // The item must have loaded for the action to be enabled — see test 5.
  await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  await user.click(btn);
  return screen.findByRole('button', { name: /^Check all$/i, hidden: true }, { timeout: 5000 });
}

/** Resolve POSTs the run issued, in order. */
function resolvePosts(calls: Array<{ url: string; init?: RequestInit }>) {
  return calls.filter((c) => c.init?.method === 'POST' && /\/api\/items\/variable-library\/[^/]+\/resolve$/.test(c.url));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Lakehouse ribbon: Check variables (read-only)', () => {
  it('checks EVERY library in the workspace, reports real counts, and writes nothing', async () => {
    const user = userEvent.setup();
    const { calls } = mount({
      '/api/items?type=variable-library': () => TWO_LIBRARIES,
      '/api/items/variable-library/lib1/resolve': () => LIB1_OK,
      '/api/items/variable-library/lib2/resolve': () => LIB2_ONE_BAD,
    });

    const submit = await openDialog(user);
    // Workspace-scoped: reddens if `workspaceId` is dropped from the query.
    expect(calls.some((c) => c.url.includes('type=variable-library') && c.url.includes('workspaceId=ws-1'))).toBe(true);
    // Both library names are offered — reddens if the hook keeps only the first.
    expect(await screen.findByText(/Shared connection strings, Env switches/)).toBeTruthy();
    // THE HONEST DESCRIPTION. Reddens if the copy stops saying it is read-only,
    // which is the claim the round-1 "update" label got wrong.
    expect(screen.getByText(/This is a read-only check\. It writes no values and refreshes nothing\./)).toBeTruthy();

    const before = calls.length;
    await user.click(submit);

    // EXACTLY ONE POST PER LIBRARY. Reddens at 1 (only the first checked), at 3
    // (a re-entrant submit), and at 0 (a label with no handler).
    await waitFor(() => expect(resolvePosts(calls).map((c) => c.url)).toEqual([
      '/api/items/variable-library/lib1/resolve',
      '/api/items/variable-library/lib2/resolve',
    ]));
    // …AND NOTHING ELSE. Every request the check issued is one of those two
    // resolve reads; a PATCH/PUT/DELETE, or a POST anywhere else, reddens this.
    // Paired with the positive list above, so deleting the feature cannot
    // satisfy it (`assertion-design.md` "done" #4).
    const issued = calls.slice(before).filter((c) => (c.init?.method || 'GET') !== 'GET');
    expect(issued.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'POST /api/items/variable-library/lib1/resolve',
      'POST /api/items/variable-library/lib2/resolve',
    ]);

    // lib1: 2 clean rows. lib2: one clean, one failed — so `resolved` is 1, NOT
    // 2. Counting the failed row as resolved reddens this line.
    expect(await screen.findByText('2 resolved')).toBeTruthy();
    expect(await screen.findByText(/^1 resolved, 1 failed — secret-ref requires a Key Vault/)).toBeTruthy();
    // The value set each library actually answered with, not a constant.
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('dev')).toBeTruthy();
    expect(screen.getByText(/2 libraries checked; 1 variable\(s\) did not resolve\./)).toBeTruthy();

    // `no-fabric-dependency.md` — no Fabric/Power BI host on the default path.
    expect(calls.filter((c) => /fabric\.microsoft\.com|powerbi\.com|onelake\.dfs/.test(c.url))).toEqual([]);
  });

  it('a resolve that never landed reads as NOT REACHED, not as zero failures (R7)', async () => {
    const user = userEvent.setup();
    const { calls } = mount({
      '/api/items?type=variable-library': () => TWO_LIBRARIES,
      '/api/items/variable-library/lib1/resolve': () => LIB1_OK,
      '/api/items/variable-library/lib2/resolve': () => ({ ok: false, error: 'not found' }),
    });

    const submit = await openDialog(user);
    await user.click(submit);
    await waitFor(() => expect(resolvePosts(calls).length).toBe(2));

    // Both redden if the catch arm degrades to `{ resolved: 0, failed: 0 }`.
    expect(await screen.findByText(/^Not reached: not found$/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 libraries could not be reached\./)).toBeTruthy();
    // POSITIVE CONTROL — the library that DID answer still reports its count.
    expect(screen.getByText('2 resolved')).toBeTruthy();
  });

  it('a BOUNDED library list is disclosed rather than presented as the estate', async () => {
    const user = userEvent.setup();
    mount({
      '/api/items?type=variable-library': () => ({
        ...TWO_LIBRARIES,
        truncated: true,
        hint: 'Showing the first 200 item(s) of type "variable-library".',
      }),
    });

    await openDialog(user);
    // Reddens if `truncated` is dropped on the way through the hook.
    expect(await screen.findByText('Partial list')).toBeTruthy();
    expect(screen.getByText(/Showing the first 200 item\(s\) of type "variable-library"\./)).toBeTruthy();
  });

  it('zero libraries is a guided state and the submit is disabled', async () => {
    const user = userEvent.setup();
    mount({
      '/api/items?type=variable-library': () => ({ ok: true, items: [], truncated: false }),
    });

    const submit = await openDialog(user);
    expect(await screen.findByText(/No variable libraries in this workspace yet/)).toBeTruthy();
    expect(screen.queryByText('Partial list')).toBeNull();
    // Reddens if the submit is left enabled with nothing to check. This is the
    // ONLY thing this test pins about the submit — the handler's own empty-list
    // guard is unreachable from here and is pinned by test 7 instead.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it('the action stays DISABLED until the item\'s workspace is known', async () => {
    // The item loads, but carries no workspaceId — the state a slow item read
    // leaves the ribbon in.
    const { workspaceId: _omit, ...noWorkspace } = ITEM;
    const { calls } = mount({ '/api/items?type=variable-library': () => TWO_LIBRARIES }, noWorkspace);

    // POSITIVE CONTROL: the item DID load (its name renders), so a disabled
    // button below is "no workspace", not "nothing loaded yet".
    await waitFor(() => expect(screen.getAllByText('Contoso Sales').length).toBeGreaterThan(0), { timeout: 5000 });
    const btn = await findRibbonAction();
    // Reddens if `checkVariablesRibbonAction` stops gating on the workspace.
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // And no unfiltered list call went out on render.
    expect(calls.filter((c) => c.url.includes('type=variable-library'))).toEqual([]);
  });
});

describe('useCheckVariables — the hook\'s own guards', () => {
  it('refuses to list with no workspace, rather than listing EVERY workspace', async () => {
    const { calls } = installFetchMock({ '/api/items?type=variable-library': () => TWO_LIBRARIES });
    const { result } = renderHook(() => useCheckVariables(undefined));

    await act(async () => { await result.current.openCheckVariables(); });

    // Reddens if the `!workspaceId` guard is removed: the list call then goes
    // out with no workspace filter, which is exactly the defect it prevents.
    expect(calls.filter((c) => c.url.includes('type=variable-library'))).toEqual([]);
    expect(result.current.cvLoadError).toBe(CHECK_VARIABLES_NO_WORKSPACE);
    // The dialog still opens, so the refusal is SAID, not silent.
    expect(result.current.cvOpen).toBe(true);
  });

  it('a check over no libraries reports NOTHING, not "0 checked, all fine"', async () => {
    const { calls } = installFetchMock({
      '/api/items?type=variable-library': () => ({ ok: true, items: [], truncated: false }),
    });
    const { result } = renderHook(() => useCheckVariables('ws-1'));
    await act(async () => { await result.current.openCheckVariables(); });
    // POSITIVE CONTROL: the list genuinely resolved to zero libraries, so the
    // guard below is the one under test rather than a load that never finished.
    expect(result.current.cvLibraries).toEqual([]);

    await act(async () => { await result.current.checkAllVariables(); });

    // Reddens if `if (!libs.length) return;` is deleted: the results then become
    // `[]`, and the dialog renders "0 libraries checked; every variable
    // resolves" in a success bar over a check that examined nothing.
    expect(result.current.cvResults).toBeNull();
    expect(resolvePosts(calls)).toEqual([]);
  });
});
