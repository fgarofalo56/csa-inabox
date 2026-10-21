#!/usr/bin/env node
/**
 * acr-build-run.mjs - submit an `az acr build` with --no-wait, then decide the
 * outcome from the ACR RUN STATUS (acr-run-verdict.mjs), not from the log
 * stream. See that file for the incident (run 39634317953).
 *
 * TWO SUBCOMMANDS, SO A SUBMITTED RUN IS NEVER RE-SUBMITTED:
 *
 *   submit --run-file F -- <az acr build args incl. --registry R>
 *       Queues the run (--no-wait --no-logs -o json), writes its run id to F.
 *       Only THIS step runs under deploy-retry.mjs: a failure here happened
 *       before any ACR run existed, so a retry cannot duplicate a build.
 *
 *   wait --registry R --run-id ID [--max-minutes N] [--poll-seconds N]
 *       Runs OUTSIDE the retry harness. Once a run id exists the outcome is
 *       final for the job: a terminal non-Succeeded status or a poll-limit is
 *       a failure, never a retry (a second submit would race the first run,
 *       which can still push :v0.1). On ANY non-terminal exit - poll limit,
 *       unreadable status, SIGTERM/SIGINT from a job cancel, an exception - the
 *       ACR run is cancelled (`az acr task cancel-run`), best effort and logged,
 *       so an abandoned run cannot push an unscanned image later.
 *
 * A non-Succeeded run exits 1 with az's own wording `The run with ID 'X'
 * finished with unsuccessful status 'RunStatus.FAILED'` plus the log tail.
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideRunVerdict } from './acr-run-verdict.mjs';

export function parseRunId(text) {
  const t = String(text ?? '');
  const j = /"runId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(t);
  if (j) return j[1];
  const q = /(?:run|build) with ID:?\s*'?([A-Za-z0-9_-]+)/i.exec(t);
  return q ? q[1] : null;
}

/** Queue the run. io.submit()->{status,stdout,stderr}. Returns {code, runId?}. */
export function submitRun(io) {
  const sub = io.submit();
  if (sub.status !== 0) {
    io.err(`${sub.stderr || ''}${sub.stdout || ''}`.trim());
    io.err('ERROR: az acr build could not queue the run (it failed before an ACR run existed).');
    return { code: 1 };
  }
  const runId = parseRunId(`${sub.stdout}\n${sub.stderr}`);
  if (!runId) {
    io.err(`ERROR: the build was queued but no run id could be read from az output, so its outcome cannot be established. stdout: ${String(sub.stdout).slice(0, 300)}`);
    return { code: 1 };
  }
  return { code: 0, runId };
}

/**
 * Wait for an already-submitted run. NEVER submits.
 * io: show(id)->{ok,value,err}, startLogs(id)->{stop()}, tailLogs(id)->string,
 *     cancel(id)->{ok,err}, sleep(ms)->Promise|void, now()->ms, log(m), err(m)
 */
export async function waitRun(io, id, { registry, maxMs, pollMs, maxReadFailures = 5 }) {
  io.log(`Waiting on ACR run ${id} on ${registry}. The verdict is the run status, not the log stream.`);
  let logs = null;
  try { logs = io.startLogs(id); } catch (e) { io.log(`::warning::log streaming could not start (${e.message}); the verdict does not depend on it.`); }
  const t0 = io.now();
  let failures = 0;
  let terminal = false;
  let code = 1;
  try {
    for (;;) {
      const r = io.show(id);
      let run = null;
      if (r.ok) { failures = 0; run = r.value; } else {
        failures += 1;
        io.log(`::warning::could not read run ${id} status (${failures}/${maxReadFailures}): ${r.err}`);
        if (failures >= maxReadFailures) {
          io.err(`ERROR: the status of run ${id} could not be read ${failures} times in a row (${r.err}); success was NOT established. This is final for this job; the run is being cancelled.`);
          return (code = 1);
        }
      }
      if (r.ok) {
        const v = decideRunVerdict(run, { elapsedMs: io.now() - t0, maxMs });
        if (v.verdict === 'continue') { terminal = true; io.log(`ACR run ${id} Succeeded.`); return (code = 0); }
        if (v.verdict === 'fail') {
          const st = String(run?.status ?? '');
          const finished = ['Failed', 'Canceled', 'Cancelled', 'Timeout', 'Error'].includes(st);
          terminal = finished;
          if (finished) {
            const label = st === 'Timeout' ? 'TIME_LIMIT_EXCEEDED' : st.toUpperCase();
            io.err(`ERROR: The run with ID '${id}' finished with unsuccessful status 'RunStatus.${label}'. ${v.reason}. This is final for this job (no re-submit). Show run logs by 'az acr task logs -r ${registry} --run-id ${id}'.`);
          } else {
            io.err(`ERROR: The run with ID '${id}' did not reach a final status: ${v.reason}. It is being cancelled, and this is final for this job (no re-submit).`);
          }
          // The log tail goes to STDOUT on purpose: stderr stays a short, fixed
          // message, so build-log text (e.g. a cargo network error) can never
          // be read as a retryable signal by anything that classifies stderr.
          try { io.log(`--- last lines of the ACR task log for ${id} ---\n${io.tailLogs(id)}`); } catch (e) { io.log(`(log tail unavailable: ${e.message})`); }
          return (code = 1);
        }
      }
      await io.sleep(pollMs);
    }
  } catch (e) {
    io.err(`ERROR: unexpected failure while waiting on run ${id}: ${e.message}. The run is being cancelled.`);
    return 1;
  } finally {
    try { logs?.stop(); } catch { /* best effort */ }
    if (!terminal) {
      const c = io.cancel(id);
      if (c.ok) io.log(`::notice::cancelled ACR run ${id} (it did not reach a final status), so it cannot push an image after this job has failed.`);
      else io.err(`::warning::could not cancel ACR run ${id} (${c.err}). It may still finish and push; check 'az acr task show-run -r ${registry} --run-id ${id}'.`);
    }
  }
}

function realIo(registry) {
  const win = process.platform === 'win32';
  return {
    submit: (azArgs) => spawnSync('az', ['acr', 'build', '--no-wait', '--no-logs', '-o', 'json', ...azArgs], { encoding: 'utf8', shell: win, maxBuffer: 1 << 26, timeout: 600000 }),
    show: (id) => {
      const r = spawnSync('az', ['acr', 'task', 'show-run', '-r', registry, '--run-id', id, '-o', 'json'], { encoding: 'utf8', shell: win, timeout: 120000 });
      if (r.error) return { ok: false, err: `az did not finish: ${r.error.message}` };
      if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim().split('\n').slice(-2).join(' | ') };
      try { return { ok: true, value: JSON.parse(r.stdout) }; } catch { return { ok: false, err: 'unparseable show-run output' }; }
    },
    cancel: (id) => {
      const r = spawnSync('az', ['acr', 'task', 'cancel-run', '--registry', registry, '--run-id', id], { encoding: 'utf8', shell: win, timeout: 120000 });
      if (r.error) return { ok: false, err: r.error.message };
      return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || '').trim().split('\n').slice(-2).join(' | ') };
    },
    startLogs: (id) => {
      const c = spawn('az', ['acr', 'task', 'logs', '-r', registry, '--run-id', id], { stdio: ['ignore', 'inherit', 'pipe'], shell: win });
      let errTail = '';
      c.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400); });
      c.on('close', (code) => {
        if (code) console.log(`::warning::log streaming ended with exit ${code} (${errTail.trim().split('\n').pop()}). This does NOT decide the build: the verdict is the ACR run status.`);
      });
      return { stop: () => c.kill() };
    },
    tailLogs: (id) => {
      const r = spawnSync('az', ['acr', 'task', 'logs', '-r', registry, '--run-id', id], { encoding: 'utf8', shell: win, timeout: 180000, maxBuffer: 1 << 26 });
      return (r.stdout || r.stderr || '').split('\n').slice(-60).join('\n');
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  };
}

async function main(argv) {
  const sub = argv[0];
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(1, dd) : argv.slice(1);
  const azArgs = dd >= 0 ? argv.slice(dd + 1) : [];
  const opt = (k, d) => { const i = own.indexOf(k); return i >= 0 ? own[i + 1] : d; };
  if (sub === 'submit') {
    const file = opt('--run-file');
    const ri = azArgs.indexOf('--registry');
    if (!file || ri < 0 || azArgs.includes('--no-wait') || azArgs.includes('--no-logs')) {
      console.error('usage: acr-build-run.mjs submit --run-file F -- <az acr build args incl. --registry R; no --no-wait/--no-logs>');
      return 2;
    }
    const io = realIo(azArgs[ri + 1]);
    const r = submitRun({ ...io, submit: () => io.submit(azArgs) });
    if (r.code !== 0) return r.code;
    writeFileSync(file, `${r.runId}\n`);
    console.log(`Queued ACR run ${r.runId}.`);
    return 0;
  }
  if (sub === 'wait') {
    const registry = opt('--registry');
    const id = opt('--run-id');
    if (!registry || !id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      console.error('usage: acr-build-run.mjs wait --registry R --run-id ID [--max-minutes N] [--poll-seconds N]');
      return 2;
    }
    const io = realIo(registry);
    // A job cancel delivers SIGINT/SIGTERM: cancel the ACR run before dying.
    const onSignal = (sig) => {
      console.error(`ERROR: received ${sig} while waiting on run ${id}; cancelling the ACR run.`);
      const c = io.cancel(id);
      console.error(c.ok ? `cancelled ACR run ${id}.` : `::warning::could not cancel ACR run ${id} (${c.err}).`);
      process.exit(sig === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGINT', () => onSignal('SIGINT'));
    return waitRun(io, id, { registry, maxMs: Number(opt('--max-minutes', 105)) * 60000, pollMs: Number(opt('--poll-seconds', 30)) * 1000 });
  }
  console.error('usage: acr-build-run.mjs submit|wait ...');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
