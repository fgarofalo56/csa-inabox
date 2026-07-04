/**
 * Unit tests for the self-update COMPATIBILITY MANIFEST (rel-T41 / B15).
 *
 * These prove the honesty guarantee: an update to a release that NEWLY requires
 * an env var (or newer infra) the running deployment lacks is BLOCKED with the
 * exact remediation — the image-only roller can never silently step a tenant
 * into a half-configured state (no-vaporware.md). All inputs are injected
 * (synthetic manifest + envPresent), so the logic is proven without Azure.
 */
import { describe, it, expect } from 'vitest';
import {
  checkCompat,
  requirementsForUpdate,
  COMPAT_MANIFEST,
  type ReleaseCompat,
} from '../compat-manifest';

/** A synthetic manifest: 0.46.0 introduces a brand-new required env var. */
const MANIFEST: ReleaseCompat[] = [
  {
    version: '0.45.0',
    requiredEnv: [
      { name: 'LOOM_COSMOS_ACCOUNT', reason: 'metadata store', remediation: 're-deploy bicep' },
    ],
  },
  {
    version: '0.46.0',
    minInfraVersion: '0.46.0',
    requiredEnv: [
      { name: 'LOOM_NEW_THING', reason: 'a new backend the 0.46.0 code reads', remediation: 'set LOOM_NEW_THING via bicep re-deploy' },
    ],
  },
];

/** envPresent that treats a given set of names as present, everything else missing. */
function present(...names: string[]) {
  const set = new Set(names);
  return (name: string) => set.has(name);
}

describe('requirementsForUpdate', () => {
  it('aggregates requirements across (current, target], including skipped releases', () => {
    // 0.44.0 -> 0.46.0 skips over 0.45.0 but must still pick up its requirement.
    const entries = requirementsForUpdate('0.44.0', '0.46.0', MANIFEST);
    expect(entries.map((e) => e.version)).toEqual(['0.45.0', '0.46.0']);
  });

  it('excludes requirements at or below the current version', () => {
    const entries = requirementsForUpdate('0.45.0', '0.46.0', MANIFEST);
    expect(entries.map((e) => e.version)).toEqual(['0.46.0']);
  });

  it('is empty when nothing newer is required', () => {
    expect(requirementsForUpdate('0.46.0', '0.46.0', MANIFEST)).toEqual([]);
  });
});

describe('checkCompat', () => {
  it('BLOCKS when a newly-required env var is missing, naming it + the remediation', () => {
    const r = checkCompat(
      { envPresent: present('LOOM_COSMOS_ACCOUNT'), infraVersion: '0.46.0' },
      '0.45.0',
      '0.46.0',
      MANIFEST,
    );
    expect(r.ok).toBe(false);
    expect(r.missingEnv.map((e) => e.name)).toEqual(['LOOM_NEW_THING']);
    expect(r.missingEnv[0].remediation).toMatch(/bicep re-deploy/);
  });

  it('PASSES when every newly-required env var is present', () => {
    const r = checkCompat(
      { envPresent: present('LOOM_COSMOS_ACCOUNT', 'LOOM_NEW_THING'), infraVersion: '0.46.0' },
      '0.45.0',
      '0.46.0',
      MANIFEST,
    );
    expect(r.ok).toBe(true);
    expect(r.missingEnv).toEqual([]);
    expect(r.infraTooOld).toBeUndefined();
  });

  it('BLOCKS when the running infra version predates the required minimum', () => {
    const r = checkCompat(
      { envPresent: present('LOOM_COSMOS_ACCOUNT', 'LOOM_NEW_THING'), infraVersion: '0.45.0' },
      '0.45.0',
      '0.46.0',
      MANIFEST,
    );
    expect(r.ok).toBe(false);
    expect(r.infraTooOld).toEqual({ required: '0.46.0', actual: '0.45.0' });
  });

  it('does NOT enforce infra version when the running value is unknown (pre-LOOM_INFRA_VERSION)', () => {
    // env is satisfied; infraVersion '' means the deployment predates the stamp —
    // the env-var check carries it and we do not false-block.
    const r = checkCompat(
      { envPresent: present('LOOM_COSMOS_ACCOUNT', 'LOOM_NEW_THING'), infraVersion: '' },
      '0.45.0',
      '0.46.0',
      MANIFEST,
    );
    expect(r.ok).toBe(true);
    expect(r.infraTooOld).toBeUndefined();
  });

  it('dedupes an env required by more than one release in the range', () => {
    const dup: ReleaseCompat[] = [
      { version: '0.45.0', requiredEnv: [{ name: 'LOOM_X', reason: 'r', remediation: 'm' }] },
      { version: '0.46.0', requiredEnv: [{ name: 'LOOM_X', reason: 'r', remediation: 'm' }] },
    ];
    const r = checkCompat({ envPresent: present(), infraVersion: '' }, '0.44.0', '0.46.0', dup);
    expect(r.missingEnv.map((e) => e.name)).toEqual(['LOOM_X']);
  });
});

describe('the shipped COMPAT_MANIFEST', () => {
  it('never false-blocks a healthy, bicep-deployed tenant (its baseline env is present)', () => {
    // Every requiredEnv in the real manifest is emitted by platform bicep and
    // present in a real deploy — simulate that and expect a clean pass.
    const allNames = COMPAT_MANIFEST.flatMap((e) => (e.requiredEnv ?? []).map((x) => x.name));
    const r = checkCompat(
      { envPresent: present(...allNames), infraVersion: '9.9.9' },
      '0.0.0',
      '9.9.9',
    );
    expect(r.ok).toBe(true);
  });

  it('lists only hard-required env (no tuning knobs / opt-in backends)', () => {
    const names = COMPAT_MANIFEST.flatMap((e) => (e.requiredEnv ?? []).map((x) => x.name));
    for (const n of names) {
      // Requirements must not be feature toggles / backend selectors / caps —
      // those have code defaults and must never gate an update.
      expect(n).not.toMatch(/_ENABLED$|_BACKEND$|_CACHE$|_MAX_|_TTL/);
    }
  });
});
