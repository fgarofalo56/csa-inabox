#!/usr/bin/env node
/**
 * external-origin-urls — MUTATION PROOFS. (refs #3442, #3443, #3467, #3468)
 *
 * The point of this file is that the guard must be shown able to catch the
 * incidents it was written for. #3468 exists because the previous version's
 * five controls all modelled the two-argument `new URL(x, req.url)` form, so
 * they passed on a tree carrying a live ONE-argument defect — the control
 * population confirmed the guard worked while excluding the case it missed.
 *
 * So the proofs below re-break the two REAL routes #3500 fixed, in both shapes:
 * the direct single-argument form and the form laundered through a helper that
 * takes a plain `string`, where no request identifier is anywhere near the
 * `new URL`. If either mutation leaves the guard green, the guard is blind.
 *
 * Run: node --test scripts/ci/__tests__/external-origin-urls.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  findViolations,
  maskNonCode,
  readArgs,
  matchBracket,
  selfTest,
  CONTROLS,
  TOUCH_EXEMPT,
  collect,
} from '../check-external-origin-urls.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'ci', 'check-external-origin-urls.mjs');
const BASELINE = path.join(REPO_ROOT, 'scripts', 'ci', 'external-origin-urls-baseline.json');

const app = (...p) => path.join(REPO_ROOT, 'apps', 'fiab-console', ...p);
const ICEBERG_CONNECT = app('app', 'api', 'catalog', 'iceberg', 'connect', 'route.ts');
const LAKEHOUSE_INTEROP = app('app', 'api', 'lakehouse', 'interop', 'route.ts');
const FLIGHTSQL_CONNECT = app('app', 'api', 'flightsql', 'connect', 'route.ts');

/** @returns {{code:number, out:string}} — the guard's real exit code and log. */
function run() {
  try {
    const out = execFileSync(process.execPath, [GUARD], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Apply a one-string mutation to a real file, run the guard, restore. The
 * assertion that the mutation APPLIED is not decoration: a replace() that
 * matched nothing would leave the tree clean and the test would then prove the
 * guard catches nothing at all.
 */
function withMutation(file, from, to, fn) {
  const original = readFileSync(file, 'utf8');
  assert.ok(original.includes(from), `${path.basename(file)}: mutation source absent — this proof is vacuous`);
  writeFileSync(file, original.split(from).join(to));
  try {
    fn();
  } finally {
    writeFileSync(file, original);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// import hygiene
// ───────────────────────────────────────────────────────────────────────────

test('importing the guard did not run its scan (#3436)', () => {
  assert.equal(typeof analyze, 'function');
  assert.equal(typeof findViolations, 'function');
});

// ───────────────────────────────────────────────────────────────────────────
// the embedded controls, including the two real incidents
// ───────────────────────────────────────────────────────────────────────────

test('every embedded control agrees with the detector', () => {
  assert.deepEqual(selfTest(), []);
});

test('the control set contains BOTH shapes — the single-arg form and the laundered one', () => {
  const flagged = CONTROLS.filter((c) => c.expect);
  const single = flagged.find((c) => /new URL\(req\.url\)\.origin/.test(c.src));
  const laundered = flagged.find((c) => /function originOf\(url: string\)/.test(c.src));
  assert.ok(single, 'no control models `new URL(req.url).origin` — the shape #3467 shipped');
  assert.ok(laundered, 'no control models the helper-laundered shape — the shape #3500 fixed in interop');
  // …and the laundered control must NOT be catchable by a syntactic pattern:
  // if `req` sat next to the constructor a widened regex would suffice and the
  // control would not prove the dataflow.
  const ctorLine = laundered.src.split('\n').find((l) => l.includes('new URL('));
  assert.ok(
    !/\breq\b|\brequest\b/.test(ctorLine),
    'the laundered control has a request identifier on the constructor line — it no longer proves value-following',
  );
});

test('a widened SYNTACTIC pattern would still miss the laundered shape', () => {
  // The most generous single-regex widening anyone would write for #3468.
  const WIDENED = /new URL\((?:[^)]*,\s*)?(?:req|request)\.(?:url|nextUrl(?:\.origin)?)\s*\)/;
  const laundered = CONTROLS.find((c) => /function originOf\(url: string\)/.test(c.src));
  assert.equal(
    WIDENED.test(laundered.src.split('\n').find((l) => l.includes('new URL('))),
    false,
    'the widened regex matches — pick a laundered fixture it genuinely cannot see',
  );
  assert.ok(findViolations(laundered.src).length > 0, 'the dataflow detector must see what the regex cannot');
});

// ───────────────────────────────────────────────────────────────────────────
// the mask — the class of false negative the old stripper had
// ───────────────────────────────────────────────────────────────────────────

test('maskNonCode preserves length and newlines, so reported lines are true', () => {
  const src = "/* a\n b */\nconst x = 1; // note\nconst s = 'text';\n";
  const masked = maskNonCode(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.ok(masked.includes('const x = 1;'));
  assert.ok(!masked.includes('note'));
  assert.ok(!masked.includes('text'));
});

test('a `//` INSIDE a string does not truncate the line — the #3468 false negative', () => {
  // The standard protocol-relative open-redirect guard: by construction a line
  // building an outward redirect, and the old `l.replace(/\/\/.*$/, '')` deleted
  // the rest of it before the matcher ever ran.
  const src = "const u = new URL(next.startsWith('//') ? '/' : next, req.url);";
  assert.ok(maskNonCode(src).includes('req.url'), 'the mask ate the code after the in-string `//`');
  assert.equal(findViolations(src).length, 1);
});

test('a regex literal containing slashes does not desync the mask', () => {
  // `.replace(/\/+$/, '')` is in the #3467 code itself; read as division it
  // would open a string and swallow the remainder of the file.
  const src = "const o = new URL(req.url).origin.replace(/\\/+$/, '');\nconst p = 1;";
  assert.ok(maskNonCode(src).includes('const p = 1;'));
  assert.equal(findViolations(src).length, 1);
});

test('a template literal keeps its ${…} substitutions as CODE', () => {
  const src = 'const s = `${new URL(req.url).origin}/api/x`;';
  assert.ok(maskNonCode(src).includes('new URL(req.url).origin'));
  assert.equal(findViolations(src).length, 1);
});

test('prose ABOUT the pattern is not a violation, and does not hide code below it', () => {
  assert.equal(findViolations("// never build new URL('/x', req.url) here").length, 0);
  assert.equal(findViolations('/**\n * see new URL(path, req.url)\n */\nconst a = 1;').length, 0);
  const mixed = "// explains new URL(p, req.url)\nconst u = new URL('/y', req.url);";
  assert.equal(findViolations(mixed).length, 1);
  assert.equal(findViolations(mixed)[0].line, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// the bracket helpers the argument reader is built on
// ───────────────────────────────────────────────────────────────────────────

test('readArgs splits top-level arguments across nesting and newlines', () => {
  const code = "f(new URL('' , x), a[b, c], {d: 1},\n  last)";
  const { args } = readArgs(code, code.indexOf('('));
  assert.equal(args.length, 4);
  assert.equal(args[3].text.trim(), 'last');
  assert.equal(matchBracket(code, code.indexOf('(')), code.length - 1);
});

// ───────────────────────────────────────────────────────────────────────────
// dataflow — the part a syntactic guard cannot have
// ───────────────────────────────────────────────────────────────────────────

test('taint follows a local variable to a later authority read', () => {
  assert.equal(findViolations('const u = new URL(req.url);\nconst o = u.origin;').length, 1);
  assert.equal(findViolations('const u = new URL(req.url);\nconst p = u.pathname;').length, 0);
});

test('taint follows a helper PARAMETER from its call site', () => {
  const src = [
    'function originOf(url: string): string { return new URL(url).origin; }',
    'const safe = originOf(externalOrigin(req.headers));',
  ].join('\n');
  assert.equal(findViolations(src).length, 0, 'a helper called only with a SAFE value must not be flagged');
  assert.equal(findViolations(`${src}\nconst bad = originOf(req.url);`).length, 1);
});

test('taint follows a helper RETURN value to its call site', () => {
  const src = [
    'function urlOf(req: Request) { return new URL(req.url); }',
    'const o = urlOf(incoming).pathname;',
  ].join('\n');
  assert.equal(findViolations(src).length, 0);
  assert.equal(findViolations(src.replace('.pathname', '.origin')).length, 1);
});

test('reading the PATH half of the request URL is never a violation', () => {
  for (const good of [
    'const p = new URL(req.url).pathname;',
    "const q = req.nextUrl.searchParams.get('id');",
    'const s = req.nextUrl.search;',
    'const h = new URL(req.url).hash;',
  ])
    assert.equal(findViolations(good).length, 0, good);
});

// ───────────────────────────────────────────────────────────────────────────
// END-TO-END: re-break the real routes #3500 fixed
// ───────────────────────────────────────────────────────────────────────────

test('the real tree is clean against the ratchet', () => {
  const { code, out } = run();
  assert.equal(code, 0, out);
  assert.match(out, /embedded control\(s\) passed/);
});

test('#3467 REPRODUCED — re-breaking iceberg/connect with the SINGLE-ARGUMENT form fails the guard', () => {
  // This is the mutation the previous guard could not see: it reported
  // `0 violation(s), 5 embedded control(s) passed`, EXIT=0, on a tree carrying
  // exactly this construction.
  withMutation(
    ICEBERG_CONNECT,
    '`${externalOrigin(req.headers)}/api/catalog/iceberg`',
    '`${new URL(req.url).origin}/api/catalog/iceberg`',
    () => {
      const { code, out } = run();
      assert.equal(code, 1, `the guard did NOT catch the re-broken route — it is blind.\n${out}`);
      assert.match(out, /catalog[/\\]iceberg[/\\]connect[/\\]route\.ts/);
    },
  );
  assert.equal(run().code, 0, 'restore failed — the tree is left dirty');
});

test('#3500 REPRODUCED — re-breaking lakehouse/interop through a HELPER fails the guard', () => {
  // The value is laundered through `originOf(url: string)`, so the constructor
  // line carries no request identifier at all. A widened regex stays green here.
  const original = readFileSync(LAKEHOUSE_INTEROP, 'utf8');
  assert.ok(
    original.includes('externalOrigin(req.headers)'),
    'the route should already be fixed — this proof is vacuous otherwise',
  );
  const broken =
    'function originOf(url: string): string { return new URL(url).origin; }\n' +
    original.split('externalOrigin(req.headers)').join('originOf(req.url)');
  writeFileSync(LAKEHOUSE_INTEROP, broken);
  try {
    const { code, out } = run();
    assert.equal(code, 1, `the guard did NOT follow the value through the helper.\n${out}`);
    assert.match(out, /lakehouse[/\\]interop[/\\]route\.ts/);
  } finally {
    writeFileSync(LAKEHOUSE_INTEROP, original);
  }
  assert.equal(run().code, 0, 'restore failed — the tree is left dirty');
});

test('#3443 REPRODUCED — re-breaking flightsql/connect with req.nextUrl.origin fails the guard', () => {
  withMutation(FLIGHTSQL_CONNECT, 'externalOrigin(req.headers)', 'req.nextUrl.origin', () => {
    const { code, out } = run();
    assert.equal(code, 1, `the guard did NOT catch the re-broken route — it is blind.\n${out}`);
    assert.match(out, /flightsql[/\\]connect[/\\]route\.ts/);
  });
  assert.equal(run().code, 0, 'restore failed — the tree is left dirty');
});

// ───────────────────────────────────────────────────────────────────────────
// the guard cannot pass vacuously
// ───────────────────────────────────────────────────────────────────────────

test('the measured population is real — `0 violations` is distinguishable from `0 files scanned`', () => {
  const { files, current, detail, withCtor } = collect();
  assert.ok(files.length > 4500, `only ${files.length} tracked files enumerated`);
  assert.ok(withCtor > 150, `only ${withCtor} files still contain \`new URL(\` after masking`);
  assert.ok(detail.length >= 20, `only ${detail.length} sites found — the detector has stopped detecting`);
  assert.equal(
    detail.length,
    Object.values(current).reduce((a, b) => a + b, 0),
    'the per-file counts and the site list disagree',
  );
});

test('the baseline is count-pinned per file, not file-scoped cover (#3468)', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const { current } = collect();
  for (const [f, n] of Object.entries(baseline.entries)) {
    assert.ok(n > 0, `${f}: a zero baseline entry is meaningless`);
    assert.ok(f in current, `${f}: baseline entry is STALE — a drained entry is cover for the next violation`);
  }
  // The pin is what makes it different from the old EXEMPT map: one MORE
  // violation in an already-baselined file must still fail.
  const testFile = 'apps/fiab-console/app/auth/__tests__/sign-in-redirect-origin.test.ts';
  assert.ok(baseline.entries[testFile] > 0, 'the deliberate-control test file should be baselined, not exempted');
  assert.ok(baseline._owner && baseline._why && baseline._unblock, 'the baseline needs its ownership header');
});

test('a NEW violation in an already-baselined file still fails (the old EXEMPT `continue` did not)', () => {
  const target = app('app', 'auth', '__tests__', 'sign-in-redirect-origin.test.ts');
  const original = readFileSync(target, 'utf8');
  writeFileSync(target, `${original}\n// added by a test\nconst leaked = new URL(req.url).origin;\n`);
  try {
    const { code, out } = run();
    assert.equal(code, 1, `a net-new violation in a baselined file passed — the pin is not holding.\n${out}`);
  } finally {
    writeFileSync(target, original);
  }
  assert.equal(run().code, 0, 'restore failed — the tree is left dirty');
});

test('a DRAINED baseline entry fails the guard rather than sitting there as cover', () => {
  // The old guard's one real virtue: a stale exemption is cover for the next
  // violation in that file. A shrink-only ratchet does not fail on a shrink, so
  // this has to be enforced separately.
  const target = app('lib', 'scim', 'respond.ts');
  withMutation(target, 'return new URL(req.url).origin;', 'return externalOrigin(req.headers);', () => {
    const { code, out } = run();
    assert.equal(code, 1, `a fully-drained baseline entry passed — it is now silent cover.\n${out}`);
    assert.match(out, /no longer contain ANY site/);
    assert.match(out, /lib[/\\]scim[/\\]respond\.ts/);
  });
  assert.equal(run().code, 0, 'restore failed — the tree is left dirty');
});

test('every touched-file exemption carries a reviewable reason', () => {
  for (const [f, reason] of TOUCH_EXEMPT) {
    assert.ok(reason && reason.length > 60, `${f}: exemption reason is too thin to review`);
  }
});
