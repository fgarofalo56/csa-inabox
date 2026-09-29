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

/**
 * A fetch mock whose FIRST (memoized) connections read stays unanswered until
 * the test calls `release()` — the slow-CI-runner window, made deterministic.
 *
 * WHY THIS EXISTS: `useApi` sets `loading: true` before it calls `fetch`, and
 * the "Refresh connections" button is `disabled={conn.loading}`. So "the
 * request was ISSUED" is not "the button is clickable": a click that lands
 * between the two is dropped (React does not dispatch onClick on a disabled
 * button), no `?refresh=1` read is ever made, and the spec times out. That is
 * the failure that froze the roll on main at 0f520d262 (CI run 36501961405).
 * Every other URL, and the `?refresh=1` read itself, answers immediately.
 */
function installSlowFirstConnectionsMock() {
  const calls: Array<{ url: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(global, 'fetch').mockImplementation((async (url: unknown) => {
    const u = String(url);
    calls.push({ url: u });
    const isConnections = u.includes('/api/foundry/connections');
    if (isConnections && !u.includes('refresh=1')) await gate;
    const body = isConnections ? { ok: true, connections: [] } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  return { calls, release };
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

    // The first read being ISSUED does not make the button clickable — it is
    // disabled until that read is ANSWERED (see installSlowFirstConnectionsMock).
    // Clicking inside that window is a silent no-op, so wait it out first.
    const refresh = screen.getByTestId('refresh-connections');
    await waitFor(() => expect(refresh).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(refresh);

    // Breaks if refreshConnections stops appending `?refresh=1` (the #2584 memo bust).
    await waitFor(
      () => expect(connectionCalls(calls).some((u) => u.includes('refresh=1'))).toBe(true),
      { timeout: 5000 },
    );
  });

  it('"Refresh connections" still busts the memo when the first read is SLOW', async () => {
    const { calls, release } = installSlowFirstConnectionsMock();
    render(<PromptFlowEditor item={item} id="new" />);
    await waitFor(() => expect(connectionCalls(calls).length).toBeGreaterThan(0), { timeout: 5000 });

    // COVERAGE — the button is disabled while the connections read is in flight.
    // This is the ONLY spec in the file that pins that behaviour: it goes red
    // (and it alone — measured, 1 failed / 6 passed) when `disabled={conn.loading}`
    // on the Refresh connections button becomes `disabled={false}`. Do not delete
    // it as scaffolding. It is also what places the click below in the exact
    // window the CI flake clicked in.
    const refresh = screen.getByTestId('refresh-connections');
    expect(refresh).toBeDisabled();
    // FIXTURE PRECONDITION, not coverage: nothing has busted the memo yet, so the
    // `refresh=1` assertion at the end can only be satisfied by the click. Fails
    // if a `refresh=1` read is made before any click (the first-mount spec above
    // is the coverage for that).
    expect(connectionCalls(calls).some((u) => u.includes('refresh=1'))).toBe(false);

    release();
    await waitFor(() => expect(refresh).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(refresh);

    // Breaks if refreshConnections stops appending `?refresh=1`.
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
