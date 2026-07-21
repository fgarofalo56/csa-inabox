import { describe, it, expect } from 'vitest';
import {
  normalizeTimeBranchInput, timeBranchView, newTimeBranchId,
  type TimeBranchDoc,
} from '../time-branch-store';
import { TimeMachineError } from '../time-machine';

describe('time-branch-store — normalizeTimeBranchInput', () => {
  it('accepts a name + timestamp asOf', () => {
    const out = normalizeTimeBranchInput({ name: '  Q2 close  ', asOf: '2026-07-01', description: ' snapshot ' });
    expect(out.name).toBe('Q2 close');
    expect(out.asOf).toEqual({ kind: 'timestamp', iso: '2026-07-01T00:00:00.000Z' });
    expect(out.description).toBe('snapshot');
  });

  it('accepts a Delta version asOf', () => {
    expect(normalizeTimeBranchInput({ name: 'v42', asOf: 'v:42' }).asOf).toEqual({ kind: 'version', version: 42 });
  });

  it('rejects a missing name', () => {
    expect(() => normalizeTimeBranchInput({ asOf: '2026-07-01' })).toThrow(TimeMachineError);
  });

  it('rejects a live / empty asOf (a branch must pin a point in time)', () => {
    expect(() => normalizeTimeBranchInput({ name: 'x', asOf: 'live' })).toThrow(TimeMachineError);
    expect(() => normalizeTimeBranchInput({ name: 'x', asOf: '' })).toThrow(TimeMachineError);
  });

  it('rejects a malformed asOf', () => {
    expect(() => normalizeTimeBranchInput({ name: 'x', asOf: 'garbage' })).toThrow(TimeMachineError);
  });
});

describe('time-branch-store — view + id', () => {
  it('projects a stored doc to a client view with label + wire value', () => {
    const doc: TimeBranchDoc = {
      id: 'tb:ws1:abc', docType: 'time-branch', workspaceId: 'ws1', name: 'Q2 close',
      asOf: { kind: 'version', version: 42 }, createdAt: '2026-07-20T00:00:00.000Z', createdBy: 'oid-1',
    };
    const v = timeBranchView(doc);
    expect(v).toMatchObject({ id: 'tb:ws1:abc', workspaceId: 'ws1', name: 'Q2 close', asOfValue: 'v:42', asOfLabel: 'as of v42' });
  });

  it('newTimeBranchId is workspace-prefixed + unique', () => {
    const a = newTimeBranchId('ws1');
    const b = newTimeBranchId('ws1');
    expect(a.startsWith('tb:ws1:')).toBe(true);
    expect(a).not.toBe(b);
  });
});
