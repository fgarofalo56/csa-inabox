import { describe, it, expect } from 'vitest';
import {
  normalizeGuardrails, checkInputGuardrails, applyOutputGuardrails, redactPii,
  activeGuardrailCount, FLOW_EVALS, DEFAULT_GUARDRAILS,
} from '../agent-flow-guardrails';

describe('agent-flow-guardrails — normalize', () => {
  it('defaults a non-object to the baseline (opt-out)', () => {
    const g = normalizeGuardrails(undefined);
    expect(g.enabled).toBe(true);
    expect(g.redactPii).toBe(true);
    expect(g.blockedTerms).toEqual([]);
  });

  it('dedupes + trims blocked terms and drops unknown evals', () => {
    const g = normalizeGuardrails({ blockedTerms: [' secret ', 'secret', ''], evals: ['groundedness', 'nope'] });
    expect(g.blockedTerms).toEqual(['secret']);
    expect(g.evals).toEqual(['groundedness']);
  });

  it('clamps a negative / non-numeric maxOutputChars to 0', () => {
    expect(normalizeGuardrails({ maxOutputChars: -5 }).maxOutputChars).toBe(0);
    expect(normalizeGuardrails({ maxOutputChars: 'x' as any }).maxOutputChars).toBe(0);
    expect(normalizeGuardrails({ maxOutputChars: 500 }).maxOutputChars).toBe(500);
  });

  it('exposes the Azure AI Foundry evaluator families', () => {
    expect(FLOW_EVALS.map((e) => e.id)).toContain('groundedness');
    expect(FLOW_EVALS.map((e) => e.id)).toContain('safety');
    expect(DEFAULT_GUARDRAILS.evals).toContain('groundedness');
  });
});

describe('agent-flow-guardrails — PII redaction (real regex layer)', () => {
  it('redacts email / phone / ssn / card', () => {
    const { text, hits } = redactPii('Reach a@b.com or 415-555-1212; ssn 123-45-6789 card 4111 1111 1111 1111');
    expect(text).not.toContain('a@b.com');
    expect(text).toContain('[redacted-email]');
    expect(hits).toEqual(expect.arrayContaining(['email', 'ssn']));
  });

  it('leaves clean text unchanged', () => {
    const { text, hits } = redactPii('total revenue was 1,234 units');
    expect(text).toBe('total revenue was 1,234 units');
    expect(hits).toEqual([]);
  });
});

describe('agent-flow-guardrails — input', () => {
  it('blocks a question containing a blocked term', () => {
    const g = normalizeGuardrails({ blockedTerms: ['classified'] });
    const v = checkInputGuardrails(g, 'show me the classified report');
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('block');
  });

  it('passes a clean question', () => {
    const g = normalizeGuardrails({ blockedTerms: ['classified'] });
    expect(checkInputGuardrails(g, 'show me revenue')).toEqual([]);
  });

  it('is a no-op when disabled', () => {
    const g = normalizeGuardrails({ enabled: false, blockedTerms: ['x'] });
    expect(checkInputGuardrails(g, 'x')).toEqual([]);
  });
});

describe('agent-flow-guardrails — output', () => {
  it('redacts PII and reports a warn violation', () => {
    const g = normalizeGuardrails({ redactPii: true });
    const r = applyOutputGuardrails(g, 'contact a@b.com', { executedRows: true });
    expect(r.answer).toContain('[redacted-email]');
    expect(r.blocked).toBe(false);
    expect(r.violations.some((v) => v.rule.startsWith('pii'))).toBe(true);
    expect(r.applied).toContain('redact-pii');
  });

  it('blocks when grounding required but no rows executed', () => {
    const g = normalizeGuardrails({ requireGrounding: true, redactPii: false });
    const r = applyOutputGuardrails(g, 'the answer', { executedRows: false });
    expect(r.blocked).toBe(true);
    expect(r.answer).toContain('withheld');
  });

  it('does not block when grounding required and rows executed', () => {
    const g = normalizeGuardrails({ requireGrounding: true, redactPii: false });
    const r = applyOutputGuardrails(g, 'the answer', { executedRows: true });
    expect(r.blocked).toBe(false);
    expect(r.answer).toBe('the answer');
  });

  it('blocks on a blocked term in the output', () => {
    const g = normalizeGuardrails({ blockedTerms: ['ssn'], redactPii: false });
    const r = applyOutputGuardrails(g, 'the ssn is secret', { executedRows: true });
    expect(r.blocked).toBe(true);
  });

  it('truncates to maxOutputChars', () => {
    const g = normalizeGuardrails({ maxOutputChars: 5, redactPii: false });
    const r = applyOutputGuardrails(g, 'abcdefghij', { executedRows: true });
    expect(r.answer.length).toBeLessThanOrEqual(6); // 5 + ellipsis
    expect(r.applied).toContain('max-output');
  });

  it('counts active guardrails', () => {
    expect(activeGuardrailCount(normalizeGuardrails({ redactPii: true, requireGrounding: true }))).toBe(2);
    expect(activeGuardrailCount(normalizeGuardrails({ enabled: false, redactPii: true }))).toBe(0);
  });
});
