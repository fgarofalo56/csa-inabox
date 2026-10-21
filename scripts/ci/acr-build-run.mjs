#!/usr/bin/env node
/**
 * acr-build-run.mjs - submit an `az acr build` with --no-wait, then decide the
 * outcome from the ACR RUN STATUS (acr-run-verdict.mjs), not from the log
 * stream. See that file for the incident (run 39634317953).
 *
 * Usage (this is the command deploy-retry.mjs wraps, so its transient-retry
 * classification still sees our stderr):
 *   node acr-build-run.mjs --max-minutes 100 --poll-seconds 30 -- <az acr build args>
 *   (the args must include --registry <name>; do NOT pass --no-wait/--no-logs)
 *
 * Flow: submit (--no-wait --no-logs) -> parse run id -> stream
 * `az acr task logs` best-effort in the background (its failure, including an
 * expired SAS, is reported as a warning and decides NOTHING) -> poll
 * `az acr task show-run` -> verdict. A non-Succeeded run exits 1 with az's own
 * wording `The run with ID 'X' finished with unsuccessful status
 * 'RunStatus.FAILED'` (the failure taxonomy and the #3416 diagnose step both
 * key on it) followed by the log tail.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideRunVerdict } from './acr-run-verdict.mjs';

export function parseRunId(text) {
  const t = String(text ?? '');
  const j = /"runId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(t);
  if (j) return j[1];
  const q = /(?:run|build) with ID:?\s*'?([A-Za-z0-9_-]+)/i.exec(t);
  return q ? q[1] : null;
}

/**
 * @param {object} io injectable: submit()->{status,stdout,stderr}, show(id)->{ok,value,err},
 *   startLogs(id)->{stop()}, tailLogs(id)->string, sleep(ms), now()->ms, log(msg), err(msg)
 */
export async function runBuild(io, { registry, maxMs, pollMs, maxReadFailures = 5 }) {
  const sub = io.submit();
  if (sub.status !== 0) {
    io.err(`${sub.stderr || ''}${sub.stdout || ''}`.trim());
    io.err('ERROR: az acr build could not queue the run (it failed before an ACR run existed).');
    return 1;
  }
  const id = parseRunId(`${sub.stdout}\n${sub.stderr}`);
  if (!id) {
    io.err(`ERROR: the build was queued but no run id could be read from az output, so its outcome cannot be established. stdout: ${String(sub.stdout).slice(0, 300)}`);
    return 1;
  }
  io.log(`Queued ACR run ${id} on ${registry}. The verdict is the run status, not the log stream.`);
  let logs = null;
  try { logs = io.startLogs(id); } catch (e) { io.log(`::warning::log streaming could not start (${e.message}); the verdict does not depend on it.`); }
  const t0 = io.now();
  let failures = 0;
  try {
    for (;;) {
      const r = io.show(id);
      let run = null;
      if (r.ok) { failures = 0; run = r.value; } else {
        failures += 1;
        io.log(`::warning::could not read run ${id} status (${failures}/${maxReadFailures}): ${r.err}`);
        if (failures >= maxReadFailures) {
          io.err(`ERROR: the status of run ${id} could not be read ${failures} times in a row (${r.err}); success was NOT established.`);
          return 1;
        }
      }
      if (run !== null || r.ok) {
        const v = decideRunVerdict(run, { elapsedMs: io.now() - t0, maxMs });
        if (v.verdict === 'continue') { io.log(`ACR run ${id} Succeeded.`); return 0; }
        if (v.verdict === 'fail') {
          const st = String(run?.status ?? 'UNKNOWN').toUpperCase();
          io.err(`ERROR: The run with ID '${id}' finished with unsuccessful status 'RunStatus.${st}'. ${v.reason}. Show run logs by 'az acr task logs -r ${registry} --run-id ${id}'.`);
          try { io.err(`--- last lines of the ACR task log for ${id} ---\n${io.tailLogs(id)}`); } catch (e) { io.err(`(log tail unavailable: ${e.message})`); }
          return 1;
        }
      }
      io.sleep(pollMs);
    }
  } finally {
    try { logs?.stop(); } catch { /* best effort */ }
  }
}

function main(argv) {
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const azArgs = dd >= 0 ? argv.slice(dd + 1) : [];
  const num = (k, d) => { const i = own.indexOf(k); return i >= 0 ? Number(own[i + 1]) : d; };
  const ri = azArgs.indexOf('--registry');
  const registry = ri >= 0 ? azArgs[ri + 1] : '';
  if (!registry || azArgs.includes('--no-wait') || azArgs.includes('--no-logs')) {
    console.error('usage: acr-build-run.mjs [--max-minutes N] [--poll-seconds N] -- <az acr build args incl. --registry R>');
    return 2;
  }
  const win = process.platform === 'win32';
  const io = {
    submit: () => spawnSync('az', ['acr', 'build', '--no-wait', '--no-logs', '-o', 'json', ...azArgs], { encoding: 'utf8', shell: win, maxBuffer: 1 << 26 }),
    show: (id) => {
      const r = spawnSync('az', ['acr', 'task', 'show-run', '-r', registry, '--run-id', id, '-o', 'json'], { encoding: 'utf8', shell: win });
      if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim().split('\n').slice(-2).join(' | ') };
      try { return { ok: true, value: JSON.parse(r.stdout) }; } catch { return { ok: false, err: 'unparseable show-run output' }; }
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
    sleep: (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]),
    now: () => Date.now(),
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  };
  return runBuild(io, { registry, maxMs: num('--max-minutes', 100) * 60000, pollMs: num('--poll-seconds', 30) * 1000 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
