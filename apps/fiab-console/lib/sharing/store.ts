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
 * `LOOM_SHARING_AUDIENCE` is the RIGHT answer — a dedicated app registration (or
 * App ID URI) exposed only to sharing recipients, so that a token for the
 * Console is not a token for the data-export endpoint.
 *
 * Without it we fall back to the Console's own App ID URI (`api://<clientId>`),
 * which still requires a registered recipient principal and (see
 * `verifyEntraBearer`) an ACCESS token carrying `scp`/`roles`. The BARE client
 * id is deliberately NOT accepted: that is the audience shape of the Console's
 * own ID tokens, and accepting it would let an ordinary interactive sign-in
 * credential be replayed at the data plane.
 */
export function sharingRecipientAudiences(): string[] {
  const out: string[] = [];
  const explicit = (process.env.LOOM_SHARING_AUDIENCE || '').trim();
  if (explicit) out.push(explicit);
  const clientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  if (clientId) out.push(`api://${clientId}`);
  return [...new Set(out)];
}

/** Optional scope/app-role pin for recipient tokens (`LOOM_SHARING_SCOPE`). Unset
 *  by default — no day-one gate — but when set, a token without it is refused
 *  even if its audience matches. */
export function sharingRequiredScopes(): string[] {
  return (process.env.LOOM_SHARING_SCOPE || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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

function shareDocId(name: string): string {
  return `share:${name}`;
}
function recipientDocId(name: string): string {
  return `recipient:${name}`;
}
/** Strip the storage prefix so callers only ever see the bare share/recipient name. */
function fromDoc<T extends { id: string }>(doc: SharingDoc<T>): T {
  return { ...doc, id: doc.name } as T;
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
  return (resources || []).map(fromDoc).sort((a, b) => a.id.localeCompare(b.id));
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
  const doc: SharingDoc<LoomShare> = {
    ...share,
    id: shareDocId(share.id),
    name: share.id,
    kind: 'share',
    updatedAt: nowIso(),
    createdAt: share.createdAt || nowIso(),
  };
  await c.items.upsert(doc);
  return fromDoc(doc);
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
  return (resources || []).map(fromDoc).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getRecipient(tenantId: string, name: string): Promise<LoomRecipient | null> {
  const c = await sharingContainer();
  try {
    const { resource } = await c.item(recipientDocId(name), tenantId).read<SharingDoc<LoomRecipient>>();
    return resource ? fromDoc(resource) : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function upsertRecipient(recipient: LoomRecipient): Promise<LoomRecipient> {
  const c = await sharingContainer();
  const doc: SharingDoc<LoomRecipient> = {
    ...recipient,
    id: recipientDocId(recipient.id),
    name: recipient.id,
    kind: 'recipient',
    updatedAt: nowIso(),
    createdAt: recipient.createdAt || nowIso(),
  };
  await c.items.upsert(doc);
  return fromDoc(doc);
}

export async function deleteRecipient(tenantId: string, name: string): Promise<void> {
  const c = await sharingContainer();
  try {
    await c.item(recipientDocId(name), tenantId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}
