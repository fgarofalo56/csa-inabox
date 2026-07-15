import { describe, it, expect } from 'vitest';
import {
  evaluateCertification, deriveCertificationState, resolveEndorsement,
  CERT_THRESHOLDS, type CertificationInputs,
} from '../certification';

const FULL: CertificationInputs = {
  ownerCount: 1,
  descriptionLength: 120,
  useCaseLength: 40,
  glossaryCount: 2,
  cdeCount: 0,
  assetCount: 3,
  dqScore: 88,
  sloCount: 2,
  hasContractSchema: true,
  accessConfigured: true,
  hasSampleData: true,
};

describe('evaluateCertification', () => {
  it('all checks pass → score 100, validated, certifiable', () => {
    const e = evaluateCertification(FULL);
    expect(e.score).toBe(100);
    expect(e.validated).toBe(true);
    expect(e.certifiable).toBe(true);
    expect(e.checks.every((c) => c.pass)).toBe(true);
  });

  it('validated needs the 5 core checks; certifiable needs ALL', () => {
    // Core checks pass, but DQ/SLO/access/sample fail → validated but not certifiable.
    const e = evaluateCertification({
      ...FULL, dqScore: null, sloCount: 0, accessConfigured: false, hasSampleData: false,
    });
    expect(e.validated).toBe(true);
    expect(e.certifiable).toBe(false);
    expect(e.checks.find((c) => c.id === 'dq')!.pass).toBe(false);
  });

  it('a missing owner drops validated', () => {
    const e = evaluateCertification({ ...FULL, ownerCount: 0 });
    expect(e.validated).toBe(false);
    expect(e.certifiable).toBe(false);
    expect(e.checks.find((c) => c.id === 'owner')!.detail).toMatch(/Add at least one owner/);
  });

  it('DQ below threshold fails the dq check with the exact bar', () => {
    const e = evaluateCertification({ ...FULL, dqScore: CERT_THRESHOLDS.dqScoreMin - 1 });
    const dq = e.checks.find((c) => c.id === 'dq')!;
    expect(dq.pass).toBe(false);
    expect(dq.detail).toMatch(new RegExp(`below the ${CERT_THRESHOLDS.dqScoreMin} bar`));
  });

  it('a null DQ score honest-gates rather than fabricating a pass', () => {
    const dq = evaluateCertification({ ...FULL, dqScore: null }).checks.find((c) => c.id === 'dq')!;
    expect(dq.pass).toBe(false);
    expect(dq.detail).toMatch(/No DQ score yet/);
  });
});

describe('deriveCertificationState', () => {
  it('certified only with a sign-off AND all checks passing', () => {
    const e = evaluateCertification(FULL);
    expect(deriveCertificationState(e, { state: 'certified', certifiedBy: { oid: 'r' } })).toBe('certified');
    // sign-off but no prior certified state → not certified
    expect(deriveCertificationState(e, { state: 'validated' })).toBe('validated');
  });

  it('downgrades a stale certified to validated when checks regress (continuously verified)', () => {
    const regressed = evaluateCertification({ ...FULL, dqScore: 10 }); // certifiable=false, still validated
    expect(deriveCertificationState(regressed, { state: 'certified', certifiedBy: { oid: 'r' } })).toBe('validated');
  });

  it('draft when not even validated', () => {
    const draft = evaluateCertification({ ...FULL, assetCount: 0 });
    expect(deriveCertificationState(draft)).toBe('draft');
  });
});

describe('resolveEndorsement — two-rung ladder', () => {
  it('certified outranks promoted', () => {
    expect(resolveEndorsement({ certificationState: 'certified', endorsed: true })).toBe('certified');
  });
  it('endorsed or legacy certified → promoted', () => {
    expect(resolveEndorsement({ endorsed: true })).toBe('promoted');
    expect(resolveEndorsement({ legacyCertified: true })).toBe('promoted');
  });
  it('nothing → none', () => {
    expect(resolveEndorsement({})).toBe('none');
  });
});
