/**
 * #3905 — the demo-deploy state vocabulary and its rollup.
 *
 * The defect these lock down: a sub-install was marked `done` on jobId RECEIPT
 * and rolled up to `done / 100%`, so the product reported "14/14 apps installed"
 * over apps that had not begun provisioning. The rollup is the one place that
 * decides what "installed" may mean, so it is asserted state by state, including
 * the state that has no good answer — `unknown`, which must NEVER become
 * success and must never be silently dropped from the counts.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeDemoSubJobs, mapTerminalInstallStatus, isResolved,
  DEMO_SUB_STATUS_LABEL, type DemoSubJob, type DemoSubStatus,
} from '../demo-deploy-status';

const sub = (status: DemoSubStatus, i = 0): DemoSubJob => ({
  appId: `app-${status}-${i}`, wsLabel: `Demo — ${status} ${i}`, status,
});
const many = (status: DemoSubStatus, n: number): DemoSubJob[] =>
  Array.from({ length: n }, (_, i) => sub(status, i));

describe('mapTerminalInstallStatus — only a TERMINAL job resolves an entry', () => {
  it('maps each terminal install-job status onto its demo state', () => {
    expect(mapTerminalInstallStatus('done')).toBe('succeeded');
    expect(mapTerminalInstallStatus('partial')).toBe('partial');
    expect(mapTerminalInstallStatus('failed')).toBe('failed');
  });

  it('refuses to resolve a non-terminal (or unrecognised) job status', () => {
    expect(mapTerminalInstallStatus('running')).toBeNull();
    expect(mapTerminalInstallStatus(undefined)).toBeNull();
    expect(mapTerminalInstallStatus('accepted' as any)).toBeNull();
    expect(mapTerminalInstallStatus('' as any)).toBeNull();
  });
});

describe('isResolved', () => {
  it('treats only settled states as resolved — accepted is NOT settled', () => {
    expect(isResolved('succeeded')).toBe(true);
    expect(isResolved('partial')).toBe(true);
    expect(isResolved('failed')).toBe(true);
    expect(isResolved('unknown')).toBe(true);
    expect(isResolved('pending')).toBe(false);
    expect(isResolved('accepted')).toBe(false);
    expect(isResolved('installing')).toBe(false);
  });
});

describe('summarizeDemoSubJobs — every terminal state', () => {
  it('all 14 succeeded → done, 14/14, and the ONLY headline allowed to say so', () => {
    const r = summarizeDemoSubJobs(many('succeeded', 14));
    expect(r.status).toBe('done');
    expect(r.succeeded).toBe(14);
    expect(r.allSucceeded).toBe(true);
    expect(r.percentComplete).toBe(100);
    expect(r.headline).toBe('14/14 apps installed');
  });

  it('all failed → failed, and never claims an install', () => {
    const r = summarizeDemoSubJobs(many('failed', 14));
    expect(r.status).toBe('failed');
    expect(r.succeeded).toBe(0);
    expect(r.allSucceeded).toBe(false);
    expect(r.headline).toBe('0/14 installed · 14 failed');
  });

  it('all partial → partial (installed WITH GATES is not installed)', () => {
    const r = summarizeDemoSubJobs(many('partial', 14));
    expect(r.status).toBe('partial');
    expect(r.succeeded).toBe(0);
    expect(r.allSucceeded).toBe(false);
    expect(r.headline).toContain('14 installed with gates');
    expect(r.headline).not.toBe('14/14 apps installed');
  });

  it('REGRESSION — all 14 stuck at `accepted` is RUNNING, never done', () => {
    const r = summarizeDemoSubJobs(many('accepted', 14));
    expect(r.status).toBe('running');
    expect(r.succeeded).toBe(0);
    expect(r.allSucceeded).toBe(false);
    expect(r.percentComplete).toBe(0);
    expect(r.headline).toBe('0/14 installed · 14 accepted, not started');
  });

  it('REGRESSION — all 14 `unknown` is PARTIAL, never done, and unknown is COUNTED', () => {
    const r = summarizeDemoSubJobs(many('unknown', 14));
    expect(r.status).toBe('partial');
    expect(r.unknown).toBe(14);
    expect(r.succeeded).toBe(0);
    expect(r.allSucceeded).toBe(false);
    expect(r.headline).toBe('0/14 installed · 14 unconfirmed');
  });

  it('ONE unknown among 13 succeeded still cannot be done', () => {
    const r = summarizeDemoSubJobs([...many('succeeded', 13), sub('unknown')]);
    expect(r.status).toBe('partial');
    expect(r.allSucceeded).toBe(false);
    expect(r.succeeded).toBe(13);
    expect(r.headline).toBe('13/14 installed · 1 unconfirmed');
  });

  it('mixed run reports the REAL counts, one term per outcome', () => {
    const r = summarizeDemoSubJobs([
      ...many('succeeded', 6), ...many('partial', 2), ...many('failed', 3), ...many('unknown', 3),
    ]);
    expect(r).toMatchObject({
      total: 14, succeeded: 6, partial: 2, failed: 3, unknown: 3,
      resolved: 14, status: 'partial', allSucceeded: false, percentComplete: 100,
    });
    expect(r.headline).toBe('6/14 installed · 2 installed with gates · 3 failed · 3 unconfirmed');
  });

  it('still RUNNING while any entry is in flight, even if the rest succeeded', () => {
    const r = summarizeDemoSubJobs([...many('succeeded', 13), sub('installing')]);
    expect(r.status).toBe('running');
    expect(r.percentComplete).toBe(93); // 13/14 resolved
    expect(r.headline).toBe('13/14 installed · 1 installing');
  });

  it('a VACUOUS run (no sub-jobs) is failed, not done', () => {
    for (const empty of [[], undefined, null]) {
      const r = summarizeDemoSubJobs(empty as any);
      expect(r.status).toBe('failed');
      expect(r.allSucceeded).toBe(false);
      expect(r.headline).toBe('No installs were dispatched');
    }
  });

  it('every state has a label, and no label reads as plain success', () => {
    const states: DemoSubStatus[] = ['pending', 'accepted', 'installing', 'succeeded', 'partial', 'failed', 'unknown'];
    for (const st of states) expect(DEMO_SUB_STATUS_LABEL[st]).toBeTruthy();
    expect(DEMO_SUB_STATUS_LABEL.succeeded).toBe('Installed');
    for (const st of states.filter((x) => x !== 'succeeded')) {
      expect(DEMO_SUB_STATUS_LABEL[st]).not.toBe('Installed');
    }
  });
});
