/**
 * HTTP transport for the Loom SDK.
 *
 * Auth — the SDK supports the two schemes the Loom API documents in its
 * OpenAPI spec:
 *   • **Bearer (PAT)** — `Authorization: Bearer loom_pat_<id>_<secret>`, a
 *     scoped API token (created under Settings → Developer → API tokens). This
 *     is the recommended scheme for CI / automation.
 *   • **Cookie** — replaying the encrypted `loom_session` cookie, identical to
 *     how the browser and the `loom` CLI authenticate.
 *
 * Envelope normalization — Loom routes are not uniform: some return a bare
 * array (`GET /api/workspaces`), some a bare object (`GET /api/workspaces/:id`),
 * some an `{ ok, … }` envelope. Errors are uniformly `{ ok:false, error, code }`
 * (+ optional `hint`). `request()` throws {@link LoomApiError} on failure and
 * hands success bodies back untouched.
 *
 * Runtime — uses the global `fetch` (Node >= 18 / all modern runtimes). No
 * third-party HTTP dependency.
 */

import { LoomApiError } from './errors.js';

/** The cookie name the Loom session is stored under (mirrors the server). */
export const COOKIE_NAME = 'loom_session';

export interface LoomClientOptions {
  /** Base URL of the Loom deployment, e.g. `https://csa-loom.limitlessdata.ai`. */
  baseUrl: string;
  /** A scoped API token (`loom_pat_<id>_<secret>`) sent as a bearer header. */
  token?: string;
  /** An encrypted `loom_session` cookie value (alternative to `token`). */
  cookie?: string;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Override the fetch implementation (tests / custom runtimes). */
  fetch?: typeof fetch;
}

/** Strip a trailing slash so URL joins are stable. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly token?: string;
  private cookie?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LoomClientOptions) {
    if (!opts.baseUrl) throw new Error('LoomClient requires a baseUrl');
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.token = opts.token;
    this.cookie = opts.cookie;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('No global fetch available — pass options.fetch (Node < 18) or upgrade Node.');
    }
    this.fetchImpl = f;
  }

  /** The resolved base URL (trailing slash stripped). */
  get base(): string {
    return this.baseUrl;
  }

  /** Update the cookie in place (used after a service-principal login). */
  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (hasBody) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    else if (this.cookie) h.Cookie = `${COOKIE_NAME}=${this.cookie}`;
    return h;
  }

  /**
   * Issue a request and return the parsed body, throwing {@link LoomApiError}
   * on a non-2xx response OR a 200 body that carries `{ ok:false }`.
   */
  async request<T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${apiPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network_error';
      throw new LoomApiError(`${code === 'timeout' ? 'Timed out' : 'Network error'} calling ${method} ${apiPath}: ${msg}`, 0, code);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw errorFrom(parsed, res);
    }
    // Some routes return `{ ok:false }` with a 200 in degraded cases — honor it.
    if (parsed && typeof parsed === 'object' && (parsed as { ok?: unknown }).ok === false) {
      throw errorFrom(parsed, res);
    }
    return parsed as T;
  }

  /** Return a 204/empty response as void, else the parsed body. */
  async requestVoid(method: string, apiPath: string, body?: unknown): Promise<void> {
    await this.request<unknown>(method, apiPath, body);
  }
}

function errorFrom(parsed: unknown, res: Response): LoomApiError {
  if (parsed && typeof parsed === 'object') {
    const p = parsed as { error?: unknown; message?: unknown; code?: unknown; hint?: unknown };
    const msg = (typeof p.error === 'string' && p.error) || (typeof p.message === 'string' && p.message) || `${res.status} ${res.statusText}`;
    return new LoomApiError(String(msg), res.status, typeof p.code === 'string' ? p.code : undefined, typeof p.hint === 'string' ? p.hint : undefined);
  }
  const msg = typeof parsed === 'string' && parsed ? parsed : `${res.status} ${res.statusText}`;
  return new LoomApiError(msg, res.status);
}

/** Percent-encode a path segment. */
export function enc(seg: string): string {
  return encodeURIComponent(seg);
}
