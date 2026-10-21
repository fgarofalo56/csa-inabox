#!/usr/bin/env node
/**
 * acr-run-verdict.mjs - decide a build step's outcome from the ACR RUN STATUS,
 * never from the log stream.
 *
 * WHY: `az acr build` streams the task log over a SAS URL that expires about
 * 70 minutes after submission. Run 39634317953 (loom-directlake): ACR run cj90w
 * queued 52 min on the default agents, then SUCCEEDED and pushed the image, but
 * the stream died with AuthenticationFailed. The step went red, so the Trivy
 * gate and cosign signing were skipped on an image already pushed under
 * :v0.1 / :latest. The registry's run record is the authority; the stream is a
 * convenience.
 *
 * Input : the JSON of `az acr task show-run` (or null if unreadable).
 * Output: { verdict: 'continue' | 'wait' | 'fail', reason }
 *   Succeeded                          -> continue
 *   Queued / Started / Running         -> wait, or fail with a timeout message
 *                                         once elapsedMs >= maxMs
 *   Failed / Canceled / Timeout / Error-> fail
 *   missing/unknown status, null input -> fail (closed): a status that cannot
 *                                         be read is never treated as success.
 *
 * CLI: node acr-run-verdict.mjs <show-run.json> [--elapsed-min N] [--max-min N]
 *      exit 0 continue, 3 wait, 1 fail, 2 usage.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TERMINAL_FAIL = ['Failed', 'Canceled', 'Cancelled', 'Timeout', 'Error'];
export const IN_FLIGHT = ['Queued', 'Started', 'Running'];

export function decideRunVerdict(run, { elapsedMs = 0, maxMs = Infinity } = {}) {
  const status = run && typeof run === 'object' ? run.status : undefined;
  if (typeof status !== 'string' || status === '') {
    return { verdict: 'fail', reason: 'the run status could not be read, so success was NOT established' };
  }
  if (status === 'Succeeded') return { verdict: 'continue', reason: 'ACR run status is Succeeded' };
  if (TERMINAL_FAIL.includes(status)) return { verdict: 'fail', reason: `ACR run finished with status ${status}` };
  if (IN_FLIGHT.includes(status)) {
    if (elapsedMs >= maxMs) {
      return { verdict: 'fail', reason: `timed out: run still ${status} after ${Math.round(elapsedMs / 60000)} min (limit ${Math.round(maxMs / 60000)} min)` };
    }
    return { verdict: 'wait', reason: `run is ${status}` };
  }
  return { verdict: 'fail', reason: `unrecognised run status '${status}', so success was NOT established` };
}

function main(argv) {
  const file = argv[0];
  if (!file) { console.error('usage: acr-run-verdict.mjs <show-run.json> [--elapsed-min N] [--max-min N]'); return 2; }
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
  let run = null;
  try { run = JSON.parse(readFileSync(file, 'utf8')); } catch { run = null; }
  const v = decideRunVerdict(run, { elapsedMs: arg('--elapsed-min', 0) * 60000, maxMs: arg('--max-min', Infinity) * 60000 });
  console.log(`${v.verdict}: ${v.reason}`);
  return v.verdict === 'continue' ? 0 : v.verdict === 'wait' ? 3 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
