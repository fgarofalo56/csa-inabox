/**
 * "THE PICTURE AND THE ANALYSIS CANNOT DISAGREE" — asserted, not promised.
 *
 * PRP §3.6 makes that claim about the visualizer. A doc-block cannot enforce
 * it. This suite does, and it checks BOTH halves of the property, because they
 * fail independently:
 *
 *   1. ONE PAYLOAD. Every node a finding names must exist in the same
 *      snapshot's node set, and every edge it cites must exist in the same
 *      edge set. This is what a second endpoint would break: two ARG pulls
 *      taken seconds apart, one canvas, one findings list, and no way to tell
 *      which was stale.
 *
 *   2. ONE PREDICATE. Sharing a payload is necessary and NOT sufficient. The
 *      canvas decides what to paint via `nodeVisual`; the recommendations list
 *      shows what `unreachableAlwaysOn` produced. Those are two functions, and
 *      they can disagree about the same data — which is exactly what happened
 *      while this was being built: the detector correctly skipped an
 *      externally-ingressed app and the canvas painted it red as unreachable.
 *      The test below would have caught it, and now guards it.
 */

import { describe, expect, it } from 'vitest';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { nodeVisual } from '@/app/admin/brain/model';
import { collection, estateRows } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());

describe('one payload — findings and the graph reference the same objects', () => {
  const nodeIds = new Set(snapshot.nodes.map((n) => n.id));
  const edgeIds = new Set(snapshot.edges.map((e) => e.id));

  it('the fixture produced findings at all (otherwise these checks are vacuous)', () => {
    // A coherence suite over ZERO findings passes every assertion below while
    // establishing nothing. This is the population check for the test itself.
    expect(snapshot.findings.length).toBeGreaterThan(0);
    expect(nodeIds.size).toBeGreaterThan(0);
  });

  it('every finding subject is a node the canvas draws', () => {
    for (const f of snapshot.findings) {
      for (const s of f.subjects) {
        expect(nodeIds.has(s), `finding ${f.id} names node ${s}, which is not in the snapshot`).toBe(
          true,
        );
      }
    }
  });

  it('every evidence node and edge exists in the same snapshot', () => {
    for (const f of snapshot.findings) {
      for (const n of f.evidence.nodes) {
        expect(nodeIds.has(n), `finding ${f.id} cites node ${n}, absent from the snapshot`).toBe(true);
      }
      for (const e of f.evidence.edges) {
        expect(edgeIds.has(e), `finding ${f.id} cites edge ${e}, absent from the snapshot`).toBe(true);
      }
    }
  });

  it('every resolved edge connects two nodes that exist', () => {
    for (const e of snapshot.edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      if (e.resolution === 'resolved') {
        expect(e.to).not.toBeNull();
        expect(nodeIds.has(e.to!)).toBe(true);
      }
    }
  });

  it('every DANGLING edge carries to: null — P2, on the wire', () => {
    const dangling = snapshot.edges.filter((e) => e.resolution === 'dangling');
    expect(dangling.length).toBeGreaterThan(0);
    for (const e of dangling) {
      expect(e.to).toBeNull();
      expect(e.danglingReason).toBeTruthy();
    }
  });
});

describe('one predicate — the canvas paints what the detector found', () => {
  const flagged = new Set(
    snapshot.findings
      .filter((f) => f.detector === 'unreachable-always-on')
      .flatMap((f) => f.subjects),
  );

  it('every node the canvas paints unreachable-always-on has a matching finding', () => {
    const painted = snapshot.nodes
      .filter((n) => nodeVisual(n, snapshot.coverage.configured.collected).state === 'unreachable-always-on')
      .map((n) => n.id);

    expect(painted.length, 'nothing painted — the check would be vacuous').toBeGreaterThan(0);
    for (const id of painted) {
      expect(
        flagged.has(id),
        `the canvas paints ${id} as unreachable+always-on but no finding names it — ` +
          'the picture and the analysis disagree',
      ).toBe(true);
    }
  });

  it('every node a finding flags is painted unreachable-always-on', () => {
    expect(flagged.size, 'no findings — the check would be vacuous').toBeGreaterThan(0);
    for (const id of flagged) {
      const node = snapshot.nodes.find((n) => n.id === id)!;
      const v = nodeVisual(node, snapshot.coverage.configured.collected);
      expect(
        v.state,
        `finding names ${id} but the canvas paints it '${v.state}' — the analysis and the picture disagree`,
      ).toBe('unreachable-always-on');
    }
  });

  it('the externally-ingressed app is painted as NOT EVALUABLE by both halves', () => {
    const ext = snapshot.nodes.find((n) => n.ingress?.external === true && n.unreachableConfigured);
    expect(ext, 'fixture has no externally-ingressed unreachable app').toBeDefined();
    const v = nodeVisual(ext!, snapshot.coverage.configured.collected);
    expect(v.state).toBe('reachability-not-evaluable');
    expect(v.error).toBe(false);
    expect(flagged.has(ext!.id)).toBe(false);
  });
});

describe('a snapshot with NO configured edges cannot paint anything unreachable', () => {
  // The vacuous-truth trap, at the rendering layer. Over a graph with zero
  // `configured` edges, `unreachableConfigured` is true of EVERY node — and
  // `Population.blind` does not fire, because the node set is not empty. A
  // canvas that painted from that flag alone would go entirely red.
  const bare = snapshotFromCollection(
    collection(
      estateRows().map((r) => ({
        ...r,
        properties: {
          ...(r.properties as Record<string, unknown>),
          template: {
            ...((r.properties as { template?: Record<string, unknown> }).template ?? {}),
            containers: [{ name: 'x', resources: { cpu: 0.5, memory: '1Gi' }, env: [] }],
          },
        },
      })),
    ),
  );

  it('the fixture really did produce zero configured edges', () => {
    expect(bare.edgesByProvenance.configured).toBe(0);
    // ...and the node set is NOT empty, which is why `blind` is the wrong signal.
    expect(bare.nodes.length).toBeGreaterThan(0);
  });

  it('nodes still report unreachableConfigured — the flag alone is not a verdict', () => {
    expect(bare.nodes.every((n) => n.unreachableConfigured)).toBe(true);
  });

  it('but coverage marks the provenance as collected-with-zero, so the UI can refuse it', () => {
    expect(bare.coverage.configured.collected).toBe(true);
    expect(bare.coverage.configured.edgeCount).toBe(0);
  });

  it('and the detector still discriminates rather than indicting the whole estate', () => {
    // The `configured` extractor RAN (so the provenance is collected) and simply
    // found nothing. The always-on + non-external filters still apply, so the
    // result is bounded rather than "every node".
    const flagged = bare.findings
      .filter((f) => f.detector === 'unreachable-always-on')
      .flatMap((f) => f.subjects);
    expect(flagged.length).toBeLessThan(bare.nodes.length);
  });
});
