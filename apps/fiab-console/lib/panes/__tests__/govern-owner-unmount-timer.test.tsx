/**
 * GovernOwnerPane: the on-open refresh's delayed re-read must never outlive the
 * pane.
 *
 * The flake this pins (measured 2026-09-30, `vitest (node 20)` job 109925057459
 * on PR #4839): every test passed, but the job failed on two unhandled
 * `ReferenceError: window is not defined` raised AFTER the jsdom environment was
 * torn down. The pane's `refresh()` scheduled `setTimeout(() => load(), 1500)`
 * on mount and nothing cleared it, so when a worker outlived its tests by 1.5s
 * the callback ran `setError(null)` against a dead DOM and React read
 * `window.event`.
 *
 * Fake timers make the window deterministic: we arm the timer, unmount, then
 * advance the clock well past 1500ms.
 *
 * What value breaks each assertion:
 *   - `clearSpy toHaveBeenCalledWith(armedId)`: an effect cleanup that does not
 *     clear the stored timer id (the cleanup's `clearTimeout` deleted) — the id
 *     returned for the 1500ms timer is never passed to clearTimeout.
 *   - `ownerCalls` unchanged after advancing: the original defect (no cleanup
 *     AND no alive guard in the callback). The fired callback calls load(),
 *     which calls clientFetch('/api/governance/govern/owner') — count 1 → 2.
 *     DISCLOSED: with ONLY the cleanup removed this assertion stays green,
 *     because the callback's alive guard still stops load(); the clearTimeout
 *     assertion above is what kills that mutant.
 *   - `timersAfterUnmount` empty (in-flight test): a `finally` that schedules
 *     the re-read without checking the pane is still mounted. The refresh POST
 *     resolves after unmount, so an unguarded `finally` arms a fresh 1500ms
 *     timer that no cleanup will ever clear.
 *   - `consoleError` not called: any React warning/error logged on the late
 *     path. Weak on its own (React 19 does not warn on an unmounted setState),
 *     so it is never the only assertion in a test.
 * Positive controls pin that the path under test was actually reached: the
 * 1500ms timer IS armed before unmount (test 1), the refresh POST IS issued
 * (test 2), and — without unmounting — the timer DOES fire and re-read (test 3),
 * so "no second owner read" cannot be satisfied by a timer that never existed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { ReactNode } from 'react';

vi.mock('@/lib/components/governance-shell', () => ({
  GovernanceShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/components/copilot-pane', () => ({ openCopilot: vi.fn() }));

const REFRESH_DELAY_MS = 1500;
let ownerCalls = 0;
let refreshCalls = 0;
// When set, the refresh POST waits on this promise (lets a test unmount while
// the dispatch is still in flight).
let refreshGate: Promise<void> | null = null;

// Plain objects, not `Response`: `Response.json()` reads a stream, which can
// settle outside the microtask queue and would make the flush below racy.
vi.mock('@/lib/client-fetch', () => ({
  clientFetch: async (url: string) => {
    if (url.includes('/api/governance/govern/refresh')) {
      refreshCalls += 1;
      if (refreshGate) await refreshGate;
      return { json: async () => ({ ok: true, dispatched: true }) };
    }
    ownerCalls += 1;
    return { json: async () => ({ ok: false, error: 'fixture: posture read not under test' }) };
  },
}));

import { GovernOwnerPane } from '../govern-owner';

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <GovernOwnerPane />
    </FluentProvider>,
  );
}

/** Drain pending microtasks (mocked fetch → json → state) inside act(). */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

let setSpy: ReturnType<typeof vi.spyOn>;
let clearSpy: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

/** Ids of every setTimeout(…, 1500) call recorded so far (the re-read timer). */
function refreshTimerIds(): unknown[] {
  return setSpy.mock.calls
    .map((call, i) => ({ delay: call[1], id: setSpy.mock.results[i]?.value }))
    .filter((c) => c.delay === REFRESH_DELAY_MS)
    .map((c) => c.id);
}

beforeEach(() => {
  ownerCalls = 0;
  refreshCalls = 0;
  refreshGate = null;
  vi.useFakeTimers();
  // Spy AFTER faking so the recorded ids are the fake clock's ids.
  setSpy = vi.spyOn(globalThis, 'setTimeout');
  clearSpy = vi.spyOn(globalThis, 'clearTimeout');
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GovernOwnerPane delayed re-read vs unmount', () => {
  it('clears the armed re-read timer on unmount; it never fires a late load()', async () => {
    const view = mount();
    await flush();

    // Positive control: the on-open refresh resolved and armed the re-read.
    expect(refreshCalls).toBe(1);
    expect(ownerCalls).toBe(1);
    const armed = refreshTimerIds();
    expect(armed).toHaveLength(1);
    const armedId = armed[0];

    view.unmount();

    expect(clearSpy).toHaveBeenCalledWith(armedId);

    // Well past the 1500ms delay: a surviving callback would re-read here.
    expect(() => vi.advanceTimersByTime(REFRESH_DELAY_MS * 4)).not.toThrow();
    await flush();
    expect(ownerCalls).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a refresh still in flight at unmount schedules no re-read when it resolves', async () => {
    let release!: () => void;
    refreshGate = new Promise<void>((r) => { release = r; });
    const view = mount();
    await flush();

    // Positive control: the dispatch is issued and still pending, so no timer yet.
    expect(refreshCalls).toBe(1);
    expect(refreshTimerIds()).toHaveLength(0);

    view.unmount();
    const before = setSpy.mock.calls.length;
    release();
    await flush();

    const timersAfterUnmount = setSpy.mock.calls.slice(before).filter((c) => c[1] === REFRESH_DELAY_MS);
    expect(timersAfterUnmount).toEqual([]);

    vi.advanceTimersByTime(REFRESH_DELAY_MS * 4);
    await flush();
    expect(ownerCalls).toBe(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('control: while still mounted the timer fires and re-reads the posture', async () => {
    mount();
    await flush();
    expect(ownerCalls).toBe(1);

    vi.advanceTimersByTime(REFRESH_DELAY_MS);
    await flush();
    expect(ownerCalls).toBe(2);
  });
});
