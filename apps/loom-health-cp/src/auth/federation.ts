// Entra federation (OIDC authorization-code + PKCE, single Entra tenant in W1)
// and the server-side Microsoft Graph group-membership check (security.md A5).
// Both are seams: the server only sees the interfaces, tests inject fakes, and
// the production factories below talk to the per-cloud Entra and Graph hosts.
// The AS NEVER trusts a `groups` claim carried by a client or an id_token.

import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Cloud } from '../config.js';
import { GRAPH_BY_CLOUD, graphScope } from './clouds.js';

export interface EntraIdentity {
  /** Entra user object id. */
  oid: string;
  /** Entra tenant of the authenticated identity. */
  tid: string;
}

export interface Federation {
  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string;
  exchange(p: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<EntraIdentity>;
}

export interface GraphMembership {
  /** The subset of `groupIds` the user is a (transitive) member of. */
  memberOf(oid: string, groupIds: string[]): Promise<string[]>;
}

/** Graph itself refused (401/403): the AS app lacks the Graph application permission, a tenant-admin consent gate. */
export class GraphConsentRequiredError extends Error {
  constructor(message = 'graph permission not consented') {
    super(message);
    this.name = 'GraphConsentRequiredError';
  }
}

/**
 * The AS app's Graph token could not be acquired, so Graph was never asked. Carries ONLY a fixed reason
 * class and, for a token-endpoint refusal, Entra's `error` token and first `error_codes` number (the #5504
 * pattern): never the response body, the client assertion, or a token. Distinct from the consent gate.
 */
export class GraphTokenError extends Error {
  constructor(
    readonly reason: string,
    readonly entraError?: string,
    readonly entraErrorCode?: number,
  ) {
    super('graph app token acquisition failed');
    this.name = 'GraphTokenError';
  }
}

/**
 * Scopes the AS asks Entra for. `profile` is REQUIRED: per the Entra ID token claims reference
 * (learn.microsoft.com/entra/identity-platform/id-token-claims-reference#payload-claims) `oid` is
 * only issued when the `profile` scope is requested, and exchange() requires `oid`. `tid` is issued
 * without `profile`. With `openid` alone every real sign-in failed on the missing `oid` (2026-11-27).
 */
export const ENTRA_SCOPE = 'openid profile';

/**
 * A federation exchange failure carrying ONLY a fixed reason class and, for a token-endpoint
 * refusal, Entra's `error` token and first `error_codes` number. Never the response body, the
 * authorization code, a token, or any claim value: the fields are safe to log as they stand.
 */
export class FederationError extends Error {
  constructor(
    readonly reason: string,
    readonly entraError?: string,
    readonly entraErrorCode?: number,
  ) {
    super('entra federation exchange failed');
    this.name = 'FederationError';
  }
}

const OAUTH_ERROR = /^[a-z_]{1,64}$/;
const JOSE_CODE = /^ERR_[A-Z_]{1,60}$/;
const CLAIM_NAME = /^[A-Za-z_]{1,32}$/;

/** Entra's `error` token and first `error_codes` integer, each only when it has the expected shape. */
async function entraErrorFields(res: Response): Promise<{ entraError?: string; entraErrorCode?: number }> {
  const out: { entraError?: string; entraErrorCode?: number } = {};
  try {
    const b = (await res.json()) as { error?: unknown; error_codes?: unknown };
    if (typeof b?.error === 'string' && OAUTH_ERROR.test(b.error)) out.entraError = b.error;
    const first = Array.isArray(b?.error_codes) ? b.error_codes[0] : undefined;
    if (typeof first === 'number' && Number.isInteger(first)) out.entraErrorCode = first;
  } catch {
    // Not JSON: the status alone is the class.
  }
  return out;
}

async function tokenEndpointError(res: Response): Promise<FederationError> {
  const { entraError, entraErrorCode } = await entraErrorFields(res);
  return new FederationError(`token_endpoint_${res.status}`, entraError, entraErrorCode);
}

/** jose's error code (plus the claim NAME for a claim failure); never its message or payload. */
function idTokenInvalid(e: unknown): FederationError {
  const raw = (e ?? {}) as { code?: unknown; claim?: unknown };
  const code = typeof raw.code === 'string' && JOSE_CODE.test(raw.code) ? raw.code : 'unknown';
  const claim = typeof raw.claim === 'string' && CLAIM_NAME.test(raw.claim) ? `:${raw.claim}` : '';
  return new FederationError(`id_token_invalid:${code}${claim}`);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (v: string): boolean => GUID.test(v);

export interface EntraFederationOptions {
  authorityHost: string;
  entraTenantId: string;
  /** App registration (client id) of the AS in this cloud's Entra tenant. */
  clientId: string;
  /** Returns a fresh client assertion (federated credential); no secret is held here. */
  getClientAssertion: () => Promise<string>;
  keyResolver: JWTVerifyGetKey;
  fetchImpl?: typeof fetch;
}

export function createEntraFederation(o: EntraFederationOptions): Federation {
  const f = o.fetchImpl ?? fetch;
  const base = `https://${o.authorityHost}/${o.entraTenantId}`;
  return {
    authorizeUrl(p) {
      const u = new URL(`${base}/oauth2/v2.0/authorize`);
      u.search = new URLSearchParams({
        client_id: o.clientId,
        response_type: 'code',
        redirect_uri: p.redirectUri,
        scope: ENTRA_SCOPE,
        state: p.state,
        nonce: p.nonce,
        code_challenge: p.codeChallenge,
        code_challenge_method: 'S256',
        response_mode: 'query',
      }).toString();
      return u.toString();
    },
    async exchange(p) {
      const res = await f(`${base}/oauth2/v2.0/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: o.clientId,
          grant_type: 'authorization_code',
          code: p.code,
          redirect_uri: p.redirectUri,
          code_verifier: p.codeVerifier,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await o.getClientAssertion(),
          scope: ENTRA_SCOPE,
        }),
      });
      if (!res.ok) throw await tokenEndpointError(res);
      let body: { id_token?: unknown } | undefined;
      try {
        body = (await res.json()) as { id_token?: unknown };
      } catch {
        throw new FederationError('id_token_missing');
      }
      if (typeof body?.id_token !== 'string') throw new FederationError('id_token_missing');
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(body.id_token, o.keyResolver, {
          issuer: `https://${o.authorityHost}/${o.entraTenantId}/v2.0`,
          audience: o.clientId,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'oid', 'tid', 'nonce'],
        }));
      } catch (e) {
        throw idTokenInvalid(e);
      }
      if (payload.nonce !== p.nonce) throw new FederationError('nonce_mismatch');
      if (typeof payload.oid !== 'string' || typeof payload.tid !== 'string') throw new FederationError('oid_tid_missing');
      return { oid: payload.oid, tid: payload.tid };
    },
  };
}

export interface AppTokenProviderOptions {
  authorityHost: string;
  entraTenantId: string;
  /** The AS app registration (loom-health-cp-as): the identity that holds the Graph application permissions. */
  clientId: string;
  /** The managed-identity token federated into the AS app (workload identity federation). */
  getClientAssertion: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Refresh this long before Entra's `expires_in` so a token is never presented at the edge of its life. */
export const APP_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

/**
 * Client-credentials tokens AS the AS app, authenticated by the federated managed-identity assertion.
 * Per scope: cached until `expires_in` minus the skew, single-flight while a fetch is in progress, and a
 * failed fetch is NEVER cached (the in-flight slot is cleared on settle, so the next call retries; #5416).
 */
export function createAppTokenProvider(o: AppTokenProviderOptions): (scope: string) => Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const url = `https://${o.authorityHost}/${o.entraTenantId}/oauth2/v2.0/token`;
  const cache = new Map<string, { token: string; refreshAt: number }>();
  const inflight = new Map<string, Promise<string>>();

  async function fetchToken(scope: string): Promise<string> {
    let assertion: string;
    try {
      assertion = await o.getClientAssertion();
    } catch {
      throw new GraphTokenError('client_assertion_failed');
    }
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: o.clientId,
          scope,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
        }),
      });
    } catch {
      throw new GraphTokenError('token_endpoint_unreachable');
    }
    if (!res.ok) {
      const { entraError, entraErrorCode } = await entraErrorFields(res);
      throw new GraphTokenError(`token_endpoint_${res.status}`, entraError, entraErrorCode);
    }
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw new GraphTokenError('access_token_missing');
    }
    if (typeof body?.access_token !== 'string' || body.access_token === '') throw new GraphTokenError('access_token_missing');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      cache.set(scope, { token: body.access_token, refreshAt: now() + expiresIn * 1000 - APP_TOKEN_REFRESH_SKEW_MS });
    }
    return body.access_token;
  }

  return (scope) => {
    const hit = cache.get(scope);
    if (hit && now() < hit.refreshAt) return Promise.resolve(hit.token);
    const pending = inflight.get(scope);
    if (pending) return pending;
    const p = fetchToken(scope).finally(() => inflight.delete(scope));
    inflight.set(scope, p);
    return p;
  };
}

export interface GraphMembershipOptions {
  cloud: Cloud;
  getToken: (scope: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Graph `checkMemberGroups` (<= 20 ids per call). UNVERIFIED as the minimum
 * least-privilege call/permission (security.md Q7); a 401/403 maps to the
 * consent gate rather than to "no membership".
 */
export function createGraphMembership(o: GraphMembershipOptions): GraphMembership {
  const f = o.fetchImpl ?? fetch;
  return {
    async memberOf(oid, groupIds) {
      if (!isGuid(oid)) throw new Error('oid is not a GUID');
      const out: string[] = [];
      for (let i = 0; i < groupIds.length; i += 20) {
        const chunk = groupIds.slice(i, i + 20);
        const res = await f(`https://${GRAPH_BY_CLOUD[o.cloud]}/v1.0/directoryObjects/${oid}/checkMemberGroups`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: { authorization: `Bearer ${await o.getToken(graphScope(o.cloud))}`, 'content-type': 'application/json' },
          body: JSON.stringify({ groupIds: chunk }),
        });
        if (res.status === 401 || res.status === 403) throw new GraphConsentRequiredError();
        if (!res.ok) throw new Error(`graph returned ${res.status}`);
        const body = (await res.json()) as { value?: unknown };
        if (!Array.isArray(body.value)) throw new Error('graph response has no value array');
        for (const g of body.value) if (typeof g === 'string' && chunk.includes(g)) out.push(g);
      }
      return out;
    },
  };
}
