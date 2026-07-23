// scripts/csa-loom/dr/_drill-lib.mjs
// Shared helpers for the quarterly DR-drill validators (CSA-0073 / loom-next-level
// WS-DR items DR1–DR3). Zero-dependency: node:child_process + az CLI only, so the
// validators run on a bare GitHub-hosted runner (or the in-enclave gh-aca-runner
// for IL5 — no api.github.com or npm egress needed at drill time).
//
// Every validator asserts REAL restored state (doc counts, byte hashes, secret
// values) — never DOM strings or exit-code-only az calls — and emits a
// machine-readable report to test-results/dr/<kind>-<drillId>.json that the
// Phase-2 DR4 hub tab (and the dr-drill.yml report job) consume.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Run `az <args>` and return stdout (trimmed). Throws on non-zero exit. */
export function az(args, { input, allowFail = false } = {}) {
  try {
    return execFileSync('az', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (allowFail) {
      const e = new Error(String(err.stderr || err.message));
      e.stderr = String(err.stderr || '');
      e.failed = true;
      throw e;
    }
    console.error(`az ${args.join(' ')} failed:\n${err.stderr || err.message}`);
    throw err;
  }
}

/** Run `az <args> -o json` and JSON-parse the result. */
export function azJson(args, opts = {}) {
  const out = az([...args, '-o', 'json'], opts);
  return out ? JSON.parse(out) : null;
}

/** AAD bearer token for an arbitrary resource scope via the logged-in az context. */
export function azToken(scope) {
  return azJson(['account', 'get-access-token', '--scope', scope]).accessToken;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` (async, returns truthy to stop) every `intervalMs` up to `timeoutMs`. */
export async function poll(label, fn, { timeoutMs = 300_000, intervalMs = 10_000 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fn();
    if (res) return res;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`poll timed out after ${timeoutMs}ms: ${label}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Drill report accumulator. Usage:
 *   const report = makeReport({ scenario, drillId, cloud });
 *   await report.check('name', async () => 'detail string');   // pass/fail by throw
 *   report.finish(); report.write(); process.exit(report.ok ? 0 : 1)
 */
export function makeReport({ scenario, drillId, cloud }) {
  const startedAt = new Date();
  const checks = [];
  const rpoEvidence = {};
  const rep = {
    async check(name, fn) {
      const t0 = Date.now();
      try {
        const detail = await fn();
        checks.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
        console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
        return true;
      } catch (err) {
        checks.push({ name, ok: false, ms: Date.now() - t0, detail: String(err.message || err) });
        console.error(`  FAIL ${name} — ${err.message || err}`);
        return false;
      }
    },
    rpo(key, value) {
      rpoEvidence[key] = value;
    },
    get ok() {
      return checks.length > 0 && checks.every((c) => c.ok);
    },
    get json() {
      const finishedAt = new Date();
      return {
        drillId,
        scenario,
        cloud,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        ok: rep.ok,
        rpoEvidence,
        checks,
      };
    },
    write(dir = process.env.DR_REPORT_DIR || 'test-results/dr') {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${scenario}-${drillId}.json`);
      writeFileSync(file, `${JSON.stringify(rep.json, null, 2)}\n`);
      console.log(`report → ${file} (ok=${rep.ok})`);
      return file;
    },
  };
  return rep;
}

/** Common env plumbing for all validators. */
export function drillEnv() {
  const drillId = process.env.DRILL_ID || `local-${Date.now()}`;
  const cloud = process.env.DRILL_CLOUD || 'commercial';
  return { drillId, cloud };
}

// ---------------------------------------------------------------------------
// Cosmos DB SQL data-plane REST (AAD) — enough surface for count + sample-doc
// probes without pulling @azure/cosmos onto the runner.
// ---------------------------------------------------------------------------

function cosmosHeaders(token) {
  return {
    Authorization: encodeURIComponent(`type=aad&ver=1.0&sig=${token}`),
    'x-ms-version': '2018-12-31',
    'x-ms-date': new Date().toUTCString(),
  };
}

/** Normalize a Cosmos documentEndpoint to `https://host` (no port, no slash). */
export function cosmosOrigin(endpoint) {
  const u = new URL(endpoint);
  return `https://${u.hostname}`;
}

export function cosmosScope(endpoint) {
  return `${cosmosOrigin(endpoint)}/.default`;
}

/** GET a data-plane path (e.g. `dbs/loom/colls`). Returns parsed JSON. */
export async function cosmosGet(endpoint, token, p) {
  const res = await fetch(`${cosmosOrigin(endpoint)}/${p}`, { headers: cosmosHeaders(token) });
  if (!res.ok) throw new Error(`Cosmos GET ${p} → ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Cross-partition SQL query against one container, following continuations.
 * Returns the concatenated Documents array.
 */
export async function cosmosQuery(endpoint, token, db, coll, query) {
  const url = `${cosmosOrigin(endpoint)}/dbs/${db}/colls/${coll}/docs`;
  let continuation;
  const docs = [];
  do {
    const headers = {
      ...cosmosHeaders(token),
      'Content-Type': 'application/query+json',
      'x-ms-documentdb-isquery': 'true',
      'x-ms-documentdb-query-enablecrosspartition': 'true',
      'x-ms-max-item-count': '1000',
    };
    if (continuation) headers['x-ms-continuation'] = continuation;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query, parameters: [] }) });
    if (!res.ok) throw new Error(`Cosmos query ${db}/${coll} → ${res.status} ${await res.text()}`);
    const body = await res.json();
    docs.push(...(body.Documents || []));
    continuation = res.headers.get('x-ms-continuation');
  } while (continuation);
  return docs;
}

/** COUNT(1) across all partitions of a container (sums continuation pages). */
export async function cosmosCount(endpoint, token, db, coll) {
  const parts = await cosmosQuery(endpoint, token, db, coll, 'SELECT VALUE COUNT(1) FROM c');
  return parts.reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
}
