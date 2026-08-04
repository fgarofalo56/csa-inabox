/**
 * Device-code sign-in over `POST /api/auth/cli-session` (NDJSON stream).
 *
 * This is a faithful port of the CLI's flow —
 * `apps/loom-cli/src/client.ts` (`loginDeviceCode` + `ndjsonLines`) — so the
 * extension shares the CLI's exact contract with the same BFF route
 * (`apps/fiab-console/app/api/auth/cli-session/route.ts`):
 *   line 1  {"type":"device_code", userCode, verificationUri, message, expiresIn}
 *   ...     (server polls Entra via the MSAL device-authorization grant)
 *   line N  {"type":"session", ok:true, cookie, expiresAt, claims}
 *   or      {"type":"error", ok:false, error, code}
 *
 * Token acquisition is server-side, so the client holds no Entra authority
 * matrix — one build serves Commercial and Government; only `apiUrl` differs
 * (PRP A4). This module intentionally imports neither `vscode` nor the SDK so
 * it can be unit-tested in isolation.
 */

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}

export interface DeviceCodeSession {
  cookie: string;
  expiresAt: number;
  claims?: { oid?: string; name?: string; upn?: string; email?: string };
}

/** Error carrying the BFF's stable `code` so callers can branch (T-4 gates). */
export class DeviceCodeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'DeviceCodeError';
  }
}

/** Async-iterate newline-delimited JSON lines off a fetch ReadableStream. */
export async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) yield line;
      }
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export interface DeviceCodeOptions {
  /** Entra tenant override (rarely needed — the deployment resolves it). */
  tenantId?: string;
  /** Injectable fetch for tests / custom runtimes (defaults to global). */
  fetchImpl?: typeof fetch;
}

/**
 * Run the interactive device-code login and resolve the minted session.
 * `onPrompt` is invoked once with the code + verification URL to show the user.
 */
export async function runDeviceCodeLogin(
  apiUrl: string,
  onPrompt: (p: DevicePrompt) => void,
  opts: DeviceCodeOptions = {},
): Promise<DeviceCodeSession> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (typeof f !== 'function') {
    throw new DeviceCodeError('No global fetch available in this runtime.', 0, 'no_fetch');
  }
  const url = `${apiUrl}/api/auth/cli-session`;
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ flow: 'device-code', tenantId: opts.tenantId }),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DeviceCodeError(`Network error contacting ${apiUrl}: ${msg}`, 0, 'network_error');
  }

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    try {
      const j = JSON.parse(t) as { error?: string; hint?: string; code?: string };
      throw new DeviceCodeError(
        String(j.error || `${res.status} ${res.statusText}`),
        res.status,
        j.code,
        j.hint,
      );
    } catch (e) {
      if (e instanceof DeviceCodeError) throw e;
    }
    throw new DeviceCodeError(`device-code login failed: ${res.status} ${res.statusText}`, res.status);
  }

  let session: DeviceCodeSession | null = null;
  let failure: DeviceCodeError | null = null;
  for await (const line of ndjsonLines(res.body)) {
    let obj: {
      type?: string;
      ok?: boolean;
      userCode?: string;
      verificationUri?: string;
      message?: string;
      expiresIn?: number;
      cookie?: string;
      expiresAt?: number;
      claims?: DeviceCodeSession['claims'];
      error?: string;
      code?: string;
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'device_code') {
      onPrompt({
        userCode: obj.userCode ?? '',
        verificationUri: obj.verificationUri ?? '',
        message: obj.message ?? '',
        expiresIn: obj.expiresIn ?? 0,
      });
    } else if (obj.type === 'session' && obj.ok) {
      session = { cookie: obj.cookie ?? '', expiresAt: obj.expiresAt ?? 0, claims: obj.claims };
    } else if (obj.type === 'error') {
      failure = new DeviceCodeError(String(obj.error || 'device-code login failed'), 401, obj.code);
    }
  }
  if (failure) throw failure;
  if (!session) throw new DeviceCodeError('device-code login ended without a session', 500, 'no_session');
  return session;
}
