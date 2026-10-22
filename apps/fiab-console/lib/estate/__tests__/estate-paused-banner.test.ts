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
  resources: [entry('loom-mcp'), entry('loom-airflow'), entry('loom-activator')],
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
    const s = snap({ resources: [entry('loom-mcp'), entry('loom-airflow'), entry('loom-activator'), entry('old', 'Paused')] });
    const m = summarizePausedSnapshot(s, { isAdmin: true });
    expect(m).toMatchObject({ paused: true, state: 'PAUSED', count: 3 });
    expect((m as { names: string[] }).names).toEqual(['loom-mcp', 'loom-airflow', 'loom-activator']);
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
        { resourceId: entry('loom-mcp').resourceId, confirmation: 'confirmed-running', reason: 'ok' },
        { resourceId: entry('loom-airflow').resourceId, confirmation: 'unknown', reason: 'no reading' },
        { resourceId: entry('loom-activator').resourceId, confirmation: 'confirmed-mismatch', reason: 'min 0' },
      ],
    });
    const m = summarizePausedSnapshot(s, { isAdmin: true }) as { failure: string };
    expect(m.failure).toContain('2 service(s)');
    expect(m.failure).toContain('loom-airflow');
    expect(m.failure).toContain('loom-activator');
    expect(m.failure).not.toContain('loom-mcp');
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
