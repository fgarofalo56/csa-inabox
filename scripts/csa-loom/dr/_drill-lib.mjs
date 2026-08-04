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

/**
 * `az` flags whose FOLLOWING TOKEN must never reach a log or a report artifact.
 *
 * WHY (CodeQL js/clear-text-logging #664). The failure path used to print the
 * whole argv:
 *
 *     console.error(`az ${args.join(' ')} failed:\n${err.stderr || err.message}`)
 *
 * and validate-kv-recovery.mjs calls
 *
 *     az(['keyvault','secret','set','--vault-name',V,'--name',C,'--value',secret,…])
 *
 * so one non-zero exit from that command printed a live Key Vault secret value —
 * and `--subscription <guid>` beside it — into a PUBLIC repository's Actions log.
 *
 * There are THREE channels, not one, and the fix has to close all three. Measured
 * with a real `execFileSync` failure rather than assumed: node builds the thrown
 * error's `.message` as `Command failed: <the entire argv>\n<stderr>`. So the
 * secret rides out on
 *   1. the `args.join(' ')` in the log line above,
 *   2. `err.message`, which `makeReport().check` writes verbatim into
 *      `checks[].detail` — i.e. into the report JSON the dr-drill workflow
 *      uploads as an artifact, and
 *   3. `err.message` again via the validators' top-level `console.error(err)`.
 *
 * `--subscription` is not a credential, but this repository is public and a
 * subscription id is not ours to publish, so it is redacted on the same path.
 *
 * The list is EXPLICIT rather than a name heuristic: a heuristic that decides
 * "does this flag look secret?" is one unfamiliar flag away from printing one.
 */
const SECRET_VALUE_FLAGS = new Set([
  '--value',
  '--password',
  '--admin-password',
  '--secret',
  '--client-secret',
  '--account-key',
  '--sas-token',
  '--connection-string',
  '--certificate-password',
  '--token',
  '--subscription',
]);

/** Placeholder written in place of a redacted value. */
const REDACTED = '***';

/**
 * The VALUES in `args` that must not be printed: the token after any flag in
 * `SECRET_VALUE_FLAGS`, plus the right-hand side of its `--flag=value` spelling.
 *
 * Values shorter than 4 characters are excluded: they are scrubbed out of free
 * text by literal substring replacement, and a 1–3 character needle would shred
 * unrelated words in an `az` error message for no security benefit.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function secretValuesIn(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const eq = a.indexOf('=');
    if (eq > 0 && SECRET_VALUE_FLAGS.has(a.slice(0, eq))) {
      out.push(a.slice(eq + 1));
      continue;
    }
    if (SECRET_VALUE_FLAGS.has(a) && i + 1 < args.length) out.push(String(args[i + 1]));
  }
  return out.filter((v) => v.length >= 4);
}

/**
 * `args` with every sensitive value replaced by `***`, safe to print.
 * The flag NAMES are kept — "which command failed" is the whole point of the log.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function redactAzArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const eq = a.indexOf('=');
    if (eq > 0 && SECRET_VALUE_FLAGS.has(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=${REDACTED}`);
      continue;
    }
    out.push(a);
    if (SECRET_VALUE_FLAGS.has(a) && i + 1 < args.length) {
      out.push(REDACTED);
      i++; // consume the value
    }
  }
  return out;
}

/**
 * `text` with every sensitive value from `args` replaced by `***`.
 *
 * Literal substring replacement, NOT a shape heuristic: it is the only thing that
 * reliably neutralizes `err.message`, whose format ("Command failed: …") is
 * node's, not ours. GUIDs are deliberately NOT blanket-redacted — Azure error
 * bodies carry correlation/activity ids that are the only handle an operator has
 * on a failed drill, and the one GUID that does matter (the subscription) is
 * removed here because it was passed as an argument.
 *
 * @param {string} text
 * @param {string[]} args
 * @returns {string}
 */
export function scrubSecrets(text, args) {
  let out = String(text ?? '');
  for (const v of secretValuesIn(args)) out = out.split(v).join(REDACTED);
  return out;
}

/**
 * The error `az()` throws for a failed invocation: a NEW Error whose message has
 * been scrubbed.
 *
 * Re-throwing node's own error is what made this a three-channel leak — its
 * `.message` embeds the full argv, so every downstream `catch` (including
 * `makeReport().check`, which writes `err.message` into the uploaded report JSON)
 * republished the secret. `.stderr`, `.status` and `.failed` are preserved
 * because callers branch on them.
 *
 * Exported so the regression suite can drive it with a REAL `execFileSync`
 * failure instead of a hand-written fixture.
 *
 * @param {any} err the error thrown by execFileSync
 * @param {string[]} args the argv that produced it
 * @returns {Error & {stderr:string, status:number|undefined, failed:true}}
 */
export function azError(err, args) {
  const e = new Error(scrubSecrets(String(err?.stderr || err?.message || ''), args));
  e.stderr = scrubSecrets(String(err?.stderr || ''), args);
  e.status = err?.status;
  e.failed = true;
  return e;
}

/** The single line `az()` prints when a command fails. Pure, so it can be asserted on. */
export function azFailureLogLine(args, safeDetail) {
  return `az ${redactAzArgs(args).join(' ')} failed:\n${safeDetail}`;
}

/**
 * Run `az <args>` and return stdout (trimmed). Throws (a scrubbed error) on non-zero exit.
 *
 * `_exec` is a test seam, not an option: the regression suite injects a runner
 * that throws a REAL `execFileSync` error so the catch block below — both
 * branches, and the `console.error` line — is exercised on a machine with no
 * `az` on PATH. Nothing in the drill scripts passes it.
 */
export function az(args, { input, allowFail = false, _exec = execFileSync } = {}) {
  try {
    return _exec('az', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    // NEVER `throw err`. Node builds its own error message as
    // "Command failed: <the entire argv>" followed by the stderr, so
    // re-throwing it hands the `--value <secret>` to every downstream catch —
    // including makeReport().check, which copies `err.message` into the
    // uploaded report JSON. That was a leak channel independent of the log
    // line below, and closing only the log line would have left it open.
    const e = azError(err, args);
    if (!allowFail) console.error(azFailureLogLine(args, e.message));
    throw e;
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
