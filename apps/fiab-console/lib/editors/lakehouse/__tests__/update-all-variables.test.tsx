/**
 * #3538 — the Lakehouse ribbon's `Update all variables`, which Fabric has and
 * Loom did not (live side-by-side 2026-08-15 against `fabriccaplimitlessdatadev`;
 * `git grep "Update all variables" apps/fiab-console` returned ZERO at
 * ad01938db, re-measured before this file was written).
 *
 * WHAT EACH TEST WOULD BREAK ON (`assertion-design.md` "done" #1). Every
 * assertion below names the value that reddens it at its own site; the four
 * cases are chosen so that no two die for the same reason:
 *
 *   1. the ribbon entry exists AND fans out to EVERY library — deleting the
 *      ribbon action reddens the query; resolving only the first library
 *      reddens the call-count; folding failed rows into `resolved` reddens
 *      the per-row badge.
 *   2. a resolve that did not LAND reads as "not reached", never as "0 failed"
 *      (`deploy-integrity.md` R7) — collapsing the catch arm into
 *      `{ resolved: 0, failed: 0 }` reddens BOTH the badge and the summary.
 *   3. a bounded list says so — dropping `truncated` reddens the warning bar.
 *   4. zero libraries is guided and the submit is INERT — enabling the submit
 *      with nothing to resolve reddens the disabled assertion.
 *
 * NOT CLAIMED. This is jsdom, so per `ux-baseline.md` G1 it is not a
 * completion receipt for the surface; the in-browser click-walk is still owed.
 * What it does establish is that the command is wired to the two real routes
 * rather than to a label.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';

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

/** Distinct per-library payloads so a hook that resolved one twice is visible. */
const LIB1_OK = { ok: true, valueSet: 'prod', resolved: [{ name: 'sqlHost' }, { name: 'sqlDb' }] };
const LIB2_ONE_BAD = {
  ok: true,
  valueSet: 'dev',
  resolved: [{ name: 'featureFlag' }, { name: 'apiKey', error: 'secret-ref requires a Key Vault — set LOOM_KEY_VAULT_URI' }],
};

function mount(extra: Record<string, (url: string, init?: RequestInit) => unknown>) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => ({ ok: true, containers: [{ name: 'landing', url: 'u' }] }),
    '/api/lakehouse/paths': () => ({ ok: true, entries: [] }),
    '/api/cosmos-items/lakehouse/lh-3538': () => ITEM,
    ...extra,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-3538" />);
  return mock;
}

/**
 * The ribbon action, then the dialog it opens. Returns once the list resolved.
 *
 * `hidden: true` on the DIALOG query, and why — MEASURED HERE, not inherited.
 * Without it the first of these four tests failed at this line in a full-file
 * run (`1 failed | 3 passed`) and PASSED on its own (`-t "re-resolves EVERY"`,
 * 1502ms), which is the #4685 / #4698 shape: Fluent's modal bookkeeping marks
 * the live `.fui-DialogSurface` aria-hidden, so a role query is a race the
 * later tests happened to win. The RIBBON query above stays strict — it is
 * outside any modal, and it is the assertion that carries #3538's deliverable,
 * so it must not be widened.
 */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  // THE #3538 DELIVERABLE. Deleting the ribbon entry reddens exactly here, and
  // this is the only assertion in the file that does.
  const btn = await screen.findByRole('button', { name: /Update all variables/i }, { timeout: 5000 });
  await user.click(btn);
  return screen.findByRole('button', { name: /^Update all$/i, hidden: true }, { timeout: 5000 });
}

/** Resolve POSTs the run issued, in order. */
function resolvePosts(calls: Array<{ url: string; init?: RequestInit }>) {
  return calls.filter((c) => c.init?.method === 'POST' && /\/api\/items\/variable-library\/[^/]+\/resolve$/.test(c.url));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('#3538 — Lakehouse ribbon: Update all variables', () => {
  it('re-resolves EVERY visible library and reports each one\'s real counts', async () => {
    const user = userEvent.setup();
    const { calls } = mount({
      '/api/items?type=variable-library': () => TWO_LIBRARIES,
      '/api/items/variable-library/lib1/resolve': () => LIB1_OK,
      '/api/items/variable-library/lib2/resolve': () => LIB2_ONE_BAD,
    });

    const submit = await openDialog(user);
    // The list call is workspace-scoped, so a picker in this workspace never
    // re-resolves a sibling workspace's libraries. Reddens if `workspaceId` is
    // dropped from the query string.
    expect(calls.some((c) => c.url.includes('type=variable-library') && c.url.includes('workspaceId=ws-1'))).toBe(true);
    // Both library names are offered before anything is written — reddens if
    // the hook keeps only the first item.
    expect(await screen.findByText(/Shared connection strings, Env switches/)).toBeTruthy();

    await user.click(submit);

    // EXACTLY ONE POST PER LIBRARY. Reddens at 1 (only the first resolved), at
    // 3 (a re-entrant submit), and at 0 (a label with no handler).
    await waitFor(() => expect(resolvePosts(calls).map((c) => c.url)).toEqual([
      '/api/items/variable-library/lib1/resolve',
      '/api/items/variable-library/lib2/resolve',
    ]));

    // lib1: 2 clean rows. lib2: one clean, one failed — so `resolved` is 1, NOT
    // 2. Counting the failed row as resolved reddens this line.
    expect(await screen.findByText('2 resolved')).toBeTruthy();
    expect(await screen.findByText(/^1 resolved, 1 failed — secret-ref requires a Key Vault/)).toBeTruthy();
    // The value set each library actually answered with, not a constant.
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('dev')).toBeTruthy();
    // Summary distinguishes "a variable failed" from "a library was unreachable".
    expect(screen.getByText(/2 libraries refreshed; 1 variable\(s\) did not resolve\./)).toBeTruthy();

    // `no-fabric-dependency.md` — the default path touches no Fabric/Power BI
    // host. Paired with the positive assertions above, so deleting the feature
    // cannot satisfy it (`assertion-design.md` "done" #4).
    expect(calls.filter((c) => /fabric\.microsoft\.com|powerbi\.com|onelake\.dfs/.test(c.url))).toEqual([]);
  });

  it('a resolve that never landed reads as NOT REACHED, not as zero failures (R7)', async () => {
    const user = userEvent.setup();
    const { calls } = mount({
      '/api/items?type=variable-library': () => TWO_LIBRARIES,
      '/api/items/variable-library/lib1/resolve': () => LIB1_OK,
      // The route answering `ok:false` is the shape `parseJsonOrError` hands
      // back for a 4xx/5xx with a JSON body — i.e. the call reached the server
      // and was refused, which is NOT "zero variables failed".
      '/api/items/variable-library/lib2/resolve': () => ({ ok: false, error: 'not found' }),
    });

    const submit = await openDialog(user);
    await user.click(submit);
    await waitFor(() => expect(resolvePosts(calls).length).toBe(2));

    // Both reddens if the catch arm degrades to `{ resolved: 0, failed: 0 }`
    // with no `error`: the badge would then read "0 resolved" and the summary
    // "2 libraries refreshed".
    expect(await screen.findByText(/^Not reached: not found$/)).toBeTruthy();
    expect(screen.getByText(/1 of 2 libraries could not be reached\./)).toBeTruthy();
    // POSITIVE CONTROL — the library that DID answer still reports its count,
    // so the two arms are genuinely separated rather than both failing.
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
    // Reddens if `truncated` is dropped on the way through the hook — which is
    // the failure that would let a partial refresh read as a complete one.
    expect(await screen.findByText('Partial list')).toBeTruthy();
    expect(screen.getByText(/Showing the first 200 item\(s\) of type "variable-library"\./)).toBeTruthy();
  });

  it('zero libraries is a guided state and the submit is INERT', async () => {
    const user = userEvent.setup();
    const { calls } = mount({
      '/api/items?type=variable-library': () => ({ ok: true, items: [], truncated: false }),
    });

    const submit = await openDialog(user);
    // `ux-baseline.md` §6 — guided, not red, on a surface with nothing to do.
    expect(await screen.findByText(/No variable libraries in this workspace yet/)).toBeTruthy();
    expect(screen.queryByText('Partial list')).toBeNull();
    // Reddens if the submit is left enabled with nothing to resolve.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // …and it genuinely issues nothing. `user.click` on a disabled button is a
    // no-op, so this pins the handler's own guard rather than the DOM's.
    await user.click(submit);
    expect(resolvePosts(calls)).toEqual([]);
  });
});
