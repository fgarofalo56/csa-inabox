/**
 * ttl-memo — the invalidation contract (#2557 review).
 *
 * The defect this locks: `invalidate()` used to null `cached`/`inFlight` only.
 * A compute already in flight when the write landed still wrote its PRE-WRITE
 * snapshot into `cached` when it resolved, so a `createConnection` racing an
 * in-flight GET was papered over for the full TTL. The generation counter is
 * what makes the "visible on the very next read" claim true under a race, not
 * just serially.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTtlMemo } from '@/lib/azure/ttl-memo';

/** A compute whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createTtlMemo', () => {
  it('serves a fresh value without re-computing', async () => {
    const memo = createTtlMemo<number>(60_000);
    const compute = vi.fn(async () => 1);
    expect(await memo.get(compute)).toBe(1);
    expect(await memo.get(compute)).toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('de-dupes concurrent misses onto ONE compute', async () => {
    const memo = createTtlMemo<number>(60_000);
    const compute = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return 7; });
    const [a, b] = await Promise.all([memo.get(compute), memo.get(compute)]);
    expect([a, b]).toEqual([7, 7]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('never caches a rejection', async () => {
    const memo = createTtlMemo<number>(60_000);
    let n = 0;
    const compute = vi.fn(async () => { n += 1; if (n === 1) throw new Error('blip'); return 42; });
    await expect(memo.get(compute)).rejects.toThrow('blip');
    expect(await memo.get(compute)).toBe(42);
  });

  it('expires after the TTL', async () => {
    const memo = createTtlMemo<number>(10);
    const compute = vi.fn(async () => 1);
    await memo.get(compute);
    await new Promise((r) => setTimeout(r, 25));
    await memo.get(compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a write that lands MID-FLIGHT is not overwritten by the pre-write snapshot', async () => {
    const memo = createTtlMemo<string>(60_000);
    const d = deferred<string>();

    // A read starts and stalls inside compute…
    const read = memo.get(() => d.promise);
    // …a write lands and invalidates…
    memo.invalidate();
    // …then the stalled read finally resolves with the PRE-WRITE value.
    d.resolve('before-the-write');
    expect(await read).toBe('before-the-write'); // the caller still gets its answer

    // But it must NOT have become the cached answer: the next read re-computes
    // and sees the post-write state.
    const after = vi.fn(async () => 'after-the-write');
    expect(await memo.get(after)).toBe('after-the-write');
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('force:true also invalidates a racing in-flight compute', async () => {
    const memo = createTtlMemo<string>(60_000);
    const d = deferred<string>();
    const read = memo.get(() => d.promise); // in flight
    expect(await memo.get(async () => 'forced', true)).toBe('forced');
    d.resolve('stale');
    await read;
    const next = vi.fn(async () => 'never');
    // The stale in-flight result must not have clobbered the forced refresh.
    expect(await memo.get(next)).toBe('forced');
    expect(next).not.toHaveBeenCalled();
  });
});
