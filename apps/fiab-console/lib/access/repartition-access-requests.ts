/**
 * REPARTITION the `access-request-workflow` container onto the tenant key.
 *
 * WHY A MIGRATION IS NEEDED AT ALL. Cosmos partition keys are IMMUTABLE. The
 * F16 fix changed what goes INTO `/tenantId` (the Entra tenant, via
 * tenantScopeId) but that only governs documents written from now on. Every
 * request filed before the fix still sits in a partition keyed by its
 * REQUESTER's `oid`, where the approval inbox — which now reads the tenant
 * partition — cannot see it. Those requests are not corrupt; they are
 * unreachable. Moving them means REWRITING each one under the new key and
 * removing the old copy, because Cosmos cannot update a partition key in place.
 *
 * DESIGN CONSTRAINTS (deploy-integrity R6/R7, no-vaporware):
 *
 *   IDEMPOTENT — the unit of work is "documents whose tenantId is not the target
 *     tenant". A second run finds none and moves nothing. A run interrupted
 *     between the write and the delete leaves the document in BOTH partitions;
 *     the next run sees the target copy already present, skips the write, and
 *     completes the delete. Convergent from any partial state.
 *
 *   FAIL-CLOSED, AND "COULD NOT DETERMINE" NEVER READS AS "NOTHING TO DO" —
 *     every document lands in exactly one of moved / alreadyMigrated / failed,
 *     and `failed` is itemised with its error. A run with any failure returns
 *     ok:false. `scanned` is reported separately from `needingMigration` so an
 *     empty container (scanned 0) can never be mistaken for a clean container
 *     (scanned N, needing 0) — the distinction this repo has been bitten by.
 *     No per-document error is swallowed; there is no bare catch here.
 *
 *   REVERSIBLE / VERIFIABLE — each moved document carries a `_repartition`
 *     stamp recording the partition it came from and when, so the move is
 *     auditable and can be reversed by writing it back under `previousTenantId`.
 *     `verifyRepartition` independently re-scans and reports the residual count,
 *     which must be 0; the route calls it AFTER the move and reports the result
 *     rather than asserting success from the write loop's own bookkeeping.
 *
 * SEQUENCING with `access-governance/backfill`: run this FIRST, confirm
 * `residual === 0`, then run the backfill. The backfill sweeps
 * `SELECT ... WHERE c.status = 'completed'` cross-partition so it reads both
 * layouts, but seeding the entitlement ledger from requests the inbox cannot
 * show would record grants nobody can trace back to an actionable request.
 */

/** The minimal container surface this migration needs. */
export interface RepartitionContainer {
  items: {
    create<T = any>(doc: T): Promise<{ resource: T }>;
    query<T = any>(
      spec: { query: string; parameters?: { name: string; value: any }[] },
      options?: { partitionKey?: string },
    ): { fetchAll(): Promise<{ resources: T[] }> };
  };
  item(id: string, pk?: string): {
    read<T = any>(): Promise<{ resource: T | undefined }>;
    delete(): Promise<{ resource: any }>;
  };
}

export interface RepartitionStamp {
  /** The partition the document was moved OUT of (a user oid). */
  previousTenantId: string;
  movedAt: string;
  /** Short fingerprint of the target tenant — never the full id. */
  toFingerprint: string;
}

export interface RepartitionPlanRow {
  id: string;
  previousTenantId: string;
  requesterId?: string;
  assetName?: string;
  status?: string;
}

export interface RepartitionResult {
  ok: boolean;
  dryRun: boolean;
  /** Total documents examined. Distinct from `needingMigration` ON PURPOSE. */
  scanned: number;
  /** Of those, how many were in the wrong partition. */
  needingMigration: number;
  moved: number;
  /** Already present in the target partition (a resumed / repeated run). */
  alreadyMigrated: number;
  failed: { id: string; previousTenantId: string; error: string }[];
  /** Populated on a dry run: exactly what a real run would move. */
  plan: RepartitionPlanRow[];
  /** Independent post-move re-scan. null on a dry run. */
  residual: number | null;
  message: string;
}

/** Short, non-identifying fingerprint of a tenant id (never log the full id). */
export function tenantFingerprint(tenantId: string): string {
  return `${tenantId.slice(0, 4)}…${tenantId.slice(-4)}`;
}

const SCAN_CAP = 10_000;

/** Every access-request document, across all partitions. */
async function scanAll(c: RepartitionContainer): Promise<any[]> {
  const { resources } = await c.items
    .query<any>({
      query: `SELECT TOP ${SCAN_CAP} * FROM c WHERE c.kind = "access-request"`,
    })
    .fetchAll();
  return resources || [];
}

/**
 * Move every access-request document into the `targetTenantId` partition.
 *
 * @param dryRun when true (the DEFAULT for the caller), nothing is written and
 *        `plan` enumerates precisely what a real run would move.
 */
export async function repartitionAccessRequests(
  c: RepartitionContainer,
  targetTenantId: string,
  opts: { dryRun?: boolean } = {},
): Promise<RepartitionResult> {
  const dryRun = opts.dryRun !== false;
  if (!targetTenantId) {
    // Refuse rather than guess — moving documents to an empty key would make
    // them MORE unreachable, not less.
    return {
      ok: false, dryRun, scanned: 0, needingMigration: 0, moved: 0, alreadyMigrated: 0,
      failed: [], plan: [], residual: null,
      message:
        'Refused: no target tenant id. The caller session carries no `tid` and no ' +
        'explicit target was supplied, so the correct destination partition could ' +
        'NOT be determined. Nothing was scanned or moved.',
    };
  }

  const all = await scanAll(c);
  const stale = all.filter((d) => d?.tenantId !== targetTenantId);
  const plan: RepartitionPlanRow[] = stale.map((d) => ({
    id: d.id,
    previousTenantId: d.tenantId,
    requesterId: d.requesterId,
    assetName: d.assetName,
    status: d.status,
  }));

  if (dryRun) {
    return {
      ok: true, dryRun: true,
      scanned: all.length,
      needingMigration: stale.length,
      moved: 0, alreadyMigrated: 0, failed: [], plan, residual: null,
      message:
        `Dry run: scanned ${all.length} access-request document(s); ` +
        `${stale.length} sit in a pre-fix (per-requester) partition and would be ` +
        `moved to the tenant partition ${tenantFingerprint(targetTenantId)}. ` +
        'Re-POST with {"confirm":true} to apply.',
    };
  }

  const now = new Date().toISOString();
  let moved = 0;
  let alreadyMigrated = 0;
  const failed: RepartitionResult['failed'] = [];

  for (const doc of stale) {
    const previousTenantId = doc.tenantId;
    try {
      // Resume-safe: a crash between write and delete leaves both copies.
      const { resource: existing } = await c.item(doc.id, targetTenantId).read<any>();
      if (existing) {
        alreadyMigrated++;
      } else {
        const next = {
          ...doc,
          tenantId: targetTenantId,
          _repartition: {
            previousTenantId,
            movedAt: now,
            toFingerprint: tenantFingerprint(targetTenantId),
          } satisfies RepartitionStamp,
        };
        await c.items.create(next);
        moved++;
      }
      // Only now is it safe to drop the source copy.
      await c.item(doc.id, previousTenantId).delete();
    } catch (e: any) {
      // Itemised, never swallowed: a document we could not move is a FAILURE,
      // not a skip, and it makes the whole run ok:false.
      failed.push({ id: doc.id, previousTenantId, error: e?.message || String(e) });
    }
  }

  // Independent verification — re-scan rather than trust the loop's counters.
  const residual = await verifyRepartition(c, targetTenantId);

  const ok = failed.length === 0 && residual === 0;
  return {
    ok, dryRun: false,
    scanned: all.length,
    needingMigration: stale.length,
    moved, alreadyMigrated, failed, plan: [],
    residual,
    message: ok
      ? `Moved ${moved} access-request document(s) into the tenant partition ` +
        `${tenantFingerprint(targetTenantId)}` +
        (alreadyMigrated ? ` (${alreadyMigrated} were already there from an earlier run)` : '') +
        '; an independent re-scan found 0 remaining in a pre-fix partition. ' +
        'Safe to run access-governance/backfill now.'
      : `INCOMPLETE. Moved ${moved}, already-migrated ${alreadyMigrated}, ` +
        `FAILED ${failed.length}; an independent re-scan still finds ${residual} ` +
        'document(s) in a pre-fix partition. The approval inbox will not show those ' +
        'requests. Do NOT run access-governance/backfill yet — re-run this migration ' +
        '(it is idempotent) and, if the same documents fail again, inspect the ' +
        'itemised errors below.',
  };
}

/**
 * Independent check: how many access-request documents are still NOT in the
 * target tenant partition? 0 means the container is fully migrated.
 */
export async function verifyRepartition(
  c: RepartitionContainer,
  targetTenantId: string,
): Promise<number> {
  const all = await scanAll(c);
  return all.filter((d) => d?.tenantId !== targetTenantId).length;
}
