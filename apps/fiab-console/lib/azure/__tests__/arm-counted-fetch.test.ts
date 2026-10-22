/**
 * armCountedFetch / armCountedRawFetch — per-service ARM clients book their GETs
 * on the `[arm-reads]` counter without changing the request.
 *
 * assertion-design: each load-bearing assertion names the input that breaks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armCountedFetch, isArmOrigin } from '../arm-counted-fetch';import { getArmReadCounts, resetArmReadCounts, runWithArmCaller } from '../arm-read-gate';

const COMMERCIAL = 'https://management.azure.com';
const GOV = 'https://management.usgovcloudapi.net';
const PATH = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Foo/x/y?api-version=1';
const realFetch = global.fetch;

function stubFetch(status = 200, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status, headers });
  }) as never;
  return calls;
}

beforeEach(() => { resetArmReadCounts(); delete process.env.LOOM_ARM_ENDPOINT; delete process.env.AZURE_CLOUD; });
afterEach(() => { global.fetch = realFetch; delete process.env.LOOM_ARM_ENDPOINT; });

describe('armCountedFetch', () => {
  it('books a GET to the ARM origin under the label in scope and sends the same request', async () => {
    const calls = stubFetch();
    await runWithArmCaller('aks.list', () => armCountedFetch(`${COMMERCIAL}${PATH}`, { headers: { authorization: 'Bearer T' } }));
    // Breaks (reads == {}) if the wrapper stops calling beginArmRead.
    expect(getArmReadCounts().reads).toEqual({ 'aks.list': 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${COMMERCIAL}${PATH}`);
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer T');
  });

  it('a read with no label lands under unlabeled (the bucket an operator greps for)', async () => {
    stubFetch();
    await armCountedFetch(`${COMMERCIAL}${PATH}`);
    expect(getArmReadCounts().reads).toEqual({ unlabeled: 1 });
  });

  it('counts a 429 against the caller and still returns the Response unthrown', async () => {
    stubFetch(429, { 'retry-after': '7' });
    const res = await runWithArmCaller('cost.query', () => armCountedFetch(`${COMMERCIAL}${PATH}`));
    // Breaks if the status is not forwarded to ticket.done (s429 would be {}).
    expect(getArmReadCounts().s429).toEqual({ 'cost.query': 1 });
    expect(res.status).toBe(429);
  });

  it('a thrown fetch is still counted as a read (and rethrown unchanged)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('socket hang up'); }) as never;
    await expect(runWithArmCaller('x', () => armCountedFetch(`${COMMERCIAL}${PATH}`))).rejects.toThrow(/socket hang up/);
    expect(getArmReadCounts().reads).toEqual({ x: 1 });
  });

  it('does NOT count writes: a POST/PUT/DELETE to ARM is a different quota bucket', async () => {
    stubFetch();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      await runWithArmCaller('w', () => armCountedFetch(`${COMMERCIAL}${PATH}`, { method }));
    }
    expect(getArmReadCounts().reads).toEqual({});
  });

  it('does NOT count a GET to a non-ARM host (data-plane read in a mixed file)', async () => {
    stubFetch();
    await runWithArmCaller('mixed', () => armCountedFetch('https://myvault.vault.azure.net/secrets?api-version=7.4'));
    // Breaks if the origin check is dropped (reads would be {mixed: 1}).
    expect(getArmReadCounts().reads).toEqual({});
  });

  it('look-alike host does not count: management.azure.com.evil.test is not the ARM origin', async () => {
    stubFetch();
    await runWithArmCaller('evil', () => armCountedFetch(`${COMMERCIAL}.evil.test${PATH}`));
    expect(getArmReadCounts().reads).toEqual({});
  });

  it('Gov: counts the Gov ARM origin and not the Commercial one when LOOM_ARM_ENDPOINT is Gov', async () => {
    process.env.LOOM_ARM_ENDPOINT = GOV;
    stubFetch();
    await runWithArmCaller('gov', () => armCountedFetch(`${GOV}${PATH}`));
    await runWithArmCaller('gov-wrong-cloud', () => armCountedFetch(`${COMMERCIAL}${PATH}`));
    expect(getArmReadCounts().reads).toEqual({ gov: 1 });
  });

  it('forwards the timeout argument untouched (3rd arg reaches fetchWithTimeout, request completes)', async () => {
    const calls = stubFetch();
    await armCountedFetch(`${COMMERCIAL}${PATH}`, undefined, 5_000);
    expect(calls).toHaveLength(1);
    // fetchWithTimeout composes its own AbortSignal into init: proof it ran, not bare fetch.
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('isArmOrigin', () => {
  it('is false for garbage rather than throwing', () => {
    expect(isArmOrigin('not a url')).toBe(false);
    expect(isArmOrigin(`${COMMERCIAL}/x`)).toBe(true);
  });
});
