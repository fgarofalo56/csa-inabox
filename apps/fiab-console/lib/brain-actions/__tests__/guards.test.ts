/**
 * The guard chain, unit by unit (#4242).
 *
 * Every spec pairs a REFUSAL arm with the positive control one field away, so
 * each guard is proven to (a) fire on exactly its condition and (b) not fire
 * on the healthy fixture — a guard that refuses everything is as useless as
 * one that refuses nothing. The route-level suite (`perform-route.test.ts`)
 * additionally proves each guard is actually WIRED into the orchestrator:
 * deleting a guard call there turns that suite red even while this one stays
 * green.
 */

import { describe, expect, it } from 'vitest';
import {
  guardDetectorNotVacuous,
  guardEvidenceFresh,
  guardFindingPresent,
  guardOwnership,
  guardSnapshotComplete,
  guardWriteScope,
  resolvePerformSubject,
} from '../guards';
import type { PerformSubject } from '../types';
import {
  APP_NAME,
  brainSnapshot,
  collectionReport,
  detectorRun,
  ESTATE_ID,
  FINDING_ID,
  NODE_ID,
  population,
  RG,
  SUB,
  wireEdge,
  wireFinding,
  wireNode,
} from './fixtures';

const REQ = { findingId: FINDING_ID, detector: 'unreachable-always-on', subjectNodeId: NODE_ID };

function subject(overrides: Partial<PerformSubject> = {}): PerformSubject {
  return {
    nodeId: NODE_ID,
    displayName: APP_NAME,
    resourceType: 'Microsoft.App/containerApps',
    subscriptionId: SUB,
    resourceGroup: RG,
    armResourceId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${APP_NAME}`,
    minReplicasClaimed: 2,
    ...overrides,
  };
}

describe('guardSnapshotComplete — the #4015/#4016 partial-pull refusal', () => {
  it('passes on a complete collection (positive control)', () => {
    expect(guardSnapshotComplete(brainSnapshot())).toBeNull();
  });

  it('refuses an INCOMPLETE pull, showing the row counts', () => {
    const snap = brainSnapshot({
      collection: collectionReport({ complete: false, rowsFetched: 40, totalRecords: 90 }),
    });
    const refusal = guardSnapshotComplete(snap);
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('snapshot-complete');
    expect(refusal!.reason).toContain('INCOMPLETE');
    expect(refusal!.reason).toContain('rowsFetched=40');
    expect(refusal!.reason).toContain('90');
  });

  it('refuses when completeness is UNKNOWN (totalRecords null)', () => {
    const snap = brainSnapshot({
      collection: collectionReport({ complete: false, totalRecords: null }),
    });
    const refusal = guardSnapshotComplete(snap);
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('UNKNOWN');
  });
});

describe('guardFindingPresent — the fresh rebuild must still say so', () => {
  it('locates the finding and its subject node (positive control)', () => {
    const out = guardFindingPresent(brainSnapshot(), REQ);
    expect('refusal' in out).toBe(false);
    if (!('refusal' in out)) {
      expect(out.finding.id).toBe(FINDING_ID);
      expect(out.node.id).toBe(NODE_ID);
    }
  });

  it('refuses a finding the fresh rebuild no longer produces', () => {
    const out = guardFindingPresent(brainSnapshot({ findings: [] }), REQ);
    expect('refusal' in out).toBe(true);
    if ('refusal' in out) {
      expect(out.refusal.guard).toBe('finding-present');
      expect(out.refusal.reason).toContain('no longer produces');
    }
  });

  it('refuses a detector that does not match the finding', () => {
    const out = guardFindingPresent(brainSnapshot(), { ...REQ, detector: 'orphan' });
    expect('refusal' in out).toBe(true);
  });

  it('refuses a subject the finding does not name (no substituted targets)', () => {
    const out = guardFindingPresent(brainSnapshot(), {
      ...REQ,
      subjectNodeId: 'azure:/subscriptions/x/resourcegroups/y/providers/microsoft.app/containerapps/other',
    });
    expect('refusal' in out).toBe(true);
    if ('refusal' in out) expect(out.refusal.reason).toContain('not a subject');
  });

  it('refuses when the subject node is missing from the node set', () => {
    const out = guardFindingPresent(brainSnapshot({ nodes: [] }), REQ);
    expect('refusal' in out).toBe(true);
  });
});

describe('guardOwnership — re-checked from the fresh tag read', () => {
  it('passes a confirmed finding whose subject carries THIS estate (positive control)', () => {
    expect(guardOwnership(wireFinding(), wireNode(), ESTATE_ID)).toBeNull();
  });

  it('refuses when ownership is not established', () => {
    const refusal = guardOwnership(
      wireFinding({ ownershipConfirmed: false }),
      wireNode(),
      ESTATE_ID,
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('ownership-confirmed');
    expect(refusal!.reason).toContain('NOT established');
  });

  // ── #4258 item 4 — the PERMISSIVE-OWNERSHIP defect ──────────────────────
  //
  // `resource-graph.ts` states that a snapshot built with NO estate id counts
  // ANY non-empty `loom-estate-id` as owned, and forbids that mode for a
  // mutating caller. `perform.ts` was calling `loadSnapshot()` with none. The
  // shape below is exactly what that produced: a snapshot that marks ANOTHER
  // Loom estate's resource `ownershipConfirmed: true`. The guard must refuse
  // it on its own re-derivation, not inherit the snapshot's verdict.
  //
  // MUTATION CONTROL: delete the `tagged !== estateId` branch from
  // `../guards.ts` and this spec goes red (the refusal becomes null).
  it("refuses a subject tagged for a DIFFERENT estate even when the snapshot says confirmed", () => {
    const foreign = wireNode({
      tags: { 'loom-estate-id': 'someone-elses-loom' },
      ownership: 'observed',
      ownershipConfirmed: true, // what a permissively-built snapshot would say
    });
    const refusal = guardOwnership(wireFinding(), foreign, ESTATE_ID);
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('ownership-confirmed');
    expect(refusal!.reason).toContain('someone-elses-loom');
    expect(refusal!.reason).toContain('DIFFERENT Loom estate');
  });

  it('refuses a confirmed subject whose tag bag carries no estate value at all', () => {
    const refusal = guardOwnership(
      wireFinding(),
      wireNode({ tags: { CSA_Loom: 'true' }, ownership: 'observed' }),
      ESTATE_ID,
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('the tag is absent');
  });

  it('refuses a confirmed subject whose tags could NOT be read — indeterminate is not ownership', () => {
    const refusal = guardOwnership(
      wireFinding(),
      wireNode({ tags: null, ownership: 'indeterminate' }),
      ESTATE_ID,
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('could NOT be read at all');
  });
});

describe('guardDetectorNotVacuous — P3 at the moment of execution', () => {
  it('passes a real run with a non-blind population (positive control)', () => {
    expect(guardDetectorNotVacuous(brainSnapshot(), wireFinding())).toBeNull();
  });

  it('refuses when the snapshot has no run record for the detector', () => {
    const refusal = guardDetectorNotVacuous(brainSnapshot({ detectors: [] }), wireFinding());
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('detector-not-vacuous');
  });

  it('refuses a VACUOUS detector run', () => {
    const snap = brainSnapshot({
      detectors: [detectorRun({ vacuous: true, vacuousReason: 'provenance not collected' })],
    });
    const refusal = guardDetectorNotVacuous(snap, wireFinding());
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('VACUOUS');
  });

  it('refuses a BLIND population', () => {
    const refusal = guardDetectorNotVacuous(
      brainSnapshot(),
      wireFinding({ population: population({ blind: true, examined: 0 }) }),
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('population-not-blind');
  });

  it("refuses the vacuous-truth case: zero 'configured' edges in scope", () => {
    const refusal = guardDetectorNotVacuous(
      brainSnapshot({ edges: [] }),
      wireFinding({
        population: population({
          byProvenance: { declared: 0, configured: 0, imports: 0, observed: 0, owns: 2 },
        }),
      }),
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('vacuously true');
  });

  // ── #4258 item 3 — THE BYPASS THIS GUARD USED TO HAVE ───────────────────
  //
  // The check read `finding.population.byProvenance.configured`, and
  // `countByProvenance` (`lib/brain/graph/graph.ts`) tallies EVERY edge of a
  // provenance, DANGLING INCLUDED. A dangling edge resolved to no node, so it
  // contributes to no node's reachability — which means the exact degenerate
  // state this guard exists to catch ("every configured wire dangles, so every
  // app looks unreachable") had a NON-ZERO count and sailed through.
  //
  // MUTATION CONTROL: revert `../guards.ts` to read
  // `finding.population.byProvenance.configured` and this spec goes red — the
  // count is 3, the guard passes, and `refusal` is null where the spec demands
  // a refusal naming the dangling edges.
  it('refuses when every configured edge DANGLES, though byProvenance counts three', () => {
    const dangling = brainSnapshot({
      edges: [
        wireEdge({ id: 'd1', to: null, resolution: 'dangling', danglingReason: 'empty-value' }),
        wireEdge({ id: 'd2', to: null, resolution: 'dangling', danglingReason: 'empty-value' }),
        wireEdge({ id: 'd3', to: null, resolution: 'dangling', danglingReason: 'unresolved-target' }),
      ],
    });
    // The OLD signal is non-zero — this is what made the bypass invisible.
    expect(wireFinding().population.byProvenance.configured).toBe(3);

    const refusal = guardDetectorNotVacuous(dangling, wireFinding());
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('population-not-blind');
    expect(refusal!.reason).toContain('ZERO RESOLVED');
    expect(refusal!.reason).toContain('DANGLES');
  });

  it('POSITIVE CONTROL: a graph with real resolved configured edges passes', () => {
    // A guard that refuses everything is as useless as one that refuses
    // nothing. The default fixture carries three RESOLVED configured edges.
    expect(guardDetectorNotVacuous(brainSnapshot(), wireFinding())).toBeNull();
  });
});

describe('resolvePerformSubject — the ARM id is DERIVED, never accepted', () => {
  it('derives the resource id from server-held fields (positive control)', () => {
    const out = resolvePerformSubject(wireNode());
    expect('refusal' in out).toBe(false);
    if (!('refusal' in out)) {
      expect(out.subject.armResourceId).toBe(
        `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${APP_NAME}`,
      );
      expect(out.subject.minReplicasClaimed).toBe(2);
    }
  });

  it('refuses a non-Container-App subject', () => {
    const out = resolvePerformSubject(
      wireNode({ resourceType: 'Microsoft.Storage/storageAccounts' }),
    );
    expect('refusal' in out).toBe(true);
    if ('refusal' in out) expect(out.refusal.guard).toBe('subject-resolvable');
  });

  it('refuses a node with incomplete ARM coordinates', () => {
    const out = resolvePerformSubject(wireNode({ subscriptionId: undefined }));
    expect('refusal' in out).toBe(true);
    if ('refusal' in out) expect(out.refusal.reason).toContain('cannot be derived');
  });

  it('omits the claim when scale was NOT MEASURED (never invents zero)', () => {
    const out = resolvePerformSubject(wireNode({ scale: undefined, scaleMeasured: false }));
    expect('refusal' in out).toBe(false);
    if (!('refusal' in out)) expect(out.subject.minReplicasClaimed).toBeUndefined();
  });
});

describe('guardWriteScope — the credential acts only inside its own scope', () => {
  it('passes inside the configured subscription + RG, case-insensitively', () => {
    expect(
      guardWriteScope(subject(), { subscriptionId: SUB.toUpperCase(), resourceGroup: 'RG-LOOM' }),
    ).toBeNull();
  });

  it('refuses a subject in another subscription, naming both scopes', () => {
    const refusal = guardWriteScope(subject(), {
      subscriptionId: '00000000-0000-4000-8000-000000000002',
      resourceGroup: RG,
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('write-scope');
    expect(refusal!.reason).toContain(SUB);
    expect(refusal!.reason).toContain('00000000-0000-4000-8000-000000000002');
  });

  it('refuses a subject in another resource group', () => {
    expect(
      guardWriteScope(subject(), { subscriptionId: SUB, resourceGroup: 'rg-somebody-else' }),
    ).not.toBeNull();
  });
});

describe('guardEvidenceFresh — the authoritative ARM read must still agree', () => {
  it('passes when ARM matches the claim (positive control)', () => {
    expect(guardEvidenceFresh(subject(), { minReplicas: 2 }, 'scale-to-zero')).toBeNull();
  });

  it('refuses a STALE claim, showing both numbers', () => {
    const refusal = guardEvidenceFresh(subject(), { minReplicas: 1 }, 'scale-to-zero');
    expect(refusal).not.toBeNull();
    expect(refusal!.guard).toBe('evidence-fresh');
    expect(refusal!.reason).toContain('minReplicas=2');
    expect(refusal!.reason).toContain('minReplicas=1');
    expect(refusal!.reason).toContain('STALE');
  });

  it('refuses scale-to-zero when ARM reports no reading (NOT MEASURED ≠ 0)', () => {
    const refusal = guardEvidenceFresh(subject({ minReplicasClaimed: undefined }), {}, 'scale-to-zero');
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('NOT MEASURED');
  });

  it('refuses scale-to-zero when the app is ALREADY at zero', () => {
    const refusal = guardEvidenceFresh(
      subject({ minReplicasClaimed: undefined }),
      { minReplicas: 0 },
      'scale-to-zero',
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toContain('already has minReplicas 0');
  });

  it('delete-resource: a matching read passes; a drifted read refuses', () => {
    expect(guardEvidenceFresh(subject(), { minReplicas: 2 }, 'delete-resource')).toBeNull();
    expect(guardEvidenceFresh(subject(), { minReplicas: 3 }, 'delete-resource')).not.toBeNull();
  });
});
