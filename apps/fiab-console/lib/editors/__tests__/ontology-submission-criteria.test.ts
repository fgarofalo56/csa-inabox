import { describe, it, expect } from 'vitest';
import {
  evaluateSubmissionCriteria, normalizeOntoActionCriteria, type OntoActionType,
} from '../ontology-model';

function action(submissionCriteria: any[]): OntoActionType {
  return { name: 'createOrder', objectType: 'Order', kind: 'create', parameters: [], submissionCriteria } as OntoActionType;
}

describe('normalizeOntoActionCriteria', () => {
  it('drops malformed rows, keeps valid ops, coerces value/message', () => {
    const out = normalizeOntoActionCriteria([
      { parameter: 'total', op: 'gt', value: 0 },
      { parameter: '', op: 'gt' },              // no parameter → dropped
      { parameter: 'x', op: 'bogus' },          // bad op → dropped
      { parameter: 'status', op: 'in', value: 'a,b', message: 'bad status' },
      'nope',                                    // non-object → dropped
    ]);
    expect(out).toEqual([
      { parameter: 'total', op: 'gt', value: '0' },
      { parameter: 'status', op: 'in', value: 'a,b', message: 'bad status' },
    ]);
  });
});

describe('evaluateSubmissionCriteria', () => {
  it('passes when no criteria', () => {
    expect(evaluateSubmissionCriteria(action([]), { total: 5 })).toEqual({ ok: true });
  });

  it('nonEmpty fails on missing/empty, passes when present', () => {
    const a = action([{ parameter: 'name', op: 'nonEmpty' }]);
    expect(evaluateSubmissionCriteria(a, {}).ok).toBe(false);
    expect(evaluateSubmissionCriteria(a, { name: '' }).ok).toBe(false);
    expect(evaluateSubmissionCriteria(a, { name: 'Acme' })).toEqual({ ok: true });
  });

  it('numeric comparisons (gt/gte/lt/lte)', () => {
    expect(evaluateSubmissionCriteria(action([{ parameter: 'total', op: 'gt', value: '0' }]), { total: 5 })).toEqual({ ok: true });
    expect(evaluateSubmissionCriteria(action([{ parameter: 'total', op: 'gt', value: '0' }]), { total: 0 }).ok).toBe(false);
    expect(evaluateSubmissionCriteria(action([{ parameter: 'total', op: 'lte', value: '100' }]), { total: 100 })).toEqual({ ok: true });
    // non-numeric value with numeric op fails safe
    expect(evaluateSubmissionCriteria(action([{ parameter: 'total', op: 'gt', value: '0' }]), { total: 'abc' }).ok).toBe(false);
  });

  it('eq/neq compare as strings', () => {
    expect(evaluateSubmissionCriteria(action([{ parameter: 's', op: 'eq', value: 'A' }]), { s: 'A' })).toEqual({ ok: true });
    expect(evaluateSubmissionCriteria(action([{ parameter: 's', op: 'neq', value: 'A' }]), { s: 'A' }).ok).toBe(false);
  });

  it('in matches a comma list (trimmed)', () => {
    const a = action([{ parameter: 'status', op: 'in', value: 'open, closed , pending' }]);
    expect(evaluateSubmissionCriteria(a, { status: 'closed' })).toEqual({ ok: true });
    expect(evaluateSubmissionCriteria(a, { status: 'archived' }).ok).toBe(false);
  });

  it('regex validates and reports an invalid pattern', () => {
    expect(evaluateSubmissionCriteria(action([{ parameter: 'sku', op: 'regex', value: '^[A-Z]+$' }]), { sku: 'ABC' })).toEqual({ ok: true });
    expect(evaluateSubmissionCriteria(action([{ parameter: 'sku', op: 'regex', value: '^[A-Z]+$' }]), { sku: 'abc' }).ok).toBe(false);
    const bad = evaluateSubmissionCriteria(action([{ parameter: 'sku', op: 'regex', value: '([' }]), { sku: 'x' });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/invalid regex/);
  });

  it('value-ops skip when the value is absent (required-ness is the schema\'s job)', () => {
    expect(evaluateSubmissionCriteria(action([{ parameter: 'total', op: 'gt', value: '0' }]), {})).toEqual({ ok: true });
  });

  it('uses the custom message when provided', () => {
    const r = evaluateSubmissionCriteria(action([{ parameter: 'total', op: 'gt', value: '0', message: 'Total must be positive.' }]), { total: -1 });
    expect(r).toEqual({ ok: false, error: 'Total must be positive.' });
  });
});

import { evaluateObjectInvariants } from '../ontology-model';
describe('evaluateObjectInvariants', () => {
  const ot = (invariants: any[]) => ({ apiName: 'Order', properties: [], invariants } as any);
  it('enforces invariants on instance values with the Invariant label', () => {
    expect(evaluateObjectInvariants(ot([{ parameter: 'total', op: 'gt', value: '0' }]), { total: 5 })).toEqual({ ok: true });
    const r = evaluateObjectInvariants(ot([{ parameter: 'total', op: 'gt', value: '0' }]), { total: 0 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Invariant failed/);
  });
  it('no invariants → ok; null type → ok', () => {
    expect(evaluateObjectInvariants(ot([]), { x: 1 })).toEqual({ ok: true });
    expect(evaluateObjectInvariants(null, { x: 1 })).toEqual({ ok: true });
  });
});
