/**
 * The executor registry (#4242): what can be performed, what honestly cannot,
 * and — the property that matters most — what can NEVER be.
 *
 * Population discipline: the registry must have NO silent middle. Every entry
 * is either performable with a named executor, or carries an honest
 * not-performable reason. An entry that is neither would render as a dead
 * Perform button, which is the `no-vaporware.md` failure this registry exists
 * to prevent.
 */

import { describe, expect, it } from 'vitest';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { collection } from '@/lib/brain/__tests__/ui/estate-fixture';
import {
  performRegistryEntries,
  resolvePerformEntry,
  resolvePerformEntryForSubject,
  SECURITY_DETECTOR_PREFIX,
} from '../registry';
import type { ScaleToZeroRefusal } from '../scalability';

const SECURITY_IDS = [
  'security.c1.unauthorized-inbound-edge',
  'security.c2.aggregate-oracle',
  'security.c3.discarded-verdict',
  'security.c4.unbounded-publication',
  'security.c5.fail-open',
  'security.c6.credential-unbounded-sink',
  'security.c7.synthesized-principal',
  'security.c8.human-executed-command',
  'security.c9.duplicated-decision',
];

describe('security detectors are NEVER performable', () => {
  it('every c1–c9 id resolves to a refusal with the taxonomy reason', () => {
    // POPULATION: all nine, not a sample.
    expect(SECURITY_IDS.length).toBe(9);
    for (const id of SECURITY_IDS) {
      const entry = resolvePerformEntry(id);
      expect(entry.performable, id).toBe(false);
      expect(entry.executor, id).toBeUndefined();
      expect(entry.notPerformableReason, id).toContain('NEVER performable');
    }
  });

  it('matches the SHAPE, not a spelling list: an unseen security id refuses too', () => {
    // A c10 added next month must be never-performable ON ARRIVAL. Keying the
    // guard to an enumeration of the nine known ids is the layer-keyed failure
    // this repo has measured repeatedly.
    const entry = resolvePerformEntry(`${SECURITY_DETECTOR_PREFIX}c10.brand-new-class`);
    expect(entry.performable).toBe(false);
    expect(entry.notPerformableReason).toContain('NEVER performable');
  });
});

describe('the performable classes', () => {
  it.each([
    ['unreachable-always-on', 'scale-to-zero'],
    ['unreachable-service', 'scale-to-zero'],
    ['always-on-unused', 'scale-to-zero'],
    ['orphan', 'delete-resource'],
  ] as const)('%s → %s, destructive (staged confirm required)', (detector, executor) => {
    const entry = resolvePerformEntry(detector);
    expect(entry.performable).toBe(true);
    expect(entry.executor).toBe(executor);
    // Destructive drives the two-step staged confirm in the orchestrator; a
    // performable entry without it would one-click a deletion.
    expect(entry.destructive).toBe(true);
  });
});

describe('the honestly-not-performable classes', () => {
  it.each([
    'dangling-empty-wire',
    'dangling-wire',
    'config-drift',
    'declared-not-configured',
    'declared-but-dead',
  ])('%s refuses with the repo-edit reason', (detector) => {
    const entry = resolvePerformEntry(detector);
    expect(entry.performable).toBe(false);
    expect(entry.executor).toBeUndefined();
    // The reason must say WHY the platform cannot act — the fix lives in the
    // repository — not merely that it will not.
    expect(entry.notPerformableReason).toContain('REPOSITORY EDIT');
  });

  it('reachable-not-observed refuses as a weak signal, not a repo edit', () => {
    const entry = resolvePerformEntry('reachable-not-observed');
    expect(entry.performable).toBe(false);
    expect(entry.notPerformableReason).toContain('WEAK signal');
  });
});

describe('unknown detector kinds', () => {
  it('refuses with an honest reason instead of guessing an executor', () => {
    const entry = resolvePerformEntry('made-up-detector');
    expect(entry.performable).toBe(false);
    expect(entry.notPerformableReason).toContain('No executor is registered');
  });
});

describe('#4257 — performability is per SUBJECT, not only per class', () => {
  const pinned: ScaleToZeroRefusal = {
    kind: 'pinned-singleton',
    declaration: {
      appName: 'loom-risingwave',
      module: 'loom-risingwave',
      scalableToZero: false,
      declared: { minReplicas: 1, maxReplicas: 1, hasScaleRules: false },
      declaredConsumers: [],
      reason: "the deploy PINS 'loom-risingwave' to exactly 1 replica(s).",
      declaredStatement: 'CANNOT scale to zero: a stopped replica loses every materialized view',
    },
  };

  it.each(['unreachable-always-on', 'unreachable-service', 'always-on-unused'])(
    '%s stops offering scale-to-zero for a declared non-scalable subject',
    (detector) => {
      // The class is performable and stays right about the class; the SUBJECT
      // downgrades it. Before this existed, `loom-risingwave` was the
      // highest-value performable finding on the live list.
      expect(resolvePerformEntry(detector).performable).toBe(true);
      const entry = resolvePerformEntryForSubject(detector, 'loom-risingwave', pinned);
      expect(entry.performable).toBe(false);
      expect(entry.executor).toBeUndefined();
      expect(entry.notPerformableReason).toContain('CANNOT be scaled to zero');
      expect(entry.notPerformableReason).toMatch(/materialized view/i);
      // Reported, not hidden — #4257 asks for a report-only observation.
      expect(entry.notPerformableReason).toContain('stays REPORTED');
    },
  );

  it('THE CONTROL: an ELASTIC subject with no declared consumer keeps its executor', () => {
    const entry = resolvePerformEntryForSubject('unreachable-always-on', 'loom-duckdb', null);
    expect(entry.performable).toBe(true);
    expect(entry.executor).toBe('scale-to-zero');
  });

  it('a subject with no declaration keeps its executor', () => {
    const entry = resolvePerformEntryForSubject(
      'unreachable-always-on',
      'loom-capacity-broker',
      null,
    );
    expect(entry.performable).toBe(true);
    expect(entry.executor).toBe('scale-to-zero');
  });

  it('the downgrade is scoped to scale-to-zero — orphan/delete is untouched', () => {
    const entry = resolvePerformEntryForSubject('orphan', 'loom-risingwave', pinned);
    expect(entry.performable).toBe(true);
    expect(entry.executor).toBe('delete-resource');
  });

  it('a class that is already not performable keeps ITS reason, not this one', () => {
    const entry = resolvePerformEntryForSubject('dangling-empty-wire', 'loom-risingwave', pinned);
    expect(entry.performable).toBe(false);
    expect(entry.notPerformableReason).toContain('REPOSITORY EDIT');
  });

  it('DERIVED, not injected: the default lookup refuses risingwave from the real template', () => {
    // No refusal argument — this is the production call path, reading the
    // committed compiled ARM. A resolver wired only to the test double would
    // pass every spec above and protect nothing.
    const entry = resolvePerformEntryForSubject('unreachable-always-on', 'loom-risingwave');
    expect(entry.performable).toBe(false);
  });

  it('DERIVED: loom-unity is refused too — ELASTIC, but the deploy wires it', () => {
    // The #4261 review hole. Its replica shape clears the pinned predicate, so
    // this can only come from the declared-consumer signal.
    const entry = resolvePerformEntryForSubject('unreachable-always-on', 'loom-unity');
    expect(entry.performable).toBe(false);
    expect(entry.notPerformableReason).toContain('AVAILABILITY refusal');
  });

  it('DERIVED CONTROL: an app the deploy wires nothing to stays performable', () => {
    // `loom-capacity-broker`'s only wire is `LOOM_BROKER_URL: ''` — an empty
    // value that names nothing — so it has no declared consumer and remains
    // the founding acceptance case.
    const entry = resolvePerformEntryForSubject('unreachable-always-on', 'loom-capacity-broker');
    expect(entry.performable).toBe(true);
    expect(entry.executor).toBe('scale-to-zero');
  });
});

describe('registry population — no silent middle', () => {
  it('every entry is performable-with-executor XOR honestly refused', () => {
    const entries = performRegistryEntries();
    // POPULATION: the four runtime detectors + the library kinds must all be
    // present; a scan over two entries would be green and blind.
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const e of entries) {
      if (e.performable) {
        expect(e.executor, e.detector).toBeDefined();
        expect(e.destructive, e.detector).toBe(true);
      } else {
        expect(e.executor, e.detector).toBeUndefined();
        expect((e.notPerformableReason ?? '').length, e.detector).toBeGreaterThan(40);
      }
    }
  });

  it('covers every detector kind the runtime surface mints — DERIVED, not enumerated', () => {
    // #4246 review nit: a hand-typed list watches only the detectors its
    // author remembered. Run the REAL runtime pipeline over the estate
    // fixture instead — `snapshot.detectors` carries one run record per
    // registered detector, so a detector added to detect.ts appears here
    // automatically and fails this spec until it gets a registry entry
    // (a real executor or an honest not-performable reason).
    const runtime = snapshotFromCollection(collection()).detectors.map((d) => d.detector);
    // POPULATION: the pipeline currently registers four; fewer means the
    // derivation broke, not that the registry is fine.
    expect(runtime.length).toBeGreaterThanOrEqual(4);
    const registered = new Set(performRegistryEntries().map((e) => e.detector));
    for (const d of runtime) expect(registered.has(d), d).toBe(true);
  });
});
