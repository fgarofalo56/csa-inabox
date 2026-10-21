/**
 * The ARM transport hook: arm-client.armGet attributes each GET to the caller
 * label in scope, and a 429 inside a warmer cycle guard abandons that cycle.
 * Request behaviour must be unchanged (same URL, same thrown text).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { AcaManagedIdentityCredential: Cred };
});

import { armGet } from '../arm-client';
import { createArmReadGate, getArmReadCounts, resetArmReadCounts, runWithArmCaller, WarmerCycleGuard } from '../arm-read-gate';

const PATH = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Foo/x/y?api-version=1';
const realFetch = global.fetch;

function fetchReturning(status: number, retryAfter?: string) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: unknown) => {
    urls.push(String(url));
    return new Response('{}', { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
  }) as never;
  return urls;
}

beforeEach(() => { resetArmReadCounts(); });
afterEach(() => { global.fetch = realFetch; });

describe('arm-client armGet read counter', () => {
  it('counts a GET under the label in scope and leaves the request untouched', async () => {
    const urls = fetchReturning(200);
    await runWithArmCaller('estate.state', () => armGet(PATH));
    // Breaks if armFetch no longer calls the hook (the label would never appear).
    expect(getArmReadCounts().reads).toEqual({ 'estate.state': 1 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(PATH);
  });

  it('a 429 is counted and still throws the unchanged ARM error text', async () => {
    fetchReturning(429);
    await expect(runWithArmCaller('health', () => armGet(PATH))).rejects.toThrow(/ARM GET .* failed 429/);
    expect(getArmReadCounts().s429).toEqual({ health: 1 });
  });

  it('inside a warmer guard, a 429 abandons the cycle so the next read is not sent', async () => {
    const urls = fetchReturning(429, '7');
    const gate = createArmReadGate({ maxConcurrent: 4, readsPerSec: 10 });
    const guard = new WarmerCycleGuard();
    await expect(runWithArmCaller('warmer.diagnostics', () => armGet(PATH), { guard, gate })).rejects.toThrow(/429/);
    expect(guard.abandoned?.retryAfterSeconds).toBe(7);
    await expect(runWithArmCaller('warmer.diagnostics', () => armGet(PATH), { guard, gate })).rejects.toMatchObject({ code: 'WarmerCycleAbandoned' });
    // Breaks if an abandoned guard still lets the request out: urls would be 2.
    expect(urls).toHaveLength(1);
  });
});
