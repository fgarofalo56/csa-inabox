// RFC 7662 token introspection for the LHDS AS (#5151, operator decision 2026-11-28).
//
// verifyAccessToken is the AS's own check of an lhds-at/1 access token: the ES384 key the AS signs with, the AS
// issuer, typ at+jwt, the claims contract version, exp and iat with NO clock tolerance (an expired token is
// inactive the second it expires). It returns undefined for anything that is not such a token, and throws only
// when the AS cannot read its own key: that is a server fault, never reported as "inactive" (deploy-integrity R7).

import { importJWK, jwtVerify } from 'jose';
import type { Signer } from './signer.js';
import { LHDS_AT_VERSION } from './tokens.js';

/** The claims introspection reads from a verified lhds-at/1 token. */
export interface AccessTokenClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  tenant: string;
  sub: string;
  sub_type: 'user' | 'system';
  client_id: string;
  scope: string;
  patient?: string;
  encounter?: string;
  fhirUser?: string;
}

/** A compact JWS, bounded: anything else is not one of our access tokens and is never parsed. */
const COMPACT_JWS = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,512}$/;
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export async function verifyAccessToken(signer: Signer, issuer: string, token: string, now: Date): Promise<AccessTokenClaims | undefined> {
  if (!COMPACT_JWS.test(token)) return undefined;
  // Outside the try: a key the AS cannot read is a 500, not an inactive token.
  const key = await importJWK(await signer.publicJwk(), 'ES384');
  try {
    const { payload: p } = await jwtVerify(token, key, {
      algorithms: ['ES384'],
      typ: 'at+jwt',
      issuer,
      requiredClaims: ['exp', 'iat', 'aud', 'sub'],
      clockTolerance: 0,
      currentDate: now,
    });
    if (p.lhds_ver !== LHDS_AT_VERSION) return undefined;
    if (typeof p.exp !== 'number' || typeof p.iat !== 'number') return undefined;
    if (!str(p.aud) || !str(p.tenant) || !str(p.sub) || !str(p.client_id) || typeof p.scope !== 'string') return undefined;
    if (p.sub_type !== 'user' && p.sub_type !== 'system') return undefined;
    return {
      iss: p.iss as string,
      aud: p.aud,
      iat: p.iat,
      exp: p.exp,
      tenant: p.tenant,
      sub: p.sub,
      sub_type: p.sub_type,
      client_id: p.client_id,
      scope: p.scope,
      ...(str(p.patient) ? { patient: p.patient } : {}),
      ...(str(p.encounter) ? { encounter: p.encounter } : {}),
      ...(str(p.fhirUser) ? { fhirUser: p.fhirUser } : {}),
    };
  } catch {
    // Bad signature, wrong issuer/typ, expired, not yet valid, malformed: all the same "not an active token".
    return undefined;
  }
}

/** The one inactive response (RFC 7662 2.2): nothing else, so no reason for inactivity is ever disclosed. */
export const INACTIVE: Readonly<{ active: false }> = Object.freeze({ active: false });
