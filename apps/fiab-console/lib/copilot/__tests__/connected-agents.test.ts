import { describe, it, expect } from 'vitest';
import {
  newSubAgentRef, normalizeSubAgents, isSubAgentConfigured,
  subAgentToFoundryTool, subAgentsToFoundryTools, foundryAgentNameFor,
  type SubAgentRef,
} from '../connected-agents';

const resolver = (itemId: string, itemType: any) => foundryAgentNameFor(itemId, itemType);

describe('connected-agents model', () => {
  it('newSubAgentRef binds an item', () => {
    const r = newSubAgentRef('abc', 'data-agent', 'Finance');
    expect(r.itemId).toBe('abc');
    expect(r.itemType).toBe('data-agent');
    expect(r.name).toBe('Finance');
    expect(r.id).toMatch(/^sub-/);
    expect(isSubAgentConfigured(r)).toBe(true);
  });

  it('normalizeSubAgents drops entries without an itemId + defaults the type', () => {
    const out = normalizeSubAgents([
      { id: '1', itemId: 'a', itemType: 'operations-agent', name: 'Ops' },
      { id: '2', itemType: 'data-agent' }, // no itemId → dropped
      { itemId: 'c', itemType: 'bogus', name: 'X' }, // bad type → data-agent
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].itemType).toBe('operations-agent');
    expect(out[1].itemType).toBe('data-agent');
    expect(out[1].id).toBeTruthy();
  });

  it('normalizeSubAgents returns [] for non-arrays', () => {
    expect(normalizeSubAgents(undefined)).toEqual([]);
    expect(normalizeSubAgents('x')).toEqual([]);
  });
});

describe('foundryAgentNameFor', () => {
  it('mirrors the publish naming per type', () => {
    expect(foundryAgentNameFor('MyId_1', 'data-agent')).toBe('loom-data-myid-1');
    expect(foundryAgentNameFor('MyId_1', 'operations-agent')).toBe('loom-ops-myid-1');
  });
});

describe('subAgentToFoundryTool', () => {
  it('maps a bound ref to a connected_agent tool', () => {
    const ref: SubAgentRef = { id: '1', itemId: 'a', itemType: 'data-agent', name: 'Finance', role: 'analyst', description: 'money Qs' };
    const t = subAgentToFoundryTool(ref, resolver);
    expect(t).toEqual({
      type: 'connected_agent',
      connected_agent: { id: 'loom-data-a', name: 'analyst', description: 'money Qs' },
    });
  });

  it('returns null when the ref is unbound or unresolved', () => {
    expect(subAgentToFoundryTool({ id: '1', itemId: '', itemType: 'data-agent', name: 'x' }, resolver)).toBeNull();
    expect(subAgentToFoundryTool({ id: '1', itemId: 'a', itemType: 'data-agent', name: 'x' }, () => undefined)).toBeNull();
  });

  it('subAgentsToFoundryTools drops unresolved entries', () => {
    const out = subAgentsToFoundryTools(
      [
        { id: '1', itemId: 'a', itemType: 'data-agent', name: 'A' },
        { id: '2', itemId: '', itemType: 'data-agent', name: 'B' },
      ],
      resolver,
    );
    expect(out).toHaveLength(1);
  });
});
