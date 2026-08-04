import { describe, it, expect, vi } from 'vitest';
import { ndjsonLines, runDeviceCodeLogin, DeviceCodeError } from '../src/auth/device-code';

/** Build a ReadableStream<Uint8Array> from raw string chunks. */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function ndjsonResponse(chunks: string[], init: ResponseInit = {}): Response {
  // Response with a stream body — matches the BFF's application/x-ndjson.
  return new Response(streamFrom(chunks), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
    ...init,
  });
}

describe('ndjsonLines', () => {
  it('yields whole lines including one split across chunks', async () => {
    const stream = streamFrom(['{"a":1}\n{"b":', '2}\n', '{"c":3}']);
    const lines: string[] = [];
    for await (const line of ndjsonLines(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('ignores blank lines', async () => {
    const stream = streamFrom(['\n{"a":1}\n\n']);
    const lines: string[] = [];
    for await (const line of ndjsonLines(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":1}']);
  });
});

describe('runDeviceCodeLogin', () => {
  it('surfaces the device prompt then resolves the minted session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([
        JSON.stringify({
          type: 'device_code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://microsoft.com/devicelogin',
          message: 'enter code',
          expiresIn: 900,
        }) + '\n',
        JSON.stringify({
          type: 'session',
          ok: true,
          cookie: 'enc-cookie-value',
          expiresAt: 1234567890,
          claims: { oid: 'oid1', upn: 'user@contoso.com' },
        }) + '\n',
      ]),
    );

    const prompts: string[] = [];
    const session = await runDeviceCodeLogin(
      'https://loom.example.com',
      (p) => prompts.push(p.userCode),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(prompts).toEqual(['ABCD-EFGH']);
    expect(session.cookie).toBe('enc-cookie-value');
    expect(session.expiresAt).toBe(1234567890);
    expect(session.claims?.upn).toBe('user@contoso.com');
    // Posts to the CLI-shared cli-session route with the device-code flow.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://loom.example.com/api/auth/cli-session');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ flow: 'device-code' });
  });

  it('throws DeviceCodeError on an error line', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ndjsonResponse([JSON.stringify({ type: 'error', ok: false, error: 'public client disabled', code: 'device_login_failed' }) + '\n']),
    );
    await expect(
      runDeviceCodeLogin('https://loom.example.com', () => {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(DeviceCodeError);
  });

  it('throws a configured DeviceCodeError on a 503 not_configured response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'not configured', code: 'not_configured', hint: 'see MSAL-handoff' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const err = await runDeviceCodeLogin('https://loom.example.com', () => {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceCodeError);
    expect((err as DeviceCodeError).code).toBe('not_configured');
    expect((err as DeviceCodeError).status).toBe(503);
  });

  it('wraps a network failure as a status-0 DeviceCodeError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await runDeviceCodeLogin('https://loom.example.com', () => {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceCodeError);
    expect((err as DeviceCodeError).status).toBe(0);
  });
});
