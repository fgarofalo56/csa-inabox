/**
 * Loom Sharing — the Cosmos store (LU-9).
 *
 * The AUTHORITATIVE record of shares, recipients, and grants. Loom decides what
 * is shared and who may see it; the OSS Delta Sharing reference server is only a
 * data-plane engine (it reads Delta logs and signs file URLs) and has exactly one
 * authorization primitive — a single global bearer — so it can never be the
 * enforcement point.
 *
 * This module used to hold the HTTP client for that server as well. It went out
 * with the recipient-facing proxy that was its only caller (see the SPLIT NOTICE
 * in docs/fiab/security/loom-sharing-threat-model.md). Nothing in this build
 * calls the sharing server, and the server has no external ingress.
 *
 * Real backends throughout (`.claude/rules/no-vaporware.md`): every function here
 * is a Cosmos query. When the server is not deployed the caller gets a typed
 * {@link LoomSharingNotConfiguredError} naming the exact env var, bicep module,
 * and remediation — never an empty array pretending to be data.
 */

import { sharingContainer } from '@/lib/azure/cosmos-client';
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

/** Open Delta Sharing publishing is on by default (default-ON / opt-out); an
 *  admin turns it off with LOOM_SHARING_ENABLED=false. The real prerequisite —
 *  a deployed sharing server — is reported separately and honestly. */
export function loomSharingEnabled(): boolean {
  return process.env.LOOM_SHARING_ENABLED !== 'false';
}

/** The Loom tenant that owns the shares. Recipients are EXTERNAL, so the owning
 *  tenant can never be read off a caller's token — it is the estate's own. */
export function sharingOwnerTenantId(): string {
  return (
    process.env.LOOM_ENTRA_TENANT_ID
    || process.env.LOOM_MSAL_TENANT_ID
    || process.env.AZURE_TENANT_ID
    || ''
  ).trim();
}

// ── Recipient-facing config + the server client — NOT IN THIS PR ────────
//
// The protocol prefix, the Console→server bearer, the recipient audience/scope
// pin and `loomSharingFetch` (the ONLY code that talks to the reference server)
// belong to the recipient-facing data plane, which was split out of this change.
// The control plane in this PR reads and writes Cosmos and renders the server's
// config manifest; it never calls the server. Keeping an authenticated HTTP
// client to a bearer-only backend around with no caller is exactly the loose end
// that gets picked up by the next route, so it goes out with its caller.
//
// See the follow-up PR referenced in
// docs/fiab/security/loom-sharing-threat-model.md.

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
