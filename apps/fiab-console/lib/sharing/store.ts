/**
 * Loom Sharing — Cosmos store + the reference-server client (LU-9).
 *
 * Two responsibilities, kept in one module because they are two halves of one
 * request path:
 *
 *   1. The AUTHORITATIVE record of shares, recipients, and grants (Cosmos).
 *   2. The ONLY client of the `loom-sharing` Container App (the OSS Delta
 *      Sharing reference server), which is internal-ingress-only and reachable
 *      by nothing else in the estate.
 *
 * Real backends throughout (`.claude/rules/no-vaporware.md`): Cosmos queries and
 * HTTP calls to a deployed server. When the server is not deployed the caller
 * gets a typed {@link LoomSharingNotConfiguredError} naming the exact env var,
 * bicep module, and remediation — never an empty array pretending to be data.
 */

import { sharingContainer } from '@/lib/azure/cosmos-client';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { canonicalSharingName, isCanonicalSharingName } from './model';
import type { LoomRecipient, LoomShare } from './model';

// ── Configuration / honest gate ────────────────────────────────────────────

export interface LoomSharingHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  followUp: string;
}

/** Thrown when a sharing operation needs the server and it is not wired. */
export class LoomSharingNotConfiguredError extends Error {
  hint: LoomSharingHint;
  constructor(hint: LoomSharingHint) {
    super(`Loom Sharing is not configured: missing ${hint.missingEnvVar}`);
    this.name = 'LoomSharingNotConfiguredError';
    this.hint = hint;
  }
}

/** Base URL of the internal Delta Sharing server, no trailing slash. */
export function loomSharingBase(): string {
  const url = (process.env.LOOM_SHARING_URL || '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new LoomSharingNotConfiguredError({
      missingEnvVar: 'LOOM_SHARING_URL',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-sharing-app.bicep',
      bicepStatus:
        'Deploy the loom-sharing Container App (the OSS Delta Sharing reference server) and set LOOM_SHARING_URL on the Console app.',
      followUp:
        'See docs/fiab/delta-sharing-gov.md for the az acr build + deploy steps. No Databricks, Fabric, or Power BI workspace is required.',
    });
  }
  return url;
}

/** True when the sharing server is wired — i.e. Loom can serve the open
 *  protocol itself rather than falling back to Databricks Delta Sharing. */
export function isLoomSharingConfigured(): boolean {
  return !!(process.env.LOOM_SHARING_URL || '').trim();
}

/** The protocol prefix the server answers on (must match the bicep param). */
export function loomSharingEndpoint(): string {
  const raw = (process.env.LOOM_SHARING_ENDPOINT || '/delta-sharing').trim();
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '');
}

/**
 * Console→server bearer. This is NOT a recipient credential: it is the single
 * global token the reference server accepts, so anything holding it sees every
 * share on the server. It exists only inside the BFF process and is never
 * echoed to a caller.
 */
function loomSharingBearer(): string {
  const t = (process.env.LOOM_SHARING_BEARER || '').trim();
  if (!t) {
    throw new LoomSharingNotConfiguredError({
      missingEnvVar: 'LOOM_SHARING_BEARER',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-sharing-app.bicep',
      bicepStatus:
        'The sharing server is deployed but the Console has no credential for it. Set the LOOM_SHARING_BEARER secretref on the Console app to the same Key Vault secret passed as sharingBearerSecretUri.',
      followUp:
        'Both halves come from ONE Key Vault secret: the server renders it as its authorization.bearerToken, the Console presents it. See docs/fiab/security/loom-sharing-threat-model.md.',
    });
  }
  return t;
}

/**
 * The Entra audiences a RECIPIENT token may carry.
 *
 * `LOOM_SHARING_AUDIENCE` (comma or space separated) is the RIGHT answer — a
 * dedicated app registration / App ID URI exposed only to sharing recipients, so
 * that a token for the Console is not a token for the data-export endpoint. When
 * it is set it REPLACES the fallback rather than adding to it: an operator who
 * stands up a dedicated registration and still finds `api://<clientId>` accepted
 * has gained nothing. (A migration that needs both lists both.)
 *
 * With it unset, the Console's own App ID URI is the fallback — usable ONLY
 * alongside a scope/app-role pin, see {@link sharingAudiencePinned}. The BARE
 * client id is never accepted: that is the audience shape of the Console's own
 * ID tokens.
 */
export function sharingRecipientAudiences(): string[] {
  const explicit = splitList(process.env.LOOM_SHARING_AUDIENCE);
  if (explicit.length) return [...new Set(explicit)];
  const clientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  return clientId ? [`api://${clientId}`] : [];
}

function splitList(raw: string | undefined): string[] {
  return (raw || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Scope / app-role pin for recipient tokens (`LOOM_SHARING_SCOPE`, comma or
 * space separated). A token without one of these values in `scp`/`roles` is
 * refused even when its audience matches.
 */
export function sharingRequiredScopes(): string[] {
  return splitList(process.env.LOOM_SHARING_SCOPE);
}

/**
 * Is the recipient credential actually PINNED to the data-export API?
 *
 * Round-2 of this change closed the ID-token half of the audience problem (the
 * bare client id is rejected, and an access token is required) but left the other
 * half open: with only `api://<clientId>` accepted and no scope pinned, ANY
 * access token minted for the Console's own API satisfies the audience check.
 * The audience then isolates nothing — it is the Console's own registration —
 * and the recipient-principal lookup is the sole authorization surface. That is
 * one control, not two, on the path that moves data outside the boundary.
 *
 * The pin is adequate when EITHER holds:
 *
 *   - every accepted audience is DEDICATED — i.e. none of them is the Console's
 *     own client id / App ID URI; or
 *   - a scope or app role is pinned — `LOOM_SHARING_SCOPE`, which the operator
 *     exposes on the Console registration and consents ONLY to recipient apps.
 *
 * Setting `LOOM_SHARING_AUDIENCE=api://<the Console's own clientId>` does NOT
 * count: that is the weak configuration spelled out longhand, and a check a
 * caller can satisfy by restating the default is not a check.
 *
 * When neither holds, `authenticateRecipient` fails CLOSED with 503 rather than
 * accepting a credential it cannot distinguish from an ordinary Console API
 * token. This is an honest infra gate, not a feature flag: it costs nothing on a
 * default deployment, because a recipient must be registered by an admin before
 * this endpoint can serve anyone at all.
 */
export function sharingAudiencePinned(): boolean {
  if (sharingRequiredScopes().length > 0) return true;
  const audiences = sharingRecipientAudiences().map((a) => a.toLowerCase());
  if (!audiences.length) return false;
  const clientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim().toLowerCase();
  if (!clientId) return true;
  return audiences.every((a) => a !== clientId && a !== `api://${clientId}`);
}

export class LoomSharingError extends Error {
  status: number;
  body?: string;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = 'LoomSharingError';
    this.status = status;
    this.body = body;
  }
}

/**
 * One call to the reference server. `path` is protocol-relative
 * (`/shares/x/schemas/y/tables/z/metadata`); the endpoint prefix and the bearer
 * are added here so no caller can forget either.
 *
 * NOTE for callers: reaching this function means authorization has ALREADY
 * happened. The server will happily serve any share it knows about to anyone
 * holding this bearer.
 */
export async function loomSharingFetch(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  timeoutMs = 20000,
): Promise<Response> {
  const url = `${loomSharingBase()}${loomSharingEndpoint()}${path.startsWith('/') ? path : `/${path}`}`;
  return fetchWithTimeout(
    url,
    {
      method: init.method || 'GET',
      headers: {
        authorization: `Bearer ${loomSharingBearer()}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      body: init.body,
      cache: 'no-store',
    },
    timeoutMs,
  );
}

// ── Cosmos store ───────────────────────────────────────────────────────────
//
// ONE tenant-partitioned container holds both record kinds, with document ids
// namespaced `share:<name>` / `recipient:<name>`. That is deliberate: every
// recipient protocol call has to resolve the caller's grants, so keeping the
// two kinds co-partitioned lets that hot path be a single-partition read
// instead of two round trips. The model keeps bare names as ids; the prefixing
// is an implementation detail confined to this file.

type SharingDoc<T> = T & { kind: 'share' | 'recipient'; name: string };

// NAMES ARE CANONICAL IN THE DOCUMENT ID. Cosmos ids are case-SENSITIVE, so
// `share:sales` and `share:Sales` would be two different documents while
// `recipientCanAccessShare` treats the two names as one — the round-4
// cross-recipient read. Building the id from `canonicalSharingName` makes the
// collision unrepresentable: there is exactly one document per canonical name,
// so an authorization decision and the point read that follows it cannot resolve
// to different records. See lib/sharing/model.ts canonicalSharingName.

function shareDocId(name: string): string {
  return `share:${canonicalSharingName(name)}`;
}
function recipientDocId(name: string): string {
  return `recipient:${canonicalSharingName(name)}`;
}

/**
 * Strip the storage prefix so callers only ever see the bare share/recipient
 * name, and REFUSE a document whose stored name is not canonical.
 *
 * The refusal is the read-side half of the invariant. `listShares` /
 * `listRecipients` are SQL queries, not point reads, so a document written
 * before this fix — or inserted by hand — would otherwise still reach the
 * authorization code under a name the grant list matches case-insensitively.
 * Dropping it is fail-closed: the record does not exist as far as Loom is
 * concerned, so it can neither be discovered nor served.
 */
function fromDoc<T extends { id: string }>(doc: SharingDoc<T>): T | null {
  if (!isCanonicalSharingName(doc.name)) {
    console.warn(
      `[sharing] refusing non-canonical ${doc.kind} document "${doc.name}" — `
      + 'share and recipient names are case-insensitive identifiers and must be stored canonically '
      + '(lib/sharing/model.ts canonicalSharingName). Re-create the record.',
    );
    return null;
  }
  return { ...doc, id: doc.name } as T;
}

/** Grant lists are compared case-insensitively by the data plane, so they are
 *  stored canonical and de-duplicated. A mixed-case entry that survived a write
 *  is normalised on read too, so the admin view and the authorization decision
 *  see the same list. */
function canonicalGrants(shares: unknown): string[] {
  const list = Array.isArray(shares) ? shares : [];
  return [...new Set(list.map((s) => canonicalSharingName(s as string)).filter(Boolean))];
}

/**
 * Entra principal ids, canonical.
 *
 * `matchRecipientByPrincipal` compares them case-insensitively (Entra emits
 * GUIDs in mixed case across token versions) while they were stored verbatim —
 * the SAME compare/store divergence as the share name, one field over. Its
 * consequence is a suspend or a DELETE that appears to work: two recipient
 * records could each hold the same principal in different case, authentication
 * matches whichever sorts first, and disabling that one leaves the other
 * authenticating. Stored canonical, so a duplicate is detectable (see
 * loomCreateRecipient) and the audit row's `actorOid` matches the record.
 */
function canonicalPrincipalIds(ids: unknown): string[] {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.map((p) => String(p ?? '').trim().toLowerCase()).filter(Boolean))];
}

function recipientFromDoc(doc: SharingDoc<LoomRecipient>): LoomRecipient | null {
  const base = fromDoc(doc);
  return base
    ? { ...base, shares: canonicalGrants(base.shares), principalIds: canonicalPrincipalIds(base.principalIds) }
    : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Every published share for a tenant. Single-partition read. */
export async function listShares(tenantId: string): Promise<LoomShare[]> {
  const c = await sharingContainer();
  const { resources } = await c.items
    .query<SharingDoc<LoomShare>>({
      query: "SELECT * FROM c WHERE c.tenantId = @t AND c.kind = 'share'",
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return (resources || [])
    .map(fromDoc)
    .filter((s): s is LoomShare => !!s)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getShare(tenantId: string, name: string): Promise<LoomShare | null> {
  const c = await sharingContainer();
  try {
    const { resource } = await c.item(shareDocId(name), tenantId).read<SharingDoc<LoomShare>>();
    return resource ? fromDoc(resource) : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function upsertShare(share: LoomShare): Promise<LoomShare> {
  const c = await sharingContainer();
  const name = canonicalSharingName(share.id);
  const doc: SharingDoc<LoomShare> = {
    ...share,
    id: shareDocId(name),
    // Canonical, so the stored name and the document id agree with every
    // comparison made against them.
    name,
    kind: 'share',
    updatedAt: nowIso(),
    createdAt: share.createdAt || nowIso(),
  };
  await c.items.upsert(doc);
  // Non-null by construction: `name` came out of canonicalSharingName.
  return fromDoc(doc) as LoomShare;
}

export async function deleteShare(tenantId: string, name: string): Promise<void> {
  const c = await sharingContainer();
  try {
    await c.item(shareDocId(name), tenantId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}

/** Every recipient for a tenant. Single-partition read — this is on the
 *  recipient hot path, once per protocol call. */
export async function listRecipients(tenantId: string): Promise<LoomRecipient[]> {
  const c = await sharingContainer();
  const { resources } = await c.items
    .query<SharingDoc<LoomRecipient>>({
      query: "SELECT * FROM c WHERE c.tenantId = @t AND c.kind = 'recipient'",
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return (resources || [])
    .map(recipientFromDoc)
    .filter((r): r is LoomRecipient => !!r)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getRecipient(tenantId: string, name: string): Promise<LoomRecipient | null> {
  const c = await sharingContainer();
  try {
    const { resource } = await c.item(recipientDocId(name), tenantId).read<SharingDoc<LoomRecipient>>();
    return resource ? recipientFromDoc(resource) : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function upsertRecipient(recipient: LoomRecipient): Promise<LoomRecipient> {
  const c = await sharingContainer();
  const name = canonicalSharingName(recipient.id);
  const doc: SharingDoc<LoomRecipient> = {
    ...recipient,
    id: recipientDocId(name),
    name,
    // The grant list IS the authorization input, so it is stored in the same
    // canonical form every comparison against it uses.
    shares: canonicalGrants(recipient.shares),
    // Likewise the principals: matched case-insensitively, so stored that way.
    principalIds: canonicalPrincipalIds(recipient.principalIds),
    kind: 'recipient',
    updatedAt: nowIso(),
    createdAt: recipient.createdAt || nowIso(),
  };
  await c.items.upsert(doc);
  return recipientFromDoc(doc) as LoomRecipient;
}

export async function deleteRecipient(tenantId: string, name: string): Promise<void> {
  const c = await sharingContainer();
  try {
    await c.item(recipientDocId(name), tenantId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}
