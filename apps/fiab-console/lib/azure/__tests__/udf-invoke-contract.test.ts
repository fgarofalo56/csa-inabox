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
 *
 * SECOND REVIEW ROUND. The fix above was written against a traceback shape the
 * day-one backend never emits, and its frame matching was loose enough to name
 * the wrong parameter with total confidence. Both are pinned below.
 */
import { describe, it, expect } from 'vitest';
import {
  friendlyRuntimeError, udfFailureBody, validateInvokeParameters, validateAgainstSignature,
} from '../udf-invoke-contract';
import type { UdfFunction } from '@/lib/editors/_family-utils';

// ── Fixtures: what the DEFAULT backend actually puts on the wire ────────────
//
// `LOOM_UDF_FUNCTION_BASE` points at the loom-udf-runtime Container App, whose
// handler is platform/fiab/bicep/modules/admin-plane/udf-runtime/app.py. It
// NEVER returns a bare traceback. It returns a JSON envelope, and `json.dumps`
// puts the whole thing on ONE line with the newlines escaped:
//
//   app.py:156  except TypeError  -> 400 {"error": "bad parameters for <fn>: <exc>"}
//                                        …with NO "trace" key at all.
//   app.py:161  except Exception  -> 500 {"error": str(exc), "trace": format_exc()}
//
// app.py:84 runs the authored source via
// `exec(compile(src, "<udf-source>", "exec"))`, so linecache cannot resolve
// `<udf-source>` and Python emits NO source line for the authored frame — the
// only frame whose text could implicate a parameter.

/** app.py:161 — the 500 envelope, exactly as json.dumps writes it. */
function runtimeEnvelope(error: string, trace?: string): string {
  return JSON.stringify(trace === undefined ? { error } : { error, trace });
}

/** app.py:156 — the 400 TypeError envelope. No trace, by construction. */
function runtimeBadParameters(fnName: string, excText: string): string {
  return runtimeEnvelope(`bad parameters for ${fnName}: ${excText}`);
}

/**
 * A traceback as CPython formats it inside the runtime: app.py's own frame
 * carries a source line (it is a real file); the authored `<udf-source>` frame
 * does NOT, because it was compiled from a string.
 */
function pyTraceback(authoredFrames: string[], exception: string): string {
  return [
    'Traceback (most recent call last):',
    '  File "/app/app.py", line 154, in do_POST',
    '    result = func(**params) if isinstance(params, dict) else func(params)',
    ...authoredFrames,
    exception,
    '',
  ].join('\n');
}

/**
 * A BARE traceback — i.e. a response body that is nothing but interpreter text.
 * This is NOT what the Loom runtime returns; it models a customer's own
 * deployed Azure Function App (LOOM_UDF_ALLOWED_FUNCTION_BASES) or the opt-in
 * Fabric host, which can surface raw interpreter output. Kept because those
 * paths are real, and labelled honestly because the previous helper here
 * claimed to be "the real shape the loom-udf-runtime returns" and was not.
 */
function bareTraceback(authoredFrame: string, exception: string): string {
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

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 3 — the real backend envelope
// ═══════════════════════════════════════════════════════════════════════════
describe('the DEFAULT backend returns a JSON envelope, not a bare traceback (app.py)', () => {
  it('reads the interpreter TypeError out of the app.py:156 envelope, which carries NO traceback', () => {
    // Measured against head: friendlyRuntimeError returned undefined here, so
    // the entire basis:'interpreter' path was dead against the real backend.
    const raw = runtimeBadParameters(
      'compute_score',
      "compute_score() missing 1 required positional argument: 'user_id'",
    );
    const out = friendlyRuntimeError(raw, { weight: 2.5 }, 'compute_score')!;

    expect(out).toBeDefined();
    expect(out.basis).toBe('interpreter');
    expect(out.excType).toBe('TypeError');
    expect(out.implicated).toEqual(['user_id']);
    expect(out.message).toMatch(/was called without user_id/);
    // The envelope's JSON must never be what the user reads.
    expect(out.message).not.toContain('{"error"');
    expect(out.message).not.toContain('bad parameters for');
  });

  it('reads the unexpected-keyword TypeError out of the same envelope', () => {
    const raw = runtimeBadParameters(
      'compute_score',
      "compute_score() got an unexpected keyword argument 'weght'",
    );
    const out = friendlyRuntimeError(raw, { user_id: 'u1', weght: 2 }, 'compute_score')!;

    expect(out.basis).toBe('interpreter');
    expect(out.excType).toBe('TypeError');
    expect(out.implicated).toEqual(['weght']);
    expect(out.message).toMatch(/does not accept a parameter named weght/);
  });

  it('decodes the escaped traceback in the app.py:161 envelope and reports the REAL exception type', () => {
    // json.dumps put this on one line; head parsed excType as "Error".
    const trace = pyTraceback(
      ['  File "<udf-source>", line 7, in compute_score'],
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const raw = runtimeEnvelope("unsupported operand type(s) for *: 'NoneType' and 'int'", trace);
    expect(raw).not.toContain('\n'); // the wire body really is one line

    const out = friendlyRuntimeError(raw, { user_id: 'u1', weight: null }, 'compute_score')!;

    expect(out.excType).toBe('TypeError');
    expect(out.message).toMatch(/unsupported operand type/);
    expect(out.message).not.toContain('\\n'); // never the escaped form
  });

  it('surfaces the DECODED traceback as detail, not the escaped JSON envelope', () => {
    // The "Show full traceback" disclosure rendered escaped JSON at head.
    const trace = pyTraceback(
      ['  File "<udf-source>", line 7, in compute_score'],
      "ValueError: bad input",
    );
    const raw = runtimeEnvelope('bad input', trace);
    const out = udfFailureBody(raw, { user_id: 'u1' }, 'compute_score');

    expect(out.detail).toBe(trace);
    expect(out.detail).toContain('\n');       // real newlines
    expect(out.detail).not.toContain('\\n');  // not the escaped ones
    expect(out.detail).not.toContain('{"error"');
  });

  it('offers no traceback disclosure when the envelope carried none (app.py:156)', () => {
    // R7: do not imply evidence exists when it does not.
    const raw = runtimeBadParameters('compute_score', "compute_score() missing 1 required positional argument: 'user_id'");
    expect(udfFailureBody(raw, {}, 'compute_score').detail).toBeUndefined();
  });

  it('does not claim a frame reference when <udf-source> yielded no source line', () => {
    // app.py:84 compiles from a string, so the authored frame has no source.
    const trace = pyTraceback(
      ['  File "<udf-source>", line 7, in compute_score'],
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(runtimeEnvelope('boom', trace), { weight: null }, 'compute_score')!;

    expect(out.basis).not.toBe('frame');
    expect(out.message).not.toMatch(/The line that raised/);
    // And it must not assert the opposite either (BLOCKER 5).
    expect(out.message).not.toMatch(/does not reference weight/);
    expect(out.message).toMatch(/no source line|could not read/i);
  });

  it('still summarises a plain envelope that has neither trace nor interpreter shape', () => {
    const out = friendlyRuntimeError(runtimeEnvelope('connection to the lake timed out'), {}, 'f')!;
    expect(out.message).toMatch(/connection to the lake timed out/);
    expect(out.message).not.toContain('{"error"');
    expect(out.basis).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 1 — "the line that raised references X" must be TRUE
// ═══════════════════════════════════════════════════════════════════════════
describe('the frame claim and the message claim are kept separate (R7)', () => {
  const MODE_TRACE = pyTraceback(
    [
      '  File "/app/udf/function_app.py", line 12, in pick_mode',
      '    raise ValueError(_MODE_MSG)',
    ],
    'ValueError: mode must be one of a, b, c',
  );

  it('does NOT say the raising LINE references a name that only the MESSAGE contains', () => {
    // Head: basis 'frame', "The line that raised — in pick_mode — references mode".
    // The line is `raise ValueError(_MODE_MSG)`. It does not reference `mode`.
    const out = friendlyRuntimeError(runtimeEnvelope('mode must be one of a, b, c', MODE_TRACE), { mode: null }, 'pick_mode')!;

    expect(out.message).not.toMatch(/The line that raised.*references mode/);
    expect(out.basis).not.toBe('frame');
  });

  it('attributes it to the exception MESSAGE, which is what actually matched', () => {
    const out = friendlyRuntimeError(runtimeEnvelope('mode must be one of a, b, c', MODE_TRACE), { mode: null }, 'pick_mode')!;

    expect(out.basis).toBe('message');
    expect(out.implicated).toEqual(['mode']);
    expect(out.message).toMatch(/exception message references mode/);
  });

  it('still says "the line that raised" when the SOURCE genuinely references it', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 7, in compute_score\n'
      + '    return {"user": user_id, "score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { user_id: 'u1', weight: null }, 'compute_score')!;

    expect(out.basis).toBe('frame');
    expect(out.implicated).toEqual(['weight']);
    expect(out.message).toMatch(/The line that raised — in compute_score — references weight/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 2 — identifier positions only, and hedge the frame claim
// ═══════════════════════════════════════════════════════════════════════════
describe('a parameter name is matched only where it could BE the identifier', () => {
  it('does not match a name that appears only inside a STRING LITERAL', () => {
    // Head: implicated ['id'], "Set a value for id … and run again." — from ["id"].
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 9, in lookup\n'
      + '    return payload["id"]',
      "KeyError: 'id2'",
    );
    const out = friendlyRuntimeError(raw, { id: null }, 'lookup')!;

    expect(out.basis).not.toBe('frame');
    expect(out.message).not.toMatch(/The line that raised.*references id\b/);
  });

  it('does not match a name that appears only inside a # COMMENT', () => {
    // Head: implicated ['name'], from `# TODO: honour name`.
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 14, in greet\n'
      + '    return build()  # TODO: honour name',
      "AttributeError: 'NoneType' object has no attribute 'strip'",
    );
    const out = friendlyRuntimeError(raw, { name: null }, 'greet')!;

    expect(out.basis).not.toBe('frame');
    expect(out.message).not.toMatch(/The line that raised.*references name\b/);
  });

  it('DOES match inside an f-string interpolation, which is a real identifier position', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 5, in label\n'
      + '    return f"score={weight * 2}"',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { weight: null }, 'label')!;

    expect(out.basis).toBe('frame');
    expect(out.implicated).toEqual(['weight']);
  });

  it('does not match an ATTRIBUTE of the same name (self.weight is not the parameter)', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 5, in scale\n'
      + '    return cfg.weight * 2',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { weight: null }, 'scale')!;
    expect(out.basis).not.toBe('frame');
  });

  it('hedges the frame claim rather than asserting cause outright', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 7, in compute_score\n'
      + '    return {"score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { weight: null }, 'compute_score')!;

    expect(out.basis).toBe('frame');
    // basis:'none' already hedges ("may or may not be the cause"); 'frame' must too.
    expect(out.message).toMatch(/does not prove|not proof|may not be/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER 5 — never assert a negative about a frame that was never parsed
// ═══════════════════════════════════════════════════════════════════════════
describe('an unparsed frame is reported as unparsed, never as a negative finding', () => {
  it('does not claim "the frame that raised does not reference X" with no frame at all', () => {
    // Head: "the frame that raised does not reference mode, which was sent as null".
    const raw = 'Traceback (most recent call last):\nValueError: boom';
    const out = friendlyRuntimeError(raw, { mode: null }, 'f')!;

    expect(out.message).not.toMatch(/does not reference mode/);
    expect(out.message).toMatch(/no frame could be parsed|could not parse a frame/i);
    expect(out.basis).toBe('none');
    expect(out.implicated).toEqual([]);
  });

  it('may state the negative when it genuinely READ the failing line', () => {
    const raw = bareTraceback(
      '  File "/usr/lib/python3.11/site-packages/vendorlib/core.py", line 412, in normalize\n'
      + '    return self._cache.upper()',
      "AttributeError: 'NoneType' object has no attribute 'upper'",
    );
    const out = friendlyRuntimeError(raw, { a: null, b: 5 }, 'f')!;

    expect(out.basis).toBe('none');
    expect(out.implicated).toEqual([]);
    expect(out.message).not.toMatch(/failed because a/);
    expect(out.message).toMatch(/does not reference a\b/);
    expect(out.message).toMatch(/may or may not be the cause/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Finding 9 — the interpreter basis must be about the INVOKED function
// ═══════════════════════════════════════════════════════════════════════════
describe('an internal helper\'s TypeError is not reported as the caller\'s missing parameter', () => {
  it('does not tell the user to supply a parameter the invoked function has no field for', () => {
    const raw = runtimeEnvelope(
      "_lookup_user() missing 1 required positional argument: 'conn'",
      pyTraceback(
        ['  File "<udf-source>", line 11, in compute_score'],
        "TypeError: _lookup_user() missing 1 required positional argument: 'conn'",
      ),
    );
    const out = friendlyRuntimeError(raw, { user_id: 'u1' }, 'compute_score')!;

    expect(out.basis).not.toBe('interpreter');
    expect(out.implicated).not.toContain('conn');
    expect(out.message).not.toMatch(/Supply that parameter/);
    expect(out.message).toMatch(/_lookup_user/);
  });

  it('still trusts the interpreter when the callee IS the invoked function', () => {
    const raw = runtimeBadParameters('compute_score', "compute_score() missing 1 required positional argument: 'user_id'");
    const out = friendlyRuntimeError(raw, {}, 'compute_score')!;
    expect(out.basis).toBe('interpreter');
    expect(out.implicated).toEqual(['user_id']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Retained coverage from round one
// ═══════════════════════════════════════════════════════════════════════════
describe('friendlyRuntimeError — attribution must be EARNED, not correlated (R7)', () => {
  it('attributes only the referenced null, not every null in the payload', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 7, in compute_score\n'
      + '    return {"score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { weight: null, unused: null }, 'compute_score')!;

    expect(out.implicated).toEqual(['weight']);
    expect(out.message).not.toContain('unused');
  });

  it('summarises a failure with no null parameters at all without inventing a cause', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 9, in compute_score\n'
      + '    raise ValueError("score out of range")',
      'ValueError: score out of range',
    );
    const out = friendlyRuntimeError(raw, { user_id: 'u1', weight: 2.5 }, 'compute_score')!;

    expect(out.basis).toBe('none');
    expect(out.excType).toBe('ValueError');
    expect(out.implicated).toEqual([]);
    expect(out.message).toMatch(/raised ValueError: score out of range/);
  });

  it('never returns the raw traceback AS the summary (R6)', () => {
    const raw = bareTraceback(
      '  File "/app/udf/function_app.py", line 7, in compute_score\n'
      + '    return {"score": weight * 42}',
      "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
    );
    const out = friendlyRuntimeError(raw, { weight: null }, 'compute_score')!;
    expect(out.message).not.toContain('Traceback (most recent call last)');
    expect(out.message).not.toContain('File "');
  });

  it('returns undefined for a body that is neither a traceback nor a runtime envelope', () => {
    expect(friendlyRuntimeError('upstream 503 from the gateway', {}, 'f')).toBeUndefined();
    expect(friendlyRuntimeError('', {}, 'f')).toBeUndefined();
    expect(friendlyRuntimeError('<html>502 Bad Gateway</html>', {}, 'f')).toBeUndefined();
  });

  it('reads the exception from the LAST frame, not a raise inside a quoted source line', () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "/app/app.py", line 88, in invoke',
      '    raise ValueError("this is source text, not the exception")',
      '  File "/app/udf/function_app.py", line 4, in compute_score',
      '    return cfg["missing"]',
      "KeyError: 'missing'",
    ].join('\n');
    expect(friendlyRuntimeError(raw, {}, 'compute_score')!.excType).toBe('KeyError');
  });
});

describe('udfFailureBody — the summary must not DESTROY the traceback', () => {
  const RAW = bareTraceback(
    '  File "/app/udf/function_app.py", line 7, in compute_score\n'
    + '    return {"score": weight * 42}',
    "TypeError: unsupported operand type(s) for *: 'NoneType' and 'int'",
  );

  it('returns the summary AND the raw interpreter output', () => {
    const out = udfFailureBody(RAW, { weight: null }, 'compute_score');
    expect(out.detail).toBe(RAW);
    expect(out.body).not.toContain('Traceback (most recent call last)');
    expect(out.body).toMatch(/references weight/);
  });

  it('discloses how much the summary actually established', () => {
    expect(udfFailureBody(RAW, { weight: null }, 'compute_score').attribution)
      .toEqual({ basis: 'frame', parameters: ['weight'] });
    const vague = udfFailureBody(RAW, { unrelated: null }, 'compute_score');
    expect(vague.attribution).toEqual({ basis: 'none', parameters: [] });
    expect(vague.detail).toBe(RAW);
  });

  it('forwards a non-traceback body unchanged, with no invented detail', () => {
    const out = udfFailureBody('upstream 503 from the gateway', {}, 'f');
    expect(out).toEqual({ body: 'upstream 503 from the gateway' });
  });
});

describe('validateInvokeParameters — server-side shape checks', () => {
  it('accepts an absent body as an empty parameter set', () => {
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
  });

  // Finding 11 — the old assertion `expect(({}).polluted).toBeUndefined()` could
  // not fail: `{...raw}` defines an OWN property and never invokes a setter, so
  // it read `undefined` whether or not the code polluted anything. Assert the
  // READ through a fresh object, against a payload that DOES install a setter.
  it('cannot pollute Object.prototype — asserted on the READ, with a live control', () => {
    const before = ({} as any).polluted;
    expect(before).toBeUndefined();

    // The control: prove this harness CAN observe pollution, so a clean read
    // below is evidence and not a vacuous assertion.
    (Object.prototype as any).polluted = 'CONTROL';
    expect(({} as any).polluted).toBe('CONTROL');
    delete (Object.prototype as any).polluted;
    expect(({} as any).polluted).toBeUndefined();

    const out = validateInvokeParameters(JSON.parse('{"__proto__": {"polluted": 1}}')) as any;
    expect(out.invalidParameters).toEqual(['__proto__']);
    // Read through a FRESH object — this is the assertion that can actually fail.
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  // Finding 6 — `constructor`/`prototype` ARE valid Python identifiers. Saying
  // otherwise is an untrue error message (R7) for a legitimate parameter name.
  it('rejects constructor/prototype WITHOUT claiming they are invalid identifiers', () => {
    for (const key of ['constructor', 'prototype']) {
      const out = validateInvokeParameters({ [key]: 1 }) as any;
      expect(out.invalidParameters).toEqual([key]);
      expect(out.error).not.toMatch(/not valid Python identifiers/);
      expect(out.error).toMatch(/reserved|JavaScript|hazard/i);
    }
  });

  it('still calls a genuinely non-identifier key what it is', () => {
    const out = validateInvokeParameters({ '2bad': 1 }) as any;
    expect(out.error).toMatch(/not valid Python identifiers/);
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
