/**
 * THE BASELINE SPEC — the subject the mutation arms break.
 *
 * `cleanBaseline()` models a graph in which every node of every kind is clean.
 * This file asserts the sweep over it is EMPTY — no security findings AND no
 * population-integrity findings.
 *
 * `mutation/run-arm.mjs` injects one defect into `fixtures/corpus.ts`, runs THIS
 * FILE, and requires it to go RED; then restores and requires it GREEN. Both RCs
 * are reported. That is the mutation discipline applied literally: break the
 * subject, prove the assertion that the subject is clean now fails.
 *
 * ── WHY BOTH HALVES OF "EMPTY" MATTER ────────────────────────────────────
 *
 * Zero SECURITY findings proves the detectors do not cry wolf on a clean graph —
 * without it, the mutation arms are worthless, because a detector that fires on
 * everything "catches" every mutation.
 *
 * Zero POPULATION findings proves the baseline still covers every class. If a
 * node kind is dropped from the baseline, its detector reports candidates === 0,
 * `detectorResult()` synthesises a `POP-population-integrity` finding, and this
 * spec fails. A baseline that quietly stops covering a class therefore cannot go
 * unnoticed — which is the failure mode the whole taxonomy §11.5 is about,
 * applied to the fixtures themselves.
 */

import { describe, expect, it } from 'vitest';
import {
  runSecuritySweep,
  SECURITY_DETECTORS,
} from '@/lib/brain/security';
import { cleanBaseline } from './fixtures/corpus';

describe('loom brain security — clean baseline', () => {
  it('produces ZERO findings of ANY class over the clean baseline', () => {
    const sweep = runSecuritySweep(cleanBaseline());
    // Render the titles on failure so a red mutation arm says WHICH detector fired.
    expect(sweep.findings.map((f) => `${f.findingClass}: ${f.title}`)).toEqual([]);
  });

  it('covers every node kind, so no detector reports an empty population', () => {
    const sweep = runSecuritySweep(cleanBaseline());
    const empties = sweep.findings.filter((f) => f.id.endsWith(':population:empty'));
    expect(empties.map((f) => f.detectorId)).toEqual([]);
  });

  it('judges every candidate it enumerates — ratio is exactly 1', () => {
    const sweep = runSecuritySweep(cleanBaseline());
    expect(sweep.coverage.incompleteDetectors).toEqual([]);
    expect(sweep.coverage.ratio).toBe(1);
    // A non-zero candidate count is part of the claim: ratio 1 over 0 candidates
    // would be vacuous, and `populationCoverage` returns 0 for that case
    // precisely so it cannot be mistaken for full coverage.
    expect(sweep.coverage.candidates).toBeGreaterThan(0);
  });

  it('runs every registered detector against the baseline', () => {
    const sweep = runSecuritySweep(cleanBaseline());
    expect(sweep.perDetector.map((d) => d.detectorId).sort()).toEqual(
      SECURITY_DETECTORS.map((d) => d.id).sort(),
    );
  });
});
