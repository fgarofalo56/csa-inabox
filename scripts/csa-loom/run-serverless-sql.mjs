#!/usr/bin/env node
/**
 * run-serverless-sql.mjs — execute a batch of T-SQL against a Synapse serverless
 * SQL endpoint with an AAD access token, using the SAME `mssql` driver +
 * `azure-active-directory-access-token` auth the console itself uses
 * (apps/fiab-console/lib/azure/synapse-sql-client.ts). Reads the SQL from stdin,
 * splits it on `GO` batch separators, and runs each batch in order.
 *
 * This exists because sqlcmd's AAD-token support is inconsistent across the
 * runner images; the mssql driver path is exactly what runs in production, so
 * the seed executes over the identical stack.
 *
 * Env:
 *   SQL_SERVER         <workspace>-ondemand.sql.azuresynapse.net (required)
 *   SQL_ACCESS_TOKEN   AAD access token for the SQL resource      (required)
 * Args:
 *   --database <name>  database to connect to (default: master)
 *   --ignore-errors    log a failing batch and continue (idempotent CREATE
 *                      DATABASE: a benign "already exists" must not abort)
 *
 * Exit 0 on success; non-zero (and a printed error) on the first failing batch.
 *
 * Usage (from scripts/csa-loom/seed-dax-golden.sh):
 *   node scripts/csa-loom/gen-dax-golden-ddl.mjs --views-only \
 *     | SQL_SERVER=... SQL_ACCESS_TOKEN=... node scripts/csa-loom/run-serverless-sql.mjs --database loom_dax_golden
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

// Resolve `mssql` from the console workspace (the repo-root node_modules does
// not carry it in this pnpm layout).
const requireFromConsole = createRequire(
  pathToFileURL(path.join(REPO_ROOT, 'apps', 'fiab-console', 'package.json')),
);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/** Split a script into batches on lines that are exactly `GO` (case-insensitive). */
function splitBatches(sqlText) {
  const batches = [];
  let cur = [];
  for (const line of sqlText.replace(/\r/g, '').split('\n')) {
    if (/^\s*GO\s*$/i.test(line)) {
      if (cur.join('\n').trim()) batches.push(cur.join('\n'));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.join('\n').trim()) batches.push(cur.join('\n'));
  return batches;
}

async function main() {
  const server = process.env.SQL_SERVER;
  const token = process.env.SQL_ACCESS_TOKEN;
  const database = arg('--database', 'master');
  const ignoreErrors = process.argv.includes('--ignore-errors');
  if (!server) throw new Error('SQL_SERVER is required (<workspace>-ondemand.sql.azuresynapse.net)');
  if (!token) throw new Error('SQL_ACCESS_TOKEN is required (az account get-access-token …)');

  const sqlText = await readStdin();
  const batches = splitBatches(sqlText);
  if (batches.length === 0) {
    console.log('[run-serverless-sql] no batches to run');
    return;
  }

  const sql = requireFromConsole('mssql');
  const pool = new sql.ConnectionPool({
    server,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    requestTimeout: 120_000,
    connectionTimeout: 30_000,
  });

  await pool.connect();
  console.log(`[run-serverless-sql] connected ${server}/${database} — ${batches.length} batch(es)`);
  try {
    for (let i = 0; i < batches.length; i++) {
      try {
        const res = await pool.request().query(batches[i]);
        const affected = Array.isArray(res.rowsAffected)
          ? res.rowsAffected.reduce((a, b) => a + b, 0)
          : 0;
        console.log(`  batch ${i + 1}/${batches.length} ok (rowsAffected=${affected})`);
      } catch (e) {
        if (ignoreErrors) {
          console.log(`  batch ${i + 1}/${batches.length} ignored: ${e?.message || e}`);
        } else {
          throw e;
        }
      }
    }
  } finally {
    await pool.close().catch(() => {});
  }
  console.log('[run-serverless-sql] done');
}

main().catch((e) => {
  console.error(`[run-serverless-sql] FAILED: ${e?.message || e}`);
  process.exit(1);
});
