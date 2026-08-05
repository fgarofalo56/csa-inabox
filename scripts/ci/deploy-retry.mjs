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
 * Tests: node --test scripts/ci/__tests__/deploy-retry.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classify, render, classExitCode } from './deploy-classify.mjs';

const __filename = fileURLToPath(import.meta.url);

/** Exit code for a usage error — distinct from every class exit code (10..17). */
export const USAGE_EXIT = 2;

/**
 * Redact subscription / tenant GUIDs and long ARM ids down to their last path
 * segment before they reach a summary line or a committed artifact. The raw
 * stderr file is untouched — this only stops full resource ids leaking into
 * annotations and PR bodies.
 */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\/subscriptions\/[0-9a-fA-F-]{36}/g, '/subscriptions/<redacted>')
    .replace(/\/tenants?\/[0-9a-fA-F-]{36}/g, '/tenant/<redacted>')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<guid>');
}

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

/** Constant base with upward-only jitter, matching the proven roll() shape. */
export function backoffMs(baseSeconds, jitter, rnd = Math.random) {
  const base = Math.max(0, Number(baseSeconds) || 0) * 1000;
  if (base === 0) return 0;
  const j = Math.min(Math.max(Number(jitter) || 0, 0), 1);
  return Math.round(base * (1 + j * rnd()));
}

/**
 * What the PLATFORM can do about this failure itself (auto-bind-by-default §5).
 * Pure: returns the plan, does not execute it. `null` when there is nothing the
 * platform may safely perform unattended.
 */
export function planRemediation(diagnosis, stderr) {
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
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function ghAnnotate(level, message) {
  // One line, GitHub-annotation form. Newlines are escaped so a multi-line
  // remediation still renders as ONE annotation rather than being truncated.
  process.stdout.write(`::${level}::${message.replace(/\r?\n/g, '%0A')}\n`);
}

function main() {
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
  let lastStatus = null;
  const history = [];

  for (;;) {
    attempt += 1;
    const res = spawnSync(args.cmd[0], args.cmd.slice(1), {
      // stdout streams straight through so a long build still shows progress.
      // stderr is PIPED so it can be classified — and then written out in full.
      stdio: ['inherit', 'inherit', 'pipe'],
      encoding: 'utf8',
      shell: false,
    });

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

    const diagnosis = classify(lastStderr);
    history.push({ attempt, exitCode: lastStatus, class: diagnosis.class, signalId: diagnosis.signalId });

    // Platform-performed remediation, once, for the classes that carry one it
    // can execute unattended.
    if (args.remediate && !remediated) {
      const plan = planRemediation(diagnosis, lastStderr);
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

    const delay = backoffMs(args.backoffSeconds, args.jitter);
    const decision = decideRetry({
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
      };
      if (args.artifact) fs.writeFileSync(args.artifact, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

      // FULL stderr on final failure — never truncated, never suppressed.
      process.stderr.write('\n───── deploy-retry: full captured stderr ─────\n');
      process.stderr.write(lastStderr.endsWith('\n') ? lastStderr : `${lastStderr}\n`);
      process.stderr.write('─────────────────────────────────────────────\n');
      ghAnnotate('error', `${message} ${decision.reason}`);
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
if (isMain) main();
