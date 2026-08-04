/**
 * Auth resolution — PRP §5.1. Turns the environment / CLI credential store into
 * an {@link AuthContext} bound to a Loom SDK client, or `null` (anonymous).
 *
 * Order of resolution (first match wins):
 *   1. `LOOM_TOKEN` (a `loom_pat_<id>_<secret>` PAT) + a base URL → **bearer/PAT** client.
 *   2. The `loom` CLI credential store (`~/.loom/credentials.json`, written by
 *      `loom auth login`) → **cookie** client, if a non-expired profile matches.
 *   3. Otherwise `null` — the authorization gate then rejects every tool call.
 *
 * The base URL is taken from `LOOM_API_URL`, else the sole stored profile's URL.
 *
 * A §5.6-aligned transport check refuses to build a client that would send a
 * credential over plaintext to a remote host (https required; `http://localhost`
 * / `127.0.0.1` allowed for local development).
 */
import { LoomClient } from '@csa-loom/sdk';
import { loadProfile, listProfiles, isExpired, normalizeApiUrl } from './credential-store.js';
import type { AuthContext, TokenScope } from './types.js';

export interface ResolveAuthOptions {
  /** Explicit base URL (else `LOOM_API_URL`, else the sole stored profile). */
  apiUrl?: string;
  /** Explicit PAT (else `LOOM_TOKEN`). */
  token?: string;
  /** Injectable env for testing (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Injectable `fetch` handed to the SDK client (testing). */
  fetch?: typeof fetch;
  /** Where to write a one-line resolution note (defaults to stderr). */
  note?: (msg: string) => void;
}

/** Extract the non-secret PAT id: `loom_pat_<id>_<secret>` → `pat_<id>`. */
export function patPrincipal(token: string): string {
  const m = /^loom_pat_([A-Za-z0-9]+)_/.exec(token);
  return m ? `pat_${m[1]}` : 'pat';
}

/** https required unless the host is localhost/127.0.0.1 (plaintext dev only). */
export function isTransportAllowed(apiUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return false;
}

/**
 * Resolve the caller's credential. Returns `null` for anonymous (including a
 * fixable misconfiguration, which is noted to stderr but never fatal — the
 * server still starts and lists tools; calls are then denied by the gate).
 */
export async function resolveAuth(opts: ResolveAuthOptions = {}): Promise<AuthContext | null> {
  const env = opts.env ?? process.env;
  const note = opts.note ?? ((m: string) => process.stderr.write(`[loom-mcp] ${m}\n`));

  const token = opts.token ?? env.LOOM_TOKEN;
  let apiUrl = opts.apiUrl ?? env.LOOM_API_URL;

  // 1) PAT path.
  if (token) {
    if (!apiUrl) {
      const profiles = await listProfiles();
      if (profiles.length === 1 && profiles[0]) apiUrl = profiles[0].apiUrl;
    }
    if (!apiUrl) {
      note('LOOM_TOKEN is set but no LOOM_API_URL — running unauthenticated. Set LOOM_API_URL.');
      return null;
    }
    apiUrl = normalizeApiUrl(apiUrl);
    if (!isTransportAllowed(apiUrl)) {
      note(`refusing to send a token over a non-https URL (${apiUrl}) — running unauthenticated.`);
      return null;
    }
    const scope = coerceScope(env.LOOM_TOKEN_SCOPE) ?? 'read-only';
    return {
      mode: 'pat',
      principal: patPrincipal(token),
      scope,
      apiUrl,
      client: new LoomClient({ baseUrl: apiUrl, token, fetch: opts.fetch }),
    };
  }

  // 2) CLI credential-store (cookie) path.
  let profile = null as Awaited<ReturnType<typeof loadProfile>>;
  if (apiUrl) {
    profile = await loadProfile(apiUrl);
  } else {
    const profiles = await listProfiles();
    if (profiles.length === 1 && profiles[0]) {
      profile = profiles[0];
      apiUrl = profile.apiUrl;
    } else if (profiles.length > 1) {
      note('multiple stored Loom sessions — set LOOM_API_URL to choose one. Running unauthenticated.');
      return null;
    }
  }

  if (profile && apiUrl) {
    if (isExpired(profile)) {
      note(`stored session for ${apiUrl} is expired — run \`loom auth login\`. Running unauthenticated.`);
      return null;
    }
    apiUrl = normalizeApiUrl(apiUrl);
    if (!isTransportAllowed(apiUrl)) {
      note(`refusing to replay a session over a non-https URL (${apiUrl}) — running unauthenticated.`);
      return null;
    }
    return {
      mode: 'cookie',
      principal: 'session',
      // A user session reads/writes within its own ACL; the BFF enforces the
      // real per-item ACL. `read-write` lets it satisfy M1's read-only floor.
      scope: 'read-write',
      apiUrl,
      client: new LoomClient({ baseUrl: apiUrl, cookie: profile.cookie, fetch: opts.fetch }),
    };
  }

  // 3) Anonymous.
  return null;
}

function coerceScope(v: string | undefined): TokenScope | undefined {
  return v === 'read-only' || v === 'read-write' || v === 'admin' ? v : undefined;
}
