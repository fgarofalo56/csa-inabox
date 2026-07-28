/**
 * U13 — pipeline-debug-overlay logic tests: the pub/sub store, status
 * derivation/mapping, and the shared run poller (fake timers, mocked fetch).
 * Pure-logic coverage (the render harness is exercised in-browser per G1).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  publishRunOverlay, clearRunOverlay, getRunOverlay,
  deriveOverallStatus, runStatusToNodeStatus, isTerminalRunStatus,
  fmtDuration, runStatusDetail, startRunOverlayPolling,
  type ActivityRunOverlayRow, type RunOverlayState,
} from '../pipeline-debug-overlay';

function row(partial: Partial<ActivityRunOverlayRow> & { name: string }): ActivityRunOverlayRow {
  return { id: partial.name, type: 'Copy', ...partial };
}

function state(rows: ActivityRunOverlayRow[], over?: Partial<RunOverlayState>): RunOverlayState {
  return {
    runId: 'run-1', source: 'debug', rows,
    overall: deriveOverallStatus(rows), polling: false, updatedAt: Date.now(),
    ...over,
  };
}

afterEach(() => {
  clearRunOverlay('p1');
  clearRunOverlay('p2');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('run overlay store', () => {
  it('publishes, reads back, and clears per key', () => {
    expect(getRunOverlay('p1')).toBeNull();
    publishRunOverlay('p1', state([row({ name: 'Copy1', status: 'InProgress' })]));
    expect(getRunOverlay('p1')?.rows[0].name).toBe('Copy1');
    expect(getRunOverlay('p2')).toBeNull(); // keyed isolation
    clearRunOverlay('p1');
    expect(getRunOverlay('p1')).toBeNull();
  });

  it('last write wins for the same key', () => {
    publishRunOverlay('p1', state([], { runId: 'a' }));
    publishRunOverlay('p1', state([], { runId: 'b' }));
    expect(getRunOverlay('p1')?.runId).toBe('b');
  });

  it('ignores an empty key (no crash, nothing stored)', () => {
    publishRunOverlay('', state([]));
    expect(getRunOverlay('')).toBeNull();
  });
});

describe('deriveOverallStatus', () => {
  it('is Queued with no rows', () => {
    expect(deriveOverallStatus([])).toBe('Queued');
  });
  it('is InProgress while any activity is non-terminal', () => {
    expect(deriveOverallStatus([
      row({ name: 'a', status: 'Succeeded' }),
      row({ name: 'b', status: 'InProgress' }),
    ])).toBe('InProgress');
  });
  it('surfaces Failed immediately, even mid-run', () => {
    expect(deriveOverallStatus([
      row({ name: 'a', status: 'Failed' }),
      row({ name: 'b', status: 'InProgress' }),
    ])).toBe('Failed');
  });
  it('is Succeeded when every activity is terminal-green (Skipped allowed)', () => {
    expect(deriveOverallStatus([
      row({ name: 'a', status: 'Succeeded' }),
      row({ name: 'b', status: 'Skipped' }),
    ])).toBe('Succeeded');
  });
  it('is Cancelled when all terminal with a Cancelled and no Failed', () => {
    expect(deriveOverallStatus([
      row({ name: 'a', status: 'Succeeded' }),
      row({ name: 'b', status: 'Cancelled' }),
    ])).toBe('Cancelled');
  });
});

describe('runStatusToNodeStatus', () => {
  it('maps the ADF vocabulary onto the canvas-node-kit statuses', () => {
    expect(runStatusToNodeStatus('Succeeded')).toBe('succeeded');
    expect(runStatusToNodeStatus('Failed')).toBe('failed');
    expect(runStatusToNodeStatus('Skipped')).toBe('skipped');
    expect(runStatusToNodeStatus('Cancelled')).toBe('warning');
    expect(runStatusToNodeStatus('InProgress')).toBe('running');
    expect(runStatusToNodeStatus('Queued')).toBe('running');
    expect(runStatusToNodeStatus('Cancelling')).toBe('running');
    expect(runStatusToNodeStatus(undefined)).toBe('idle');
    expect(runStatusToNodeStatus('SomethingNew')).toBe('idle');
  });
});

describe('isTerminalRunStatus / fmtDuration / runStatusDetail', () => {
  it('marks the four terminal states', () => {
    for (const s of ['Succeeded', 'Failed', 'Cancelled', 'Skipped']) {
      expect(isTerminalRunStatus(s)).toBe(true);
    }
    expect(isTerminalRunStatus('InProgress')).toBe(false);
    expect(isTerminalRunStatus(undefined)).toBe(false);
  });

  it('formats durations across magnitudes', () => {
    expect(fmtDuration(undefined)).toBe('—');
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(750)).toBe('750 ms');
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
  });

  it('prefers errorCode on failure, duration on success, Running… mid-flight', () => {
    expect(runStatusDetail(row({ name: 'a', status: 'Failed', errorCode: 'BadRequest' }))).toBe('BadRequest');
    expect(runStatusDetail(row({ name: 'a', status: 'Failed' }))).toBe('Failed');
    expect(runStatusDetail(row({ name: 'a', status: 'Succeeded', durationMs: 1500 }))).toBe('1.5s');
    expect(runStatusDetail(row({ name: 'a', status: 'Succeeded' }))).toBe('Succeeded');
    expect(runStatusDetail(row({ name: 'a', status: 'InProgress' }))).toBe('Running…');
    expect(runStatusDetail(row({ name: 'a', status: 'Queued' }))).toBe('Queued');
  });
});

describe('startRunOverlayPolling', () => {
  it('seeds Queued immediately, streams rows, and stops when all-terminal', async () => {
    vi.useFakeTimers();
    const pages: ActivityRunOverlayRow[][] = [
      [row({ name: 'Copy1', status: 'InProgress' })],
      [row({ name: 'Copy1', status: 'Succeeded', durationMs: 900 })],
    ];
    let calls = 0;
    const fetchActivities = vi.fn(async () => pages[Math.min(calls++, pages.length - 1)]);

    startRunOverlayPolling({
      key: 'p1', runId: 'r1', fetchActivities, pollMs: 100,
    });
    // Seeded before the first poll.
    expect(getRunOverlay('p1')).toMatchObject({ runId: 'r1', overall: 'Queued', polling: true, rows: [] });

    await vi.advanceTimersByTimeAsync(1200); // first quick poll
    expect(getRunOverlay('p1')).toMatchObject({ overall: 'InProgress', polling: true });

    await vi.advanceTimersByTimeAsync(100); // steady cadence → terminal
    expect(getRunOverlay('p1')).toMatchObject({ overall: 'Succeeded', polling: false });
    const callsAtDone = fetchActivities.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1000); // no polls after terminal
    expect(fetchActivities.mock.calls.length).toBe(callsAtDone);
  });

  it('keeps polling through transient (null) fetch results', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchActivities = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return null; // transient failure
      return [row({ name: 'a', status: 'Succeeded' })];
    });
    startRunOverlayPolling({ key: 'p1', runId: 'r1', fetchActivities, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(1200);
    // Transient error — prior (seeded) state retained, still polling.
    expect(getRunOverlay('p1')).toMatchObject({ overall: 'Queued', polling: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(getRunOverlay('p1')).toMatchObject({ overall: 'Succeeded', polling: false });
  });

  it('a new poll for the same key supersedes the previous one', async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => [row({ name: 'a', status: 'InProgress' })]);
    const second = vi.fn(async () => [row({ name: 'b', status: 'Succeeded' })]);
    startRunOverlayPolling({ key: 'p1', runId: 'r1', fetchActivities: first, pollMs: 100 });
    startRunOverlayPolling({ key: 'p1', runId: 'r2', fetchActivities: second, pollMs: 100 });
    expect(getRunOverlay('p1')?.runId).toBe('r2');
    await vi.advanceTimersByTimeAsync(1200);
    expect(first).not.toHaveBeenCalled(); // cancelled before its first tick
    expect(getRunOverlay('p1')).toMatchObject({ runId: 'r2', overall: 'Succeeded' });
  });

  it('cancel stops future polls; clearRunOverlay drops the state', async () => {
    vi.useFakeTimers();
    const fetchActivities = vi.fn(async () => [row({ name: 'a', status: 'InProgress' })]);
    const cancel = startRunOverlayPolling({ key: 'p1', runId: 'r1', fetchActivities, pollMs: 100 });
    cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchActivities).not.toHaveBeenCalled();
    clearRunOverlay('p1');
    expect(getRunOverlay('p1')).toBeNull();
  });

  it('carries the rerun callbacks on every published state', async () => {
    vi.useFakeTimers();
    const onRerunFromFailed = vi.fn();
    const fetchActivities = vi.fn(async () => [row({ name: 'a', status: 'Failed', error: 'boom' })]);
    startRunOverlayPolling({ key: 'p1', runId: 'r1', fetchActivities, pollMs: 100, onRerunFromFailed });
    await vi.advanceTimersByTimeAsync(1200);
    const st = getRunOverlay('p1');
    expect(st?.overall).toBe('Failed');
    st?.onRerunFromFailed?.();
    expect(onRerunFromFailed).toHaveBeenCalledTimes(1);
  });
});
