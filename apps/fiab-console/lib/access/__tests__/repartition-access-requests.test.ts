/**
 * Repartition migration — behaviour tests against the partition-honest Cosmos
 * fake (so the point reads, the deletes and the partitioning are real, not
 * assumed).
 *
 * The properties under test are the ones the migration is REQUIRED to have:
 * idempotent, resume-safe, fail-closed, independently verified, and honest
 * about the difference between "nothing to do" and "could not determine".
 */
import { describe, it, expect } from 'vitest';

import {
  repartitionAccessRequests, verifyRepartition, tenantFingerprint,
  type RepartitionContainer,
} from '@/lib/access/repartition-access-requests';
import { makePartitionedContainer } from '@/app/api/access-requests/__tests__/partitioned-cosmos-fake';

const TENANT = 'tenant-1-tid';
const A = 'user-a-oid';
const B = 'user-b-oid';

/** A pre-fix document: partitioned by the REQUESTER's oid. */
function legacyDoc(id: string, requesterId: string, over: Record<string, any> = {}) {
  return {
    id,
    tenantId: requesterId, // the defect: partition key == requester oid
    kind: 'access-request',
    assetId: `asset-${id}`,
    assetName: `Asset ${id}`,
    requesterId,
    requesterUpn: `${requesterId}@contoso.com`,
    tier: 'manager',
    status: 'open',
    requestedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function container(seed: any[]) {
  return makePartitionedContainer({ partitionKeyPath: '/tenantId', seed }) as unknown as
    RepartitionContainer & { __all(): any[]; __partition(pk: string): any[] };
}

describe('repartitionAccessRequests', () => {
  it('dry run reports the plan and writes NOTHING', async () => {
    const c = container([legacyDoc('r1', A), legacyDoc('r2', B)]);
    const before = JSON.stringify(c.__all());

    const res = await repartitionAccessRequests(c, TENANT); // dryRun defaults true

    expect(res.dryRun).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.scanned).toBe(2);
    expect(res.needingMigration).toBe(2);
    expect(res.moved).toBe(0);
    expect(res.plan.map((p) => p.id).sort()).toEqual(['r1', 'r2']);
    expect(res.plan[0].previousTenantId).toBeTruthy();
    // Byte-for-byte unchanged.
    expect(JSON.stringify(c.__all())).toBe(before);
  });

  it('applies the move: documents land in the tenant partition and leave the old one', async () => {
    const c = container([legacyDoc('r1', A), legacyDoc('r2', B)]);

    const res = await repartitionAccessRequests(c, TENANT, { dryRun: false });

    expect(res.ok).toBe(true);
    expect(res.moved).toBe(2);
    expect(res.failed).toEqual([]);
    expect(res.residual).toBe(0);
    expect(c.__partition(TENANT)).toHaveLength(2);
    expect(c.__partition(A)).toHaveLength(0);
    expect(c.__partition(B)).toHaveLength(0);
    // Total count preserved — moved, not duplicated and not lost.
    expect(c.__all()).toHaveLength(2);
  });

  it('stamps each moved document so the move is auditable and reversible', async () => {
    const c = container([legacyDoc('r1', A)]);
    await repartitionAccessRequests(c, TENANT, { dryRun: false });

    const moved = c.__partition(TENANT)[0];
    expect(moved._repartition.previousTenantId).toBe(A);
    expect(moved._repartition.movedAt).toBeTruthy();
    expect(moved._repartition.toFingerprint).toBe(tenantFingerprint(TENANT));
    // The full tenant id is never embedded in the stamp's fingerprint.
    expect(moved._repartition.toFingerprint).not.toBe(TENANT);
    // Everything else survives untouched.
    expect(moved.requesterId).toBe(A);
    expect(moved.status).toBe('open');
    expect(moved.tier).toBe('manager');
  });

  it('is IDEMPOTENT — a second run moves nothing and stays ok', async () => {
    const c = container([legacyDoc('r1', A), legacyDoc('r2', B)]);
    await repartitionAccessRequests(c, TENANT, { dryRun: false });

    const second = await repartitionAccessRequests(c, TENANT, { dryRun: false });
    expect(second.ok).toBe(true);
    expect(second.scanned).toBe(2);
    expect(second.needingMigration).toBe(0);
    expect(second.moved).toBe(0);
    expect(second.residual).toBe(0);
    expect(c.__all()).toHaveLength(2);
  });

  it('RESUMES from a crash between the write and the delete (no duplicate, no loss)', async () => {
    // Simulate an interrupted run: the doc exists in BOTH partitions.
    const c = container([
      legacyDoc('r1', A),
      { ...legacyDoc('r1', A), tenantId: TENANT, _repartition: { previousTenantId: A, movedAt: 'x', toFingerprint: 'y' } },
    ]);
    expect(c.__all()).toHaveLength(2);

    const res = await repartitionAccessRequests(c, TENANT, { dryRun: false });

    expect(res.ok).toBe(true);
    expect(res.alreadyMigrated).toBe(1);
    expect(res.moved).toBe(0);
    expect(res.residual).toBe(0);
    // The orphan source copy is gone; exactly one survives.
    expect(c.__all()).toHaveLength(1);
    expect(c.__partition(TENANT)).toHaveLength(1);
    expect(c.__partition(A)).toHaveLength(0);
  });

  it('FAILS CLOSED — a document it cannot move is an itemised failure, never a silent skip', async () => {
    const c = container([legacyDoc('r1', A), legacyDoc('r2', B)]);
    const realDelete = c.item.bind(c);
    // r2's delete blows up midway through the run.
    (c as any).item = (id: string, pk?: string) => {
      const h = realDelete(id, pk);
      if (id === 'r2') {
        return { ...h, delete: async () => { throw new Error('simulated 429 throttle'); } };
      }
      return h;
    };

    const res = await repartitionAccessRequests(c, TENANT, { dryRun: false });

    expect(res.ok).toBe(false);                       // the RUN fails, not just the row
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe('r2');
    expect(res.failed[0].previousTenantId).toBe(B);
    expect(res.failed[0].error).toMatch(/throttle/);
    // And the message must not imply success.
    expect(res.message).toMatch(/INCOMPLETE/);
    expect(res.message).toMatch(/Do NOT run access-governance\/backfill yet/);
  });

  it('refuses without a target tenant rather than moving documents to an empty key', async () => {
    const c = container([legacyDoc('r1', A)]);
    const res = await repartitionAccessRequests(c, '', { dryRun: false });

    expect(res.ok).toBe(false);
    expect(res.scanned).toBe(0);
    expect(res.moved).toBe(0);
    expect(res.message).toMatch(/Refused/);
    expect(res.message).toMatch(/could NOT be determined/i);
    // Nothing touched.
    expect(c.__partition(A)).toHaveLength(1);
  });

  it('distinguishes an EMPTY container from a CLEAN one (scanned vs needingMigration)', async () => {
    const empty = await repartitionAccessRequests(container([]), TENANT);
    expect(empty.scanned).toBe(0);
    expect(empty.needingMigration).toBe(0);

    const clean = await repartitionAccessRequests(
      container([{ ...legacyDoc('r1', A), tenantId: TENANT }]),
      TENANT,
    );
    expect(clean.scanned).toBe(1);        // <- the discriminator
    expect(clean.needingMigration).toBe(0);
  });

  it('verifyRepartition is an INDEPENDENT re-scan, not a replay of the counters', async () => {
    const c = container([legacyDoc('r1', A), { ...legacyDoc('r2', B), tenantId: TENANT }]);
    expect(await verifyRepartition(c, TENANT)).toBe(1);
    await repartitionAccessRequests(c, TENANT, { dryRun: false });
    expect(await verifyRepartition(c, TENANT)).toBe(0);
  });

  it('leaves non-access-request documents in the container alone', async () => {
    const c = container([
      legacyDoc('r1', A),
      { id: 'other', tenantId: A, kind: 'something-else' },
    ]);
    const res = await repartitionAccessRequests(c, TENANT, { dryRun: false });
    expect(res.scanned).toBe(1);
    expect(res.moved).toBe(1);
    // The foreign doc is untouched in its original partition.
    expect(c.__partition(A)).toEqual([{ id: 'other', tenantId: A, kind: 'something-else' }]);
  });
});
