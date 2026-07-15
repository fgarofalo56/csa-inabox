/**
 * BR-SCIM — NextResponse helpers that emit `application/scim+json` with the
 * right status codes + the SCIM auth gate every route shares.
 */

import { NextResponse } from 'next/server';
import { SCIM_CONTENT_TYPE, scimError, scimAuthConfigured, verifyScimBearer } from './core';

/** JSON body with the SCIM content type. */
export function scimJson(body: unknown, status = 200, extraHeaders?: Record<string, string>): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Content-Type': SCIM_CONTENT_TYPE, ...(extraHeaders ?? {}) },
  });
}

/** A SCIM error response (SCIM error body + matching HTTP status). */
export function scimErr(status: number, detail: string, scimType?: string): NextResponse {
  return scimJson(scimError(status, detail, scimType), status);
}

/**
 * Gate a SCIM route. Returns a NextResponse to short-circuit with (501 honest
 * gate when unconfigured, 401 when the bearer is missing/wrong) or null when the
 * caller is authorized to proceed.
 *
 * The 501 names the exact env var to set (no-vaporware.md honest gate); a
 * `WWW-Authenticate` header is returned on 401 per RFC 7644.
 */
export function requireScim(req: { headers: { get(n: string): string | null } }): NextResponse | null {
  if (!scimAuthConfigured()) {
    return scimJson(
      scimError(
        501,
        'SCIM provisioning is not configured on this deployment. Set the LOOM_SCIM_BEARER_TOKEN secret (a provisioning token) on the console app, then configure the same value in your identity provider\'s provisioning connector.',
        'notImplemented',
      ),
      501,
    );
  }
  if (!verifyScimBearer(req.headers.get('authorization'))) {
    return scimJson(scimError(401, 'Missing or invalid SCIM provisioning bearer token.'), 401, {
      'WWW-Authenticate': 'Bearer',
    });
  }
  return null;
}

/** Derive the request origin for `meta.location` links. */
export function originOf(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return process.env.LOOM_PUBLIC_BASE_URL || '';
  }
}
