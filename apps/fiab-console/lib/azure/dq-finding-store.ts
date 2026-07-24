/**
 * loom-dq-findings store (SERVER-ONLY) — persist the N7d findings N17 consumes.
 *
 * N7d is the PRODUCER of data-quality findings; **N17's incident console OWNS
 * the incident UX**. This store is the hand-off: findings are written here
 * (idempotent by deterministic id, so a re-run upserts) and N17 lists / promotes
 * them. Every write is AUDITED (`_auditLog` + `emitAuditEvent`) because a finding
 * is a governance signal.
 *
 * Azure-native, in-boundary Cosmos — the detect→emit→consume loop runs fully
 * disconnected in an air-gapped IL5 enclave (no SaaS incident service).
 */

import { auditLogContainer, dqFindingsContainer } from './cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { DQ_FINDING_CONTAINER, type DqFindingDoc } from './dq-finding-model';

export interface WriteFindingsActor {
  oid: string;
  upn: string;
  tenantId: string;
}

/**
 * Upsert a batch of findings (idempotent — deterministic ids) and audit the
 * emission. A per-finding upsert failure is collected, not thrown, so one bad
 * row never loses the rest; the count of written rows is returned for the receipt.
 */
export async function writeDqFindings(findings: DqFindingDoc[], actor: WriteFindingsActor): Promise<{ written: number; failed: number }> {
  if (!findings.length) return { written: 0, failed: 0 };
  const c = await dqFindingsContainer();
  let written = 0;
  let failed = 0;
  for (const f of findings) {
    try {
      await c.items.upsert(f);
      written++;
    } catch {
      failed++;
    }
  }

  const at = new Date().toISOString();
  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: actor.tenantId,
      itemId: findings[0]?.itemId || 'data-quality',
      itemType: 'dq-finding',
      action: 'dq.findings.emit',
      summary: `Emitted ${written} data-quality finding(s) for N17 (run ${findings[0]?.runId || '?'})`,
      count: written,
      runId: findings[0]?.runId || '',
      upn: actor.upn,
      actorOid: actor.oid,
      at,
    });
  } catch {
    /* audit best-effort; the finding write is the authoritative artifact */
  }
  try {
    emitAuditEvent({
      actorOid: actor.oid,
      actorUpn: actor.upn,
      action: 'dq.findings.emit',
      targetType: 'dq-finding',
      targetId: findings[0]?.runId || 'run',
      outcome: failed ? 'failure' : 'success',
      tenantId: actor.tenantId,
      timestamp: at,
      detail: { container: DQ_FINDING_CONTAINER, written, failed },
    });
  } catch {
    /* fan-out best-effort by contract */
  }
  return { written, failed };
}

export interface ListFindingsOpts {
  /** Restrict to one source item (a data-quality item id). */
  itemId?: string;
  /** Restrict to one run. */
  runId?: string;
  /** Only open findings (the N17 default). */
  openOnly?: boolean;
  limit?: number;
}

/**
 * List a tenant's findings newest-first (single-partition query on /tenantId).
 * This is the feed N17's incident console reads. Real Cosmos query — no mocks.
 */
export async function listDqFindings(tenantId: string, opts: ListFindingsOpts = {}): Promise<DqFindingDoc[]> {
  const c = await dqFindingsContainer();
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 200), 1000));
  const filters: string[] = ['c.tenantId = @tenantId', "c.docType = 'dq-finding'"];
  const params: Array<{ name: string; value: unknown }> = [{ name: '@tenantId', value: tenantId }];
  if (opts.itemId) { filters.push('c.itemId = @itemId'); params.push({ name: '@itemId', value: opts.itemId }); }
  if (opts.runId) { filters.push('c.runId = @runId'); params.push({ name: '@runId', value: opts.runId }); }
  if (opts.openOnly) { filters.push("c.status = 'open'"); }
  const query = `SELECT * FROM c WHERE ${filters.join(' AND ')} ORDER BY c.lastSeenAt DESC OFFSET 0 LIMIT ${limit}`;
  const { resources } = await c.items.query<DqFindingDoc>({ query, parameters: params as never }).fetchAll();
  return resources;
}
