import { NextResponse } from 'next/server'

/**
 * Shared BFF response envelope for CSA Loom API routes.
 *
 * Matches the repo's established convention (see .claude/rules/no-vaporware.md
 * — "returns structured JSON ({ok: true|false, data, error}) with proper HTTP
 * status codes"): a success response spreads its named fields alongside
 * `ok: true`; a failure carries `ok: false` + a human-readable `error` + an
 * explicit HTTP status code.
 *
 * OPT-IN, no mass codemod: the ~1180 existing route.ts files keep their
 * hand-written `NextResponse.json(...)` calls. New or touched routes SHOULD use
 * these helpers so the envelope + status codes stay consistent, and so the 500
 * path never leaks stack traces / connection strings to the client.
 *
 * @example
 *   return apiOk({ entries })                       // 200 { ok: true, entries }
 *   return apiError('id required', 400)             // 400 { ok: false, error }
 *   if (!session) return apiUnauthorized()          // 401 { ok: false, error }
 *   try { ... } catch (e) { return apiServerError(e) } // 500, logged server-side
 */

export type ApiOk<T extends Record<string, unknown> = Record<string, unknown>> = { ok: true } & T
export type ApiErr = { ok: false; error: string }

/**
 * Success. Spreads `fields` next to `ok: true` — the repo's existing success
 * shape (`{ ok: true, entries }`, `{ ok: true, status }`, …), so this is a
 * drop-in replacement, not a new `data`-wrapped envelope.
 */
export function apiOk<T extends Record<string, unknown>>(fields?: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...(fields ?? {}) }, init)
}

/** Failure with an explicit HTTP status (default 400) + optional extra fields. */
export function apiError(error: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra ?? {}) }, { status })
}

// --- Common named errors: consistent messages + the right status code -------
export const apiUnauthorized = (error = 'unauthenticated') => apiError(error, 401)
export const apiForbidden = (error = 'forbidden') => apiError(error, 403)
export const apiBadRequest = (error = 'bad request') => apiError(error, 400)
export const apiNotFound = (error = 'not found') => apiError(error, 404)
export const apiConflict = (error = 'conflict') => apiError(error, 409)

/**
 * 500 wrapper. Logs the raw error server-side and returns a SAFE public
 * message — never leak stack traces, SQL, or connection strings to the client
 * (see the security rules in CLAUDE.md). Pass a `publicMessage` when the caller
 * has a more specific user-facing string.
 */
export function apiServerError(err: unknown, publicMessage = 'internal error') {
  const detail = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error('[api] server error:', detail)
  return apiError(publicMessage, 500)
}
