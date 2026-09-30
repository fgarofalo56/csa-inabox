/**
 * LakehouseSharedRootsPanel — the "Keep root for <lakehouse>" Fix-it on the
 * readiness check "Lakehouses sharing a storage root".
 *
 * `fetch` is spied so the REAL `clientFetch` runs; every POST body is captured.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { LakehouseSharedRootsPanel, type SharedRootGroupView } from '../lakehouse-shared-roots-panel';

const GROUP: SharedRootGroupView = {
  ids: ['lh-a', 'lh-b'],
  roots: ['<container not recorded>/lakehouses/Sales'],
  members: [
    { id: 'lh-a', name: 'Sales', workspaceId: 'ws-1', href: '/items/lakehouse/lh-a', recorded: true, recycled: false },
    { id: 'lh-b', name: 'Sales copy', workspaceId: 'ws-2', href: '/items/lakehouse/lh-b', recorded: false, recycled: true },
  ],
};

function mount(onResolved = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <LakehouseSharedRootsPanel groups={[GROUP]} onResolved={onResolved} />
    </FluentProvider>,
  );
  return onResolved;
}

function spyFetch(status: number, body: unknown) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    posts.push({ url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;
  });
  return posts;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LakehouseSharedRootsPanel', () => {
  // FAILS IF a member is rendered without a link to its item (no link named
  // "Sales"), or the recorded / recycled flags are not shown.
  it('lists each member as a link, with its recorded and recycled state', () => {
    spyFetch(200, { ok: true });
    mount();
    expect(screen.getByRole('link', { name: 'Sales' }).getAttribute('href')).toBe('/items/lakehouse/lh-a');
    expect(screen.getByRole('link', { name: 'Sales copy' }).getAttribute('href')).toBe('/items/lakehouse/lh-b');
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(screen.getByText('In recycle bin')).toBeInTheDocument();
  });

  // FAILS IF a recycled member can be made the keeper (its button enabled).
  // Paired positive: the live member's button is enabled.
  it('disables the action for a recycled member only', () => {
    spyFetch(200, { ok: true });
    mount();
    expect((screen.getByRole('button', { name: /Keep root for Sales copy/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Keep root for Sales$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  // FAILS IF the button posts without confirming (a POST before "Keep root" in
  // the dialog), if the dialog does not say nothing is copied or deleted, or if
  // the POST names the wrong item or route. FAILS IF the page is not asked to
  // re-run the check afterwards (onResolved not called).
  it('confirms, then posts the keeper id and reports the result', async () => {
    const posts = spyFetch(200, {
      ok: true,
      kept: { name: 'Sales', container: 'bronze', root: 'lakehouses/Sales' },
      reassigned: [{ id: 'lh-b', name: 'Sales copy', container: 'landing', root: 'lakehouses/Sales-copy--lh-b' }],
      failed: [],
    });
    const onResolved = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Keep root for Sales$/ }));
    expect(posts).toEqual([]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Nothing is copied or deleted.');
    expect(dialog.textContent).toContain('Sales copy (lh-b)');
    fireEvent.click(screen.getByRole('button', { name: 'Keep root' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(posts.map((p) => [new URL(p.url, 'http://x').pathname, p.body])).toEqual([
      ['/api/admin/lakehouse-roots/keep', { itemId: 'lh-a' }],
    ]);
    const result = await screen.findByTestId('lakehouse-keep-result');
    expect(result.textContent).toContain('Storage roots updated');
    expect(result.textContent).toContain('now uses landing/lakehouses/Sales-copy--lh-b');
  });

  // FAILS IF a 502 with per-member failures is shown as success, or the
  // failing member's reason is dropped.
  it('shows a partial failure as an error, with the member and its reason', async () => {
    spyFetch(502, { ok: false, failed: [{ id: 'lh-b', name: 'Sales copy', error: 'the item was not found' }] });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Keep root for Sales$/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Keep root' }));
    const result = await screen.findByTestId('lakehouse-keep-result');
    expect(result.textContent).toContain('Not every lakehouse was updated');
    expect(result.textContent).toContain('Sales copy');
    expect(result.textContent).toContain('the item was not found');
  });
});
