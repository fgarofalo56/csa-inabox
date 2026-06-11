/**
 * Unit tests for the IRM-for-Lakehouse indicator engine (Fabric Build 2026 #35).
 *
 * Exercises the pure analyzers (no IO) on fixture audit rows — z-score volume
 * flagging, off-hours bucketing with tz/business-hours, privileged + pipeline
 * volume, and the per-actor rollup. Mirrors the no-vaporware requirement that
 * indicator math is real and deterministic, not mocked output.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock the IO modules so the pure-analyzer unit tests don't drag in the real
// @azure/cosmos / ARM clients (these tests exercise deterministic math only).
vi.mock('../cosmos-client', () => ({
  auditLogContainer: async () => ({}),
  tenantSettingsContainer: async () => ({}),
}));
vi.mock('../monitor-client', () => ({
  queryLoomAppEvents: async () => [],
  queryActivityFeed: async () => [],
  listActivityLog: async () => [],
  MonitorNotConfiguredError: class MonitorNotConfiguredError extends Error {},
}));

import {
  analyzeVolume,
  analyzeOffHours,
  analyzePrivileged,
  analyzePipelineVolume,
  rollupTopActors,
  normalizeAuditRow,
  isExfilVerb,
  localParts,
  mergeThresholds,
  DEFAULT_THRESHOLDS,
  IRM_INDICATORS,
  type NormalizedAuditEvent,
} from '../irm-client';

const T = mergeThresholds(null);

function ev(actor: string, verb: string, at: string): NormalizedAuditEvent {
  return { actor, verb, at, source: 'cosmos' };
}

describe('isExfilVerb', () => {
  it('matches exfiltration-class verbs case-insensitively', () => {
    expect(isExfilVerb('Download')).toBe(true);
    expect(isExfilVerb('item.export')).toBe(true);
    expect(isExfilVerb('share')).toBe(true);
    expect(isExfilVerb('login')).toBe(false);
    expect(isExfilVerb('')).toBe(false);
  });
});

describe('normalizeAuditRow', () => {
  it('handles the {who,kind} writer shape', () => {
    const n = normalizeAuditRow({ who: 'a@x.com', kind: 'download', at: '2026-06-01T10:00:00Z', itemId: 'i1' });
    expect(n).toMatchObject({ actor: 'a@x.com', verb: 'download', itemId: 'i1', source: 'cosmos' });
  });
  it('handles the {upn,action} activity-feed shape', () => {
    const n = normalizeAuditRow({ upn: 'b@x.com', action: 'share', at: '2026-06-01T10:00:00Z', itemType: 'lakehouse' });
    expect(n).toMatchObject({ actor: 'b@x.com', verb: 'share', itemType: 'lakehouse' });
  });
  it('returns null when actor or timestamp is missing', () => {
    expect(normalizeAuditRow({ kind: 'download', at: '2026-06-01T10:00:00Z' })).toBeNull();
    expect(normalizeAuditRow({ who: 'a@x.com', kind: 'download' })).toBeNull();
  });
});

describe('analyzeVolume (cumulative exfiltration peer-norm)', () => {
  it('flags an actor whose exfil volume exceeds mean + zσ and the floor', () => {
    const events: NormalizedAuditEvent[] = [];
    // Ten baseline actors with ~5 exfil events each.
    for (let a = 0; a < 10; a++) {
      for (let i = 0; i < 5; i++) events.push(ev(`u${a}`, 'read', `2026-06-0${(i % 9) + 1}T10:00:00Z`));
    }
    // One outlier with 60 exfil events.
    for (let i = 0; i < 60; i++) events.push(ev('outlier', 'download', `2026-06-01T${String(i % 24).padStart(2, '0')}:00:00Z`));

    const findings = analyzeVolume(events, T);
    expect(findings).toHaveLength(1);
    expect(findings[0].actor).toBe('outlier');
    expect(findings[0].indicatorId).toBe('unusual-volume');
    expect(findings[0].count).toBe(60);
    expect(findings[0].severity).toBe('high');
  });

  it('does not flag below the minVolumeEvents floor even with high z-score', () => {
    const events = [
      ...['u1', 'u2', 'u3'].map((a) => ev(a, 'read', '2026-06-01T10:00:00Z')),
      ...Array.from({ length: 10 }, (_, i) => ev('spiky', 'download', `2026-06-01T${String(i).padStart(2, '0')}:00:00Z`)),
    ];
    // spiky has 10 exfil events — above peer mean but below the floor of 20.
    const findings = analyzeVolume(events, T);
    expect(findings.find((f) => f.actor === 'spiky')).toBeUndefined();
  });

  it('respects a custom z-score / floor via mergeThresholds', () => {
    const t = mergeThresholds({ minVolumeEvents: 3, volumeZ: 1 });
    const events = [
      ...['a', 'b', 'c'].flatMap((x) => Array.from({ length: 3 }, () => ev(x, 'read', '2026-06-01T10:00:00Z'))),
      ...Array.from({ length: 20 }, () => ev('d', 'download', '2026-06-01T10:00:00Z')),
    ];
    const findings = analyzeVolume(events, t);
    expect(findings.map((f) => f.actor)).toContain('d');
  });
});

describe('analyzeOffHours', () => {
  it('flags events outside business hours (UTC)', () => {
    const events = [
      ev('night', 'read', '2026-06-01T02:00:00Z'), // 02:00 UTC — off hours
      ev('night', 'read', '2026-06-01T03:00:00Z'),
      ev('night', 'read', '2026-06-01T04:00:00Z'),
      ev('night', 'read', '2026-06-01T22:00:00Z'),
      ev('night', 'read', '2026-06-01T23:00:00Z'),
      ev('day', 'read', '2026-06-01T12:00:00Z'),   // midday Monday — within hours
    ];
    const findings = analyzeOffHours(events, mergeThresholds({ minOffHoursEvents: 1, flagWeekends: false }));
    const actors = findings.map((f) => f.actor);
    expect(actors).toContain('night');
    expect(actors).not.toContain('day');
    expect(findings.find((f) => f.actor === 'night')!.count).toBe(5);
  });

  it('flags weekend access when flagWeekends is on', () => {
    // 2026-06-06 is a Saturday, 2026-06-07 a Sunday.
    const events = [
      ev('weekender', 'read', '2026-06-06T12:00:00Z'),
      ev('weekender', 'read', '2026-06-07T12:00:00Z'),
    ];
    const on = analyzeOffHours(events, mergeThresholds({ minOffHoursEvents: 1, flagWeekends: true }));
    expect(on.find((f) => f.actor === 'weekender')!.count).toBe(2);
    const off = analyzeOffHours(events, mergeThresholds({ minOffHoursEvents: 1, flagWeekends: false }));
    expect(off.find((f) => f.actor === 'weekender')).toBeUndefined();
  });
});

describe('localParts', () => {
  it('localizes an ISO timestamp to a timezone', () => {
    // 2026-06-01T02:00:00Z is 22:00 the prior day in America/New_York (EDT, UTC-4).
    const p = localParts('2026-06-01T02:00:00Z', 'America/New_York');
    expect(p).not.toBeNull();
    expect(p!.hour).toBe(22);
  });
  it('falls back to UTC for an invalid timezone', () => {
    const p = localParts('2026-06-01T05:00:00Z', 'Not/AZone');
    expect(p!.hour).toBe(5);
  });
  it('returns null for an unparseable timestamp', () => {
    expect(localParts('not-a-date', 'UTC')).toBeNull();
  });
});

describe('analyzePrivileged', () => {
  it('flags callers with privileged ops over the floor', () => {
    const arm = Array.from({ length: 6 }, (_, i) => ({
      caller: 'admin@x.com', operationName: 'Microsoft.Storage/storageAccounts/write',
      eventTimestamp: `2026-06-01T0${i}:00:00Z`,
    }));
    arm.push({ caller: 'reader@x.com', operationName: 'Microsoft.Storage/storageAccounts/read', eventTimestamp: '2026-06-01T01:00:00Z' });
    const findings = analyzePrivileged(arm, T);
    expect(findings).toHaveLength(1);
    expect(findings[0].actor).toBe('admin@x.com');
    expect(findings[0].source).toBe('arm');
  });
});

describe('analyzePipelineVolume', () => {
  it('flags a user submitter above pipelineMinRuns and skips scheduled triggers', () => {
    const feed = [
      ...Array.from({ length: 30 }, (_, i) => ({ submitter: 'etl@x.com', timeGenerated: `2026-06-01T${String(i % 24).padStart(2, '0')}:00:00Z` })),
      ...Array.from({ length: 40 }, () => ({ submitter: 'Scheduled', timeGenerated: '2026-06-01T01:00:00Z' })),
    ];
    const findings = analyzePipelineVolume(feed, T);
    expect(findings).toHaveLength(1);
    expect(findings[0].actor).toBe('etl@x.com');
  });
});

describe('rollupTopActors', () => {
  it('aggregates findings into a per-actor risk leaderboard', () => {
    const findings = [
      { actor: 'u1', indicatorId: 'unusual-volume', indicator: 'V', category: 'Exfiltration' as const, severity: 'high' as const, count: 60, baseline: 5, lastSeen: '2026-06-02T00:00:00Z', detail: '', source: 'cosmos' as const },
      { actor: 'u1', indicatorId: 'off-hours-access', indicator: 'O', category: 'Unusual activity' as const, severity: 'medium' as const, count: 12, baseline: 0, lastSeen: '2026-06-03T00:00:00Z', detail: '', source: 'cosmos' as const },
      { actor: 'u2', indicatorId: 'off-hours-access', indicator: 'O', category: 'Unusual activity' as const, severity: 'low' as const, count: 6, baseline: 0, lastSeen: '2026-06-01T00:00:00Z', detail: '', source: 'cosmos' as const },
    ];
    const events = [ev('u1', 'download', '2026-06-01T02:00:00Z'), ev('u2', 'read', '2026-06-01T12:00:00Z')];
    const top = rollupTopActors(findings, events, T);
    expect(top[0].actor).toBe('u1');
    expect(top[0].indicators).toBe(2);
    expect(top[0].highestSeverity).toBe('high');
    expect(top[0].riskScore).toBeGreaterThan(top[1].riskScore);
  });
});

describe('catalog + thresholds', () => {
  it('every indicator has a stable id and category', () => {
    const ids = new Set(IRM_INDICATORS.map((i) => i.id));
    expect(ids.size).toBe(IRM_INDICATORS.length);
    expect(ids.has('unusual-volume')).toBe(true);
    expect(ids.has('off-hours-access')).toBe(true);
  });
  it('mergeThresholds preserves defaults and overlays the enabled map', () => {
    const t = mergeThresholds({ enabled: { 'privileged-access': true } });
    expect(t.volumeZ).toBe(DEFAULT_THRESHOLDS.volumeZ);
    expect(t.enabled['privileged-access']).toBe(true);
    expect(t.enabled['unusual-volume']).toBe(DEFAULT_THRESHOLDS.enabled['unusual-volume']);
  });
});
