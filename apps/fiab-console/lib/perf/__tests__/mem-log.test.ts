import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MB = 1024 * 1024;
const heapLimit = { bytes: 1000 * MB };
vi.mock('node:v8', () => ({
  getHeapStatistics: () => ({ heap_size_limit: heapLimit.bytes }),
}));

import {
  resolveIntervalMs,
  startMemLog,
  stopMemLog,
  WARN_COOLDOWN_MS,
} from '../mem-log';

function mockUsage(heapUsedMB: number) {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: 1200 * MB,
    heapTotal: 1000 * MB,
    heapUsed: heapUsedMB * MB,
    external: 30 * MB,
    arrayBuffers: 5 * MB,
  } as NodeJS.MemoryUsage);
}

describe('mem-log', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.LOOM_MEM_LOG_INTERVAL_MS;
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUsage(500);
  });
  afterEach(() => {
    stopMemLog();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits exactly one line per interval (2 intervals -> 2 lines, 0 before the first)', () => {
    expect(startMemLog()).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(log).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('interval 0 disables: no timer, no lines (a ticking timer would give >0)', () => {
    process.env.LOOM_MEM_LOG_INTERVAL_MS = '0';
    expect(startMemLog()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(log).toHaveBeenCalledTimes(0);
  });

  it('clamps the interval to 10000..600000 and falls back on garbage', () => {
    expect(resolveIntervalMs('5')).toBe(10_000);
    expect(resolveIntervalMs('99999999')).toBe(600_000);
    expect(resolveIntervalMs('abc')).toBe(60_000);
    expect(resolveIntervalMs(undefined)).toBe(60_000);
    expect(resolveIntervalMs('30000')).toBe(30_000);
  });

  it('unrefs the timer (a ref-d timer would keep the process alive)', () => {
    const unref = vi.fn();
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      const t = real(fn, ms);
      t.unref = (() => { unref(); return t; }) as typeof t.unref;
      return t;
    }) as typeof setInterval);
    startMemLog();
    expect(unref).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('the line is JSON after the [mem] prefix with exactly the expected numeric keys', () => {
    startMemLog();
    vi.advanceTimersByTime(60_000);
    const line = String(log.mock.calls[0][0]);
    expect(line.startsWith('[mem] ')).toBe(true);
    const parsed = JSON.parse(line.slice('[mem] '.length));
    expect(Object.keys(parsed).sort()).toEqual(
      ['arrayBuffersMB', 'externalMB', 'heapLimitMB', 'heapUsedMB', 'rssMB'],
    );
    // a string-valued field (e.g. a path or id leaking in) would fail here
    for (const v of Object.values(parsed)) expect(typeof v).toBe('number');
    expect(parsed.rssMB).toBe(1200);
    expect(parsed.heapLimitMB).toBe(1000);
  });

  it('no WARN at 84% of limit; WARN fires at 86%, then rate-limits for 10 min', () => {
    mockUsage(840);
    startMemLog();
    vi.advanceTimersByTime(60_000);
    expect(warn).toHaveBeenCalledTimes(0);

    mockUsage(860);
    vi.advanceTimersByTime(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    // a limiter that never rate-limits would reach 5 here
    vi.advanceTimersByTime(4 * 60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WARN_COOLDOWN_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
