/**
 * summarizePausedSnapshot - the model behind the shell banner. Each `it` names
 * the input that breaks it.
 */
import { describe, it, expect } from 'vitest';
import { summarizePausedSnapshot } from '../estate-paused-banner';
import { countsAsHumanActivity } from '../estate-activity';
import type { EstatePauseSnapshot, PausedResourceSnapshot } from '../pause-state';

const entry = (name: string, pre: PausedResourceSnapshot['prePausePowerState'] = 'Online'): PausedResourceSnapshot => ({
  resourceId: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/${name}`,
  resourceType: 'microsoft.app/containerapps', name, resourceGroup: 'rg', subscriptionId: 's',
  prePausePowerState: pre, powerStateSource: 'arm', powerStateReadAt: 'T', powerStateApiVersion: 'x',
  ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
});

const snap = (over: Partial<EstatePauseSnapshot> = {}): EstatePauseSnapshot => ({
  id: 'snap', tenantId: 't', schemaVersion: 1, estateId: 'e', state: 'PAUSED',
  resources: [entry('loom-udf-runtime'), entry('loom-dab-preview'), entry('loom-transform-runner')],
  createdAt: '2026-10-22T01:00:00.000Z', updatedAt: '2026-10-22T01:05:00.000Z',
  createdBy: 'sp:app-123', pausedAt: '2026-10-22T01:04:00.000Z',
  ...over,
});

describe('hidden when nothing is paused', () => {
  // Breaks if: a null snapshot (fresh / never-paused estate) renders a banner.
  it('no snapshot -> not paused', () => {
    expect(summarizePausedSnapshot(null, { isAdmin: true })).toEqual({ paused: false });
  });

  // Breaks if: RUNNING (the post-resume state) is treated as paused.
  it('RUNNING -> not paused, even with a full resource list in the snapshot', () => {
    expect(summarizePausedSnapshot(snap({ state: 'RUNNING' }), { isAdmin: true })).toEqual({ paused: false });
  });

  // Breaks if: entries that were ALREADY stopped before the pause are counted as "paused by Loom".
  it('a snapshot in which Loom stopped nothing (all entries pre-stopped) -> not paused', () => {
    const s = snap({ resources: [entry('a', 'Paused'), entry('b', 'Stopped'), entry('c', 'Deallocated')] });
    expect(summarizePausedSnapshot(s, { isAdmin: true })).toEqual({ paused: false });
  });
});

describe('shown with the correct count', () => {
  // Breaks if: count is resources.length (4) instead of the number Loom stopped (3).
  it('counts only services Loom stopped; pre-stopped ones are excluded from count AND names', () => {
    const s = snap({ resources: [entry('loom-udf-runtime'), entry('loom-dab-preview'), entry('loom-transform-runner'), entry('old', 'Paused')] });
    const m = summarizePausedSnapshot(s, { isAdmin: true });
    expect(m).toMatchObject({ paused: true, state: 'PAUSED', count: 3 });
    expect((m as { names: string[] }).names).toEqual(['loom-udf-runtime', 'loom-dab-preview', 'loom-transform-runner']);
  });

  // Breaks if: PAUSING / RESUMING / RESUME_FAILED stop being surfaced (the banner would vanish mid-transition).
  it.each(['PAUSING', 'PAUSED', 'RESUMING', 'RESUME_FAILED'] as const)('%s is shown', (state) => {
    expect(summarizePausedSnapshot(snap({ state }), { isAdmin: true })).toMatchObject({ paused: true, state, count: 3 });
  });

  // Breaks if: pausedAt is dropped (the banner could not say WHEN).
  it('carries when it was paused; falls back to createdAt while still PAUSING', () => {
    expect(summarizePausedSnapshot(snap(), { isAdmin: true })).toMatchObject({ pausedAt: '2026-10-22T01:04:00.000Z' });
    const pausing = snap({ state: 'PAUSING', pausedAt: undefined });
    expect(summarizePausedSnapshot(pausing, { isAdmin: true })).toMatchObject({ pausedAt: '2026-10-22T01:00:00.000Z' });
  });
});

describe('apps whose pause FAILED are not counted as stopped (review N4)', () => {
  const failedEntry = (name: string) => ({ ...entry(name), pauseFailed: 'ARM 409' });

  // Breaks if: count = resources not pre-stopped (ignores pauseFailed): 3 would show instead of 2.
  it('count and names exclude the rejected app, which is listed separately in failedToPause', () => {
    const s = snap({ state: 'PAUSING', resources: [entry('loom-udf-runtime'), failedEntry('loom-dab-preview'), entry('loom-transform-runner')] });
    const m = summarizePausedSnapshot(s, { isAdmin: true }) as { count: number; names: string[]; failedToPause: string[] };
    expect(m.count).toBe(2);
    expect(m.names).toEqual(['loom-udf-runtime', 'loom-transform-runner']);
    expect(m.failedToPause).toEqual(['loom-dab-preview']);
  });

  // Breaks if: an all-rejected snapshot is hidden (the operator would never learn the pause failed) or counted as paused.
  it('only failures: still shown, with count 0 and the failures named', () => {
    const m = summarizePausedSnapshot(snap({ state: 'PAUSING', resources: [failedEntry('a'), failedEntry('b')] }), { isAdmin: false });
    expect(m).toMatchObject({ paused: true, count: 0, failedToPause: ['a', 'b'] });
  });

  // Breaks if: pre-stopped entries that also carry a marker are reported as failures.
  it('an already-stopped entry is neither counted nor reported failed', () => {
    const m = summarizePausedSnapshot(snap({ resources: [entry('x'), { ...entry('old', 'Paused'), pauseFailed: 'n/a' }] }), { isAdmin: true });
    expect(m).toMatchObject({ count: 1, failedToPause: [] });
  });
});

describe('who paused: identity to admins, kind to everyone', () => {
  // Breaks if: an administrator's UPN is published to non-admins.
  it('non-admin gets pausedBy:null; admin gets the identity', () => {
    const s = snap({ createdBy: 'admin@contoso.com' });
    expect(summarizePausedSnapshot(s, { isAdmin: false })).toMatchObject({ pausedBy: null, pausedByKind: 'person' });
    expect(summarizePausedSnapshot(s, { isAdmin: true })).toMatchObject({ pausedBy: 'admin@contoso.com', pausedByKind: 'person' });
  });

  // Breaks if: a service principal is described as a person (or the reverse).
  it('"sp:" identities are automation; a missing createdBy is unknown', () => {
    expect(summarizePausedSnapshot(snap({ createdBy: 'sp:abc' }), { isAdmin: false })).toMatchObject({ pausedByKind: 'automation' });
    expect(summarizePausedSnapshot(snap({ createdBy: undefined }), { isAdmin: true })).toMatchObject({ pausedBy: null, pausedByKind: 'unknown' });
  });
});

describe('RESUME_FAILED is honest', () => {
  // Breaks if: the failure text is generic when the snapshot names the unconfirmed services.
  it('names the services whose resume outcome is unconfirmed, by NAME not by ARM id', () => {
    const s = snap({
      state: 'RESUME_FAILED',
      resumeOutcomes: [
        { resourceId: entry('loom-udf-runtime').resourceId, confirmation: 'confirmed-running', reason: 'ok' },
        { resourceId: entry('loom-dab-preview').resourceId, confirmation: 'unknown', reason: 'no reading' },
        { resourceId: entry('loom-transform-runner').resourceId, confirmation: 'confirmed-mismatch', reason: 'min 0' },
      ],
    });
    const m = summarizePausedSnapshot(s, { isAdmin: true }) as { failure: string };
    expect(m.failure).toContain('2 service(s)');
    expect(m.failure).toContain('loom-dab-preview');
    expect(m.failure).toContain('loom-transform-runner');
    expect(m.failure).not.toContain('loom-udf-runtime');
    expect(m.failure).not.toContain('/subscriptions/');
  });

  // Breaks if: a non-failed state carries failure text.
  it('failure is null unless RESUME_FAILED', () => {
    expect(summarizePausedSnapshot(snap(), { isAdmin: true })).toMatchObject({ failure: null });
  });
});

describe('the banner poll cannot pin the estate awake', () => {
  // Breaks if: '/api/estate/paused' is removed from NOT_ACTIVITY_PREFIXES -> every page view is "human activity".
  it('/api/estate/paused is not human activity; an ordinary route still is', () => {
    expect(countsAsHumanActivity('/api/estate/paused')).toBe(false);
    expect(countsAsHumanActivity('/api/items/lakehouse')).toBe(true);
  });
});
