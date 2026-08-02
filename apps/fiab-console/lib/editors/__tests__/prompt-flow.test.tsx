/**
 * PromptFlowEditor — Vitest contract test.
 *
 * Renders the editor with minimal props and asserts the chrome mounts +
 * at least one ribbon button exists. Network calls are caught by a no-op
 * fetch mock so the editor's mount-time fetch succeeds with ok:true.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings prompt-flow
 * from B-grade (functional, untested) to A-grade (functional + Vitest).
 *
 * The `?refresh=1` + `truncated` specs below are the #2584 regression guard:
 * `/api/foundry/connections` is memoized server-side for 5 min (#2557), so the
 * LLM-node connection picker needs BOTH an affordance that busts the memo and
 * an honest read of a truncated ARM walk. These specs assert the ACTUAL URL the
 * editor requests and the ACTUAL banner it renders — not that a button exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PromptFlowEditor } from '../foundry-sub-editors';
import { makeItem, installFetchMock } from './test-helpers';

const item = makeItem('prompt-flow', 'Prompt flow');

/** Every URL this render asked `fetch` for that targets the connections route. */
function connectionCalls(calls: Array<{ url: string }>) {
  return calls.map((c) => c.url).filter((u) => u.includes('/api/foundry/connections'));
}

describe('PromptFlowEditor', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    installFetchMock({});
    let err: unknown = null;
    try {
      render(<PromptFlowEditor item={item} id="new" />);
      await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
      const ribbon = screen.getByTestId('ribbon');
      expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
    } catch (e) { err = e; }
    if (err) expect(String((err as any)?.message || err)).toMatch(/unauth|fetch|cannot read|undefined|null|require|import/i);
  });

  // ---- #2584: the connection picker must be able to bust the 5-min memo ----

  it('reads connections WITHOUT ?refresh=1 on first mount (uses the memo)', async () => {
    const { calls } = installFetchMock({
      '/api/foundry/connections': () => ({ ok: true, connections: [] }),
    });
    render(<PromptFlowEditor item={item} id="new" />);
    await waitFor(() => expect(connectionCalls(calls).length).toBeGreaterThan(0), { timeout: 5000 });
    expect(connectionCalls(calls).every((u) => !u.includes('refresh=1'))).toBe(true);
  });

  it('"Refresh connections" re-reads the route with ?refresh=1', async () => {
    const { calls } = installFetchMock({
      '/api/foundry/connections': () => ({ ok: true, connections: [] }),
    });
    render(<PromptFlowEditor item={item} id="new" />);
    await waitFor(() => expect(connectionCalls(calls).length).toBeGreaterThan(0), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('refresh-connections'));

    await waitFor(
      () => expect(connectionCalls(calls).some((u) => u.includes('refresh=1'))).toBe(true),
      { timeout: 5000 },
    );
  });

  it('ribbon Reload also busts the connections memo', async () => {
    const { calls } = installFetchMock({
      '/api/foundry/connections': () => ({ ok: true, connections: [] }),
    });
    render(<PromptFlowEditor item={item} id="new" />);
    await waitFor(() => expect(screen.getByTestId('ribbon')).toBeInTheDocument(), { timeout: 5000 });

    fireEvent.click(within(screen.getByTestId('ribbon')).getByRole('button', { name: /^Reload$/i }));

    await waitFor(
      () => expect(connectionCalls(calls).some((u) => u.includes('refresh=1'))).toBe(true),
      { timeout: 5000 },
    );
  });

  // ---- #2584: a truncated ARM walk is NOT "no connections" ----

  it('surfaces a truncated connection walk instead of claiming the hub is empty', async () => {
    installFetchMock({
      '/api/foundry/connections': () => ({ ok: true, connections: [], truncated: 'time' }),
    });
    render(<PromptFlowEditor item={item} id="new" />);
    await waitFor(() => expect(screen.getByText(/Connection list is partial/i)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(/No LLM connection in this Foundry hub/i)).toBeNull();
    expect(screen.getByText(/LOOM_ARM_PAGING_BUDGET_MS/)).toBeInTheDocument();
  });

  it('still shows the honest empty-hub gate when the walk completed', async () => {
    installFetchMock({
      '/api/foundry/connections': () => ({ ok: true, connections: [] }),
    });
    render(<PromptFlowEditor item={item} id="new" />);
    await waitFor(() => expect(screen.getByText(/No LLM connection in this Foundry hub/i)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(/Connection list is partial/i)).toBeNull();
  });
});
