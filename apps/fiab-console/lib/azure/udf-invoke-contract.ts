/**
 * udf-invoke-contract — the request/response contract for
 * `POST /api/items/user-data-function/<id>/invoke`, kept as pure functions so
 * vitest can exercise it without booting the route's Azure/Cosmos graph.
 *
 * Two jobs, both of them about telling the truth:
 *
 * 1. `friendlyRuntimeError()` — translate a Python traceback into a summary a
 *    user can act on WITHOUT asserting a cause the code never established
 *    (.claude/rules/deploy-integrity.md R7). The first cut of this helper
 *    blamed whichever parameter happened to be `null` in the outgoing payload:
 *
 *        if (/NoneType/.test(excMsg)) { name every param whose value === null }
 *
 *    That is a CORRELATION, not an attribution. `f(a=None, b=5)` that ignores
 *    `a` entirely and raises `NoneType` deep inside a library call on unrelated
 *    internal state got the message "The function failed because a was not
 *    provided" — so the user fixes `a`, reruns, and fails identically. That is
 *    the exact shape of the incident R7 was written about (a roll that reported
 *    "the tag does not exist" when the truth was "I could not reach the
 *    registry"). Attribution here is therefore EARNED:
 *
 *      basis 'interpreter' — Python itself named the argument (a "missing N
 *                            required positional argument: 'x'" TypeError).
 *      basis 'frame'       — the parameter's name appears in the frame that
 *                            actually raised (or in the exception message), AND
 *                            it was sent as null.
 *      basis 'none'        — Loom does not know. The message SAYS it does not
 *                            know, lists the nulls as unproven candidates, and
 *                            points at the traceback.
 *
 *    The raw traceback is never destroyed: the route returns it alongside the
 *    summary (`detail`) so support and the user can still debug the real frame.
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
  basis: 'interpreter' | 'frame' | 'none';
}

/** Python names a value-less parameter itself in these two TypeError shapes. */
const MISSING_ARGS_RE = /missing \d+ required (?:positional|keyword-only) arguments?:\s*(.+)$/;
const UNEXPECTED_KW_RE = /got an unexpected keyword argument '([^']+)'/;

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
 * and its source-context lines. This — not the whole body — is what a parameter
 * name has to appear in before Loom will name it as the cause.
 */
function raisingFrame(lines: string[]): { fn?: string; source: string } {
  let hdr = -1;
  for (let i = 0; i < lines.length; i++) if (/^\s+File\s+"/.test(lines[i])) hdr = i;
  if (hdr < 0) return { source: '' };
  const fn = lines[hdr].match(/,\s*in\s+(.+?)\s*$/)?.[1];
  const ctx: string[] = [];
  for (let i = hdr + 1; i < lines.length; i++) {
    if (!/^\s/.test(lines[i])) break; // the exception line / a chaining note
    if (/^\s+File\s+"/.test(lines[i])) break;
    ctx.push(lines[i]);
  }
  return { fn, source: ctx.join('\n') };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Translate a non-2xx runtime body into an actionable summary
 * (.claude/rules/deploy-integrity.md R6), without asserting an unestablished
 * cause (R7).
 *
 * Returns `undefined` when the body is not a recognizable Python traceback, so
 * callers forward it unchanged.
 */
export function friendlyRuntimeError(
  rawText: string,
  parameters: Record<string, unknown>,
): UdfRuntimeFailure | undefined {
  if (!/Traceback \(most recent call last\)/.test(String(rawText || ''))) return undefined;
  const lines = String(rawText).split(/\r?\n/);
  const exc = parseException(lines);
  const excType = exc?.type || 'Error';
  const excMsg = exc?.message || '';
  const raised = `${excType}${excMsg ? `: ${excMsg}` : ''}`;
  const frame = raisingFrame(lines);
  // Python's own argument errors name the callee ("compute_score() missing …").
  // The LAST traceback frame is the function that RAISED, which for a wrapper
  // or library failure is NOT the callee — so the two are never interchanged.
  const callee = excMsg.match(/^([A-Za-z_]\w*)\(\)/)?.[1];
  const calleeLabel = callee || 'The function';

  // (a) Python named the arguments itself. Nothing to infer.
  const missing = excMsg.match(MISSING_ARGS_RE);
  if (missing) {
    const names = quotedNames(missing[1]);
    if (names.length) {
      const plural = names.length > 1;
      return {
        excType,
        implicated: names,
        basis: 'interpreter',
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
      excType,
      implicated: [unexpected[1]],
      basis: 'interpreter',
      message:
        `${calleeLabel} does not accept a parameter named ${unexpected[1]}. Python reported "${raised}". `
        + `Remove ${unexpected[1]} from the request, or add it to the function signature.`,
    };
  }

  // (b) A null-valued parameter whose name the RAISING FRAME actually
  //     references. "Sent as null" alone is not evidence and never was.
  const nullParams = Object.entries(parameters || {})
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const haystack = `${frame.source}\n${excMsg}`;
  const implicated = nullParams.filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(haystack));
  const inFrame = frame.fn ? ` — in ${frame.fn} —` : '';
  if (implicated.length) {
    const plural = implicated.length > 1;
    return {
      excType,
      implicated,
      basis: 'frame',
      message:
        `The function raised ${raised}. The line that raised${inFrame} references `
        + `${joinNames(implicated)}, which ${plural ? 'were' : 'was'} sent as null. Set a value for `
        + `${joinNames(implicated)}, or omit ${plural ? 'them' : 'it'} so the function's own default `
        + 'applies, and run again.',
    };
  }

  // (c) Loom does not know which parameter is responsible — so it says so.
  //     Nulls are listed as UNPROVEN candidates, never as the cause.
  if (nullParams.length) {
    const plural = nullParams.length > 1;
    return {
      excType,
      implicated: [],
      basis: 'none',
      message:
        `The function raised ${raised}. Loom could not determine which parameter is responsible: the `
        + `frame that raised${frame.fn ? ` (${frame.fn})` : ''} does not reference ${joinNames(nullParams)}, `
        + `which ${plural ? 'were' : 'was'} sent as null. ${plural ? 'Those' : 'That'} may or may not be `
        + 'the cause — see the full traceback for the failing line.',
    };
  }
  return {
    excType,
    implicated: [],
    basis: 'none',
    message: `The function raised ${raised}. See the full traceback for the failing line.`,
  };
}

// ── 2) Response shaping — the traceback is summarised, never destroyed ──────

export interface UdfFailureBody {
  /** What the surface shows first: the summary, or the raw body if unparsed. */
  body: string;
  /** The raw interpreter output the summary was derived from. */
  detail?: string;
  /** How much weight the summary carries, so no caller has to guess. */
  attribution?: { basis: UdfRuntimeFailure['basis']; parameters: string[] };
}

/**
 * Build the failure fields of an invoke response.
 *
 * The previous shape was `body: friendly || text` — producing a summary
 * DESTROYED the traceback, leaving the user and support nothing to debug with
 * and no way to check the summary's claim. Both are returned now.
 */
export function udfFailureBody(text: string, parameters: Record<string, unknown>): UdfFailureBody {
  const friendly = friendlyRuntimeError(text, parameters);
  if (!friendly) return { body: text };
  return {
    body: friendly.message,
    detail: text,
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

/** Keys that are never legitimate Python kwargs and are a known JS hazard class. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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
  const bad: string[] = [];
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k) || !PY_IDENT_RE.test(k)) bad.push(k);
  }
  if (bad.length) {
    return {
      error: `These parameter names are not valid Python identifiers: ${bad.join(', ')}.`,
      hint: 'Parameter names are passed as keyword arguments, so each must match [A-Za-z_][A-Za-z0-9_]*.',
      invalidParameters: bad,
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
