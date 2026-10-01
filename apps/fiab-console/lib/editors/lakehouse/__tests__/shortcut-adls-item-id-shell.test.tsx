/**
 * Shortcut wizard in the REAL lakehouse editor: the ADLS picker authorizes the
 * lakehouse ITEM, not the shortcut registry key.
 *
 * The shell hands the shortcut hook `shortcutLakehouseId = activeContainer || id`,
 * and `useLakehouseBinding` sets `activeContainer` to the item's bound CONTAINER
 * NAME (`landing` here) as soon as the container list loads. That value is the
 * registry key the credential and the shortcut rows are saved under; it is not
 * an item id, and authorizing it as one answers 404 for every caller. So the
 * ADLS scope, the ADLS browse and the ADLS create must carry the item id
 * (`itemId`) separately.
 *
 * Nothing below injects a context: the shell, the binding hook, the shortcut
 * hook, the dialog and the tree all run for real; only `fetch` is mocked.
 *
 * WHAT BREAKS EACH LOAD-BEARING ASSERTION (assertion-design.md):
 *   - `binding container === 'landing'`: a fixture whose binding never
 *     resolves to a container, i.e. one that never reproduces the
 *     `activeContainer || id` != item id case. It guards the other assertions'
 *     premise.
 *   - scope / browse / create `itemId === 'lh-3904'`: the dialog or the shell
 *     passing `shortcutLakehouseId` (`landing`) as the item id, which is the
 *     defect: the routes would 404.
 *   - browse carries no `lakehouseId`: sending the registry key on the ADLS
 *     browse, which the route does not read.
 *   - create `lakehouseId` equals the listing's key and is `landing` or
 *     `lh-3904`: the shell handing the shortcut hook any other value (for
 *     example `'not-an-item-id'`), which saves the shortcut under a key the
 *     lakehouse never lists. Both values are accepted because the registry key
 *     is moving from the container name to the item id; either is this
 *     lakehouse's own key.
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

describe('shortcut wizard in the real editor — ADLS uses the item id, not the registry key', () => {
  it('scope, browse and create carry itemId=lh-3904 while the registry key is the bound container', async () => {
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

    // The premise: the real binding hook settles on the CONTAINER `landing`.
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

    // 3. Create: the item id rides beside the registry key.
    await user.click(await within(dialog).findByRole('button', { name: 'Next', hidden: true }));
    const nameInputs = await within(dialog).findAllByPlaceholderText('partner_products');
    await user.type(nameInputs[nameInputs.length - 1], 'partner_exports');
    await user.click(await within(dialog).findByRole('button', { name: 'Create', hidden: true }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/lakehouse/shortcuts') && c.init?.method === 'POST')).toBe(true));
    const post = JSON.parse(String(calls.find((c) => c.url.endsWith('/api/lakehouse/shortcuts') && c.init?.method === 'POST')!.init!.body));
    expect(post.targetType).toBe('adls');
    expect(post.targetUri).toBe('abfss://exports@partneracct.dfs.core.windows.net/');
    expect(post.itemId, 'create itemId').toBe('lh-3904');

    const listKey = params(calls.find((c) => c.url.includes('/api/lakehouse/shortcuts?'))!.url).get('lakehouseId');
    expect(post.lakehouseId, 'create saves under the key the lakehouse lists').toBe(listKey);
    expect(['landing', 'lh-3904'], `registry key ${post.lakehouseId}`).toContain(post.lakehouseId);
  });
});
