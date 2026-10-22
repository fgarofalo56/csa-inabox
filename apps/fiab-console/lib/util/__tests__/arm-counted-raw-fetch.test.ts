/**
 * armCountedRawFetch — SSRF-safe by construction: it can only reach the ARM
 * origin. Every refusal case asserts the thrown error AND that the global fetch
 * was called 0 times, and names the input that would break it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armCountedRawFetch, ArmFetchRefusedError, pinToArmOrigin } from '../arm-counted-raw-fetch';
import { getArmReadCounts, resetArmReadCounts, runWithArmCaller } from '@/lib/azure/arm-read-gate';

const ARM = 'https://management.azure.com';
const PATH = '/subscriptions/s/resourceGroups/r/providers/Microsoft.Foo/x/y?api-version=1';
const realFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetArmReadCounts();
  delete process.env.LOOM_ARM_ENDPOINT;
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  global.fetch = fetchMock as never;
});
afterEach(() => { global.fetch = realFetch; delete process.env.LOOM_ARM_ENDPOINT; });

describe('refusals: fetch is never called', () => {
  const cases: Array<[string, string, RegExp]> = [
    // [name of the value that breaks the guard, input, expected reason]
    ['other host: https://evil.example/x', 'https://evil.example/x', /is not the ARM origin/],
    ['userinfo smuggling: ARM host as the username, evil as the host', 'https://management.azure.com@evil.example/x', /userinfo/],
    ['userinfo on the real ARM host', 'https://user:pw@management.azure.com/subscriptions', /userinfo/],
    ['protocol-relative: //evil.example/x', '//evil.example/x', /not an absolute/],
    ['relative path: /subscriptions/s', '/subscriptions/s', /not an absolute/],
    ['http downgrade on the ARM host', 'http://management.azure.com/subscriptions', /is not https/],
    ['look-alike suffix host: management.azure.com.evil.example', 'https://management.azure.com.evil.example/x', /is not the ARM origin/],
    ['non-default port on the ARM host', 'https://management.azure.com:8443/x', /is not the ARM origin/],
    ['file: scheme', 'file:///etc/passwd', /is not https/],
    ['empty string', '', /not an absolute/],
  ];
  for (const [name, input, reason] of cases) {
    it(`refuses ${name}`, async () => {
      await expect(armCountedRawFetch(input)).rejects.toBeInstanceOf(ArmFetchRefusedError);
      await expect(armCountedRawFetch(input)).rejects.toThrow(reason);
      // Breaks if any refused input reaches fetch (would be >= 1).
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(getArmReadCounts().reads).toEqual({});
    });
  }

  it('refuses a Request object (its URL would not be checked)', async () => {
    await expect(armCountedRawFetch(new Request('https://evil.example/x') as never)).rejects.toThrow(/must be a string or URL/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('Gov: the Commercial ARM host is refused when LOOM_ARM_ENDPOINT is the Gov host', async () => {
    process.env.LOOM_ARM_ENDPOINT = 'https://management.usgovcloudapi.net';
    await expect(armCountedRawFetch(`${ARM}${PATH}`)).rejects.toThrow(/is not the ARM origin/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe('positive controls: a real ARM URL still fetches and counts', () => {
  it('fetches exactly the ARM URL once, counts the GET, and never follows redirects', async () => {
    await runWithArmCaller('setup.scan', () => armCountedRawFetch(`${ARM}${PATH}`, { headers: { a: 'b' } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ARM}${PATH}`);
    // Breaks if redirects are followed (cross-origin bearer-token bounce).
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ a: 'b' });
    // Breaks if the raw variant is built on fetchWithTimeout (a signal would appear).
    expect(init.signal).toBeUndefined();
    expect(getArmReadCounts().reads).toEqual({ 'setup.scan': 1 });
  });

  it('Gov: the Gov ARM URL fetches when LOOM_ARM_ENDPOINT is Gov', async () => {
    process.env.LOOM_ARM_ENDPOINT = 'https://management.usgovcloudapi.net';
    await armCountedRawFetch(`https://management.usgovcloudapi.net${PATH}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a POST to ARM is allowed through and NOT counted as a read', async () => {
    await armCountedRawFetch(`${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=1`, { method: 'POST', body: '{}' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getArmReadCounts().reads).toEqual({});
  });

  it('the fetched host comes from armBase(), the argument only supplies path+query (fragment dropped)', () => {
    expect(pinToArmOrigin(`${ARM}/a/b?x=1#frag`)).toBe(`${ARM}/a/b?x=1`);
  });
});
