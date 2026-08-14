#!/usr/bin/env node
/**
 * check-deploy-failure-handling.mjs — teeth for deploy-integrity.md R6 and R7.
 *
 * WHAT EACH CHECK EXISTS FOR (all four are things that actually happened)
 *
 *  C1  A FAILURE NOTIFICATION THAT NOBODY RECEIVES.
 *      Four deploy workflows posted every failure as a comment on
 *      `issue_number: 279` — "CSA Loom — v1 build roadmap", state CLOSED, 289
 *      comments — with the body "Check workflow logs". That is the literal
 *      mechanism by which 47 days of daily deploy failure stayed invisible
 *      (deploy-integrity.md, "Why this rule exists"). A failure notice must go
 *      to a DEDICATED, auto-titled, OPEN issue, never to a hard-coded number.
 *
 *  C2  A RETRY THAT DOES NOT KNOW WHAT IT IS RETRYING.
 *      `for attempt in 1 2 3; do az acr build … ; sleep 30; done` retried a
 *      deterministic `QuotaExceeded: standardDDSv5Family Cores … Current Limit:
 *      200` three times and reported "failed after 3 attempts" — a sentence
 *      with no cause in it. R6 requires classification, so every retry around
 *      an `az` mutation goes through scripts/ci/deploy-retry.mjs.
 *
 *  C3  "I COULD NOT READ IT" RENDERED AS "IT DOES NOT EXIST" — R7 verbatim.
 *          DIGEST=$(az acr repository show … -o tsv 2>/dev/null || echo "")
 *          if [[ -z "$DIGEST" ]]; then echo "::error::… the tag does not exist"
 *      The `2>/dev/null` turns an RBAC denial, a throttle, a network failure
 *      and a genuine 404 into the same empty string, and the message then
 *      states the 404 as fact. That message sent two separate investigations
 *      down the wrong path. This check finds the SHAPE, not the wording.
 *
 *  C4  THE TAXONOMY ITSELF DRIFTING OR GOING UNREACHABLE.
 *      One table, two consumers. If either consumer stops resolving it, or the
 *      table grows a class with no precedence entry (which would sort LAST and
 *      be silently outranked by everything), the engine degrades quietly.
 *
 * USAGE
 *   node scripts/ci/check-deploy-failure-handling.mjs
 *   node scripts/ci/check-deploy-failure-handling.mjs --list   # findings only
 *
 * There is NO allow-list and NO baseline file. A baseline of tolerated
 * violations is how a ratchet rots (csa_loom_guard_adoption_gap); if a new
 * violation lands, this goes red and the fix is to fix it.
 *
 * Tests: node --test scripts/ci/__tests__/deploy-failure-handling.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WF_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Workflows in scope.
 *
 * NAME-BASED SCOPING WAS THE HOLE. The first cut of this guard scoped on the
 * FILENAME — `/(^|[-_])(deploy|build|roll|rollback)/i` — which matched 27 of
 * 114 workflows and excluded 17 that mutate Azure, 11 of them `gov-provision-*`.
 * Measured: `gov-provision-aisearch.yml` runs `az deployment group create` and
 * `gov-provision-maps.yml` runs `az acr build`, and neither was ever looked at.
 * That is the same class as the `getSession(`-literal guard that made four
 * exploitable routes invisible: a control whose reach is decided by a name is
 * defeated by a rename, and lands exactly where the guard is the only control.
 *
 * Scope is therefore decided by WHAT THE WORKFLOW DOES. The name pattern is
 * kept only as an OR arm so a deploy/build/roll workflow stays in scope even
 * when it has no inline `az` at all.
 *
 * The SECOND cut of the behavioural arm still had two holes, both measured:
 *
 *   - It classified with an ALLOW-LIST of mutating verbs
 *     (`acr build|group create|keyvault (create|set)|…`). An allow-list of
 *     verbs is a name-based control wearing a different hat: `ops-kv-secret-sync.yml`
 *     runs `az keyvault SECRET set` and `copilot-quality-evals.yml` runs
 *     `az containerapp JOB start`, and neither spelling was on the list, so both
 *     stayed invisible. Classification is therefore inverted below: an `az`
 *     command is treated as MUTATING unless it is provably read-only or purely
 *     CLI-local. A verb nobody has thought of yet defaults to IN scope.
 *   - It only looked inside `run: |` blocks, so `run: az …` on one line and
 *     `run: >`-folded scripts were invisible, and a workflow whose `az` lives in
 *     a repo shell script it invokes (`teardown-fiab-commercial.yml` ->
 *     `.github/scripts/fiab-teardown.sh`, which deletes resource groups) was
 *     invisible too. Both are closed below.
 *
 * The behavioural arm is also ratcheted: if it ever stops contributing anything
 * beyond the filename arm, the driver exits 1 rather than reporting a smaller,
 * greener scope (see `assertDiscoveryHealthy`). A scope that silently shrinks is
 * how a guard rots back to the defect it was written for.
 */
export const IN_SCOPE = /(^|[-_])(deploy|build|roll|rollback)/i;

/**
 * `az` invocations that change nothing in Azure because they only touch the
 * LOCAL CLI (profile, cloud, extensions, the bicep compiler) or are pure reads.
 * Everything else is treated as mutating — see `isAzureMutatingCommand`.
 */
const AZ_CLI_LOCAL = [
  /^az\s+(?:login|logout|version|upgrade|self-test|interactive|feedback|find|survey|configure)\b/,
  /^az\s+account\s+(?:set|show|list|list-locations|clear|get-access-token)\b/,
  /^az\s+cloud\s+(?:set|show|list|list-profiles|register|unregister|update)\b/,
  /^az\s+config\s+\S+/,
  /^az\s+extension\s+\S+/,
  /^az\s+bicep\b/,
  /^az\s+graph\s+query\b/,
];

/**
 * Verb prefixes that only READ. Prefix-matched on purpose so `show-tags`,
 * `list-locations`, `check-health` and `get-access-token` are covered without
 * enumerating them — the opposite policy to the verb allow-list this replaced.
 */
const AZ_READ_VERB = /^(?:show|list|get|query|exists|check|download|export|describe|wait|search|history|is-|login|logout)/;

/**
 * `az deployment … validate|what-if` reads rather than writes, but it is a
 * DEPLOY-PATH call and its failure handling is exactly what R6/R7 govern, so it
 * is deliberately in scope.
 */
const AZ_DEPLOY_PATH = /^az\s+deployment\s+\S+\s+(?:validate|what-if)\b/;

/**
 * Is the text before an `az` token a place a COMMAND can start?
 *
 * Without this, prose wins: `echo "::warning::az identity show failed (not a
 * divergence …)"` and `echo "az reported success but returned no id"` were both
 * classified as Azure mutations, because the tail of an English sentence is not
 * a read verb. Scoping a workflow in on its own log messages is the mirror image
 * of scoping one out on its filename — both decide on text rather than
 * behaviour — so the token must sit where a shell would execute it.
 */
function atCommandPosition(prefix) {
  const p = prefix.replace(/\s+$/, '');
  if (p === '') return true; // start of line
  if (/[|;&(`{!]$/.test(p)) return true; // after a separator, subshell or negation
  if (/(?:^|\s)(?:if|elif|then|else|do|while|until|exec|sudo|time|command|eval)$/.test(p)) return true;
  if (/run:$/.test(p)) return true; // `run: az …` — a single-line step
  if (/^-$/.test(p)) return true; // `- az …` in a YAML sequence
  return false;
}

/** Pull every `az …` INVOCATION out of one line of shell (prose is not an invocation). */
export function azInvocations(text) {
  const out = [];
  const re = /\baz\s+(?=[a-z])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!atCommandPosition(text.slice(0, m.index))) continue;
    // Stop at a shell separator so `az group create | tee` does not absorb the pipe.
    const rest = text.slice(m.index).split(/[|;&)]|\s&&\s/)[0];
    out.push(rest.trim());
  }
  return out;
}

/**
 * Does this `az …` command change Azure state?
 *
 * DEFAULT IS YES. This is the fail-safe direction: a command the classifier has
 * never seen lands IN scope and gets looked at, instead of slipping out of scope
 * and being reported green.
 */
export function isAzureMutatingCommand(cmd) {
  const c = cmd.trim();
  if (!/^az\s/.test(c)) return false;
  if (/--help\b|\s-h(?:\s|$)/.test(c)) return false;
  if (AZ_DEPLOY_PATH.test(c)) return true;
  if (AZ_CLI_LOCAL.some((re) => re.test(c))) return false;
  if (/^az\s+rest\b/.test(c)) {
    const method = /--method[\s=]+["']?([A-Za-z]+)/.exec(c);
    return method ? !/^(?:get|head)$/i.test(method[1]) : false;
  }
  const words = c
    .replace(/\\$/, '') // a trailing line-continuation is not a verb
    .split(/\s+/)
    .slice(1)
    .filter(Boolean);
  // The command PATH is everything before the first flag. Taking "the last token
  // that is not a flag" instead reads the flag's VALUE as the verb —
  // `az group show -n "$RG" -o none 2>/dev/null` then classifies on
  // `2>/dev/null` and a plain read is reported as a mutation.
  const cut = words.findIndex((w) => w.startsWith('-'));
  const commandPath = cut === -1 ? words : words.slice(0, cut);
  const verb = commandPath.at(-1);
  if (!verb) return false;
  return !AZ_READ_VERB.test(verb);
}

/**
 * YAML keys whose value is prose, never a command. `- name: Build + push via
 * ACR Tasks (az acr build)` is a step TITLE; treating it as an invocation would
 * scope workflows in on their documentation.
 */
const PROSE_KEY = /^\s*(?:-\s*)?(?:name|description|title|summary|if|env|id):/;

/** Every line of `source` that issues an Azure-mutating command. */
export function azMutatingLines(source) {
  return source
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => !isComment(text) && !PROSE_KEY.test(text))
    .filter(({ text }) => azInvocations(text).some(isAzureMutatingCommand));
}

/**
 * Repo SHELL scripts a workflow invokes. Restricted to `.sh`/`.bash` because in
 * those an `az …` token is an invocation, whereas in a `.mjs` guard it is
 * usually a string inside a remediation message — following those would scope in
 * the guard workflows on their own error text.
 */
export function referencedShellScripts(source, root = REPO_ROOT) {
  const out = new Set();
  const re = /(?<![\w./-])((?:\.github\/)?scripts\/[A-Za-z0-9._/-]+\.(?:sh|bash))/g;
  for (const m of source.matchAll(re)) {
    if (fs.existsSync(path.join(root, m[1]))) out.add(m[1]);
  }
  return [...out];
}

/**
 * @returns {{inScope: boolean, reason: string}} the reason is reported by
 * `--list` so a scoping decision is never a black box.
 */
export function scopeOf(file, source, root = REPO_ROOT) {
  const direct = azMutatingLines(source);
  if (direct.length > 0) {
    return { inScope: true, reason: `runs \`${azInvocations(direct[0].text).find(isAzureMutatingCommand).slice(0, 60)}\`` };
  }
  for (const rel of referencedShellScripts(source, root)) {
    const hits = azMutatingLines(fs.readFileSync(path.join(root, rel), 'utf8'));
    if (hits.length > 0) return { inScope: true, reason: `invokes ${rel}, which mutates Azure` };
  }
  if (IN_SCOPE.test(file)) return { inScope: true, reason: 'deploy/build/roll workflow (name arm)' };
  return { inScope: false, reason: 'no Azure-mutating command, directly or via a repo shell script' };
}

export function isInScope(file, source, root = REPO_ROOT) {
  return scopeOf(file, source, root).inScope;
}

/** `.yaml` is accepted as well as `.yml`; an extension rename must not un-scope a workflow. */
const IS_WORKFLOW = /\.ya?ml$/;

export function inScopeWorkflows(dir = WF_DIR, root = REPO_ROOT) {
  return fs
    .readdirSync(dir)
    .filter((f) => IS_WORKFLOW.test(f))
    .filter((f) => isInScope(f, fs.readFileSync(path.join(dir, f), 'utf8'), root))
    .sort();
}

/**
 * The anti-collapse ratchet.
 *
 * A guard whose discovery quietly shrinks reports green having looked at less.
 * Two independent conditions must hold, and both are about DISCOVERY, not about
 * findings — neither can be satisfied by tolerating a violation:
 *
 *   1. scope is non-empty;
 *   2. the BEHAVIOURAL arm contributes at least one workflow the filename arm
 *      does not. If a future edit breaks `isAzureMutatingCommand`, scope
 *      collapses back to the 27 name-matched files and this fails loudly instead
 *      of shrinking in silence.
 *
 * @returns {string[]} problems; empty means healthy.
 */
export function assertDiscoveryHealthy(dir = WF_DIR, root = REPO_ROOT) {
  const scoped = inScopeWorkflows(dir, root);
  const problems = [];
  if (scoped.length === 0) problems.push('matched ZERO workflows — discovery is broken.');
  const behavioural = scoped.filter((f) => !IN_SCOPE.test(f));
  if (behavioural.length === 0) {
    problems.push(
      'the BEHAVIOURAL arm matched nothing — scope has collapsed back to filenames, which is the ' +
        'exact hole this guard was rewritten to close (gov-provision-*.yml mutate Azure and are not ' +
        'named deploy/build/roll). Fix isAzureMutatingCommand rather than accepting the smaller scope.',
    );
  }
  return problems;
}

/**
 * Split a workflow into its `run:` script blocks, keeping the 1-based line
 * number each starts on so a finding can be pointed at.
 *
 * All three spellings are captured. An earlier cut handled only `run: |`, which
 * meant `run: az …` on a single line and `run: >`-folded scripts were invisible
 * to C1..C3 — a workflow could dodge the whole guard by not using a literal
 * block scalar.
 */
export function runBlocks(source) {
  // PHYSICAL-LINES-OK: this slices YAML `run:` BLOCK SCALARS by indentation, and
  // every rule over the body is single-token PRESENCE within the block (a
  // mutating `az`, a retry loop, a `-z "$VAR"` test, an `echo "::"` claim) —
  // never "two tokens on one line". C3 also counts a 12-line proximity window
  // from the emptiness test to the claim, which is deliberately a window of
  // PHYSICAL lines: folding would silently change how far it reaches (#3420).
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^(\s*)-?\s*run:\s*(.*)$/.exec(lines[i]);
    if (!m) {
      i += 1;
      continue;
    }
    const [, lead, value] = m;
    if (!/^[|>][-+]?\s*$/.test(value.trim())) {
      // Single-line `run: <command>` — a block of exactly one line.
      if (value.trim() !== '') blocks.push({ startLine: i + 1, body: [{ line: i + 1, text: value }] });
      i += 1;
      continue;
    }
    const indent = lead.length;
    const body = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || (lines[j].match(/^\s*/) ?? [''])[0].length > indent)) {
      body.push({ line: j + 1, text: lines[j] });
      j += 1;
    }
    blocks.push({ startLine: i + 1, body });
    i = j;
  }
  return blocks;
}

const isComment = (t) => /^\s*#/.test(t);

// ── C1 ───────────────────────────────────────────────────────────────────────

/** A hard-coded issue number in a failure notifier. */
export function findHardCodedNotifyTargets(source, file) {
  const out = [];
  source.split(/\r?\n/).forEach((text, idx) => {
    if (isComment(text)) return;
    const m = /issue_number:\s*(\d+)/.exec(text);
    if (m) {
      out.push({
        check: 'C1',
        file,
        line: idx + 1,
        detail:
          `failure notice is hard-coded to issue #${m[1]}. Issue #279 — the one this pattern ` +
          'used — is CLOSED with 289 comments, which is how 47 days of daily deploy failure ' +
          'stayed invisible. Resolve or open a dedicated issue by TITLE instead ' +
          '(see .github/scripts/deploy-notify-failure.mjs).',
      });
    }
  });
  return out;
}

// ── C2 ───────────────────────────────────────────────────────────────────────

/** `az` verbs that CHANGE something and therefore must not be blind-retried. */
const AZ_MUTATIONS =
  /\baz\s+(deployment\s+\w+\s+create|acr\s+build|containerapp\s+(update|create)|containerapp\s+job\s+(update|create)|group\s+create|role\s+assignment\s+create)/;

const RETRY_LOOP = /^\s*(for\s+\w+\s+in\s+[\d\s]+;\s*do|until\s+|while\s+!)/;

export function findHandRolledRetries(source, file) {
  const out = [];
  for (const block of runBlocks(source)) {
    const hasLoop = block.body.find((l) => !isComment(l.text) && RETRY_LOOP.test(l.text));
    if (!hasLoop) continue;
    const mutation = block.body.find((l) => !isComment(l.text) && AZ_MUTATIONS.test(l.text));
    if (!mutation) continue;
    if (block.body.some((l) => l.text.includes('deploy-retry.mjs'))) continue;
    out.push({
      check: 'C2',
      file,
      line: hasLoop.line,
      detail:
        `hand-rolled retry loop around "${mutation.text.trim().slice(0, 80)}". An unclassified ` +
        'retry burns its budget on failures retrying cannot fix (a QuotaExceeded was retried 3× ' +
        'over 90s and reported without the word "quota"). Use ' +
        'scripts/ci/deploy-retry.mjs --class-allow transient,eventual-consistency -- <cmd>.',
    });
  }
  return out;
}

// ── C3 ───────────────────────────────────────────────────────────────────────

/**
 * `VAR=$(az … 2>/dev/null …)` or `VAR=$(az … || echo "")` — a value whose
 * emptiness can mean four different things.
 */
const ASSIGN_FROM_BLIND_AZ =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*az\s[^)]*(?:2>\s*\/dev\/null|\|\|\s*echo\s*(?:""|''))/;

/**
 * `VAR=$(… $OTHER …)` or `VAR="$OTHER"` — how blindness travels one hop. The
 * first draft of this check missed exactly this and a one-line rename defeated
 * the whole guard; see the comment in findAbsenceClaimedFromDiscardedError.
 */
const ASSIGN_FROM_VAR = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

/** A claim that an Azure thing is absent. Wording-agnostic on purpose. */
const ABSENCE_CLAIM =
  /(does\s*n[o']?t\s+exist|is\s+NOT\s+in\b|do\s+not\s+exist|not\s+found\b|no\s+such\b)/i;

/*
 * NOTE — there is deliberately NO "this block calls a three-state helper, so
 * exempt it" escape hatch. An earlier draft had one, and it made the guard
 * defeatable by the very defect it hunts: calling
 * `deploy-classify.mjs --text "$OUT"` proves nothing when $OUT came from
 * `az … 2>/dev/null`, because the error text the classifier needed was thrown
 * away before it ran. The classifier then sees "" , returns `unknown`, and the
 * code falls through to the absence claim anyway. Discarding stderr is the
 * defect; no downstream helper can undo it.
 */

export function findAbsenceClaimedFromDiscardedError(source, file) {
  const out = [];
  for (const block of runBlocks(source)) {
    // TAINT, not a single variable. The first draft of this check tracked only
    // the variable the blind `az` call assigned to — and a one-line
    // indirection walked straight past it:
    //     SHOW_OUT=$(az … 2>/dev/null || echo "")   # blind
    //     D=$(echo "$SHOW_OUT" | tr -d '\r')        # D is just as blind
    //     if [ -z "$D" ]; then echo "::error::… is NOT in $ACR"
    // A guard that a one-line rename defeats is not a guard, so blindness
    // propagates through assignments.
    const blind = new Map(); // varName -> the line that made it blind
    let changed = true;
    let pass = 0;
    while (changed && pass < 5) {
      changed = false;
      pass += 1;
      for (const l of block.body) {
        if (isComment(l.text)) continue;
        const direct = ASSIGN_FROM_BLIND_AZ.exec(l.text);
        if (direct && !blind.has(direct[1])) {
          blind.set(direct[1], l);
          changed = true;
          continue;
        }
        const derived = ASSIGN_FROM_VAR.exec(l.text);
        if (!derived) continue;
        const [, target, rhs] = derived;
        if (blind.has(target)) continue;
        const usesTainted = [...blind.keys()].some((v) =>
          new RegExp(`\\$\\{?${v}\\b`).test(rhs),
        );
        if (usesTainted) {
          blind.set(target, blind.get([...blind.keys()].find((v) => new RegExp(`\\$\\{?${v}\\b`).test(rhs))));
          changed = true;
        }
      }
    }
    if (blind.size === 0) continue;

    // Find an emptiness test on one of those variables whose branch makes an
    // absence claim. Scanning forward from the test keeps this to the branch
    // the test actually guards rather than the whole block.
    for (const [name, assignLine] of blind) {
      const emptyTest = new RegExp(`-z\\s+"?\\$\\{?${name}\\b`);
      const idx = block.body.findIndex((l) => !isComment(l.text) && emptyTest.test(l.text));
      if (idx === -1) continue;
      const claim = block.body
        .slice(idx, idx + 12)
        .find((l) => !isComment(l.text) && /echo\s+"::/.test(l.text) && ABSENCE_CLAIM.test(l.text));
      if (!claim) continue;
      out.push({
        check: 'C3',
        file,
        line: claim.line,
        detail:
          `$${name} traces back to an az call whose failure is discarded (line ${assignLine.line}), ` +
          `and its emptiness is then stated as absence (line ${claim.line}). A denial, a throttle, ` +
          'a network failure and a genuine 404 all produce "" — the message asserts a cause the ' +
          'code never established (R7). Capture stderr and classify it: ' +
          'OUT=$(az … 2>&1) then `node scripts/ci/deploy-classify.mjs --text "$OUT" --assert-signal …`, ' +
          'or use scripts/ci/assert-acr-image-tags.sh.',
      });
      break; // one finding per block is enough to make the point
    }
  }
  return out;
}

// ── C4 ───────────────────────────────────────────────────────────────────────

export const TAXONOMY_REL = 'apps/fiab-console/lib/deploy/failure-taxonomy.json';

export function checkTaxonomyIntegrity(root = REPO_ROOT) {
  const out = [];
  const taxPath = path.join(root, TAXONOMY_REL);
  if (!fs.existsSync(taxPath)) {
    return [{ check: 'C4', file: TAXONOMY_REL, line: 0, detail: 'the failure taxonomy is missing.' }];
  }
  const tax = JSON.parse(fs.readFileSync(taxPath, 'utf8'));

  for (const s of tax.signals ?? []) {
    if (!tax.classPrecedence?.includes(s.class)) {
      out.push({
        check: 'C4',
        file: TAXONOMY_REL,
        line: 0,
        detail: `signal ${s.id} declares class "${s.class}", which is absent from classPrecedence — it would sort LAST and be silently outranked by every other class.`,
      });
    }
    if (!tax.classes?.[s.class]) {
      out.push({ check: 'C4', file: TAXONOMY_REL, line: 0, detail: `signal ${s.id} declares class "${s.class}", which has no entry in classes{}.` });
    }
    if (!(s.anyOf?.length || s.allOf?.length)) {
      out.push({ check: 'C4', file: TAXONOMY_REL, line: 0, detail: `signal ${s.id} has neither anyOf nor allOf — it would match EVERY input and swallow the taxonomy.` });
    }
  }

  // Both consumers must still resolve the SAME file.
  const consumers = [
    ['scripts/ci/deploy-classify.mjs', /['"]failure-taxonomy\.json['"]/],
    ['apps/fiab-console/lib/deploy/failure-taxonomy.ts', /from '\.\/failure-taxonomy\.json'/],
  ];
  for (const [rel, re] of consumers) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) {
      out.push({ check: 'C4', file: rel, line: 0, detail: 'a taxonomy consumer is missing.' });
      continue;
    }
    if (!re.test(fs.readFileSync(p, 'utf8'))) {
      out.push({
        check: 'C4',
        file: rel,
        line: 0,
        detail: 'this consumer no longer references failure-taxonomy.json — the two implementations would drift silently.',
      });
    }
  }
  return out;
}

// ── driver ───────────────────────────────────────────────────────────────────

export function scan(root = REPO_ROOT) {
  const dir = path.join(root, '.github', 'workflows');
  const findings = [];
  for (const f of inScopeWorkflows(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    findings.push(
      ...findHardCodedNotifyTargets(src, f),
      ...findHandRolledRetries(src, f),
      ...findAbsenceClaimedFromDiscardedError(src, f),
    );
  }
  findings.push(...checkTaxonomyIntegrity(root));
  return findings;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const problems = assertDiscoveryHealthy();
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`check-deploy-failure-handling: ${p}\n`);
    process.exit(1);
  }
  const scoped = inScopeWorkflows();
  const findings = scan();
  if (process.argv.includes('--list')) {
    const dir = path.join(REPO_ROOT, '.github', 'workflows');
    for (const f of scoped) {
      const { reason } = scopeOf(f, fs.readFileSync(path.join(dir, f), 'utf8'));
      process.stdout.write(`${IN_SCOPE.test(f) ? 'name  ' : 'BEHAVE'}  ${f}  — ${reason}\n`);
    }
  }
  for (const f of findings) {
    process.stdout.write(`${f.check}  ${f.file}:${f.line}\n      ${f.detail}\n\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(
      `check-deploy-failure-handling: ${findings.length} finding(s) across ${scoped.length} workflow(s). ` +
        'See deploy-integrity.md R6/R7.\n',
    );
    process.exit(1);
  }
  const behavioural = scoped.filter((f) => !IN_SCOPE.test(f)).length;
  process.stdout.write(
    `check-deploy-failure-handling: OK — ${scoped.length} Azure-mutating workflow(s) clean (C1..C4); ` +
      `${scoped.length - behavioural} by name, ${behavioural} by behaviour.\n`,
  );
}
