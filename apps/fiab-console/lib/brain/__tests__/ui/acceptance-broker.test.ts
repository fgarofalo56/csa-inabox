/**
 * THE ACCEPTANCE TEST (PRP §5): `loom-capacity-broker` appears as an unreachable
 * always-on node WITH ITS EVIDENCE CHAIN.
 *
 * This drives the real pipeline — ARG rows -> extractors -> `buildGraph` ->
 * detectors -> the wire snapshot the visualizer renders. Nothing is stubbed
 * between the Resource Graph rows and the finding, so a regression anywhere in
 * that chain lands here.
 *
 * ── WHAT MAKES THIS TEST ABLE TO FAIL ──────────────────────────────────────
 * A suite that only asserts "the broker is unreachable" would pass identically
 * against `detector = () => allNodes`. So every claim below is paired with its
 * CONTROL: `loom-directlake` is wired by the line immediately above the broken
 * one in the same bicep block, and it must be absent from every unreachable
 * result. If the two ever agree, the detector has stopped discriminating and
 * these tests say so.
 *
 * The evidence assertions live in SEPARATE `it` blocks from the verdict
 * assertions, for the reason the substrate's own mutation run recorded: a
 * mutation that drops the empty-wire edge REMOVES THE RECEIPT AND LEAVES THE
 * VERDICT — the broker still has zero inbound configured edges, so a combined
 * test would stay green while the finding lost the thing that makes it
 * actionable.
 */

import { describe, expect, it } from 'vitest';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import {
  BROKER_ID,
  CONSOLE_ID,
  DIRECTLAKE_ID,
  MIGRATE_ID,
  ONELAKE_ID,
  UNITY_ID,
  collection,
  estateRows,
} from './estate-fixture';

const snapshot = snapshotFromCollection(collection(), { now: () => new Date('2026-08-23T00:00:00Z') });

const broker = snapshot.nodes.find((n) => n.id === BROKER_ID);
const control = snapshot.nodes.find((n) => n.id === DIRECTLAKE_ID);

describe('acceptance — the founding measured example', () => {
  it('the fixture actually produced both the subject and the control', () => {
    // A test whose subject is undefined passes every `?.` assertion below.
    expect(broker, 'loom-capacity-broker missing from the snapshot').toBeDefined();
    expect(control, 'loom-directlake (the control) missing from the snapshot').toBeDefined();
  });

  it('reports the broker as always-on with the scale that was measured', () => {
    expect(broker!.scaleMeasured).toBe(true);
    expect(broker!.alwaysOn).toBe(true);
    expect(broker!.scale?.minReplicas).toBe(2);
    expect(broker!.scale?.cpu).toBe(0.5);
    expect(broker!.scale?.memory).toBe('1Gi');
  });

  it('reports the broker as healthy and INTERNALLY addressable — the reason liveness misses it', () => {
    expect(broker!.provisioningState).toBe('Succeeded');
    expect(broker!.ingress?.external).toBe(false);
    expect(broker!.ingress?.fqdn).toBeTruthy();
  });

  it('reports ZERO inbound configured edges for the broker', () => {
    expect(broker!.inboundByProvenance.configured).toBe(0);
    expect(broker!.unreachableConfigured).toBe(true);
  });

  it('THE CONTROL: the wired service has an inbound configured edge and is NOT unreachable', () => {
    // Without this, "everything is unreachable" would satisfy the test above.
    expect(control!.inboundByProvenance.configured).toBeGreaterThan(0);
    expect(control!.unreachableConfigured).toBe(false);
  });

  it('produces an unreachable-always-on finding naming the broker and NOT the control', () => {
    const f = snapshot.findings.filter((x) => x.detector === 'unreachable-always-on');
    const subjects = f.flatMap((x) => x.subjects);
    expect(subjects).toContain(BROKER_ID);
    expect(subjects).not.toContain(DIRECTLAKE_ID);
  });

  it('does NOT indict an EXTERNALLY-ingressed app, and says why', () => {
    // Reachability over intra-estate wires establishes nothing about an app the
    // public internet can call. `loom-console` has external ingress and no
    // inbound configured edge — the naive query flags it, which is a false
    // positive by construction, and a rule that indicts the console is a rule
    // nobody will trust about anything else.
    const console_ = snapshot.nodes.find((n) => n.id === CONSOLE_ID)!;
    expect(console_.ingress?.external).toBe(true);
    expect(console_.unreachableConfigured).toBe(true);

    const subjects = snapshot.findings
      .filter((x) => x.detector === 'unreachable-always-on')
      .flatMap((x) => x.subjects);
    expect(subjects).not.toContain(CONSOLE_ID);

    // ...and it is SKIPPED WITH A REASON, not silently dropped.
    const run = snapshot.detectors.find((d) => d.detector === 'unreachable-always-on')!;
    const skipText = run.skipped.map((s) => `${s.subject} ${s.reason}`).join(' ');
    expect(skipText).toContain('EXTERNAL ingress');
    expect(skipText).toContain('Not evaluated');
  });
});

describe('acceptance — THE EVIDENCE CHAIN (asserted separately from the verdict)', () => {
  it('retains the empty wire that was MEANT to reach the broker', () => {
    const dangling = snapshot.edges.filter(
      (e) => e.resolution === 'dangling' && e.intendedTo === BROKER_ID,
    );
    expect(dangling.length).toBeGreaterThan(0);
    const e = dangling[0]!;
    expect(e.danglingReason).toBe('empty-value');
    expect(e.evidence.symbol).toBe('LOOM_BROKER_URL');
    // The receipt shows `''` — not a blank, not an absent field.
    expect(e.evidence.rawValue).toBe('');
    expect(e.from).toBe(CONSOLE_ID);
  });

  it('the dangling wire has to: null, so it CANNOT count as reachability', () => {
    const e = snapshot.edges.find(
      (x) => x.resolution === 'dangling' && x.intendedTo === BROKER_ID,
    );
    expect(e!.to).toBeNull();
    // Both facts at once: the wire exists AND the target is still unreachable.
    expect(broker!.danglingIntendedFor).toBeGreaterThan(0);
    expect(broker!.inboundByProvenance.configured).toBe(0);
  });

  it("the finding's evidence notes quote the wire and its empty value", () => {
    const f = snapshot.findings.find(
      (x) => x.detector === 'unreachable-always-on' && x.subjects.includes(BROKER_ID),
    );
    const joined = f!.evidence.notes.join('\n');
    expect(joined).toContain('LOOM_BROKER_URL');
    expect(joined).toContain('empty-value');
    expect(joined).toContain('minReplicas=2');
    // The point a liveness check misses, stated in the finding itself.
    expect(joined).toContain('Succeeded');
  });

  it('the finding cites a re-runnable query, not an assertion', () => {
    const f = snapshot.findings.find(
      (x) => x.detector === 'unreachable-always-on' && x.subjects.includes(BROKER_ID),
    );
    expect(f!.evidence.query).toContain('nodesWithNoInboundEdge');
    expect(f!.evidence.query).toContain("'configured'");
    expect(f!.evidence.edges.length).toBeGreaterThan(0);
  });
});

describe('acceptance — cost is DERIVED and labelled as such', () => {
  const f = snapshot.findings.find(
    (x) => x.detector === 'unreachable-always-on' && x.subjects.includes(BROKER_ID),
  );

  it('carries a derived figure, never a billed one', () => {
    expect(f!.cost).toBeDefined();
    expect(f!.cost!.source).toBe('derived');
  });

  it('renders through formatCostFigure so it cannot be read as a bill', () => {
    expect(f!.costLabel).toContain('DERIVED estimate');
    expect(f!.costLabel).toContain('not a bill');
  });

  it('prices 2 x 0.5 vCPU + 2 x 1GiB for 30 days at the IDLE meters', () => {
    // 30d = 2,592,000s. vCPU: 2*0.5*2592000*0.000003 = 7.776
    //                   mem:  2*1  *2592000*0.000003 = 15.552  => 23.33
    expect(f!.cost!.amountUsd).toBeCloseTo(23.33, 2);
  });

  it('the basis names the idle meter AND what the estimate excludes', () => {
    const b = f!.cost!.basis;
    expect(b).toContain('Idle');
    // The 8x overstatement this deliberately avoids is named in the basis.
    expect(b).toContain('8x');
    expect(b).toContain('free grant');
    expect(b).toContain('prices.azure.com');
  });
});

describe('the class, not the instance — a query finds every member', () => {
  it('finds a SECOND always-on unreachable service from the same shape', () => {
    const subjects = snapshot.findings
      .filter((f) => f.detector === 'unreachable-always-on')
      .flatMap((f) => f.subjects);
    // loom-onelake carries the identical `value: ''` shape in the fixture.
    expect(subjects).toContain(ONELAKE_ID);
  });

  it('does NOT flag an unreachable service that scales to zero as always-on', () => {
    const subjects = snapshot.findings
      .filter((f) => f.detector === 'unreachable-always-on')
      .flatMap((f) => f.subjects);
    // Unreachable, but minReplicas 0 — real, and not the same finding.
    expect(subjects).not.toContain(MIGRATE_ID);
    const migrate = snapshot.nodes.find((n) => n.id === MIGRATE_ID)!;
    expect(migrate.unreachableConfigured).toBe(true);
    expect(migrate.alwaysOn).toBe(false);
  });

  it('an UNMEASURED scale is neither cleared nor flagged as always-on', () => {
    const unity = snapshot.nodes.find((n) => n.id === UNITY_ID)!;
    expect(unity.scaleMeasured).toBe(false);
    // The critical non-claim: absent scale must NOT be reported as minReplicas 0.
    expect(unity.alwaysOn).toBe(false);
    expect(unity.scale).toBeUndefined();

    const subjects = snapshot.findings
      .filter((f) => f.detector === 'unreachable-always-on')
      .flatMap((f) => f.subjects);
    expect(subjects).not.toContain(UNITY_ID);

    // ...and the detector SAYS it could not evaluate it, rather than passing it.
    const run = snapshot.detectors.find((d) => d.detector === 'unreachable-always-on')!;
    const skipText = run.skipped.map((s) => `${s.subject} ${s.reason}`).join(' ');
    expect(skipText).toContain('NOT MEASURED');
  });

  it('inventories every empty wire separately from the unreachability verdict', () => {
    const wires = snapshot.findings.filter((f) => f.detector === 'dangling-empty-wire');
    expect(wires.length).toBeGreaterThanOrEqual(2);
    const symbols = wires.map((w) => w.title);
    expect(symbols.some((t) => t.includes('LOOM_BROKER_URL'))).toBe(true);
  });

  it('a secretRef value is INDETERMINATE — never counted as an empty wire', () => {
    // LOOM_TRINO_URL is a secretRef in the fixture. It must produce no edge at
    // all: "not readable" is not "empty", and conflating them invents a finding.
    const trinoEdges = snapshot.edges.filter((e) => e.evidence.symbol === 'LOOM_TRINO_URL');
    expect(trinoEdges).toHaveLength(0);
    expect(snapshot.collection.envEntriesSecretRef).toBeGreaterThan(0);
  });
});

describe('populations are reported, on every run', () => {
  it('every detector run carries the population it examined', () => {
    expect(snapshot.detectors.length).toBeGreaterThan(0);
    for (const d of snapshot.detectors) {
      expect(d.population.scope, `${d.detector} has no scope`).toBeTruthy();
      expect(typeof d.population.examined).toBe('number');
      expect(d.population.byProvenance).toBeDefined();
    }
  });

  it('the always-on detector reports how many apps had NO scale facts', () => {
    const run = snapshot.detectors.find((d) => d.detector === 'unreachable-always-on')!;
    expect(run.population.scope).toContain('NO scale facts');
    expect(run.population.scope).toContain('NOT MEASURED');
  });

  it('the collection reports what it read and whether it was complete', () => {
    expect(snapshot.collection.complete).toBe(true);
    expect(snapshot.collection.rowsFetched).toBe(estateRows().length);
    expect(snapshot.collection.subscriptionsSeen).toBe(2);
    expect(snapshot.collection.containerApps).toBeGreaterThan(0);
    expect(snapshot.collection.managedEnvironments).toBeGreaterThan(0);
  });
});
