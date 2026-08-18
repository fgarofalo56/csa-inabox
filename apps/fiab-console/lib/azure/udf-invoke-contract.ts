/**
 * udf-invoke-contract — the request/response contract for
 * `POST /api/items/user-data-function/<id>/invoke`, kept as pure functions so
 * vitest can exercise it without booting the route's Azure/Cosmos graph.
 *
 * Two jobs, both of them about telling the truth:
 *
 * 1. `friendlyRuntimeError()` — translate a runtime failure into a summary a
 *    user can act on WITHOUT asserting a cause the code never established
 *    (.claude/rules/deploy-integrity.md R7). The first cut of this helper
 *    blamed whichever parameter happened to be `null` in the outgoing payload:
 *
 *        if (/NoneType/.test(excMsg)) { name every param whose value === null }
 *
 *    That is a CORRELATION, not an attribution. `f(a=None, b=5)` that ignores
 *    `a` entirely and raises `NoneType` deep inside a library call on unrelated
 *    internal state got the message "The function failed because a was not
 *    provided" — so the user fixes `a`, reruns, and fails identically.
 *
 *    The SECOND cut earned its attribution but earned it from the wrong text:
 *    it matched `frame.source + "\n" + excMsg` as one haystack and then claimed
 *    "The line that raised references X" even when only the MESSAGE contained
 *    X, and it matched bare `\bX\b`, so `id` from the literal `["id"]` and
 *    `name` from `# TODO: honour name` both counted as references. Attribution
 *    is therefore now earned from a NAMED source, and the sentence says which:
 *
 *      basis 'interpreter' — Python itself named the argument (a "missing N
 *                            required positional argument: 'x'" TypeError) AND
 *                            the callee is the function that was invoked.
 *      basis 'frame'       — the parameter's name appears at an IDENTIFIER
 *                            POSITION in the source line that raised (string
 *                            literals and `#` comments excluded), and it was
 *                            sent as null. Hedged: consistent with, not proof of.
 *      basis 'message'     — the name appears in the exception message only.
 *                            Weaker, and said in those words.
 *      basis 'none'        — Loom does not know. The message SAYS it does not
 *                            know, and distinguishes "I read the failing line
 *                            and your parameter is not in it" from "I never got
 *                            a failing line to read" (R7).
 *
 *    The raw traceback is never destroyed: the route returns it alongside the
 *    summary (`detail`) so support and the user can still debug the real frame.
 *
 *    THE WIRE FORMAT IS AN ENVELOPE, NOT A TRACEBACK. The day-one backend is
 *    the loom-udf-runtime Container App
 *    (platform/fiab/bicep/modules/admin-plane/udf-runtime/app.py), and it never
 *    emits a bare traceback — it emits JSON, on one line:
 *
 *      app.py:156  except TypeError  -> 400 {"error": "bad parameters for <fn>: <exc>"}
 *                                       …with NO "trace" key at all.
 *      app.py:161  except Exception  -> 500 {"error": str(exc), "trace": format_exc()}
 *
 *    Requiring a bare traceback made both `basis:'interpreter'` shapes dead
 *    code against the real backend and rendered escaped JSON into the "Show
 *    full traceback" disclosure. A bare traceback is still accepted, because a
 *    customer's own deployed Function App or the opt-in Fabric host can return
 *    one.
 *
 * 2. `validateInvokeParameters()` / `validateAgainstSignature()` — server-side
 *    validation of the posted parameters. The Test panel's client-side checks
 *    are a UX affordance, not a control: any direct caller of the route
 *    bypasses them entirely. These run on the server, on every caller.
 */

import type { UdfFunction } from '@/lib/editors/_family-utils';

// ── 1) Runtime-failure translation ──────────────────────────────────────────

export interface UdfRuntimeFailure {
  /** One-line, user-facing summary. NEVER contains the raw traceback. */
  message: string;
  /** Exception class name as Python reported it (e.g. 'TypeError'). */
  excType: string;
  /** Parameters Loom ESTABLISHED as implicated. Empty when basis is 'none'. */
  implicated: string[];
  /** How the attribution was reached. 'none' = Loom does not know. */
  basis: 'interpreter' | 'frame' | 'message' | 'none';
  /**
   * The interpreter traceback the summary was derived from, DECODED — i.e. with
   * real newlines, never the one-line escaped JSON the runtime put on the wire.
   * Absent when the failure carried no traceback (app.py:156 never sends one),
   * so callers do not offer a "full traceback" that does not exist.
   */
  traceback?: string;
}

/** Python names a value-less parameter itself in these two TypeError shapes. */
const MISSING_ARGS_RE = /missing \d+ required (?:positional|keyword-only) arguments?:\s*(.+)$/;
const UNEXPECTED_KW_RE = /got an unexpected keyword argument '([^']+)'/;
/** app.py:156 wraps the interpreter's own TypeError text in this prefix. */
const BAD_PARAMS_RE = /^bad parameters for ([A-Za-z_]\w*):\s*([\s\S]+)$/;

function quotedNames(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/'([^']+)'/g)) out.push(m[1]);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The exception line: the LAST non-indented `Name: message` (or bare `Name`)
 * line in the body. Anchored to line start so a `raise ValueError(...)` inside
 * a quoted source line can never be mistaken for the exception that was raised.
 */
function parseException(lines: string[]): { type: string; message: string } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || /^\s/.test(l)) continue;
    if (/^Traceback\b/.test(l)) return undefined;
    // Dotted names (`fabric.functions.UserDataFunctionError`) keep only the leaf.
    const m = l.match(/^((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\s*(?::\s*([\s\S]*))?$/);
    if (!m) continue;
    return { type: m[1].split('.').pop() as string, message: (m[2] || '').trim() };
  }
  return undefined;
}

/**
 * The frame that actually raised: the LAST `File "...", line N, in fn` header
 * and its source-context lines.
 *
 * `parsed` distinguishes "there was no frame header at all" from "there was a
 * frame but it carried no source". Both leave `source` empty and the caller
 * MUST NOT treat either as evidence that a parameter is absent from the failing
 * line — see R7 and the `basis:'none'` wording below. The second case is the
 * COMMON one for authored code: app.py:84 runs it via
 * `exec(compile(src, "<udf-source>", "exec"))`, and linecache cannot resolve
 * `<udf-source>`, so CPython prints the frame header with no source line under it.
 */
function raisingFrame(lines: string[]): { parsed: boolean; fn?: string; source: string } {
  let hdr = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s+File\s+"/.test(lines[i])) hdr = i;
  if (hdr < 0) return { parsed: false, source: '' };
  const fn = lines[hdr].match(/,\s*in\s+(.+?)\s*$/)?.[1];
  const ctx: string[] = [];
  for (let i = hdr + 1; i < lines.length; i++) {
    if (!/^\s/.test(lines[i])) break; // the exception line / a chaining note
    if (/^\s+File\s+"/.test(lines[i])) break;
    ctx.push(lines[i]);
  }
  return { parsed: true, fn, source: ctx.join('\n') };
}

/**
 * Blank out everything in a Python source line that is NOT an identifier
 * position — string literal bodies and `#` comments — preserving offsets so the
 * result still reads like the original line.
 *
 * Why this exists: matching a bare `\bname\b` against raw source named `id` as
 * the cause of a failure because the line contained the literal `["id"]`, and
 * named `name` because a trailing `# TODO: honour name` mentioned it. Those are
 * exactly the parameter names most likely to collide (`id`, `name`, `data`,
 * `value`, `key`), so the false-positive rate was concentrated on the worst case.
 *
 * f-string interpolations are KEPT: in `f"score={weight}"` the `weight` inside
 * the braces is a genuine identifier reference, and blanking it would trade a
 * false positive for a false negative.
 */
function identifierPositionsOnly(src: string): string {
  const out: string[] = [];
  const blank = (ch: string) => out.push(ch === '\n' ? '\n' : ' ');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#') { // comment runs to end of line
      while (i < src.length && src[i] !== '\n') { blank(src[i]); i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      // A string prefix (r/b/u/f, up to two chars) sits immediately before the
      // quote and was already emitted as identifier text — take it back out.
      let s = i;
      while (s > 0 && /[A-Za-z]/.test(src[s - 1])) s--;
      const prefix = src.slice(s, i);
      const isPrefix = /^[rbufRBUF]{0,2}$/.test(prefix)
        && (s === 0 || !/[A-Za-z0-9_]/.test(src[s - 1]));
      const fstring = isPrefix && /f/i.test(prefix);
      if (isPrefix && prefix.length) {
        for (let z = 1; z <= prefix.length; z++) out[out.length - z] = ' ';
      }
      const triple = src.slice(i, i + 3);
      const quote = (triple === '"""' || triple === "'''") ? triple : c;
      for (let z = 0; z < quote.length; z++) { blank(src[i]); i++; }
      let depth = 0; // f-string {…} nesting
      while (i < src.length) {
        if (src[i] === '\\' && quote.length === 1) {
          blank(src[i]); i++;
          if (i < src.length) { blank(src[i]); i++; }
          continue;
        }
        if (depth === 0 && src.startsWith(quote, i)) {
          for (let z = 0; z < quote.length; z++) { blank(src[i]); i++; }
          break;
        }
        if (fstring && src[i] === '{') {
          if (src[i + 1] === '{') { blank(src[i]); blank(src[i + 1]); i += 2; continue; }
          depth++; blank(src[i]); i++; continue;
        }
        if (fstring && src[i] === '}') {
          if (depth > 0) depth--;
          blank(src[i]); i++; continue;
        }
        if (fstring && depth > 0) { out.push(src[i]); i++; continue; } // real code
        blank(src[i]); i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/**
 * Does `name` occur as a free identifier in `code`? Attribute access
 * (`cfg.weight`) is excluded — that is an attribute of some object, not the
 * parameter the caller supplied.
 */
function referencesIdentifier(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w.])${escapeRe(name)}(?![\\w])`).test(code);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The failure as the runtime actually reported it, normalised across the two
 * wire formats: the JSON envelope the Loom runtime returns, and the bare
 * traceback a customer's own Function App / the Fabric host can return.
 */
interface RuntimeReport {
  /** Decoded traceback text, if one was supplied at all. */
  traceback?: string;
  /** The interpreter's exception text (no class name), if supplied directly. */
  errorText?: string;
  /** The callee app.py named in its `bad parameters for <fn>:` prefix. */
  badParamsCallee?: string;
}

/**
 * Recognise the response body. Returns undefined when it is neither shape, so
 * the caller forwards it unchanged rather than inventing a summary for an HTML
 * error page or a gateway string.
 */
function parseRuntimeReport(rawText: string): RuntimeReport | undefined {
  const text = String(rawText || '');
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      const error = typeof o.error === 'string' ? o.error : '';
      const trace = typeof o.trace === 'string' && o.trace.trim() ? o.trace : undefined;
      if (error || trace) {
        const bad = error.match(BAD_PARAMS_RE);
        return {
          traceback: trace,
          errorText: bad ? bad[2] : (error || undefined),
          badParamsCallee: bad ? bad[1] : undefined,
        };
      }
    }
  }

  // A bare traceback: not the Loom runtime, but a real path (deployed Function
  // App, opt-in Fabric host).
  if (/Traceback \(most recent call last\)/.test(text)) return { traceback: text };
  return undefined;
}

/**
 * Translate a non-2xx runtime body into an actionable summary
 * (.claude/rules/deploy-integrity.md R6), without asserting an unestablished
 * cause (R7).
 *
 * `functionName` is the function the CALLER asked to invoke. It matters because
 * an interpreter argument error names its CALLEE, and that callee is often an
 * internal helper — telling the user to "supply conn" when the Test panel has
 * no `conn` field is an instruction they cannot follow.
 *
 * Returns `undefined` when the body is neither a runtime envelope nor a
 * traceback, so callers forward it unchanged.
 */
export function friendlyRuntimeError(
  rawText: string,
  parameters: Record<string, unknown>,
  functionName?: string,
): UdfRuntimeFailure | undefined {
  const report = parseRuntimeReport(rawText);
  if (!report) return undefined;

  const traceLines = report.traceback ? report.traceback.split(/\r?\n/) : [];
  const fromTrace = report.traceback ? parseException(traceLines) : undefined;

  // Exception CLASS. From the traceback when there is one. Otherwise: app.py's
  // `bad parameters for <fn>:` prefix is emitted only inside `except TypeError`
  // (app.py:155-156), so that prefix does establish the class — nothing else does.
  const excType = fromTrace?.type || (report.badParamsCallee ? 'TypeError' : 'Error');
  const excMsg = (fromTrace?.message || report.errorText || '').trim();
  const knownType = excType !== 'Error';
  const raised = knownType
    ? `${excType}${excMsg ? `: ${excMsg}` : ''}`
    : excMsg;
  // "raised TypeError: …" reads right; "raised Error: …" would assert a class
  // Python never reported, so an unknown class is worded as a plain failure.
  const raisedPhrase = knownType
    ? `The function raised ${raised}.`
    : `The function failed: ${raised || 'the runtime reported no detail'}.`;
  const frame = raisingFrame(traceLines);
  const traceback = report.traceback;

  // Python's own argument errors name the callee ("compute_score() missing …").
  // The LAST traceback frame is the function that RAISED, which for a wrapper
  // or library failure is NOT the callee — so the two are never interchanged.
  const callee = excMsg.match(/^([A-Za-z_]\w*)\(\)/)?.[1] || report.badParamsCallee;
  const calleeLabel = callee || 'The function';
  // An argument error about some OTHER function is not about the caller's input.
  const calleeIsInvoked = !callee || !functionName || callee === functionName;

  const argError = excMsg.match(MISSING_ARGS_RE) || excMsg.match(UNEXPECTED_KW_RE);
  if (argError && !calleeIsInvoked) {
    return {
      excType, implicated: [], basis: 'none', traceback,
      message:
        `${raisedPhrase} That error is about ${callee}, which ${functionName} calls internally — `
        + `it is not about the parameters you supplied. Check how ${functionName} calls ${callee}`
        + `${traceback ? '; the full traceback shows the failing line' : ''}.`,
    };
  }

  // (a) Python named the arguments itself, for the function we actually called.
  const missing = excMsg.match(MISSING_ARGS_RE);
  if (missing) {
    const names = quotedNames(missing[1]);
    if (names.length) {
      const plural = names.length > 1;
      return {
        excType, implicated: names, basis: 'interpreter', traceback,
        message:
          `${calleeLabel} was called without ${joinNames(names)}. Python reported "${raised}". `
          + `Supply ${plural ? 'those parameters' : 'that parameter'} — or add a default in the function `
          + 'signature — and run again.',
      };
    }
  }
  const unexpected = excMsg.match(UNEXPECTED_KW_RE);
  if (unexpected) {
    return {
      excType, implicated: [unexpected[1]], basis: 'interpreter', traceback,
      message:
        `${calleeLabel} does not accept a parameter named ${unexpected[1]}. Python reported "${raised}". `
        + `Remove ${unexpected[1]} from the request, or add it to the function signature.`,
    };
  }

  // (b) A null-valued parameter the evidence actually references. The two
  //     sources are matched SEPARATELY so the sentence can name the one that
  //     matched: claiming "the line that raised references X" on the strength
  //     of the exception message is a statement the code did not establish.
  const nullParams = Object.entries(parameters || {})
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const codeOnly = identifierPositionsOnly(frame.source);
  const inSource = nullParams.filter((n) => referencesIdentifier(codeOnly, n));
  const inMessage = nullParams.filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(excMsg));
  const inFrame = frame.fn ? ` — in ${frame.fn} —` : '';
  // Do not promise the traceback "shows the failing line" when we just said the
  // runtime never supplied one — it shows the frame, which is a weaker thing.
  const seeTrace = traceback
    ? (frame.source ? ' The full traceback shows the failing line.' : ' See the full traceback.')
    : '';

  if (inSource.length) {
    const plural = inSource.length > 1;
    return {
      excType, implicated: inSource, basis: 'frame', traceback,
      message:
        `${raisedPhrase} The line that raised${inFrame} references `
        + `${joinNames(inSource)}, which ${plural ? 'were' : 'was'} sent as null. That is consistent `
        + `with the failure but does not prove it caused it. Set a value for ${joinNames(inSource)}, `
        + `or omit ${plural ? 'them' : 'it'} so the function's own default applies, and run again.`,
    };
  }
  if (inMessage.length) {
    const plural = inMessage.length > 1;
    // Say WHY the stronger check could not be made, rather than implying it was.
    const why = frame.source
      ? 'the failing line itself does not'
      : frame.parsed
        ? 'the runtime reported no source line for the frame that raised, so Loom could not check whether it does'
        : 'Loom could not parse a frame from the traceback, so it could not check the failing line';
    return {
      excType, implicated: inMessage, basis: 'message', traceback,
      message:
        `${raisedPhrase} The exception message references ${joinNames(inMessage)}, which `
        + `${plural ? 'were' : 'was'} sent as null — but ${why}. Setting a value for `
        + `${joinNames(inMessage)}, or omitting ${plural ? 'them' : 'it'} so the function's own default `
        + `applies, is the first thing to try.${seeTrace}`,
    };
  }

  // (c) Loom does not know which parameter is responsible — so it says so, and
  //     it distinguishes "I read the line and it is not there" from "I never
  //     had a line to read". Only the first is a negative FINDING; asserting
  //     the second would be a claim about evidence that was never obtained (R7).
  if (nullParams.length) {
    const plural = nullParams.length > 1;
    const those = plural ? 'Those' : 'That';
    const were = plural ? 'were' : 'was';
    if (frame.source) {
      return {
        excType, implicated: [], basis: 'none', traceback,
        message:
          `${raisedPhrase} Loom could not determine which parameter is responsible: the `
          + `line that raised${frame.fn ? ` (${frame.fn})` : ''} does not reference `
          + `${joinNames(nullParams)}, which ${were} sent as null. ${those} may or may not be `
          + `the cause — see the full traceback for the failing line.`,
      };
    }
    const why = frame.parsed
      ? `the runtime reported no source line for the frame that raised${frame.fn ? ` (${frame.fn})` : ''}`
      : 'no frame could be parsed from the traceback';
    return {
      excType, implicated: [], basis: 'none', traceback,
      message:
        `${raisedPhrase} Loom could not determine which parameter is responsible: ${why}, so it `
        + `could not check the failing line against ${joinNames(nullParams)}, which ${were} sent as `
        + `null. ${those} may or may not be the cause.${seeTrace}`,
    };
  }
  return {
    excType, implicated: [], basis: 'none', traceback,
    message: traceback
      ? `${raisedPhrase} See the full traceback for the failing line.`
      : raisedPhrase,
  };
}

// ── 2) Response shaping — the traceback is summarised, never destroyed ──────

export interface UdfFailureBody {
  /** What the surface shows first: the summary, or the raw body if unparsed. */
  body: string;
  /**
   * The raw interpreter traceback the summary was derived from, DECODED.
   * Absent when the runtime sent no traceback — the surface must not offer a
   * "full traceback" disclosure that would show something else instead.
   */
  detail?: string;
  /** How much weight the summary carries, so no caller has to guess. */
  attribution?: { basis: UdfRuntimeFailure['basis']; parameters: string[] };
}

/**
 * Build the failure fields of an invoke response.
 *
 * The previous shape was `body: friendly || text` — producing a summary
 * DESTROYED the traceback, leaving the user and support nothing to debug with
 * and no way to check the summary's claim. Both are returned now — except that
 * `detail` is the DECODED traceback, never the one-line escaped JSON envelope
 * the runtime actually put on the wire, and never a fabricated stand-in when
 * the runtime sent no traceback at all.
 */
export function udfFailureBody(
  text: string,
  parameters: Record<string, unknown>,
  functionName?: string,
): UdfFailureBody {
  const friendly = friendlyRuntimeError(text, parameters, functionName);
  if (!friendly) return { body: text };
  return {
    body: friendly.message,
    ...(friendly.traceback ? { detail: friendly.traceback } : {}),
    attribution: { basis: friendly.basis, parameters: friendly.implicated },
  };
}

// ── 3) Server-side parameter validation ─────────────────────────────────────

export interface InvokeParamError {
  error: string;
  hint: string;
  /** The parameter names the caller must fix. */
  invalidParameters: string[];
}

/**
 * Keys that ARE valid Python identifiers but are a JavaScript hazard class: the
 * parameters object is built and spread in JS before it is ever serialised, so
 * these names collide with `Object.prototype` machinery.
 *
 * They are rejected under their OWN message. Calling them "not valid Python
 * identifiers" was simply untrue — `def f(constructor)` is legal Python — and
 * an untrue error sends the reader looking for a syntax problem that is not
 * there (R7).
 */
const JS_HAZARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PY_IDENT_RE = /^[A-Za-z_]\w*$/;

/**
 * Shape validation, applied to EVERY caller before any backend request. The
 * runtime does `fn(**parameters)`, so a non-object body or a non-identifier key
 * can only ever produce an interpreter error — reject it here with a message
 * that names the offending key instead.
 */
export function validateInvokeParameters(
  raw: unknown,
): { parameters: Record<string, unknown> } | InvokeParamError {
  if (raw === undefined || raw === null) return { parameters: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error: '`parameters` must be a JSON object of name/value pairs.',
      hint: 'The runtime calls the function as fn(**parameters), so the body needs the shape '
        + '{"parameters": {"user_id": "u1", "weight": 2.5}}.',
      invalidParameters: [],
    };
  }
  const notIdentifiers: string[] = [];
  const hazards: string[] = [];
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    if (!PY_IDENT_RE.test(k)) notIdentifiers.push(k);
    else if (JS_HAZARD_KEYS.has(k)) hazards.push(k);
  }
  if (notIdentifiers.length) {
    return {
      error: `These parameter names are not valid Python identifiers: ${notIdentifiers.join(', ')}.`,
      hint: 'Parameter names are passed as keyword arguments, so each must match [A-Za-z_][A-Za-z0-9_]*.',
      invalidParameters: notIdentifiers,
    };
  }
  if (hazards.length) {
    return {
      error: `These parameter names are reserved by Loom because they collide with JavaScript object `
        + `internals: ${hazards.join(', ')}.`,
      hint: 'They are valid Python identifiers, but the invoke request is assembled in JavaScript, where '
        + 'these names address Object.prototype rather than your data. Rename the parameter (for example '
        + `${hazards[0]}_ or ${hazards[0]}_name) in the function signature and in the request.`,
      invalidParameters: hazards,
    };
  }
  return { parameters: { ...(raw as Record<string, unknown>) } };
}

/**
 * Signature validation — the server-side equivalent of what the Test panel
 * enforces client-side (issue #3574): a parameter with no declared default must
 * be supplied, and a blank one that DOES declare a default is omitted so the
 * function's own default applies, never sent as an explicit null.
 *
 * Only meaningful when the authored source is the code that will run (Loom
 * pushes it via `x-udf-source-b64`); against a deployed Function App the item's
 * source is not authoritative, so the caller must not apply this.
 *
 * NOTE: unknown/extra keys are deliberately NOT rejected. `parseUdfFunctions`
 * drops `*args` / `**kwargs` from the parsed signature, so a function that
 * legitimately accepts them would be falsely rejected. Python's own
 * "unexpected keyword argument" TypeError covers that case honestly.
 */
export function validateAgainstSignature(
  parameters: Record<string, unknown>,
  fn: UdfFunction | undefined,
): InvokeParamError | undefined {
  if (!fn) return undefined;
  const missing: string[] = [];
  const nulled: string[] = [];
  for (const p of fn.params) {
    const present = Object.prototype.hasOwnProperty.call(parameters, p.name);
    const declaresDefault = p.default != null && p.default !== '';
    // `= None` in the signature means null is exactly what the author asked for.
    const defaultIsNone = declaresDefault && /^none$/i.test(String(p.default).trim());
    if (!present) {
      if (!declaresDefault) missing.push(p.name);
      continue;
    }
    if (parameters[p.name] === null && !defaultIsNone) nulled.push(p.name);
  }
  if (missing.length) {
    return {
      error: `${fn.name} requires ${joinNames(missing)}, which ${missing.length > 1 ? 'were' : 'was'} not supplied.`,
      hint: `${fn.name} declares no default for ${joinNames(missing)}, so the runtime cannot call it. `
        + 'Send a value, or add a default in the function signature.',
      invalidParameters: missing,
    };
  }
  if (nulled.length) {
    return {
      error: `${joinNames(nulled)} ${nulled.length > 1 ? 'were' : 'was'} sent as null, which ${fn.name} does not declare as a default.`,
      hint: 'Send a real value, or omit the parameter entirely so the function\'s own default applies. '
        + 'An explicit null reaches the function as None and fails on the first arithmetic or string '
        + 'operation (issue #3574).',
      invalidParameters: nulled,
    };
  }
  return undefined;
}
