/**
 * EstatePowerPanel poll pacing (2026-10-20, ARM read throttling).
 * Fake timers; jsdom only - NOT a G1 browser E2E. Each `it` names the input that breaks it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));
const jsonGet = vi.fn();
vi.mock('@/lib/components/admin-scaling/json-get', () => ({ jsonGet: (...a: unknown[]) => jsonGet(...a) }));

import { EstatePowerPanel } from '../estate-power-panel';
import { nextPollDelayMs, isThrottledResponse } from '../estate-power-poll';

const styles = new Proxy({}, { get: (_t, k) => String(k) }) as Record<string, string>;
const mount = () => render(<FluentProvider theme={webLightTheme}><EstatePowerPanel styles={styles} /></FluentProvider>);

const resuming = (over: Record<string, unknown> = {}) => ({
  ok: true,
  state: 'RESUMING',
  estateId: 'loom:e',
  progress: [],
  resources: [],
  throttled: 0,
  ...over,
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => { vi.useFakeTimers(); jsonGet.mockReset(); });
afterEach(() => { cleanup(); setHidden(false); vi.useRealTimers(); });

/** Flush the mount fetch + state updates without advancing the poll clock. */
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('nextPollDelayMs', () => {
  it.each([[0, 10_000], [1, 20_000], [2, 40_000], [3, 60_000], [9, 60_000], [-1, 10_000], [NaN, 10_000]])(
    'streak %s -> %s ms (breaks if the cap or the base moves)', (streak, ms) => {
      expect(nextPollDelayMs(streak as number)).toBe(ms);
    },
  );
  it('isThrottledResponse: only a positive numeric `throttled` counts ("3" and 0 do not)', () => {
    expect(isThrottledResponse({ throttled: 2 })).toBe(true);
    expect(isThrottledResponse({ throttled: 0 })).toBe(false);
    expect(isThrottledResponse({ throttled: '3' })).toBe(false);
    expect(isThrottledResponse(null)).toBe(false);
  });
});

describe('EstatePowerPanel polling', () => {
  it('RESUMING polls every 10 s while visible: 1 mount read + 2 more after 20 s (breaks if the interval changes)', async () => {
    jsonGet.mockResolvedValue(resuming());
    mount();
    await settle();
    expect(jsonGet).toHaveBeenCalledTimes(1);
    await tick(20_000);
    expect(jsonGet).toHaveBeenCalledTimes(3);
  });

  it('a HIDDEN tab sends NO reads however long it stays hidden (breaks at 7 if the poll ignores document.hidden)', async () => {
    jsonGet.mockResolvedValue(resuming());
    mount();
    await settle();
    expect(jsonGet).toHaveBeenCalledTimes(1);
    setHidden(true);
    await tick(60_000);
    expect(jsonGet).toHaveBeenCalledTimes(1);
  });

  it('returning to the tab reads IMMEDIATELY once, then resumes the cadence', async () => {
    jsonGet.mockResolvedValue(resuming());
    mount();
    await settle();
    setHidden(true);
    await tick(30_000);
    expect(jsonGet).toHaveBeenCalledTimes(1);
    setHidden(false);
    await settle();
    expect(jsonGet).toHaveBeenCalledTimes(2);
    await tick(10_000);
    expect(jsonGet).toHaveBeenCalledTimes(3);
  });

  it('while the last read reported throttling it backs off 10 -> 20 -> 40 -> 60 s (reads at t=0,20,60,120 only)', async () => {
    jsonGet.mockResolvedValue(resuming({ throttled: 2 }));
    mount();
    await settle(); // t=0: read #1, streak 1 -> next delay 20 s
    expect(jsonGet).toHaveBeenCalledTimes(1);
    await tick(19_999);
    expect(jsonGet).toHaveBeenCalledTimes(1); // breaks at 2 if the base 10 s cadence is kept
    await tick(1); // t=20 s: read #2, streak 2 -> 40 s
    expect(jsonGet).toHaveBeenCalledTimes(2);
    await tick(39_999);
    expect(jsonGet).toHaveBeenCalledTimes(2);
    await tick(1); // t=60 s: read #3, streak 3 -> 60 s cap
    expect(jsonGet).toHaveBeenCalledTimes(3);
    await tick(60_000); // t=120 s: read #4
    expect(jsonGet).toHaveBeenCalledTimes(4);
  });

  it('the back-off resets to 10 s as soon as a read is not throttled', async () => {
    jsonGet
      .mockResolvedValueOnce(resuming({ throttled: 1 }))
      .mockResolvedValue(resuming({ throttled: 0 }));
    mount();
    await settle(); // read #1 throttled -> next in 20 s
    await tick(20_000); // read #2 clean -> next in 10 s
    expect(jsonGet).toHaveBeenCalledTimes(2);
    await tick(10_000);
    expect(jsonGet).toHaveBeenCalledTimes(3);
  });

  it('a throttled read shows a calm INFO bar with the retry time - not the red error bar - and no failure wording', async () => {
    jsonGet.mockResolvedValue(resuming({ throttled: 2 }));
    const { container } = mount();
    await settle();
    expect(screen.getByText('Azure is rate-limiting power-state reads')).toBeTruthy();
    expect(screen.getByText(/Next automatic retry at/)).toBeTruthy();
    expect(screen.getByText(/no failure was recorded/)).toBeTruthy();
    // Fluent renders intent as a class on the bar: an error bar here would be a red banner.
    expect(container.querySelector('.fui-MessageBar')).toBeTruthy();
    // The red error bar carries the title 'Estate power' (the page heading also says it, outside any bar).
    for (const el of screen.queryAllByText('Estate power')) expect(el.closest('.fui-MessageBar')).toBeNull();
  });

  it('NOT throttled: no rate-limit bar at all (breaks if the bar renders unconditionally)', async () => {
    jsonGet.mockResolvedValue(resuming({ throttled: 0 }));
    mount();
    await settle();
    expect(screen.queryByText('Azure is rate-limiting power-state reads')).toBeNull();
  });
});
