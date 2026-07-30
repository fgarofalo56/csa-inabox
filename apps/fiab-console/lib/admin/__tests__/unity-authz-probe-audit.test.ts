/**
 * LU-2/LU-3 — the anonymous-read probe's AUDIT ROW must agree with the probe's
 * own verdict.
 *
 * The bug this locks: `outcome: denied ? … : 'success'` recorded a 404 / 500 /
 * 502 from the catalog as `success` — and on this row `success` means "the
 * catalog ANSWERED an anonymous read", i.e. it is OPEN. Meanwhile
 * probeLoomUnityAuthz itself correctly returns `warn` for that band ("neither an
 * authorization rejection nor an anonymous success, so the posture is
 * unverified"). A reviewer filtering the access pane would see a false
 * "anonymous read succeeded" alarm, or miss a real one.
 */
import { describe, it, expect } from 'vitest';
import { unityProbeAuditOutcome } from '../health-probes';

describe('unityProbeAuditOutcome', () => {
  it('records an authorization rejection as DENIED (probe verdict: pass)', () => {
    expect(unityProbeAuditOutcome(401)).toBe('denied');
    expect(unityProbeAuditOutcome(403)).toBe('denied');
  });

  it('records a genuine anonymous 2xx as SUCCESS — the catalog is open (probe verdict: fail)', () => {
    expect(unityProbeAuditOutcome(200)).toBe('success');
    expect(unityProbeAuditOutcome(204)).toBe('success');
  });

  it('does NOT record an unverified posture as an anonymous success (probe verdict: warn)', () => {
    for (const status of [0, 404, 429, 500, 502, 503]) {
      expect(unityProbeAuditOutcome(status)).toBe('failure');
    }
  });
});
