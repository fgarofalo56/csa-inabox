/**
 * Centralized API base-URL resolution — CSA-0123.
 *
 * Every outbound HTTP call from the React webapp MUST derive its base URL
 * from `resolveApiBaseUrl` so that the Next.js rewrite (`next.config.js`)
 * and the BFF reverse-proxy (CSA-0020 Phase 3) are the single choke points
 * for inbound traffic. Historically, `src/services/api.ts` read
 * `process.env.NEXT_PUBLIC_API_URL` directly with a hard-coded
 * `http://localhost:8000/api/v1` fallback; on a production build where the
 * env var was unset, the browser would attempt cross-origin calls to the
 * localhost backend (exposed by bundler inlining). This module fixes that.
 *
 * Default: `/api` — same-origin, routed by:
 *   1. `next.config.js::rewrites()` in dev (proxy to `NEXT_PUBLIC_API_URL`
 *      if set, else `http://localhost:8000/api`).
 *   2. The BFF / reverse proxy in staging and production.
 *
 * Callers requesting versioned endpoints (`/v1/sources`, …) should rely on
 * `apiV1BaseUrl()` which appends `/v1`. This keeps call sites free of
 * string concatenation with env vars.
 *
 * Tests override via the `env` argument rather than mutating
 * `process.env`; Next.js inlines `NEXT_PUBLIC_*` at build time so runtime
 * mutation is only honoured in Node test processes.
 */

/**
 * Sensible default base URL. Using a relative path ensures that the
 * browser speaks to the origin serving the webapp, which is the surface
 * the Next.js rewrite rule and any reverse-proxy (BFF, APIM, App
 * Gateway) are configured for.
 */
export const DEFAULT_API_BASE_URL = '/api';

/**
 * Resolve the API base URL for non-versioned endpoints.
 *
 * Precedence:
 *   1. `NEXT_PUBLIC_API_URL` when set, trimmed of trailing slashes.
 *   2. `DEFAULT_API_BASE_URL` (`/api`) — same-origin.
 */
export function resolveApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.NEXT_PUBLIC_API_URL;
  if (raw && raw.trim()) {
    return raw.replace(/\/+$/, '');
  }
  return DEFAULT_API_BASE_URL;
}

/**
 * Resolve the API base URL for versioned endpoints (`/v1/...`).
 *
 * Appends `/v1` to `resolveApiBaseUrl` unless the configured base already
 * ends in `/v<digit(s)>`, which indicates an operator deliberately pinned
 * the version and we must not double-segment.
 */
export function apiV1BaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = resolveApiBaseUrl(env);
  if (/\/v\d+$/.test(base)) {
    return base;
  }
  return `${base}/v1`;
}
