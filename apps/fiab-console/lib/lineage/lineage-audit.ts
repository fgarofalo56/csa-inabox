/**
 * LU-8 — the ONE audit path every OpenLineage producer writes through.
 *
 * The cross-workspace denial audit used to be a PRIVATE copy inside
 * `POST /api/lineage/openlineage`, which meant every additional producer of the
 * shared lineage store either had to duplicate it or (as the first cut of the
 * Synapse harvests did) skip silently with no attributable record. It lives here
 * so a new producer inherits the row and the credential strip instead of
 * re-deciding them.
 *
 * `lineage.cross-workspace-denied` — a producer named a dataset owned by an item
 * in a DIFFERENT workspace. Denials must be audited (SI-7/SC-8: a rejected write
 * is exactly the event a reviewer needs to see). Best-effort: the enforcement is
 * the 403, not the row.
 *
 * The write-side row (`lineage.harvested`) belongs to the producer PR that
 * actually harvests — it is added there with its emitters rather than parked
 * here with no caller.
 */

import crypto from 'node:crypto';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { canonicalDatasetIdentity } from '@/lib/lineage/dataset-naming';

export const LINEAGE_DENIED_KIND = 'lineage.cross-workspace-denied';
export const LINEAGE_WRITE_KIND = 'lineage.harvested';

function auditId(): string {
  return `audit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export interface CrossWorkspaceDenial {
  /** Producer identity: the OL credential principal, or the caller's oid. */
  principal: string;
  /** Which producer tripped the probe (`openlineage-ingest`, `adf-harvest`…). */
  producer: string;
  authorizedWorkspaceId: string;
  targetWorkspaceId: string;
  uri: string;
  itemId: string;
}

/** Authoritative audit row + SIEM emit for a cross-workspace write attempt. */
export async function auditCrossWorkspaceDenial(opts: CrossWorkspaceDenial): Promise<void> {
  // STRIP AT THE SINK, not only at the callers (round-3 class fix).
  //
  // The denial row persists `uri` into the Cosmos audit document's `target`
  // and onto the SIEM stream. That is a durable credential store exactly like
  // the thread edge, so the same rule applies. Round 2 stripped the harvest
  // producer's uri and left the ingest producer passing `edge.toUri` RAW —
  // the same defect, one door down. Canonicalizing HERE means no producer,
  // present or future, can reopen it: there is one door left and it is inside
  // this function.
  const uri = canonicalDatasetIdentity(opts.uri);
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: auditId(),
        itemId: `lineage:${opts.itemId}`,
        tenantId: opts.authorizedWorkspaceId,
        who: opts.principal,
        actorOid: opts.principal,
        at: new Date().toISOString(),
        kind: LINEAGE_DENIED_KIND,
        target: uri,
        detail: {
          producer: opts.producer,
          authorizedWorkspaceId: opts.authorizedWorkspaceId,
          targetWorkspaceId: opts.targetWorkspaceId,
          resolvedItemId: opts.itemId,
        },
      })
      .catch(() => undefined);
  } catch {
    /* audit is best-effort; the 403 / skip itself is the enforcement */
  }
  emitAuditEvent({
    actorOid: opts.principal,
    actorUpn: opts.principal,
    action: LINEAGE_DENIED_KIND,
    targetType: 'thread-edge',
    targetId: opts.itemId,
    outcome: 'denied',
    tenantId: opts.authorizedWorkspaceId,
    detail: {
      producer: opts.producer,
      uri,
      authorizedWorkspaceId: opts.authorizedWorkspaceId,
      targetWorkspaceId: opts.targetWorkspaceId,
    },
  });
}

export interface LineageWriteAudit {
  principal: string;
  producer: string;
  workspaceId: string;
  /** The run the edges were derived from (ADF run id / Livy batch id). */
  runKey: string;
  written: number;
  denied: number;
}

/** Authoritative audit row + SIEM emit for a harvest that wrote lineage. */
export async function auditLineageWrite(opts: LineageWriteAudit): Promise<void> {
  if (!opts.written && !opts.denied) return; // nothing happened — no row
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: auditId(),
        itemId: `lineage:${opts.producer}:${opts.runKey}`,
        tenantId: opts.workspaceId,
        who: opts.principal,
        actorOid: opts.principal,
        at: new Date().toISOString(),
        kind: LINEAGE_WRITE_KIND,
        target: opts.runKey,
        detail: { producer: opts.producer, written: opts.written, denied: opts.denied },
      })
      .catch(() => undefined);
  } catch {
    /* best-effort */
  }
  emitAuditEvent({
    actorOid: opts.principal,
    actorUpn: opts.principal,
    action: LINEAGE_WRITE_KIND,
    targetType: 'thread-edge',
    targetId: opts.runKey,
    outcome: opts.denied && !opts.written ? 'denied' : 'success',
    tenantId: opts.workspaceId,
    detail: { producer: opts.producer, written: opts.written, denied: opts.denied },
  });
}
