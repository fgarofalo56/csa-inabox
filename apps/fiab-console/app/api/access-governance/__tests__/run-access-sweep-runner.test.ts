/**
 * The scheduled `loom-access-sweep` job's runner (e2e/run-access-sweep.mjs):
 * its EXIT CODE is the only signal the Container App Job records, so a pass
 * that did not happen must fail the execution.
 *
 * The real script is run as a child process against an in-process HTTP server
 * standing in for the console's sweep route; nothing is mocked inside it.
 *
 * Each assertion names the value that breaks it:
 *   - an expiry pass that answers ok with `grantRecordsError` exits non-zero
 *     and says why. Breaks if the runner returns success for it (exit 0, the
 *     reviewer's finding: the job reported Succeeded over a grant-records pass
 *     that did not run);
 *   - positive pair: the same pass without the error exits 0, and its log line
 *     carries every grant-record count, `stillAbsent` and `lapsed` included.
 *     Breaks if a clean pass failed too, or if a count is dropped from the log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const SCRIPT = path.resolve(__dirname, '../../../../e2e/run-access-sweep.mjs');

let server: http.Server;
let base = '';
let body: Record<string, unknown> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** Run the real runner in expiry mode; resolves with its exit code and output. */
function runSweep(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      // A placeholder value: the stand-in server never checks it.
      env: { ...process.env, LOOM_URL: base, LOOM_INTERNAL_TOKEN: 'placeholder', ACCESS_SWEEP_MODE: 'expiry', ACCESS_SWEEP_DRY_RUN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const COUNTS = { checked: 6, absent: 1, found: 2, landedLate: 3, stillAbsent: 4, lapsed: 5, unknown: 7 };

describe('run-access-sweep.mjs — the scheduled job fails when the grant records were not resolved', () => {
  it('exits non-zero when the expiry pass reports grantRecordsError', async () => {
    body = {
      ok: true, dryRun: false, candidates: 0, expired: 0,
      grantRecordsError: 'The access-request grant records could not be resolved (the store answered 503).',
    };
    const { code, out } = await runSweep();
    expect(code).toBe(1);
    expect(out).toContain('expiry: grant records not resolved');
    expect(out).toContain('grantRecordsError="The access-request grant records could not be resolved (the store answered 503)."');
  }, 30_000);

  it('positive pair: exits 0 for a clean pass and logs every count', async () => {
    body = { ok: true, dryRun: false, candidates: 2, expired: 1, grantRecords: COUNTS };
    const { code, out } = await runSweep();
    expect(code).toBe(0);
    expect(out).toContain(
      'expiry: ok — candidates=2 expired=1 grantRecords: checked=6 absent=1 found=2 landedLate=3 stillAbsent=4 lapsed=5 unknown=7',
    );
  }, 30_000);
});
