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
    /** Seconds to wait before retrying (a 429's `retryAfter` / `Retry-After`). */
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'LoomApiError';
  }
}

/** A bare machine token (`rate_limited`, `forbidden`) — not a sentence a person can act on. */
const MACHINE_TOKEN_RE = /^[a-z][a-z0-9_]*$/;

function positiveSeconds(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/**
 * Build the error for a failed response. The text is the route's `error`,
 * unless that is a bare token AND the route also sent a `message`, in which
 * case the message is the sentence to show. The retry wait comes from the body's
 * `retryAfter`, else the `Retry-After` header (seconds).
 */
export function apiErrorFrom(parsed: unknown, res: Response): LoomApiError {
  const headerWait = positiveSeconds(res.headers.get('retry-after'));
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { error?: unknown; message?: unknown; code?: unknown; hint?: unknown; retryAfter?: unknown };
    const error = typeof p.error === 'string' && p.error ? p.error : undefined;
    const message = typeof p.message === 'string' && p.message ? p.message : undefined;
    const text =
      (error && message && MACHINE_TOKEN_RE.test(error) ? message : error ?? message) ||
      `${res.status} ${res.statusText}`;
    return new LoomApiError(
      text,
      res.status,
      typeof p.code === 'string' ? p.code : undefined,
      typeof p.hint === 'string' ? p.hint : undefined,
      positiveSeconds(p.retryAfter) ?? headerWait,
    );
  }
  const text = typeof parsed === 'string' && parsed ? parsed : `${res.status} ${res.statusText}`;
  return new LoomApiError(text, res.status, undefined, undefined, headerWait);
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

    if (!res.ok) throw apiErrorFrom(parsed, res);

    // Some routes return `{ ok:false }` with a 200 in degraded cases — honor it.
    if (parsed && typeof parsed === 'object' && parsed.ok === false) {
      throw apiErrorFrom({ error: 'request failed', ...parsed }, res);
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed === 'object') throw apiErrorFrom(parsed, res);
      throw new LoomApiError(
        `device-code login failed: ${res.status} ${res.statusText}`,
        res.status,
        undefined,
        undefined,
        positiveSeconds(res.headers.get('retry-after')),
      );
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
