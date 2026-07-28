/**
 * Cosmos-backed store for access-review evidence records (loom-apex B-N19c').
 *
 * Append-only. `sealCampaignEvidence` is called from the campaign CLOSE path
 * (`close-campaign.ts`, after the campaign doc is persisted) — it reads the
 * tenant's current chain head, seals the closed campaign into a new record whose
 * `prevHash` points at that head, writes it, and fans the event out through
 * `emitAuditEvent` (SIEM stream + outbound webhooks) plus the Cosmos audit trail.
 *
 * Failure policy: sealing NEVER fails the close. A campaign that closed with a
 * real backend revoke must stay closed even if Cosmos rejects the evidence write;
 * the caller receives `{ evidence: null, error }` and surfaces it as a warning.
 * The reverse (evidence for a campaign that did not close) is prevented by
 * calling this only AFTER the campaign replace succeeds.
 */
import crypto from 'node:crypto';
import { accessReviewEvidenceContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { AccessReview } from '@/lib/types/access-review';
import type { AccessReviewEvidence } from '@/lib/types/access-review-evidence';
import { buildEvidenceRecord } from '@/lib/access/evidence-record';

/** Who sealed the record — used for the audit/SIEM fan-out. */
export interface EvidenceActor {
  oid?: string;
  upn?: string;
  /** Entra tenant id (session `claims.tid`) for the SIEM row. */
  tid?: string;
}

/**
 * Read the tenant's current chain head (highest `sequence`). Returns `null` for
 * a tenant with no evidence yet — the next record is then sequence 1 linking to
 * the genesis hash.
 */
export async function readChainHead(tenantId: string): Promise<AccessReviewEvidence | null> {
  const c = await accessReviewEvidenceContainer();
  const { resources } = await c.items
    .query<AccessReviewEvidence>({
      query: 'SELECT TOP 1 * FROM c WHERE c.tenantId = @t ORDER BY c.sequence DESC',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId })
    .fetchAll();
  return resources[0] || null;
}

/** Every evidence record for one campaign, oldest first. */
export async function listCampaignEvidence(tenantId: string, campaignId: string): Promise<AccessReviewEvidence[]> {
  const c = await accessReviewEvidenceContainer();
  const { resources } = await c.items
    .query<AccessReviewEvidence>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.campaignId = @c ORDER BY c.sequence ASC',
      parameters: [{ name: '@t', value: tenantId }, { name: '@c', value: campaignId }],
    }, { partitionKey: tenantId })
    .fetchAll();
  return resources || [];
}

/** The whole tenant chain, oldest first (bounded — evidence is one row per close). */
export async function listTenantEvidence(tenantId: string, max = 500): Promise<AccessReviewEvidence[]> {
  const c = await accessReviewEvidenceContainer();
  const { resources } = await c.items
    .query<AccessReviewEvidence>({
      query: `SELECT TOP ${Math.max(1, Math.min(2000, Math.floor(max)))} * FROM c WHERE c.tenantId = @t ORDER BY c.sequence ASC`,
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId })
    .fetchAll();
  return resources || [];
}

export interface SealOptions {
  /** Backend revokes that actually ran during close (from closeCampaign). */
  backendRevoked?: number;
  /** Non-fatal revoke warnings from close. */
  warnings?: string[];
  /** Who closed the campaign. */
  actor?: EvidenceActor;
  /** ISO timestamp; defaults to now. */
  now?: string;
}

/**
 * Seal a CLOSED campaign into the tenant's evidence chain. Returns the new
 * record, or `{ evidence: null, error }` when the write failed (never throws —
 * the close itself already happened).
 */
export async function sealCampaignEvidence(
  review: AccessReview,
  by: string,
  opts: SealOptions = {},
): Promise<{ evidence: AccessReviewEvidence | null; error?: string }> {
  try {
    const head = await readChainHead(review.tenantId);
    const record = buildEvidenceRecord(review, {
      prevHash: head?.contentHash,
      sequence: (head?.sequence || 0) + 1,
      recordedBy: by,
      backendRevoked: opts.backendRevoked,
      warnings: opts.warnings,
      now: opts.now,
    });
    const c = await accessReviewEvidenceContainer();
    const { resource } = await c.items.create<AccessReviewEvidence>(record);
    const saved = (resource as AccessReviewEvidence) || record;

    // Cosmos audit trail (what /admin/audit-logs reads) — best effort.
    try {
      const al = await auditLogContainer();
      await al.items.create({
        id: crypto.randomUUID(),
        itemId: review.id,
        itemType: 'access-review',
        action: 'review-evidence-sealed',
        summary: `Evidence record #${saved.sequence} sealed for review "${review.name}" — ${saved.totals.total} decision(s), ${saved.totals.revoked} revocation(s), hash ${saved.contentHash.slice(0, 16)}…`,
        upn: by,
        at: saved.recordedAt,
      });
    } catch {
      /* the evidence row is the authoritative record; the trail row is additive */
    }

    // SIEM stream + outbound webhooks.
    emitAuditEvent({
      actorOid: opts.actor?.oid || '',
      actorUpn: opts.actor?.upn || by,
      action: 'access-review.evidence-sealed',
      targetType: 'access-review-evidence',
      targetId: saved.id,
      outcome: 'success',
      tenantId: opts.actor?.tid || review.tenantId,
      timestamp: saved.recordedAt,
      detail: {
        campaignId: review.id,
        campaignName: review.name,
        sequence: saved.sequence,
        prevHash: saved.prevHash,
        contentHash: saved.contentHash,
        totals: saved.totals,
      },
    });
    return { evidence: saved };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn('[access-review-evidence] failed to seal evidence record:', error);
    return { evidence: null, error };
  }
}
