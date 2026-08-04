/**
 * End-to-end contract test for scripts/ci/reindex-loom-docs.sh (#2929).
 *
 * WHY A REAL SERVER AND REAL curl
 * -------------------------------
 * The decision logic is already unit-tested in classify-reindex-result.test.mjs.
 * What is NOT covered by that — and is exactly where this repo keeps getting
 * bitten — is the GLUE: a shell wrapper that computes a correct verdict and then
 * discards it. `|| true`, a missing `exit 1`, a `2>/dev/null`, a subshell that
 * eats the status. Those are invisible to a unit test of the classifier and to
 * any test that stubs curl, because a stub tends to model the code's
 * assumptions rather than the dependency's behaviour.
 *
 * So this drives the REAL script with the REAL `curl` binary against a REAL
 * `node:http` server that speaks the route's actual contract, and asserts on the
 * script's PROCESS EXIT CODE — the only thing a workflow step actually reads.
 *
 * MUTATION-PROOF: each `exit 1` expectation below goes RED if the corresponding
 * failure path in the script is softened (drop the `fail` after the classifier,
 * add `|| true` to the classifier call, or make the poll timeout a pass).
 *
 * Run: node --test scripts/ci/__tests__/reindex-loom-docs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'reindex-loom-docs.sh');

/** A body the route would actually return for a GET poll. */
function pollBody({ freshness, job = 'running' }) {
  return {
    ok: true,
    backend: 'ai-search',
    job: { state: job, jobId: 'j-1', error: job === 'failed' ? 'AI Search upload failed: 403' : null },
    freshness: { state: freshness, indexedChunkCount: 49593 },
    sourceFiles: 2453,
  };
}

/**
 * Stand up a console stub.
 * @param {(n:number)=>{status:number,body:unknown}} onPost
 * @param {(n:number)=>{status:number,body:unknown}} onGet
 */
async function withServer(onPost, onGet, run) {
  let posts = 0;
  let gets = 0;
  const server = http.createServer((req, res) => {
    const isPost = req.method === 'POST';
    const handler = isPost ? onPost : onGet;
    const n = isPost ? ++posts : ++gets;
    const { status, body } = handler(n);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(url, () => ({ posts, gets }));
  } finally {
    // curl keeps the connection alive; without this `close` waits on an idle
    // socket and the test file never exits.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/**
 * Invoke the real script. MUST be async: the stub server above lives in THIS
 * process, so a synchronous `spawnSync` would block the event loop, the server
 * would never answer curl, and every case would deadlock rather than assert.
 *
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function runScript(url, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        ...process.env,
        CONSOLE_URL: url,
        INTERNAL_TOKEN: 'test-token',
        POLL_TIMEOUT_S: '6',
        POLL_INTERVAL_S: '1',
        GITHUB_OUTPUT: '', // never write to the real step output from a test
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

const ACCEPTED = { status: 202, body: { ok: true, accepted: true, state: 'running', jobId: 'j-1' } };

test('202 → polls → freshness fresh → exit 0', async () => {
  await withServer(
    () => ACCEPTED,
    (n) => ({ status: 200, body: pollBody({ freshness: n >= 2 ? 'fresh' : 'stale' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /FRESH index/i);
      assert.ok(counts().gets >= 2, 'must actually poll more than once');
    },
  );
});

/**
 * THE REGRESSION. This is byte-for-byte what the live console returned on
 * 2026-08-04 (run 30937670794): a 502 in ~160ms because the image shipped with
 * no staged Copilot corpus. It used to be swallowed as an honest "not
 * configured" gate, so the eval measured a stale index and reported per-surface
 * hit-rates as if they were fresh.
 */
test('502 "No corpus chunks discovered" → exit 1 (never tolerated)', async () => {
  await withServer(
    () => ({
      status: 502,
      body: {
        ok: false,
        backend: 'none',
        totalChunks: 0,
        uploaded: 0,
        byKind: {},
        warnings: [],
        error: 'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd',
      },
    }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /NO CORPUS/i);
      assert.equal(counts().gets, 0, 'a failed POST must not be followed by polling');
    },
  );
});

/**
 * MUTATION-PROOF (load-bearing). Make the timeout branch a pass — in the script
 * or in classifyReindexPoll — and this goes RED. A timeout is a refusal:
 * proceeding measures the stale index the whole step exists to prevent.
 */
test('202 but never fresh → poll TIMEOUT → exit 1', async () => {
  await withServer(
    () => ACCEPTED,
    () => ({ status: 200, body: pollBody({ freshness: 'stale' }) }),
    async (url) => {
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /REFUSAL/i);
    },
  );
});

test('202 then job.state failed → exit 1 (fails fast, no waiting out the cap)', async () => {
  await withServer(
    () => ACCEPTED,
    () => ({ status: 200, body: pollBody({ freshness: 'stale', job: 'failed' }) }),
    async (url) => {
      const started = Date.now();
      const res = await runScript(url);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /NOT refreshed/i);
      assert.ok(Date.now() - started < 6000, 'must break on the failure, not poll to the cap');
    },
  );
});

test('401 (token mismatch) → exit 1 — the reindex never ran', async () => {
  await withServer(
    () => ({ status: 401, body: { ok: false, error: 'unauthenticated' } }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url) => {
      assert.equal((await runScript(url)).status, 1);
    },
  );
});

/** A pre-#2929 console rebuilds inline and answers 200. Complete already. */
test('200 (legacy inline console) → exit 0 and does NOT poll', async () => {
  await withServer(
    () => ({
      status: 200,
      body: { ok: true, backend: 'ai-search', totalChunks: 49593, uploaded: 49593, byKind: {}, warnings: [] },
    }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url);
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.equal(counts().gets, 0);
    },
  );
});

/** An unset secret is an honest gate, not a broken index — and must not poll. */
test('no INTERNAL_TOKEN → warn + exit 0, no request at all', async () => {
  await withServer(
    () => ACCEPTED,
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url, counts) => {
      const res = await runScript(url, { INTERNAL_TOKEN: '' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /::warning::.*LOOM_INTERNAL_TOKEN/);
      assert.equal(counts().posts + counts().gets, 0);
    },
  );
});

/**
 * FATAL=false is the post-deploy bootstrap's documented non-blocking contract.
 * It may only change the EXIT CODE, and it must say so out loud — a silent
 * downgrade would be indistinguishable from a gate that cannot fail.
 */
test('FATAL=false downgrades a real failure to a loud warning (bootstrap contract)', async () => {
  await withServer(
    () => ({ status: 502, body: { ok: false, error: 'No corpus chunks discovered — …' } }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url) => {
      const res = await runScript(url, { FATAL: 'false' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /NO CORPUS/i, 'the real verdict is still printed');
      assert.match(res.stdout, /::warning::.*non-blocking/i);
    },
  );
});

/** FATAL defaults to fatal: a new call site cannot silently opt out. */
test('FATAL defaults to true (opt-out must be explicit)', async () => {
  await withServer(
    () => ({ status: 500, body: { ok: false, error: 'kaboom' } }),
    () => ({ status: 200, body: pollBody({ freshness: 'fresh' }) }),
    async (url) => {
      assert.equal((await runScript(url)).status, 1);
    },
  );
});

test('missing CONSOLE_URL is a hard error, not a silent skip', async () => {
  const res = await runScript('', { CONSOLE_URL: '', INTERNAL_TOKEN: 'x' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CONSOLE_URL/);
});
