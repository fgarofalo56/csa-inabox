// Persistence shapes for the LHDS Authorization Server. Three Cosmos containers
// (operator decision, security.md Q6), all partitioned on /id like the rest of
// the control plane:
//   health-auth-config  tenant role bindings + client registrations + fhirUser mappings
//   health-auth-replay  client-assertion jti cache (TTL; create-if-absent => 409 = replay)
//   health-auth-grants  auth requests, authorization codes, refresh tokens, launch handles, patient picks (TTL)
// Secrets (codes, refresh tokens, launch handles) are stored only as SHA-256.

import { createHash } from 'node:crypto';
import type { JWK } from 'jose';
import type { Collection, Doc } from '../store/types.js';

export const AUTH_CONTAINER_NAMES = {
  config: 'health-auth-config',
  replay: 'health-auth-replay',
  grants: 'health-auth-grants',
} as const;

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface RoleBinding {
  /** Entra group objectId. */
  groupId: string;
  roleId: string;
}

export interface BindingDoc extends Doc {
  kind: 'binding';
  tenant: string;
  bindings: RoleBinding[];
  /** Tenant v1 scope-syntax compatibility flag (A2). */
  v1Scopes: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface ClientDoc extends Doc {
  kind: 'client';
  clientId: string;
  tenant: string;
  /** backend = client_credentials only; app = authorization_code (+ refresh). */
  clientType: 'backend' | 'app';
  displayName: string;
  status: 'active' | 'disabled';
  jwksUrl?: string;
  jwks?: { keys: JWK[] };
  /** Scopes the registration may ever receive (v2 form). */
  allowedScopes: string[];
  /** Backend clients only: roles acting for the client (no user to resolve groups for). */
  roleIds: string[];
  redirectUris: string[];
  /** App clients only: the SMART app's launch URL for an EHR launch (`launchUri?iss=...&launch=...`, #5454 A3). */
  launchUri?: string;
  /**
   * Backend clients only: may call POST {issuer}/{tenant}/introspect for THIS tenant (RFC 7662, #5151). Granted by
   * an admin, never by a scope request, so no token request can earn it. Absent = false.
   */
  introspect?: boolean;
  pou: string;
  updatedAt: string;
  updatedBy: string;
}

/** Entra oid -> the FHIR resource that user IS in one tenant (SMART `fhirUser`, #5454 A3). Id: fhirUserDocId(). */
export interface FhirUserDoc extends Doc {
  kind: 'fhiruser';
  tenant: string;
  /** Lower-case Entra object id. */
  oid: string;
  /** Relative reference, e.g. `Practitioner/abc`. Tokens carry it as an absolute URL on the tenant FHIR base. */
  resource: string;
  updatedAt: string;
  updatedBy: string;
}

/** The mappings share the config container, so they need a delete and a tenant-scoped list the Collection seam lacks. */
export interface FhirUserStore extends Collection<FhirUserDoc> {
  /** True when a document was removed, false when none existed. */
  delete(id: string): Promise<boolean>;
  /** Mappings of ONE tenant, ordered by id, at most `limit`. */
  listForTenant(tenant: string, limit: number): Promise<FhirUserDoc[]>;
}

export interface ReplayDoc extends Doc {
  /** Cosmos TTL, seconds. */
  ttl: number;
}

/** One SMART App Launch STU2.2 `fhirContext` entry: at least one of reference, canonical or identifier. */
export interface FhirContextItem {
  reference?: string;
  canonical?: string;
  identifier?: { system?: string; value: string };
  type?: string;
  role?: string;
}

export interface GrantDoc extends Doc {
  kind: 'authreq' | 'code' | 'refresh' | 'launch' | 'revoked' | 'pick';
  /** authreq + pick: sha256 of the browser-binding cookie secret (#5134; the pick cookie is its own, #5454 A5). */
  browserBinding?: string;
  /** pick: sha256 of the CSRF value in the picker form; rotated on every render. */
  csrf?: string;
  /** pick: the tenant's v1 scope flag at sign-in, so requestedScope re-parses the same way when the code is issued. */
  v1Scopes?: boolean;
  /** code + refresh: id shared by every rotation of one sign-in; revoking it kills the chain (#5134). */
  family?: string;
  ttl: number;
  used?: boolean;
  tenant: string;
  clientId: string;
  // authreq + code
  redirectUri?: string;
  codeChallenge?: string;
  clientState?: string;
  clientNonce?: string;
  entraNonce?: string;
  entraVerifier?: string;
  requestedScope?: string;
  aud?: string;
  launchHandle?: string;
  // code + refresh: the identity and the grant it carries
  oid?: string;
  idpTid?: string;
  grantedScope?: string[]; // v2 form, includes context scopes
  patient?: string;
  encounter?: string;
  /** SMART STU2.2 fhirContext objects. Documents written before #5454 may still hold bare strings (normalised on read). */
  fhirContext?: Array<FhirContextItem | string>;
  fhirUser?: string;
  echo?: Record<string, string>;
  /** Enforced in code on every read; `ttl` is only Cosmos-side cleanup. */
  expiresAt: string;
}

/** Reads a stored fhirContext: a pre-STU2.2 bare string becomes `{reference}`. */
export function normalizeFhirContext(v: GrantDoc['fhirContext']): FhirContextItem[] | undefined {
  if (!v || v.length === 0) return undefined;
  return v.map((x) => (typeof x === 'string' ? { reference: x } : x));
}

export interface AuthStores {
  bindings: Collection<BindingDoc>;
  clients: Collection<ClientDoc>;
  fhirUsers: FhirUserStore;
  replay: Collection<ReplayDoc>;
  grants: Collection<GrantDoc>;
}

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'access_denied'
  | 'server_error';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = code === 'invalid_client' ? 401 : code === 'server_error' ? 500 : 400,
  ) {
    super(description);
  }
}
