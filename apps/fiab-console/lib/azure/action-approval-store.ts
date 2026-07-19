/**
 * Foundry-parity "approvals" (row 4.6) — a run of an approval-gated ontology
 * action is blocked until an approver approves the request for the EXACT
 * parameters. Approvals are one-shot: consumed on the next matching run so an
 * approval can't be silently replayed.
 *
 * Stored in the shared Cosmos `audit-log` container (partition `/itemId` = the
 * ontology id) as `kind:'action-approval'`, so decisions are part of the
 * tamper-evident chain and listable per ontology for a review pane.
 * Azure-native (Cosmos) — no Fabric.
 */
import { auditLogContainer } from './cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';

export const ACTION_APPROVAL_KIND = 'action-approval';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ActionApproval {
  id: string;
  itemId: string;            // ontology id (partition key)
  kind: typeof ACTION_APPROVAL_KIND;
  ontologyName?: string;
  action: string;
  objectType: string;
  actionKind: 'create' | 'update' | 'delete';
  paramsHash: string;        // ties the approval to exact parameters
  paramsPreview?: string;    // short human-readable summary
  status: ApprovalStatus;
  consumed?: boolean;        // an approved request that has been used by a run
  requesterOid: string;
  requesterName?: string;
  decidedByOid?: string;
  decidedByName?: string;
  decidedAt?: string;
  note?: string;
  at: string;                // ISO — request time
}

/**
 * Deterministic hash of the run parameters so an approval is bound to the exact
 * values it was granted for. Canonical JSON (sorted keys) → 32-bit rolling hash,
 * hex. No crypto/Math.random (deterministic + available everywhere).
 */
export function paramsHash(params: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortDeep(params ?? {}));
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function previewParams(params: Record<string, unknown>): string {
  return Object.entries(params ?? {}).filter(([k]) => !k.startsWith('_')).slice(0, 5).map(([k, v]) => `${k}=${String(v)}`).join(', ');
}

/** Create a pending approval request for a blocked run. */
export async function requestApproval(
  session: SessionPayload,
  input: { ontologyId: string; ontologyName?: string; action: string; objectType: string; actionKind: 'create' | 'update' | 'delete'; params: Record<string, unknown>; nowIso: string },
): Promise<ActionApproval> {
  const hash = paramsHash(input.params);
  const rec: ActionApproval = {
    id: `action-approval:${input.ontologyId}:${input.action}:${hash}:${input.nowIso}`,
    itemId: input.ontologyId,
    kind: ACTION_APPROVAL_KIND,
    ...(input.ontologyName ? { ontologyName: input.ontologyName } : {}),
    action: input.action,
    objectType: input.objectType,
    actionKind: input.actionKind,
    paramsHash: hash,
    ...(previewParams(input.params) ? { paramsPreview: previewParams(input.params) } : {}),
    status: 'pending',
    requesterOid: session.claims.oid,
    ...(session.claims.name ? { requesterName: session.claims.name } : {}),
    at: input.nowIso,
  };
  const c = await auditLogContainer();
  await c.items.upsert(rec);
  return rec;
}

/** The newest APPROVED, unconsumed approval matching this action + params, or null. */
export async function findUsableApproval(ontologyId: string, action: string, hash: string): Promise<ActionApproval | null> {
  const c = await auditLogContainer();
  const { resources } = await c.items
    .query<ActionApproval>({
      query: 'SELECT * FROM c WHERE c.itemId = @i AND c.kind = @k AND c.action = @a AND c.paramsHash = @h AND c.status = @s AND (NOT IS_DEFINED(c.consumed) OR c.consumed = false) ORDER BY c._ts DESC',
      parameters: [
        { name: '@i', value: ontologyId }, { name: '@k', value: ACTION_APPROVAL_KIND },
        { name: '@a', value: action }, { name: '@h', value: hash }, { name: '@s', value: 'approved' as ApprovalStatus },
      ],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/** Mark an approved request consumed after a successful run (best-effort). */
export async function consumeApproval(id: string, itemId: string): Promise<void> {
  const c = await auditLogContainer();
  try {
    const { resource } = await c.item(id, itemId).read<ActionApproval>();
    if (resource) await c.items.upsert({ ...resource, consumed: true });
  } catch { /* best-effort */ }
}

/** Approve or reject a pending request. Returns the updated record or null. */
export async function decideApproval(
  id: string, itemId: string, session: SessionPayload, decision: 'approve' | 'reject', note: string, nowIso: string,
): Promise<ActionApproval | null> {
  const c = await auditLogContainer();
  const { resource } = await c.item(id, itemId).read<ActionApproval>();
  if (!resource || resource.kind !== ACTION_APPROVAL_KIND) return null;
  const updated: ActionApproval = {
    ...resource,
    status: decision === 'approve' ? 'approved' : 'rejected',
    decidedByOid: session.claims.oid,
    ...(session.claims.name ? { decidedByName: session.claims.name } : {}),
    decidedAt: nowIso,
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  await c.items.upsert(updated);
  return updated;
}

/** List approvals for an ontology (newest first). */
export async function listApprovals(ontologyId: string, top = 50): Promise<ActionApproval[]> {
  const c = await auditLogContainer();
  const { resources } = await c.items
    .query<ActionApproval>({
      query: 'SELECT TOP @n * FROM c WHERE c.itemId = @i AND c.kind = @k ORDER BY c._ts DESC',
      parameters: [
        { name: '@n', value: Math.max(1, Math.min(200, top)) },
        { name: '@i', value: ontologyId }, { name: '@k', value: ACTION_APPROVAL_KIND },
      ],
    })
    .fetchAll();
  return resources || [];
}
