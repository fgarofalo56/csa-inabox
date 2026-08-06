#!/usr/bin/env node
/**
 * check-role-assignment-determinism.mjs — teeth for the `RoleAssignmentExists`
 * class (issue #3039, deploy-integrity.md R4/R6).
 *
 * WHAT ARM ACTUALLY ENFORCES, and why that is the whole point
 *
 *   A role assignment's NAME is a GUID the template chooses. Uniqueness,
 *   however, is enforced by ARM on the TRIPLE
 *
 *       (scope, principalId, roleDefinitionId)
 *
 *   NOT on the name. So two different names for one triple is not a duplicate
 *   that ARM tolerates — it is `RoleAssignmentExists`, permanently, on every
 *   future reconcile of an estate that already carries the first one.
 *
 *   Measured on deploy-fiab-commercial run 31069329802 (2026-08-06):
 *
 *       RoleAssignmentExists: The role assignment already exists. The ID of the
 *       existing role assignment is 2f9290b01a8244fea959b441c49c84cb.
 *
 *   The template asked for `3d0daf64-…`; the estate held `2f9290b0-…`; both are
 *   Website Contributor for the Console UAMI at the admin resource group. The
 *   grant was already in place. The deploy failed anyway.
 *
 * WHAT THIS GUARD DOES AND DOES NOT CLAIM
 *
 *   D1 — the name must be a deterministic `guid(…)`. `newGuid()`, `utcNow()`
 *        and anything seeded from `deployment().name` produce a NEW name every
 *        run, so every run collides with the previous run's assignment.
 *
 *   D2 — two declarations must not produce the same (scope, principalId,
 *        roleDefinitionId) triple under DIFFERENT name seeds. That is the
 *        `RoleAssignmentExists` generator, expressed statically.
 *
 *   It deliberately does NOT require the seed to be literally
 *   `guid(scope, principalId, roleDefinitionId)`. A label seed such as
 *   `guid(resourceGroup().id, consolePrincipalId, 'monitoring-reader')` is
 *   perfectly deterministic; it is only dangerous when a SECOND declaration
 *   grants the same triple under a different seed — which is exactly D2. Making
 *   the literal shape mandatory would demand renaming ~40 assignments that are
 *   already deployed, and a rename is the very thing that produced this issue.
 *   That would be manufacturing 40 new RoleAssignmentExists failures in the name
 *   of preventing one.
 *
 *   KNOWN HAZARD, deliberately NOT gated here: a versioned discriminator in the
 *   seed (`'shim-uami-reader-v1'`, `'lifecycle-policy-v1'`). Bumping the version
 *   renames a live assignment and guarantees RoleAssignmentExists on the next
 *   reconcile. Whether a literal changed is a question about HISTORY, and a
 *   guard that answers it from a merge-base is fragile in exactly the way that
 *   makes guards get switched off. It is called out in `--list` output instead,
 *   so the reviewer sees it without the build asserting something it cannot
 *   establish (R7).
 *
 * USAGE
 *   node scripts/ci/check-role-assignment-determinism.mjs
 *   node scripts/ci/check-role-assignment-determinism.mjs --list
 *
 * Tests: node --test scripts/ci/__tests__/role-assignment-determinism.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const BICEP_ROOT = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep');

const RA_TYPE = /'Microsoft\.Authorization\/roleAssignments@[^']+'/;

/** Non-deterministic name sources — a new value on every deployment. */
export const NONDETERMINISTIC = [
  { token: 'newGuid(', why: 'newGuid() returns a different GUID on every deployment.' },
  { token: 'utcNow(', why: 'utcNow() changes on every deployment.' },
  {
    token: 'deployment().name',
    why: 'deployment().name embeds the run id, so the name changes on every deployment.',
  },
];

export function bicepFiles(root = BICEP_ROOT) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bicep')) out.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

/**
 * Extract the declaration bodies. Brace-balanced from the `= {` that opens the
 * resource, so a nested object cannot end it early — a line-count window is how
 * a parser starts reading the NEXT resource's `name:`.
 */
export function declarations(source, file = '<memory>') {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue;
    if (!/^\s*resource\s/.test(line)) continue;
    if (!RA_TYPE.test(line)) continue;
    if (/\bexisting\b/.test(line)) continue;

    let depth = 0;
    let started = false;
    const body = [];
    for (let j = i; j < lines.length; j += 1) {
      const t = lines[j];
      body.push({ line: j + 1, text: t });
      for (const ch of t.replace(/\/\/.*$/, '')) {
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') depth -= 1;
      }
      if (started && depth <= 0) break;
    }
    out.push({ file, line: i + 1, body });
  }
  return out;
}

/** Parens/brackets still open at the end of `s`, comments stripped. */
function unbalanced(s) {
  let n = 0;
  for (const ch of s.replace(/\/\/.*$/, '')) {
    if (ch === '(' || ch === '[') n += 1;
    else if (ch === ')' || ch === ']') n -= 1;
  }
  return n;
}

/**
 * First `key: <value>` at any depth inside a declaration body, JOINING
 * continuation lines until the expression's parentheses balance.
 *
 * The single-line version of this read
 *     roleDefinitionId: subscriptionResourceId(
 *       'Microsoft.Authorization/roleDefinitions',
 *       'f6c7c914-…')
 * as the value `subscriptionResourceId(` — so two assignments of DIFFERENT
 * roles compared equal and the guard invented a triple collision. A parser that
 * truncates its input is a guard that measures the truncation.
 */
function field(body, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`);
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i];
    if (/^\s*\/\//.test(l.text)) continue;
    const m = re.exec(l.text);
    if (!m) continue;
    let value = m[1];
    let depth = unbalanced(value);
    for (let j = i + 1; j < body.length && depth > 0; j += 1) {
      const t = body[j].text.replace(/^\s*/, '').replace(/\/\/.*$/, '');
      if (t === '') continue;
      value += t;
      depth += unbalanced(t);
    }
    return { value, line: l.line };
  }
  return null;
}

/**
 * Normalise an expression for COMPARISON only. Whitespace and quote style are
 * not semantics; everything else is left alone so two genuinely different
 * expressions never compare equal.
 */
export function normaliseExpr(expr) {
  return String(expr ?? '')
    .replace(/\s+/g, '')
    .replace(/"/g, "'");
}

/**
 * The role definition GUID a `roleDefinitionId:` expression resolves to, when
 * it is written as a literal; otherwise the normalised expression itself (a
 * `var` reference is stable within a file, which is all D2 needs).
 */
export function roleKey(expr, source) {
  const norm = normaliseExpr(expr);
  const lit = /'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'/.exec(norm);
  if (lit) return lit[1].toLowerCase();
  // `subscriptionResourceId('Microsoft.Authorization/roleDefinitions', someVar)`
  const varRef = /roleDefinitions',([A-Za-z_][\w.!]*)\)/.exec(norm);
  if (varRef) {
    const v = new RegExp(`^\\s*var\\s+${varRef[1]}\\s*=\\s*'([^']+)'`, 'm').exec(source ?? '');
    if (v) return v[1].toLowerCase();
    return `var:${varRef[1]}`;
  }
  return norm;
}

export function parseDeclaration(decl, source) {
  const name = field(decl.body, 'name');
  const scope = field(decl.body, 'scope');
  const principal = field(decl.body, 'principalId');
  const role = field(decl.body, 'roleDefinitionId');
  return {
    file: decl.file,
    line: decl.line,
    name: name?.value ?? null,
    nameLine: name?.line ?? decl.line,
    scope: scope?.value ?? null,
    principalId: principal?.value ?? null,
    roleDefinitionId: role?.value ?? null,
    roleKey: role ? roleKey(role.value, source) : null,
  };
}

export function inventory(root = BICEP_ROOT) {
  const out = [];
  for (const f of bicepFiles(root)) {
    const source = fs.readFileSync(f, 'utf8');
    const rel = path.relative(REPO_ROOT, f).split(path.sep).join('/');
    for (const d of declarations(source, rel)) out.push(parseDeclaration(d, source));
  }
  return out;
}

// ── D1 ───────────────────────────────────────────────────────────────────────

export function findNonDeterministicNames(records) {
  const out = [];
  for (const r of records) {
    if (r.name === null) {
      out.push({
        check: 'D1',
        file: r.file,
        line: r.line,
        detail:
          'role assignment declares no `name:`. ARM would reject it, and this guard cannot ' +
          'establish determinism for a name it cannot read — no claim is made either way.',
      });
      continue;
    }
    const bad = NONDETERMINISTIC.find((n) => r.name.includes(n.token));
    if (bad) {
      out.push({
        check: 'D1',
        file: r.file,
        line: r.nameLine,
        detail:
          `name is seeded with ${bad.token}…) — ${bad.why} Every reconcile then asks ARM for a ` +
          'SECOND assignment of the same (scope, principalId, roleDefinitionId) triple and gets ' +
          'RoleAssignmentExists. Seed the name from the triple: ' +
          'guid(<scope>.id, <principalId>, <roleDefinitionId>).',
      });
      continue;
    }
    if (!/^guid\(/.test(r.name.trim())) {
      out.push({
        check: 'D1',
        file: r.file,
        line: r.nameLine,
        detail:
          `name is \`${r.name.slice(0, 70)}\`, which is not a guid(…) expression. A role ` +
          'assignment name must be a GUID derived deterministically from its inputs.',
      });
    }
  }
  return out;
}

// ── D2 ───────────────────────────────────────────────────────────────────────

/**
 * The triple ARM enforces, keyed WITHIN ONE FILE.
 *
 * `scope: aasServer` is a symbolic reference whose meaning is local to its
 * module: the same identifier in two files can name two different Azure
 * resources, and two different identifiers can name the same one. Comparing
 * across files therefore produced findings this guard could not substantiate —
 * the first cut reported seven, six of which were symbol collisions between
 * unrelated modules. Proving a cross-file collision needs the module wiring
 * resolved, which is not something a static read of one .bicep establishes, so
 * this reports only what it can prove and `--list` prints the cross-file
 * CANDIDATES separately, labelled as unproven (R7).
 *
 * `scope` falls back to `<implicit>` when omitted — an inline assignment takes
 * the enclosing deployment scope, identical for every declaration in one file.
 */
export function tripleKey(r) {
  const scope = r.scope ? normaliseExpr(r.scope) : '<implicit>';
  return `${r.file}||${scope}||${normaliseExpr(r.principalId)}||${r.roleKey}`;
}

/** Same triple, ignoring which file it was declared in — unproven candidates. */
export function crossFileKey(r) {
  const scope = r.scope ? normaliseExpr(r.scope) : '<implicit>';
  return `${scope}||${normaliseExpr(r.principalId)}||${r.roleKey}`;
}

export function findTripleCollisions(records) {
  const byTriple = new Map();
  for (const r of records) {
    if (!r.principalId || !r.roleKey) continue;
    const k = tripleKey(r);
    if (!byTriple.has(k)) byTriple.set(k, []);
    byTriple.get(k).push(r);
  }
  const out = [];
  for (const [k, group] of byTriple) {
    if (group.length < 2) continue;
    const names = new Set(group.map((g) => normaliseExpr(g.name)));
    if (names.size < 2) continue; // same triple, same name — ARM sees one resource
    out.push({
      check: 'D2',
      file: group[0].file,
      line: group[0].nameLine,
      detail:
        `${group.length} declarations grant the SAME (scope, principalId, roleDefinitionId) triple ` +
        `under ${names.size} DIFFERENT names — ARM enforces uniqueness on the triple, not the name, ` +
        'so the second one to deploy fails with RoleAssignmentExists on every run. ' +
        `Triple: ${k.slice(0, 160)}. Declarations: ${group.map((g) => `${g.file}:${g.nameLine}`).join(', ')}.`,
    });
  }
  return out;
}

// ── hazards (reported, not gated — see the header) ───────────────────────────

export const VERSIONED_SEED = /'[^']*-v\d+'/;

export function findVersionedSeeds(records) {
  return records
    .filter((r) => r.name && VERSIONED_SEED.test(r.name))
    .map((r) => ({
      file: r.file,
      line: r.nameLine,
      name: r.name,
    }));
}

/**
 * Declarations in DIFFERENT files whose (scope, principalId, roleDefinitionId)
 * expressions read identically. These MAY be the same ARM triple under two
 * names — or two unrelated resources that happen to share a symbolic name. Not
 * gated; printed by `--list` so a reviewer can resolve the module wiring by
 * hand. Saying "collision" here would be asserting something not established.
 */
export function findCrossFileCandidates(records) {
  const byKey = new Map();
  for (const r of records) {
    if (!r.principalId || !r.roleKey) continue;
    const k = crossFileKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const out = [];
  for (const [k, group] of byKey) {
    const files = new Set(group.map((g) => g.file));
    if (files.size < 2) continue;
    if (new Set(group.map((g) => normaliseExpr(g.name))).size < 2) continue;
    out.push({ key: k, where: group.map((g) => `${g.file}:${g.nameLine}`) });
  }
  return out;
}

// ── driver ───────────────────────────────────────────────────────────────────

export function scan(root = BICEP_ROOT) {
  const records = inventory(root);
  return { records, findings: [...findNonDeterministicNames(records), ...findTripleCollisions(records)] };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { records, findings } = scan();
  if (records.length === 0) {
    process.stderr.write(
      'check-role-assignment-determinism: discovered ZERO role assignments under ' +
        `${path.relative(REPO_ROOT, BICEP_ROOT)} — discovery is broken, not clean.\n`,
    );
    process.exit(1);
  }
  if (process.argv.includes('--list')) {
    for (const r of records) {
      process.stdout.write(`${r.file}:${r.nameLine}  ${r.name}\n`);
    }
    const hazards = findVersionedSeeds(records);
    process.stdout.write(`\nversioned-seed hazards (not gated): ${hazards.length}\n`);
    for (const h of hazards) process.stdout.write(`  ${h.file}:${h.line}  ${h.name}\n`);
    const cross = findCrossFileCandidates(records);
    process.stdout.write(
      `\ncross-file triple CANDIDATES (unproven — symbolic names are module-local): ${cross.length}\n`,
    );
    for (const c of cross) process.stdout.write(`  ${c.key}\n    ${c.where.join('\n    ')}\n`);
  }
  for (const f of findings) process.stdout.write(`${f.check}  ${f.file}:${f.line}\n      ${f.detail}\n\n`);
  if (findings.length > 0) {
    process.stderr.write(
      `check-role-assignment-determinism: ${findings.length} finding(s) across ${records.length} ` +
        'role assignment(s). See deploy-integrity.md R4/R6 and issue #3039.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-role-assignment-determinism: OK — ${records.length} role assignment(s); every name is a ` +
      'deterministic guid(…) and no two declarations collide on one ARM triple.\n',
  );
}
