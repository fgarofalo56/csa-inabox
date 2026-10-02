/**
 * Shortcut wizard in the REAL lakehouse editor: the ADLS picker, browse and
 * create all name the lakehouse ITEM, never the file-browser's bound
 * CONTAINER name.
 *
 * `useLakehouseBinding` sets `activeContainer` to the item's bound CONTAINER
 * NAME (`landing` here) as soon as the container list loads — that state
 * drives the Files pane, not the shortcut registry. The shell hands the
 * shortcut hook `shortcutLakehouseId = isNewItem ? '' : id`: the registry key
 * IS the item id, so a row the hook creates is always filed under the item,
 * never under `activeContainer`. The dialog computes the SAME item id
 * (`isNewItem ? '' : id`) independently for the ADLS scope and browse calls,
 * so all three (scope, browse, create) carry the identical value.
 *
 * Nothing below injects a context: the shell, the binding hook, the shortcut
 * hook, the dialog and the tree all run for real; only `fetch` is mocked.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md):
 *   - `binding container === 'landing'`: a fixture whose binding never
 *     resolves to a container, i.e. one that never reproduces the
 *     `activeContainer !== id` case. It guards the other assertions' premise
 *     (that `activeContainer` and the item id are genuinely different
 *     strings, so a test that silently used one for the other would not be
 *     caught by accident).
 *   - scope / browse `itemId === 'lh-3904'`: the dialog passing
 *     `activeContainer` ('landing') as the item id, which the routes would
 *     404 on.
 *   - browse carries no `lakehouseId`: sending the registry key on the ADLS
 *     browse, which the route does not read.
 *   - create `post.lakehouseId === 'lh-3904'`: the shell regressing to
 *     `shortcutLakehouseId: activeContainer || id` (the pre-#4790 shape),
 *     which would file the row under `landing` instead of the item, and
 *     which the merged route's outer item check would 404 on in production.
 *   - create carries no `itemId`: a stale caller re-adding the retired
 *     separate item-id field to the POST body.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { waitFor, cleanup, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';

const CONTAINERS = {
  ok: true,
  containers: [
    { name: 'bronze', url: 'https://loomlake.dfs.core.windows.net/bronze' },
    { name: 'landing', url: 'https://loomlake.dfs.core.windows.net/landing' },
  ],
};

const ITEM = {
  id: 'lh-3904',
  workspaceId: 'ws-1',
  itemType: 'lakehouse',
  displayName: 'Contoso Sales',
  state: { provisioning: { status: 'created', secondaryIds: { container: 'landing', rootPath: 'lakehouses/Contoso Sales' } } },
};

const SCOPE = {
  ok: true,
  data: {
    unrestricted: false,
    locations: [
      { account: 'loomlake', container: 'landing', dfsHost: 'loomlake.dfs.core.windows.net', source: 'lake' },
      { account: 'partneracct', container: 'exports', dfsHost: 'partneracct.dfs.core.windows.net', source: 'lakehouse', lakehouseName: 'Partner' },
    ],
  },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const params = (url: string) => new URL(url, 'http://localhost').searchParams;

describe('shortcut wizard in the real editor — ADLS uses the item id, never the bound container name', () => {
  it('scope, browse and create all carry itemId/lakehouseId=lh-3904, while the file browser binds the container landing', async () => {
    const user = userEvent.setup();
    const { calls } = installFetchMock({
      '/api/lakehouse/containers': () => CONTAINERS,
      '/api/lakehouse/paths': () => ({ ok: true, paths: [] }),
      '/api/cosmos-items/lakehouse/lh-3904': () => ITEM,
      '/api/lakehouse/shortcuts/adls-scope': () => SCOPE,
      '/api/lakehouse/shortcuts/browse': () => ({ ok: true, data: { entries: [] } }),
      '/api/lakehouse/shortcuts': () => ({ ok: true, data: [] }),
    });
    renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-3904" />);

    // The premise: the real binding hook settles on the CONTAINER `landing`,
    // a different string than the item id (`lh-3904`) — so any assertion
    // below that passed by accident (one value standing in for the other)
    // would be exposed by this divergence.
    await waitFor(() => expect(
      calls.some((c) => c.url.includes('/api/lakehouse/paths') && params(c.url).get('container') === 'landing'),
      'binding container === landing',
    ).toBe(true));

    await user.click(await screen.findByRole('tab', { name: /Shortcuts/ }));
    await user.click((await screen.findAllByRole('button', { name: /^New shortcut$/ }))[0]);
    // Fluent's DialogSurface is aria-hidden under jsdom (tabster cannot establish a
    // real focus trap), so role queries in and under it need hidden:true.
    const dialog = await screen.findByRole('dialog', { hidden: true }, { timeout: 5000 });
    await user.click(await within(dialog).findByRole('button', { name: /ADLS Gen2 \/ Azure Blob/, hidden: true }));
    await user.click(await within(dialog).findByRole('button', { name: 'Next', hidden: true }));

    // 1. The scope request names the item.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/shortcuts/adls-scope'))).toBe(true));
    const scopeCall = calls.find((c) => c.url.includes('/api/lakehouse/shortcuts/adls-scope'))!;
    expect(params(scopeCall.url).get('itemId'), 'scope itemId').toBe('lh-3904');

    // 2. Pick a bound container; the tree browses it under the item id.
    // fireEvent, as in mirror-source-mismatch.test.tsx: user.click on the Fluent
    // Dropdown inside the aria-hidden surface leaves it collapsed under jsdom.
    fireEvent.click(await within(dialog).findByRole('combobox', { name: /Container/, hidden: true }));
    fireEvent.click(await screen.findByRole('option', { name: /partneracct \/ exports/, hidden: true }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/shortcuts/browse'))).toBe(true));
    const browse = params(calls.find((c) => c.url.includes('/api/lakehouse/shortcuts/browse'))!.url);
    expect(browse.get('sourceType')).toBe('adls');
    expect(browse.get('account')).toBe('partneracct');
    expect(browse.get('container')).toBe('exports');
    expect(browse.get('itemId'), 'browse itemId').toBe('lh-3904');
    expect(browse.has('lakehouseId'), 'browse carries no registry key').toBe(false);

    // 3. Create: the registry key IS the item id, and there is no separate itemId.
    await user.click(await within(dialog).findByRole('button', { name: 'Next', hidden: true }));
    const nameInputs = await within(dialog).findAllByPlaceholderText('partner_products');
    await user.type(nameInputs[nameInputs.length - 1], 'partner_exports');
    await user.click(await within(dialog).findByRole('button', { name: 'Create', hidden: true }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/lakehouse/shortcuts') && c.init?.method === 'POST')).toBe(true));
    const post = JSON.parse(String(calls.find((c) => c.url.endsWith('/api/lakehouse/shortcuts') && c.init?.method === 'POST')!.init!.body));
    expect(post.targetType).toBe('adls');
    expect(post.targetUri).toBe('abfss://exports@partneracct.dfs.core.windows.net/');
    expect(post).not.toHaveProperty('itemId');

    const listKey = params(calls.find((c) => c.url.includes('/api/lakehouse/shortcuts?'))!.url).get('lakehouseId');
    expect(post.lakehouseId, 'create saves under the key the lakehouse lists').toBe(listKey);
    expect(post.lakehouseId, 'create saves under the item id, never the bound container name').toBe('lh-3904');
  });
});
