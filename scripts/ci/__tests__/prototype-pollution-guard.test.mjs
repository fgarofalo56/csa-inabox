/**
 * check-prototype-pollution.mjs — the guard's own tests.
 *
 * A guard nobody has seen go RED is not a control. Each rule is exercised on a
 * VIOLATING fixture and on the FIXED one, and each has a CONTROL fixture that
 * must stay green in both directions, so an over-broad rule is caught here
 * rather than by a wave of false failures in CI.
 *
 * The A_IMPORTED_PREDICATE case is the one that matters most: it is the exact
 * code #2773 shipped, and it must still be reported. That fix was correct at
 * runtime and CodeQL alert #374 stayed OPEN on the same head commit — so a
 * version of this guard that accepted it would be measuring nothing.
 *
 * Run: node --test scripts/ci/__tests__/prototype-pollution-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../check-prototype-pollution.mjs';

const { ruleAOnSource, ruleBOnSource, ruleC, computedWriteOn, DISMISSAL_REGISTER } = _internals;

// ── RULE A — dotted-path writers ───────────────────────────────────────────

/** The pre-#2773 shape: no guard at all. */
const A_UNGUARDED = `
function tokenize(path) { return path.split('.'); }
function setPath(obj, path, value) {
  const toks = tokenize(path);
  const root = { ...(obj || {}) };
  let cur = root;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (i === toks.length - 1) { cur[t] = value; break; }
    cur[t] = {};
    cur = cur[t];
  }
  return root;
}
`;

/** The #2773 shape: the right rule, expressed behind an import. */
const A_IMPORTED_PREDICATE = A_UNGUARDED.replace(
  'const t = toks[i];',
  'const t = toks[i];\n    if (isDangerousKey(t)) return obj;',
);

/** The shipped fix: local string literals. */
const A_LOCAL_LITERALS = A_UNGUARDED.replace(
  'const t = toks[i];',
  "const t = toks[i];\n    if (t === '__proto__' || t === 'constructor' || t === 'prototype') return obj;",
);

/** The stronger fix: a prototype-less target needs no denylist at all. */
const A_NULL_PROTO = `
function tokenize(path) { return path.split('.'); }
function setPath(obj, path, value) {
  const toks = tokenize(path);
  const root = safeRecord();
  let cur = root;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    cur[t] = value;
  }
  return root;
}
`;

/**
 * CONTROL — splits on '.' and writes a computed key, but the key is NOT a path
 * token. This is the shape that made the first draft of RULE A report 15 sites,
 * 14 of them destructures like this one.
 */
const A_CONTROL_DESTRUCTURE = `
function introspect(conn, rows) {
  const [defCatalog, defSchema] = (conn.database || '').split('.');
  const out = {};
  for (const r of rows) out[r.id] = defCatalog + defSchema;
  return out;
}
`;

test('RULE A fires on an unguarded dotted-path writer', () => {
  assert.equal(ruleAOnSource(A_UNGUARDED).length, 1);
});

test('RULE A STILL fires when the denylist is behind an imported predicate (#2773 / alert #374)', () => {
  assert.equal(ruleAOnSource(A_IMPORTED_PREDICATE).length, 1);
});

test('RULE A is silent once the literals are local', () => {
  assert.equal(ruleAOnSource(A_LOCAL_LITERALS).length, 0);
});

test('RULE A is silent on a prototype-less target (the stronger fix)', () => {
  assert.equal(ruleAOnSource(A_NULL_PROTO).length, 0);
});

test('CONTROL: a .split(".") destructure with an unrelated computed write is not a path writer', () => {
  assert.equal(ruleAOnSource(A_CONTROL_DESTRUCTURE).length, 0);
});

// ── RULE B — identifier-regex-gated writes ─────────────────────────────────

const B_PLAIN_LITERAL = `
function toProps(row) {
  const props = {};
  for (const [col, val] of Object.entries(row)) {
    if (/^[A-Za-z_][\\w]{0,62}$/.test(col)) props[col] = val;
  }
  return props;
}
`;

const B_SAFE_RECORD = B_PLAIN_LITERAL.replace('const props = {};', 'const props = safeRecord();');

/**
 * CONTROL — same write, gated by a regex whose first character class has no
 * `_`, so `__proto__` genuinely cannot reach the key. Widening RULE B to every
 * regex would drown the signal and get the guard switched off.
 */
const B_CONTROL_NO_UNDERSCORE = `
function toProps(row) {
  const props = {};
  for (const [col, val] of Object.entries(row)) {
    if (/^[A-Za-z][A-Za-z0-9]{0,62}$/.test(col)) props[col] = val;
  }
  return props;
}
`;

test('RULE B fires on a plain object literal behind an underscore-admitting identifier regex', () => {
  assert.equal(ruleBOnSource(B_PLAIN_LITERAL).length, 1);
});

test('RULE B is silent once the target is safeRecord()', () => {
  assert.equal(ruleBOnSource(B_SAFE_RECORD).length, 0);
});

test('CONTROL: a regex with no `_` in the first class cannot admit __proto__, so no finding', () => {
  assert.equal(ruleBOnSource(B_CONTROL_NO_UNDERSCORE).length, 0);
});

test('the premise: the repo regex accepts every prototype-slot key, the control regex does not', () => {
  const RE = /^[A-Za-z_][\w]{0,62}$/;
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']) {
    assert.equal(RE.test(k), true, `${k} should match the repo filter`);
  }
  assert.equal(/^[A-Za-z][A-Za-z0-9]{0,62}$/.test('__proto__'), false);
});

// ── the write matcher itself ───────────────────────────────────────────────

test('computedWriteOn matches a computed write', () => {
  assert.deepEqual(computedWriteOn('  out[key] = v;'), { base: 'out', key: 'key' });
});

test('computedWriteOn ignores a constant key — a literal is not injectable', () => {
  assert.equal(computedWriteOn("  out['mode'] = v;"), null);
  assert.equal(computedWriteOn('  out[0] = v;'), null);
});

test('computedWriteOn ignores array destructuring — the `[` there is not an index', () => {
  assert.equal(computedWriteOn('  const [a, b] = s.split(".");'), null);
});

test('computedWriteOn ignores a comparison and a comment', () => {
  assert.equal(computedWriteOn('  if (out[key] === v) return;'), null);
  assert.equal(computedWriteOn('  // out[key] = v'), null);
});

// ── RULE C — the dismissal register ────────────────────────────────────────

test('RULE C: every dismissed alert still has its justification in the working tree', () => {
  assert.deepEqual(ruleC(), []);
});

test('RULE C: each row names its kind, the exact construct it depends on, and a reason', () => {
  assert.ok(DISMISSAL_REGISTER.length > 0);
  for (const row of DISMISSAL_REGISTER) {
    assert.ok(['dismissal', 'adoption'].includes(row.kind), `${row.file} needs kind`);
    // A dismissal MUST carry the alert number — it is the only way back to the
    // finding if the justification ever stops being true. An adoption row is a
    // site CodeQL never reported, so there is no number to carry.
    if (row.kind === 'dismissal') assert.equal(typeof row.alert, 'number', `${row.file} needs an alert number`);
    else assert.equal(row.alert, null);
    assert.ok(row.requires instanceof RegExp, `${row.file} needs a RegExp`);
    assert.ok(row.why.length > 20, `${row.file} needs a stated reason`);
  }
});

test('RULE C: at least one row of each kind, so neither branch of the message is dead', () => {
  const kinds = new Set(DISMISSAL_REGISTER.map((r) => r.kind));
  assert.ok(kinds.has('dismissal'));
  assert.ok(kinds.has('adoption'));
});
