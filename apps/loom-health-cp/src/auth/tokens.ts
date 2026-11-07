// LHDS access-token (lhds-at/1) and id_token minting. The claim set is the
// contract the PDP consumes (security.md A7); changing a claim here changes that
// contract and must bump LHDS_AT_VERSION.

import { randomUUID } from 'node:crypto';
import type { Signer } from './signer.js';
import { SCOPE_MAP_VERSION } from './role-map.js';

export const LHDS_AT_VERSION = 'lhds-at/1';
export const ACCESS_TOKEN_TTL_S = 300;

export async function signJwt(signer: Signer, typ: string, payload: Record<string, unknown>): Promise<string> {
  const header = { typ, alg: signer.alg, kid: await signer.kid() };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const sig = await signer.sign(Buffer.from(input, 'utf8'));
  return `${input}.${sig.toString('base64url')}`;
}

export interface AccessTokenInput {
  issuer: string;
  /** Exact tenant FHIR base the client named in `aud`. */
  audience: string;
  tenant: string;
  subType: 'user' | 'system';
  sub: string;
  idpTid?: string;
  clientId: string;
  scope: string[]; // v2 form only
  patient?: string;
  encounter?: string;
  fhirUser?: string;
  roles: string[];
  pou: string[];
  now: Date;
}

export async function mintAccessToken(signer: Signer, i: AccessTokenInput): Promise<string> {
  const iat = Math.floor(i.now.getTime() / 1000);
  const claims: Record<string, unknown> = {
    iss: i.issuer,
    aud: i.audience,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_S,
    jti: randomUUID(),
    lhds_ver: LHDS_AT_VERSION,
    tenant: i.tenant,
    sub: i.sub,
    sub_type: i.subType,
    client_id: i.clientId,
    scope: i.scope.join(' '),
    lhds_roles: i.roles,
    lhds_map_ver: SCOPE_MAP_VERSION,
    pou: i.pou,
  };
  if (i.idpTid) claims.idp_tid = i.idpTid;
  if (i.patient) claims.patient = i.patient;
  if (i.encounter) claims.encounter = i.encounter;
  if (i.fhirUser) claims.fhirUser = i.fhirUser;
  // `act` and `cnf` are reserved (A7): never set here.
  return signJwt(signer, 'at+jwt', claims);
}

export async function mintIdToken(
  signer: Signer,
  i: { issuer: string; clientId: string; sub: string; nonce?: string; fhirUser?: string; now: Date },
): Promise<string> {
  const iat = Math.floor(i.now.getTime() / 1000);
  const claims: Record<string, unknown> = { iss: i.issuer, aud: i.clientId, sub: i.sub, iat, exp: iat + ACCESS_TOKEN_TTL_S };
  if (i.nonce) claims.nonce = i.nonce;
  if (i.fhirUser) claims.fhirUser = i.fhirUser;
  return signJwt(signer, 'JWT', claims);
}
