/**
 * SMART apps on a health tenant (#5454 A6): the validation and URL building the
 * `/api/health/tenants/[id]/apps/**` routes share.
 *
 * The control plane's Authorization Server is the authority and re-validates
 * every write (apps/loom-health-cp/src/auth/server.ts ClientCreateSchema). These
 * checks exist so the editor gets a precise 400 here, and so the console holds
 * two rules the CP does not: a launch URI must be https (the browser is sent
 * there with a launch handle), and scopes come from a fixed list, never a free
 * text box.
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import type { SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { readBinding } from '@/lib/install/provisioners/health-tenant';
import { CpError, CpNotConfiguredError, type CpSmartClient } from './cp-client';

/** Same shape as the CP's client id. */
export const CLIENT_ID = /^[A-Za-z0-9._-]{3,64}$/;
/** FHIR logical id (CP `FHIR_ID`): 1-64 of [A-Za-z0-9.-], not only dots. */
export const FHIR_ID = /^(?!\.+$)[A-Za-z0-9.-]{1,64}$/;
/** FHIR date: YYYY, YYYY-MM or YYYY-MM-DD (CP `FHIR_DATE`). */
export const FHIR_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/**
 * The scopes an app may be registered for, picked from a list (no free text). SMART v2 data scopes the CP's
 * parseDataScope accepts; read-only first because that is what most launch apps need.
 */
export const SMART_SCOPE_CHOICES: ReadonlyArray<{ scope: string; label: string }> = [
  { scope: 'patient/*.rs', label: 'Read the launched patient\'s data' },
  { scope: 'user/*.rs', label: 'Read what the signed-in user may read' },
  { scope: 'patient/Patient.rs', label: 'Read the launched patient\'s demographics only' },
  { scope: 'patient/Observation.rs', label: 'Read the launched patient\'s observations only' },
  { scope: 'patient/*.cruds', label: 'Read and write the launched patient\'s data' },
  { scope: 'user/*.cruds', label: 'Read and write what the signed-in user may' },
];
const SCOPE_SET = new Set(SMART_SCOPE_CHOICES.map((c) => c.scope));

/**
 * A client id the BFF refuses: `patient-search` is a static sibling of `apps/[clientId]` and would shadow that
 * client's PATCH and launch routes.
 */
export const RESERVED_CLIENT_IDS = new Set(['patient-search']);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The client id the BFF assigns (OAuth dynamic registration: the authorization server, not the user, assigns
 * client_id). `<slug of displayName, at most 40>-<8 random base32 chars>`, e.g. `growth-chart-k3x9a2bq`. Throws if
 * the result would not match the CP's id grammar or is reserved; neither can happen with the 9-char suffix, and the
 * guard keeps it that way if the shape changes. `rand` is injectable for tests.
 */
export function generateClientId(displayName: string, rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'app';
  const suffix = Array.from(rand(8), (b) => BASE32[b % 32]).join('');
  const id = `${slug}-${suffix}`;
  if (!CLIENT_ID.test(id) || RESERVED_CLIENT_IDS.has(id)) throw new Error(`generated client id is not usable: ${id}`);
  return id;
}

function httpsUrl(v: unknown, opts: { loopback?: boolean } = {}): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === 'https:') return v;
  // The CP allows loopback http for redirect URIs (local app development). Never for a launch URI.
  if (opts.loopback && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return v;
  return null;
}

/** A launch URI the browser may be sent to: https, no credentials, no fragment. */
export function parseLaunchUri(v: unknown): string | null {
  return httpsUrl(v);
}

export interface RegisterInput {
  displayName: string;
  redirectUris: string[];
  launchUri: string;
  allowedScopes: string[];
  /** public = PKCE only, no client authentication; asymmetric = private_key_jwt against `jwksUrl`. */
  kind: 'public' | 'asymmetric';
  jwksUrl?: string;
}

export function parseRegister(body: unknown): { app: RegisterInput } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const displayName = typeof b.displayName === 'string' ? b.displayName.trim() : '';
  if (!displayName || displayName.length > 120) return { error: 'displayName: 1 to 120 characters' };
  if (!Array.isArray(b.redirectUris) || b.redirectUris.length < 1 || b.redirectUris.length > 10) {
    return { error: 'redirectUris: 1 to 10 redirect URIs' };
  }
  const redirectUris: string[] = [];
  for (const r of b.redirectUris) {
    const ok = httpsUrl(r, { loopback: true });
    if (!ok) return { error: 'redirectUris: each must be https (or loopback http) without credentials or fragment' };
    redirectUris.push(ok);
  }
  const launchUri = parseLaunchUri(b.launchUri);
  if (!launchUri) return { error: 'launchUri: must be an https URL without credentials or fragment' };
  if (!Array.isArray(b.allowedScopes) || b.allowedScopes.length === 0) return { error: 'allowedScopes: pick at least one' };
  const allowedScopes: string[] = [];
  for (const s of b.allowedScopes) {
    if (typeof s !== 'string' || !SCOPE_SET.has(s)) return { error: 'allowedScopes: pick from the listed scopes' };
    if (!allowedScopes.includes(s)) allowedScopes.push(s);
  }
  if (b.kind !== 'public' && b.kind !== 'asymmetric') return { error: 'kind: public or asymmetric' };
  if (b.kind === 'public') {
    if (b.jwksUrl !== undefined && b.jwksUrl !== '') return { error: 'jwksUrl: a public client has no keys' };
    return { app: { displayName, redirectUris, launchUri, allowedScopes, kind: 'public' } };
  }
  const jwksUrl = httpsUrl(b.jwksUrl);
  if (!jwksUrl) return { error: 'jwksUrl: an asymmetric client needs an https JWKS URL' };
  return { app: { displayName, redirectUris, launchUri, allowedScopes, kind: 'asymmetric', jwksUrl } };
}

/** True when `new URL(v)` would not throw. */
export function isParsableUrl(v: string): boolean {
  try { new URL(v); return true; } catch { return false; }
}

/** The SMART EHR launch URL: the app's launch URI with `iss` (FHIR base) and `launch` (handle) set, URL-encoded. */
export function buildLaunchUrl(launchUri: string, iss: string, handle: string): string {
  const u = new URL(launchUri);
  // set(), not append(): a launch URI that already carries iss/launch must not send the app two of either.
  u.searchParams.set('iss', iss);
  u.searchParams.set('launch', handle);
  return u.toString();
}

/** The console view of a client: what the Apps tab renders. Public = no key source registered. */
export function toAppRow(c: CpSmartClient) {
  return {
    clientId: c.clientId,
    displayName: c.displayName,
    status: c.status,
    kind: (c.jwksUrl || c.jwks ? 'asymmetric' : 'public') as 'public' | 'asymmetric',
    allowedScopes: c.allowedScopes,
    redirectUris: c.redirectUris,
    launchUri: c.launchUri ?? null,
    jwksUrl: c.jwksUrl ?? null,
    updatedAt: c.updatedAt ?? null,
  };
}
export type AppRow = ReturnType<typeof toAppRow>;

/** App clients of ONE tenant. The CP lists every tenant's clients; this filter is what scopes the tab. */
export function appsOfTenant(clients: CpSmartClient[], tenant: string): CpSmartClient[] {
  return clients.filter((c) => c.tenant === tenant && c.clientType === 'app');
}

/**
 * The control-plane tenant id of a `health-tenant` item the caller may open, or the response to return. The
 * tenant always comes from the item's recorded binding, never from a request body.
 */
export async function boundTenant(itemId: string, session: SessionPayload, opts: { allowReadRoles?: boolean } = {}): Promise<string | NextResponse> {
  const item = await loadOwnedItem(itemId, 'health-tenant', session.claims.oid, { session, ...opts });
  if (!item) return apiError('Health tenant not found', 404);
  const binding = readBinding(item.state);
  if (!binding) return apiError('This health tenant is not provisioned yet; open it first so it can be created.', 409);
  return binding.tenantId;
}

/** Map a control-plane failure to the BFF envelope: gate (503), the CP's own 4xx, or 502 for anything else. */
export function cpFailure(e: unknown): NextResponse {
  if (e instanceof CpNotConfiguredError) return apiHonestGateError('health-control-plane', { missing: e.missing, message: e.message });
  if (e instanceof CpError) {
    const status = e.status === 400 || e.status === 404 || e.status === 409 ? e.status : 502;
    return apiError(`${e.code}: ${e.message}`, status, { code: e.code });
  }
  throw e;
}
