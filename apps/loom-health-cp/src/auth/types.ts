// Persistence shapes for the LHDS Authorization Server. Three Cosmos containers
// (operator decision, security.md Q6), all partitioned on /id like the rest of
// the control plane:
//   health-auth-config  tenant role bindings + client registrations
//   health-auth-replay  client-assertion jti cache (TTL; create-if-absent => 409 = replay)
//   health-auth-grants  auth requests, authorization codes, refresh tokens, launch handles (TTL)
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
  pou: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ReplayDoc extends Doc {
  /** Cosmos TTL, seconds. */
  ttl: number;
}

export interface GrantDoc extends Doc {
  kind: 'authreq' | 'code' | 'refresh' | 'launch';
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
  fhirContext?: string[];
  fhirUser?: string;
  echo?: Record<string, string>;
  /** Enforced in code on every read; `ttl` is only Cosmos-side cleanup. */
  expiresAt: string;
}

export interface AuthStores {
  bindings: Collection<BindingDoc>;
  clients: Collection<ClientDoc>;
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
