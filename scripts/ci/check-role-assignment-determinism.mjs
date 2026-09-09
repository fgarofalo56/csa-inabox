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
import { readLogicalLines } from './_logical-lines.mjs';

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

// ── D3 ───────────────────────────────────────────────────────────────────────

/**
 * THE GAP D1/D2 COULD NOT SEE, and which took Commercial down on 2026-08-14.
 *
 * D1 and D2 audit bicep against bicep. On run 31780698652 this guard reported
 * "OK — 164 role assignment(s); every name is a deterministic guid(…) and no two
 * declarations collide on one ARM triple" and the deploy failed anyway:
 *
 *   RoleAssignmentExists: The role assignment already exists. The ID of the
 *   existing role assignment is 0a2b7dc58eb449709418694f83a6c164.
 *
 * The competing writer was not another bicep declaration. It was
 * `az role assignment create`, which mints a RANDOM v4 GUID when no `--name` is
 * passed — measured: every one of the 15 template-computed names in that run's
 * what-if is a v5 (ARM `guid()` is name-based), and both recorded strays are v4.
 * The repo has ~40 such call sites and NOT ONE passes `--name`, so a CLI grant
 * and a template grant of one triple can never agree on a name. Whichever lands
 * first owns the triple; the other fails forever.
 *
 * THE RULE. An imperative `az role assignment create` for a role the bicep ALSO
 * grants must PROBE first — `az role assignment list` for that assignee/scope/
 * role — and create only on an established absence. Then the normal case is a
 * no-op and no competing name is minted. Creating on absence is still allowed
 * (dropping a genuinely missing grant is worse), and is now self-healing:
 * deploy-retry --remediate converges a stray on the next infra deploy.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM (R7). A `--role` given as a display name
 * ("Storage Blob Data Contributor") or as an unresolvable variable is NOT
 * judged — this guard cannot establish which role definition it is, and a
 * finding it cannot substantiate is how a guard gets switched off. Those are
 * printed by `--list` as unresolved, so the reviewer sees the residue.
 *
 * TWO WIDENINGS, both #3464, both load-bearing for whether D3 judges ANYTHING:
 *   - a role GUID may reach `--role` through a workflow's YAML `env:` mapping,
 *     not only a shell `KEY=<guid>` (see `yamlEnvGuidVars`);
 *   - a create may be spelled `grant_role_if_absent <pid> <role> <scope>`, the
 *     shared probe-then-create helper, in which case the `az role assignment
 *     create` token is in the HELPER and not in the calling file at all (see
 *     `GRANT_HELPER`). Without this, adopting the remedy deletes the site from
 *     the population and the guard's numbers fall as the tree improves.
 * Before both, `judged` on this repo was ZERO — a clean verdict about an empty
 * set — and only a `::warning::` said so. `judged === 0` is now a hard failure.
 */
export const IMPERATIVE_ROOTS = ['.github/workflows', 'scripts'];
const IMPERATIVE_EXT = /\.(ya?ml|sh)$/;
const CREATE_TOKEN = 'az role assignment create';
const PROBE_TOKEN = 'az role assignment list';
/** How far back a probe may sit and still be governing this create. */
export const PROBE_WINDOW = 12;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function imperativeFiles(root = REPO_ROOT, roots = IMPERATIVE_ROOTS) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__fixtures__') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (IMPERATIVE_EXT.test(e.name)) out.push(p);
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out.sort();
}

/**
 * A create that only appears inside an `echo`/annotation is a REFERENCE, not an
 * execution — the same distinction check-deploy-script-reachability.mjs draws,
 * and for the same reason: a naive grep scores the string as a hit.
 *
 * The first version scanned the WHOLE prefix for `(^|[;&|]\s*)(echo|printf)\s`,
 * which meant an `echo` ANYWHERE before the create disqualified it. The
 * independent review of #3928 demonstrated the consequence:
 *
 *     echo "$N" && az role assignment create …
 *
 * is an echo AND a genuine execution, and it fell out of the population
 * entirely — invisible to the judge, so `probeGates` never even saw it. So the
 * question is now asked about the command the create ACTUALLY sits in:
 *
 * The question is asked about the command SEGMENT the create actually sits in:
 * everything after the last `;` `&&` `||` `|` `&` `(` `{` `then` `do` `else`
 * that stands OUTSIDE quotes. If that segment starts with `echo`/`printf` the
 * create is a reference; anything else executes.
 *
 * Quote state is tracked rather than counted. An earlier version of this fix
 * rejected any prefix with an ODD number of unescaped quotes, reasoning that an
 * unclosed quote means the create sits inside a string. The independent
 * round-2 review of #3928 measured what that actually removed from the
 * POPULATION — five shapes that `main` had always counted:
 *
 *     bash -c "az role assignment create …"      eval "az role assignment create …"
 *     ssh "$HOST" "az role assignment create …"  sudo bash -c "az role assignment create …"
 *     az tag create --name "don't" ; az role assignment create …
 *
 * The last is the one that would have bitten: an APOSTROPHE anywhere earlier on
 * the logical line deleted the create from the population entirely. Falling out
 * of the population is this repo's dominant recorded evasion, so a test that
 * silently shrinks it is worse than the reference it was catching. Masking gets
 * both: a `;` inside `echo "step 1; az … create"` still does not open a new
 * segment, and an apostrophe inside `"don't"` is just a character.
 */
function maskQuoted(s) {
  const out = s.split('');
  // Masked to a WORD character on purpose: `x""then` is the single shell word
  // `xthen`, and masking the quotes to spaces would manufacture a `\bthen\b`
  // delimiter the real line does not contain. Delimiters OUTSIDE quotes are
  // never masked, so none is lost.
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote !== "'" && ch === '\\') {
      out[i] = 'x';
      if (i + 1 < s.length) out[i + 1] = 'x';
      i += 1;
      continue;
    }
    if (quote) {
      out[i] = 'x';
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out[i] = 'x';
    }
  }
  return out.join('');
}

const SEGMENT_DELIM = /(?:&&|\|\||[;|&]|\bthen\b|\bdo\b|\belse\b|\{|\()/g;

export function isExecuted(text, token = CREATE_TOKEN) {
  const at = text.indexOf(token);
  if (at < 0) return false;
  if (/^\s*#/.test(text)) return false;
  const before = text.slice(0, at);
  if (/::(error|warning|notice)/.test(before)) return false;
  const masked = maskQuoted(before);
  let segStart = 0;
  SEGMENT_DELIM.lastIndex = 0;
  let m = SEGMENT_DELIM.exec(masked);
  while (m !== null) {
    segStart = m.index + m[0].length;
    m = SEGMENT_DELIM.exec(masked);
  }
  return !/^\s*(?:echo|printf)\s/.test(before.slice(segStart));
}

/** `ACRPULL_ROLE=7f951dda-…` / `ROLE="7f951dda-…"` within the same file. */
export function shellGuidVars(logical) {
  const map = new Map();
  for (const l of logical) {
    const m = /(?:^|\s|\()([A-Za-z_][A-Za-z0-9_]*)=["']?([0-9a-fA-F-]{36})["']?(?:\s|$|\))/.exec(l.text);
    if (m && GUID_RE.test(m[2])) map.set(m[1], m[2].toLowerCase());
  }
  return map;
}

const YAML_ENV_OPEN = /^(\s*)env:\s*$/;
const YAML_ENV_ENTRY = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;

/**
 * Role GUIDs bound in a workflow's YAML `env:` mapping — `#3464 finding 1`.
 *
 * `shellGuidVars` reads only `KEY=<guid>`, the SHELL form. A GitHub workflow
 * binds the same thing as `KEY: <guid>` under `env:`, and the step's `run:`
 * body then references it as `$KEY` exactly as if it had been assigned in the
 * shell. D3 could not see that, so `.github/workflows/gov-provision-streaming-
 * migrate.yml`'s `--role "$BLOB_CONTRIB_ROLE"` filed as UNRESOLVED and was never
 * judged — measured on main 2026-09-07: ENUMERATED 33, RESOLVED 3, JUDGED 0.
 * A guard whose judged population is zero is a guard reporting on an empty set.
 *
 * Both `env:` scopes are read: the workflow-level block and any step-level one.
 * A block runs from an `env:` line to the next non-blank line indented at or
 * left of it.
 *
 * STATED LIMIT (R7). Scoping is per FILE, not per step: a GUID bound in one
 * step's `env:` is offered to every `$KEY` in the file. Modelling step scope
 * needs a real YAML parse, which this line reader is not. The over-approximation
 * is bounded in the direction that matters — it can only make D3 judge MORE
 * sites, never fewer — but a key bound to two DIFFERENT GUIDs in one file is
 * genuinely ambiguous, so it is dropped rather than guessed.
 */
export function yamlEnvGuidVars(logical) {
  const map = new Map();
  const ambiguous = new Set();
  let envIndent = -1;
  for (const l of logical) {
    const text = l.text;
    if (text.trim() === '' || isCommentLine(text)) continue;
    const indent = /^\s*/.exec(text)[0].length;
    if (envIndent >= 0 && indent <= envIndent) envIndent = -1;
    const open = YAML_ENV_OPEN.exec(text);
    if (open) {
      envIndent = open[1].length;
      continue;
    }
    if (envIndent < 0) continue;
    const m = YAML_ENV_ENTRY.exec(text);
    if (!m || m[1].length <= envIndent) continue;
    const value = m[3] ?? m[4] ?? m[5];
    if (!GUID_RE.test(value)) continue;
    const key = m[2];
    const guid = value.toLowerCase();
    if (map.has(key) && map.get(key) !== guid) ambiguous.add(key);
    map.set(key, guid);
  }
  for (const k of ambiguous) map.delete(k);
  return map;
}

/** Both binding forms a role GUID can reach a `--role` argument through. */
export function roleVars(logical) {
  return new Map([...yamlEnvGuidVars(logical), ...shellGuidVars(logical)]);
}

/** The role definition GUID a bare token resolves to, or null. */
export function resolveGuidToken(raw, vars) {
  if (raw === null || raw === undefined) return null;
  const bare = String(raw).replace(/^["']|["']$/g, '');
  if (GUID_RE.test(bare)) return bare.toLowerCase();
  const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(bare);
  if (v && vars.has(v[1])) return vars.get(v[1]);
  return null;
}

/** The role definition GUID a `--role <token>` resolves to, or null. */
export function resolveRoleArg(text, vars) {
  const m = /--role\s+("[^"]*"|'[^']*'|\S+)/.exec(text);
  if (!m) return null;
  return resolveGuidToken(m[1], vars);
}

/**
 * The shell variable a probe captures its answer into:
 * `N=$(az role assignment list … --query "length(@)" -o tsv)`.
 * A probe whose result is never captured cannot gate anything.
 */
export function probeResultVar(text) {
  const m = /(?:^|\s|\(|;)([A-Za-z_][A-Za-z0-9_]*)=\$\([^)]*az role assignment list/.exec(text);
  return m ? m[1] : null;
}

/**
 * A construct only opens a CONDITION when it stands in COMMAND POSITION — the
 * start of a command, not the middle of a word or the inside of a quoted
 * string. Without this, `echo "[[ $N ]] observed"` reads as a bracket test.
 */
const COMMAND_POSITION = /(?:^|[;&|(){}!]|\b(?:then|do|else|if|elif|while|until)\b)\s*$/;

/**
 * `inclusive:false` means the region ENDS where the closing token BEGINS, so
 * that token is left in the gap the caller inspects (`test X && cmd` must leave
 * the `&&` visible as the hand-off).
 */
const CONDITION_CONSTRUCTS = [
  { open: /\[\[/g, close: /\]\]/g, inclusive: true },
  { open: /\[/g, close: /(?:^|\s)\]/g, inclusive: true },
  { open: /\(\(/g, close: /\)\)/g, inclusive: true },
  { open: /\btest\b/g, close: /(?:&&|\|\||;)/g, inclusive: false },
  { open: /\b(?:if|elif|while|until)\b/g, close: /(?:;|\s)\s*(?:then|do)\b/g, inclusive: false },
  { open: /\bcase\b/g, close: /\bin\b/g, inclusive: true },
];

/**
 * The CONDITION regions of one logical shell line — the substrings whose EXIT
 * STATUS can actually branch execution.
 *
 * This distinction is the entire fix. The first version of `probeGates` tested
 * `/(^|\s|;)(if|elif)\s|\[\[?\s|&&|\|\|/` against the WHOLE line, so a bare
 * `&&`/`||` anywhere on it counted as a branch. The independent review of
 * PR #3928 demonstrated three bypasses through this guard's own entry points —
 * each `gated: true`, each an unconditional create:
 *
 *     az role assignment create … --description "seen $N" || true
 *     echo "$N" && az role assignment create …
 *     az role assignment create … || echo "had $N"
 *
 * `|| true` after a create is the most-recorded anti-pattern in this repo and
 * `deploy-integrity.md` names it explicitly, so it is the shape most likely to
 * appear next. Four more of the same class were found while fixing it. All
 * seven are pinned in `D3_CONTROLS`.
 *
 * @returns {{start:number, end:number, text:string}[]} regions, in order.
 */
export function conditionRegions(text) {
  const regions = [];
  for (const { open, close, inclusive } of CONDITION_CONSTRUCTS) {
    open.lastIndex = 0;
    let m = open.exec(text);
    while (m !== null) {
      const start = m.index;
      if (COMMAND_POSITION.test(text.slice(0, start))) {
        close.lastIndex = start + m[0].length;
        const c = close.exec(text);
        const end = c ? (inclusive ? c.index + c[0].length : c.index) : text.length;
        regions.push({ start, end, text: text.slice(start, end) });
      }
      m = open.exec(text);
    }
  }
  return regions.sort((a, b) => a.start - b.start);
}

const BLOCK_OPEN = /(?:^|[;&|(){}]|\s)(?:if|case|do)\b/g;
const BLOCK_CLOSE = /(?:^|[;&|(){}]|\s)(?:fi|esac|done)\b/g;
// The keyword must be a COMPLETE shell token, not a prefix of a longer word.
// `\b` alone matches inside `break-glass.sh`, because the boundary sits between
// `k` and `-` — so a command NAMED break-glass.sh read as the `break` builtin
// (fixture R4). A real builtin is followed by whitespace, a separator, or the
// end of the line; requiring one of those is a token rule, not a spelling list.
const EARLY_EXIT_WORD = /\b(?:exit|return|continue|break)(?![^\s;&|)}<>])/g;

/** A logical line that is entirely a shell comment executes nothing. */
export function isCommentLine(text) {
  return /^\s*#/.test(text);
}

/**
 * The part of a logical line that actually EXECUTES: quoted regions masked, and
 * any trailing `#` comment dropped.
 *
 * This exists because the normalisation used to be applied to only ONE half of
 * path (b). `hasEarlyExit` masked quotes and skipped comments; `blockDelta`
 * counted `if`/`do`/`fi`/`done` over the RAW text. So the two evasions pinned as
 * controls B2 (keyword in a quoted string) and B3 (keyword in a comment) were
 * closed against the early-exit half and still open against the BLOCK half — a
 * quoted `do` in `echo "nothing to do here"` opened a block that never existed
 * (fixtures R1/R2/R3). One normalisation, both halves, so the two cannot drift
 * apart again.
 *
 * The `#` must start a WORD to be a comment: `${VAR#x}` and `a#b` are not
 * comments, so the strip requires start-of-line or preceding whitespace. A `#`
 * inside quotes is already masked away and cannot reach this test.
 */
export function executableText(text) {
  if (isCommentLine(text)) return '';
  const masked = maskQuoted(text);
  const at = masked.search(/(?:^|\s)#/);
  if (at < 0) return masked;
  return masked.slice(0, masked.indexOf('#', at));
}

/**
 * Does this line carry an early-exit that could genuinely stop the flow before
 * the create — `exit`/`return`/`continue`/`break` standing in COMMAND POSITION,
 * outside quotes, on a line that is not a comment?
 *
 * The predicate this replaces (#3958) was `/(?:^|[;&|(){}]|\s)(?:exit|return|
 * continue|break)\b/` over the RAW text, and its own docblock recorded the two
 * measured holes: `echo "will not break here"` satisfied it, and so did
 * `az tag create --name break-glass` — a word in an argument, not a builtin.
 * Both answered `gated: true` over a create that nothing gated. Masking the
 * quoted regions and demanding command position closes both; the controls B2
 * and B3c below are those two exact lines.
 */
export function hasEarlyExit(text) {
  const masked = executableText(text);
  EARLY_EXIT_WORD.lastIndex = 0;
  let m = EARLY_EXIT_WORD.exec(masked);
  while (m !== null) {
    if (COMMAND_POSITION.test(masked.slice(0, m.index))) return true;
    m = EARLY_EXIT_WORD.exec(masked);
  }
  return false;
}

/**
 * Net block-nesting change of one logical line. A conditional that opens AND
 * closes on its own line — `if true; then echo "$N"; fi` — controls nothing
 * that follows it, so it cannot be the gate for a create three lines later.
 *
 * Counted over `executableText`, not the raw line: a keyword inside a quoted
 * string or after a trailing `#` opens and closes nothing.
 */
export function blockDelta(text) {
  const exec = executableText(text);
  const count = (re) => (exec.match(re) || []).length;
  return count(BLOCK_OPEN) - count(BLOCK_CLOSE);
}

/**
 * Is the block opened by `lines[k]` STILL OPEN when the create is reached?
 *
 * `blockDelta` alone answers only "did this one line open more than it closed",
 * and #3958 recorded the consequence: an `if …; then` on one line, its `fi` two
 * lines later, and the create AFTER the `fi` scored `gated: true` for the
 * remaining window — the create sat outside the block that supposedly gated it.
 * `lines` here is the window from the probe up to (not including) the create, so
 * running the delta forward to the end of that window answers the real question.
 * The moment the running sum reaches zero the block has closed, and a later
 * re-open is a DIFFERENT block that this condition does not control.
 *
 * Comment lines are skipped on both sides: a commented-out `fi` closes nothing,
 * and a commented-out `if` opens nothing.
 */
export function blockOpenThroughCreate(lines, k) {
  if (blockDelta(lines[k].text) <= 0) return false;
  let sum = 0;
  for (let j = k; j < lines.length; j += 1) {
    if (isCommentLine(lines[j].text)) continue;
    sum += blockDelta(lines[j].text);
    if (sum <= 0) return false;
  }
  return true;
}

/**
 * Is the create at `logical[i]` genuinely GATED on a probe, or merely PRECEDED
 * by one? (#3464 finding 3, hardened after the review of #3928.)
 *
 * The original test was `…some((p) => p.text.includes('az role assignment list'))`
 * — i.e. probe PRESENCE. The independent review of PR #3454 DEMONSTRATED the
 * bypass rather than inferring it: replace `if [ "$EXISTING" = "0" ]; then` with
 * `if true; then`, leaving the probe sitting right above an unconditional
 * create, and the guard still reported OK. That is the recorded
 * `guard_signals_presence_not_enforcement` shape, and it is the one that
 * matters here because an unconditional create is exactly what mints the
 * competing random v4 name.
 *
 * Gating requires all three:
 *   1. a probe in the preceding window;
 *   2. the probe's answer CAPTURED into a variable (an uncaptured probe is a
 *      no-op whose output goes nowhere);
 *   3. a genuine CONDITION (see `conditionRegions`) that READS that variable and
 *      actually controls the create:
 *        (a) on the create's OWN logical line, the condition must END BEFORE the
 *            create and the ONLY thing between them may be the hand-off that
 *            gives it execution — `&&`, `||`, or `then`. So
 *            `[ "$N" = 0 ] && az … create` gates; `az … create … || true` does
 *            not, and neither does `[ "$N" = 0 ]; az … create`, where the test's
 *            exit status is discarded by the `;`.
 *        (b) on a PRECEDING line, that condition's line must additionally either
 *            open a block that is STILL OPEN when the create is reached (the
 *            running `blockDelta` from that line forward never returns to zero),
 *            or carry an early-exit keyword (`exit`/`return`/`continue`/`break`)
 *            standing in COMMAND POSITION outside quotes.
 *
 * STATED LIMITS (R7). Path (b) is a LINE READ, not a parse. #3958 closed the
 * five holes the round-2 review of #3928 had measured and left recorded here —
 * each was a FALSE NEGATIVE where (b) answered `gated: true` over a create that
 * nothing gated, and each is now pinned as a control (B1, B2, B3, B3b, B3c, B6):
 *   - `blockDelta` was PER LINE and never accumulated, so a block that opened
 *     AND closed before the create still read as gating it (B1, B6);
 *   - `EARLY_EXIT` matched the keyword anywhere on the line, including inside a
 *     quoted string (B2) and inside an argument such as `--name break-glass`,
 *     where it is not the builtin at all (B3c);
 *   - path (b) did not skip COMMENT lines, so a commented-out conditional
 *     contributed a positive block delta (B3) and a commented-out early-exit
 *     satisfied the keyword test (B3b).
 *
 * The independent review of #4347 then measured that B2 and B3 had been closed
 * against ONE HALF of path (b) only. `maskQuoted`/`isCommentLine` were applied
 * inside `hasEarlyExit`; `blockDelta` still counted `if`/`do`/`fi`/`done` over
 * the RAW text. So a quoted `if`/`do`, and a keyword after a trailing `#`, still
 * opened a block that does not exist. That asymmetry is closed by
 * `executableText`, which is now the single input to BOTH halves, and the four
 * measured lines are pinned as controls R1–R4:
 *   - `echo "grant missing, check if it was removed"` (R1);
 *   - `echo skipping   # if this ever fires` (R2);
 *   - `echo "nothing to do here"` (R3);
 *   - `break-glass.sh --emit`, a command NAME whose `\b` boundary sits at the
 *     hyphen, which R4 closes by requiring the keyword to be a complete shell
 *     token rather than a prefix.
 *
 * What it still does NOT claim, and these are not fixed:
 *   - it does not verify the probe targets the SAME (assignee, scope, role)
 *     triple as the create it guards. That needs the shell variables resolved
 *     across the file; it is reported by `--list` as residue instead.
 *   - it does not establish that the create sits inside the OPEN block rather
 *     than a sibling `else` arm. Full block scoping is a parse, not a line read,
 *     and the running delta cannot distinguish the two arms.
 *   - `conditionRegions` treats `{` as opening a command position, so a `{` in
 *     an `echo` ARGUMENT (`echo {[ $N ] && …`) can open a condition region.
 *   - a HEREDOC body is read as ordinary lines. MEASURED at the `blockDelta`
 *     level: `blockDelta('if this were a gate it is not')` returns 1 for a line
 *     sitting inside a `cat <<'EOF'` body. Heredoc tracking needs state carried
 *     across logical lines, which this per-line reader does not have. Whether
 *     that can be driven all the way to a false `gated: true` was NOT measured —
 *     it would additionally need a condition reading the captured probe var.
 *   - masking is per LOGICAL LINE, so a quote opened on one line and closed on a
 *     later one leaves each line masked only from its OWN first quote onward.
 *     MEASURED: `blockDelta('and if closed here"')` returns 1, because the `if`
 *     precedes that line's first quote character. Same caveat as above — the
 *     delta is established, the end-to-end bypass is not.
 */
export function probeGates(logical, i) {
  const start = Math.max(0, i - PROBE_WINDOW);
  const window = logical.slice(start, i);
  let probeIdx = -1;
  const vars = [];
  for (let k = 0; k < window.length; k += 1) {
    if (!window[k].text.includes(PROBE_TOKEN)) continue;
    if (probeIdx < 0) probeIdx = k;
    const v = probeResultVar(window[k].text);
    if (v) vars.push(v);
  }
  if (probeIdx < 0) return { gated: false, why: 'no `az role assignment list` probe in the preceding window' };
  if (!vars.length) {
    return { gated: false, why: 'a probe runs but its answer is never captured into a variable, so nothing can branch on it' };
  }
  const readsVar = (text) =>
    vars.some((v) => new RegExp(`\\$\\{?${v}\\b`).test(text));

  // (a) the create's OWN logical line. ORDERING is enforced by the gap test
  //     itself, not by a separate comparison: a condition that ends AFTER the
  //     create yields `slice(end, createIdx) === ''`, and HANDOFF requires an
  //     actual `&&`/`||`/`then`, so an empty gap is rejected. (An explicit
  //     `if (r.end > createIdx) continue;` sat here and could not change any
  //     verdict — a line that cannot move the answer is a decoration, so it is
  //     gone and the property is pinned by a control instead.)
  const own = logical[i].text;
  const createIdx = own.indexOf(CREATE_TOKEN);
  const HANDOFF = /^\s*(?:&&|\|\||;?\s*then)\s*(?:\{\s*)?$/;
  for (const r of conditionRegions(own)) {
    if (!readsVar(r.text)) continue;
    if (HANDOFF.test(own.slice(r.end, createIdx))) return { gated: true };
  }

  // (b) a PRECEDING line, between the probe and the create. `tail` ends at the
  //     line BEFORE the create, which is what makes the running block delta
  //     answer "is this block still open when the create runs".
  const tail = window.slice(probeIdx + 1);
  for (let k = 0; k < tail.length; k += 1) {
    const l = tail[k];
    if (isCommentLine(l.text)) continue;
    if (!conditionRegions(l.text).some((r) => readsVar(r.text))) continue;
    if (blockOpenThroughCreate(tail, k) || hasEarlyExit(l.text)) return { gated: true };
  }

  return {
    gated: false,
    why: 'a probe runs and its answer is captured, but no CONDITION that reads that variable actually controls '
      + 'the create — the create is unconditional. `if true; then` above it, and `create … || true` on its own '
      + 'line, are the demonstrated bypasses',
  };
}

/**
 * THE SECOND WAY THIS REPO CREATES A ROLE ASSIGNMENT (#3464 finding 2).
 *
 * `scripts/csa-loom/_grant-role-if-absent.sh` is the ONE shared implementation
 * of "probe, then create only when the probe did not find the grant". #3454 and
 * #4227 moved call sites onto it, which is the fix D3 asks for — but it also
 * moved the `az role assignment create` token OUT of those files and into the
 * helper. A site that adopts the remedy therefore vanishes from D3's population,
 * and D3's numbers go DOWN as the tree gets better. That is the shape where a
 * guard's zero stops meaning anything.
 *
 * So a `grant_role_if_absent <principal> <role> <scope>` call is enumerated as a
 * create in its own right, and counted as GATED.
 *
 * WHAT "GATED" CLAIMS HERE, EXACTLY (R7). The helper runs `az role assignment
 * list` into a captured variable and creates only when that probe did not
 * establish the grant is present. It DELIBERATELY creates when the probe cannot
 * be READ (unreadable probe → create, documented in the helper's own header:
 * skipping a real absence is an outage, while a redundant create is refused by
 * ARM and cannot mint a second name). So the claim is "the create is behind a
 * probe", NOT "the create only ever runs on an established absence" — the
 * helper's contract is the weaker one on purpose, and this guard does not assert
 * the stronger one. What the helper's own suite proves is checked by
 * `scripts/csa-loom/__tests__/grant-role-if-absent.test.mjs`, not here.
 */
export const GRANT_HELPER = 'grant_role_if_absent';
const HELPER_DEFINITION = /(?:^|\s)grant_role_if_absent\s*\(\s*\)/;

/**
 * The positional arguments following `token` on a command line, quotes removed
 * and stopping at the first unquoted command separator. `"$PID"` → `$PID`.
 */
export function positionalArgs(text, token) {
  const at = text.indexOf(token);
  if (at < 0) return [];
  const rest = text.slice(at + token.length);
  const out = [];
  let cur = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '#') break;
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * The create SITE at one logical line, or null.
 *
 * @returns {{kind:'cli'|'helper', roleToken:string|null}|null}
 */
export function createSite(text) {
  if (isExecuted(text, CREATE_TOKEN)) {
    const m = /--role\s+("[^"]*"|'[^']*'|\S+)/.exec(text);
    return { kind: 'cli', roleToken: m ? m[1] : null };
  }
  if (HELPER_DEFINITION.test(text)) return null;
  if (isExecuted(text, GRANT_HELPER)) {
    const args = positionalArgs(text, GRANT_HELPER);
    return { kind: 'helper', roleToken: args.length >= 2 ? args[1] : null };
  }
  return null;
}

/**
 * Judge ONE file's logical lines. Shared by the tree scan and by the in-process
 * controls, so a control cannot pass against a classifier the tree scan does not
 * use — the two loops used to be separate copies of the same code.
 *
 * @returns {{findings: object[], population: number, judged: number, resolved: number, unresolved: object[]}}
 */
export function classifyImperative(logical, bicepRoles, rel = '<memory>') {
  const vars = roleVars(logical);
  const findings = [];
  const unresolved = [];
  let population = 0;
  let resolved = 0;
  let judged = 0;

  for (let i = 0; i < logical.length; i += 1) {
    const l = logical[i];
    const site = createSite(l.text);
    if (!site) continue;
    population += 1;

    const role = resolveGuidToken(site.roleToken, vars);
    if (!role) {
      unresolved.push({ file: rel, line: l.line });
      continue;
    }
    resolved += 1;
    if (!bicepRoles.has(role)) continue;
    judged += 1;

    if (site.kind === 'helper') continue; // see GRANT_HELPER — probe is inside it
    const gate = probeGates(logical, i);
    if (gate.gated) continue;

    findings.push({
      check: 'D3',
      file: rel,
      line: l.line,
      detail:
        `\`az role assignment create --role ${role}\` is not gated on an \`az role assignment list\` probe ` +
        `within the preceding ${PROBE_WINDOW} logical lines (${gate.why}), and the bicep ALSO grants that ` +
        'role definition. The CLI mints a RANDOM v4 name for the (scope, principalId, roleDefinitionId) ' +
        'triple while the template computes a deterministic v5 one, and ARM enforces uniqueness on the ' +
        'TRIPLE — so whichever writer lands first blocks the other on EVERY future run (measured: ' +
        'deploy-fiab-commercial 31780698652, #3439). Probe first and create only on an established absence — ' +
        `\`. scripts/csa-loom/_grant-role-if-absent.sh\` then \`${GRANT_HELPER} <pid> <role> <scope> <label>\` ` +
        'is the shared implementation.',
    });
  }
  return { findings, population, resolved, judged, unresolved };
}

/**
 * @returns {{findings: object[], population: number, judged: number, resolved: number, unresolved: object[]}}
 *   `population` is every EXECUTED create site found, resolvable or not — both
 *                `az role assignment create` and `grant_role_if_absent`.
 *   `resolved`   is those whose role argument resolved to a role-definition GUID.
 *   `judged`     is those D3 actually RULES ON — resolved AND also granted by
 *                the bicep. This is the number the guard's verdict is about, and
 *                the one that was never reported (#3464 finding 2).
 */
export function findImperativeCollisions(records, root = REPO_ROOT, roots = IMPERATIVE_ROOTS) {
  const bicepRoles = new Set(records.map((r) => r.roleKey).filter((k) => k && GUID_RE.test(k)));
  const findings = [];
  const unresolved = [];
  let population = 0;
  let resolved = 0;
  let judged = 0;

  for (const abs of imperativeFiles(root, roots)) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const logical = readLogicalLines(fs.readFileSync(abs, 'utf8'));
    const one = classifyImperative(logical, bicepRoles, rel);
    findings.push(...one.findings);
    unresolved.push(...one.unresolved);
    population += one.population;
    resolved += one.resolved;
    judged += one.judged;
  }
  return { findings, population, resolved, judged, unresolved };
}

// ── D3's EMBEDDED CONTROL, in the BINARY (#3464 finding 4) ───────────────────
//
// PR #3454's body claimed "D3 runs a synthetic unprobed create that MUST be
// flagged". The binary carried only the population floors; the synthetic
// control lived in the test file. That is an accuracy nit plus a convention gap
// — five sibling guards (check-curl-httpcode-fallback, check-empty-claim-read-
// evidence, check-gov-image-producer-parity, check-guard-import-side-effects,
// check-azd-provision-param-binding) run theirs IN-PROCESS before judging the
// tree — and here it is more than a convention, because D3's JUDGED population
// is currently ZERO (see the driver below). With nothing judged, the controls
// are the only evidence the judge path works at all.

const CONTROL_ROLE = '7f951dda-4ed3-4680-a7ca-43fe172d538d'; // AcrPull
const CONTROL_RECORDS = [{ roleKey: CONTROL_ROLE, file: 'control.bicep', nameLine: 1 }];
const PROBE_CONTROL_LINE =
  `N=$(az role assignment list --assignee-object-id "$PID" --scope "$ACR_ID" --role ${CONTROL_ROLE} --query "length(@)" -o tsv)`;

export const D3_CONTROLS = [
  {
    why: 'an UNPROBED create over a bicep-granted role IS flagged',
    lines: [
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'the SAME create, genuinely gated on a captured probe, is NOT flagged',
    lines: [
      `N=$(az role assignment list --assignee-object-id "$PID" --scope "$ACR_ID" --role ${CONTROL_ROLE} --query "length(@)" -o tsv)`,
      'if [ "$N" = "0" ]; then',
      `  az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
      'fi',
    ],
    expectFindings: 0,
  },
  {
    // #3464 finding 3, as a control. The probe is present and captured, but the
    // branch does not read it — the demonstrated bypass. Presence is not gating.
    why: 'a probe above an UNCONDITIONAL create (`if true`) is still flagged — presence is not gating',
    lines: [
      `N=$(az role assignment list --assignee-object-id "$PID" --scope "$ACR_ID" --role ${CONTROL_ROLE} --query "length(@)" -o tsv)`,
      'if true; then',
      `  az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
      'fi',
    ],
    expectFindings: 1,
  },
  {
    why: 'a probe whose answer is never captured cannot gate anything',
    lines: [
      `az role assignment list --assignee-object-id "$PID" --scope "$ACR_ID" --role ${CONTROL_ROLE} -o tsv`,
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'a role the bicep does NOT grant cannot collide, so it is not flagged',
    lines: [
      'az role assignment create --assignee-object-id "$PID" --role 00000000-0000-0000-0000-000000000001 --scope "$X"',
    ],
    expectFindings: 0,
  },
  {
    why: 'a create quoted inside an echo is a REFERENCE, not an execution',
    lines: [
      `echo "run: az role assignment create --role ${CONTROL_ROLE}"`,
    ],
    expectFindings: 0,
    expectPopulation: 0,
  },

  // ── the "mention is not a branch" class ──────────────────────────────────
  //
  // Every case below scored `gated: true` (or fell out of the POPULATION) on
  // the first version of this fix. The first three are the independent review
  // of PR #3928, reproduced here verbatim; the rest were found while fixing
  // them, by asking what ELSE satisfies "the line has a `&&`/`||` and mentions
  // $N". They are pinned because a fix without a control regresses the moment
  // someone refactors — the recorded shape in this repo is a narrow fix that
  // stops exactly at the cases the reviewer happened to name.
  {
    why: 'BYPASS 1/3 (review of #3928): `create … --description "seen $N" || true` — `|| true` is not a branch',
    lines: [
      PROBE_CONTROL_LINE,
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID" --description "seen $N" || true`,
    ],
    expectFindings: 1,
  },
  {
    why: 'BYPASS 2/3 (review of #3928): `echo "$N" && az … create` — an echo AND an execution, not a reference',
    lines: [
      PROBE_CONTROL_LINE,
      `echo "$N" && az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
    expectPopulation: 1,
  },
  {
    why: 'BYPASS 3/3 (review of #3928): `create … || echo "had $N"` — the create ran FIRST',
    lines: [
      PROBE_CONTROL_LINE,
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID" || echo "had $N"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'an INTERVENING `echo "count=$N" && echo ok` is not a branch either',
    lines: [
      PROBE_CONTROL_LINE,
      'echo "count=$N" && echo ok',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'an INTERVENING `if true; then echo "$N"; fi` reads $N OUTSIDE the condition, so it gates nothing',
    lines: [
      PROBE_CONTROL_LINE,
      'if true; then echo "$N"; fi',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'an INTERVENING `if [ "$N" = "0" ]; then :; fi` opens AND closes — nothing after it is inside the block',
    lines: [
      PROBE_CONTROL_LINE,
      'if [ "$N" = "0" ]; then :; fi',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'a bracket inside a QUOTED STRING (`echo "[[ $N ]] observed"`) is not a test',
    lines: [
      PROBE_CONTROL_LINE,
      'echo "[[ $N ]] observed"',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'a DISCARDED test — `[ "$N" = "0" ]; az … create` — the `;` throws the exit status away',
    lines: [
      PROBE_CONTROL_LINE,
      `[ "$N" = "0" ]; az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    // Pins ORDERING. The create ran BEFORE this condition was evaluated, so the
    // condition cannot be its gate. Fails the moment HANDOFF is loosened to
    // accept the empty gap an out-of-order region produces.
    why: 'a condition AFTER the create — `az … create && [ "$N" = "0" ]` — cannot gate it',
    lines: [
      PROBE_CONTROL_LINE,
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID" && [ "$N" = "0" ]`,
    ],
    expectFindings: 1,
  },
  {
    // Pins COMMAND POSITION. `test` here is a word in a log message, not the
    // shell builtin; only a construct in command position opens a condition.
    why: 'the WORD `test` in a log line — `echo run test $N && az … create` — is not the `test` BUILTIN',
    lines: [
      PROBE_CONTROL_LINE,
      `echo run test $N && az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },

  // ── the path-(b) FALSE NEGATIVES the #3928 docblock recorded (#3958) ──────
  //
  // Every shape below was MEASURED `gated: true` at the parent of this change,
  // over a create that nothing gates. They are the guard's own stated limits,
  // turned from prose into controls: a docblock that lists a hole is a record,
  // not a defence, and this repo has lost to exactly that distinction before.
  {
    why: 'B1: a block that OPENS and CLOSES before the create does not gate it',
    lines: [
      PROBE_CONTROL_LINE,
      'if [ "$N" = "0" ]; then',
      '  echo creating',
      'fi',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'B2: an early-exit keyword INSIDE A QUOTED STRING (`echo "will not break here"`) is not an exit',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" = "0" ] && echo "will not break here"',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'B3: a COMMENTED-OUT conditional contributes no block delta',
    lines: [
      PROBE_CONTROL_LINE,
      '# if [ "$N" = "0" ]; then',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'B3b: a COMMENTED-OUT early-exit gate executes nothing',
    lines: [
      PROBE_CONTROL_LINE,
      '# elif [ "$N" != "0" ]; then continue',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'B3c: `break` inside an ARGUMENT (`--name break-glass`) is not the shell builtin',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" = "0" ] && az tag create --name break-glass',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'B6: a `while … do` LOOP closed by `done` before the create does not gate it either',
    lines: [
      PROBE_CONTROL_LINE,
      'while [ "$N" = "0" ]; do',
      '  echo waiting',
      'done',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },

  // ── the BLOCK half of B2/B3, from the independent review of #4347 ─────────
  //
  // #3958 masked quotes and skipped comments for `hasEarlyExit` only, so the
  // exact evasions pinned above as B2 and B3 stayed open against `blockDelta`,
  // which counted `if`/`do`/`fi`/`done` over the RAW text. All four below were
  // MEASURED `gated: true` both at the parent (77ae50ed) and at the first tip
  // of this branch — the PR did not introduce them, it described them as fixed.
  // `executableText` now normalises BOTH halves, and R4 additionally requires
  // the early-exit keyword to be a complete shell token.
  {
    why: 'R1: a quoted `if` in an echo ARGUMENT (`echo "check if it was removed"`) opens no block',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" = "0" ] && echo "grant missing, check if it was removed"',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'R2: a TRAILING `# if …` comment on an otherwise live line opens no block',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" = "0" ] && echo skipping   # if this ever fires',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'R3: a quoted `do` (`echo "nothing to do here"`) opens no block',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" = "0" ] && echo "nothing to do here"',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    why: 'R4: `break-glass.sh --emit` is a COMMAND NAME in command position, not the `break` builtin',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" = "0" ] && break-glass.sh --emit',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
  },
  {
    // Counter-control for the trailing-`#` strip: it must remove a COMMENT, not
    // truncate a live conditional that happens to carry one.
    why: 'POSITIVE: a real `if …; then  # note` block with a trailing comment STILL gates',
    lines: [
      PROBE_CONTROL_LINE,
      'if [ "$N" = "0" ]; then   # no existing assignment',
      `  az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
      'fi',
    ],
    expectFindings: 0,
  },
  {
    // Counter-control for the token rule in R4: a bare builtin at end-of-line
    // has no trailing character at all and must still count.
    why: 'POSITIVE: a bare `continue` at END OF LINE is still the builtin and STILL gates',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" != "0" ] && continue',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
  },
  {
    // …and one terminated by a separator rather than whitespace.
    why: 'POSITIVE: `exit 0;` terminated by a `;` is still the builtin and STILL gates',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" != "0" ] && { exit 0; }',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
  },
  {
    // The other direction of B1/B6: the accumulation must not start reporting a
    // create that IS inside a still-open block as unguarded.
    why: 'POSITIVE: a block that opens and STAYS OPEN through the create IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      'if [ "$N" = "0" ]; then',
      '  echo creating',
      `  az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
      'fi',
    ],
    expectFindings: 0,
  },
  {
    why: 'POSITIVE: an `exit` gate in COMMAND POSITION on a preceding line IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" != "0" ] && exit 0',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
  },

  // ── and the genuine gates that must NOT start failing (no over-tightening) ─
  {
    why: 'POSITIVE: a one-line `[ "$N" = "0" ] && az … create` IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      `[ "$N" = "0" ] && az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
    expectPopulation: 1,
  },
  {
    why: 'POSITIVE: a one-line `[ "$N" != "0" ] || az … create` IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      `[ "$N" != "0" ] || az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
  },
  {
    why: 'POSITIVE: a one-line `if [[ "$N" -eq 0 ]]; then az … create …; fi` IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      `if [[ "$N" -eq 0 ]]; then az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"; fi`,
    ],
    expectFindings: 0,
  },
  {
    why: 'POSITIVE: `test "$N" = "0" && az … create` IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      `test "$N" = "0" && az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
  },
  {
    why: 'POSITIVE: an early-exit gate `[ "$N" != "0" ] && return 0` above the create IS a gate',
    lines: [
      PROBE_CONTROL_LINE,
      '[ "$N" != "0" ] && return 0',
      `az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 0,
  },

  // ── POPULATION controls (round-2 review of #3928) ────────────────────────
  //
  // An interim version of `isExecuted` rejected any prefix carrying an ODD
  // number of unescaped quotes. Every shape below is a genuine, unprobed
  // execution that `main` had always counted and that test silently DELETED
  // from the population — and a create outside the population can never be
  // judged, so it is the most complete evasion available. `expectPopulation`
  // is asserted on each so the hole cannot reopen unnoticed.
  {
    why: 'POPULATION: `bash -c "az … create"` EXECUTES — an unbalanced quote must not delete it',
    lines: [
      `bash -c "az role assignment create --assignee-object-id \\"$PID\\" --role ${CONTROL_ROLE} --scope \\"$ACR_ID\\""`,
    ],
    expectFindings: 1,
    expectPopulation: 1,
  },
  {
    why: 'POPULATION: `eval "az … create"` EXECUTES',
    lines: [
      `eval "az role assignment create --assignee-object-id $PID --role ${CONTROL_ROLE} --scope $ACR_ID"`,
    ],
    expectFindings: 1,
    expectPopulation: 1,
  },
  {
    why: 'POPULATION: an APOSTROPHE earlier on the line (`--name "don\'t"`) must not delete the create',
    lines: [
      `az tag create --name "don't" ; az role assignment create --assignee-object-id "$PID" --role ${CONTROL_ROLE} --scope "$ACR_ID"`,
    ],
    expectFindings: 1,
    expectPopulation: 1,
  },
  {
    why: 'NEGATIVE control for the above: a DELIMITER INSIDE the quoted string still does not start a new segment',
    lines: [
      `echo "step 1; run: az role assignment create --role ${CONTROL_ROLE}"`,
    ],
    expectFindings: 0,
    expectPopulation: 0,
  },

  // ── the YAML `env:` binding (#3464 finding 1) ─────────────────────────────
  //
  // The exact shape D3 was blind to. `.github/workflows/gov-provision-streaming-
  // migrate.yml` binds its role GUIDs in the workflow-level `env:` block and the
  // step's `run:` body says `--role "$BLOB_CONTRIB_ROLE"`. `shellGuidVars` reads
  // only `KEY=<guid>`, so the site filed as UNRESOLVED and D3 judged NOTHING in
  // the whole repo. Stubbing `yamlEnvGuidVars` back to an empty Map drops
  // `expectJudged` here to 0 and this control fails.
  {
    why: 'D3-YAML: a role GUID bound in a workflow-level `env:` block resolves, and an UNGATED create over it IS flagged',
    lines: [
      'env:',
      `  BLOB_CONTRIB_ROLE: ${CONTROL_ROLE}`,
      'jobs:',
      '  provision:',
      '    steps:',
      '      - run: |',
      `          az role assignment create --assignee-object-id "$PID" --role "$BLOB_CONTRIB_ROLE" --scope "$LAKE_ID"`,
    ],
    expectFindings: 1,
    expectPopulation: 1,
    expectJudged: 1,
  },
  {
    why: 'D3-YAML: a STEP-level `env:` binding resolves too',
    lines: [
      '      - name: grant',
      '        env:',
      `          ROLE_ID: ${CONTROL_ROLE}`,
      '        run: |',
      `          az role assignment create --assignee-object-id "$PID" --role "$ROLE_ID" --scope "$S"`,
    ],
    expectFindings: 1,
    expectJudged: 1,
  },
  {
    // R7: an over-approximation that GUESSES is worse than one that abstains.
    why: 'D3-YAML: a key bound to TWO DIFFERENT GUIDs in one file is ambiguous, so it is NOT resolved',
    lines: [
      'env:',
      `  ROLE_ID: ${CONTROL_ROLE}`,
      'jobs:',
      '  a:',
      '    env:',
      '      ROLE_ID: 00000000-0000-0000-0000-000000000002',
      '    steps:',
      '      - run: |',
      `          az role assignment create --assignee-object-id "$PID" --role "$ROLE_ID" --scope "$S"`,
    ],
    expectFindings: 0,
    expectPopulation: 1,
    expectJudged: 0,
  },
  {
    // A `KEY: <guid>` OUTSIDE any `env:` block is a workflow input default, a
    // subscription id, a `with:` argument — not a shell binding.
    why: 'D3-YAML: a `KEY: <guid>` that is NOT inside an `env:` block is not a shell binding',
    lines: [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      group:',
      `        default: ${CONTROL_ROLE}`,
      '      - run: |',
      `          az role assignment create --assignee-object-id "$PID" --role "$group" --scope "$S"`,
    ],
    expectFindings: 0,
    expectPopulation: 1,
    expectJudged: 0,
  },

  // ── the shared helper as a create SITE (#3464 finding 2) ──────────────────
  //
  // #3454/#4227 moved call sites onto `grant_role_if_absent`, which removes the
  // `az role assignment create` token from those files. Without these, adopting
  // the remedy makes a site DISAPPEAR from D3's population — the guard's numbers
  // fall as the tree improves, which is the recorded
  // `filter_inside_the_predicate_beats_the_population_contract` shape.
  {
    why: 'D3-HELPER: a `grant_role_if_absent <pid> <role> <scope>` call IS enumerated and JUDGED, and counts as gated',
    lines: [
      '. scripts/csa-loom/_grant-role-if-absent.sh',
      `grant_role_if_absent "$PID" ${CONTROL_ROLE} "$ACR_ID" "AcrPull"`,
    ],
    expectFindings: 0,
    expectPopulation: 1,
    expectJudged: 1,
  },
  {
    why: 'D3-HELPER: the role argument resolves through a YAML env binding as well',
    lines: [
      'env:',
      `  ACRPULL_ROLE: ${CONTROL_ROLE}`,
      '      - run: |',
      '          . scripts/csa-loom/_grant-role-if-absent.sh',
      '          grant_role_if_absent "$PID" "$ACRPULL_ROLE" "$ACR_ID" "AcrPull"',
    ],
    expectFindings: 0,
    expectPopulation: 1,
    expectJudged: 1,
  },
  {
    why: 'D3-HELPER: the function DEFINITION line is not a call site',
    lines: [
      'grant_role_if_absent() {',
      '  local principal="$1" role="$2" scope="$3"',
      '}',
    ],
    expectFindings: 0,
    expectPopulation: 0,
    expectJudged: 0,
  },
  {
    why: 'D3-HELPER: a MENTION of the helper inside an echo is a reference, not a call',
    lines: [
      `echo "call grant_role_if_absent \\"$PID\\" ${CONTROL_ROLE} \\"$S\\" instead"`,
    ],
    expectFindings: 0,
    expectPopulation: 0,
    expectJudged: 0,
  },
];

/** Runs the controls against the classifier in memory. Returns failures. */
export function runD3Controls() {
  const failures = [];
  const bicepRoles = new Set([CONTROL_ROLE]);
  for (const c of D3_CONTROLS) {
    const logical = c.lines.map((text, idx) => ({ text, line: idx + 1 }));
    // The SAME entry point the tree scan uses. Two copies of this loop is how a
    // control set ends up proving a classifier nothing judges the tree with.
    const { findings, population, judged } = classifyImperative(logical, bicepRoles, 'control');
    if (findings.length !== c.expectFindings) {
      failures.push(`expected ${c.expectFindings} finding(s), got ${findings.length} — ${c.why}`);
    }
    if (c.expectPopulation !== undefined && population !== c.expectPopulation) {
      failures.push(`expected population ${c.expectPopulation}, got ${population} — ${c.why}`);
    }
    if (c.expectJudged !== undefined && judged !== c.expectJudged) {
      failures.push(`expected judged ${c.expectJudged}, got ${judged} — ${c.why}`);
    }
  }
  return failures;
}

// ── driver ───────────────────────────────────────────────────────────────────

export function scan(root = BICEP_ROOT) {
  const records = inventory(root);
  const imperative = findImperativeCollisions(records);
  return {
    records,
    imperative,
    findings: [
      ...findNonDeterministicNames(records),
      ...findTripleCollisions(records),
      ...imperative.findings,
    ],
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  // The controls run IN-PROCESS, BEFORE the tree is judged (#3464 finding 4),
  // through the SAME `classifyImperative` entry point the tree scan uses. They
  // were load-bearing while D3's judged population was zero; now that the floor
  // below refuses a zero, they are what keeps the judge path itself honest.
  const controlFailures = runD3Controls();
  if (controlFailures.length > 0) {
    process.stderr.write(
      `check-role-assignment-determinism: the D3 EMBEDDED CONTROL failed (${controlFailures.length}). The ` +
        'classifier no longer behaves as documented, so any verdict about this tree would be meaningless.\n',
    );
    for (const f of controlFailures) process.stderr.write(`   - ${f}\n`);
    process.exit(1);
  }

  const { records, imperative, findings } = scan();
  if (records.length === 0) {
    process.stderr.write(
      'check-role-assignment-determinism: discovered ZERO role assignments under ' +
        `${path.relative(REPO_ROOT, BICEP_ROOT)} — discovery is broken, not clean.\n`,
    );
    process.exit(1);
  }
  // D3's FINDINGS may legitimately reach zero (every site probes). Its
  // POPULATION may not: this repo executes `az role assignment create` in both
  // cloud lanes, so zero create sites means the matcher drifted off the code,
  // and a verdict from a scanner that has stopped scanning is not a verdict
  // (guard_with_zero_population_needs_embedded_control).
  if (imperative.population === 0) {
    process.stderr.write(
      'check-role-assignment-determinism: discovered ZERO executed `az role assignment create` / ' +
        `\`${GRANT_HELPER}\` call sites under ${IMPERATIVE_ROOTS.join(', ')} — D3 is not scanning anything, ` +
        'which is not the same as a clean tree.\n',
    );
    process.exit(1);
  }
  // …and the population floor alone was not enough (#3464 finding 2). Between
  // 2026-08-23 and 2026-09-07 D3 ENUMERATED 33-34 creates and JUDGED ZERO of
  // them, because every resolvable `--role` named a role the bicep does not
  // grant and the one that mattered was bound in YAML `env:`, which the resolver
  // could not read. The guard reported OK the whole time, over an empty set,
  // with only a `::warning::` saying so — and a warning does not fail a build.
  // The floor is now on the number the verdict is actually ABOUT.
  if (imperative.judged === 0) {
    process.stderr.write(
      `check-role-assignment-determinism: D3 JUDGED ZERO of ${imperative.population} create site(s) ` +
        `(${imperative.resolved} resolved a role GUID). A clean D3 verdict over an EMPTY judged set is not a ` +
        'clean verdict. Either role resolution has narrowed (yamlEnvGuidVars / shellGuidVars / the ' +
        `\`${GRANT_HELPER}\` call reader) or every site now names a role the bicep does not grant — establish ` +
        'which before treating this as clean (#3464, deploy-integrity.md R7).\n',
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
    process.stdout.write(
      `\nimperative create SITES (\`az role assignment create\` + \`${GRANT_HELPER}\`) EXECUTED: ` +
        `${imperative.population}\n` +
        `  of which the role argument could NOT be resolved to a role definition GUID (not judged): ` +
        `${imperative.unresolved.length}\n`,
    );
    for (const u of imperative.unresolved) process.stdout.write(`  ${u.file}:${u.line}\n`);
  }
  for (const f of findings) process.stdout.write(`${f.check}  ${f.file}:${f.line}\n      ${f.detail}\n\n`);
  if (findings.length > 0) {
    process.stderr.write(
      `check-role-assignment-determinism: ${findings.length} finding(s) across ${records.length} ` +
        'role assignment(s). See deploy-integrity.md R4/R6 and issues #3039, #3439.\n',
    );
    process.exit(1);
  }

  // ── THE VERDICT, STATED HONESTLY (#3464, deploy-integrity.md R7) ──────────
  //
  // This line used to read "… 34 imperative create(s) checked for the same
  // collision against the CLI (D3)". Measured on main 2026-08-23:
  //
  //     enumerated (executed creates) .. 34
  //     resolved   (--role -> a GUID) ..  3
  //     JUDGED     (…and bicep grants it) 0
  //
  // So it CHECKED ZERO and said thirty-four. An error or status message must
  // not state as fact something it did not establish, and a count of what a
  // guard ENUMERATED reported as a count of what it JUDGED is exactly that.
  //
  // #3464 findings 1+2 are what made the number zero, and both are closed above:
  // role resolution now reads a workflow's YAML `env:` bindings, and a
  // `grant_role_if_absent` call is enumerated as a create site in its own right
  // so that adopting the remedy no longer DELETES a site from the population.
  // `judged === 0` is now a hard failure rather than a `::warning::`.
  //
  // What is still NOT judged, and why it is stated rather than hidden: the sites
  // whose `--role` is a DISPLAY NAME ("Storage Blob Data Contributor") or a
  // variable this reader cannot resolve. D3 refuses to rule on a role definition
  // it cannot establish; `--list` prints every one of them as residue.
  process.stdout.write(
    `check-role-assignment-determinism: OK — ${records.length} role assignment(s); every name is a ` +
      'deterministic guid(…) and no two declarations collide on one ARM triple. ' +
      `D3 ENUMERATED ${imperative.population} imperative create site(s), RESOLVED ${imperative.resolved}, ` +
      `and JUDGED ${imperative.judged} of them (the rest name a role the bicep does not grant, or a role ` +
      'argument this guard cannot resolve and therefore refuses to rule on). ' +
      `${D3_CONTROLS.length} embedded control(s) passed in-process before the tree was judged.\n`,
  );
}
