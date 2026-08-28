/**
 * LOOM BRAIN W10 — the HTTP edge, and the three shapes that had no fixture.
 *
 * Every test here targets an input shape that EXISTED in production and had NO
 * test — which is why the 14-arm mutation sweep could not see any of them: a
 * mutation sweep can only break code the fixtures reach, and this repo's
 * recorded lesson is that a TYPE-CORRECT fixture cannot reach a lie told to the
 * compiler. `arm-probe.test.ts`'s `FetchLike` fixtures all return a well-formed
 * `json()`, never throw, and never return 429 — so the three findings below
 * (#4014 review S2, S3, S4) were invisible to a green suite.
 *
 * The controls matter as much as the assertions. A retry loop is exactly the
 * kind of thing that quietly becomes a gate that CANNOT FAIL, so every arm runs
 * in both directions: the transient case must still come out GREEN, and the
 * exhausted case must come out RED with the real status attached.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  NO_RETRY_POLICY,
  fetchWithBoundedRetry,
  isTransientStatus,
  readJsonBody,
  readTextBody,
  requireTotalRecords,
  retryAfterMs,
  type FetchResponse,
  type RetryPolicy,
} from '../azure/http';
import type { FetchLike } from '../azure/arm-probe';

/** A policy that never waits, so the loop is exercised at zero wall clock. */
function instant(maxAttempts: number): RetryPolicy {
  return { maxAttempts, baseDelayMs: 1, maxDelayMs: 4, sleep: async () => {} };
}

function res(over: Partial<FetchResponse> & { status: number; ok: boolean }): FetchResponse {
  return {
    text: async () => '',
    json: async () => ({}),
    ...over,
  } as FetchResponse;
}

// ---------------------------------------------------------------------------
// S2 — a 200 whose body is not JSON
// ---------------------------------------------------------------------------

describe('S2 — an unparseable body is DATA, not an escaping rejection', () => {
  it('turns a rejecting json() into a ProbeFailure carrying the REAL status', async () => {
    const out = await readJsonBody(
      res({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
        text: async () => '<html><body>403 Forbidden (proxy)</body></html>',
      }),
      'discovery',
      'Microsoft.ResourceGraph/resources',
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The status is 200 and stays 200. Rewriting it to a 5xx to "look like" a
    // failure would be the R7 violation in the other direction.
    expect(out.failure.httpStatus).toBe(200);
    expect(out.failure.classification).toBe('arm-error');
    expect(out.failure.detail).toContain('SyntaxError');
    // The operator needs to SEE the interstitial that actually arrived.
    expect(out.failure.detail).toContain('403 Forbidden (proxy)');
    // R7 — it must not claim a reachability problem. The transport worked.
    expect(out.failure.detail).toContain('NOT a reachability failure');
  });

  it('CONTROL: a well-formed body still parses', async () => {
    const out = await readJsonBody(
      res({ status: 200, ok: true, json: async () => ({ totalRecords: 3 }) }),
      'discovery',
      'x',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.value as { totalRecords: number }).totalRecords).toBe(3);
  });

  it('readTextBody SAYS it could not read, rather than returning an empty string', async () => {
    // The 2026-08-05 incident in miniature: `''` reads downstream as "the
    // server sent an empty body", which is a claim, and a false one.
    const text = await readTextBody(
      res({
        status: 500,
        ok: false,
        text: async () => {
          throw new TypeError('body stream already read');
        },
      }),
    );
    expect(text).toContain('could not be read');
    expect(text).toContain('TypeError');
    expect(text).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// S3 — the completeness cross-check that could not run
// ---------------------------------------------------------------------------

describe('S3 — "I could not measure" is not "the counts agreed"', () => {
  it('an ABSENT totalRecords is a FAILURE, not a pass', () => {
    const f = requireTotalRecords(null, 42, 1, 'Microsoft.ResourceGraph/resources');
    expect(f).not.toBeNull();
    expect(f?.detail).toContain('no usable numeric');
    // The message must not be interchangeable with the mismatch message: they
    // have different causes and different fixes.
    expect(f?.detail).toContain('different fact');
  });

  it('a MISMATCH is a failure, and says which two numbers disagreed', () => {
    const f = requireTotalRecords(100, 42, 2, 'x');
    expect(f).not.toBeNull();
    expect(f?.detail).toContain('totalRecords=100');
    expect(f?.detail).toContain('42 row(s)');
  });

  it('CONTROL: agreement passes — the guard is not simply always-red', () => {
    // Without this the fix would be a blanket tightening that fails every
    // healthy run, which is the other way a guard stops being useful.
    expect(requireTotalRecords(42, 42, 1, 'x')).toBeNull();
    expect(requireTotalRecords(0, 0, 1, 'x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S4 — bounded retry, failing closed
// ---------------------------------------------------------------------------

describe('S4 — bounded retry that cannot become a gate which never fails', () => {
  it('retries a 429 and returns the eventual success, counting the retries', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return n < 3
        ? res({ status: 429, ok: false, text: async () => 'TooManyRequests' })
        : res({ status: 200, ok: true, json: async () => ({ data: [] }) });
    };
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'https://arm.example/x',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 'x',
      policy: instant(4),
    });
    expect(out.ok).toBe(true);
    expect(out.retries).toBe(2);
    expect(n).toBe(3);
  });

  it('retries a thrown (no-response) error', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return res({ status: 200, ok: true });
    };
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'power-read',
      target: 't',
      policy: instant(3),
    });
    expect(out.ok).toBe(true);
    expect(out.retries).toBe(1);
  });

  it('FAILS CLOSED on exhaustion, naming the attempt count and the real status', async () => {
    const fetchImpl: FetchLike = async () =>
      res({ status: 429, ok: false, text: async () => 'Rate limit is exceeded. Try again in 5s.' });
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 'Microsoft.ResourceGraph/resources',
      policy: instant(3),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.retries).toBe(2);
    expect(out.failure.httpStatus).toBe(429);
    expect(out.failure.detail).toContain('Rate limit is exceeded');
    expect(out.failure.detail).toContain('gave up after 3 attempt(s)');
  });

  it('does NOT retry a 403 — a decision Azure has made is not transient', async () => {
    // Repeating an authorization refusal delays the truth and buys nothing.
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return res({ status: 403, ok: false, text: async () => 'AuthorizationFailed' });
    };
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy: instant(4),
    });
    // A non-transient status is handed BACK to the caller, which classifies it.
    expect(out.ok).toBe(true);
    expect(out.retries).toBe(0);
    expect(n).toBe(1);
  });

  it('CONTROL: a healthy first response costs exactly one call and zero retries', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return res({ status: 200, ok: true });
    };
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy: DEFAULT_RETRY_POLICY,
    });
    expect(out.ok).toBe(true);
    expect(out.retries).toBe(0);
    expect(n).toBe(1);
  });

  it('NO_RETRY_POLICY issues exactly one attempt and fails closed', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return res({ status: 503, ok: false, text: async () => 'unavailable' });
    };
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy: NO_RETRY_POLICY,
    });
    expect(out.ok).toBe(false);
    expect(n).toBe(1);
  });

  it('a policy permitting ZERO attempts is REFUSED, not silently treated as one', async () => {
    // A zero-attempt policy would report a reach failure having issued no
    // request at all — a red run that establishes nothing, indistinguishable
    // from a real outage. That is a defect in the caller and it throws.
    await expect(
      fetchWithBoundedRetry({
        fetchImpl: async () => res({ status: 200, ok: true }),
        url: 'u',
        init: { method: 'GET', headers: {} },
        stage: 'discovery',
        target: 't',
        policy: { ...instant(0) },
      }),
    ).rejects.toThrow(/maxAttempts must be >= 1/);
  });

  it('honours Retry-After when it is longer than the exponential backoff', async () => {
    const slept: number[] = [];
    const policy: RetryPolicy = {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    };
    const fetchImpl: FetchLike = async () =>
      ({
        ok: false,
        status: 429,
        text: async () => 'slow down',
        json: async () => ({}),
        headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '7' : null) },
      }) as unknown as Awaited<ReturnType<FetchLike>>;
    await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy,
    });
    expect(slept).toEqual([7000]);
  });

  it('CLAMPS a hostile Retry-After — a header must not be able to hang a run', async () => {
    const slept: number[] = [];
    const policy: RetryPolicy = {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 8000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    };
    const fetchImpl: FetchLike = async () =>
      ({
        ok: false,
        status: 503,
        text: async () => 'nope',
        json: async () => ({}),
        headers: { get: () => '86400' },
      }) as unknown as Awaited<ReturnType<FetchLike>>;
    await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy,
    });
    expect(slept).toEqual([8000]);
  });

  it('a response with no headers at all does not throw', async () => {
    // Every fixture in `arm-probe.test.ts` is exactly this shape.
    const fetchImpl: FetchLike = async () => res({ status: 500, ok: false });
    const out = await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy: instant(2),
    });
    expect(out.ok).toBe(false);
  });

  it('a headers.get that THROWS falls back to the exponential backoff', async () => {
    const slept: number[] = [];
    const policy: RetryPolicy = {
      maxAttempts: 2,
      baseDelayMs: 25,
      maxDelayMs: 1000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    };
    const fetchImpl: FetchLike = async () =>
      ({
        ok: false,
        status: 500,
        text: async () => 'x',
        json: async () => ({}),
        headers: {
          get: () => {
            throw new Error('detached headers');
          },
        },
      }) as unknown as Awaited<ReturnType<FetchLike>>;
    await fetchWithBoundedRetry({
      fetchImpl,
      url: 'u',
      init: { method: 'GET', headers: {} },
      stage: 'discovery',
      target: 't',
      policy,
    });
    expect(slept).toEqual([25]);
  });
});

describe('the transient predicate and Retry-After parsing', () => {
  it.each([429, 500, 502, 503, 504, 599])('%d is transient', (s) => {
    expect(isTransientStatus(s)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])('%d is NOT transient', (s) => {
    expect(isTransientStatus(s)).toBe(false);
  });

  it('parses delta-seconds and an HTTP-date, and refuses everything else', () => {
    const now = Date.parse('2026-08-27T00:00:00Z');
    expect(retryAfterMs('12', now)).toBe(12_000);
    expect(retryAfterMs('  30  ', now)).toBe(30_000);
    expect(retryAfterMs('Thu, 27 Aug 2026 00:00:20 GMT', now)).toBe(20_000);
    // A past date is not a negative sleep.
    expect(retryAfterMs('Thu, 27 Aug 2020 00:00:00 GMT', now)).toBeNull();
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs('', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs(undefined, now)).toBeNull();
  });
});

describe('DEFAULT_RETRY_POLICY is bounded', () => {
  it('permits a finite number of attempts and a capped delay', () => {
    // A policy is the one place an "unbounded retry" could hide, and an
    // unbounded retry is a run that can never go red.
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeLessThanOrEqual(6);
    expect(Number.isFinite(DEFAULT_RETRY_POLICY.maxDelayMs)).toBe(true);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(30_000);
  });

  it('its sleep actually waits (the production one is not a stub)', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void DEFAULT_RETRY_POLICY.sleep(50).then(() => {
        done = true;
      });
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
