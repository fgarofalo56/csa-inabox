// Self-test for check-bff-errors.mjs RULE 3 + the three standalone-app
// exception sanitizers it enforces.
//
// Run: node --test scripts/ci/__tests__/bff-errors-rule3.test.mjs
// (wired into .github/workflows/loom-guardrails.yml — a test nobody runs is
// the same class of defect as a gate that measures nothing.)
//
// WHAT THIS PINS
//   1. RULE 3 DETECTS every shape that turns a caught exception into text.
//      Without these, the guard is a scan that reports OK on the leak it was
//      written for — the exact failure mode this repo keeps hitting.
//   2. RULE 3 DOES NOT FIRE on the near-miss shapes that live in the real
//      tree today (an `e` that is an env bag, a `.message` read off a
//      JSON-RPC response, a bindingless `catch`, a commented-out leak).
//      These are CONTROLS: they must pass whether or not RULE 3 exists, so an
//      over-broad rewrite of the rule is caught here rather than by a wave of
//      spurious CI failures.
//   3. The SCOPE is non-empty and is the set we think it is. A guard whose
//      discovery quietly returns [] passes forever while measuring nothing.
//   4. The sanitizers genericize the message AND still log the detail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rule3Violations, standaloneHttpApps, maskNonCode, errorHandlerBlocks } from '../check-bff-errors.mjs';
import {
  publicErrorMessage as bridgeMessage,
  publicRpcError,
  logSafe as bridgeLogSafe,
} from '../../../apps/fiab-mcp-bridge/src/safe-error.mjs';
import {
  publicErrorMessage as onelakeMessage,
  logSafe as onelakeLogSafe,
  BadRequestError,
  isBadRequest,
} from '../../../apps/loom-onelake/src/safe-error.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const F = 'apps/demo-app/src/handler.ts';

// ── 1. RULE 3 detects the leak shapes ──────────────────────────────────────

const LEAKS = [
  ['catch (e) { .message }', 'try { go(); } catch (e) { return { error: e.message }; }'],
  ['catch (e: any) { ?.message }', 'try { go(); } catch (e: any) { return { error: e?.message }; }'],
  ['catch (e) { String(e) }', 'try { go(); } catch (e) { return { error: String(e) }; }'],
  ['catch (e) { .stack }', 'try { go(); } catch (e) { return { error: e.stack }; }'],
  ['catch (e) { JSON.stringify(e) }', 'try { go(); } catch (e) { return { error: JSON.stringify(e) }; }'],
  ['catch (e) { `${e}` }', 'try { go(); } catch (e) { return { error: `failed: ${e}` }; }'],
  ['catch (e) { e.toString() }', 'try { go(); } catch (e) { return { error: e.toString() }; }'],
  ['catch (e) { (e as Error).message }', 'try { go(); } catch (e) { return { error: (e as Error).message }; }'],
  ['.catch((e) => …)', 'p().catch((e) => { send(res, 500, { error: e?.message }); });'],
  ['.catch(e => …)', 'p().catch(e => { send(res, 500, { error: String(e) }); });'],
  // Laundering: wrapping the raw text in a "public" error is still the leak.
  ['launder via a wrapper error', 'try { go(); } catch (e) { throw new PublicError(`upstream: ${e.message}`); }'],
  // A different binding name must be tracked, not a hardcoded `e`.
  ['non-`e` binding', 'try { go(); } catch (problem) { return { error: problem.message }; }'],
];

for (const [name, src] of LEAKS) {
  test(`RULE 3 detects: ${name}`, () => {
    const hits = rule3Violations(F, src);
    assert.ok(hits.length > 0, `expected a violation for: ${src}`);
    assert.equal(typeof hits[0].line, 'number');
  });
}

// ── 2. CONTROLS — must stay clean (they pass with OR without RULE 3) ───────

const CONTROLS = [
  // The real shape in apps/loom-onelake/src/resolver.mjs: `e` is the ENV bag,
  // not a caught error. A rule that keys on the identifier name flags this.
  ['`e` is a function param, not a catch binding',
    'function isGov(e) { return String(e.AZURE_CLOUD || "").includes("usgov") || String(e.LOOM_CLOUD).length > 0; }'],
  // The real shape in apps/fiab-mcp-bridge/src/stdio-client.mjs:95 — reading
  // `.message` off a JSON-RPC response object, inside no catch at all.
  ['`.message` off a non-error object',
    'if (msg.error) p.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`));'],
  // The real shape in stdio-client.mjs:88 — nothing is in scope to leak.
  ['bindingless catch', 'try { msg = JSON.parse(line); } catch { logger.error("non-JSON line"); continue; }'],
  // The sanctioned fix.
  ['publicErrorMessage(e, literal)',
    'try { go(); } catch (e) { return { error: publicErrorMessage(e, "The call failed.") }; }'],
  // Re-raising is not publishing.
  ['bare re-raise / reject', 'try { go(); } catch (e) { clearTimeout(t); reject(e); }'],
  // Masking: a leak that is only in a comment or a quoted string is not code.
  ['leak inside a line comment', 'try { go(); } catch (e) { /* was: e.message */ return null; }\n// catch (e) { return e.message }'],
  ['leak inside a quoted string', 'try { go(); } catch (e) { return { error: "e.message is not read here" }; }'],
  // A catch binding used only for a type test.
  ['instanceof only', 'try { go(); } catch (e) { if (e instanceof RangeError) return null; throw e; }'],
];

for (const [name, src] of CONTROLS) {
  test(`RULE 3 control (clean both ways): ${name}`, () => {
    assert.deepEqual(rule3Violations(F, src), [], `unexpected violation for: ${src}`);
  });
}

test('RULE 3 exempts the sanitizer module itself', () => {
  const leak = 'try { go(); } catch (e) { const detail = e.stack || e.message; console.error(detail); }';
  assert.ok(rule3Violations('apps/demo-app/src/handler.mjs', leak).length > 0);
  assert.deepEqual(rule3Violations('apps/demo-app/src/safe-error.mjs', leak), []);
  assert.deepEqual(rule3Violations('apps/demo-app/src/safe-error.ts', leak), []);
});

// ── 3. SCOPE — the discovery must not silently return nothing ──────────────

test('standaloneHttpApps() discovers the real non-Next HTTP apps', () => {
  const names = standaloneHttpApps(path.join(REPO_ROOT, 'apps')).map((a) => a.name).sort();
  // Non-empty is the load-bearing assertion: an empty scope makes RULE 3 a
  // gate that cannot fail. The named set is the current reality — adding a new
  // standalone HTTP app is expected to update it (and to be covered by RULE 3).
  assert.ok(names.length >= 3, `expected >=3 standalone HTTP apps, got ${JSON.stringify(names)}`);
  for (const expected of ['copilot-maf', 'fiab-mcp-bridge', 'loom-onelake']) {
    assert.ok(names.includes(expected), `${expected} missing from RULE 3 scope: ${JSON.stringify(names)}`);
  }
  // fiab-console is Next.js — RULES 1-2 own it; double-scanning it would
  // produce noise on ~1950 route files.
  assert.ok(!names.includes('fiab-console'));
  // Each in-scope app must actually contribute files to scan.
  for (const app of standaloneHttpApps(path.join(REPO_ROOT, 'apps'))) {
    assert.ok(app.files.length > 0, `${app.name} contributed 0 files`);
  }
});

test('maskNonCode preserves length and line positions', () => {
  const src = 'a\n// e.message\n"e.stack"\nb';
  const masked = maskNonCode(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.ok(!masked.includes('e.message'));
  assert.ok(!masked.includes('e.stack'));
});

test('errorHandlerBlocks does not latch onto a distant brace', () => {
  // `.catch(() => null)` has no block; the next `{` belongs to something else
  // entirely and must not be treated as the handler body.
  const src = 'p().catch(() => null);\nfunction other(e) { return e.message; }';
  assert.deepEqual(rule3Violations(F, src), []);
  assert.deepEqual(errorHandlerBlocks(maskNonCode(src)), []);
});

// ── 4. The sanitizers ──────────────────────────────────────────────────────

function captureConsoleError(fn) {
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.map(String).join(' '));
  try {
    return { result: fn(), logged: seen };
  } finally {
    console.error = orig;
  }
}

for (const [label, publicErrorMessage] of [['mcp-bridge', bridgeMessage], ['loom-onelake', onelakeMessage]]) {
  test(`${label} publicErrorMessage: returns the literal + a ref, never the exception text`, () => {
    const err = new Error('ENOENT /app/node_modules/.bin/uvx — spawn failed for tenant 00000000-aaaa');
    const { result, logged } = captureConsoleError(() => publicErrorMessage(err, 'The bridged call failed.'));
    assert.match(result, /^The bridged call failed\. \(ref: [0-9a-f]{8}\)$/);
    assert.ok(!result.includes('ENOENT'));
    assert.ok(!result.includes('/app/node_modules'));
    assert.ok(!result.includes('00000000-aaaa'));
    // The detail is not swallowed — it is logged against the SAME ref, which is
    // the only reason genericizing the response is acceptable.
    const ref = result.match(/\(ref: ([0-9a-f]{8})\)/)[1];
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes(ref), 'log line must carry the ref');
    assert.ok(logged[0].includes('ENOENT'), 'log line must carry the real detail');
  });

  test(`${label} publicErrorMessage: non-Error throwables leak nothing either`, () => {
    const { result } = captureConsoleError(() => publicErrorMessage('conn=Server=x;Password=hunter2', 'Nope.'));
    assert.match(result, /^Nope\. \(ref: [0-9a-f]{8}\)$/);
    assert.ok(!result.includes('hunter2'));
  });

  test(`${label} publicErrorMessage: default fallback is generic`, () => {
    const { result } = captureConsoleError(() => publicErrorMessage(new Error('boom')));
    assert.match(result, /^internal error \(ref: [0-9a-f]{8}\)$/);
  });
}

test('mcp-bridge publicRpcError keeps the JSON-RPC shape and the -32000 code', () => {
  const { result } = captureConsoleError(() => publicRpcError(new Error('spawn EACCES'), 'Tool call failed'));
  assert.equal(result.code, -32000);
  assert.match(result.message, /^Tool call failed \(ref: [0-9a-f]{8}\)$/);
  assert.ok(!result.message.includes('EACCES'));
});

test('loom-onelake BadRequestError is class-tagged, not string-matched', () => {
  const bad = new BadRequestError('invalid JSON body');
  assert.ok(isBadRequest(bad));
  assert.ok(!isBadRequest(new Error('invalid JSON body')));
  assert.ok(!isBadRequest(undefined));
  assert.ok(!isBadRequest(null));
});

// ── 5. logSafe — the log-forging defence on the logging the sanitizer owns ──
//
// Concentrating every app's error logging into publicErrorMessage also
// concentrated the SINK. CodeQL js/log-injection traced request body →
// `message.method` → `new Error(\`timeout … calling ${method}\`)` → the
// console.error inside the sanitizer, so a method name containing CR/LF forges
// log records. These assert the mirror of lib/util/log-safe.ts actually strips.

for (const [label, logSafe] of [['mcp-bridge', bridgeLogSafe], ['loom-onelake', onelakeLogSafe]]) {
  test(`${label} logSafe: strips CR/LF so a forged record cannot be injected`, () => {
    const forged = 'boom\n2026-08-02 [info] admin login succeeded\r\n';
    const out = logSafe(forged);
    assert.ok(!/[\r\n]/.test(out), 'no line breaks may survive');
    // Not redaction — the text stays readable, only the framing is removed.
    assert.ok(out.includes('boom'));
    assert.ok(out.includes('admin login succeeded'));
  });

  test(`${label} logSafe: strips NUL/TAB/DEL and other C0 controls`, () => {
    const out = logSafe('a\u0000b\u0009c\u007Fd\u001Fe');
    assert.equal(out, 'a b c d e');
  });

  test(`${label} logSafe: bounds the length`, () => {
    const out = logSafe('x'.repeat(5000));
    assert.ok(out.length <= 2003, `expected <=2003 chars, got ${out.length}`);
    assert.ok(out.endsWith('...'));
  });

  test(`${label} logSafe: null/undefined are a plain empty string`, () => {
    assert.equal(logSafe(null), '');
    assert.equal(logSafe(undefined), '');
  });

  test(`${label} logSafe: the control class is not literal control characters`, () => {
    // The console original writes this class with LITERAL control characters,
    // which are invisible in an editor and survive a mangling copy/paste as
    // something else entirely — the sanitizer keeps compiling and keeps
    // returning a string while silently sanitizing nothing. Assert the
    // BEHAVIOUR that mangling would break, on a character in the middle of the
    // range rather than at either end.
    assert.equal(logSafe('a\u000Bb'), 'a b');
  });
}

test('publicErrorMessage runs the logged detail through logSafe', () => {
  const err = new Error('boom\nFORGED [info] nothing to see here');
  const { logged } = captureConsoleError(() => bridgeMessage(err, 'Failed.'));
  assert.equal(logged.length, 1);
  assert.ok(!/\n/.test(logged[0]), 'the emitted log line must be a single line');
  assert.ok(logged[0].includes('FORGED'), 'the text is flattened, not redacted');
});
