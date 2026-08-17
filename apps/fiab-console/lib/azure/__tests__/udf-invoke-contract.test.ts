/**
 * udf-invoke-contract — attribution honesty (deploy-integrity.md R7) and
 * server-side parameter validation for POST /api/items/user-data-function/<id>/invoke.
 *
 * THE COUNTEREXAMPLE THESE SPECS EXIST FOR (PR #3692 review block).
 * The first cut of `friendlyRuntimeError` named the cause from correlation
 * alone — "which parameters are null in the outgoing payload" — with no check
 * that any of them appears in the traceback:
 *
 *     if (/NoneType/.test(excMsg)) { blame every param whose value === null }
 *
 * So `f(a=None, b=5)`, where `a` is never read and the NoneType error is raised
 * deep inside a library call on unrelated internal state, produced "The function
 * failed because a was not provided". The user fixes `a`, reruns, fails
 * identically. R7: "An error must not state as fact something it did not
 * establish. If the code does not know, the message says it does not know."
 */
import { describe, it, expect } from 'vitest';
import {
  friendlyRuntimeError, udfFailureBody, validateInvokeParameters, validateAgainstSignature,
} from '../udf-invoke-contract';
import type { UdfFunction } from '@/lib/editors/_family-utils';

/** The real shape the loom-udf-runtime returns: app.py frame + authored frame. */
function traceback(authoredFrame: string, exception: string): string {
  return [
    'Traceback (most recent call last):',
    '  File "/app/app.py", line 88, in invoke',
    '    result = fn(**params)',
    authoredFrame,
    exception,
  ].join('\n');
}

const COMPUTE_SCORE: UdfFunction = {
  name: 'compute_score',
  params: [
    { name: 'user_id', type: 'str' },
    { name: 'weight', type: 'float', default: '1.0' },
  ],
  returns: 'dict',
};

describe('friendlyRuntimeError — attribution must be EARNED, not correlated (R7)', () => {
  it('does NOT blame a null parameter the traceback never references', () => {
    // `a` is null but the raising frame is a library call on unrelated internal
    // state — `a` appears nowhere in it. This is the counterexample.
    const raw = traceback(
      '  File "/usr/lib/python3.11/site-packages/vendorlib/core.py", line 412, in normalize\n'
      + '    return self._cache.upper()',
      "AttributeError: 'NoneType' object has no attribute 'upper'",
    );
    const out = friendlyRuntimeError(raw, { a: null, b: 5 })!;

    expect(out.basis).toBe('none');
    expect(out.implicated).toEqual([]);
    // The forbidden claim, verbatim from the shape that was blocked.
    expect(out.message).not.toMatch(/failed because a/);
    expect(out.message).not.toMatch(/Set a value for a\b/);
    // It says, in as many words, that it does not know.
    expect(out.message).toMatch(/could not determine which parameter is responsible/);
    // And it still discloses the null as an UNPROVEN candidate.
    expect(out.message).toMatch(/does not reference a, which was sent as null/);
    expect(out.message).toMatch(/may or may not be the cause/);
  });

  it('names the parameter when the RAISING FRAME actually references it', () => {
    const raw = traceback(
      '  File "<udf-source>", line 7, in compute_score\n'
      + '    return {"user": user_id, "score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { user_id: 'u1', weight: null })!;

    expect(out.basis).toBe('frame');
    expect(out.implicated).toEqual(['weight']);
    expect(out.message).toMatch(/The line that raised — in compute_score — references weight/);
    expect(out.message).toMatch(/was sent as null/);
  });

  it('attributes only the referenced null, not every null in the payload', () => {
    const raw = traceback(
      '  File "<udf-source>", line 7, in compute_score\n'
      + '    return {"score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    // `unused` is equally null and equally absent from the traceback.
    const out = friendlyRuntimeError(raw, { weight: null, unused: null })!;

    expect(out.implicated).toEqual(['weight']);
    expect(out.message).not.toContain('unused');
  });

  it("trusts the interpreter when Python names the missing argument itself", () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "/app/app.py", line 88, in invoke',
      '    result = fn(**params)',
      "TypeError: compute_score() missing 1 required positional argument: 'user_id'",
    ].join('\n');
    const out = friendlyRuntimeError(raw, { weight: 2.5 })!;

    expect(out.basis).toBe('interpreter');
    expect(out.implicated).toEqual(['user_id']);
    expect(out.message).toMatch(/was called without user_id/);
  });

  it('reports an unexpected keyword argument as the interpreter stated it', () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "/app/app.py", line 88, in invoke',
      '    result = fn(**params)',
      "TypeError: compute_score() got an unexpected keyword argument 'weght'",
    ].join('\n');
    const out = friendlyRuntimeError(raw, { user_id: 'u1', weght: 2 })!;

    expect(out.basis).toBe('interpreter');
    expect(out.implicated).toEqual(['weght']);
    expect(out.message).toMatch(/does not accept a parameter named weght/);
  });

  it('summarises a failure with no null parameters at all without inventing a cause', () => {
    const raw = traceback(
      '  File "<udf-source>", line 9, in compute_score\n'
      + '    raise ValueError("score out of range")',
      'ValueError: score out of range',
    );
    const out = friendlyRuntimeError(raw, { user_id: 'u1', weight: 2.5 })!;

    expect(out.basis).toBe('none');
    expect(out.excType).toBe('ValueError');
    expect(out.implicated).toEqual([]);
    expect(out.message).toMatch(/raised ValueError: score out of range/);
    expect(out.message).toMatch(/See the full traceback/);
  });

  it('never returns the raw traceback AS the summary (R6)', () => {
    const raw = traceback(
      '  File "<udf-source>", line 7, in compute_score\n'
      + '    return {"score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { weight: null })!;
    expect(out.message).not.toContain('Traceback (most recent call last)');
    expect(out.message).not.toContain('File "');
  });

  it('returns undefined for a body that is not a traceback, so it is forwarded unchanged', () => {
    expect(friendlyRuntimeError('{"error":"upstream 503"}', {})).toBeUndefined();
    expect(friendlyRuntimeError('', {})).toBeUndefined();
  });

  it('reads the exception from the LAST frame, not a raise inside a quoted source line', () => {
    // The `raise ValueError(...)` text appears in a NON-final frame's source
    // line; the exception that actually propagated is the KeyError below it.
    const raw = [
      'Traceback (most recent call last):',
      '  File "/app/app.py", line 88, in invoke',
      '    raise ValueError("this is source text, not the exception")',
      '  File "<udf-source>", line 4, in compute_score',
      '    return cfg["missing"]',
      "KeyError: 'missing'",
    ].join('\n');
    expect(friendlyRuntimeError(raw, {})!.excType).toBe('KeyError');
  });
});

describe('udfFailureBody — the summary must not DESTROY the traceback', () => {
  const RAW = traceback(
    '  File "<udf-source>", line 7, in compute_score\n'
    + '    return {"score": weight * 42}',
    "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
  );

  it('returns the summary AND the raw interpreter output', () => {
    const out = udfFailureBody(RAW, { weight: null });
    // `body: friendly || text` used to throw the traceback away here.
    expect(out.detail).toBe(RAW);
    expect(out.body).not.toContain('Traceback (most recent call last)');
    expect(out.body).toMatch(/references weight/);
  });

  it('discloses how much the summary actually established', () => {
    expect(udfFailureBody(RAW, { weight: null }).attribution)
      .toEqual({ basis: 'frame', parameters: ['weight'] });
    // The unattributed case is labelled as such, not silently equal to it.
    const vague = udfFailureBody(RAW, { unrelated: null });
    expect(vague.attribution).toEqual({ basis: 'none', parameters: [] });
    expect(vague.detail).toBe(RAW);
  });

  it('forwards a non-traceback body unchanged, with no invented detail', () => {
    const out = udfFailureBody('upstream 503', {});
    expect(out).toEqual({ body: 'upstream 503' });
  });
});

describe('validateInvokeParameters — server-side shape checks', () => {  it('accepts an absent body as an empty parameter set', () => {
    expect(validateInvokeParameters(undefined)).toEqual({ parameters: {} });
    expect(validateInvokeParameters(null)).toEqual({ parameters: {} });
  });

  it('rejects a non-object parameters payload', () => {
    for (const bad of [[1, 2], 'user_id=1', 42, true]) {
      const out = validateInvokeParameters(bad) as any;
      expect(out.error, `expected ${JSON.stringify(bad)} to be rejected`).toMatch(/must be a JSON object/);
    }
  });

  it('rejects keys that are not Python identifiers, naming them', () => {
    const out = validateInvokeParameters({ 'user id': 1, ok_name: 2, '2bad': 3 }) as any;
    expect(out.invalidParameters).toEqual(['user id', '2bad']);
    expect(out.error).toContain('user id');
    expect(out.error).toContain('2bad');
  });

  it('rejects prototype-hazard keys', () => {
    const out = validateInvokeParameters(JSON.parse('{"__proto__": {"polluted": 1}}')) as any;
    expect(out.invalidParameters).toEqual(['__proto__']);
    // And nothing was polluted on the way through.
    expect(({} as any).polluted).toBeUndefined();
  });

  it('copies a valid payload rather than forwarding the caller object verbatim', () => {
    const src = { user_id: 'u1', weight: 2.5 };
    const out = validateInvokeParameters(src) as { parameters: Record<string, unknown> };
    expect(out.parameters).toEqual(src);
    expect(out.parameters).not.toBe(src);
  });
});

describe('validateAgainstSignature — the editor rule, enforced server-side (#3574)', () => {
  it('rejects a missing required parameter that declares no default', () => {
    const out = validateAgainstSignature({ weight: 2.5 }, COMPUTE_SCORE)!;
    expect(out.invalidParameters).toEqual(['user_id']);
    expect(out.error).toMatch(/compute_score requires user_id/);
  });

  it('rejects an explicit null for a parameter whose declared default is not None', () => {
    const out = validateAgainstSignature({ user_id: 'u1', weight: null }, COMPUTE_SCORE)!;
    expect(out.invalidParameters).toEqual(['weight']);
    expect(out.hint).toMatch(/omit the parameter entirely/);
  });

  it('allows a blank-with-default parameter to be OMITTED, which is the #3574 fix', () => {
    expect(validateAgainstSignature({ user_id: 'u1' }, COMPUTE_SCORE)).toBeUndefined();
  });

  it('allows an explicit null when the signature declares `= None`', () => {
    const fn: UdfFunction = { name: 'f', params: [{ name: 'opt', type: 'str', default: 'None' }] };
    expect(validateAgainstSignature({ opt: null }, fn)).toBeUndefined();
  });

  it('skips validation entirely when the signature is unknown', () => {
    expect(validateAgainstSignature({ anything: null }, undefined)).toBeUndefined();
  });

  it('does not reject extra keys — *args/**kwargs are dropped by the parser', () => {
    expect(validateAgainstSignature({ user_id: 'u1', extra: 1 }, COMPUTE_SCORE)).toBeUndefined();
  });
});
