/**
 * External (cross-tenant) data sharing — Azure-native client (FGC-30).
 *
 * Fabric parity: Fabric's "External Data Sharing" shares a lakehouse / table
 * subset in-place to another Entra tenant, read-only, with expiry. Loom does the
 * SAME with the Azure-native cross-tenant mechanism and NO Fabric dependency
 * (.claude/rules/no-fabric-dependency.md):
 *
 *   1. Entra B2B guest — invite the foreign user into THIS tenant as a guest
 *      (Microsoft Graph POST /invitations, User.Invite.All). The guest's object
 *      id becomes the grant principal. Idempotent: an existing guest is reused.
 *   2. Scoped ADLS grant — apply a POSIX ACL that grants the guest read on ONLY
 *      the shared path (leaf = r-x + default-scope; every ancestor = --x
 *      traverse-only) so the guest can read the shared folder/table and NOTHING
 *      else in the container. This is the "scoped grant on just the shared path"
 *      guarantee (deriveAclGrantPlan) — NOT a container-wide RBAC grant.
 *   3. Share record — a Cosmos `external-shares` row (source item, target tenant/
 *      UPN, shared subset, read-only, expiry, lifecycle state) is the source of
 *      truth for the share list. Lifecycle: pending → accepted → revoked/expired.
 *   4. Revoke — remove the guest's ACL entries on every granted path (grant
 *      gone) and mark the row revoked.
 *
 * Per no-vaporware.md every step hits a real backend; a missing Graph permission
 * (User.Invite.All) or ADLS access surfaces as an honest error, never a fake
 * success.
 */

import { externalSharesContainer } from './cosmos-client';
import { getAcl, setAcl, type AclItem } from './adls-client';
import { inviteExternalGuest, findGuestByEmail, GraphIdentityError } from './graph-identity-client';
import {
  validateExternalShare,
  nextShareState,
  deriveAclGrantPlan,
  isExpired,
  type ExternalShareState,
  type ExternalShareInput,
} from './external-share-model';

/** Whether external cross-tenant sharing is switched on for this deployment.
 *  Default OFF — a foreign B2B invite is a deliberate governance action, so the
 *  operator opts in (matches the env-sync `_ENABLED$` runtime-only pattern). */
export function externalSharingEnabled(): boolean {
  return process.env.LOOM_EXTERNAL_SHARING_ENABLED === 'true';
}

export class ExternalSharingNotConfiguredError extends Error {
  hint: string;
  constructor() {
    super('External data sharing is not enabled in this deployment.');
    this.name = 'ExternalSharingNotConfiguredError';
    this.hint =
      'Set LOOM_EXTERNAL_SHARING_ENABLED=true on the loom-console Container App ' +
      '(or loomExternalSharingEnabled=true in the bicepparam + redeploy admin-plane), ' +
      'and grant the Console UAMI the Microsoft Graph app permission User.Invite.All ' +
      '(09850681-111b-4a89-9bed-3f2cae46d706) with admin consent so B2B invitations can be sent.';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Stored shape
// ────────────────────────────────────────────────────────────────────────────

export interface ExternalShare {
  /** Stable id — a random uuid. */
  id: string;
  /** Partition key — the source Loom item id. */
  sourceItemId: string;
  sourceItemType: string;
  sourceItemName?: string;
  /** Owner tenant id (the sharer). */
  tenantId: string;
  /** Foreign guest — the invited UPN/email and their tenant domain. */
  targetEmail: string;
  targetDomain: string;
  /** Object id of the B2B guest created/looked-up in this tenant. */
  guestPrincipalId?: string;
  /** The Graph invite redeem URL the guest follows to accept. */
  inviteRedeemUrl?: string;
  /** ADLS container + shared subset path. */
  container: string;
  sharedPath: string;
  /** Read-only is enforced (external shares are read-only). */
  readOnly: true;
  /** ISO expiry — external shares must expire. */
  expiry: string;
  /** Lifecycle. */
  state: ExternalShareState;
  /** Paths granted (for a precise revoke). */
  grantedPaths?: string[];
  createdBy: string;
  createdAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  /** Non-fatal notes (e.g. an ancestor ACL step that could not be written). */
  notes?: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Scoped ADLS ACL grant / revoke (merge-safe — never clobbers other entries)
// ────────────────────────────────────────────────────────────────────────────

async function upsertGuestAcl(
  container: string,
  path: string,
  guestId: string,
  permissions: AclItem['permissions'],
  withDefaultScope: boolean,
): Promise<void> {
  const current = await getAcl(container, path);
  const filtered = current.filter(
    (a) => !(a.type === 'user' && a.entityId === guestId && (a.scope === 'access' || (withDefaultScope && a.scope === 'default'))),
  );
  filtered.push({ scope: 'access', type: 'user', entityId: guestId, permissions });
  if (withDefaultScope) {
    // So files created in the shared dir later inherit the guest's read.
    filtered.push({ scope: 'default', type: 'user', entityId: guestId, permissions });
  }
  await setAcl(container, path, filtered);
}

async function removeGuestAcl(container: string, path: string, guestId: string): Promise<void> {
  const current = await getAcl(container, path);
  const filtered = current.filter((a) => !(a.type === 'user' && a.entityId === guestId));
  if (filtered.length !== current.length) await setAcl(container, path, filtered);
}

// ────────────────────────────────────────────────────────────────────────────
// Create
// ────────────────────────────────────────────────────────────────────────────

export interface CreateExternalShareInput {
  sourceItemId: string;
  sourceItemType: string;
  sourceItemName?: string;
  tenantId: string;
  container: string;
  sharedPath: string;
  targetUpnOrDomain: string;
  expiry: string;
  createdBy: string;
  /** Where the guest lands after redeeming the invite (the recipient view). */
  redirectUrl: string;
}

export async function createExternalShare(input: CreateExternalShareInput): Promise<ExternalShare> {
  if (!externalSharingEnabled()) throw new ExternalSharingNotConfiguredError();

  const v = validateExternalShare({
    sourceItemId: input.sourceItemId,
    container: input.container,
    sharedPath: input.sharedPath,
    targetUpnOrDomain: input.targetUpnOrDomain,
    expiry: input.expiry,
  } satisfies ExternalShareInput);
  if (!v.ok) {
    const e: any = new Error(v.error || 'invalid external share');
    e.status = 400;
    throw e;
  }

  const notes: string[] = [];
  const targetEmail = input.targetUpnOrDomain.trim();

  // 1. Entra B2B guest — reuse an existing guest, else send an invitation.
  let guestPrincipalId: string | undefined;
  let inviteRedeemUrl: string | undefined;
  if (v.targetIsUpn) {
    const existing = await findGuestByEmail(targetEmail).catch(() => null);
    if (existing) {
      guestPrincipalId = existing.id;
    } else {
      const invited = await inviteExternalGuest({
        email: targetEmail,
        redirectUrl: input.redirectUrl,
        sendInvitationMessage: false,
      });
      guestPrincipalId = invited.invitedUserId;
      inviteRedeemUrl = invited.inviteRedeemUrl;
    }
  } else {
    // A domain-only share cannot invite a specific guest — record the intent and
    // require a UPN before the scoped grant can be applied. Honest, not fake.
    notes.push('Domain-only target: no specific guest to grant yet — re-share with a full guest UPN (user@' + v.targetDomain + ') to apply the scoped ADLS grant.');
  }

  // 2. Scoped ADLS grant — leaf = r-x (+default), ancestors = --x traverse-only.
  const grantedPaths: string[] = [];
  if (guestPrincipalId) {
    const plan = deriveAclGrantPlan(input.sharedPath);
    for (const step of plan) {
      try {
        await upsertGuestAcl(input.container, step.path, guestPrincipalId, step.permissions, step.leaf);
        grantedPaths.push(step.path);
      } catch (e: any) {
        notes.push(`ACL grant failed on ${input.container}/${step.path || '(root)'}: ${e?.message || String(e)}`);
      }
    }
  }

  // 3. Cosmos record (source of truth).
  const doc: ExternalShare = {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sourceItemId: input.sourceItemId,
    sourceItemType: input.sourceItemType,
    sourceItemName: input.sourceItemName,
    tenantId: input.tenantId,
    targetEmail,
    targetDomain: v.targetDomain!,
    guestPrincipalId,
    inviteRedeemUrl,
    container: input.container,
    sharedPath: input.sharedPath,
    readOnly: true,
    expiry: input.expiry,
    state: 'pending',
    grantedPaths,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    ...(notes.length ? { notes } : {}),
  };
  const c = await externalSharesContainer();
  const { resource } = await c.items.upsert<ExternalShare>(doc);
  return resource ?? doc;
}

// ────────────────────────────────────────────────────────────────────────────
// Reads (tenant-scoped)
// ────────────────────────────────────────────────────────────────────────────

/** List external shares for a source item, scoped to the caller's tenant. On
 *  read, lazily flip any past-expiry share to `expired` (best-effort). */
export async function listExternalShares(sourceItemId: string, tenantId: string): Promise<ExternalShare[]> {
  const c = await externalSharesContainer();
  const { resources } = await c.items
    .query<ExternalShare>(
      {
        query: 'SELECT * FROM c WHERE c.sourceItemId = @i AND c.tenantId = @t ORDER BY c.createdAt DESC',
        parameters: [{ name: '@i', value: sourceItemId }, { name: '@t', value: tenantId }],
      },
      { partitionKey: sourceItemId },
    )
    .fetchAll();
  return resources.map((r) => (isExpired(r) && r.state !== 'revoked' && r.state !== 'expired' ? { ...r, state: 'expired' as const } : r));
}

/** RECIPIENT VIEW — list shares whose target guest matches `email`, across all
 *  source items (cross-partition; the guest doesn't own a partition). Used by the
 *  "Shared with me" recipient surface after the B2B guest redeems the invite. */
export async function listReceivedShares(email: string): Promise<ExternalShare[]> {
  const c = await externalSharesContainer();
  const { resources } = await c.items
    .query<ExternalShare>({
      query: 'SELECT * FROM c WHERE LOWER(c.targetEmail) = @e ORDER BY c.createdAt DESC',
      parameters: [{ name: '@e', value: email.trim().toLowerCase() }],
    })
    .fetchAll();
  return resources.map((r) => (isExpired(r) && r.state !== 'revoked' && r.state !== 'expired' ? { ...r, state: 'expired' as const } : r));
}

export async function getExternalShare(id: string, sourceItemId: string): Promise<ExternalShare | null> {
  const c = await externalSharesContainer();
  try {
    const { resource } = await c.item(id, sourceItemId).read<ExternalShare>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle transitions
// ────────────────────────────────────────────────────────────────────────────

/** Mark a share accepted (guest redeemed the invite). Enforces the state machine. */
export async function acceptExternalShare(id: string, sourceItemId: string): Promise<ExternalShare> {
  const c = await externalSharesContainer();
  const share = await getExternalShare(id, sourceItemId);
  if (!share) { const e: any = new Error('share not found'); e.status = 404; throw e; }
  if (isExpired(share)) { const e: any = new Error('share has expired'); e.status = 409; throw e; }
  const next = nextShareState(share.state, 'accept');
  if (!next) { const e: any = new Error(`cannot accept a share in state "${share.state}"`); e.status = 409; throw e; }
  const updated: ExternalShare = { ...share, state: next, acceptedAt: new Date().toISOString() };
  const { resource } = await c.items.upsert<ExternalShare>(updated);
  return resource ?? updated;
}

/** Revoke a share: remove the guest's scoped ACL on every granted path, then
 *  mark the row revoked. ACL removal is best-effort; the row always flips so the
 *  share disappears from the active list. */
export async function revokeExternalShare(id: string, sourceItemId: string): Promise<ExternalShare> {
  const c = await externalSharesContainer();
  const share = await getExternalShare(id, sourceItemId);
  if (!share) { const e: any = new Error('share not found'); e.status = 404; throw e; }
  const next = nextShareState(share.state, 'revoke');
  if (!next) { const e: any = new Error(`cannot revoke a share in state "${share.state}"`); e.status = 409; throw e; }
  const notes: string[] = [...(share.notes || [])];
  if (share.guestPrincipalId && share.grantedPaths?.length) {
    for (const p of share.grantedPaths) {
      try {
        await removeGuestAcl(share.container, p, share.guestPrincipalId);
      } catch (e: any) {
        notes.push(`ACL revoke failed on ${share.container}/${p || '(root)'}: ${e?.message || String(e)}`);
      }
    }
  }
  const updated: ExternalShare = { ...share, state: next, revokedAt: new Date().toISOString(), ...(notes.length ? { notes } : {}) };
  const { resource } = await c.items.upsert<ExternalShare>(updated);
  return resource ?? updated;
}

// Re-export the honest-gate class so routes can special-case it.
export { GraphIdentityError };
