// LHDS Authorization Server: SMART App Launch v2 over Entra (security.md A1-A8).
//
// handle(req, res) returns false when the path is not one of ours, so the host
// can chain it in front of the control-plane app. Routes:
//   GET  {issuerPath}/jwks.json
//   GET  {issuerPath}/.well-known/openid-configuration  (tenant-independent; APIM validate-jwt, #5160)
//   GET  {issuerPath}/callback                          (Entra redirect target)
//   GET  {issuerPath}/{tenant}/.well-known/smart-configuration
//   GET  {issuerPath}/{tenant}/.well-known/openid-configuration  (per-tenant OIDC issuer for id_tokens, #5454)
//   GET  /{tenant}/fhir/.well-known/smart-configuration  (the FHIR base path the edge forwards unchanged, #5454)
//   GET  {issuerPath}/{tenant}/authorize
//   GET  {issuerPath}/{tenant}/pick                      (standalone patient picker page, #5454 A5)
//   POST {issuerPath}/{tenant}/pick                      (the picker's choice or cancel)
//   POST {issuerPath}/{tenant}/token
//   OPTIONS on the discovery, jwks and token paths answers the CORS preflight.
//   admin (control-plane bearer auth): /api/health/auth/{clients,clients/{id},tenants/{t}/bindings,
//     tenants/{t}/fhir-users[/{oid}],tenants/{t}/patient-search,launch,readiness}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeJwt, type JWK } from 'jose';
import { z } from 'zod';
import { HttpError, StoreConflictError, badRequest, conflict, notFound } from '../http/errors.js';
import type { Authenticator } from '../middleware/auth.js';
import { SLUG, type TenantDoc } from '../registry/types.js';
import { authoredMessage, classifyError } from '../safe-error.js';
import type { Collection } from '../store/types.js';
import { ASSERTION_TYPE, verifyClientAssertion, type JwksFetcher } from './backend-auth.js';
import { FHIR_ID, FHIR_USER_RESOURCE, fhirUserDocId } from './fhir-user.js';
import { computeGrant } from './grant.js';
import { MIN_RSA_BITS, isPrivateHost, rsaModulusBits } from './jwks-guard.js';
import { FederationError, GraphConsentRequiredError, GraphTokenError, isGuid, type Federation, type GraphMembership } from './federation.js';
import { FHIR_DATE, PatientSearchUnavailableError, createFhirPatientSearch, type PatientSearch } from './patient-search.js';
import { PICKER_HEADERS, renderPicker, renderPickerError, type PickerState } from './picker-page.js';
import { ROLE_IDS, SCOPE_MAP_VERSION, ceilingsFor } from './role-map.js';
import { parseDataScope, parseRequest, intersectWithCeilings, serializeScope, type DataScope } from './scopes.js';
import type { IdTokenSigner, Signer } from './signer.js';
import { ACCESS_TOKEN_TTL_S, mintAccessToken, mintIdToken } from './tokens.js';
import {
  OAuthError,
  normalizeFhirContext,
  sha256hex,
  type AuthStores,
  type BindingDoc,
  type ClientDoc,
  type FhirContextItem,
  type FhirUserDoc,
  type GrantDoc,
  type RoleBinding,
} from './types.js';

/**
 * Log fields for a failed Entra exchange. FederationError carries only a fixed reason class plus Entra's
 * error token and first error code (never the body, the authorization code or a token); anything else
 * (network, timeout, client-assertion mint) goes through classifyError's sanitiser.
 */
function federationFailure(e: unknown): Record<string, string | number> {
  if (e instanceof FederationError) {
    return {
      reason: e.reason,
      ...(e.entraError ? { entraError: e.entraError } : {}),
      ...(e.entraErrorCode !== undefined ? { entraErrorCode: e.entraErrorCode } : {}),
    };
  }
  return { reason: 'exchange_error', ...classifyError(e) };
}

/**
 * Log fields for a failed membership check. `cause` separates the AS app's Graph token not being acquired
 * (`token_acquisition`, with the sanitised token-endpoint reason) from Graph refusing the call (`graph_refused`,
 * the consent gate): before this split both read as `consent:1` and sent a consent hunt after a token failure.
 */
export function membershipFailure(e: unknown): Record<string, string | number> {
  if (e instanceof GraphTokenError) {
    return {
      error: e.name,
      cause: 'token_acquisition',
      consent: 0,
      reason: e.reason,
      ...(e.entraError ? { entraError: e.entraError } : {}),
      ...(e.entraErrorCode !== undefined ? { entraErrorCode: e.entraErrorCode } : {}),
    };
  }
  if (e instanceof GraphConsentRequiredError) return { error: e.name, cause: 'graph_refused', consent: 1 };
  return { error: e instanceof Error ? classifyError(e).name : 'unknown', cause: 'other', consent: 0 };
}

export interface AuthServerDeps {
  /** Public issuer URL including its path, e.g. https://cp.example/auth. No trailing slash. */
  issuer: string;
  cloud: string;
  entraTenantId: string;
  stores: AuthStores;
  tenants: Collection<TenantDoc>;
  /** Access-token signer (ES384). */
  signer: Signer;
  /** id_token signer (RS256, #5454 A7). Required: there is no ES384 fallback for id_tokens. */
  idTokenSigner: IdTokenSigner;
  federation: Federation;
  graph: GraphMembership;
  fhirBaseFor: (tenant: string) => string;
  authenticate: Authenticator;
  fetchJwks: JwksFetcher;
  /**
   * Absolute FHIR URL of the resource an Entra oid is in a tenant (wire.ts: the fhir-users mapping, #5454 A4).
   * undefined means fhirUser is not granted; a throw fails the sign-in closed. Absent => fhirUser is never granted.
   */
  resolveFhirUser?: (oid: string, tenant: string) => Promise<string | undefined>;
  /** Admin-consent URL for the Graph permission gate. */
  graphConsentUrl?: string;
  /**
   * Patient search for the standalone picker (#5454 A5). Absent => FHIR REST at fhirBaseFor(tenant) with a 60 s
   * token the AS mints for the signed-in user, over `fetchFhir` (default: the global fetch).
   */
  patientSearch?: PatientSearch;
  fetchFhir?: typeof fetch;
  log: (event: string, fields: Record<string, string | number>) => void;
  now?: () => Date;
}

/** What the host supplies; compose() adds authenticate, tenants and log. */
export type AuthServerInit = Omit<AuthServerDeps, 'authenticate' | 'tenants' | 'log' | 'now'>;

const AUTHREQ_TTL_S = 600;
const CODE_TTL_S = 60;
const REFRESH_TTL_S = 30 * 24 * 3600;
const LAUNCH_TTL_S = 300;
/** A pending patient pick: the user has signed in and must choose a patient before any code exists (#5454 A5). */
const PICK_TTL_S = 600;
/** The picker's search token: bound to the user, short-lived, never handed to the app. */
const PICKER_TOKEN_TTL_S = 60;
/** `client_id` of the picker's search token: the AS acting for the user, not the app being authorized. */
export const PICKER_CLIENT_ID = 'lhds-patient-picker';
const PICKER_SCOPE = parseDataScope('user/Patient.rs', { v1: false }) as DataScope;
const MAX_BODY = 64 * 1024;

const rand = (n = 32): string => randomBytes(n).toString('base64url');
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

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
function redirect(res: ServerResponse, location: string, extra: Record<string, string> = {}): void {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extra });
  res.end();
}
/** The browser-binding cookie is named per authorization request so concurrent sign-ins do not clobber each other. */
const bindCookieName = (reqId: string): string => `lhds_ar_${reqId}`;
/** The patient picker's own browser-binding cookie, one per pick, scoped to the pick path (#5454 A5). */
const pickCookieName = (pickId: string): string => `lhds_pk_${pickId}`;
function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...PICKER_HEADERS, 'content-length': String(Buffer.byteLength(html)), ...extra });
  res.end(html);
}
function readCookie(req: string | undefined, name: string): string {
  for (const part of (req ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
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
  launchUri: redirectUri.optional(),
  pou: z.string().regex(/^[A-Z]{2,10}$/).default('TREAT'),
});

const BindingsSchema = z.strictObject({
  bindings: z.array(z.strictObject({ groupId: z.string().refine(isGuid, 'must be a GUID'), roleId: z.string() })).max(100),
  v1Scopes: z.boolean().default(true),
});

// SMART App Launch STU2.2 fhirContext entry. Each string member is bounded at 200 characters, as the
// pre-STU2.2 string form was; a bare string is still accepted and becomes {reference} (#5454).
const FhirContextObject = z
  .strictObject({
    reference: z.string().min(1).max(200).optional(),
    canonical: z.string().min(1).max(200).optional(),
    identifier: z.strictObject({ system: z.string().min(1).max(200).optional(), value: z.string().min(1).max(200) }).optional(),
    type: z.string().regex(/^[A-Za-z]{1,64}$/).optional(),
    role: z.string().min(1).max(200).optional(),
  })
  .refine((o) => !!(o.reference || o.canonical || o.identifier), 'needs one of reference, canonical or identifier');
const FhirContextEntry = z.union([
  z.string().min(1).max(200).transform((reference): FhirContextItem => ({ reference })),
  FhirContextObject,
]);

// PATCH /clients/{id}: status as before, and/or the launch URI (null clears it). At least one member.
const ClientPatchSchema = z
  .strictObject({ status: z.enum(['active', 'disabled']).optional(), launchUri: redirectUri.nullable().optional() })
  .refine((o) => o.status !== undefined || o.launchUri !== undefined, 'supply status and/or launchUri');

const FhirUserPutSchema = z.strictObject({
  resource: z.string().regex(FHIR_USER_RESOURCE, 'must be Practitioner|Patient|RelatedPerson|Person/<id>'),
});
const FHIR_USER_LIST_MAX = 500;

// Admin patient search for the console's EHR launcher (#5454 A6): the same query the picker accepts.
const PatientSearchSchema = z.strictObject({
  oid: z.string().refine(isGuid, 'must be a GUID'),
  q: z.string().trim().min(1).max(100),
  birthdate: z.string().regex(FHIR_DATE, 'must be YYYY, YYYY-MM or YYYY-MM-DD').optional(),
});

const LaunchSchema = z.strictObject({
  tenant: z.string().regex(SLUG),
  oid: z.string().refine(isGuid, 'must be a GUID'),
  clientId: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  // Optional (#5454 A6): an EHR launch with no patient in context is valid SMART. The token then carries no
  // `patient` and no need_patient_banner, and patient/ scopes are dropped exactly as for a standalone launch.
  patient: z.string().regex(FHIR_ID).optional(),
  encounter: z.string().regex(FHIR_ID).optional(),
  fhirContext: z.array(FhirContextEntry).max(10).optional(),
});

/** CORS for browser-based (public) SMART apps. Never Allow-Credentials: nothing here reads a cookie cross-origin. */
const CORS_ANY: Record<string, string> = { 'access-control-allow-origin': '*' };
function preflight(res: ServerResponse, methods: string): void {
  res.writeHead(204, {
    ...CORS_ANY,
    'access-control-allow-methods': `${methods}, OPTIONS`,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
  });
  res.end();
}

/** The `iss` of a client assertion without verifying it; '' when absent or not a JWT. Identification only, never trust. */
function assertionIss(assertion: string | null): string {
  if (!assertion) return '';
  try {
    return String(decodeJwt(assertion).iss ?? '');
  } catch {
    return '';
  }
}

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
  /**
   * OpenID issuer of a tenant's id_tokens (#5454). Per tenant, so `{issuer}/{tenant}/.well-known/openid-configuration`
   * is its discovery document. ACCESS tokens keep the tenant-independent `issuer` (the PDP and APIM pin it).
   */
  const oidcIssuerFor = (tenant: string): string => `${issuer}/${tenant}`;
  const TOKEN_AUTH_METHODS = ['private_key_jwt', 'none'];
  const SCOPES_SUPPORTED = ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access', 'patient/*.rs', 'user/*.rs', 'system/*.rs'];

  async function smartConfiguration(tenant: string): Promise<unknown> {
    const t = await activeTenant(tenant);
    const b = await bindingFor(t.id);
    const caps = ['launch-ehr', 'launch-standalone', 'client-public', 'client-confidential-asymmetric', 'sso-openid-connect',
      'context-ehr-patient', 'context-standalone-patient', 'permission-offline', 'permission-patient', 'permission-user', 'permission-v2'];
    if (b?.v1Scopes) caps.push('permission-v1');
    return {
      issuer: oidcIssuerFor(t.id),
      jwks_uri: `${issuer}/jwks.json`,
      authorization_endpoint: `${issuer}/${t.id}/authorize`,
      token_endpoint: `${issuer}/${t.id}/token`,
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      token_endpoint_auth_methods_supported: TOKEN_AUTH_METHODS,
      token_endpoint_auth_signing_alg_values_supported: ['RS384', 'ES384'],
      code_challenge_methods_supported: ['S256'], // never "plain"
      scopes_supported: SCOPES_SUPPORTED,
      response_types_supported: ['code'],
      capabilities: caps,
      lhds_scope_map: SCOPE_MAP_VERSION,
    };
  }

  /**
   * The id_token RSA keys for the JWKS (A7). If they cannot be read, the JWKS still serves the ES384 access-token key,
   * so the PDP and APIM keep verifying access tokens; the failure is logged, and no id_token can be minted in that
   * state either (the same resolve fails at mint), so no issued token carries a kid this JWKS omits.
   */
  async function idTokenJwks(): Promise<JWK[]> {
    try {
      return await deps.idTokenSigner.publicJwks();
    } catch (e) {
      deps.log('auth.idtoken_key_unavailable', { ...classifyError(e) });
      return [];
    }
  }

  async function openidConfiguration(tenant: string): Promise<unknown> {
    const t = await activeTenant(tenant);
    return {
      issuer: oidcIssuerFor(t.id),
      authorization_endpoint: `${issuer}/${t.id}/authorize`,
      token_endpoint: `${issuer}/${t.id}/token`,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      // The id_token signer's alg: RS256, the OIDC default (W1b-3a A7). Access tokens stay ES384 and are not
      // described here; id_tokens are never ES384, so ES384 is not listed.
      id_token_signing_alg_values_supported: [deps.idTokenSigner.alg],
      scopes_supported: SCOPES_SUPPORTED,
      token_endpoint_auth_methods_supported: TOKEN_AUTH_METHODS,
      code_challenge_methods_supported: ['S256'],
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
    // Bind this request to the browser that started it: a random secret goes to the browser as an
    // HttpOnly cookie, only its hash is stored, and the callback refuses a state without the cookie (#5134).
    const browserSecret = rand(24);
    await stores.grants.create({
      id,
      kind: 'authreq',
      browserBinding: sha256hex(browserSecret),
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
    // SameSite=Lax: the Entra redirect back is a top-level GET, which Lax sends; a cross-site POST/subresource does not.
    const secure = issuer.startsWith('https:') ? '; Secure' : '';
    const cookie = `${bindCookieName(id)}=${browserSecret}; HttpOnly; SameSite=Lax; Path=${base}/callback; Max-Age=${AUTHREQ_TTL_S}${secure}`;
    redirect(res, deps.federation.authorizeUrl({ state: id, nonce: entraNonce, codeChallenge: s256(entraVerifier), redirectUri: callbackUrl }), {
      'set-cookie': cookie,
    });
  }

  // ---- Entra callback ----
  async function callback(res: ServerResponse, q: URLSearchParams, cookieHeader: string | undefined): Promise<void> {
    const reqId = q.get('state') ?? '';
    const ar = reqId ? await stores.grants.get(reqId) : undefined;
    if (!ar || ar.kind !== 'authreq' || ar.used || expired(ar)) throw new OAuthError('invalid_request', 'unknown or expired authorization request');
    // Checked BEFORE the request is consumed, so a forged callback cannot burn the victim's pending sign-in.
    if (!ar.browserBinding || !safeEq(sha256hex(readCookie(cookieHeader, bindCookieName(reqId))), ar.browserBinding)) {
      deps.log('auth.state_binding_mismatch', {});
      throw new OAuthError('invalid_request', 'authorization request does not belong to this browser session');
    }
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
    } catch (e) {
      // One structured line per failed exchange: a silent catch here hid every real sign-in failing (2026-11-27).
      // The RP still sees only the generic access_denied.
      deps.log('auth.federation_failed', federationFailure(e));
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
      deps.log('auth.membership_error', membershipFailure(e));
      return back({ error: 'server_error', error_description: 'role membership could not be established' });
    }

    let patient: string | undefined;
    let encounter: string | undefined;
    let fhirContext: FhirContextItem[] | undefined;
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
      fhirContext = normalizeFhirContext(h.fhirContext);
    }
    // fhirUser is resolved only when the app asked for it (#5454 A4). A store failure fails the sign-in CLOSED with
    // server_error: silently dropping the scope would hand the app a session that lost fhirUser without saying so.
    let fhirUser: string | undefined;
    if (parsed.context.includes('fhirUser') && deps.resolveFhirUser) {
      try {
        fhirUser = await deps.resolveFhirUser(identity.oid, ar.tenant);
      } catch (e) {
        deps.log('auth.fhir_user_error', { error: e instanceof Error ? e.name : 'unknown' });
        return back({ error: 'server_error', error_description: 'the user identity could not be resolved' });
      }
    }
    const client = await getClient(ar.clientId);
    if (!client || client.status !== 'active') return back({ error: 'access_denied', error_description: 'client is not available' });
    const grantFor = (p: string | undefined) => computeGrant({
      grant: 'authorization_code',
      request: parsed,
      roleIds,
      clientAllowed: client.allowedScopes,
      ...(p ? { patient: p } : {}),
      fhirUserResolved: !!fhirUser,
    });
    const echo: Record<string, string> = {};
    for (const [k, v] of parsed.echo) echo[k] = v;

    // Standalone `launch/patient` (#5454 A5): when a patient context would actually carry a patient/ data scope
    // for this user and client, no code is issued yet. The user picks a patient on the AS first. The probe id
    // only answers "would a patient keep any patient/ scope"; it never reaches a token.
    if (!ar.launchHandle && parsed.context.includes('launch/patient') && grantFor('picker-probe').data.some((s) => s.compartment === 'patient')) {
      const pickId = rand(24);
      const secret = rand(24);
      await stores.grants.create({
        id: pickId,
        kind: 'pick',
        browserBinding: sha256hex(secret),
        ttl: PICK_TTL_S,
        expiresAt: expiry(PICK_TTL_S),
        tenant: ar.tenant,
        clientId: ar.clientId,
        redirectUri: ar.redirectUri as string,
        codeChallenge: ar.codeChallenge as string,
        ...(ar.clientState ? { clientState: ar.clientState } : {}),
        ...(ar.clientNonce ? { clientNonce: ar.clientNonce } : {}),
        requestedScope: ar.requestedScope ?? '',
        v1Scopes: b?.v1Scopes ?? false,
        aud: ar.aud as string,
        oid: identity.oid,
        idpTid: identity.tid,
        echo,
        ...(fhirUser ? { fhirUser } : {}),
      });
      const secure = issuer.startsWith('https:') ? '; Secure' : '';
      const pickPath = `${base}/${ar.tenant}/pick`;
      return redirect(res, `${issuer}/${ar.tenant}/pick?req=${pickId}`, {
        'set-cookie': `${pickCookieName(pickId)}=${secret}; HttpOnly; SameSite=Lax; Path=${pickPath}; Max-Age=${PICK_TTL_S}${secure}`,
      });
    }

    const g = grantFor(patient);
    if (g.scope.length === 0) return back({ error: 'invalid_scope', error_description: 'no requested scope could be granted' });
    const codeValue = await createCode({
      tenant: ar.tenant,
      clientId: ar.clientId,
      redirectUri: ar.redirectUri as string,
      codeChallenge: ar.codeChallenge as string,
      oid: identity.oid,
      idpTid: identity.tid,
      grantedScope: g.scope,
      echo,
      aud: ar.aud as string,
      ...(ar.clientNonce ? { clientNonce: ar.clientNonce } : {}),
      ...(ar.launchHandle ? { launchHandle: ar.launchHandle } : {}),
      ...(patient ? { patient } : {}),
      ...(encounter ? { encounter } : {}),
      ...(fhirContext ? { fhirContext } : {}),
      ...(fhirUser ? { fhirUser } : {}),
    });
    back({ code: codeValue });
  }

  /** Stores an authorization code (only its hash) and returns the value for the redirect. */
  async function createCode(c: Omit<GrantDoc, 'id' | 'kind' | 'ttl' | 'expiresAt'>): Promise<string> {
    const codeValue = rand(32);
    await stores.grants.create({ ...c, id: sha256hex(codeValue), kind: 'code', ttl: CODE_TTL_S, expiresAt: expiry(CODE_TTL_S) });
    return codeValue;
  }

  // ---- standalone patient picker (#5454 A5) ----
  /** A refusal rendered as a dead-end page: the pick itself cannot be trusted, so nothing is redirected anywhere. */
  class PickRefused extends Error {
    constructor(readonly status: number, readonly heading: string, readonly detail: string) {
      super(heading);
    }
  }
  const pickInvalid = (): PickRefused =>
    new PickRefused(400, 'This patient selection is no longer valid', 'It expired, was already used, or was started in another browser. Return to the app and sign in again.');
  const PICK_ID = /^[A-Za-z0-9_-]{32}$/;

  /** The search for ONE pick: the default mints its token with that user's own Entra tid, as user tokens carry. */
  const searchFor = (doc: GrantDoc): PatientSearch => searchAs(doc.idpTid as string);
  /** The search for a user of Entra tenant `idpTid`, with a 60 s token minted for that user (picker + admin route). */
  const searchAs = (idpTid: string): PatientSearch => deps.patientSearch ?? createFhirPatientSearch({
    fhirBaseFor: deps.fhirBaseFor,
    ...(deps.fetchFhir ? { fetch: deps.fetchFhir } : {}),
    token: async (tenant, oid, roles) => {
      const scope = pickerScope(roles);
      // Callers check pickerScope first; this keeps a token from ever being minted with an empty scope.
      if (scope.length === 0) throw new Error('picker token requested without user/Patient.rs');
      return mintAccessToken(deps.signer, {
        issuer,
        audience: deps.fhirBaseFor(tenant),
        tenant,
        subType: 'user',
        sub: oid,
        idpTid,
        clientId: PICKER_CLIENT_ID,
        scope: scope.map(serializeScope),
        roles: [...roles],
        pou: ['TREAT'],
        now: now(),
        ttlS: PICKER_TOKEN_TTL_S,
      });
    },
  });

  /** user/Patient.rs INTERSECT the user's role ceilings: the authority the picker searches with. Empty = may not search. */
  function pickerScope(roles: readonly string[]): DataScope[] {
    return intersectWithCeilings([PICKER_SCOPE], ceilingsFor(roles, 'authorization_code'));
  }

  /** A pending pick that is live, in this tenant, and bound to THIS browser. Every failure reads the same. */
  async function loadPick(tenant: string, pickId: string, cookieHeader: string | undefined): Promise<GrantDoc> {
    const doc = PICK_ID.test(pickId) ? await stores.grants.get(pickId) : undefined;
    if (!doc || doc.kind !== 'pick' || doc.used || expired(doc) || doc.tenant !== tenant) throw pickInvalid();
    if (!doc.browserBinding || !safeEq(sha256hex(readCookie(cookieHeader, pickCookieName(pickId))), doc.browserBinding)) {
      deps.log('auth.pick_binding_mismatch', {});
      throw pickInvalid();
    }
    const t = await deps.tenants.get(tenant);
    if (!t || t.status !== 'active') throw pickInvalid();
    return doc;
  }

  /** Renders the picker with a FRESH CSRF value; only its hash is stored. The latest render's form is the valid one. */
  async function showPicker(res: ServerResponse, doc: GrantDoc, status: number, state: PickerState, query = { name: '', birthdate: '' }): Promise<number> {
    const csrf = rand(24);
    try {
      await stores.grants.replace({ ...doc, csrf: sha256hex(csrf) });
    } catch (e) {
      if (e instanceof StoreConflictError) throw new PickRefused(409, 'This page changed in another window', 'Use the most recent patient picker window, or return to the app and sign in again.');
      throw e;
    }
    const client = await getClient(doc.clientId);
    sendHtml(res, status, renderPicker({
      action: `${base}/${doc.tenant}/pick`,
      req: doc.id,
      csrf,
      appName: client?.displayName ?? doc.clientId,
      tenant: doc.tenant,
      query,
      state,
    }));
    return status;
  }

  /** Fresh group membership, as the refresh path does: a membership removed since sign-in counts. */
  async function pickRoles(doc: GrantDoc): Promise<string[] | undefined> {
    try {
      return await rolesForUser(doc.tenant, doc.oid as string);
    } catch (e) {
      deps.log('auth.membership_error', membershipFailure(e));
      return undefined;
    }
  }
  const ROLES_UNAVAILABLE: PickerState = { kind: 'error', heading: 'Your roles could not be checked', message: 'Role membership in this tenant could not be established. Try again, or cancel to return to the app.' };

  /**
   * GET renders the empty search form only. Search terms are patient identifiers (PHI): they travel in a POST body,
   * never a query string, which Front Door / App Gateway access logs would record. Any `q`/`birthdate` here is ignored.
   */
  async function pickGet(res: ServerResponse, tenant: string, q: URLSearchParams, cookieHeader: string | undefined): Promise<number> {
    const doc = await loadPick(tenant, q.get('req') ?? '', cookieHeader);
    const roles = await pickRoles(doc);
    if (!roles) return showPicker(res, doc, 503, ROLES_UNAVAILABLE);
    if (pickerScope(roles).length === 0) return showPicker(res, doc, 403, { kind: 'not-permitted' });
    return showPicker(res, doc, 200, { kind: 'start' });
  }

  /** `action=search` POST, after the pick, cookie and CSRF checks in pickPost. Re-renders with a fresh CSRF. */
  async function pickSearch(res: ServerResponse, doc: GrantDoc, form: URLSearchParams): Promise<number> {
    const tenant = doc.tenant;
    const query = { name: (form.get('q') ?? '').trim(), birthdate: (form.get('birthdate') ?? '').trim() };
    const roles = await pickRoles(doc);
    if (!roles) return showPicker(res, doc, 503, ROLES_UNAVAILABLE, query);
    if (pickerScope(roles).length === 0) return showPicker(res, doc, 403, { kind: 'not-permitted' }, query);
    if (!query.name || query.name.length > 100) return showPicker(res, doc, 400, { kind: 'invalid-input', message: 'Enter a patient name of 1 to 100 characters.' }, query);
    if (query.birthdate && !FHIR_DATE.test(query.birthdate)) return showPicker(res, doc, 400, { kind: 'invalid-input', message: 'Enter the birth date as YYYY-MM-DD.' }, query);
    try {
      const patients = await searchFor(doc).search(tenant, doc.oid as string, roles, { name: query.name, ...(query.birthdate ? { birthdate: query.birthdate } : {}) });
      return showPicker(res, doc, 200, patients.length ? { kind: 'results', patients } : { kind: 'empty' }, query);
    } catch (e) {
      if (!(e instanceof PatientSearchUnavailableError)) throw e;
      deps.log('auth.pick_search_unavailable', { reason: e.reason });
      return showPicker(res, doc, 503, { kind: 'unavailable' }, query);
    }
  }

  async function pickPost(res: ServerResponse, tenant: string, form: URLSearchParams, cookieHeader: string | undefined): Promise<number> {
    const doc = await loadPick(tenant, form.get('req') ?? '', cookieHeader);
    // The form must come from the LATEST page this AS rendered for this pick (timing-safe; only the hash is stored).
    if (!doc.csrf || !safeEq(sha256hex(form.get('csrf') ?? ''), doc.csrf)) {
      deps.log('auth.pick_csrf_mismatch', {});
      throw pickInvalid();
    }
    const clearCookie = `${pickCookieName(doc.id)}=; HttpOnly; SameSite=Lax; Path=${base}/${doc.tenant}/pick; Max-Age=0`;
    const back = (params: Record<string, string>): number => {
      const u = new URL(doc.redirectUri as string);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (doc.clientState) u.searchParams.set('state', doc.clientState);
      redirect(res, u.toString(), { 'set-cookie': clearCookie });
      return 302;
    };
    const consume = async (): Promise<void> => {
      try {
        await stores.grants.replace({ ...doc, used: true }); // single use; a concurrent second POST loses the etag race
      } catch (e) {
        if (e instanceof StoreConflictError) throw pickInvalid();
        throw e;
      }
    };
    if (form.get('action') === 'search') return pickSearch(res, doc, form);
    if (form.get('action') === 'cancel') {
      await consume();
      return back({ error: 'access_denied', error_description: 'no patient was selected' });
    }
    if (form.get('action') === 'continue') {
      const roles = await pickRoles(doc);
      if (!roles) return showPicker(res, doc, 503, ROLES_UNAVAILABLE);
      // Offered ONLY on the not-permitted state. A user who may search must choose a patient; a forged continue
      // from them issues nothing and returns them to the picker.
      if (pickerScope(roles).length > 0) {
        deps.log('auth.pick_continue_refused', {});
        return showPicker(res, doc, 400, { kind: 'error', heading: 'Choose a patient', message: 'You are permitted to search patients in this tenant, so a patient must be chosen. Search, or cancel to return to the app.' });
      }
      await consume();
      return issueFromPick(doc, roles, undefined, back);
    }
    const patient = form.get('patient') ?? '';
    if (!FHIR_ID.test(patient)) return showPicker(res, doc, 400, { kind: 'invalid-input', message: 'Choose a patient from the list.' });
    const roles = await pickRoles(doc);
    if (!roles) return showPicker(res, doc, 503, ROLES_UNAVAILABLE);
    if (pickerScope(roles).length === 0) return showPicker(res, doc, 403, { kind: 'not-permitted' });
    // The posted id is only a claim: the user must be able to READ that patient, as themselves, right now.
    let seen;
    try {
      seen = await searchFor(doc).read(tenant, doc.oid as string, roles, patient);
    } catch (e) {
      if (!(e instanceof PatientSearchUnavailableError)) throw e;
      deps.log('auth.pick_search_unavailable', { reason: e.reason });
      return showPicker(res, doc, 503, { kind: 'unavailable' });
    }
    if (!seen) {
      deps.log('auth.pick_patient_refused', {});
      return showPicker(res, doc, 403, { kind: 'error', heading: 'That patient is not available', message: 'The patient was not found, or you are not permitted to see it. Search again, or cancel to return to the app.' });
    }
    await consume();
    return issueFromPick(doc, roles, seen.id, back);
  }

  /**
   * Consumed pick -> code. With a patient the grant is recomputed WITH it, so patient/ scopes survive. Without one
   * (`action=continue`) it is exactly the pre-picker grant: every patient/ scope dropped, the rest kept. Roles are the
   * fresh ones the caller checked.
   */
  async function issueFromPick(doc: GrantDoc, roles: string[], patient: string | undefined, back: (p: Record<string, string>) => number): Promise<number> {
    const client = await getClient(doc.clientId);
    if (!client || client.status !== 'active') return back({ error: 'access_denied', error_description: 'client is not available' });
    const g = computeGrant({
      grant: 'authorization_code',
      request: parseRequest(doc.requestedScope ?? '', { v1: doc.v1Scopes ?? false }),
      roleIds: roles,
      clientAllowed: client.allowedScopes,
      ...(patient ? { patient } : {}),
      fhirUserResolved: !!doc.fhirUser,
    });
    if (g.scope.length === 0) return back({ error: 'invalid_scope', error_description: 'no requested scope could be granted' });
    const codeValue = await createCode({
      tenant: doc.tenant,
      clientId: doc.clientId,
      redirectUri: doc.redirectUri as string,
      codeChallenge: doc.codeChallenge as string,
      oid: doc.oid as string,
      idpTid: doc.idpTid as string,
      grantedScope: g.scope,
      echo: doc.echo ?? {},
      aud: doc.aud as string,
      ...(patient ? { patient } : {}),
      ...(doc.clientNonce ? { clientNonce: doc.clientNonce } : {}),
      ...(doc.fhirUser ? { fhirUser: doc.fhirUser } : {}),
    });
    deps.log(patient ? 'auth.pick_issued' : 'auth.pick_continued_without_patient', { tenant: doc.tenant });
    return back({ code: codeValue });
  }

  /** The picker speaks HTML, success or failure; a JSON error body would be a blank page to the user. */
  async function pickRoute(req: IncomingMessage, res: ServerResponse, method: string, tenant: string, q: URLSearchParams): Promise<number> {
    try {
      if (method === 'GET') return await pickGet(res, tenant, q, req.headers.cookie);
      return await pickPost(res, tenant, await readForm(req), req.headers.cookie);
    } catch (e) {
      if (e instanceof PickRefused) {
        sendHtml(res, e.status, renderPickerError(e.heading, e.detail));
        return e.status;
      }
      if (e instanceof OAuthError || e instanceof HttpError) {
        sendHtml(res, 400, renderPickerError('This request could not be read', 'Return to the app and sign in again.'));
        return 400;
      }
      deps.log('auth.internal_error', { error: e instanceof Error ? e.name : 'unknown', step: 'pick', ...classifyError(e) });
      sendHtml(res, 500, renderPickerError('Something went wrong', 'The patient picker hit an internal error. Return to the app and try again.'));
      return 500;
    }
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
    fhirContext?: FhirContextItem[];
    nonce?: string;
    aud: string;
    roles: string[];
    refresh: boolean;
    launched: boolean;
    /** Rotation chain to continue; a fresh sign-in starts a new one. */
    family?: string;
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
    if (g.fhirContext && g.fhirContext.length > 0) out.fhirContext = g.fhirContext; // SMART STU2.2: objects, never strings
    if (g.scope.includes('openid')) {
      // RS256 through the id_token signer (A7). A failure here (e.g. Key Vault refusing to create the key) fails the
      // request with step=id_token in the log; it never falls back to an ES384 id_token.
      out.id_token = await inStep('id_token', () => mintIdToken(deps.idTokenSigner, {
        issuer: oidcIssuerFor(g.tenant),
        clientId: g.clientId,
        sub: g.oid,
        ...(g.nonce ? { nonce: g.nonce } : {}),
        ...(g.fhirUser ? { fhirUser: g.fhirUser } : {}),
        now: t,
      }));
    }
    if (g.refresh) {
      const rt = rand(32);
      await stores.grants.create({
        id: sha256hex(rt),
        kind: 'refresh',
        family: g.family ?? rand(16),
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
        ...(g.fhirContext && g.fhirContext.length > 0 ? { fhirContext: g.fhirContext } : {}),
        ...(g.nonce ? { clientNonce: g.nonce } : {}),
        ...(g.launched ? { launchHandle: 'bound' } : {}),
      });
      out.refresh_token = rt;
    }
    return out;
  }

  const fhirContextOf = (doc: GrantDoc): { fhirContext?: FhirContextItem[] } => {
    const fc = normalizeFhirContext(doc.fhirContext);
    return fc ? { fhirContext: fc } : {};
  };

  async function markUsed(doc: GrantDoc): Promise<void> {
    try {
      await stores.grants.replace({ ...doc, used: true });
    } catch (e) {
      if (e instanceof StoreConflictError) throw new OAuthError('invalid_grant', 'grant is invalid or already used');
      throw e;
    }
  }

  /** A non-protocol failure inside a named step of the token path; surfaces as a 500, with the step in the log. */
  class StepFailure extends Error {
    constructor(readonly step: string, readonly origin: unknown) {
      super(`step ${step} failed`);
    }
  }
  async function inStep<T>(step: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof OAuthError || e instanceof HttpError || e instanceof StepFailure) throw e;
      throw new StepFailure(step, e);
    }
  }
  /** The signer with each seam labelled, so a Key Vault failure names kid vs sign. */
  const stepSigner: Signer = {
    alg: deps.signer.alg,
    kid: () => inStep('kid', () => deps.signer.kid()),
    sign: (b) => inStep('sign', () => deps.signer.sign(b)),
    publicJwk: () => deps.signer.publicJwk(),
  };

  /**
   * `cors.publicClient` makes the response (success OR OAuth error) carry `access-control-allow-origin: *` for a
   * browser app (#5454). It is set for a request with NO client_assertion, so an error raised before the client is
   * resolved (unknown client_id) is readable too: such a request can only ever earn a token as a public client,
   * because confidential and backend clients must send an assertion. It is also set once a request resolves to a
   * public app client. A confidential client's token response never carries it.
   */
  async function token(tenantSlug: string, p: URLSearchParams, cors: { publicClient: boolean }): Promise<Record<string, unknown>> {
    await activeTenant(tenantSlug);
    const tokenUrl = `${issuer}/${tenantSlug}/token`;
    const grantType = p.get('grant_type');
    if (!p.get('client_assertion')) cors.publicClient = true;

    if (grantType === 'client_credentials') {
      const clientId = assertionIss(p.get('client_assertion'));
      const client = clientId ? await getClient(clientId) : undefined;
      // Unknown, disabled, wrong-tenant and non-backend all read as the same invalid_client.
      if (!client || client.status !== 'active' || client.clientType !== 'backend' || client.tenant !== tenantSlug) {
        throw new OAuthError('invalid_client', 'client authentication failed');
      }
      await authenticateClient(client, p, tokenUrl);
      const g = await inStep('grant', () => computeGrant({
        grant: 'client_credentials',
        request: parseRequest(p.get('scope') ?? '', { v1: false }),
        roleIds: client.roleIds,
        clientAllowed: client.allowedScopes,
        fhirUserResolved: false,
      }));
      if (g.scope.length === 0) throw new OAuthError('invalid_scope', 'no requested scope could be granted');
      const audience = await inStep('fhir_base', () => deps.fhirBaseFor(tenantSlug));
      const at = await inStep('mint', () => mintAccessToken(stepSigner, {
        issuer,
        audience,
        tenant: tenantSlug,
        subType: 'system',
        sub: client.clientId,
        clientId: client.clientId,
        scope: g.scope,
        roles: client.roleIds,
        pou: [client.pou],
        now: now(),
      }));
      // No refresh token for Backend Services (spec "SHOULD NOT").
      return { access_token: at, token_type: 'bearer', expires_in: ACCESS_TOKEN_TTL_S, scope: g.scope.join(' ') };
    }

    if (grantType === 'authorization_code' || grantType === 'refresh_token') {
      // RFC 7523 section 3: a client authenticating with an assertion may omit client_id, and is then identified by
      // the assertion iss (Inferno's asymmetric exchange sends none). Both present and different is refused.
      const formId = p.get('client_id') ?? '';
      const assertion = p.get('client_assertion');
      const assertedId = assertionIss(assertion);
      if (formId && assertion && assertedId !== formId) throw new OAuthError('invalid_client', 'client authentication failed');
      const client = await getClient(formId || assertedId);
      if (!client || client.status !== 'active' || client.clientType !== 'app' || client.tenant !== tenantSlug) {
        throw new OAuthError('invalid_client', 'client authentication failed');
      }
      const confidential = !!(client.jwks || client.jwksUrl);
      // An unverified iss names a client but proves nothing; only a confidential client, whose assertion
      // authenticateClient then VERIFIES, may be identified that way. A public client must send client_id.
      if (!formId && !confidential) throw new OAuthError('invalid_client', 'client authentication failed');
      if (!confidential) cors.publicClient = true;
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
          ...fhirContextOf(doc),
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
      if (!doc || doc.kind !== 'refresh' || expired(doc) || doc.clientId !== client.clientId || doc.tenant !== tenantSlug) {
        throw new OAuthError('invalid_grant', 'grant is invalid or already used');
      }
      // Reuse detection (#5134): a refresh token is single-use, so a SECOND presentation means two parties hold it.
      // Revoke the whole rotation chain so the legitimate holder must sign in again. The client was authenticated
      // and matches the token above, so a third party cannot trigger this by replaying someone else's token.
      if (doc.used || (doc.family && (await stores.grants.get(`revoked-${doc.family}`)))) {
        if (doc.used && doc.family) {
          try {
            await stores.grants.create({ id: `revoked-${doc.family}`, kind: 'revoked', ttl: REFRESH_TTL_S, expiresAt: expiry(REFRESH_TTL_S), tenant: doc.tenant, clientId: doc.clientId, family: doc.family });
          } catch (e) {
            if (!(e instanceof StoreConflictError)) throw e; // already revoked is the goal state
          }
          deps.log('auth.refresh_reuse_revoked', { tenant: doc.tenant });
        }
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
        ...fhirContextOf(doc),
        ...(doc.clientNonce ? { nonce: doc.clientNonce } : {}),
        aud: doc.aud as string,
        roles,
        refresh: g.scope.includes('offline_access'),
        launched: !!doc.launchHandle,
        ...(doc.family ? { family: doc.family } : {}),
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
        if (k.kty === 'RSA' && rsaModulusBits(k.n) < MIN_RSA_BITS) throw badRequest(`jwks: RSA keys must be at least ${MIN_RSA_BITS} bits`);
      }
      if (c.jwksUrl && isPrivateHost(new URL(c.jwksUrl).hostname)) {
        throw badRequest('jwksUrl must point to a public host (loopback, private, link-local and internal names are refused)');
      }
      for (const s of c.allowedScopes) if (!parseDataScope(s, { v1: false })) throw badRequest(`allowedScopes: not an accepted scope: ${s.slice(0, 80)}`);
      for (const r of c.roleIds) if (!ROLE_IDS.has(r)) throw badRequest(`roleIds: unknown role ${r.slice(0, 60)}`);
      if (c.clientType === 'backend' && c.roleIds.length === 0) throw badRequest('a backend client needs at least one role');
      if (c.clientType === 'app' && c.redirectUris.length === 0) throw badRequest('an app client needs at least one redirectUri');
      if (c.clientType === 'backend' && c.launchUri) throw badRequest('launchUri: only an app client has a launch URI');
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
        ...(c.launchUri ? { launchUri: c.launchUri } : {}),
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
      const p = ClientPatchSchema.safeParse(await readJson(req));
      if (!p.success) {
        const i = p.error.issues[0];
        throw badRequest(i?.path[0] === 'status' ? 'status: must be active or disabled' : `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`);
      }
      const cur = await stores.clients.get(`client-${cm[1]}`);
      if (!cur || cur.kind !== 'client') throw notFound('client');
      if (p.data.launchUri && cur.clientType !== 'app') throw badRequest('launchUri: only an app client has a launch URI');
      const next: ClientDoc = { ...cur, updatedAt: now().toISOString(), updatedBy: who.id };
      if (p.data.status) next.status = p.data.status;
      if (p.data.launchUri === null) delete next.launchUri;
      else if (p.data.launchUri) next.launchUri = p.data.launchUri;
      try {
        return ok(publicClient(await stores.clients.replace(next)));
      } catch (e) {
        if (e instanceof StoreConflictError) throw conflict('client changed concurrently; retry');
        throw e;
      }
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
    const fl = /^\/api\/health\/auth\/tenants\/([a-z0-9-]{2,40})\/fhir-users$/.exec(path);
    if (fl && method === 'GET') {
      await deps.authenticate(auth, 'read');
      const slug = fl[1] as string;
      if ((await deps.tenants.get(slug)) === undefined) throw notFound('tenant');
      const rows = await stores.fhirUsers.listForTenant(slug, FHIR_USER_LIST_MAX);
      // The query filters by tenant; the second filter keeps a mis-keyed row out of another tenant's list.
      return ok({ fhirUsers: rows.filter((d) => d.kind === 'fhiruser' && d.tenant === slug).map(publicFhirUser) });
    }
    const fu = /^\/api\/health\/auth\/tenants\/([a-z0-9-]{2,40})\/fhir-users\/([^/]{1,64})$/.exec(path);
    if (fu && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const who = await deps.authenticate(auth, method === 'GET' ? 'read' : 'write');
      const slug = fu[1] as string;
      const oidIn = fu[2] as string;
      if (!isGuid(oidIn)) throw badRequest('oid: must be a GUID');
      const oid = oidIn.toLowerCase();
      if ((await deps.tenants.get(slug)) === undefined) throw notFound('tenant');
      const id = fhirUserDocId(slug, oid);
      if (method === 'GET') {
        const d = await stores.fhirUsers.get(id);
        if (!d || d.kind !== 'fhiruser' || d.tenant !== slug) throw notFound('fhirUser mapping');
        return ok(publicFhirUser(d));
      }
      if (method === 'DELETE') {
        await stores.fhirUsers.delete(id); // idempotent: deleting an absent mapping is the goal state
        return ok(null, 204);
      }
      const p = FhirUserPutSchema.safeParse(await readJson(req));
      if (!p.success) throw badRequest(`${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message ?? 'invalid'}`);
      const next: Omit<FhirUserDoc, '_etag'> = {
        id, kind: 'fhiruser', tenant: slug, oid, resource: p.data.resource, updatedAt: now().toISOString(), updatedBy: who.id,
      };
      const cur = await stores.fhirUsers.get(id);
      try {
        return ok(publicFhirUser(cur ? await stores.fhirUsers.replace({ ...next, _etag: cur._etag as string }) : await stores.fhirUsers.create(next)));
      } catch (e) {
        if (e instanceof StoreConflictError) throw conflict('mapping changed concurrently; retry');
        throw e;
      }
    }
    // Patient search on behalf of a console user (#5454 A6), for the EHR launcher. Write-auth like launch: it reads
    // PHI. The search runs with the SAME role-bounded 60 s user token the picker uses (user/Patient.rs intersected
    // with that oid's role ceilings), so the FHIR engine and the PDP decide what the user may see. An honest
    // failure is a 200 with a flag, never invented rows: {unavailable:true, reason} on PatientSearchUnavailableError
    // or a failed role check, and {notPermitted:true} when the user's roles carry no user/Patient.rs. A 200 keeps
    // that state a value the console renders, distinct from a CP fault (5xx) or a bad request (400).
    const ps = /^\/api\/health\/auth\/tenants\/([a-z0-9-]{2,40})\/patient-search$/.exec(path);
    if (ps && method === 'POST') {
      await deps.authenticate(auth, 'write');
      const slug = ps[1] as string;
      const p = PatientSearchSchema.safeParse(await readJson(req));
      if (!p.success) throw badRequest(`${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message ?? 'invalid'}`);
      const t = await deps.tenants.get(slug);
      if (!t || t.status !== 'active') throw notFound('tenant');
      const oid = p.data.oid.toLowerCase();
      let roles: string[];
      try {
        roles = await rolesForUser(slug, oid);
      } catch (e) {
        deps.log('auth.membership_error', membershipFailure(e));
        return ok({ unavailable: true, reason: 'role membership could not be established' });
      }
      if (pickerScope(roles).length === 0) return ok({ notPermitted: true, patients: [] });
      try {
        // Console users sign in to the CP's own Entra tenant, the one the AS federates to (the callback refuses others).
        const patients = await searchAs(deps.entraTenantId).search(slug, oid, roles, { name: p.data.q, ...(p.data.birthdate ? { birthdate: p.data.birthdate } : {}) });
        return ok({ patients });
      } catch (e) {
        if (!(e instanceof PatientSearchUnavailableError)) throw e;
        deps.log('auth.admin_search_unavailable', { reason: e.reason });
        return ok({ unavailable: true, reason: e.reason });
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
        ...(l.patient ? { patient: l.patient } : {}),
        ...(l.encounter ? { encounter: l.encounter } : {}),
        ...(l.fhirContext ? { fhirContext: l.fhirContext } : {}),
      });
      // `iss` is the tenant's FHIR base (the token audience): the launcher sends the app to `launchUri?iss=&launch=`
      // and must not derive the base itself (#5454 A6).
      return ok({ launch: handle, expiresAt, iss: deps.fhirBaseFor(l.tenant) }, 201);
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
  const publicFhirUser = (d: FhirUserDoc) => ({
    tenant: d.tenant, oid: d.oid, resource: d.resource, fhirUser: `${deps.fhirBaseFor(d.tenant)}/${d.resource}`,
    updatedAt: d.updatedAt, updatedBy: d.updatedBy,
  });

  // Tenant-scoped routes under the issuer path, and the FHIR-base discovery path the edge forwards unchanged.
  const TENANT_ROUTE = /^\/([a-z0-9-]{2,40})\/(\.well-known\/smart-configuration|\.well-known\/openid-configuration|authorize|pick|token)$/;
  const FHIR_DISCOVERY = /^\/([a-z0-9-]{2,40})\/fhir\/\.well-known\/smart-configuration$/;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const isAdmin = path.startsWith('/api/health/auth/');
    const inBase = path === `${base}/jwks.json` || path === `${base}/callback` || path.startsWith(`${base}/`);
    const tenantRoute = !isAdmin && inBase ? TENANT_ROUTE.exec(path.slice(base.length)) : null;
    // The issuer-path route wins on the one ambiguous shape: with issuer path /auth, a tenant named `fhir` owns
    // /auth/fhir/.well-known/smart-configuration, so a tenant named `auth` has no FHIR-base discovery on this host.
    const fhirDiscovery = !isAdmin && !tenantRoute ? FHIR_DISCOVERY.exec(path) : null;
    if (!isAdmin && !inBase && !fhirDiscovery) return false;
    const started = Date.now();
    let status = 500;
    // CORS headers for this response, success or error (#5454). Discovery and jwks are public documents; the token
    // endpoint gets them only once token() resolves the caller to a public client.
    let cors: Record<string, string> = {};
    const tokenCors = { publicClient: false };
    try {
      if (isAdmin) {
        const r = await admin(req, method, path);
        if (!r) return false;
        status = r.status;
        if (status === 204) {
          res.writeHead(204, { 'cache-control': 'no-store' }); // no body on 204
          res.end();
          return true;
        }
        sendJson(res, status, { ok: true, data: r.data });
        return true;
      }
      const leaf = fhirDiscovery ? '.well-known/smart-configuration' : tenantRoute?.[2];
      const tenant = (fhirDiscovery ?? tenantRoute)?.[1] ?? '';
      const isDiscovery =
        path === `${base}/jwks.json` || path === `${base}/.well-known/openid-configuration` ||
        leaf === '.well-known/smart-configuration' || leaf === '.well-known/openid-configuration';
      if (isDiscovery) cors = CORS_ANY;
      if (method === 'OPTIONS' && (isDiscovery || leaf === 'token')) {
        status = 204;
        preflight(res, isDiscovery ? 'GET' : 'POST');
        return true;
      }
      if (path === `${base}/jwks.json` && method === 'GET') {
        status = 200;
        sendJson(res, 200, { keys: [await deps.signer.publicJwk(), ...(await idTokenJwks())] }, cors);
        return true;
      }
      if (path === `${base}/.well-known/openid-configuration` && method === 'GET') {
        // Tenant-independent OIDC discovery for the APIM validate-jwt (#5160): no tenant lookup. Its body is
        // pinned byte-for-byte by a test; the per-tenant document below is the id_token issuer's.
        status = 200;
        sendJson(res, 200, { issuer, jwks_uri: `${issuer}/jwks.json` }, cors);
        return true;
      }
      if (path === `${base}/callback` && method === 'GET') {
        status = 302;
        await callback(res, url.searchParams, req.headers.cookie);
        return true;
      }
      if (!leaf) return false;
      if (leaf === '.well-known/smart-configuration' && method === 'GET') {
        status = 200;
        sendJson(res, 200, await smartConfiguration(tenant), cors);
        return true;
      }
      if (leaf === '.well-known/openid-configuration' && method === 'GET') {
        status = 200;
        sendJson(res, 200, await openidConfiguration(tenant), cors);
        return true;
      }
      if (leaf === 'authorize' && method === 'GET') {
        status = 302;
        await authorize(res, tenant, url.searchParams);
        return true;
      }
      if (leaf === 'pick' && (method === 'GET' || method === 'POST')) {
        status = await pickRoute(req, res, method, tenant, url.searchParams);
        return true;
      }
      if (leaf === 'token' && method === 'POST') {
        const out = await token(tenant, await readForm(req), tokenCors);
        status = 200;
        sendJson(res, 200, out, tokenCors.publicClient ? CORS_ANY : {});
        return true;
      }
      status = 405;
      sendJson(res, 405, { error: 'invalid_request', error_description: 'method not allowed' }, cors);
      return true;
    } catch (e) {
      if (tokenCors.publicClient) cors = CORS_ANY;
      if (e instanceof OAuthError) {
        status = e.status;
        sendJson(res, status, { error: e.code, error_description: e.description }, { ...cors, ...(status === 401 ? { 'www-authenticate': 'Basic realm="lhds"' } : {}) });
      } else if (e instanceof HttpError) {
        status = e.status;
        sendJson(res, status, { ok: false, error: { code: e.code, message: authoredMessage(e) } }, { ...cors, ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) });
      } else {
        status = 500;
        // Step + sanitised message + SDK status/code: enough to diagnose a 500 from the log alone
        // (#5410). Never the token, assertion, key material or a request body; the response stays generic.
        const step = e instanceof StepFailure ? e.step : 'request';
        const origin = e instanceof StepFailure ? e.origin : e;
        deps.log('auth.internal_error', { error: origin instanceof Error ? origin.name : 'unknown', step, ...classifyError(origin) });
        sendJson(res, 500, { error: 'server_error', error_description: 'internal error' }, cors);
      }
      return true;
    } finally {
      deps.log('auth.request', { method, status, ms: Date.now() - started });
    }
  }

  return { handle };
}

export type AuthServer = ReturnType<typeof createAuthServer>;
