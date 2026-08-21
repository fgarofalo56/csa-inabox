#!/usr/bin/env node
/**
 * deploy-retry.mjs — THE retry primitive for every deploy / build / roll step.
 *
 * deploy-integrity.md R6: "Retry what is genuinely transient, with bounded
 * backoff, and FAIL CLOSED on exhaustion. A retry that cannot fail is
 * forbidden."
 *
 * WHAT IT REPLACES
 *
 *   full-app-deploy-commercial.yml wrapped `az acr build` in
 *       for attempt in 1 2 3; do build && exit 0; sleep 30; done
 *       echo "::error::$APP ACR build failed after 3 attempts"
 *   with NO classification. On run 31022950740 that retried a deterministic
 *   `QuotaExceeded: standardDDSv5Family Cores … Current Limit: 200, Current
 *   Usage: 196` three times over 90 seconds and then emitted a sentence that
 *   does not contain the word "quota". Retrying a quota denial cannot succeed;
 *   the only thing those 90 seconds bought was a less accurate error.
 *
 *   The one CORRECT retry in the repo — roll() in the same workflow, which
 *   retries only on `OperationInProgress`, cats the stderr, and returns 1 on
 *   anything else — is the behaviour this generalises.
 *
 * THE RULES, EACH ENFORCED BY scripts/ci/__tests__/deploy-retry.test.mjs
 *
 *   1. Retries ONLY classes named in --class-allow. Everything else exits on
 *      attempt 1 with the class exit code. A quota error is never retried.
 *   2. FAILS CLOSED on: budget exhaustion, wall-clock expiry, and `unknown`.
 *      A permanently-failing dependency in an ALLOWED class must still go red —
 *      the retry must be able to fail, or it is not a gate.
 *   3. The happy path costs nothing. No pre-flight sleep, no post-success
 *      sleep, exactly one invocation, and the process exits 0 immediately.
 *   4. No result is discarded. There is no `2>/dev/null`, no `|| true`, no
 *      `continue-on-error` anywhere in here or in what it emits. stderr is
 *      captured to a file, and on FINAL failure it is echoed in full.
 *   5. Nothing is asserted that was not established (R7). The final message is
 *      rendered from the taxonomy diagnosis, whose `evidence[]` carries the
 *      literal strings matched. `unknown` says it could not classify.
 *   6. REDACTION IS AT THE PUBLICATION BOUNDARIES, not at each field (#3829).
 *      This script writes to THREE surfaces, and on a PUBLIC repo all three are
 *      publicly readable:
 *        (a) STDOUT — the GitHub Actions annotation log. redact() once, in
 *            ghAnnotate(), covering every level (error/warning/notice alike).
 *        (b) deploy-failure.json — redact() once over the whole serialized
 *            artifact, so every field present and future is covered by
 *            construction. .github/scripts/deploy-notify-failure.mjs posts it
 *            into an issue and redacts again at ITS boundary.
 *        (c) STDERR — the Actions RUN LOG. This one was missed in the first cut
 *            of #3829, on the reasoning that the captured stderr FILE stays on
 *            the runner. True of the file; false of the stream. Every line this
 *            script COMPOSES around a leaf is now redacted at its composition
 *            site — the per-leaf classification block here, and renderLeaves()
 *            in deploy-arm-errors.mjs. What stays verbatim, deliberately, is the
 *            child command's OWN stderr echoed back: that is what the operator
 *            would have seen under `stdio: inherit`, and rewriting it would make
 *            the wrapper's log disagree with the command's (R7).
 *      It was the per-FIELD approach that leaked in the first place:
 *      `leaf.message` and `evidence.line` were redacted, `whyStopped`
 *      (= decision.reason, which embeds a leaf `resourceName` =
 *      `<server>/<objectId>`) was not, and a raw Entra object id reached issue
 *      #3817's body. redact() is idempotent, so per-site calls that remain are
 *      harmless defence in depth.
 *
 * USAGE
 *   node scripts/ci/deploy-retry.mjs \
 *     --class-allow transient,eventual-consistency \
 *     --max-attempts 6 --backoff 30 --jitter 0.3 --wall-clock 20m \
 *     --step "provision" --artifact deploy-failure.json \
 *     -- az deployment sub create -f main.bicep …
 *
 *   --remediate   additionally allows the PLATFORM to perform the remediation
 *                 for classes that carry one it can execute (currently:
 *                 registration → `az provider register --wait`), then retry
 *                 ONCE. auto-bind-by-default.md §5: a remediation the platform
 *                 could have executed is a defect, not a helpful message.
 *
 *   --arm-deployment <name> [--arm-scope sub|group --arm-resource-group <rg>]
 *                 On failure, DRILL INTO the failed ARM deployment operations
 *                 and feed the LEAF errors to the classifier (issue #3039).
 *                 `az deployment sub create` puts the bicep linter's warnings on
 *                 stderr and the ARM failure itself is content-free — "At least
 *                 one resource deployment operation failed" — so on run
 *                 31069329802 the classifier was handed 200 lines of BCP318 and
 *                 correctly reported that it could not classify them. The two
 *                 real causes were two levels down. See deploy-arm-errors.mjs.
 *
 *                 FAIL-CLOSED: only a status of `found` is appended to the text
 *                 handed to the classifier. `none` and `unreadable` are printed
 *                 for the operator but deliberately NOT classified — az's own
 *                 error text ("Deployment 'x' could not be found") would
 *                 otherwise match a taxonomy signal and misclassify the
 *                 ORIGINAL failure. An unreadable drill-down leaves the run
 *                 exactly as red as it was.
 *
 *                 PER-LEAF (D6, run 31100384405): when leaves ARE found, each
 *                 is classified SEPARATELY (classifyLeaves) and the retry
 *                 decision is made from the set (decideRetryForLeaves) — on
 *                 that run a whole-input classify let an unrelated
 *                 InvalidTemplate leaf class the failure `defect`, so the
 *                 retryable CapacityNotAvailable leaf was never retried and
 *                 the artifact never said it was retryable. The headline stays
 *                 the worst leaf; the artifact carries every leaf's own class.
 *
 * Tests: node --test scripts/ci/__tests__/deploy-retry.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  classify,
  classifyLeaves,
  worstLeafDiagnosis,
  render,
  classExitCode,
} from './deploy-classify.mjs';
import { collectArmLeafErrors, renderLeaves, STATUS as ARM_STATUS } from './deploy-arm-errors.mjs';
import { redact } from './_azure-redact.mjs';

const __filename = fileURLToPath(import.meta.url);

/** Exit code for a usage error — distinct from every class exit code (10..17). */
export const USAGE_EXIT = 2;

export { redact };

/** `20m` / `90s` / `2h` / bare seconds → milliseconds. Throws on nonsense. */
export function parseDuration(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s);
  if (!m) throw new Error(`unparseable duration: ${JSON.stringify(raw)}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  return Math.round(n * mult);
}

/**
 * THE decision. Pure, so the fail-closed behaviour is testable without Azure.
 *
 * Returns `{ retry, reason }`. `reason` is the sentence the caller prints, so
 * every refusal to retry explains itself.
 */
export function decideRetry({
  diagnosis,
  attempt,
  maxAttempts,
  classAllow,
  elapsedMs,
  wallClockMs,
  nextDelayMs = 0,
}) {
  if (diagnosis.class === 'unknown') {
    return {
      retry: false,
      reason:
        'not retrying: the failure could not be classified, so nothing is known about whether ' +
        'retrying could help. Unknown fails closed (deploy-integrity.md R7).',
    };
  }
  if (!classAllow.includes(diagnosis.class)) {
    return {
      retry: false,
      reason:
        `not retrying: class "${diagnosis.class}" is not in --class-allow ` +
        `(${classAllow.join(',') || 'empty'}). ${diagnosis.summary}`,
    };
  }
  if (!diagnosis.retryable) {
    return {
      retry: false,
      reason:
        `not retrying: class "${diagnosis.class}" is not retryable in the taxonomy, ` +
        'regardless of --class-allow. Retrying cannot change the outcome.',
    };
  }
  if (attempt >= maxAttempts) {
    return {
      retry: false,
      reason: `retry budget exhausted after ${attempt} attempt(s) (--max-attempts ${maxAttempts}).`,
    };
  }
  if (wallClockMs > 0 && elapsedMs + nextDelayMs >= wallClockMs) {
    return {
      retry: false,
      reason:
        `wall-clock budget exhausted: ${Math.round(elapsedMs / 1000)}s elapsed of ` +
        `${Math.round(wallClockMs / 1000)}s, and the next backoff would exceed it.`,
    };
  }
  return { retry: true, reason: '' };
}

/**
 * THE PER-LEAF DECISION (D6, run 31100384405).
 *
 * classify() over the concatenated leaf text returns ONE class by precedence,
 * and on that run an unrelated InvalidTemplate leaf classed the whole failure
 * `defect` — so the retryable CapacityNotAvailable leaf (DuckLake Postgres,
 * centralus zone) was never retried. This decides from the SET instead:
 *
 *   - retry ONLY when EVERY leaf is retryable AND in --class-allow. An ARM
 *     re-deploy re-runs every failed leaf, so a set containing a
 *     deterministic leaf (defect/config/quota/permission) cannot be turned
 *     green by retrying — the deterministic leaf fails identically and the
 *     budget is burnt asserting nothing (the exact C2 shape).
 *   - an `unknown` leaf fails closed, exactly as in decideRetry.
 *   - the refusal REASON names every blocking leaf with its class AND names
 *     the leaves that ARE retryable, so a capacity leaf is never again
 *     invisible inside a defect verdict — the operator sees "fix the defect;
 *     the capacity leaf will retry on the next run".
 *
 * Pure, like decideRetry, so the fail-closed behaviour is testable without
 * Azure.
 */
export function decideRetryForLeaves({
  leafDiagnoses,
  attempt,
  maxAttempts,
  classAllow,
  elapsedMs,
  wallClockMs,
  nextDelayMs = 0,
}) {
  const list = Array.isArray(leafDiagnoses) ? leafDiagnoses : [];
  if (list.length === 0) {
    return { retry: false, reason: 'not retrying: no ARM leaves were classified (nothing to decide from).' };
  }
  const name = (l) =>
    `${l.leaf?.code ?? 'NoCode'}${l.leaf?.resourceName ? ` on '${l.leaf.resourceName}'` : ''} → ${l.diagnosis.class}`;

  const unknowns = list.filter((l) => l.diagnosis.class === 'unknown');
  if (unknowns.length > 0) {
    return {
      retry: false,
      reason:
        `not retrying: ${unknowns.length} ARM leaf(s) could not be classified (${unknowns.map(name).join('; ')}), ` +
        'so nothing is known about whether retrying could help. Unknown fails closed (deploy-integrity.md R7).',
    };
  }

  const blocking = list.filter((l) => !l.diagnosis.retryable || !classAllow.includes(l.diagnosis.class));
  const retryables = list.filter((l) => l.diagnosis.retryable && classAllow.includes(l.diagnosis.class));
  if (blocking.length > 0) {
    const also =
      retryables.length > 0
        ? ` NOTE: ${retryables.length} other leaf(s) ARE retryable (${retryables.map(name).join('; ')}) — ` +
          'they are not being abandoned, they are blocked by the leaves above; fix those and the next run retries these.'
        : '';
    return {
      retry: false,
      reason:
        `not retrying: ${blocking.length} of ${list.length} ARM leaf(s) are non-retryable or outside --class-allow ` +
        `(${blocking.map(name).join('; ')}). An ARM re-deploy re-runs every failed leaf, so retrying cannot go green ` +
        `while a deterministic leaf remains.${also}`,
    };
  }

  if (attempt >= maxAttempts) {
    return { retry: false, reason: `retry budget exhausted after ${attempt} attempt(s) (--max-attempts ${maxAttempts}).` };
  }
  if (wallClockMs > 0 && elapsedMs + nextDelayMs >= wallClockMs) {
    return {
      retry: false,
      reason:
        `wall-clock budget exhausted: ${Math.round(elapsedMs / 1000)}s elapsed of ` +
        `${Math.round(wallClockMs / 1000)}s, and the next backoff would exceed it.`,
    };
  }
  return { retry: true, reason: '' };
}

/**
 * The backoff BASE for a leaf-driven retry: the larger of the CLI base and the
 * longest defaultBackoffSeconds among the leaf classes being retried. A
 * capacity leaf (taxonomy default 300s) must not be retried on a 45s cadence
 * sized for throttles — Azure said "after some time", and hammering it burns
 * the budget before capacity can return.
 */
export function effectiveBackoffBase(baseSeconds, leafDiagnoses) {
  const base = Math.max(0, Number(baseSeconds) || 0);
  const longest = (Array.isArray(leafDiagnoses) ? leafDiagnoses : [])
    .filter((l) => l?.diagnosis?.retryable)
    .reduce((m, l) => Math.max(m, Number(l.diagnosis.defaultBackoffSeconds) || 0), 0);
  return Math.max(base, longest);
}

/** Constant base with upward-only jitter, matching the proven roll() shape. */
export function backoffMs(baseSeconds, jitter, rnd = Math.random) {
  const base = Math.max(0, Number(baseSeconds) || 0) * 1000;
  if (base === 0) return 0;
  const j = Math.min(Math.max(Number(jitter) || 0, 0), 1);
  return Math.round(base * (1 + j * rnd()));
}

/**
 * Where the RoleAssignmentExists converger lives. Absolute so the plan runs the
 * same from any working directory, and resolved from this module rather than
 * `process.cwd()` — a relative path here is how a remediation silently becomes
 * "node: cannot find module" on a runner whose cwd is not the repo root.
 */
export const CONVERGE_ROLE_ASSIGNMENT = path.resolve(
  import.meta.dirname,
  '..',
  'csa-loom',
  'converge-role-assignment.mjs',
);

/**
 * ARM prints the blocking assignment as 32 undashed hex chars ("The ID of the
 * existing role assignment is 0a2b7dc58eb449709418694f83a6c164."). Accept the
 * canonical dashed form too — the message is not contractual.
 */
const EXISTING_ASSIGNMENT_RE =
  /existing role assignment is\s+([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * What the PLATFORM can do about this failure itself (auto-bind-by-default §5).
 * Pure: returns the plan, does not execute it. `null` when there is nothing the
 * platform may safely perform unattended.
 *
 * `opts.subscription` is the --arm-subscription the drill-down used, so a
 * cross-subscription (DLZ) deploy converges in the subscription the failure
 * actually came from rather than whichever one `az` happens to have selected.
 */
export function planRemediation(diagnosis, stderr, opts = {}) {
  // RoleAssignmentExists (#3439). ARM enforces uniqueness on the (scope,
  // principalId, roleDefinitionId) TRIPLE, not on the assignment NAME, so a
  // grant already held under a foreign name blocks the template's create on
  // EVERY future reconcile — deterministic, and retrying cannot help. The
  // taxonomy used to hand the operator `az role assignment delete --ids …`;
  // §5 says a remediation the platform could have executed is a defect.
  if (diagnosis.signalId === 'config.role-assignment-exists') {
    const hit = EXISTING_ASSIGNMENT_RE.exec(stderr ?? '');
    if (!hit) {
      return {
        kind: 'converge-role-assignment',
        assignmentName: null,
        argv: null,
        why:
          'The failure is a RoleAssignmentExists, but the id of the EXISTING assignment could not be read from ' +
          'the message, so nothing is deleted — picking a role assignment to remove on a guess would take access ' +
          'away on something this code never established.',
      };
    }
    const name = hit[1].toLowerCase();
    return {
      kind: 'converge-role-assignment',
      assignmentName: name,
      argv: [
        process.execPath,
        CONVERGE_ROLE_ASSIGNMENT,
        '--assignment-name',
        name,
        ...(opts.subscription ? ['--subscription', String(opts.subscription)] : []),
        '--apply',
      ],
      why:
        `The grant is already in place under assignment ${name.slice(0, 8)}…, which is NOT the deterministic name ` +
        'the template computes, so ARM refuses the create forever. The converger proves the stray belongs to a ' +
        'user-assigned managed identity in this subscription, removes it, and verifies it is gone; the retry then ' +
        'recreates the identical triple under the name the template owns. Intended net effect on the estate: zero ' +
        'permission change, one name converged. RESIDUAL, stated because this is the one destructive action in the ' +
        'lane: the grant is absent between the delete and the retry\'s create, so if that retry fails for another ' +
        'reason — or the runner is cancelled in between — it stays absent until the next deploy re-creates it. ' +
        'Bounded and self-healing, not zero. It refuses and fails closed on anything it cannot establish.',
    };
  }

  if (diagnosis.class !== 'registration') return null;
  // "The subscription is not registered to use namespace 'Microsoft.Kusto'."
  // az also renders it without quotes on some surfaces.
  const m =
    /namespace\s+'([A-Za-z0-9.]+)'/i.exec(stderr) ??
    /namespace\s+"([A-Za-z0-9.]+)"/i.exec(stderr) ??
    /namespace\s+(Microsoft\.[A-Za-z0-9]+)/i.exec(stderr);
  if (!m) {
    return {
      kind: 'register-provider',
      namespace: null,
      argv: null,
      why:
        'The failure is a provider-registration refusal, but the namespace could not be read ' +
        'from the message, so nothing is registered — guessing a namespace would be asserting ' +
        'something the code did not establish.',
    };
  }
  return {
    kind: 'register-provider',
    namespace: m[1],
    argv: ['az', 'provider', 'register', '--namespace', m[1], '--wait'],
    why: `Registering resource provider ${m[1]} is idempotent and safe; the platform performs it rather than printing it.`,
  };
}

function sleepSync(ms) {
  if (ms <= 0) return;
  // Deliberately synchronous: this is a CLI whose whole contract is "the child
  // ran N times". Atomics.wait blocks without a busy loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    classAllow: ['transient', 'eventual-consistency'],
    maxAttempts: 3,
    backoffSeconds: 30,
    jitter: 0.3,
    wallClock: '0',
    step: null,
    artifact: null,
    remediate: false,
    armDeployment: null,
    armScope: 'sub',
    armResourceGroup: null,
    armSubscription: null,
    cmd: [],
  };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      out.cmd = argv.slice(i + 1);
      break;
    }
    if (a === '--class-allow') out.classAllow = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-attempts') out.maxAttempts = Number(argv[++i]);
    else if (a === '--backoff') out.backoffSeconds = Number(String(argv[++i]).replace(/s$/, ''));
    else if (a === '--jitter') out.jitter = Number(argv[++i]);
    else if (a === '--wall-clock') out.wallClock = String(argv[++i]);
    else if (a === '--step') out.step = argv[++i];
    else if (a === '--artifact') out.artifact = argv[++i];
    else if (a === '--remediate') out.remediate = true;
    else if (a === '--arm-deployment') out.armDeployment = argv[++i];
    else if (a === '--arm-scope') out.armScope = argv[++i];
    else if (a === '--arm-resource-group') out.armResourceGroup = argv[++i];
    else if (a === '--arm-subscription') out.armSubscription = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * The ARM drill-down, and the rule for what may reach the classifier.
 *
 * `classifyText` is ONLY non-empty for status `found`. That asymmetry is the
 * whole safety property: az's failure text on an unreadable drill-down
 * ("(DeploymentNotFound) Deployment 'x' could not be found") matches
 * `config.resource-group-not-found`, so feeding it in would replace an honest
 * `unknown` with a confident, wrong diagnosis of the original failure — the
 * exact R7 error this change exists to remove.
 *
 * Exported so the test can drive every branch without Azure.
 */
export function armDrilldown(args, run) {
  if (!args.armDeployment) return null;
  const result = collectArmLeafErrors({
    name: args.armDeployment,
    scope: args.armScope,
    resourceGroup: args.armResourceGroup,
    subscription: args.armSubscription,
    ...(run ? { run } : {}),
  });
  return {
    result,
    rendered: renderLeaves(result),
    classifyText: result.status === ARM_STATUS.FOUND ? renderLeaves(result) : '',
  };
}

/**
 * How much of stdout is kept for classification. The failure is at the END of a
 * build log, and a 60-minute `az acr build` can emit tens of megabytes, so the
 * TAIL is what is retained. Generous enough to hold a full az error block.
 */
const STDOUT_TAIL_CAP = 256 * 1024;

/**
 * Run the child, STREAMING both streams through as they arrive, while keeping a
 * bounded copy of each for classification.
 *
 * WHY THIS IS NOT spawnSync. spawnSync cannot tee: `stdio: 'inherit'` streams
 * but captures nothing, `'pipe'` captures but withholds every byte until the
 * process exits. The previous shape chose `inherit` for stdout — so a long
 * build showed progress, and its failure text was invisible to the classifier.
 *
 * That is not hypothetical. `az acr build` streams the ACR Tasks runner's
 * output to STDOUT, so on run 31489538101 an IP denial the taxonomy names in
 * full was reported as:
 *
 *     ───── deploy-retry: full captured stderr ─────
 *                                                     <- empty
 *     ##[error]Could not classify this failure … Unknown fails closed.
 *
 * Live progress on a 60-minute build is worth keeping, so this streams AND
 * captures rather than trading one for the other.
 */
function runTee(cmd, argv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolve({ status: 1, stdout: '', stderr: '', error: e });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (status, error) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout: out, stderr: err, error });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk); // live progress, unchanged from `inherit`
      out += chunk;
      if (out.length > STDOUT_TAIL_CAP) out = out.slice(out.length - STDOUT_TAIL_CAP);
    });
    // stderr is captured and written in full AFTER the attempt, exactly as
    // before — the final report's stderr block must stay whole and unordered
    // against the build log.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (e) => done(1, e));
    child.on('close', (code) => done(code === null ? 1 : code, null));
  });
}

/**
 * THE ANNOTATION REDACTION BOUNDARY (#3829). Actions logs on a PUBLIC repo are
 * publicly readable, so an annotation publishes just as an issue body does.
 * redact() is applied ONCE here rather than at each call site, so a new
 * annotation cannot reopen the hole `decision.reason` opened: that string embeds
 * a leaf's `resourceName`, which for a flexibleServers/administrators leaf is
 * `<server>/<objectId>`. Idempotent, so the per-site redact() calls below remain
 * correct.
 *
 * LEVEL-BLIND, DELIBERATELY. `error`, `warning` and `notice` are all the same
 * public log; scoping the redaction to `error` would leak through
 * `ghAnnotate('warning', …drill.rendered)` and through the retry-progress
 * notices. There is no live non-error annotation carrying an id TODAY — the
 * composition sites upstream redact as well — which is exactly why this is
 * pinned by a DIRECT test over all three levels rather than end to end: with two
 * independent redactors on the same path, an end-to-end assertion cannot tell
 * which of them is doing the work, and would go green with this one deleted
 * (csa_loom_mutation_that_does_not_move_the_verdict). Hence the split: this
 * function is pure and exported so the level property can be mutated and seen.
 *
 * String() first: redact() returns '' for a non-string, and an annotation that
 * silently loses its whole message would be a worse failure than the one it was
 * reporting. Every call site passes a template literal, so this never fires — it
 * is here so that a future one that does not cannot turn a classified failure
 * into a blank `::error::`.
 *
 * @param {string} level  error | warning | notice
 * @param {unknown} message
 * @returns {string} the exact line written to stdout, newline included.
 */
export function formatAnnotation(level, message) {
  const safe = redact(String(message));
  // One line, GitHub-annotation form. Newlines are escaped so a multi-line
  // remediation still renders as ONE annotation rather than being truncated.
  return `::${level}::${safe.replace(/\r?\n/g, '%0A')}\n`;
}

function ghAnnotate(level, message) {
  process.stdout.write(formatAnnotation(level, message));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`deploy-retry: ${e.message}\n`);
    process.exit(USAGE_EXIT);
  }
  if (args.cmd.length === 0) {
    process.stderr.write('deploy-retry: no command given. Usage: deploy-retry.mjs [opts] -- <cmd> [args…]\n');
    process.exit(USAGE_EXIT);
  }
  if (!Number.isFinite(args.maxAttempts) || args.maxAttempts < 1) {
    process.stderr.write(`deploy-retry: --max-attempts must be >= 1 (got ${args.maxAttempts})\n`);
    process.exit(USAGE_EXIT);
  }

  let wallClockMs;
  try {
    wallClockMs = parseDuration(args.wallClock);
  } catch (e) {
    process.stderr.write(`deploy-retry: --wall-clock ${e.message}\n`);
    process.exit(USAGE_EXIT);
  }

  const started = Date.now();
  const errFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'loom-deploy-retry-')),
    'stderr.txt',
  );

  let attempt = 0;
  let remediated = false;
  let lastStderr = '';
  let lastStdout = '';
  let lastStatus = null;
  const history = [];

  for (;;) {
    attempt += 1;
    // Both streams tee: they reach the log live AND are kept for classification.
    const res = await runTee(args.cmd[0], args.cmd.slice(1));

    lastStdout = res.stdout ?? '';
    lastStderr = res.stderr ?? '';
    // spawnSync sets .error when the binary is missing / not executable. That is
    // a real failure with no stderr; record it rather than classifying "".
    if (res.error) lastStderr = `${lastStderr}\n${res.error.message}`;
    lastStatus = res.status === null ? 1 : res.status;
    if (lastStderr) process.stderr.write(lastStderr.endsWith('\n') ? lastStderr : `${lastStderr}\n`);

    if (lastStatus === 0 && !res.error) {
      // HAPPY PATH: exactly one invocation when the first succeeds, zero sleeps,
      // exit immediately. No artifact is written on success.
      if (attempt > 1) ghAnnotate('notice', `deploy-retry: succeeded on attempt ${attempt}.`);
      process.exit(0);
    }

    // THE ARM DRILL-DOWN (issue #3039). Runs BEFORE classification so the
    // classifier sees the leaf cause rather than the bicep linter's warnings.
    // Only `found` reaches classify() — see armDrilldown()'s header.
    const drill = armDrilldown(args);
    if (drill) {
      process.stderr.write(`\n───── deploy-retry: ARM drill-down ─────\n${drill.rendered}\n`);
      process.stderr.write('────────────────────────────────────────\n');
      if (drill.result.status !== ARM_STATUS.FOUND) {
        ghAnnotate(
          'warning',
          `deploy-retry: the ARM drill-down did not produce a leaf error, so classification ` +
            `proceeds on the command's own stderr and nothing extra is asserted. ${drill.rendered}`,
        );
      }
    }
    const classifyInput = drill?.classifyText ? `${lastStderr}\n${drill.classifyText}` : lastStderr;

    // PER-LEAF classification when the drill found leaves (D6). The headline
    // diagnosis stays the WORST leaf (fail-fast precedence, same rank a
    // concatenated classify would use), but the retry decision below is made
    // from the SET, so one deterministic leaf no longer hides a retryable one.
    const leafDiagnoses = drill?.result.status === ARM_STATUS.FOUND ? classifyLeaves(drill.result.leaves) : [];
    let diagnosis = leafDiagnoses.length > 0 ? worstLeafDiagnosis(leafDiagnoses) : classify(classifyInput);

    // STDOUT IS THE FALLBACK, NEVER THE OVERRIDE.
    //
    // Only consulted when everything authoritative — ARM leaves, then stderr —
    // yielded `unknown`. That ordering is the safety property: a build log
    // mentioning a throttle must never downgrade a real permission failure into
    // something retryable, because retrying a permission error turns a 3-minute
    // failure into a 30-minute one. It can only turn "I cannot name this" into a
    // name, which is strictly more information and never a weaker verdict.
    let diagnosedFromStdout = false;
    if (leafDiagnoses.length === 0 && diagnosis.class === 'unknown' && lastStdout.trim()) {
      const fromStdout = classify(lastStdout);
      if (fromStdout.class !== 'unknown') {
        diagnosis = fromStdout;
        diagnosedFromStdout = true;
        ghAnnotate(
          'notice',
          'deploy-retry: the command failed with nothing classifiable on stderr, but its STDOUT names a known ' +
            `failure — classified "${fromStdout.class}" (${fromStdout.signalId}). ` +
            '`az acr build` and other streaming commands report failures on stdout.',
        );
      }
    }
    if (leafDiagnoses.length > 0) {
      process.stderr.write('deploy-retry: per-leaf classification:\n');
      for (const l of leafDiagnoses) {
        // redact() on resourceName (#3829 round 2). This line is COMPOSED here
        // and written to process.stderr — which on a PUBLIC repo is the Actions
        // run log, a publication surface. `resourceName` is `<server>/<objectId>`
        // for the flexibleServers/administrators leaf that opened #3829.
        process.stderr.write(
          `  ${l.leaf.code ?? 'NoCode'}${l.leaf.resourceName ? ` on '${redact(l.leaf.resourceName)}'` : ''} → ` +
            `${l.diagnosis.class}${l.diagnosis.retryable ? ' (retryable)' : ''} [${l.diagnosis.signalId ?? 'no signal'}]\n`,
        );
      }
    }
    history.push({
      attempt,
      exitCode: lastStatus,
      class: diagnosis.class,
      signalId: diagnosis.signalId,
      ...(leafDiagnoses.length > 0
        ? { leafClasses: leafDiagnoses.map((l) => ({ code: l.leaf.code ?? null, class: l.diagnosis.class })) }
        : {}),
    });
    if (args.remediate && !remediated) {
      // classifyInput, NOT lastStderr. The diagnosis itself is made from the
      // ARM leaf text, and the leaf is where the remediable detail lives — the
      // existing role assignment id for #3439, and the provider namespace when
      // a registration refusal surfaces only as a nested operation. Planning
      // from a narrower string than the one that produced the diagnosis is how
      // a remediation reports "could not read it from the message" about text
      // it was never shown.
      const plan = planRemediation(diagnosis, classifyInput, { subscription: args.armSubscription });
      if (plan?.argv) {
        remediated = true;
        ghAnnotate('notice', `deploy-retry: performing remediation — ${plan.why}`);
        const rem = spawnSync(plan.argv[0], plan.argv.slice(1), {
          stdio: ['inherit', 'inherit', 'pipe'],
          encoding: 'utf8',
          shell: false,
        });
        if (rem.status === 0 && !rem.error) {
          ghAnnotate('notice', `deploy-retry: remediation succeeded (${plan.kind}); retrying once.`);
          continue; // one extra attempt, deliberately outside the retry budget
        }
        ghAnnotate(
          'warning',
          `deploy-retry: the platform attempted the remediation (${plan.kind}) and it FAILED. ` +
            `Falling back to reporting it. ${redact(rem.stderr ?? '')}`,
        );
      } else if (plan) {
        ghAnnotate('warning', `deploy-retry: ${plan.why}`);
      }
    }

    // Leaf-driven retries use the longest taxonomy backoff among the classes
    // being retried (a capacity leaf waits its 300s, not a throttle's 45s).
    const delay = backoffMs(effectiveBackoffBase(args.backoffSeconds, leafDiagnoses), args.jitter);
    const decision =
      leafDiagnoses.length > 0
        ? decideRetryForLeaves({
            leafDiagnoses,
            attempt,
            maxAttempts: args.maxAttempts,
            classAllow: args.classAllow,
            elapsedMs: Date.now() - started,
            wallClockMs,
            nextDelayMs: delay,
          })
        : decideRetry({
            diagnosis,
            attempt,
            maxAttempts: args.maxAttempts,
            classAllow: args.classAllow,
            elapsedMs: Date.now() - started,
            wallClockMs,
            nextDelayMs: delay,
          });

    if (!decision.retry) {
      fs.writeFileSync(errFile, lastStderr, 'utf8');
      const message = render(diagnosis, args.step);
      const artifact = {
        schemaVersion: 1,
        step: args.step,
        command: args.cmd[0],
        class: diagnosis.class,
        signalId: diagnosis.signalId,
        retryable: diagnosis.retryable,
        established: diagnosis.evidence.map((e) => ({ signal: e.signal, line: redact(e.line) })),
        remediationKind: diagnosis.remediationKind,
        remediation: diagnosis.remediation,
        ...(diagnosis.grantHint ? { grantHint: diagnosis.grantHint } : {}),
        ...(diagnosis.portalPath ? { portalPath: diagnosis.portalPath } : {}),
        attempts: history,
        whyStopped: decision.reason,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        childExitCode: lastStatus,
        stderrPath: errFile,
        evidenceStream: diagnosedFromStdout ? 'stdout' : 'stderr',
        // D6: every leaf keeps ITS OWN class in the artifact, so a retryable
        // leaf is visible even when the headline class is a deterministic one.
        ...(leafDiagnoses.length > 0
          ? {
              leafClasses: leafDiagnoses.map((l) => ({
                code: l.leaf.code ?? null,
                resourceType: l.leaf.resourceType ?? null,
                resourceName: l.leaf.resourceName ?? null,
                class: l.diagnosis.class,
                signalId: l.diagnosis.signalId,
                retryable: l.diagnosis.retryable,
                remediation: l.diagnosis.remediation,
              })),
            }
          : {}),
        ...(drill
          ? {
              armDrilldown: {
                status: drill.result.status,
                reason: drill.result.reason,
                warnings: drill.result.warnings.map(redact),
                operationsSeen: drill.result.operationsSeen,
                leaves: drill.result.leaves.map((l) => ({
                  code: l.code,
                  message: redact(l.message),
                  resourceType: l.resourceType,
                  resourceName: l.resourceName,
                })),
              },
            }
          : {}),
      };
      // THE ARTIFACT REDACTION BOUNDARY (#3829). The whole serialized artifact
      // passes through redact() once, so EVERY field is covered by
      // construction — including `whyStopped`, which is `decision.reason` and
      // which embeds a leaf's `resourceName` (`<server>/<objectId>` for a
      // flexibleServers/administrators leaf). This file is read by
      // .github/scripts/deploy-notify-failure.mjs, which posts it to a PUBLIC
      // issue. redact() only rewrites GUID / ARM-id substrings inside string
      // values, so the JSON stays valid and parseable.
      //
      // The RAW stderr FILE written above is deliberately NOT redacted, and the
      // reason is narrow: it stays on the runner, is never uploaded, and is only
      // referenced by path. That is a statement about the FILE. It is NOT true of
      // the stderr STREAM — every process.stderr.write() below lands in the
      // Actions run log, which is public on a public repo. So the stream is
      // treated as a publisher too: every line this script COMPOSES around a leaf
      // is redacted at its composition site (the per-leaf block above, and
      // renderLeaves() in deploy-arm-errors.mjs). What deliberately remains
      // verbatim on the stream is the child command's OWN stderr, echoed
      // unchanged — see the "full captured stderr" block below for why.
      if (args.artifact) {
        fs.writeFileSync(args.artifact, `${redact(JSON.stringify(artifact, null, 2))}\n`, 'utf8');
      }

      // FULL stderr on final failure — never truncated, never suppressed, and
      // never redacted. This is the child's OWN output, byte for byte: exactly
      // what the operator would have seen had the command run under
      // `stdio: inherit` with no wrapper at all. Rewriting it would make the
      // wrapper's log differ from the command's, which is how an investigation
      // gets sent somewhere the evidence does not support (R7). The residual is
      // stated rather than hidden: if `az` itself prints an id, that id reaches
      // the public run log — with or without this harness.
      process.stderr.write('\n───── deploy-retry: full captured stderr ─────\n');
      process.stderr.write(lastStderr.endsWith('\n') ? lastStderr : `${lastStderr}\n`);
      process.stderr.write('─────────────────────────────────────────────\n');
      // An EMPTY block above is itself a finding: it means the command reported
      // its failure somewhere else. Say so and show the stdout tail, rather than
      // leaving the operator with an empty box and an unknown class.
      if (!lastStderr.trim() && lastStdout.trim()) {
        const tail = lastStdout.split(/\r?\n/).filter(Boolean).slice(-40).join('\n');
        process.stderr.write(
          'deploy-retry: stderr was EMPTY — this command reports failures on STDOUT. Last 40 lines:\n',
        );
        process.stderr.write(`───── deploy-retry: stdout tail ─────\n${tail}\n`);
        process.stderr.write('─────────────────────────────────────\n');
      }
      // Every leaf is repeated in the annotation: a deployment can fail for more
      // than one reason at once (run 31069329802 failed for two) and the
      // classifier names only the winner.
      const leafBlock =
        leafDiagnoses.length > 0
          ? ` ${leafDiagnoses.length} ARM leaf failure(s), EACH WITH ITS OWN CLASS: ` +
            leafDiagnoses
              .map(
                (l) =>
                  `${l.leaf.code}→${l.diagnosis.class}${l.diagnosis.retryable ? ' (retryable)' : ''}: ${redact(l.leaf.message)}`,
              )
              .join(' | ')
          : drill?.result.status === ARM_STATUS.FOUND
            ? ` ${drill.result.leaves.length} ARM leaf failure(s): ` +
              drill.result.leaves.map((l) => `${l.code}: ${redact(l.message)}`).join(' | ')
            : '';
      ghAnnotate('error', `${message} ${decision.reason}${leafBlock}`);
      process.exit(classExitCode(diagnosis.class));
    }

    ghAnnotate(
      'warning',
      `deploy-retry: attempt ${attempt}/${args.maxAttempts} failed with a retryable ` +
        `"${diagnosis.class}" failure (${diagnosis.signalId}); waiting ${Math.round(delay / 1000)}s.`,
    );
    sleepSync(delay);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  // A rejected promise must not become a silent exit 0: this primitive gates
  // every deploy path, so an unhandled rejection has to fail closed like any
  // other failure it reports.
  main().catch((e) => {
    process.stderr.write(`deploy-retry: internal error — ${e?.stack || e}
`);
    process.exit(1);
  });
}
