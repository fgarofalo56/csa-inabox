import { describe, it, expect } from 'vitest';
import { evaluateExpression, detectSampleInputs, type EvalContext } from '../evaluate-expression';

const emptyCtx = (over: Partial<EvalContext> = {}): EvalContext => ({
  parameters: {}, variables: {}, systemVars: {}, activityOutputs: {}, ...over,
});

describe('evaluateExpression', () => {
  it('resolves the canonical concat + parameter + variable expression', () => {
    const ctx = emptyCtx({ parameters: { env: 'prod' }, variables: { x: 'east' } });
    const r = evaluateExpression("@concat(pipeline().parameters.env,'-',variables('x'))", ctx);
    expect(r.error).toBeUndefined();
    expect(r.value).toBe('prod-east');
    expect(r.unresolvedTokens).toHaveLength(0);
  });

  it('resolves activity output sub-fields', () => {
    const ctx = emptyCtx({ activityOutputs: { CopyData: { rowsCopied: 42 } } });
    const r = evaluateExpression("@activity('CopyData').output.rowsCopied", ctx);
    expect(r.value).toBe(42);
  });

  it('resolves string interpolation @{...} mixed with literals', () => {
    const ctx = emptyCtx({ parameters: { date: '2026-06-06' } });
    const r = evaluateExpression("@{concat('file_', pipeline().parameters.date, '.csv')}", ctx);
    expect(r.value).toBe('file_2026-06-06.csv');
  });

  it('handles nested function calls and logical/if', () => {
    const ctx = emptyCtx({ parameters: { n: '5' } });
    const r = evaluateExpression("@if(greater(int(pipeline().parameters.n),3),'big','small')", ctx);
    expect(r.value).toBe('big');
  });

  it('formats dates deterministically', () => {
    const r = evaluateExpression("@formatDateTime('2026-06-06T13:45:09Z','yyyy-MM-dd HH:mm')", emptyCtx());
    expect(r.value).toBe('2026-06-06 13:45');
  });

  it('flags unresolved runtime tokens', () => {
    const r = evaluateExpression("@concat('run-', pipeline().RunId)", emptyCtx());
    expect(r.unresolvedTokens).toContain('@pipeline().RunId');
  });

  it('resolves system vars from sample context', () => {
    const ctx = emptyCtx({ systemVars: { RunId: 'abc-123' } });
    const r = evaluateExpression('@pipeline().RunId', ctx);
    expect(r.value).toBe('abc-123');
    expect(r.unresolvedTokens).toHaveLength(0);
  });

  it('reports a parse error rather than throwing', () => {
    const r = evaluateExpression('@concat(', emptyCtx());
    expect(r.error).toBeTruthy();
  });

  it('treats a non-@ string as a plain literal', () => {
    const r = evaluateExpression('hello world', emptyCtx());
    expect(r.value).toBe('hello world');
  });
});

describe('detectSampleInputs', () => {
  it('detects activity outputs', () => {
    const inputs = detectSampleInputs("@activity('CopyData').output.rowsCopied", [], []);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ kind: 'activityOutput', name: 'CopyData', key: 'activity__CopyData__output' });
  });

  it('detects run-time system variables', () => {
    const inputs = detectSampleInputs('@pipeline().RunId', [], []);
    expect(inputs.some((s) => s.kind === 'systemVar' && s.name === 'RunId')).toBe(true);
  });

  it('only flags params/vars NOT defined on the pipeline', () => {
    const inputs = detectSampleInputs(
      "@concat(pipeline().parameters.env, variables('known'), variables('unknown'))",
      ['env'], ['known'],
    );
    const names = inputs.map((s) => s.name);
    expect(names).toContain('unknown');
    expect(names).not.toContain('env');
    expect(names).not.toContain('known');
  });

  it('returns nothing for design-time-only expressions', () => {
    const inputs = detectSampleInputs("@concat('a','b')", [], []);
    expect(inputs).toHaveLength(0);
  });
});
