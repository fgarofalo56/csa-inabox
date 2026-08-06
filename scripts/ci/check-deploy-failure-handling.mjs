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
 * 114 workflows and excluded 39 that mutate Azure, 13 of them `gov-provision-*`.
 * Measured: `gov-provision-aisearch.yml` runs `az deployment group create` and
 * `gov-provision-maps.yml` runs `az acr build`, and neither was ever looked at.
 * That is the same class as the `getSession(`-literal guard that made four
 * exploitable routes invisible: a control whose reach is decided by a name is
 * defeated by a rename, and lands exactly where the guard is the only control.
 *
 * Scope is therefore decided by WHAT THE WORKFLOW DOES. A workflow is in scope
 * when any of its `run:` blocks issues an Azure-mutating command. The name
 * pattern is kept as an OR arm so the deploy/build/roll workflows stay in scope
 * even if a future refactor moves their `az` calls into a script.
 */
export const IN_SCOPE = /(^|[-_])(deploy|build|roll|rollback)/i;

/**
 * An Azure command that CHANGES something (or builds an image that will be
 * deployed). Read-only verbs — `show`, `list`, `query` — are deliberately absent:
 * this guard is about deploy-path failure handling, not about every `az` call.
 */
export const AZ_MUTATING =
  /\baz\s+(?:deployment\s+\w+\s+(?:create|validate|what-if)|acr\s+build|containerapp\s+(?:create|update|revision\s+\w+)|group\s+create|provider\s+register|role\s+assignment\s+create|webapp\s+(?:create|deployment)|functionapp\s+(?:create|deployment)|storage\s+account\s+create|keyvault\s+(?:create|set)|monitor\s+\w+\s+create)\b/;

export function isInScope(file, source) {
  if (IN_SCOPE.test(file)) return true;
  return runBlocks(source).some((b) => b.body.some((l) => !isComment(l.text) && AZ_MUTATING.test(l.text)));
}

export function inScopeWorkflows(dir = WF_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .filter((f) => isInScope(f, fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort();
}

/**
 * Split a workflow into its `run: |` script blocks, keeping the 1-based line
 * number each starts on so a finding can be pointed at.
 */
export function runBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!/run:\s*\|/.test(lines[i])) {
      i += 1;
      continue;
    }
    const indent = (lines[i].match(/^\s*/) ?? [''])[0].length;
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
  const findings = scan();
  const wfCount = inScopeWorkflows().length;
  if (wfCount === 0) {
    // Discovery matching nothing would report green having checked nothing.
    process.stderr.write('check-deploy-failure-handling: matched ZERO workflows — discovery is broken.\n');
    process.exit(1);
  }
  for (const f of findings) {
    process.stdout.write(`${f.check}  ${f.file}:${f.line}\n      ${f.detail}\n\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(
      `check-deploy-failure-handling: ${findings.length} finding(s) across ${wfCount} workflow(s). ` +
        'See deploy-integrity.md R6/R7.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-deploy-failure-handling: OK — ${wfCount} deploy/build/roll workflow(s) clean (C1..C4).\n`,
  );
}
