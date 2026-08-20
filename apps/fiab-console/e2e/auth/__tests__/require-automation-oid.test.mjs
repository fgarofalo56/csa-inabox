/**
 * requireAutomationOid — the session-minting chokepoint's own self-test (#3805).
 *
 * WHY THIS FILE EXISTS (the guard was unguarded)
 * ----------------------------------------------
 * #3804 removed the placeholder-oid fallback from 29 harnesses and funnelled all
 * 18 remaining minters through ONE function: `requireAutomationOid` in
 * e2e/auth/mint-cookie.mjs, mirrored in e2e/auth/mint-session.ts. That function
 * shipped with ZERO tests. The suite added alongside it covered
 * scripts/ci/resolve-automation-oid.mjs — a DIFFERENT module carrying a THIRD
 * copy of the same regex — so nothing anywhere executed the chokepoint.
 *
 * Proven by mutation before this file existed: reintroducing the fail-open at
 * mint-cookie.mjs left 45/45 tests passing, exit 0, while
 * `mintLoomSessionCookie({ name, upn })` minted a real cookie whose decoded
 * claims carried `oid: undefined`. The guard was fully defeated and no lane
 * noticed. That is `csa_loom_gates_that_measure_nothing` at the one place in the
 * repo where the verdict decides which Cosmos partition every automated write
 * lands in.
 *
 * WHAT THIS SUITE HAS TO PROVE, BEYOND "a placeholder throws"
 * -----------------------------------------------------------
 *   1. It can FAIL. Every rejection test is paired with an acceptance so a
 *      trivially-throwing guard cannot pass the suite, and `…001a` (twelve hex
 *      after the last dash, but not eleven zeros) is a standing negative control
 *      against an over-broad regex.
 *   2. PADDING does not bypass it. `"…0001 "` and `"…0001\r"` were ACCEPTED by
 *      the raw-string form of the check. GitHub does not trim repo-variable
 *      values and this repo already has `az -o tsv` / `gh --json` CR on record,
 *      so the padded placeholder is the form that actually arrives.
 *   3. The VALIDATED value is what gets sealed. Normalizing the check and then
 *      encrypting the raw claim would validate one string and ship another.
 *   4. The refusal happens BEFORE any cookie material exists — asserted by
 *      counting real crypto calls, not by trusting the throw.
 *   5. A MALFORMED oid is refused too. The chokepoint validated no SHAPE at all
 *      until the #3805 review: `"hello"`, `"1"`, `"<unset>"`, the literal string
 *      `"LOOM_AUTOMATION_OID"` and a comma-list were every one of them accepted
 *      and sealed, while `validateCandidate` in scripts/ci/resolve-automation-oid.mjs
 *      — the module beside it, in the same PR — rejected exactly those with a
 *      written rationale. Malformed debris is unreachable for the same reason
 *      placeholder debris is.
 *   6. The TypeScript twin cannot drift away from the .mjs implementation —
 *      including ASYMMETRICALLY, which is the drift assertions' whole job (see
 *      the note above them).
 *
 * No credential appears here: the HKDF input is generated per-run with
 * `crypto.randomBytes`, and every object id is obviously synthetic.
 *
 * Run: node --test apps/fiab-console/e2e/auth/__tests__/require-automation-oid.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  requireAutomationOid,
  mintLoomSessionCookie,
  decodeLoomSessionCookie,
  buildStorageState,
} from '../mint-cookie.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINT_COOKIE_MJS = path.join(HERE, '..', 'mint-cookie.mjs');
const MINT_SESSION_TS = path.join(HERE, '..', 'mint-session.ts');
/** The sibling module whose shape rule this chokepoint must agree with. */
const RESOLVER_MJS = path.join(HERE, '..', '..', '..', '..', '..', 'scripts', 'ci', 'resolve-automation-oid.mjs');

/** Obviously synthetic — the value never leaves this process. */
const REAL_OID = '11111111-2222-3333-4444-555555555555';

/**
 * A placeholder is all-zero except the final nibble. All three of these were
 * live in the tree before #3804, in three different harnesses, each writing to
 * a partition the other two could not see.
 */
const PLACEHOLDERS = [
  '00000000-0000-0000-0000-000000000000', // tests/*.mjs, demo-seed
  '00000000-0000-0000-0000-000000000001', // e2e-receipt, parity-autopilot
  '00000000-0000-0000-0000-00000000000e', // cleanup-test-workspaces
  '00000000-0000-0000-0000-00000000000E', // the same value, upper case
];

/**
 * NEGATIVE CONTROL. Twelve hex digits after the last dash, so it is the same
 * SHAPE as a placeholder — but the run of zeros is ten, not eleven, so it is a
 * perfectly ordinary (if unlikely) object id. A regex broadened to `0{10}` or to
 * `0+` would swallow it, and this suite would then be rejecting real identities
 * while reporting green. It must be ACCEPTED.
 */
const NOT_A_PLACEHOLDER = '00000000-0000-0000-0000-00000000001a';

/** A fresh HKDF input per run — never a committed constant. */
const secret = () => crypto.randomBytes(32).toString('hex');

// ───────────────────────────── absent identity ───────────────────────────────

test('an ABSENT oid is refused, in every shape absence arrives in', () => {
  const absent = [
    {},
    { oid: undefined },
    { oid: null },
    { oid: '' },
    { name: 'uat', upn: 'uat@automation' }, // the exact call the mutation minted under
  ];
  for (const claims of absent) {
    assert.throws(
      () => requireAutomationOid(claims),
      /claims\.oid is required/,
      `${JSON.stringify(claims)} must be refused`,
    );
  }
});

test('a WHITESPACE-ONLY oid is absence, not an identity', () => {
  // Pre-normalization this returned the string "   " — non-empty, not
  // placeholder-shaped, so it sailed through and became a partition key.
  for (const blank of ['   ', '\r\n', '\t', ' \r ']) {
    assert.throws(
      () => requireAutomationOid({ oid: blank }),
      /claims\.oid is required/,
      `${JSON.stringify(blank)} must be refused as absent`,
    );
  }
});

test('normalization does not WIDEN what is accepted — a falsy non-string is still absent', () => {
  // `?? ''` here instead of `|| ''` would turn these into "0" / "false" and let
  // them past the emptiness test the un-normalized code failed closed on.
  for (const falsy of [0, false, NaN]) {
    assert.throws(
      () => requireAutomationOid({ oid: falsy }),
      /claims\.oid is required/,
      `${String(falsy)} must be refused as absent`,
    );
  }
});

test('the absent-oid refusal names the variable an operator can actually set', () => {
  // deploy-integrity R6: a remediation, not a stack trace.
  const err = assertThrown(() => requireAutomationOid({}));
  assert.match(err.message, /UAT_OID|LOOM_AUTOMATION_OID/);
});

// ─────────────────────────── placeholder identity ────────────────────────────

test('every known placeholder is refused, in both cases', () => {
  for (const oid of PLACEHOLDERS) {
    assert.throws(
      () => requireAutomationOid({ oid }),
      /is a placeholder/,
      `${oid} must be refused`,
    );
  }
});

test('the placeholder refusal ECHOES the value, so the operator sees what was rejected', () => {
  const err = assertThrown(() => requireAutomationOid({ oid: PLACEHOLDERS[1] }));
  assert.ok(
    err.message.includes(PLACEHOLDERS[1]),
    'the refusal must name the offending value',
  );
});

test('NEGATIVE CONTROL: a real oid that merely LOOKS placeholder-ish is accepted', () => {
  // If this ever starts throwing, the regex has been broadened and the guard is
  // now refusing identities that name real principals.
  assert.equal(requireAutomationOid({ oid: NOT_A_PLACEHOLDER }), NOT_A_PLACEHOLDER);
});

test('an ordinary object id is accepted and returned unchanged', () => {
  assert.equal(requireAutomationOid({ oid: REAL_OID }), REAL_OID);
});

// ─────────────────────────── malformed identity ──────────────────────────────
//
// Until the #3805 review this chokepoint validated NO shape whatsoever. Every
// value below was ACCEPTED and sealed into a real cookie, while
// `validateCandidate` in scripts/ci/resolve-automation-oid.mjs — a module in the
// same PR, twenty lines of reasoning about why — rejected exactly these.
//
// The comma-list is the sharpest case: feature-gate.ts compares
// `session.claims.oid === LOOM_TENANT_ADMIN_OID` with strict equality, so "a,b"
// matches NEITHER a nor b. The run mints cleanly, silently drops to non-admin,
// and every admin-gated probe 403s — which then gets reported as an endpoint
// defect. A malformed oid is the same unreachable-partition debris a placeholder
// produces, reached by a different route.

/** Values a `-z`/non-empty test admits and an Entra directory has never seen. */
const MALFORMED = [
  'hello',
  'a,b',
  'not-a-guid-at-all',
  '1',
  '<unset>',
  'LOOM_AUTOMATION_OID',          // the NAME of the variable, not its value
  '${{ vars.LOOM_AUTOMATION_OID }}', // an unexpanded expression
  `${PLACEHOLDERS[1]},${REAL_OID}`, // the comma-list validateCandidate names
  `${REAL_OID}x`,                 // one character too long
  REAL_OID.replace(/-/g, ''),     // GUID digits, no dashes
];

test('a MALFORMED oid is refused — it names no Entra object', () => {
  for (const oid of MALFORMED) {
    assert.throws(
      () => requireAutomationOid({ oid }),
      /is not a GUID|is a comma-separated list/,
      `${JSON.stringify(oid)} must be refused — it is not an object id`,
    );
  }
});

test('a COMMA-LIST is refused by name, with the strict-equality reason', () => {
  // Pinned separately from the generic shape refusal because the two failures
  // need different remediations: "that is not an oid" vs "that is two oids".
  const err = assertThrown(() => requireAutomationOid({ oid: `${PLACEHOLDERS[1]},${REAL_OID}` }));
  assert.match(err.message, /comma-separated list/);
  assert.match(err.message, /strict\s+equality/);
});

test('the malformed refusal ECHOES the value and names the variable to set', () => {
  const err = assertThrown(() => requireAutomationOid({ oid: '<unset>' }));
  assert.ok(err.message.includes('<unset>'), 'the refusal must name the offending value');
  assert.match(err.message, /UAT_OID|LOOM_AUTOMATION_OID/);
});

test('PAIRED CONTROL: no legitimate GUID is refused by the shape check', () => {
  // Without this the test above would pass on a guard that rejects everything.
  // Case, the negative control, and padding all have to survive.
  const legitimate = [
    REAL_OID,
    REAL_OID.toUpperCase(),
    NOT_A_PLACEHOLDER,
    'A1B2C3D4-E5F6-4a7b-8c9d-0e1f2a3b4c5d',
    'deadbeef-dead-beef-dead-beefdeadbeef',
  ];
  for (const oid of legitimate) {
    assert.equal(requireAutomationOid({ oid }), oid, `${oid} must be accepted`);
  }
  assert.equal(requireAutomationOid({ oid: ` ${REAL_OID}\r\n` }), REAL_OID);
});

test('a malformed oid throws before ANY key is derived or cipher created', () => {
  const s = secret();
  for (const oid of ['hello', `${PLACEHOLDERS[1]},${REAL_OID}`]) {
    const r = countingCrypto(() =>
      mintLoomSessionCookie({ oid, name: 'uat', upn: 'uat@automation' }, 60, s),
    );
    assert.ok(r.threw, `${JSON.stringify(oid)} must be refused`);
    assert.equal(r.hkdf, 0, 'no key material may be derived for an unidentified principal');
    assert.equal(r.cipher, 0, `${JSON.stringify(oid)} produced cookie material`);
  }
});

// ──────────────────── BLOCKER 2: padding must not bypass ─────────────────────
//
// Measured on the raw-string form of this guard:
//
//     bare placeholder             -> refused
//     placeholder + trailing CR    -> ACCEPTED   <-- bypass
//     placeholder + trailing space -> ACCEPTED   <-- bypass
//     placeholder + leading space  -> ACCEPTED   <-- bypass
//     all-zeros    + trailing CR   -> ACCEPTED   <-- bypass
//
// The padded value then became the sealed claim — a FOURTH unreachable
// partition, which also fails `oid === LOOM_TENANT_ADMIN_OID` and so silently
// drops the run to non-admin.

test('a PADDED placeholder is refused — trailing space, leading space, CR, tab, CRLF', () => {
  const pads = [
    (v) => `${v} `,
    (v) => ` ${v}`,
    (v) => `  ${v}  `,
    (v) => `${v}\r`,
    (v) => `${v}\r\n`,
    (v) => `\t${v}\t`,
    (v) => `\n ${v} \r\n`,
  ];
  for (const oid of PLACEHOLDERS) {
    for (const pad of pads) {
      const padded = pad(oid);
      assert.throws(
        () => requireAutomationOid({ oid: padded }),
        /is a placeholder/,
        `${JSON.stringify(padded)} must be refused — padding is not a different identity`,
      );
    }
  }
});

test('a padded REAL oid is accepted and returned NORMALIZED, not raw', () => {
  // The pairing matters: without it the test above would pass on a guard that
  // simply rejects anything containing whitespace, and every CI run whose repo
  // variable carries a trailing newline would fail for the wrong reason.
  for (const padded of [` ${REAL_OID}`, `${REAL_OID} `, `${REAL_OID}\r`, `\t ${REAL_OID} \r\n`]) {
    assert.equal(
      requireAutomationOid({ oid: padded }),
      REAL_OID,
      `${JSON.stringify(padded)} must normalize to the bare oid`,
    );
  }
});

// ─────────── BLOCKER 2b: the sealed cookie carries the VALIDATED value ────────

test('mintLoomSessionCookie seals the NORMALIZED oid, not the raw claim', () => {
  const s = secret();
  const cookie = mintLoomSessionCookie(
    { oid: ` ${REAL_OID}\r`, name: 'uat', upn: 'uat@automation' },
    60,
    s,
  );
  const { claims } = decodeLoomSessionCookie(cookie, s);
  assert.equal(
    claims.oid,
    REAL_OID,
    'validating one string and encrypting another is a half fix — the partition key must be the value that was checked',
  );
  // The rest of the claims survive the reseal.
  assert.equal(claims.name, 'uat');
  assert.equal(claims.upn, 'uat@automation');
});

test('mintLoomSessionCookie does not MUTATE the caller\'s claims object', () => {
  const s = secret();
  const claims = { oid: `${REAL_OID} `, name: 'uat', upn: 'uat@automation' };
  mintLoomSessionCookie(claims, 60, s);
  assert.equal(claims.oid, `${REAL_OID} `, 'the guard reseals a copy; it must not rewrite the input');
});

test('buildStorageState carries the normalized oid through to the Playwright cookie', () => {
  const s = secret();
  const state = buildStorageState({
    baseUrl: 'https://example.invalid',
    claims: { oid: `${REAL_OID}\r\n`, name: 'uat', upn: 'uat@automation' },
    ttlSecs: 60,
    sessionSecret: s,
  });
  assert.equal(state.cookies.length, 1);
  const { claims } = decodeLoomSessionCookie(state.cookies[0].value, s);
  assert.equal(claims.oid, REAL_OID);
});

// ──────────── the refusal happens BEFORE any cookie material exists ───────────

/**
 * Count real `node:crypto` calls around a thunk. The default export of a builtin
 * is the CJS module object mint-cookie.mjs itself holds, so patching it here is
 * observed there — this measures the module under test, not a stand-in.
 */
function countingCrypto(fn) {
  const realHkdf = crypto.hkdfSync;
  const realCipher = crypto.createCipheriv;
  let hkdf = 0;
  let cipher = 0;
  crypto.hkdfSync = (...a) => { hkdf++; return realHkdf.apply(crypto, a); };
  crypto.createCipheriv = (...a) => { cipher++; return realCipher.apply(crypto, a); };
  try {
    let threw = null;
    try {
      fn();
    } catch (e) {
      threw = e;
    }
    return { hkdf, cipher, threw };
  } finally {
    crypto.hkdfSync = realHkdf;
    crypto.createCipheriv = realCipher;
  }
}

test('CONTROL: the crypto counter actually fires on a successful mint', () => {
  // Without this, the assertions below would be satisfied by a spy that is not
  // wired to anything — a guard with zero population.
  const s = secret();
  const r = countingCrypto(() =>
    mintLoomSessionCookie({ oid: REAL_OID, name: 'uat', upn: 'uat@automation' }, 60, s),
  );
  assert.equal(r.threw, null);
  assert.equal(r.hkdf, 1, 'a real mint derives exactly one key');
  assert.equal(r.cipher, 1, 'a real mint creates exactly one cipher');
});

test('an ABSENT oid throws before ANY key is derived or cipher created', () => {
  const s = secret();
  const r = countingCrypto(() =>
    mintLoomSessionCookie({ name: 'uat', upn: 'uat@automation' }, 60, s),
  );
  assert.ok(r.threw, 'mintLoomSessionCookie must refuse an absent oid');
  assert.match(r.threw.message, /claims\.oid is required/);
  assert.equal(r.hkdf, 0, 'no key material may be derived for an unidentified principal');
  assert.equal(r.cipher, 0, 'no cookie may be produced for an unidentified principal');
});

test('a PLACEHOLDER oid — bare and padded — throws before any cipher exists', () => {
  const s = secret();
  for (const oid of [PLACEHOLDERS[1], `${PLACEHOLDERS[1]} `, `${PLACEHOLDERS[0]}\r`]) {
    const r = countingCrypto(() =>
      mintLoomSessionCookie({ oid, name: 'uat', upn: 'uat@automation' }, 60, s),
    );
    assert.ok(r.threw, `${JSON.stringify(oid)} must be refused`);
    assert.match(r.threw.message, /is a placeholder/);
    assert.equal(r.cipher, 0, `${JSON.stringify(oid)} produced cookie material`);
  }
});

test('the identity refusal is NOT the secret refusal wearing a different hat', () => {
  // A test that only asserts "it throws" passes when SESSION_SECRET is what is
  // missing. Pin which guard fired, and pin the order.
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    const noSecret = assertThrown(() => mintLoomSessionCookie({ oid: REAL_OID }, 60));
    assert.match(noSecret.message, /SESSION_SECRET is required/);
  } finally {
    if (saved !== undefined) process.env.SESSION_SECRET = saved;
  }

  const badOid = assertThrown(() => mintLoomSessionCookie({ oid: PLACEHOLDERS[1] }, 60, secret()));
  assert.match(badOid.message, /is a placeholder/);
  assert.doesNotMatch(badOid.message, /SESSION_SECRET/);
});

// ───────────────────── the TypeScript twin must not drift ────────────────────
//
// mint-session.ts deliberately imports nothing (importing lib/auth/session.ts
// pulls in `next/headers`, which throws outside the Next runtime), so it carries
// a second copy of this guard. It cannot be executed from node:test on the CI
// node version, so what is enforced here is that it stays IDENTICAL to the copy
// that IS executed above. Every behaviour proven for the .mjs is inherited by
// the .ts only for as long as these assertions hold.
//
// WHICH GAP THESE CLOSE, stated precisely (an earlier disclosure had it backwards).
//
//   CONSISTENT-BUT-WRONG (both files edited the same way) is NOT the gap. It is
//   caught, because the .mjs is actually EXECUTED: broadening `0{11}` to `0{10}`
//   in BOTH files takes the suite to RC=1 with 6 failures — five behavioural
//   (placeholders stop being refused) plus the population control embedded in
//   the placeholder-regex drift test, which exercises the literal it extracted.
//
//   The gap is ASYMMETRIC drift — a .ts-only edit. Nothing in this file executes
//   mint-session.ts, so the ONLY thing that can notice is a source assertion
//   here, and it notices exactly what it names. That is why these pin the
//   BRANCHES as well as the regexes, the normalization and the seal: measured at
//   the #3805 review, `if (!oid)` -> `if (false)` and
//   `if (PLACEHOLDER_OID.test(oid))` -> `if (false)` in mint-session.ts ALONE
//   left the suite at 21/21, RC=0 — both enforcement branches of live code
//   (global-setup.ts -> mintStorageState, _lib/uat.ts, tests/e2e/_shared.ts)
//   deleted with no verdict moving anywhere.
//
//   A source assertion pins the SHAPE it names and nothing else. Anything about
//   mint-session.ts these needles do not mention is unpinned.

/**
 * Both files are read with CR stripped. `.gitattributes` does not pin these
 * paths, so they carry CRLF on a Windows checkout and LF in CI — and a needle
 * written as `\n  return oid;\n}` then matches in one place and silently no-ops
 * in the other (`csa_loom_crlf_makes_mutation_needles_silently_noop`). This
 * suite caught exactly that on its first run.
 */
const mjsSrc = fs.readFileSync(MINT_COOKIE_MJS, 'utf8').replace(/\r/g, '');
const tsSrc = fs.readFileSync(MINT_SESSION_TS, 'utf8').replace(/\r/g, '');

/** Every `/^0{8}-…/` literal in a file. */
const placeholderLiterals = (src) =>
  src.match(/\/\^0\{8\}[^/\n]*\/[gimsuy]*/g) ?? [];

/** Every `/^[0-9a-fA-F]{8}-…/` literal in a file. */
const guidLiterals = (src) =>
  src.match(/\/\^\[0-9a-fA-F\]\{8\}[^/\n]*\/[gimsuy]*/g) ?? [];

/** The normalization expression, whitespace-collapsed. */
const normalizeExpr = (src) => {
  const m = src.match(/const oid = String\([^;]*?\.trim\(\);/s);
  return m ? m[0].replace(/\s+/g, ' ') : null;
};

test('DRIFT: both files carry exactly one placeholder regex, and it is the same one', () => {
  const a = placeholderLiterals(mjsSrc);
  const b = placeholderLiterals(tsSrc);
  // Population control first — a comparison of two empty lists proves nothing.
  assert.equal(a.length, 1, `mint-cookie.mjs must carry exactly one placeholder regex, found ${a.length}`);
  assert.equal(b.length, 1, `mint-session.ts must carry exactly one placeholder regex, found ${b.length}`);
  assert.equal(b[0], a[0], 'the twin regexes have diverged');
  // And it is the regex this suite actually exercised.
  const live = new RegExp(a[0].slice(1, a[0].lastIndexOf('/')), a[0].slice(a[0].lastIndexOf('/') + 1));
  for (const oid of PLACEHOLDERS) assert.ok(live.test(oid), `${oid} must match the shared regex`);
  assert.ok(!live.test(NOT_A_PLACEHOLDER), 'the shared regex must not match the negative control');
});

test('DRIFT: both files normalize the oid with the same expression', () => {
  const a = normalizeExpr(mjsSrc);
  const b = normalizeExpr(tsSrc);
  assert.ok(a, 'mint-cookie.mjs no longer normalizes claims.oid before testing it');
  assert.ok(b, 'mint-session.ts no longer normalizes claims.oid before testing it');
  assert.match(a, /\.replace\(\/\\r\/g, ''\)/, 'CR must be stripped, not merely trimmed');
  assert.equal(b, a, 'the twin normalization expressions have diverged');
});

test('DRIFT: both files seal the VALIDATED oid rather than the raw claim', () => {
  const seal = /\{ \.\.\.claims, oid: requireAutomationOid\(claims\) \}/;
  assert.match(mjsSrc, seal, 'mint-cookie.mjs must seal the guard\'s return value');
  assert.match(tsSrc, seal, 'mint-session.ts must seal the guard\'s return value');
  // The half-fix shape: calling the guard purely for its throw.
  assert.doesNotMatch(mjsSrc, /^\s*requireAutomationOid\(claims\);\s*$/m);
  assert.doesNotMatch(tsSrc, /^\s*requireAutomationOid\(claims\);\s*$/m);
});

test('DRIFT: both guards still return a value (a void guard silently un-fixes 2b)', () => {
  for (const [name, src] of [['mint-cookie.mjs', mjsSrc], ['mint-session.ts', tsSrc]]) {
    assert.match(src, /\n {2}return oid;\n\}/, `${name} must return the normalized oid`);
  }
});

test('DRIFT: both files still BRANCH on absence, malformation and the placeholder regex', () => {
  // The four assertions above pin the regex LITERAL, the normalization
  // EXPRESSION, the SEAL, and "it returns a value" — none of which is the
  // enforcement. Deleting the `if`s leaves every one of those needles intact,
  // which is exactly what happened: two one-file mutations of mint-session.ts
  // passed 21/21, RC=0, in the isolated suite AND in the full guardrails runner.
  for (const [name, src] of [['mint-cookie.mjs', mjsSrc], ['mint-session.ts', tsSrc]]) {
    assert.match(src, /\n {2}if \(!oid\) \{\n/, `${name} no longer refuses an absent oid`);
    assert.match(src, /\n {2}if \(oid\.includes\(','\)\) \{\n/, `${name} no longer refuses a comma-list`);
    assert.match(src, /\n {2}if \(!GUID_RE\.test\(oid\)\) \{\n/, `${name} no longer tests the GUID shape`);
    assert.match(
      src,
      /\n {2}if \(PLACEHOLDER_OID\.test\(oid\)\) \{\n/,
      `${name} no longer tests the placeholder regex`,
    );
  }
});

test('DRIFT: both files carry exactly one GUID-shape regex, and it is the same one', () => {
  const a = guidLiterals(mjsSrc);
  const b = guidLiterals(tsSrc);
  assert.equal(a.length, 1, `mint-cookie.mjs must carry exactly one GUID regex, found ${a.length}`);
  assert.equal(b.length, 1, `mint-session.ts must carry exactly one GUID regex, found ${b.length}`);
  assert.equal(b[0], a[0], 'the twin GUID regexes have diverged');
  // Population control: exercise the literal that was actually found, so an
  // assertion comparing two identically-broken regexes cannot pass silently.
  const live = new RegExp(a[0].slice(1, a[0].lastIndexOf('/')), a[0].slice(a[0].lastIndexOf('/') + 1));
  assert.ok(live.test(REAL_OID), 'the shared GUID regex must accept an ordinary object id');
  assert.ok(live.test(NOT_A_PLACEHOLDER), 'the shared GUID regex must accept the negative control');
  for (const bad of ['hello', 'a,b', '1', `${REAL_OID}x`]) {
    assert.ok(!live.test(bad), `the shared GUID regex must reject ${JSON.stringify(bad)}`);
  }
  // And it is the SAME rule scripts/ci/resolve-automation-oid.mjs applies. Two
  // copies of a shape rule that disagree is `csa_loom_guard_adoption_gap`, and
  // that module rejecting `"a,b"` while the chokepoint sealed it is how this
  // asymmetry was found in the first place.
  const resolver = guidLiterals(fs.readFileSync(RESOLVER_MJS, 'utf8').replace(/\r/g, ''));
  assert.equal(resolver.length, 1, `resolve-automation-oid.mjs must carry exactly one GUID regex, found ${resolver.length}`);
  assert.equal(resolver[0], a[0], 'the CI resolver and the mint chokepoint disagree on what a GUID is');
});

// ─────────────────────────────── helpers ─────────────────────────────────────

/** Run `fn`, assert it threw, and hand back the error for inspection. */
function assertThrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail('expected a throw, got a clean return');
}
