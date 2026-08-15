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
  judge,
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

/** One full-tree scan shared by every test that only needs the measurement. */
let MEASURED = null;
const measured = () => (MEASURED ??= collect());

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
// review round 2 — the shapes that evaded the first rewrite
// ───────────────────────────────────────────────────────────────────────────

test('a SAFE base argument means argument 0 is irrelevant — the guard must not punish its own remediation', () => {
  // The path-preserving fix re-bases the request path onto externalOrigin().
  // The first rewrite fell through the base branch into the one-argument rule
  // and flagged it, so the boy-scout rule would have forced 28 files to write
  // a construction the guard then rejected.
  for (const remediation of [
    'const u = new URL(new URL(req.url).pathname, externalOrigin(req.headers)).href;',
    'const v = new URL(req.nextUrl.pathname + req.nextUrl.search, externalOrigin(req.headers)).toString();',
    "const w = new URL(new URL(req.url).pathname + new URL(req.url).search, externalOrigin(req.headers));",
  ])
    assert.deepEqual(findViolations(remediation), [], remediation);

  // …and an UNSAFE base is still caught, so the fix did not just disable the rule.
  assert.equal(findViolations("const u = new URL('/x', req.url);").length, 1);
  assert.equal(findViolations('const u = new URL(new URL(req.url).pathname, req.url);').length, 1);
});

test('OPTIONAL CHAINING on the root does not hide it — one character defeated the whole analysis', () => {
  // Live house style in the scanned tree: monitor/alerts:79 uses `req?.url`;
  // monitor/{health,diagnostics,inventory} and foundry/agents use
  // `req?.nextUrl?.`. Every one is a PATH-half read today — one word from
  // invisible.
  for (const bad of [
    'const o = new URL(req?.url).origin;',
    'const o = req?.nextUrl.origin;',
    'const h = request?.nextUrl?.href;',
    'const o = req.nextUrl?.origin;',
    "const u = new URL('/x', req?.url);",
  ])
    assert.equal(findViolations(bad).length > 0, true, bad);

  for (const good of [
    'const p = new URL(req?.url).pathname;',
    "const q = req?.nextUrl?.searchParams.get('id');",
  ])
    assert.deepEqual(findViolations(good), [], good);
});

test('DESTRUCTURING is followed — one identifier apart from the idiom used in ten files', () => {
  assert.equal(findViolations('const { origin } = new URL(req.url);').length, 1);
  assert.equal(findViolations('const { origin } = req.nextUrl;').length, 1);
  assert.equal(findViolations('const { host, pathname } = new URL(req.url);').length, 1);
  assert.deepEqual(findViolations('const { searchParams } = new URL(req.url);'), []);
  assert.deepEqual(findViolations('const { pathname, searchParams } = req.nextUrl;'), []);
});

test('all four helper declaration forms are followed — #3500 was a helper', () => {
  const body = '{ return new URL(url).origin; }';
  const forms = [
    `function originOf(url: string) ${body}`,
    `const originOf = (url: string) => ${body}`,
    `const originOf = function (url) ${body}`,
    `const H = { originOf(url) ${body} };`,
  ];
  for (const decl of forms) {
    const call = decl.startsWith('const H') ? 'H.originOf(req.url)' : 'originOf(req.url)';
    assert.equal(findViolations(`${decl}\nconst o = ${call};`).length, 1, decl);
    assert.deepEqual(
      findViolations(`${decl}\nconst o = ${call.replace('req.url', 'externalOrigin(req.headers)')};`),
      [],
      `${decl} — called only with a SAFE value`,
    );
  }
});

test('`req.nextUrl.clone()` keeps carrying the authority — the canonical Next redirect idiom, and #3442', () => {
  assert.equal(
    findViolations("const u = req.nextUrl.clone();\nu.pathname = '/x';\nreturn NextResponse.redirect(u);").length,
    1,
  );
  assert.equal(findViolations('const u = req.nextUrl.clone();\nconst o = u.origin;').length, 1);
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
});

test('#3443 REPRODUCED — re-breaking flightsql/connect with req.nextUrl.origin fails the guard', () => {
  withMutation(FLIGHTSQL_CONNECT, 'externalOrigin(req.headers)', 'req.nextUrl.origin', () => {
    const { code, out } = run();
    assert.equal(code, 1, `the guard did NOT catch the re-broken route — it is blind.\n${out}`);
    assert.match(out, /flightsql[/\\]connect[/\\]route\.ts/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// the guard cannot pass vacuously
// ───────────────────────────────────────────────────────────────────────────

test('the measured population is real — `0 violations` is distinguishable from `0 files scanned`', () => {
  const { files, current, detail, withCtor } = measured();
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
  const { current } = measured();
  for (const [f, n] of Object.entries(baseline.entries)) {
    assert.ok(n > 0, `${f}: a zero baseline entry is meaningless`);
    assert.ok(f in current, `${f}: baseline entry is STALE — a drained entry is cover for the next violation`);
  }
  const testFile = 'apps/fiab-console/app/auth/__tests__/sign-in-redirect-origin.test.ts';
  assert.ok(baseline.entries[testFile] > 0, 'the deliberate-control test file should be baselined, not exempted');
  assert.ok(baseline._owner && baseline._why && baseline._unblock, 'the baseline needs its ownership header');
});

test('a NEW violation in an already-baselined file still fails (the old EXEMPT `continue` did not)', () => {
  // Kept END-TO-END rather than moved to judge(), because this is the exact
  // property that replaces the old file-scoped EXEMPT map — its `continue`
  // discarded every hit in the file, so a real violation added to the one
  // exempt file inherited the cover silently.
  const target = app('app', 'auth', '__tests__', 'sign-in-redirect-origin.test.ts');
  const original = readFileSync(target, 'utf8');
  writeFileSync(target, `${original}\n// added by a test\nconst leaked = new URL(req.url).origin;\n`);
  try {
    const { code, out } = run();
    assert.equal(code, 1, `a net-new violation in a baselined file passed — the pin is not holding.\n${out}`);
  } finally {
    writeFileSync(target, original);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// RATCHET PROPERTIES — proven against judge() with a synthetic population.
//
// These used to mutate five real tracked files. `withMutation` restores in a
// `finally`, but a SIGKILL — a CI timeout or an OOM, both with precedent in
// this repo — would leave the checkout corrupted while ~90 other suites run
// against it in parallel. There is no live race today; running them in-process
// removes the class, and the END-TO-END path is still proven by the three
// real-route reproductions above plus the net-new test.
// ───────────────────────────────────────────────────────────────────────────

const BASE = () => JSON.parse(readFileSync(BASELINE, 'utf8')).entries;
/** A population that satisfies every floor, so only the rule under test can fail. */
const healthy = (current) => ({
  files: new Array(5598).fill('apps/fiab-console/x.ts'),
  current,
  detail: [],
  withCtor: 233,
});

/** Run judge() with output captured, so a message can be asserted. */
function judged(measured, opts = {}) {
  const lines = [];
  const { log, error } = console;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const code = judge(measured, { argv: [], touchedFiles: null, ...opts });
    return { code, out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('ratchet: the current tree holds, and a per-key RISE fails', () => {
  const base = BASE();
  assert.equal(judged(healthy({ ...base })).code, 0, 'the frozen population should hold');

  const key = 'apps/fiab-console/app/auth/__tests__/sign-in-redirect-origin.test.ts';
  const risen = judged(healthy({ ...base, [key]: base[key] + 1 }));
  assert.equal(risen.code, 1, 'one MORE violation in a baselined file must fail');
  assert.match(risen.out, /new violations above the ratchet baseline/);
});

test('ratchet: a NET-NEW file fails even when the TOTAL is unchanged', () => {
  // The interesting case for a count ratchet: a global total would be satisfied
  // by "one fixed, one added". `runRatchet` compares PER KEY, so it is not.
  // Shrink an existing multi-site file by one (allowed) and add a new file with
  // one — total 35 either way. No key is DRAINED, so the drain rule stays out
  // of it and the per-key rise is what has to fail.
  const base = BASE();
  const multi = Object.entries(base).find(([, n]) => n > 1)[0];
  const swapped = { ...base, [multi]: base[multi] - 1, 'apps/fiab-console/app/api/brand/new/route.ts': 1 };
  assert.equal(
    Object.values(swapped).reduce((a, b) => a + b, 0),
    Object.values(base).reduce((a, b) => a + b, 0),
    'the fixture must keep the total identical or it proves nothing',
  );
  const r = judged(healthy(swapped));
  assert.equal(r.code, 1, 'a net-new file passed because the total was unchanged');
  assert.match(r.out, /brand[/\\]new[/\\]route\.ts/);
});

test('ratchet: a partial SHRINK passes, a full DRAIN fails as cover', () => {
  const base = BASE();
  const multi = Object.entries(base).find(([, n]) => n > 1)[0];
  assert.equal(judged(healthy({ ...base, [multi]: base[multi] - 1 })).code, 0, 'a partial fix must not fail');

  const drained = { ...base };
  delete drained['apps/fiab-console/lib/scim/respond.ts'];
  const r = judged(healthy(drained));
  assert.equal(r.code, 1, 'a fully-drained entry is silent cover for the next violation');
  assert.match(r.out, /no longer contain ANY site/);
  assert.match(r.out, /lib[/\\]scim[/\\]respond\.ts/);
});

test('ratchet: the boy-scout rule fires on a touched baselined file, and TOUCH_EXEMPT excuses it', () => {
  const base = BASE();
  const touched = 'apps/fiab-console/app/api/openapi.json/route.ts';
  const r = judged(healthy({ ...base }), { touchedFiles: new Set([touched]) });
  assert.equal(r.code, 1, 'touching a baselined file without clearing it must fail');
  assert.match(r.out, /boy-scout/);

  const exempt = [...TOUCH_EXEMPT.keys()][0];
  assert.equal(
    judged(healthy({ ...base }), { touchedFiles: new Set([exempt]) }).code,
    0,
    'the reasoned touch-exemption should excuse its own file',
  );
});

test('the floors fire, and are not satisfiable by a detector that stopped detecting', () => {
  const base = BASE();
  // enumeration collapsed
  assert.equal(judged({ ...healthy({ ...base }), files: ['a.ts'] }).code, 1);
  // the mask ate the code
  assert.equal(judged({ ...healthy({ ...base }), withCtor: 0 }).code, 1);
  // the analyzer found nothing — a ratchet alone would read this as a clean sweep
  const empty = judged(healthy({}));
  assert.equal(empty.code, 1, 'zero sites must FAIL, not pass as a shrink');
  assert.match(empty.out, /the analyzer found only 0 site\(s\)/);
});

test('the SUITE left the tree clean — every mutation above was restored', () => {
  const { code, out } = run();
  assert.equal(code, 0, `the tree is dirty after the mutation proofs.\n${out}`);
});

test('every touched-file exemption carries a reviewable reason', () => {
  for (const [f, reason] of TOUCH_EXEMPT) {
    assert.ok(reason && reason.length > 60, `${f}: exemption reason is too thin to review`);
  }
});
