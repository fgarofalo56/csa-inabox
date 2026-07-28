/**
 * LU-8 — the ONE audit path every OpenLineage producer writes through.
 *
 * Loom now has three producers mutating the same lineage store: the
 * openlineage-spark listener ingest (`POST /api/lineage/openlineage`), the
 * Synapse/ADF pipeline harvest, and the Synapse Spark batch harvest. Before
 * this module the ingest route owned a private copy of the cross-workspace
 * denial audit and the harvests emitted nothing at all — so a write the ingest
 * route would 403-and-audit, a harvest performed silently, and no harvest write
 * was attributable at all.
 *
 * Two rows, both authoritative:
 *   - `lineage.cross-workspace-denied` — a producer named a dataset owned by an
 *     item in a DIFFERENT workspace. Denials must be audited (SI-7/SC-8: a
 *     rejected write is exactly the event a reviewer needs to see).
 *   - `lineage.harvested` — a producer wrote N edges. A new authenticated
 *     mutation of a shared store is auditable by construction.
 *
 * Both are best-effort: the enforcement is the 403 / the skip, not the row.
 */

import crypto from 'node:crypto';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

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
        target: opts.uri,
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
      uri: opts.uri,
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
