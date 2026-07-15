import { describe, it, expect } from 'vitest';
import {
  missingConfig,
  evaluableRules,
  buildReasoningMessages,
  decide,
  type OpsAgentItem,
} from './evaluator-core';

const item: OpsAgentItem = {
  id: 'a1',
  displayName: 'Freezer monitor',
  workspaceId: 'ws1',
  state: {
    systemPrompt: 'Keep frozen products safe.',
    model: 'gpt-4o',
    rules: [
      { id: 'r1', name: 'temp high', query: 'Metrics | where temp > 20', sourceKind: 'adx', requireApproval: true },
      { id: 'r2', name: 'la rule', query: 'AppEvents | where x > 1', sourceKind: 'log-analytics' },
      { id: 'r3', name: 'no query adx', sourceKind: 'adx' },
    ],
  },
};

describe('missingConfig', () => {
  it('reports the exact missing env vars (honest gate)', () => {
    expect(missingConfig({})).toEqual(['LOOM_COSMOS_ENDPOINT', 'LOOM_AOAI_ENDPOINT']);
    expect(missingConfig({ LOOM_COSMOS_ENDPOINT: 'x', LOOM_AOAI_ENDPOINT: 'y' })).toEqual([]);
  });
});

describe('evaluableRules', () => {
  it('keeps only ADX-sourced triggers with a query (LA fires via Azure Monitor)', () => {
    const rules = evaluableRules(item);
    expect(rules.map((r) => r.id)).toEqual(['r1']);
  });
  it('returns [] when there are no rules', () => {
    expect(evaluableRules({ id: 'x', displayName: 'x', workspaceId: 'w' })).toEqual([]);
  });
});

describe('buildReasoningMessages', () => {
  it('grounds the prompt on the agent instructions + fired rows', () => {
    const msgs = buildReasoningMessages(item, item.state!.rules![0], {
      columns: ['temp', 'ts'],
      rows: [[22, '2026-07-15'], [25, '2026-07-15']],
      count: 2,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('Keep frozen products safe');
    expect(msgs[0].content).toContain('NOT Microsoft Fabric');
    expect(msgs[1].content).toContain('temp high');
    expect(msgs[1].content).toContain('2 matching row');
    expect(msgs[1].content).toContain('22');
  });
});

describe('decide', () => {
  it('routes requireApproval rules to approval', () => {
    expect(decide({ id: 'r1', name: 'temp', requireApproval: true }, 'raise the temp')).toEqual({
      kind: 'approval', ruleName: 'temp', recommendation: 'raise the temp',
    });
  });
  it('routes non-approval rules to autonomous', () => {
    expect(decide({ id: 'r2', name: 'cpu', requireApproval: false }, 'scale out')).toEqual({
      kind: 'autonomous', ruleName: 'cpu', recommendation: 'scale out',
    });
  });
  it('skips when no recommendation was produced', () => {
    expect(decide({ id: 'r3', name: 'x' }, '   ')).toEqual({ kind: 'skip', reason: 'no recommendation produced' });
  });
});
