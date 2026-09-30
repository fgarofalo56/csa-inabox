import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoomClient, LoomApiError, ndjsonLines } from '../src/client.js';
import { formatApiError } from '../src/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoomClient.request', () => {
  it('returns a bare array body untouched and sends the session cookie', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([{ id: 'w1' }]));
    const c = new LoomClient('https://loom.test', 'COOKIEVAL');
    const out = await c.request<any[]>('GET', '/api/workspaces');
    expect(out).toEqual([{ id: 'w1' }]);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Cookie).toBe('loom_session=COOKIEVAL');
  });

  it('throws LoomApiError with code + status on an error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ok: false, error: 'Unauthorized', code: 'unauthorized' }, 401),
    );
    const c = new LoomClient('https://loom.test', 'x');
    await expect(c.request('GET', '/api/workspaces')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      message: 'Unauthorized',
    });
  });

  it('surfaces a 503 hint verbatim', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ok: false, error: 'not provisioned', code: 'gate', hint: 'set LOOM_X env var' }, 503),
    );
    const c = new LoomClient('https://loom.test', 'x');
    try {
      await c.request('GET', '/api/loom/capacities');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LoomApiError);
      expect((e as LoomApiError).hint).toBe('set LOOM_X env var');
    }
  });

  it('treats a 200 with ok:false as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'degraded' }, 200));
    const c = new LoomClient('https://loom.test', 'x');
    await expect(c.request('GET', '/api/x')).rejects.toBeInstanceOf(LoomApiError);
  });
});

describe('ndjsonLines', () => {
  it('splits a chunked NDJSON stream into lines', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('{"a":1}\n{"b":'));
        controller.enqueue(enc.encode('2}\n'));
        controller.enqueue(enc.encode('{"c":3}'));
        controller.close();
      },
    });
    const lines: string[] = [];
    for await (const l of ndjsonLines(stream)) lines.push(l);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe('LoomClient.loginDeviceCode', () => {
  it('emits the device prompt then resolves the session from the stream', async () => {
    const ndjson =
      JSON.stringify({ type: 'device_code', userCode: 'ABC-123', verificationUri: 'https://aka.ms/devicelogin', message: 'go here', expiresIn: 900 }) +
      '\n' +
      JSON.stringify({ type: 'session', ok: true, cookie: 'NEWCOOKIE', expiresAt: 9999999999, claims: { upn: 'u@x' } }) +
      '\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    );
    const c = new LoomClient('https://loom.test');
    const prompts: any[] = [];
    const session = await c.loginDeviceCode((p) => prompts.push(p));
    expect(prompts[0].userCode).toBe('ABC-123');
    expect(session.cookie).toBe('NEWCOOKIE');
    expect(session.claims?.upn).toBe('u@x');
  });

  it('throws when the stream ends with an error line', async () => {
    const ndjson = JSON.stringify({ type: 'error', ok: false, error: 'expired', code: 'device_login_failed' }) + '\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    );
    const c = new LoomClient('https://loom.test');
    await expect(c.loginDeviceCode(() => {})).rejects.toMatchObject({ message: 'expired' });
  });
});

// #4805 — the sign-in start is rate-limited, and a device-code session is refused
// admin actions. Both answers must reach the person as a sentence, the wait, and
// the remediation, not as "API error (429): rate_limited".
describe('#4805 rate-limit and interactive-sign-in refusals, as printed', () => {
  const rateLimited = {
    ok: false,
    error: 'rate_limited',
    code: 'rate_limited',
    message: 'Too many device-code sign-in attempts from this network.',
    hint: 'Wait, then run the sign-in again.',
    retryAfter: 120,
  };

  it('a 429 on sign-in prints the message, the wait from retryAfter, and the hint', async () => {
    // The header says 7 and the body says 120: RED if the client reads the
    // header first (7), ignores both (no "Try again" line), or prints `error`
    // ("rate_limited") instead of the message.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(rateLimited), { status: 429, headers: { 'content-type': 'application/json', 'Retry-After': '7' } }),
    );
    const c = new LoomClient('https://loom.test');
    const err = await c.loginDeviceCode(() => {}).catch((e) => e);
    expect(err).toBeInstanceOf(LoomApiError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 120, message: rateLimited.message });
    const printed = formatApiError(err);
    expect(printed).toBe(
      'API error (429 rate_limited): Too many device-code sign-in attempts from this network.\n' +
        'Try again in 120 seconds.\n' +
        'Hint: Wait, then run the sign-in again.\n',
    );
  });

  it('with no retryAfter in the body, the wait comes from the Retry-After header', async () => {
    // RED if the header fallback is dropped (retryAfter undefined, no line).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '45' } }),
    );
    const err = await new LoomClient('https://loom.test', 'x').request('GET', '/api/x').catch((e) => e);
    expect(err.retryAfter).toBe(45);
    // No `message` was sent, so the token is all there is to show.
    expect(err.message).toBe('rate_limited');
    expect(formatApiError(err)).toContain('Try again in 45 seconds.');
  });

  it('a 403 interactive_sign_in_required prints the browser hint', async () => {
    // RED if the client drops `hint` (no "Hint:" line), or shows the token
    // "forbidden" when the route sent a sentence.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          error: 'forbidden',
          code: 'interactive_sign_in_required',
          message: 'Admin actions require an interactive browser sign-in.',
          hint: 'Sign in to the Loom console in a browser and do this there.',
        },
        403,
      ),
    );
    const err = await new LoomClient('https://loom.test', 'x').request('POST', '/api/admin/policy-code').catch((e) => e);
    const printed = formatApiError(err);
    expect(printed).toContain('API error (403 interactive_sign_in_required): Admin actions require an interactive browser sign-in.');
    expect(printed).toContain('Hint: Sign in to the Loom console in a browser and do this there.');
    expect(printed).not.toContain('Try again');
  });

  it('a sentence in `error` still wins over `message` (existing routes are unchanged)', async () => {
    // RED if the client always prefers `message`.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ok: false, error: 'workspace not found', message: 'secondary text' }, 404),
    );
    const err = await new LoomClient('https://loom.test', 'x').request('GET', '/api/x').catch((e) => e);
    expect(err.message).toBe('workspace not found');
  });
});
