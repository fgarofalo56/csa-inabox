import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoomClient, LoomApiError, ndjsonLines } from '../src/client.js';

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
