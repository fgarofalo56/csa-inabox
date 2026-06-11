/**
 * LoomClient — thin wrapper over the Loom BFF REST API.
 *
 * Auth: replays the encrypted `loom_session` cookie value as the `Cookie`
 * header, identical to how the browser authenticates. There is no separate
 * bearer/API-key path on the Loom API, so this is the real contract.
 *
 * Envelope normalization: Loom routes are not uniform — some return a bare
 * array (`GET /api/workspaces`), some a bare object (`GET /api/workspaces/:id`),
 * some an `{ ok, ... }` envelope (folders, task-flows, /api/loom/*). Errors are
 * uniformly `{ ok:false, error, code }` (+ optional `hint` on 503). `request()`
 * surfaces errors verbatim and hands success bodies back untouched.
 */
import { COOKIE_NAME } from './constants.js';

export class LoomApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'LoomApiError';
  }
}

export interface SessionResult {
  cookie: string;
  expiresAt: number;
  claims?: { oid?: string; name?: string; upn?: string; email?: string };
}

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}

export class LoomClient {
  constructor(
    private readonly apiUrl: string,
    private readonly cookie?: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...extra };
    if (this.cookie) h.Cookie = `${COOKIE_NAME}=${this.cookie}`;
    return h;
  }

  /** Issue a request and return the parsed body, throwing LoomApiError on !ok. */
  async request<T = unknown>(
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.apiUrl}${apiPath}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) {
      throw new LoomApiError(`Network error calling ${method} ${apiPath}: ${e?.message || e}`, 0, 'network_error');
    }

    const text = await res.text();
    let parsed: any = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const errMsg =
        (parsed && typeof parsed === 'object' && (parsed.error || parsed.message)) ||
        (typeof parsed === 'string' && parsed) ||
        `${res.status} ${res.statusText}`;
      const code = parsed && typeof parsed === 'object' ? parsed.code : undefined;
      const hint = parsed && typeof parsed === 'object' ? parsed.hint : undefined;
      throw new LoomApiError(String(errMsg), res.status, code, hint);
    }

    // Some routes return `{ ok:false }` with a 200 in degraded cases — honor it.
    if (parsed && typeof parsed === 'object' && parsed.ok === false) {
      throw new LoomApiError(String(parsed.error || 'request failed'), res.status, parsed.code, parsed.hint);
    }
    return parsed as T;
  }

  // --- Auth ---------------------------------------------------------------

  /**
   * Interactive device-code login. Reads the NDJSON stream from
   * `POST /api/auth/cli-session`: the first line carries the device prompt
   * (passed to `onPrompt` for display), the final line carries the session.
   */
  async loginDeviceCode(
    onPrompt: (p: DevicePrompt) => void,
    tenantId?: string,
  ): Promise<SessionResult> {
    const url = `${this.apiUrl}/api/auth/cli-session`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ flow: 'device-code', tenantId }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      let hint: string | undefined;
      let code: string | undefined;
      try {
        const j = JSON.parse(t);
        hint = j.hint;
        code = j.code;
        throw new LoomApiError(String(j.error || `${res.status} ${res.statusText}`), res.status, code, hint);
      } catch (e) {
        if (e instanceof LoomApiError) throw e;
      }
      throw new LoomApiError(`device-code login failed: ${res.status} ${res.statusText}`, res.status);
    }

    let session: SessionResult | null = null;
    let failure: LoomApiError | null = null;
    for await (const line of ndjsonLines(res.body)) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'device_code') {
        onPrompt({
          userCode: obj.userCode,
          verificationUri: obj.verificationUri,
          message: obj.message,
          expiresIn: obj.expiresIn,
        });
      } else if (obj.type === 'session' && obj.ok) {
        session = { cookie: obj.cookie, expiresAt: obj.expiresAt, claims: obj.claims };
      } else if (obj.type === 'error') {
        failure = new LoomApiError(String(obj.error || 'device-code login failed'), 401, obj.code);
      }
    }
    if (failure) throw failure;
    if (!session) throw new LoomApiError('device-code login ended without a session', 500, 'no_session');
    return session;
  }

  /** Non-interactive service-principal login (CI). */
  async loginServicePrincipal(creds: {
    clientId: string;
    clientSecret: string;
    tenantId?: string;
  }): Promise<SessionResult> {
    const out = await this.request<{ ok: boolean; cookie: string; expiresAt: number; claims?: any }>(
      'POST',
      '/api/auth/cli-session',
      { flow: 'service-principal', ...creds },
    );
    return { cookie: out.cookie, expiresAt: out.expiresAt, claims: out.claims };
  }

  /** Probe the current session via /api/auth/me. */
  async me(): Promise<{ ok: boolean; oid?: string; upn?: string; email?: string; name?: string }> {
    return this.request('GET', '/api/auth/me');
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
