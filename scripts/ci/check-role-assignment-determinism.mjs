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

export function isExecuted(text) {
  const at = text.indexOf(CREATE_TOKEN);
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

/** The role definition GUID a `--role <token>` resolves to, or null. */
export function resolveRoleArg(text, vars) {
  const m = /--role\s+("[^"]*"|'[^']*'|\S+)/.exec(text);
  if (!m) return null;
  const raw = m[1].replace(/^["']|["']$/g, '');
  if (GUID_RE.test(raw)) return raw.toLowerCase();
  const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
  if (v && vars.has(v[1])) return vars.get(v[1]);
  return null;
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
const EARLY_EXIT = /(?:^|[;&|(){}]|\s)(?:exit|return|continue|break)\b/;

/**
 * Net block-nesting change of one logical line. A conditional that opens AND
 * closes on its own line — `if true; then echo "$N"; fi` — controls nothing
 * that follows it, so it cannot be the gate for a create three lines later.
 */
export function blockDelta(text) {
  const count = (re) => (text.match(re) || []).length;
  return count(BLOCK_OPEN) - count(BLOCK_CLOSE);
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
 *            have a POSITIVE NET BLOCK DELTA (more `if`/`case`/`do` than
 *            `fi`/`esac`/`done` on that one line) or carry an early-exit
 *            keyword (`exit`/`return`/`continue`/`break`).
 *
 * STATED LIMITS (R7). Path (b) is a LINE READ, not a parse, and the round-2
 * review of #3928 measured exactly how far that falls short. Each of these is a
 * known FALSE-NEGATIVE — (b) answers `gated: true` and the create is in fact
 * unconditional. They are recorded here because the guard must not be read as
 * claiming more than it establishes; they are tracked in #3958, NOT fixed here:
 *   - it does not verify the probe targets the SAME (assignee, scope, role)
 *     triple as the create it guards. That needs the shell variables resolved
 *     across the file; it is reported by `--list` as residue instead.
 *   - `blockDelta` is PER LINE and never accumulated across the window, so an
 *     `if …; then` / `fi` block that OPENS AND CLOSES before the create still
 *     reads as gating it, for the remaining 12 logical lines.
 *   - it does not establish that the create sits inside THAT block rather than a
 *     sibling `else` arm. Full block scoping is a parse, not a line read.
 *   - `EARLY_EXIT` matches the keyword ANYWHERE on the line, INCLUDING inside a
 *     quoted string: `echo "will not break here"` and `echo "grant absent,
 *     continue"` both satisfy it. It is not required to stand in command
 *     position, nor on the branch that does NOT reach the create.
 *   - path (b) does not skip COMMENT lines, so a commented-out conditional
 *     (`# if [ "$N" = "0" ]; then …`) still contributes a positive block delta.
 *     `isExecuted` skips comments for the create side; this read does not.
 *   - `conditionRegions` treats `{` as opening a command position, so a `{` in
 *     an `echo` ARGUMENT (`echo {[ $N ] && …`) can open a condition region.
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

  // (b) a PRECEDING line, between the probe and the create.
  for (const l of window.slice(probeIdx + 1)) {
    if (!conditionRegions(l.text).some((r) => readsVar(r.text))) continue;
    if (blockDelta(l.text) > 0 || EARLY_EXIT.test(l.text)) return { gated: true };
  }

  return {
    gated: false,
    why: 'a probe runs and its answer is captured, but no CONDITION that reads that variable actually controls '
      + 'the create — the create is unconditional. `if true; then` above it, and `create … || true` on its own '
      + 'line, are the demonstrated bypasses',
  };
}

/**
 * @returns {{findings: object[], population: number, judged: number, resolved: number, unresolved: object[]}}
 *   `population` is every EXECUTED create found, resolvable or not.
 *   `resolved`   is those whose `--role` resolved to a role-definition GUID.
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
    const vars = shellGuidVars(logical);

    for (let i = 0; i < logical.length; i += 1) {
      const l = logical[i];
      if (!isExecuted(l.text)) continue;
      population += 1;

      const role = resolveRoleArg(l.text, vars);
      if (!role) {
        unresolved.push({ file: rel, line: l.line });
        continue;
      }
      resolved += 1;
      if (!bicepRoles.has(role)) continue;
      judged += 1;

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
          'deploy-fiab-commercial 31780698652, #3439). Probe first and create only on an established absence.',
      });
    }
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
];

/** Runs the controls against the classifier in memory. Returns failures. */
export function runD3Controls() {
  const failures = [];
  for (const c of D3_CONTROLS) {
    const logical = c.lines.map((text, idx) => ({ text, line: idx + 1 }));
    const findings = [];
    let population = 0;
    for (let i = 0; i < logical.length; i += 1) {
      if (!isExecuted(logical[i].text)) continue;
      population += 1;
      const role = resolveRoleArg(logical[i].text, shellGuidVars(logical));
      if (!role || role !== CONTROL_ROLE) continue;
      if (probeGates(logical, i).gated) continue;
      findings.push(i);
    }
    if (findings.length !== c.expectFindings) {
      failures.push(`expected ${c.expectFindings} finding(s), got ${findings.length} — ${c.why}`);
    }
    if (c.expectPopulation !== undefined && population !== c.expectPopulation) {
      failures.push(`expected population ${c.expectPopulation}, got ${population} — ${c.why}`);
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
  // The controls run IN-PROCESS, BEFORE the tree is judged (#3464 finding 4).
  // This is load-bearing rather than decorative here: D3's JUDGED population is
  // currently ZERO, so without these the guard would have no evidence at all
  // that its judge path still works.
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
  // cloud lanes, so zero executed creates means the matcher drifted off the
  // code, and a verdict from a scanner that has stopped scanning is not a
  // verdict (guard_with_zero_population_needs_embedded_control).
  if (imperative.population === 0) {
    process.stderr.write(
      'check-role-assignment-determinism: discovered ZERO executed `az role assignment create` calls under ' +
        `${IMPERATIVE_ROOTS.join(', ')} — D3 is not scanning anything, which is not the same as a clean tree.\n`,
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
      `\nimperative \`az role assignment create\` calls EXECUTED: ${imperative.population}\n` +
        `  of which the --role could NOT be resolved to a role definition GUID (not judged): ` +
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
  // #3464 filed this as "population 34, unresolved ~32 -> only ~4 judged"; it
  // has since degraded to zero, so the sentence was not merely imprecise, it
  // was describing work that is not happening.
  //
  // Why the number is zero, and why that is NOT fixed here: 31 of the 34 sites
  // pass `--role` as a DISPLAY NAME ("Storage Blob Data Contributor", "Reader")
  // or an unresolvable variable, and the 3 that do resolve name roles the bicep
  // does not grant. Widening resolution — reading role GUIDs out of a workflow's
  // YAML `env:` mapping, which is #3464 finding 1 — makes exactly ONE more site
  // judgeable, `gov-provision-streaming-migrate.yml:330`, and that site is an
  // UNGATED create with `2>/dev/null || true`. So the widening and the fix are
  // inseparable, and the file is owned by the deploy lane. Routed, not silently
  // widened, and not silently left unsaid.
  const judgedNote =
    imperative.judged === 0
      ? 'and D3 JUDGED NONE of them — see the note in this file and #3464; the D3 controls above are '
        + 'therefore the only live evidence its judge path works'
      : `and D3 JUDGED ${imperative.judged} of them (the rest name a role the bicep does not grant, or a `
        + '--role this guard cannot resolve and therefore refuses to rule on)';
  process.stdout.write(
    `check-role-assignment-determinism: OK — ${records.length} role assignment(s); every name is a ` +
      'deterministic guid(…) and no two declarations collide on one ARM triple. ' +
      `D3 ENUMERATED ${imperative.population} imperative create(s), RESOLVED ${imperative.resolved}, ` +
      `${judgedNote}. ${D3_CONTROLS.length} embedded control(s) passed in-process before the tree was judged.\n`,
  );
  if (imperative.judged === 0) {
    process.stdout.write(
      '::warning::check-role-assignment-determinism: D3 judged ZERO of ' +
        `${imperative.population} executed \`az role assignment create\` calls. Its clean verdict is about ` +
        'an EMPTY set. Closing this needs role-name resolution widened (#3464 finding 1) together with the ' +
        'ungated create it exposes in .github/workflows/gov-provision-streaming-migrate.yml — one change, ' +
        'owned by the deploy lane.\n',
    );
  }
}
