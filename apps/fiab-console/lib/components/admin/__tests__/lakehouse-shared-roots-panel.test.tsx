/**
 * LakehouseSharedRootsPanel — the "Keep root for <lakehouse>" Fix-it on the
 * readiness check "Lakehouses sharing a storage root" — and the result bar the
 * page shows after it.
 *
 * `fetch` is spied so the REAL `clientFetch` runs; every POST body is captured,
 * and the dry-run plan and the real request are answered separately.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  LakehouseKeepResultBar,
  LakehouseSharedRootsPanel,
  type KeepResult,
  type SharedRootGroupView,
} from '../lakehouse-shared-roots-panel';

const GROUP: SharedRootGroupView = {
  ids: ['lh-a', 'lh-b', 'lh-c'],
  roots: ['<container not recorded>/lakehouses/Sales'],
  members: [
    { id: 'lh-a', name: 'Sales', workspaceId: 'ws-1', href: '/items/lakehouse/lh-a', recorded: true, recycled: false },
    { id: 'lh-b', name: 'Sales copy', workspaceId: 'ws-2', href: '/items/lakehouse/lh-b', recorded: false, recycled: true },
    { id: 'lh-c', name: 'Sales silver', workspaceId: 'ws-3', href: '/items/lakehouse/lh-c', recorded: true, recycled: false },
  ],
};

const PLAN = {
  ok: true,
  dryRun: true,
  kept: { id: 'lh-a', name: 'Sales', container: 'bronze', root: 'lakehouses/Sales' },
  moving: [{ id: 'lh-b', name: 'Sales copy' }],
  unchanged: [{ id: 'lh-c', name: 'Sales silver', why: 'its directory silver/lakehouses/Sales is marked for it' }],
};

function mount(onResolved = vi.fn()) {
  render(
    <FluentProvider theme={webLightTheme}>
      <LakehouseSharedRootsPanel groups={[GROUP]} onResolved={onResolved} />
    </FluentProvider>,
  );
  return onResolved;
}

/** Answers the dry run with PLAN and the real request with `status`/`body`. */
function spyFetch(status: number, body: unknown) {
  const posts: Array<{ url: string; body: any }> = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const sent = init?.body ? JSON.parse(init.body) : undefined;
    posts.push({ url: String(input), body: sent });
    const [s, b] = sent?.dryRun ? [200, PLAN] : [status, body];
    return new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } }) as any;
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
    expect(screen.getAllByText('Recorded')).toHaveLength(2);
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

  // The dialog lists what the SERVER plan says changes, not every member.
  // FAILS IF it lists lh-c among the moving members (the old dialog listed
  // every other member), drops the reason lh-c stays, or does not say nothing
  // is copied or deleted. FAILS IF the plan request writes (it must carry
  // dryRun: true) or the real request is sent before "Keep root" is clicked.
  it('lists only the members the plan moves, and the ones it leaves, before anything is written', async () => {
    const posts = spyFetch(200, { ok: true });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Keep root for Sales$/ }));
    const moving = await screen.findByTestId('lakehouse-keep-plan-moving');
    expect(moving.textContent).toContain('Sales copy (lh-b)');
    expect(moving.textContent).not.toContain('lh-c');
    const unchanged = screen.getByTestId('lakehouse-keep-plan-unchanged');
    expect(unchanged.textContent).toContain('Sales silver (lh-c): its directory silver/lakehouses/Sales is marked for it');
    expect(screen.getByRole('dialog').textContent).toContain('Nothing is copied or deleted.');
    expect(posts.map((p) => p.body)).toEqual([{ itemId: 'lh-a', dryRun: true }]);
  });

  // FAILS IF the confirm posts the wrong item, posts it as a dry run, or does
  // not hand the outcome to the page (onResolved not called with it).
  it('confirms, then posts the keeper id and hands the outcome to the page', async () => {
    const outcome = {
      ok: true,
      kept: { name: 'Sales', container: 'bronze', root: 'lakehouses/Sales' },
      reassigned: [{ id: 'lh-b', name: 'Sales copy', container: 'landing', root: 'lakehouses/Sales-copy--lh-b' }],
      unchanged: [],
      failed: [],
    };
    const posts = spyFetch(200, outcome);
    const onResolved = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Keep root for Sales$/ }));
    await screen.findByTestId('lakehouse-keep-plan-moving');
    fireEvent.click(screen.getByRole('button', { name: 'Keep root' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(posts.map((p) => [new URL(p.url, 'http://x').pathname, p.body])).toEqual([
      ['/api/admin/lakehouse-roots/keep', { itemId: 'lh-a', dryRun: true }],
      ['/api/admin/lakehouse-roots/keep', { itemId: 'lh-a' }],
    ]);
    expect(onResolved.mock.calls[0][0]).toMatchObject({ ok: true, reassigned: outcome.reassigned });
  });

  // FAILS IF a 502 with per-member failures is handed on as success.
  it('hands a partial failure on as not ok', async () => {
    spyFetch(502, { ok: false, failed: [{ id: 'lh-b', name: 'Sales copy', error: 'the item was not found' }] });
    const onResolved = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Keep root for Sales$/ }));
    await screen.findByTestId('lakehouse-keep-plan-moving');
    fireEvent.click(screen.getByRole('button', { name: 'Keep root' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onResolved.mock.calls[0][0]).toMatchObject({ ok: false, failed: [{ id: 'lh-b' }] });
  });
});

describe('LakehouseKeepResultBar', () => {
  function show(result: KeepResult) {
    const onDismiss = vi.fn();
    render(
      <FluentProvider theme={webLightTheme}>
        <LakehouseKeepResultBar result={result} onDismiss={onDismiss} />
      </FluentProvider>,
    );
    return onDismiss;
  }

  // FAILS IF the moved member's new location, or the member left as it was and
  // why, is dropped from the success text.
  it('says which lakehouse kept the root, which moved where, and which stayed', () => {
    show({
      ok: true,
      kept: { name: 'Sales', container: 'bronze', root: 'lakehouses/Sales' },
      reassigned: [{ id: 'lh-b', name: 'Sales copy', container: 'landing', root: 'lakehouses/Sales-copy--lh-b' }],
      unchanged: [{ id: 'lh-c', name: 'Sales silver', why: 'its directory silver/lakehouses/Sales is marked for it' }],
    });
    const bar = screen.getByTestId('lakehouse-keep-result');
    expect(bar.textContent).toContain('Storage roots updated');
    expect(bar.textContent).toContain('keeps bronze/lakehouses/Sales');
    expect(bar.textContent).toContain('now uses landing/lakehouses/Sales-copy--lh-b');
    expect(bar.textContent).toContain('“Sales silver” was left as it is: its directory silver/lakehouses/Sales is marked for it');
  });

  // FAILS IF a partial failure is shown as success, or the failing member's
  // reason is dropped. FAILS IF Dismiss does not reach the page.
  it('shows a partial failure as an error, with the member and its reason, and can be dismissed', () => {
    const onDismiss = show({ ok: false, failed: [{ id: 'lh-b', name: 'Sales copy', error: 'the item was not found' }] });
    const bar = screen.getByTestId('lakehouse-keep-result');
    expect(bar.textContent).toContain('Not every lakehouse was updated');
    expect(bar.textContent).toContain('the item was not found');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
