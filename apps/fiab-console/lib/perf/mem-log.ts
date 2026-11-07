/**
 * Process memory trail. The console crashed 10 times in 26 h on a V8 heap
 * abort (live set ~990 MB against a ~1048 MB limit) with no memory telemetry,
 * so the retainer could not be named. This logs ONE structured line per
 * interval so the next crash leaves a trail, plus a rate-limited WARN when
 * heapUsed passes 85% of the heap limit. Numbers only: no user data.
 *
 * Env: LOOM_MEM_LOG_INTERVAL_MS (default 60000; 0 disables; clamped to
 * 10000..600000). No heap snapshots are taken.
 */
import { getHeapStatistics } from 'node:v8';

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 600_000;
export const WARN_RATIO = 0.85;
export const WARN_COOLDOWN_MS = 10 * 60_000;

const MB = 1024 * 1024;
let timer: ReturnType<typeof setInterval> | null = null;
let lastWarnAt = Number.NEGATIVE_INFINITY;

/** 0 = disabled; otherwise clamped to [MIN, MAX]. Unparseable -> default. */
export function resolveIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  if (n === 0) return 0;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
}

const mb = (bytes: number) => Math.round(bytes / MB);

export function sampleMemory(): Record<string, number> {
  const m = process.memoryUsage();
  return {
    rssMB: mb(m.rss),
    heapUsedMB: mb(m.heapUsed),
    heapLimitMB: mb(getHeapStatistics().heap_size_limit),
    externalMB: mb(m.external),
    arrayBuffersMB: mb(m.arrayBuffers),
  };
}

function tick(now: number): void {
  const s = sampleMemory();
  console.log(`[mem] ${JSON.stringify(s)}`);
  if (s.heapLimitMB > 0 && s.heapUsedMB > s.heapLimitMB * WARN_RATIO && now - lastWarnAt >= WARN_COOLDOWN_MS) {
    lastWarnAt = now;
    console.warn(
      `[mem] WARN heap above ${Math.round(WARN_RATIO * 100)}% of limit ${JSON.stringify(s)}`,
    );
  }
}

/** Idempotent. Returns true when a timer is running after the call. */
export function startMemLog(): boolean {
  if (timer) return true;
  const interval = resolveIntervalMs(process.env.LOOM_MEM_LOG_INTERVAL_MS);
  if (interval === 0) return false;
  timer = setInterval(() => tick(Date.now()), interval);
  timer.unref();
  return true;
}

/** Test seam. */
export function stopMemLog(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastWarnAt = Number.NEGATIVE_INFINITY;
}
