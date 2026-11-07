// Caller authentication for the admin API. Every route except the liveness
// probe goes through authenticate(): a signed Entra bearer token (signature via
// the tenant JWKS, issuer, audience, expiry) plus an app-role check and an
// optional caller-app allowlist. Fails closed: anything unverifiable is 401, a
// verified caller without the needed role is 403.

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config.js';
import { forbidden, unauthorized } from '../http/errors.js';

export type Permission = 'read' | 'write' | 'report';

export const ROLES = {
  reader: 'HealthCP.Reader',
  admin: 'HealthCP.Admin',
  reporter: 'HealthCP.StampReporter',
} as const;

const ROLES_FOR: Record<Permission, readonly string[]> = {
  read: [ROLES.reader, ROLES.admin],
  write: [ROLES.admin],
  report: [ROLES.reporter, ROLES.admin],
};

export interface Caller {
  /** Stable, non-PHI identifier for audit fields and logs (object id, else app id). */
  id: string;
  appId: string | undefined;
  roles: string[];
}

export interface AuthOptions {
  authorityHost: string;
  entraTenantId: string;
  audiences: string[];
  allowedCallerAppIds: string[];
  /** Seam: production = remote JWKS for the tenant; tests inject a local key set. */
  keyResolver: JWTVerifyGetKey;
}

export function jwksUrl(authorityHost: string, tenantId: string): URL {
  return new URL(`https://${authorityHost}/${tenantId}/discovery/v2.0/keys`);
}

export function createAuthenticator(opts: AuthOptions) {
  const issuers = [
    `https://${opts.authorityHost}/${opts.entraTenantId}/v2.0`,
    `https://sts.windows.net/${opts.entraTenantId}/`,
  ];
  return async function authenticate(authorization: string | undefined, need: Permission): Promise<Caller> {
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization ?? '');
    if (!m || !m[1]) throw unauthorized();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1], opts.keyResolver, {
        issuer: issuers,
        audience: opts.audiences,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      }));
    } catch {
      throw unauthorized();
    }
    const roles = Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === 'string') : [];
    const appId =
      typeof payload.azp === 'string' ? payload.azp : typeof payload.appid === 'string' ? payload.appid : undefined;
    if (opts.allowedCallerAppIds.length > 0 && (!appId || !opts.allowedCallerAppIds.includes(appId))) {
      throw forbidden();
    }
    if (!roles.some((r) => ROLES_FOR[need].includes(r))) throw forbidden();
    const oid = typeof payload.oid === 'string' ? payload.oid : undefined;
    return { id: oid ?? appId ?? 'unknown', appId, roles };
  };
}

export type Authenticator = ReturnType<typeof createAuthenticator>;

export function authOptionsFromConfig(cfg: Config): AuthOptions {
  return {
    authorityHost: cfg.authorityHost,
    entraTenantId: cfg.entraTenantId,
    audiences: cfg.audiences,
    allowedCallerAppIds: cfg.allowedCallerAppIds,
    keyResolver: createRemoteJWKSet(jwksUrl(cfg.authorityHost, cfg.entraTenantId), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    }),
  };
}
