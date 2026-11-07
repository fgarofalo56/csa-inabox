// Entra federation (OIDC authorization-code + PKCE, single Entra tenant in W1)
// and the server-side Microsoft Graph group-membership check (security.md A5).
// Both are seams: the server only sees the interfaces, tests inject fakes, and
// the production factories below talk to the per-cloud Entra and Graph hosts.
// The AS NEVER trusts a `groups` claim carried by a client or an id_token.

import { jwtVerify, type JWTVerifyGetKey } from 'jose';
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

/** The AS identity lacks the Graph application permission: a tenant-admin consent gate. */
export class GraphConsentRequiredError extends Error {}

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
        scope: 'openid',
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
          scope: 'openid',
        }),
      });
      if (!res.ok) throw new Error(`entra token endpoint returned ${res.status}`);
      const body = (await res.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string') throw new Error('entra response has no id_token');
      const { payload } = await jwtVerify(body.id_token, o.keyResolver, {
        issuer: `https://${o.authorityHost}/${o.entraTenantId}/v2.0`,
        audience: o.clientId,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'oid', 'tid', 'nonce'],
      });
      if (payload.nonce !== p.nonce) throw new Error('entra id_token nonce mismatch');
      if (typeof payload.oid !== 'string' || typeof payload.tid !== 'string') throw new Error('entra id_token lacks oid/tid');
      return { oid: payload.oid, tid: payload.tid };
    },
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
        if (res.status === 401 || res.status === 403) throw new GraphConsentRequiredError('graph permission not consented');
        if (!res.ok) throw new Error(`graph returned ${res.status}`);
        const body = (await res.json()) as { value?: unknown };
        if (!Array.isArray(body.value)) throw new Error('graph response has no value array');
        for (const g of body.value) if (typeof g === 'string' && chunk.includes(g)) out.push(g);
      }
      return out;
    },
  };
}
