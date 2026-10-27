// LHDS Authorization Server: SMART App Launch v2 over Entra (security.md A1-A8).
//
// handle(req, res) returns false when the path is not one of ours, so the host
// can chain it in front of the control-plane app. Routes:
//   GET  {issuerPath}/jwks.json
//   GET  {issuerPath}/callback                          (Entra redirect target)
//   GET  {issuerPath}/{tenant}/.well-known/smart-configuration
//   GET  {issuerPath}/{tenant}/authorize
//   POST {issuerPath}/{tenant}/token
//   admin (control-plane bearer auth): /api/health/auth/{clients,tenants/{t}/bindings,launch,readiness}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { HttpError, StoreConflictError, badRequest, conflict, notFound } from '../http/errors.js';
import type { Authenticator } from '../middleware/auth.js';
import { SLUG, type TenantDoc } from '../registry/types.js';
import { authoredMessage } from '../safe-error.js';
import type { Collection } from '../store/types.js';
import { ASSERTION_TYPE, verifyClientAssertion, type JwksFetcher } from './backend-auth.js';
import { computeGrant } from './grant.js';
import { GraphConsentRequiredError, isGuid, type Federation, type GraphMembership } from './federation.js';
import { ROLE_IDS, SCOPE_MAP_VERSION } from './role-map.js';
import { parseDataScope, parseRequest, intersectWithCeilings, type DataScope } from './scopes.js';
import type { Signer } from './signer.js';
import { ACCESS_TOKEN_TTL_S, mintAccessToken, mintIdToken } from './tokens.js';
import {
  OAuthError,
  sha256hex,
  type AuthStores,
  type BindingDoc,
  type ClientDoc,
  type GrantDoc,
  type RoleBinding,
} from './types.js';

export interface AuthServerDeps {
  /** Public issuer URL including its path, e.g. https://cp.example/auth. No trailing slash. */
  issuer: string;
  cloud: string;
  entraTenantId: string;
  stores: AuthStores;
  tenants: Collection<TenantDoc>;
  signer: Signer;
  federation: Federation;
  graph: GraphMembership;
  fhirBaseFor: (tenant: string) => string;
  authenticate: Authenticator;
  fetchJwks: JwksFetcher;
  /** Practitioner/Patient/RelatedPerson URL for an Entra oid; undefined means fhirUser is not granted (A3). */
  resolveFhirUser?: (oid: string, tenant: string) => Promise<string | undefined>;
  /** Admin-consent URL for the Graph permission gate. */
  graphConsentUrl?: string;
  log: (event: string, fields: Record<string, string | number>) => void;
  now?: () => Date;
}

/** What the host supplies; compose() adds authenticate, tenants and log. */
export type AuthServerInit = Omit<AuthServerDeps, 'authenticate' | 'tenants' | 'log' | 'now'>;

const AUTHREQ_TTL_S = 600;
const CODE_TTL_S = 60;
const REFRESH_TTL_S = 30 * 24 * 3600;
const LAUNCH_TTL_S = 300;
const MAX_BODY = 64 * 1024;

const rand = (n = 32): string => randomBytes(n).toString('base64url');
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const FHIR_ID = /^[A-Za-z0-9.-]{1,64}$/;

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(text);
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (ct !== 'application/x-www-form-urlencoded') throw new OAuthError('invalid_request', 'content-type must be application/x-www-form-urlencoded');
  return new URLSearchParams(await readBody(req));
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (ct !== 'application/json') throw badRequest('content-type must be application/json');
  try {
    return JSON.parse(await readBody(req));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest('body is not valid JSON');
  }
}

const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
const redirectUri = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return !u.username && !u.password && !u.hash && (u.protocol === 'https:' || loopback.test(v));
    } catch {
      return false;
    }
  }, 'must be https (or loopback http) without credentials or fragment');

const ClientCreateSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  tenant: z.string().regex(SLUG),
  clientType: z.enum(['backend', 'app']),
  displayName: z.string().trim().min(1).max(120),
  jwksUrl: z
    .string()
    .max(2048)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
      } catch {
        return false;
      }
    }, 'must be an https URL without credentials')
    .optional(),
  jwks: z
    .strictObject({
      keys: z
        .array(z.looseObject({ kty: z.string(), kid: z.string() }))
        .min(1)
        .max(20),
    })
    .optional(),
  allowedScopes: z.array(z.string()).min(1).max(100),
  roleIds: z.array(z.string()).max(20).default([]),
  redirectUris: z.array(redirectUri).max(10).default([]),
  pou: z.string().regex(/^[A-Z]{2,10}$/).default('TREAT'),
});

const BindingsSchema = z.strictObject({
  bindings: z.array(z.strictObject({ groupId: z.string().refine(isGuid, 'must be a GUID'), roleId: z.string() })).max(100),
  v1Scopes: z.boolean().default(true),
});

const LaunchSchema = z.strictObject({
  tenant: z.string().regex(SLUG),
  oid: z.string().refine(isGuid, 'must be a GUID'),
  clientId: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  patient: z.string().regex(FHIR_ID),
  encounter: z.string().regex(FHIR_ID).optional(),
  fhirContext: z.array(z.string().max(200)).max(10).optional(),
});

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];

export function createAuthServer(deps: AuthServerDeps) {
  const now = deps.now ?? (() => new Date());
  const base = new URL(deps.issuer).pathname.replace(/\/$/, '');
  const issuer = deps.issuer.replace(/\/$/, '');
  const callbackUrl = `${issuer}/callback`;
  const { stores } = deps;
  const expiry = (ttlS: number): string => new Date(now().getTime() + ttlS * 1000).toISOString();
  const expired = (g: { expiresAt: string }): boolean => Date.parse(g.expiresAt) <= now().getTime();

  async function activeTenant(slug: string): Promise<TenantDoc> {
    const t = await deps.tenants.get(slug);
    // T4: a suspended or destroying tenant gets no token. "Not found" and "not active" read the same.
    if (!t || t.status !== 'active') throw new OAuthError('invalid_request', 'tenant is not available');
    return t;
  }

  async function bindingFor(tenant: string): Promise<BindingDoc | undefined> {
    return stores.bindings.get(`binding-${tenant}`);
  }

  /** Roles for a user: server-side Graph check of exactly the bound groups. Never a client-supplied claim. */
  async function rolesForUser(tenant: string, oid: string): Promise<string[]> {
    const b = await bindingFor(tenant);
    if (!b || b.bindings.length === 0) return [];
    const groupIds = [...new Set(b.bindings.map((x) => x.groupId))];
    const member = new Set(await deps.graph.memberOf(oid, groupIds));
    return [...new Set(b.bindings.filter((x) => member.has(x.groupId)).map((x) => x.roleId))];
  }

  async function getClient(clientId: string): Promise<ClientDoc | undefined> {
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(clientId)) return undefined;
    return stores.clients.get(`client-${clientId}`);
  }

  async function authenticateClient(client: ClientDoc, p: URLSearchParams, tokenUrl: string): Promise<void> {
    const confidential = !!(client.jwks || client.jwksUrl);
    const assertion = p.get('client_assertion');
    if (!confidential) {
      if (client.clientType === 'backend') throw new OAuthError('invalid_client', 'client authentication failed');
      return; // public SMART app: PKCE is its proof of possession
    }
    if (!assertion || p.get('client_assertion_type') !== ASSERTION_TYPE) {
      throw new OAuthError('invalid_client', 'client authentication failed');
    }
    await verifyClientAssertion(assertion, client, tokenUrl, { replay: stores.replay, fetchJwks: deps.fetchJwks, now });
  }

  // ---- discovery / jwks ----
  async function smartConfiguration(tenant: string): Promise<unknown> {
    const t = await activeTenant(tenant);
    const b = await bindingFor(t.id);
    const caps = ['launch-ehr', 'launch-standalone', 'client-public', 'client-confidential-asymmetric', 'sso-openid-connect',
      'context-ehr-patient', 'context-standalone-patient', 'permission-offline', 'permission-patient', 'permission-user', 'permission-v2'];
    if (b?.v1Scopes) caps.push('permission-v1');
    return {
      issuer,
      jwks_uri: `${issuer}/jwks.json`,
      authorization_endpoint: `${issuer}/${t.id}/authorize`,
      token_endpoint: `${issuer}/${t.id}/token`,
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['RS384', 'ES384'],
      code_challenge_methods_supported: ['S256'], // never "plain"
      scopes_supported: ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access', 'patient/*.rs', 'user/*.rs', 'system/*.rs'],
      response_types_supported: ['code'],
      capabilities: caps,
      lhds_scope_map: SCOPE_MAP_VERSION,
    };
  }

  // ---- authorize ----
  async function authorize(res: ServerResponse, tenantSlug: string, q: URLSearchParams): Promise<void> {
    await activeTenant(tenantSlug);
    const client = await getClient(q.get('client_id') ?? '');
    const ru = q.get('redirect_uri') ?? '';
    // Until client + redirect_uri are verified nothing may be redirected to.
    if (!client || client.status !== 'active' || client.clientType !== 'app' || client.tenant !== tenantSlug || !client.redirectUris.includes(ru)) {
      throw new OAuthError('invalid_request', 'unknown client or redirect_uri');
    }
    const state = q.get('state') ?? undefined;
    const fail = (code: string, desc: string): void => {
      const u = new URL(ru);
      u.searchParams.set('error', code);
      u.searchParams.set('error_description', desc);
      if (state) u.searchParams.set('state', state);
      redirect(res, u.toString());
    };
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !PKCE_CHALLENGE.test(challenge)) {
      return fail('invalid_request', 'PKCE with S256 is required');
    }
    if (q.get('aud') !== deps.fhirBaseFor(tenantSlug)) return fail('invalid_request', 'aud must be the tenant FHIR base');
    const scope = q.get('scope') ?? '';
    const b = await bindingFor(tenantSlug);
    const parsed = parseRequest(scope, { v1: b?.v1Scopes ?? false });
    if (parsed.data.length === 0 && parsed.context.length === 0) return fail('invalid_scope', 'no acceptable scope requested');
    if (parsed.context.includes('launch') && !q.get('launch')) return fail('invalid_request', 'launch scope requires a launch parameter');
    const entraVerifier = rand(48);
    const id = rand(24);
    const entraNonce = rand(16);
    await stores.grants.create({
      id,
      kind: 'authreq',
      ttl: AUTHREQ_TTL_S,
      expiresAt: expiry(AUTHREQ_TTL_S),
      tenant: tenantSlug,
      clientId: client.clientId,
      redirectUri: ru,
      codeChallenge: challenge,
      ...(state ? { clientState: state } : {}),
      ...(q.get('nonce') ? { clientNonce: q.get('nonce') as string } : {}),
      entraNonce,
      entraVerifier,
      requestedScope: scope,
      aud: q.get('aud') as string,
      ...(q.get('launch') ? { launchHandle: sha256hex(q.get('launch') as string) } : {}),
    });
    redirect(res, deps.federation.authorizeUrl({ state: id, nonce: entraNonce, codeChallenge: s256(entraVerifier), redirectUri: callbackUrl }));
  }

  // ---- Entra callback ----
  async function callback(res: ServerResponse, q: URLSearchParams): Promise<void> {
    const reqId = q.get('state') ?? '';
    const ar = reqId ? await stores.grants.get(reqId) : undefined;
    if (!ar || ar.kind !== 'authreq' || ar.used || expired(ar)) throw new OAuthError('invalid_request', 'unknown or expired authorization request');
    try {
      await stores.grants.replace({ ...ar, used: true }); // single use; a concurrent second callback loses the etag race
    } catch (e) {
      if (e instanceof StoreConflictError) throw new OAuthError('invalid_request', 'unknown or expired authorization request');
      throw e;
    }
    const back = (params: Record<string, string>): void => {
      const u = new URL(ar.redirectUri as string);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (ar.clientState) u.searchParams.set('state', ar.clientState);
      redirect(res, u.toString());
    };
    const code = q.get('code');
    if (q.get('error') || !code) return back({ error: 'access_denied', error_description: 'sign-in was not completed' });

    let identity;
    try {
      identity = await deps.federation.exchange({ code, codeVerifier: ar.entraVerifier as string, redirectUri: callbackUrl, nonce: ar.entraNonce as string });
    } catch {
      return back({ error: 'access_denied', error_description: 'sign-in could not be completed' });
    }
    // T4: the Entra tid must equal the Entra tenant bound to the control plane.
    if (identity.tid !== deps.entraTenantId) return back({ error: 'access_denied', error_description: 'identity is not from the bound tenant' });
    const tenant = await deps.tenants.get(ar.tenant);
    if (!tenant || tenant.status !== 'active') return back({ error: 'access_denied', error_description: 'tenant is not available' });

    const b = await bindingFor(ar.tenant);
    const parsed = parseRequest(ar.requestedScope ?? '', { v1: b?.v1Scopes ?? false });
    let roleIds: string[];
    try {
      roleIds = await rolesForUser(ar.tenant, identity.oid);
    } catch (e) {
      deps.log('auth.membership_error', { error: e instanceof Error ? e.name : 'unknown', consent: e instanceof GraphConsentRequiredError ? 1 : 0 });
      return back({ error: 'server_error', error_description: 'role membership could not be established' });
    }

    let patient: string | undefined;
    let encounter: string | undefined;
    let fhirContext: string[] | undefined;
    if (ar.launchHandle) {
      const h = await stores.grants.get(ar.launchHandle);
      // Single-use; bound to tenant + oid + client_id (A3). Any mismatch reads the same.
      const ok = !!h && h.kind === 'launch' && !h.used && !expired(h) && h.tenant === ar.tenant && h.oid === identity.oid && h.clientId === ar.clientId;
      if (!ok || !h) return back({ error: 'access_denied', error_description: 'launch context is not valid for this user and client' });
      try {
        await stores.grants.replace({ ...h, used: true });
      } catch (e) {
        if (e instanceof StoreConflictError) return back({ error: 'access_denied', error_description: 'launch context is not valid for this user and client' });
        throw e;
      }
      patient = h.patient;
      encounter = h.encounter;
      fhirContext = h.fhirContext;
    }
    // Standalone `launch/patient` needs the patient picker; it is not built in W1, so no patient
    // context exists here and every patient/ scope is dropped by computeGrant.

    const fhirUser = await deps.resolveFhirUser?.(identity.oid, ar.tenant);
    const client = await getClient(ar.clientId);
    if (!client || client.status !== 'active') return back({ error: 'access_denied', error_description: 'client is not available' });
    const g = computeGrant({
      grant: 'authorization_code',
      request: parsed,
      roleIds,
      clientAllowed: client.allowedScopes,
      ...(patient ? { patient } : {}),
      fhirUserResolved: !!fhirUser,
    });
    if (g.scope.length === 0) return back({ error: 'invalid_scope', error_description: 'no requested scope could be granted' });

    const codeValue = rand(32);
    const echo: Record<string, string> = {};
    for (const [k, v] of parsed.echo) echo[k] = v;
    const doc: GrantDoc = {
      id: sha256hex(codeValue),
      kind: 'code',
      ttl: CODE_TTL_S,
      expiresAt: expiry(CODE_TTL_S),
      tenant: ar.tenant,
      clientId: ar.clientId,
      redirectUri: ar.redirectUri as string,
      codeChallenge: ar.codeChallenge as string,
      oid: identity.oid,
      idpTid: identity.tid,
      grantedScope: g.scope,
      echo,
      aud: ar.aud as string,
    };
    if (ar.clientNonce) doc.clientNonce = ar.clientNonce;
    if (ar.launchHandle) doc.launchHandle = ar.launchHandle;
    if (patient) doc.patient = patient;
    if (encounter) doc.encounter = encounter;
    if (fhirContext) doc.fhirContext = fhirContext;
    if (fhirUser) doc.fhirUser = fhirUser;
    await stores.grants.create(doc);
    back({ code: codeValue });
  }

  // ---- token ----
  const dataScopesOf = (scope: string[]): DataScope[] =>
    scope.map((s) => parseDataScope(s, { v1: false })).filter((x): x is DataScope => !!x);

  async function userTokenResponse(g: {
    tenant: string;
    clientId: string;
    oid: string;
    idpTid: string;
    scope: string[];
    echo: Record<string, string>;
    patient?: string;
    encounter?: string;
    fhirUser?: string;
    nonce?: string;
    aud: string;
    roles: string[];
    refresh: boolean;
    launched: boolean;
  }): Promise<Record<string, unknown>> {
    const t = now();
    const accessToken = await mintAccessToken(deps.signer, {
      issuer,
      audience: g.aud,
      tenant: g.tenant,
      subType: 'user',
      sub: g.oid,
      idpTid: g.idpTid,
      clientId: g.clientId,
      scope: g.scope,
      ...(g.patient ? { patient: g.patient } : {}),
      ...(g.encounter ? { encounter: g.encounter } : {}),
      ...(g.fhirUser ? { fhirUser: g.fhirUser } : {}),
      roles: g.roles,
      pou: ['TREAT'],
      now: t,
    });
    const out: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      // The response echoes scopes in the client's own syntax (A2 normalisation 2).
      scope: g.scope.map((s) => g.echo[s] ?? s).join(' '),
      tenant: g.tenant,
    };
    if (g.patient) {
      out.patient = g.patient;
      out.need_patient_banner = !g.launched; // an EHR launch already showed the patient
    }
    if (g.encounter) out.encounter = g.encounter;
    if (g.scope.includes('openid')) {
      out.id_token = await mintIdToken(deps.signer, {
        issuer,
        clientId: g.clientId,
        sub: g.oid,
        ...(g.nonce ? { nonce: g.nonce } : {}),
        ...(g.fhirUser ? { fhirUser: g.fhirUser } : {}),
        now: t,
      });
    }
    if (g.refresh) {
      const rt = rand(32);
      await stores.grants.create({
        id: sha256hex(rt),
        kind: 'refresh',
        ttl: REFRESH_TTL_S,
        expiresAt: expiry(REFRESH_TTL_S),
        tenant: g.tenant,
        clientId: g.clientId,
        oid: g.oid,
        idpTid: g.idpTid,
        grantedScope: g.scope,
        echo: g.echo,
        aud: g.aud,
        ...(g.patient ? { patient: g.patient } : {}),
        ...(g.encounter ? { encounter: g.encounter } : {}),
        ...(g.fhirUser ? { fhirUser: g.fhirUser } : {}),
        ...(g.nonce ? { clientNonce: g.nonce } : {}),
        ...(g.launched ? { launchHandle: 'bound' } : {}),
      });
      out.refresh_token = rt;
    }
    return out;
  }

  async function markUsed(doc: GrantDoc): Promise<void> {
    try {
      await stores.grants.replace({ ...doc, used: true });
    } catch (e) {
      if (e instanceof StoreConflictError) throw new OAuthError('invalid_grant', 'grant is invalid or already used');
      throw e;
    }
  }

  async function token(tenantSlug: string, p: URLSearchParams): Promise<Record<string, unknown>> {
    await activeTenant(tenantSlug);
    const tokenUrl = `${issuer}/${tenantSlug}/token`;
    const grantType = p.get('grant_type');

    if (grantType === 'client_credentials') {
      const assertion = p.get('client_assertion');
      let clientId = '';
      try {
        clientId = String(assertion ? decodeJwt(assertion).iss ?? '' : '');
      } catch {
        clientId = '';
      }
      const client = clientId ? await getClient(clientId) : undefined;
      // Unknown, disabled, wrong-tenant and non-backend all read as the same invalid_client.
      if (!client || client.status !== 'active' || client.clientType !== 'backend' || client.tenant !== tenantSlug) {
        throw new OAuthError('invalid_client', 'client authentication failed');
      }
      await authenticateClient(client, p, tokenUrl);
      const g = computeGrant({
        grant: 'client_credentials',
        request: parseRequest(p.get('scope') ?? '', { v1: false }),
        roleIds: client.roleIds,
        clientAllowed: client.allowedScopes,
        fhirUserResolved: false,
      });
      if (g.scope.length === 0) throw new OAuthError('invalid_scope', 'no requested scope could be granted');
      const at = await mintAccessToken(deps.signer, {
        issuer,
        audience: deps.fhirBaseFor(tenantSlug),
        tenant: tenantSlug,
        subType: 'system',
        sub: client.clientId,
        clientId: client.clientId,
        scope: g.scope,
        roles: client.roleIds,
        pou: [client.pou],
        now: now(),
      });
      // No refresh token for Backend Services (spec "SHOULD NOT").
      return { access_token: at, token_type: 'bearer', expires_in: ACCESS_TOKEN_TTL_S, scope: g.scope.join(' ') };
    }

    if (grantType === 'authorization_code' || grantType === 'refresh_token') {
      const client = await getClient(p.get('client_id') ?? '');
      if (!client || client.status !== 'active' || client.clientType !== 'app' || client.tenant !== tenantSlug) {
        throw new OAuthError('invalid_client', 'client authentication failed');
      }
      await authenticateClient(client, p, tokenUrl);

      if (grantType === 'authorization_code') {
        const codeIn = p.get('code') ?? '';
        const doc = codeIn ? await stores.grants.get(sha256hex(codeIn)) : undefined;
        if (!doc || doc.kind !== 'code' || doc.used || expired(doc) || doc.clientId !== client.clientId || doc.tenant !== tenantSlug) {
          throw new OAuthError('invalid_grant', 'grant is invalid or already used');
        }
        if (p.get('redirect_uri') !== doc.redirectUri) throw new OAuthError('invalid_grant', 'grant is invalid or already used');
        const verifier = p.get('code_verifier') ?? '';
        if (!verifier || !safeEq(s256(verifier), doc.codeChallenge ?? '')) throw new OAuthError('invalid_grant', 'PKCE verification failed');
        await markUsed(doc);
        const scope = doc.grantedScope ?? [];
        return userTokenResponse({
          tenant: doc.tenant,
          clientId: doc.clientId,
          oid: doc.oid as string,
          idpTid: doc.idpTid as string,
          scope,
          echo: doc.echo ?? {},
          ...(doc.patient ? { patient: doc.patient } : {}),
          ...(doc.encounter ? { encounter: doc.encounter } : {}),
          ...(doc.fhirUser ? { fhirUser: doc.fhirUser } : {}),
          ...(doc.clientNonce ? { nonce: doc.clientNonce } : {}),
          aud: doc.aud as string,
          roles: await rolesForUser(doc.tenant, doc.oid as string),
          refresh: scope.includes('offline_access'),
          launched: !!doc.launchHandle,
        });
      }

      // refresh_token: re-run the FULL mapping; scopes can only shrink (A3, N20).
      const rtIn = p.get('refresh_token') ?? '';
      const doc = rtIn ? await stores.grants.get(sha256hex(rtIn)) : undefined;
      if (!doc || doc.kind !== 'refresh' || doc.used || expired(doc) || doc.clientId !== client.clientId || doc.tenant !== tenantSlug) {
        throw new OAuthError('invalid_grant', 'grant is invalid or already used');
      }
      await activeTenant(doc.tenant);
      // Group re-check BEFORE the token is burned: a transient Graph failure must not cost the user their refresh token (#5134).
      const roles = await rolesForUser(doc.tenant, doc.oid as string);
      await markUsed(doc);
      const original = doc.grantedScope ?? [];
      const originalData = dataScopesOf(original);
      let wanted = originalData;
      if (p.get('scope')) {
        // A narrower scope may be asked for; it can never exceed the original grant.
        wanted = intersectWithCeilings(parseRequest(p.get('scope') as string, { v1: false }).data, originalData);
      }
      const g = computeGrant({
        grant: 'authorization_code',
        request: {
          data: wanted,
          context: original.filter((s) => !parseDataScope(s, { v1: false })),
          echo: new Map(),
          rejected: [],
        },
        roleIds: roles,
        clientAllowed: client.allowedScopes,
        ...(doc.patient ? { patient: doc.patient } : {}),
        fhirUserResolved: !!doc.fhirUser,
      });
      if (g.data.length === 0) throw new OAuthError('invalid_grant', 'grant no longer carries any data scope');
      return userTokenResponse({
        tenant: doc.tenant,
        clientId: doc.clientId,
        oid: doc.oid as string,
        idpTid: doc.idpTid as string,
        scope: g.scope,
        echo: doc.echo ?? {},
        ...(doc.patient ? { patient: doc.patient } : {}),
        ...(doc.encounter ? { encounter: doc.encounter } : {}),
        ...(doc.fhirUser ? { fhirUser: doc.fhirUser } : {}),
        ...(doc.clientNonce ? { nonce: doc.clientNonce } : {}),
        aud: doc.aud as string,
        roles,
        refresh: g.scope.includes('offline_access'),
        launched: !!doc.launchHandle,
      });
    }
    throw new OAuthError('unsupported_grant_type', 'unsupported grant_type');
  }

  // ---- admin (control-plane bearer auth) ----
  async function admin(req: IncomingMessage, method: string, path: string): Promise<{ status: number; data: unknown } | undefined> {
    const auth = req.headers.authorization;
    const ok = (data: unknown, status = 200) => ({ status, data });
    if (path === '/api/health/auth/clients' && method === 'GET') {
      await deps.authenticate(auth, 'read');
      // The config container also holds binding documents; keep clients only.
      return ok({ clients: (await stores.clients.list(500)).filter((c) => c.kind === 'client').map(publicClient) });
    }
    if (path === '/api/health/auth/clients' && method === 'POST') {
      const who = await deps.authenticate(auth, 'write');
      const p = ClientCreateSchema.safeParse(await readJson(req));
      if (!p.success) throw badRequest(`${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message ?? 'invalid'}`);
      const c = p.data;
      if ((await deps.tenants.get(c.tenant)) === undefined) throw notFound('tenant');
      if (!!c.jwksUrl === !!c.jwks && (c.clientType === 'backend' || c.jwksUrl || c.jwks)) {
        throw badRequest('supply exactly one of jwksUrl or jwks (a backend client must have one)');
      }
      for (const k of c.jwks?.keys ?? []) {
        if (PRIVATE_JWK_MEMBERS.some((m) => m in k)) throw badRequest('jwks must contain public keys only');
      }
      for (const s of c.allowedScopes) if (!parseDataScope(s, { v1: false })) throw badRequest(`allowedScopes: not an accepted scope: ${s.slice(0, 80)}`);
      for (const r of c.roleIds) if (!ROLE_IDS.has(r)) throw badRequest(`roleIds: unknown role ${r.slice(0, 60)}`);
      if (c.clientType === 'backend' && c.roleIds.length === 0) throw badRequest('a backend client needs at least one role');
      if (c.clientType === 'app' && c.redirectUris.length === 0) throw badRequest('an app client needs at least one redirectUri');
      if (c.pou === 'BTG') throw badRequest('BTG is not issued in this release');
      const doc: ClientDoc = {
        id: `client-${c.clientId}`,
        kind: 'client',
        clientId: c.clientId,
        tenant: c.tenant,
        clientType: c.clientType,
        displayName: c.displayName,
        status: 'active',
        allowedScopes: c.allowedScopes,
        roleIds: c.roleIds,
        redirectUris: c.redirectUris,
        pou: c.pou,
        updatedAt: now().toISOString(),
        updatedBy: who.id,
        ...(c.jwksUrl ? { jwksUrl: c.jwksUrl } : {}),
        ...(c.jwks ? { jwks: c.jwks as ClientDoc['jwks'] } : {}),
      };
      try {
        return ok(publicClient(await stores.clients.create(doc)), 201);
      } catch (e) {
        if (e instanceof StoreConflictError) throw conflict('client already exists');
        throw e;
      }
    }
    const cm = /^\/api\/health\/auth\/clients\/([A-Za-z0-9._-]{3,64})$/.exec(path);
    if (cm && method === 'PATCH') {
      const who = await deps.authenticate(auth, 'write');
      const p = z.strictObject({ status: z.enum(['active', 'disabled']) }).safeParse(await readJson(req));
      if (!p.success) throw badRequest('status: must be active or disabled');
      const cur = await stores.clients.get(`client-${cm[1]}`);
      if (!cur) throw notFound('client');
      return ok(publicClient(await stores.clients.replace({ ...cur, status: p.data.status, updatedAt: now().toISOString(), updatedBy: who.id })));
    }
    const bm = /^\/api\/health\/auth\/tenants\/([a-z0-9-]{2,40})\/bindings$/.exec(path);
    if (bm && method === 'GET') {
      await deps.authenticate(auth, 'read');
      const b = await bindingFor(bm[1] as string);
      return ok(b ?? { tenant: bm[1], bindings: [], v1Scopes: true });
    }
    if (bm && method === 'PUT') {
      const who = await deps.authenticate(auth, 'write');
      const slug = bm[1] as string;
      if ((await deps.tenants.get(slug)) === undefined) throw notFound('tenant');
      const p = BindingsSchema.safeParse(await readJson(req));
      if (!p.success) throw badRequest(`${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message ?? 'invalid'}`);
      for (const x of p.data.bindings) if (!ROLE_IDS.has(x.roleId)) throw badRequest(`bindings: unknown role ${x.roleId.slice(0, 60)}`);
      const next: Omit<BindingDoc, '_etag'> = {
        id: `binding-${slug}`,
        kind: 'binding',
        tenant: slug,
        bindings: p.data.bindings as RoleBinding[],
        v1Scopes: p.data.v1Scopes,
        updatedAt: now().toISOString(),
        updatedBy: who.id,
      };
      const cur = await stores.bindings.get(next.id);
      try {
        return ok(cur ? await stores.bindings.replace({ ...next, _etag: cur._etag as string }) : await stores.bindings.create(next));
      } catch (e) {
        if (e instanceof StoreConflictError) throw conflict('bindings changed concurrently; retry');
        throw e;
      }
    }
    if (path === '/api/health/auth/launch' && method === 'POST') {
      await deps.authenticate(auth, 'write');
      const p = LaunchSchema.safeParse(await readJson(req));
      if (!p.success) throw badRequest(`${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message ?? 'invalid'}`);
      const l = p.data;
      if ((await deps.tenants.get(l.tenant)) === undefined) throw notFound('tenant');
      const handle = rand(32);
      const expiresAt = expiry(LAUNCH_TTL_S);
      await stores.grants.create({
        id: sha256hex(handle),
        kind: 'launch',
        ttl: LAUNCH_TTL_S,
        expiresAt,
        tenant: l.tenant,
        clientId: l.clientId,
        oid: l.oid,
        patient: l.patient,
        ...(l.encounter ? { encounter: l.encounter } : {}),
        ...(l.fhirContext ? { fhirContext: l.fhirContext } : {}),
      });
      return ok({ launch: handle, expiresAt }, 201);
    }
    if (path === '/api/health/auth/readiness' && method === 'GET') {
      await deps.authenticate(auth, 'read');
      return ok(await readiness());
    }
    return undefined;
  }

  /** Graph consent gate (G2): a status plus the one-click Fix-it descriptor. */
  async function readiness(): Promise<unknown> {
    const gate = {
      id: 'health-auth-graph-consent',
      title: 'Group membership check (Microsoft Graph)',
      fixIt: {
        label: 'Grant admin consent',
        action: 'admin-consent',
        permission: 'GroupMember.Read.All (application) - UNVERIFIED as the minimum',
        ...(deps.graphConsentUrl ? { url: deps.graphConsentUrl } : {}),
      },
    };
    try {
      // Probe with the all-zero object id: a consent failure is the only outcome we classify.
      await deps.graph.memberOf('00000000-0000-0000-0000-000000000000', ['00000000-0000-0000-0000-000000000000']);
      return { ...gate, status: 'ok' };
    } catch (e) {
      if (e instanceof GraphConsentRequiredError) return { ...gate, status: 'needs-consent' };
      return { ...gate, status: 'unknown' };
    }
  }

  const publicClient = (c: ClientDoc) => {
    const { _etag, ...rest } = c;
    void _etag;
    return rest;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const isAdmin = path.startsWith('/api/health/auth/');
    const inBase = path === `${base}/jwks.json` || path === `${base}/callback` || path.startsWith(`${base}/`);
    if (!isAdmin && !inBase) return false;
    const started = Date.now();
    let status = 500;
    try {
      if (isAdmin) {
        const r = await admin(req, method, path);
        if (!r) return false;
        status = r.status;
        sendJson(res, status, { ok: true, data: r.data });
        return true;
      }
      if (path === `${base}/jwks.json` && method === 'GET') {
        status = 200;
        sendJson(res, 200, { keys: [await deps.signer.publicJwk()] });
        return true;
      }
      if (path === `${base}/callback` && method === 'GET') {
        status = 302;
        await callback(res, url.searchParams);
        return true;
      }
      const m = /^\/([a-z0-9-]{2,40})\/(\.well-known\/smart-configuration|authorize|token)$/.exec(path.slice(base.length));
      if (!m) return false;
      const [, tenant, leaf] = m as unknown as [string, string, string];
      if (leaf === '.well-known/smart-configuration' && method === 'GET') {
        status = 200;
        sendJson(res, 200, await smartConfiguration(tenant));
        return true;
      }
      if (leaf === 'authorize' && method === 'GET') {
        status = 302;
        await authorize(res, tenant, url.searchParams);
        return true;
      }
      if (leaf === 'token' && method === 'POST') {
        const out = await token(tenant, await readForm(req));
        status = 200;
        sendJson(res, 200, out);
        return true;
      }
      status = 405;
      sendJson(res, 405, { error: 'invalid_request', error_description: 'method not allowed' });
      return true;
    } catch (e) {
      if (e instanceof OAuthError) {
        status = e.status;
        sendJson(res, status, { error: e.code, error_description: e.description }, status === 401 ? { 'www-authenticate': 'Basic realm="lhds"' } : {});
      } else if (e instanceof HttpError) {
        status = e.status;
        sendJson(res, status, { ok: false, error: { code: e.code, message: authoredMessage(e) } }, status === 401 ? { 'www-authenticate': 'Bearer' } : {});
      } else {
        status = 500;
        deps.log('auth.internal_error', { error: e instanceof Error ? e.name : 'unknown' });
        sendJson(res, 500, { error: 'server_error', error_description: 'internal error' });
      }
      return true;
    } finally {
      deps.log('auth.request', { method, status, ms: Date.now() - started });
    }
  }

  return { handle };
}

export type AuthServer = ReturnType<typeof createAuthServer>;
