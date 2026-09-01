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
import {
  performRegistryEntries,
  resolvePerformEntry,
  SECURITY_DETECTOR_PREFIX,
} from '../registry';

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

  it('covers every detector kind the runtime surface mints', () => {
    // The four detectors app/api/admin/brain/_lib/detect.ts registers. A new
    // runtime detector must land with a registry entry (real executor or
    // honest reason) — resolvePerformEntry falls back to "no executor is
    // registered" for strays, and this spec is what notices the stray.
    const runtime = [
      'unreachable-always-on',
      'dangling-empty-wire',
      'declared-not-configured',
      'reachable-not-observed',
    ];
    const registered = new Set(performRegistryEntries().map((e) => e.detector));
    for (const d of runtime) expect(registered.has(d), d).toBe(true);
  });
});
