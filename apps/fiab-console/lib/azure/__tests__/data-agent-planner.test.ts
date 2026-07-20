import { describe, it, expect } from 'vitest';
import {
  isMultiHop,
  shouldPlan,
  parsePlan,
  sequenceSteps,
  parseVerify,
  MAX_PLAN_STEPS,
} from '../data-agent-planner';

describe('isMultiHop', () => {
  it('flags conjunction / comparison / breakdown questions', () => {
    expect(isMultiHop('Compare revenue in the West vs the East region')).toBe(true);
    expect(isMultiHop('Show total sales and then break down by product')).toBe(true);
    expect(isMultiHop('What is the revenue trend over time?')).toBe(true);
  });
  it('flags two-plus explicit questions and long compound prompts', () => {
    expect(isMultiHop('Who are the top customers? What did they buy?')).toBe(true);
    expect(isMultiHop('x'.repeat(200))).toBe(true);
  });
  it('is false for a simple single-hop lookup', () => {
    expect(isMultiHop('What is the total revenue?')).toBe(false);
    expect(isMultiHop('')).toBe(false);
  });
  it('lowers the bar when two+ sources are attached', () => {
    const q = 'Which customers had the highest support ticket volume last quarter';
    expect(isMultiHop(q, 1)).toBe(false); // no explicit multi-hop marker, single source
    expect(isMultiHop(q, 2)).toBe(true);  // spans sources
  });
});

describe('shouldPlan', () => {
  it('requires at least one source', () => {
    expect(shouldPlan('compare A vs B', { taskClass: 'reasoning', sourceCount: 0 })).toBe(false);
    expect(shouldPlan('compare A vs B', { taskClass: 'reasoning', sourceCount: 1 })).toBe(true);
  });
  it('never plans a non-reasoning turn', () => {
    expect(shouldPlan('compare A vs B', { taskClass: 'lightweight', sourceCount: 2 })).toBe(false);
    expect(shouldPlan('compare A vs B', { taskClass: 'general', sourceCount: 2 })).toBe(false);
  });
  it('plans a hard, multi-hop reasoning turn with sources', () => {
    expect(shouldPlan('Compare Q1 vs Q2 revenue then break down by region', { taskClass: 'reasoning', sourceCount: 2 })).toBe(true);
  });
  it('does not plan a simple reasoning turn (no multi-hop signal)', () => {
    expect(shouldPlan('Why is revenue down?', { taskClass: 'reasoning', sourceCount: 1 })).toBe(false);
  });
});

describe('parsePlan', () => {
  it('parses a fenced {"plan":[…]} block into ordered steps', () => {
    const content = [
      'Here is my plan:',
      '```json',
      '{"plan":[{"step":1,"source":"Sales WH","subQuery":"revenue by region","rationale":"base"},{"step":2,"source":"Support KQL","subQuery":"tickets by region"}]}',
      '```',
    ].join('\n');
    const p = parsePlan(content);
    expect(p.steps).toHaveLength(2);
    expect(p.steps[0]).toMatchObject({ step: 1, source: 'Sales WH', subQuery: 'revenue by region', rationale: 'base' });
    expect(p.steps[1].rationale).toBeUndefined();
  });
  it('accepts a bare array and sub_query / question aliases', () => {
    const content = '[{"source":"A","sub_query":"q1"},{"source":"B","question":"q2"}]';
    const p = parsePlan(content);
    expect(p.steps.map((s) => s.subQuery)).toEqual(['q1', 'q2']);
    expect(p.steps.map((s) => s.step)).toEqual([1, 2]);
  });
  it('drops steps with no sub-query and never throws on garbage', () => {
    expect(parsePlan('no json here').steps).toEqual([]);
    expect(parsePlan('```json\n{"plan":[{"source":"A"}]}\n```').steps).toEqual([]);
  });
});

describe('sequenceSteps', () => {
  it('sorts by step ordinal, dedupes, caps, and renumbers from 1', () => {
    const seq = sequenceSteps([
      { step: 3, source: 'C', subQuery: 'q3' },
      { step: 1, source: 'A', subQuery: 'q1' },
      { step: 1, source: 'A', subQuery: 'q1' }, // dup
      { step: 2, source: 'B', subQuery: 'q2' },
    ]);
    expect(seq.map((s) => s.subQuery)).toEqual(['q1', 'q2', 'q3']);
    expect(seq.map((s) => s.step)).toEqual([1, 2, 3]);
  });
  it('caps at MAX_PLAN_STEPS', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ step: i + 1, source: `S${i}`, subQuery: `q${i}` }));
    expect(sequenceSteps(many)).toHaveLength(MAX_PLAN_STEPS);
  });
});

describe('parseVerify', () => {
  it('parses a structured verdict + grounded final answer', () => {
    const content = '```json\n{"verdict":"pass","reason":"rows answer it","finalAnswer":"West leads at $4.2M"}\n```';
    const v = parseVerify(content);
    expect(v.verdict).toBe('pass');
    expect(v.reason).toBe('rows answer it');
    expect(v.finalAnswer).toBe('West leads at $4.2M');
  });
  it('normalizes free-form verdict tokens', () => {
    expect(parseVerify('{"verdict":"insufficient","reason":"missing data"}').verdict).toBe('fail');
    expect(parseVerify('{"verdict":"correct","reason":"ok"}').verdict).toBe('pass');
    expect(parseVerify('{"verdict":"unclear","reason":"maybe"}').verdict).toBe('partial');
  });
  it('degrades to an honest partial when unstructured (never claims pass)', () => {
    const v = parseVerify('The answer looks fine to me.');
    expect(v.verdict).toBe('partial');
    expect(v.finalAnswer).toBe('The answer looks fine to me.');
  });
});
