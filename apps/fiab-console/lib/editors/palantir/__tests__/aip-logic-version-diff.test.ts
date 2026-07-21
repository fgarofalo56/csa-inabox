/**
 * diffSnapshots — pure version-diff unit tests for the Spindle Versions panel.
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshots } from '../aip-logic-version-diff';

const base = {
  inputs: [{ name: 'customerId', type: 'string' }, { name: 'region', type: 'string' }],
  blocks: [
    { id: 'b1', kind: 'use-llm', name: 'Assess', output: 'answer1', prompt: 'Assess {customerId}' },
    { id: 'b2', kind: 'transform', name: 'Upper', output: 'value1', transformOp: 'uppercase' },
  ],
  outputType: 'string',
  outputDescription: 'summary',
  settings: { tier: 'standard' },
};

describe('diffSnapshots', () => {
  it('reports identical snapshots as unchanged', () => {
    const d = diffSnapshots(base, base);
    expect(d.addedCount).toBe(0);
    expect(d.removedCount).toBe(0);
    expect(d.editedCount).toBe(0);
    expect(d.inputs.every((r) => r.change === 'unchanged')).toBe(true);
    expect(d.blocks.every((r) => r.change === 'unchanged')).toBe(true);
  });

  it('detects added / removed inputs', () => {
    const next = { ...base, inputs: [{ name: 'customerId', type: 'string' }, { name: 'score', type: 'double' }] };
    const d = diffSnapshots(base, next);
    const added = d.inputs.find((r) => r.change === 'added');
    const removed = d.inputs.find((r) => r.change === 'removed');
    expect(added?.key).toBe('score');
    expect(removed?.key).toBe('region');
    expect(d.addedCount).toBe(1);
    expect(d.removedCount).toBe(1);
  });

  it('detects an edited block and names the changed fields', () => {
    const next = {
      ...base,
      blocks: [
        { id: 'b1', kind: 'use-llm', name: 'Assess', output: 'answer1', prompt: 'Assess {customerId} in {region}' },
        { id: 'b2', kind: 'transform', name: 'Upper', output: 'value1', transformOp: 'uppercase' },
      ],
    };
    const d = diffSnapshots(base, next);
    const edited = d.blocks.find((r) => r.change === 'edited');
    expect(edited?.key).toBe('b1');
    expect(edited?.detail).toContain('prompt');
    expect(d.editedCount).toBe(1);
  });

  it('detects output-contract and settings changes', () => {
    const next = { ...base, outputType: 'number', settings: { tier: 'strong' } };
    const d = diffSnapshots(base, next);
    expect(d.outputChanged).toBe(true);
    expect(d.outputDetail).toBe('string → number');
    expect(d.settingsChanged).toBe(true);
    // editedCount includes output + settings deltas
    expect(d.editedCount).toBe(2);
  });

  it('is null-safe for empty snapshots', () => {
    const d = diffSnapshots(undefined, undefined);
    expect(d.inputs).toEqual([]);
    expect(d.blocks).toEqual([]);
    expect(d.outputChanged).toBe(false);
  });
});
