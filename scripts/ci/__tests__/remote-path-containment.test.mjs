/**
 * Self-test for scripts/ci/check-remote-path-containment.mjs.
 *
 * WHY THIS EXISTS. The guard's own value depends entirely on it being ABLE to
 * fail. This repo has shipped several controls that ran, reported success and
 * measured nothing — a required vitest lane that passed in 13s, a Copilot eval
 * gate green for months on four silent `az` errors. "It was green on main" is
 * not evidence. These cases encode the mutations that were applied to the real
 * tree while writing the guard, so the guard stays capable of failing.
 *
 * Run: node --test scripts/ci/__tests__/remote-path-containment.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  findRemotePathWrites,
  checkHelperIntegrity,
  findRivalHelpers,
  collectFunctions,
} from '../check-remote-path-containment.mjs';

// ── M1 / M4: a network value reaching a path without containment ────────────

test('M1 — the original run-local defect is detected', () => {
  const src = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
async function runLocal(client, dir) {
  const ctx = await client.request('GET', '/context');
  for (const f of ctx.files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content, 'utf-8');
  }
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 2, 'both the mkdir and the write are network-derived');
  assert.ok(hits.every((h) => !h.contained), 'neither is contained');
  assert.deepEqual(hits.map((h) => h.sink).sort(), ['mkdirSync', 'writeFileSync']);
});

test('M4 — a NEW download command with a raw join is detected', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function pullTemplates(client, dir) {
  const resp = await client.request('GET', '/api/templates');
  for (const f of resp.files) writeFileSync(join(dir, f.path), f.body);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, false);
});

test('taint crosses a LOCAL function boundary (fetch here, write there)', () => {
  // The shipped fix fetches in one function and writes in another. A purely
  // intra-procedural pass would call BOTH clean and enforce nothing.
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
function writeAll(dir, files) {
  for (const f of files) writeFileSync(join(dir, f.path), f.content);
}
async function run(client, dir) {
  const ctx = await client.request('GET', '/context');
  writeAll(dir, ctx.files);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, 'the write inside writeAll is reached through the call site');
  assert.equal(hits[0].contained, false);
});

// ── M6a / M7: the negative controls ─────────────────────────────────────────

test('M6a CONTROL — the same command, contained, passes', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { containedJoin } from '../safe-path.js';
export async function pullTemplates(client, dir) {
  const resp = await client.request('GET', '/api/templates');
  for (const f of resp.files) writeFileSync(containedJoin(dir, f.path), f.body);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, 'still recognised as network-derived');
  assert.equal(hits[0].contained, true, 'and recognised as contained');
});

test('M7 CONTROL — network CONTENT with an operator-supplied PATH is not flagged', () => {
  // This is `loom apps export`, and the shape of CodeQL alert 636: the bundle
  // comes off the wire, but the path is the operator's own --out flag. A guard
  // that flagged this would force pointless sanitisation onto every
  // download-to-disk command and would rightly get deleted.
  const src = `
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export async function exportBundle(client, args) {
  const out = flagStr(args.flags, 'out') || 'app.loomapp';
  const bundle = await client.request('GET', '/export');
  writeFileSync(resolve(out), JSON.stringify(bundle), 'utf-8');
}`;
  assert.deepEqual(findRemotePathWrites(src), []);
});

test('CONTROL — a purely local path (constants, readdir) is not flagged', () => {
  const src = `
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const OUT = join(process.cwd(), 'docs');
for (const name of readdirSync(OUT)) writeFileSync(join(OUT, name), 'x');`;
  assert.deepEqual(findRemotePathWrites(src), []);
});

test('M6b CONTROL — a comment naming containedJoin cannot satisfy the check', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function sneaky(client, dir) {
  const resp = await client.request('GET', '/x');
  /* contained by containedJoin, honest */
  for (const f of resp.files) writeFileSync(join(dir, f.path), f.body); // containedJoin
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, false, 'comments are masked before the scan');
});

test('CONTROL — a string literal naming containedJoin cannot satisfy the check', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function sneaky(client, dir) {
  const resp = await client.request('GET', '/x');
  const note = 'we use containedJoin here';
  for (const f of resp.files) writeFileSync(join(dir, f.path), note);
}`;
  assert.equal(findRemotePathWrites(src)[0].contained, false);
});

// ── M2 / M3: the anti-inert layer assertions ────────────────────────────────

const INTACT_HELPER = `
import { resolve, sep } from 'node:path';
export function containedJoin(baseDir, untrustedRelPath) {
  const base = resolve(baseDir);
  const rel = String(untrustedRelPath).trim();
  if (rel.startsWith('/')) refuse('absolute');
  if (rel.split('/').some((s) => s === '..')) refuse('dotdot');
  const abs = resolve(base, rel);
  if (!abs.startsWith(base + sep)) refuse('escape');
  return abs;
}`;

test('the intact helper passes all three layer assertions', () => {
  assert.deepEqual(checkHelperIntegrity(INTACT_HELPER), []);
});

test('M2 — a helper that lost its ".." rejection is reported as inert', () => {
  const gutted = INTACT_HELPER.replace(/ *if \(rel\.split.*\n/, '');
  const problems = checkHelperIntegrity(gutted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer rejects "\.\." segments/);
});

test('M3 — a helper that lost its post-resolve containment is reported as inert', () => {
  const gutted = INTACT_HELPER.replace(/ *if \(!abs\.startsWith.*\n/, '');
  const problems = checkHelperIntegrity(gutted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /post-resolve/);
});

test('a helper that lost its absolute-path rejection is reported as inert', () => {
  const gutted = INTACT_HELPER.replace(/ *if \(rel\.startsWith\('\/'\).*\n/, '');
  const problems = checkHelperIntegrity(gutted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer rejects absolute paths/);
});

test('a helper that keeps its NAME but has an empty body fails every layer', () => {
  // The #2729 shape: the fix is present, exported, imported and inert.
  const problems = checkHelperIntegrity(
    'export function containedJoin(baseDir, rel) {\n  return resolve(baseDir, rel);\n}',
  );
  assert.equal(problems.length, 3, 'all three layers reported, not just the first');
});

// ── M5: no rival implementation ─────────────────────────────────────────────

test('M5 — a rival containment helper is reported', () => {
  assert.deepEqual(
    findRivalHelpers('export function safeJoin(base, rel) { return resolve(base, rel); }'),
    ['safeJoin'],
  );
});

test('CONTROL — a comment mentioning safeJoin is not a rival definition', () => {
  assert.deepEqual(findRivalHelpers('// consider a safeJoin(base, rel) helper one day\n'), []);
});

// ── #2869 F1: the declaration syntax must not decide whether the guard sees it ─
//
// The three blocks below are the SAME defect written three ways. Before the
// fix, only the first was detected — so a guard that read as a class closure
// was really a check on which syntax the author happened to pick.

const ARROW_DEFECT = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const writeAll = (dir, files) => {
  for (const f of files) writeFileSync(join(dir, f.path), f.content);
};
async function run(client, dir) {
  const ctx = await client.request('GET', '/context');
  writeAll(dir, ctx.files);
}`;

test('M9 — taint crosses an ARROW FUNCTION boundary', () => {
  const hits = findRemotePathWrites(ARROW_DEFECT);
  assert.equal(hits.length, 1, 'the write inside the arrow function is reached through the call site');
  assert.equal(hits[0].contained, false);
});

test('M9 CONTROL — the same arrow function, contained, passes', () => {
  const hits = findRemotePathWrites(ARROW_DEFECT.replace('join(dir, f.path)', 'containedJoin(dir, f.path)'));
  assert.equal(hits.length, 1, 'still recognised as network-derived');
  assert.equal(hits[0].contained, true);
});

test('M10 — taint crosses a CLASS METHOD boundary', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
class Puller {
  writeAll(dir, files) {
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
  }
  async run(client, dir) {
    const ctx = await client.request('GET', '/context');
    this.writeAll(dir, ctx.files);
  }
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, false);
});

test('taint crosses an OBJECT-LITERAL method and an arrow property', () => {
  for (const decl of ['writeAll(dir, files) {', 'writeAll: (dir, files) => {']) {
    const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const io = {
  ${decl}
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
  },
};
async function run(client, dir) {
  const ctx = await client.request('GET', '/context');
  io.writeAll(dir, ctx.files);
}`;
    const hits = findRemotePathWrites(src);
    assert.equal(hits.length, 1, `not detected for \`${decl}\``);
    assert.equal(hits[0].contained, false);
  }
});

test('CONTROL — `if (…) {` and `catch (e) {` are not mistaken for callables', () => {
  // The method matcher looks for `NAME(params) {` at the start of a line, which
  // is also the shape of every control-flow keyword. If `if` became a callable,
  // any call to something named `if`-adjacent would propagate taint into an
  // unrelated block and the guard would start inventing findings.
  const names = collectFunctions(`
function real(a) {
  if (a) { return 1; }
  for (const x of a) { noop(x); }
  try { noop(); } catch (e) { noop(e); }
  while (a) { break; }
  switch (a) { default: break; }
}`).map((f) => f.name).sort();
  assert.deepEqual(names, ['real']);
});

// ── #2869 F2: a destructured response still binds ────────────────────────────

test('M11 — a DESTRUCTURED network response still propagates taint', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function pull(client, dir) {
  const { files } = await client.request('GET', '/context');
  for (const f of files) writeFileSync(join(dir, f.path), f.content);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, 'the destructured binding used to record nothing at all');
  assert.equal(hits[0].contained, false);
});

test('M11 CONTROL — the destructured form, contained, passes', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { containedJoin } from '../safe-path.js';
export async function pull(client, dir) {
  const { files } = await client.request('GET', '/context');
  for (const f of files) writeFileSync(containedJoin(dir, f.path), f.content);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, true);
});

test('a RENAMED / nested / rest destructure binds the LOCAL name', () => {
  for (const pattern of ['{ files: entries }', '{ data: { files: entries } }', '{ ...entries }']) {
    const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function pull(client, dir) {
  const ${pattern} = await client.request('GET', '/context');
  for (const f of entries) writeFileSync(join(dir, f.path), f.content);
}`;
    assert.equal(findRemotePathWrites(src).length, 1, `not detected for \`${pattern}\``);
  }
});

test('a destructured LOOP HEAD still carries taint to the sink', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function pull(client, dir) {
  const { files } = await client.request('GET', '/context');
  for (const { path: rel, content } of files) writeFileSync(join(dir, rel), content);
}`;
  assert.equal(findRemotePathWrites(src).length, 1);
});

// ── REALITY CHECK: the shape the real CLI actually has ──────────────────────
//
// This is the fixture that matters most, and it is here because the F2 fix
// BROKE the guard while every other test stayed green. Recording
// `const { client } = await requireAuth(…)` as a binding made `client` expand
// inline, turning `await client.request(` — which the network pattern matches —
// into `await (await requireAuth(opts)).request(`, which it does not. The
// repo-wide run went from "2 network-derived" to "0" and still printed OK.
//
// A fixture that models the code's assumptions instead of production reality
// (a bare `const client = …`) would have passed throughout. This one mirrors
// the real chain: destructured auth → client → request → cross-function call.
test('REALITY — destructured client → request → cross-function write is still seen', () => {
  const src = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { containedJoin } from '../safe-path.js';
export async function runApps(sub, args, opts) {
  const { client, output } = await requireAuth(opts);
  const dir = resolve(flagStr(args.flags, 'dir') || './out');
  const ctx = await client.request('GET', api('/context'));
  const written = writeBuildContext(dir, ctx.files);
  return written;
}
export function writeBuildContext(dir, files) {
  const planned = files.map((f) => ({ abs: containedJoin(dir, f?.path), content: f?.content ?? '' }));
  for (const p of planned) {
    mkdirSync(dirname(p.abs), { recursive: true });
    writeFileSync(p.abs, p.content, 'utf-8');
  }
  return planned.length;
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 2, 'both the mkdir and the write must stay VISIBLE as network-derived');
  assert.ok(hits.every((h) => h.contained), 'and both must read as contained');
});

test('REALITY — the same file with the containment removed goes RED', () => {
  // The other half of the pair: "visible" is only worth asserting if the
  // visibility can still produce a finding.
  const src = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export async function runApps(sub, args, opts) {
  const { client, output } = await requireAuth(opts);
  const ctx = await client.request('GET', api('/context'));
  return writeBuildContext('./out', ctx.files);
}
export function writeBuildContext(dir, files) {
  const planned = files.map((f) => ({ abs: join(dir, f?.path), content: f?.content ?? '' }));
  for (const p of planned) {
    mkdirSync(dirname(p.abs), { recursive: true });
    writeFileSync(p.abs, p.content, 'utf-8');
  }
  return planned.length;
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => !h.contained), 'neither is contained');
});

// ── #2869 F3: a COMMENT must not satisfy an integrity layer ──────────────────

test('M8 — a `..` rejection COMMENTED OUT is reported, not just a deleted one', () => {
  // The original check tested the RAW body, which still contains comments — so
  // deleting the line fired and disabling it did not. Disabling is the more
  // likely edit, and it leaves containment just as gone.
  const commented = INTACT_HELPER.replace(
    /( *)if \(rel\.split.*\n/,
    "$1// if (rel.split('/').some((s) => s === '..')) refuse('dotdot');\n",
  );
  const problems = checkHelperIntegrity(commented);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer rejects "\.\." segments/);
});

test('an absolute-path rejection COMMENTED OUT is reported', () => {
  const commented = INTACT_HELPER.replace(
    /( *)if \(rel\.startsWith\('\/'\).*\n/,
    "$1/* disabled for now: if (rel.startsWith('/')) refuse('absolute'); */\n",
  );
  const problems = checkHelperIntegrity(commented);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer rejects absolute paths/);
});

test('CONTROL — a comment ABOUT the layers, with the layers intact, passes', () => {
  // The mirror image: masking must not make a correct helper look gutted.
  const documented = INTACT_HELPER.replace(
    'export function containedJoin',
    "// Rejects '..' segments and paths that startsWith('/'), then re-checks.\nexport function containedJoin",
  );
  assert.deepEqual(checkHelperIntegrity(documented), []);
});

test('CONTROL — the SHIPPED helper passes every layer', () => {
  // Reads the real file: the fixtures above are only evidence if the thing they
  // model is itself still intact.
  const shipped = readFileSync(
    new URL('../../../apps/loom-cli/src/safe-path.ts', import.meta.url),
    'utf8',
  );
  assert.deepEqual(checkHelperIntegrity(shipped), []);
});

// ── #2869 residual A: two declaration shapes the FOLLOWED / NOT-FOLLOWED
//    boundary claimed neither way, and missed ─────────────────────────────────
//
// #2872 fixed the three shapes #2869 named and wrote down a boundary so the
// next reader could check rather than trust. These two shapes sat on neither
// side of it and were invisible — a reader checking the boundary would have
// concluded they were covered. The same over-claim, one size smaller.

test('M12 — a class FIELD arrow (`writeAll = (…) => {}`) propagates taint', () => {
  // No `const|let|var`, so the binder-anchored arrow shape could never see it.
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
class Puller {
  writeAll = (dir, files) => {
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
  };
  async pull(opts) {
    const ctx = await this.client.request('GET', '/context');
    this.writeAll(opts.out, ctx.files);
  }
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, 'a class-field arrow used to break the chain entirely');
  assert.equal(hits[0].contained, false);
});

test('M12 CONTROL — the same class field, contained, passes', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { containedJoin } from '../safe-path.js';
class Puller {
  writeAll = (dir, files) => {
    for (const f of files) writeFileSync(containedJoin(dir, f.path), f.content);
  };
  async pull(opts) {
    const ctx = await this.client.request('GET', '/context');
    this.writeAll(opts.out, ctx.files);
  }
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, true);
});

test('M13 — a PAREN-LESS single-parameter arrow propagates taint', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const writeAll = files => {
  for (const f of files) writeFileSync(join('/out', f.path), f.content);
};
export async function pull(client) {
  const ctx = await client.request('GET', '/context');
  writeAll(ctx.files);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1, '`files => {}` has no `(`, so both arrow shapes missed it');
  assert.equal(hits[0].contained, false);
});

test('M13 CONTROL — the same paren-less arrow, contained, passes', () => {
  const src = `
import { writeFileSync } from 'node:fs';
import { containedJoin } from '../safe-path.js';
const writeAll = files => {
  for (const f of files) writeFileSync(containedJoin('/out', f.path), f.content);
};
export async function pull(client) {
  const ctx = await client.request('GET', '/context');
  writeAll(ctx.files);
}`;
  const hits = findRemotePathWrites(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contained, true);
});

test('CONTROL — comparisons and compound assignment are not collected as callables', () => {
  // Shapes 5 and 6 anchor on `=`, so every operator ENDING in `=` is a
  // false-positive risk: a bogus callable can shadow the real enclosing
  // function in `enclosing()` and hide its tainted parameters.
  const names = collectFunctions(`
function real(a, b) {
  if (a === b) { return 1; }
  let n = 0;
  n += 2;
  const ok = a !== b;
  return ok;
}`)
    .map((f) => f.name)
    .sort();
  assert.deepEqual(names, ['real'], `collected ${names.join(',')}`);
});

// ── #2869 residual B: a layer that TESTS the right thing and does nothing ────
//
// F3 established that a COMMENTED-OUT rejection must fire. One level below
// that: an `if` whose condition is intact and whose consequent is empty.
// Reproduced against the shipped tree — with the `..` layer emptied, BOTH
// checkHelperIntegrity AND the whole 27-test apps/loom-cli suite stayed green,
// because the post-resolve layer still caught those inputs. Nothing at all
// observed the loss of a layer, which is what A1 exists to observe.

test('M14 — a `..` layer that tests but does not refuse is reported as inert', () => {
  const inert = INTACT_HELPER.replace(
    /( *)if \(rel\.split.*\n/,
    "$1if (rel.split('/').some((s) => s === '..')) { /* intentionally does nothing */ }\n",
  );
  assert.notEqual(inert, INTACT_HELPER, 'mutation did not apply');
  const problems = checkHelperIntegrity(inert);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /still TESTS for "\.\." segments but no longer refuses/);
});

test('M15 — an absolute-path layer that logs instead of refusing is reported', () => {
  const inert = INTACT_HELPER.replace(
    /( *)if \(rel\.startsWith\('\/'\).*\n/,
    "$1if (rel.startsWith('/')) console.warn('absolute path');\n",
  );
  assert.notEqual(inert, INTACT_HELPER, 'mutation did not apply');
  const problems = checkHelperIntegrity(inert);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /still TESTS for absolute paths but no longer refuses/);
});

test('M16 — the post-resolve layer with its NEGATION dropped is reported', () => {
  // `if (abs.startsWith(base + sep)) refuse(…)` inverts containment outright —
  // it refuses everything INSIDE the base and admits everything outside — while
  // satisfying any check that only looks for the comparison's text.
  const inverted = INTACT_HELPER.replace(
    "if (!abs.startsWith(base + sep)) refuse('escape');",
    "if (abs.startsWith(base + sep)) refuse('escape');",
  );
  assert.notEqual(inverted, INTACT_HELPER, 'mutation did not apply');
  const problems = checkHelperIntegrity(inverted);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not refuse on the NEGATED result/);
});

test('CONTROL — `throw`, a braced consequent and a wrapped condition all pass', () => {
  // The rejection check must not dictate one spelling. Refusing a legitimate
  // refactor of the security helper is how a guard gets deleted.
  const variants = [
    INTACT_HELPER.replace("refuse('escape');", "throw new CliError('escape');"),
    INTACT_HELPER.replace(
      "if (!abs.startsWith(base + sep)) refuse('escape');",
      "if (!abs.startsWith(base + sep)) {\n    refuse('escape');\n  }",
    ),
    INTACT_HELPER.replace(
      "if (!abs.startsWith(base + sep)) refuse('escape');",
      "if (\n    !abs.startsWith(base + sep)\n  ) {\n    refuse('escape');\n  }",
    ),
  ];
  for (const [i, v] of variants.entries()) {
    assert.notEqual(v, INTACT_HELPER, `variant ${i} did not apply`);
    assert.deepEqual(checkHelperIntegrity(v), [], `variant ${i} was wrongly reported`);
  }
});
