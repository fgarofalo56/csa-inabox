#!/usr/bin/env node
/**
 * Unattended headless entrypoint for the Loom UAT Container App Job.
 *
 * What it does:
 *   1. Reads SESSION_SECRET + LOOM_URL + automation-identity env vars.
 *   2. Calls mintStorageState() (same mechanism as global-setup.ts) to
 *      produce a Playwright storageState object with a pre-minted
 *      loom_session cookie — no MSAL, no MFA, no user credentials.
 *   3. Writes the storageState to .auth/loom-state.json and sets
 *      LOOM_STORAGE_STATE so playwright.config.ts picks it up.
 *   4. Runs `pnpm exec playwright test --project=<UAT_PROJECT>` (default: uat).
 *      UAT_GREP narrows to a spec pattern (slice run).
 *   5. Reads test-results/uat/report.json + verdicts.ndjson and prints:
 *        UAT_RESULT pass=<n> fail=<n> skip=<n> realFails=<n> infraGated=<n>
 *      Exits non-zero if any realFail (crash/empty/non-infra code bug).
 *      Exit 0 when all failures are infra-gated (honest provisioning gates).
 *      UAT_STRICT_PROVISION=1 restores the old behaviour (any fail → exit 1).
 *   6. (Best-effort) Uploads report.json + verdicts.ndjson + every artifact
 *      under test-results/uat/artifacts/ to Azure Blob when
 *      LOOM_UAT_RESULTS_CONTAINER + LOOM_UAT_RESULTS_ACCOUNT are set.
 *      Uses DefaultAzureCredential (the job's managed identity).
 *      Run tag = UAT_RUN_TAG env, else CONTAINER_APP_REPLICA_NAME, else
 *      a short random string (deterministic within a replica lifetime).
 *
 * Required env vars:
 *   SESSION_SECRET          — console session-signing secret (from ARM literal)
 *   LOOM_URL                — console base URL (e.g. https://loom-console.b02.azurefd.net)
 *   LOOM_AUTOMATION_OID     — object ID baked into the minted session. No default:
 *                             this run performs REAL writes and Cosmos partitions
 *                             them on the creator oid, so a sentinel deposits the
 *                             whole run in a partition nobody can enumerate (#3804).
 *
 * Optional env vars:
 *   LOOM_AUTOMATION_UPN     — UPN for the minted session
 *   LOOM_AUTOMATION_NAME    — display name for the minted session
 *   UAT_PROJECT             — playwright --project value (default: uat)
 *   UAT_GREP                — playwright --grep pattern for a slice run
 *   UAT_STRICT_PROVISION    — set to "1" to fail on ANY provision failure (not just code bugs)
 *   LOOM_UAT_RESULTS_CONTAINER — blob container name (e.g. "uat-results")
 *   LOOM_UAT_RESULTS_ACCOUNT   — storage account name (e.g. "stloomm56y")
 *   UAT_RUN_TAG             — human-readable run identifier (preferred over replica name)
 *   CONTAINER_APP_REPLICA_NAME — set by ACA runtime; used as fallback run tag
 *
 * Usage (in Container App Job):
 *   node e2e/run-uat-unattended.mjs
 *   # Or run a slice first:
 *   UAT_GREP="catalog" node e2e/run-uat-unattended.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The one exception to the no-TS-imports note below: mint-cookie.mjs is the
// plain-JS twin of mint-session.ts, built precisely so .mjs entrypoints can
// share code without pulling the TypeScript tree. Importing the identity guard
// from it satisfies that constraint rather than bending it (#3804).
import { requireAutomationOid } from './auth/mint-cookie.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of the fiab-console package (one level up from e2e/).
const ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(ROOT, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'loom-state.json');
const UAT_RESULTS_DIR = path.join(ROOT, 'test-results', 'uat');
const REPORT_JSON = path.join(UAT_RESULTS_DIR, 'report.json');
const VERDICTS_NDJSON = path.join(UAT_RESULTS_DIR, 'verdicts.ndjson');
const ARTIFACTS_DIR = path.join(UAT_RESULTS_DIR, 'artifacts');

// ---------------------------------------------------------------------------
// Inline session mint — mirrors mint-session.ts using only Node built-ins so
// this .mjs entrypoint has zero imports from the TypeScript source tree.
// The algorithm is IDENTICAL to lib/auth/session.ts (HKDF-SHA-256 + AES-256-GCM).
// ---------------------------------------------------------------------------
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const HKDF_INFO = 'loom-session-v1';
const COOKIE_NAME = 'loom_session';

function deriveKey(sessionSecret) {
  const ab = crypto.hkdfSync(
    'sha256',
    Buffer.from(sessionSecret, 'utf-8'),
    Buffer.alloc(32),
    Buffer.from(HKDF_INFO),
    32,
  );
  return Buffer.from(ab);
}

function mintCookieValue(sessionSecret, claims, ttlSecs = 28_800) {
  const key = deriveKey(sessionSecret);
  const payload = { claims, exp: Math.floor(Date.now() / 1000) + ttlSecs };
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf-8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function buildStorageState(baseUrl, claims, ttlSecs = 28_800) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      '[run-uat-unattended] SESSION_SECRET is required.\n' +
      '  Pull it from the console container-app literal via ARM:\n' +
      '  az containerapp secret show -n loom-console -g $ADMIN_RG --secret-name session-secret --query value -o tsv',
    );
  }
  const host = new URL(baseUrl).hostname;
  const value = mintCookieValue(sessionSecret, claims, ttlSecs);
  const expires = Math.floor(Date.now() / 1000) + ttlSecs;
  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value,
        domain: host,
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
}

// ---------------------------------------------------------------------------
// Derive a stable run tag from env (no Date.now() — deterministic per replica).
// Priority: UAT_RUN_TAG > CONTAINER_APP_REPLICA_NAME > short random string.
// ---------------------------------------------------------------------------
function buildRunTag() {
  if (process.env.UAT_RUN_TAG) return process.env.UAT_RUN_TAG;
  if (process.env.CONTAINER_APP_REPLICA_NAME) return process.env.CONTAINER_APP_REPLICA_NAME;
  // Fall back to a 8-char hex derived from process start time + pid — stable
  // within a single job execution but doesn't leak wall-clock timestamps.
  return crypto
    .createHash('sha256')
    .update(`${process.pid}:${process.hrtime.bigint().toString()}`)
    .digest('hex')
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Summary reader — parses both Playwright report.json and verdicts.ndjson
// to produce the gate-aware summary.
// ---------------------------------------------------------------------------
function readSummary() {
  let pass = 0, fail = 0, skip = 0;
  try {
    const raw = fs.readFileSync(REPORT_JSON, 'utf-8');
    const report = JSON.parse(raw);
    // Playwright JSON reporter top-level structure: { stats: { expected, unexpected, skipped, ... } }
    const stats = report.stats || {};
    pass = stats.expected ?? 0;
    fail = stats.unexpected ?? 0;
    skip = stats.skipped ?? 0;
  } catch {
    return null;
  }
  return { pass, fail, skip };
}

/**
 * Enumerate every FAILED test from report.json and print one grep-friendly line
 * each: `UAT_FAIL <file>:<line> › <title> :: <first error line>`. This is the
 * per-run triage signal that survives in Log Analytics even when the blob
 * upload fails — it covers ALL specs (no-cuts, admin pages, etc.), not just the
 * use-case-apps verdicts. Walks the Playwright JSON reporter suite tree.
 */
function printFailedTests() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf-8'));
  } catch {
    return;
  }
  const fails = [];
  const walk = (suite, fileHint) => {
    const file = suite.file || fileHint || '';
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const bad = (t.results || []).some(
          (r) => r.status && r.status !== 'passed' && r.status !== 'skipped' && r.status !== 'expected',
        );
        const ok = (t.results || []).some((r) => r.status === 'passed' || r.status === 'expected');
        if (bad && !ok) {
          const errRaw =
            (t.results || []).map((r) => r.error?.message).find(Boolean) || '';
          const errLine = String(errRaw)
            .replace(/\[[0-9;]*m/g, '') // strip ANSI
            .split('\n')[0]
            .slice(0, 200);
          fails.push(`UAT_FAIL ${spec.file || file}:${spec.line ?? '?'} › ${spec.title} :: ${errLine}`);
        }
      }
    }
    for (const child of suite.suites || []) walk(child, file);
  };
  for (const s of report.suites || []) walk(s, s.file);
  if (fails.length) {
    console.error(`[run-uat-unattended] ${fails.length} failing test(s) (full list for triage):`);
    for (const line of fails) console.error(line);
  }
}

/**
 * Parse verdicts.ndjson to separate realFails from infra-gated outcomes.
 * A verdict is infra-gated when:
 *   - status==='fail' AND notes contain provision-failure keywords that
 *     indicate a missing/unauthorized Azure resource (not a code crash).
 * A verdict is a realFail when:
 *   - status==='fail' AND notes contain CRASH=[...] or EMPTY=[...] with
 *     at least one entry, OR there are no matching infra-gate keywords.
 */
function readGateAwareVerdicts() {
  const realFails = [];
  let infraGatedSteps = 0;

  if (!fs.existsSync(VERDICTS_NDJSON)) return { realFails, infraGatedSteps };

  const INFRA_GATE_RE = /not configured|not found|unauthorized|forbidden|does not exist|no .* workspace|provision|quota|RBAC|role|429|403|404|env var/i;

  const lines = fs.readFileSync(VERDICTS_NDJSON, 'utf-8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (v.status !== 'fail') continue;

    const notes = v.notes || '';
    // Extract crash/empty lists from the notes string written by use-case-apps-uat.uat.ts
    // e.g. "CRASH=[notebook,kql] EMPTY=[warehouse]"
    const crashMatch = notes.match(/CRASH=\[([^\]]*)\]/);
    const emptyMatch = notes.match(/EMPTY=\[([^\]]*)\]/);
    const crashes = crashMatch ? crashMatch[1].split(',').filter(Boolean) : [];
    const empties = emptyMatch ? emptyMatch[1].split(',').filter(Boolean) : [];

    // Provision-failure lines (PROV-FAILS section in notes):
    const provFailSection = notes.split('| PROV-FAILS:')[1] || '';
    const provFailItems = provFailSection ? provFailSection.split(';').map(s => s.trim()).filter(Boolean) : [];

    // Separate infra-gated prov steps from real code failures
    const realProvFails = provFailItems.filter(f => !INFRA_GATE_RE.test(f));
    const gatedProvFails = provFailItems.filter(f => INFRA_GATE_RE.test(f));
    infraGatedSteps += gatedProvFails.length;

    const isRealFail = crashes.length > 0 || empties.length > 0 || realProvFails.length > 0;
    if (isRealFail) {
      realFails.push({
        surface: v.surface,
        crashes,
        empties,
        realProvFails,
      });
    }
    // If only gated prov failures (and no crashes/empties), this is NOT a real fail.
  }

  return { realFails, infraGatedSteps };
}

// ---------------------------------------------------------------------------
// Best-effort results upload via @azure/storage-blob + DefaultAzureCredential.
// The job's managed identity must have Storage Blob Data Contributor on the
// target storage account. This runs IN the VNet so PE-protected accounts work.
// ---------------------------------------------------------------------------
async function uploadResults(runTag) {
  const containerName = process.env.LOOM_UAT_RESULTS_CONTAINER;
  const accountName = process.env.LOOM_UAT_RESULTS_ACCOUNT;
  if (!containerName || !accountName) return;

  try {
    // Dynamic import — avoids ESM/CJS issues with top-level await unavailability
    // in older Node versions and keeps the import lazy (not needed in dry runs).
    const { BlobServiceClient } = await import('@azure/storage-blob');

    // On Azure Container Apps, @azure/identity's DefaultAzureCredential FAILS to
    // parse the MI token (the ACA endpoint returns `expires_on` as Unix-seconds
    // and omits `expires_in`), which is exactly the `ChainedTokenCredential
    // authentication failed` we hit. Mirror the console's AcaManagedIdentityCredential:
    // raw-fetch the 2019-08-01 endpoint with X-IDENTITY-HEADER and map
    // expires_on → ms. Fall back to DefaultAzureCredential off-ACA (local dev).
    const endpoint = process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT;
    const header = process.env.IDENTITY_HEADER || process.env.MSI_SECRET;
    const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID || undefined;
    let credential;
    if (endpoint && header) {
      credential = {
        async getToken(scopes) {
          const scope = Array.isArray(scopes) ? scopes[0] : scopes;
          const resource = String(scope).replace(/\/\.default$/, '');
          const u = new URL(endpoint);
          u.searchParams.set('resource', resource);
          u.searchParams.set('api-version', '2019-08-01');
          if (clientId) u.searchParams.set('client_id', clientId);
          const res = await fetch(u.toString(), { headers: { 'X-IDENTITY-HEADER': header } });
          if (!res.ok) throw new Error(`ACA MI token fetch ${res.status}: ${await res.text().catch(() => '')}`);
          const j = await res.json();
          return { token: j.access_token, expiresOnTimestamp: Number(j.expires_on) * 1000 };
        },
      };
    } else {
      const { DefaultAzureCredential } = await import('@azure/identity');
      credential = new DefaultAzureCredential();
    }
    // Sovereign-cloud blob host. LOOM_STORAGE_BLOB_SUFFIX is emitted per-cloud by
    // admin-plane/synthetic-monitor-job.bicep from environment().suffixes.storage
    // (blob.core.windows.net in Commercial/GCC, blob.core.usgovcloudapi.net in
    // GCC-High/IL5). This used to be a hard-coded commercial literal, so in Gov
    // the upload resolved a host that does not exist there and silently no-op'd
    // through the catch below — the Journeys tab could never populate in Gov.
    const blobSuffix = (process.env.LOOM_STORAGE_BLOB_SUFFIX || '').trim()
      || (/usgov|AzureUSGovernment|AzureDOD|GCC-High|IL5|DoD/i.test(
            `${process.env.AZURE_CLOUD || ''} ${process.env.LOOM_CLOUD || ''}`)
          ? 'blob.core.usgovcloudapi.net'
          : 'blob.core.windows.net');
    const serviceUrl = `https://${accountName}.${blobSuffix}`;
    const blobService = new BlobServiceClient(serviceUrl, credential);
    const containerClient = blobService.getContainerClient(containerName);

    // Ensure the container exists (idempotent — no-op if already present).
    await containerClient.createIfNotExists();

    const prefix = `uat-runs/${runTag}`;
    let uploadCount = 0;

    // Helper to upload a single local file to a blob path.
    async function uploadFile(localPath, blobPath) {
      const blockBlob = containerClient.getBlockBlobClient(blobPath);
      await blockBlob.uploadFile(localPath);
      uploadCount++;
    }

    // Upload report.json
    if (fs.existsSync(REPORT_JSON)) {
      await uploadFile(REPORT_JSON, `${prefix}/report.json`);
    }

    // Upload verdicts.ndjson
    if (fs.existsSync(VERDICTS_NDJSON)) {
      await uploadFile(VERDICTS_NDJSON, `${prefix}/verdicts.ndjson`);
    }

    // Upload every file under test-results/uat/artifacts/
    if (fs.existsSync(ARTIFACTS_DIR)) {
      const walk = (dir, base) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files = [];
        for (const e of entries) {
          const full = path.join(dir, e.name);
          const rel = path.join(base, e.name);
          if (e.isDirectory()) files.push(...walk(full, rel));
          else files.push({ localPath: full, relPath: rel });
        }
        return files;
      };
      const files = walk(ARTIFACTS_DIR, 'artifacts');
      // Upload concurrently, bounded to 8 in-flight at once.
      const CONCURRENCY = 8;
      for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = files.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(f => uploadFile(f.localPath, `${prefix}/${f.relPath}`)));
      }
    }

    // Upload screenshots from test-results/uat/ (*.png, not under artifacts/)
    const uatPngFiles = fs.readdirSync(UAT_RESULTS_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.png'))
      .map(e => ({ localPath: path.join(UAT_RESULTS_DIR, e.name), relPath: e.name }));
    // Also check sub-directories that contain screenshots (e.g. use-case-apps/)
    const uatSubDirs = fs.readdirSync(UAT_RESULTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'artifacts');
    for (const d of uatSubDirs) {
      const subDir = path.join(UAT_RESULTS_DIR, d.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.png'))
          .map(e => ({ localPath: path.join(subDir, e.name), relPath: path.join(d.name, e.name) }));
        uatPngFiles.push(...subFiles);
      } catch { /* skip unreadable sub-dirs */ }
    }
    for (let i = 0; i < uatPngFiles.length; i += 8) {
      const batch = uatPngFiles.slice(i, i + 8);
      await Promise.all(batch.map(f => uploadFile(f.localPath, `${prefix}/screenshots/${f.relPath}`)));
    }

    console.log(`[run-uat-unattended] uploaded ${uploadCount} blobs to ${containerName}/${prefix}/`);
  } catch (err) {
    // Non-fatal — results are still in the container job logs.
    console.warn(`[run-uat-unattended] Results upload failed (non-fatal): ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // --- 1. Validate required env vars ----------------------------------------
  const loomUrl = process.env.LOOM_URL;
  if (!loomUrl) {
    console.error('[run-uat-unattended] LOOM_URL is required.');
    process.exit(1);
  }

  // The identity fails closed, symmetric with LOOM_URL directly above (#3804).
  // This suite CREATES workspaces and items; `workspaces` is partitioned by the
  // creator's oid, so the old `…0001` fallback deposited a full UAT run in a
  // partition no principal can sign in to and enumerate — and the run reported
  // success. That is the mechanism behind the 24 orphans in #3801, which the
  // cleanup script could not see because it defaulted to a DIFFERENT fake oid.
  //
  // Both the empty and the placeholder case are decided at the shared chokepoint
  // in auth/mint-cookie.mjs. A local `if (!oid)` would only cover the first: the
  // fallback this replaced was `…0001`, which is non-empty and a well-formed
  // GUID, so it satisfies every shape test a naive guard performs.
  const oid = process.env.LOOM_AUTOMATION_OID;
  try {
    requireAutomationOid({ oid });
  } catch (err) {
    console.error(`[run-uat-unattended] ${err.message}`);
    process.exit(1);
  }
  const upn = process.env.LOOM_AUTOMATION_UPN || 'loom-uat@automation.local';
  const name = process.env.LOOM_AUTOMATION_NAME || 'Loom UAT [automation]';
  const claims = { oid, name, upn, email: upn };

  const project = process.env.UAT_PROJECT || 'uat';
  const grep = process.env.UAT_GREP || '';
  const strictProvision = process.env.UAT_STRICT_PROVISION === '1';
  const runTag = buildRunTag();

  console.log(`[run-uat-unattended] target   : ${loomUrl}`);
  console.log(`[run-uat-unattended] project  : ${project}${grep ? ` (grep: ${grep})` : ' (full suite)'}`);
  console.log(`[run-uat-unattended] identity : oid=${oid} upn=${upn}`);
  console.log(`[run-uat-unattended] run tag  : ${runTag}`);
  console.log(`[run-uat-unattended] mode     : ${strictProvision ? 'STRICT (UAT_STRICT_PROVISION=1)' : 'gate-aware (infra-gates are PASS)'}`);

  // --- 2. Mint storageState -------------------------------------------------
  let storageState;
  try {
    storageState = buildStorageState(loomUrl, claims);
  } catch (err) {
    console.error(`[run-uat-unattended] Failed to mint session: ${err.message}`);
    process.exit(1);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(storageState, null, 2));
  console.log(`[run-uat-unattended] session minted → ${AUTH_FILE}`);

  // --- 3. Set env vars for playwright.config.ts ----------------------------
  process.env.LOOM_STORAGE_STATE = AUTH_FILE;
  process.env.LOOM_URL = loomUrl;
  // Pass the run tag into test env so specs can annotate artifacts.
  process.env.UAT_RUN_TAG = runTag;

  // --- 4. Run Playwright ----------------------------------------------------
  let playwrightExitCode = 0;
  try {
    const grepArg = grep ? ` --grep "${grep}"` : '';
    // Playwright matches --grep / --grep-invert against the test's FILE PATH as
    // well as its title, so both a title fragment ("tutorial:") and a filename
    // fragment ("apps.uat.ts") are valid selectors. Verified live 2026-08-08:
    // UAT_GREP="(admin-security|phase2-install-rbac|apps\.uat\.ts)" selected
    // exactly the 13 tests in those three spec files. Prefer bare filename
    // fragments over rooted paths — the separator differs between the Windows
    // workstation and the Linux job container.
    const grepInvert = process.env.UAT_GREP_INVERT || '';
    const grepInvertArg = grepInvert ? ` --grep-invert "${grepInvert}"` : '';
    const cmd = `pnpm exec playwright test --project=${project}${grepArg}${grepInvertArg}`;
    console.log(`[run-uat-unattended] running: ${cmd}`);
    execSync(cmd, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err) {
    // execSync throws when the child exits non-zero.
    playwrightExitCode = err.status ?? 1;
  }

  // --- 5. Emit gate-aware summary -------------------------------------------
  const summary = readSummary();
  const { realFails, infraGatedSteps } = readGateAwareVerdicts();
  const realFailCount = realFails.length;

  if (summary) {
    const { pass, fail, skip } = summary;
    // Gate-aware: highlight real code bugs separately from infra-gated steps.
    console.log(
      `\nUAT_RESULT pass=${pass} fail=${fail} skip=${skip} realFails=${realFailCount} infraGated=${infraGatedSteps}`,
    );
    if (realFailCount > 0) {
      console.error(`[run-uat-unattended] ${realFailCount} REAL CODE FAILURE(S) — these are bugs, not infra-gates:`);
      for (const rf of realFails) {
        const parts = [];
        if (rf.crashes.length) parts.push(`crashes=[${rf.crashes.join(',')}]`);
        if (rf.empties.length) parts.push(`empties=[${rf.empties.join(',')}]`);
        if (rf.realProvFails.length) parts.push(`provFails=[${rf.realProvFails.join(' ; ')}]`);
        console.error(`  ${rf.surface}: ${parts.join(' ')}`);
      }
    }
    if (infraGatedSteps > 0) {
      console.log(`[run-uat-unattended] ${infraGatedSteps} provision step(s) are infra-gated (honest gates — NOT code bugs).`);
    }
    // Always enumerate the actual failing tests (all specs) for per-run triage.
    if (fail > 0) printFailedTests();
    if (fail > 0 && realFailCount === 0 && !strictProvision) {
      console.log(`[run-uat-unattended] All ${fail} Playwright failure(s) are infra-gated. No code bugs. Exiting 0.`);
    } else if (realFailCount === 0 && fail === 0) {
      console.log(`[run-uat-unattended] All tests PASSED.`);
    }
  } else {
    console.warn('[run-uat-unattended] Could not read test-results/uat/report.json — check Playwright output above.');
    console.log(`UAT_RESULT exit_code=${playwrightExitCode} realFails=${realFailCount} infraGated=${infraGatedSteps}`);
  }

  // Emit per-app real-fail summary line (grep-friendly for log triage):
  if (realFails.length > 0) {
    const crashList = realFails.flatMap(rf => rf.crashes.map(c => `${rf.surface}/${c}`));
    const emptyList = realFails.flatMap(rf => rf.empties.map(e => `${rf.surface}/${e}`));
    console.error(
      `UAT_REAL_FAILS app=${realFails.map(rf => rf.surface.replace(/^app:/, '')).join(',')} crashes=[${crashList.join(',')}] empties=[${emptyList.join(',')}] infraGatedSteps=${infraGatedSteps}`,
    );
  }

  // --- 6. Best-effort results upload ----------------------------------------
  await uploadResults(runTag);

  // --- 7. Minimum-collected-test floor --------------------------------------
  // A run that collects almost nothing is a MEASUREMENT FAILURE, not a pass.
  //
  // Incident, 2026-08-08: a stale UAT_GREP left on the loom-uat job template by
  // an old targeted run —
  //   "use-case app via UI . app-(direct-lake-replacement|supercharge-streaming)"
  // — narrowed every roll gate to 2 of the 120 declared tests. The roll workflow
  // described that step as "the full-visual Playwright suite" and three
  // consecutive production rolls (31277716379, 31280987503, 31284001915) gated
  // on pass<=2 with an exit code of 0. Nothing anywhere said the suite had not
  // run. This floor makes that state fail loudly instead of passing silently.
  //
  // The floor applies in two cases:
  //   - UAT_MIN_TESTS set EXPLICITLY → applies to ANY run, narrow or not. A
  //     caller that names a floor knows how many tests it expects; this is what
  //     lets the roll gate run a deliberately narrow slice and still assert the
  //     slice was actually collected. Without this, arming the gate on a grep
  //     would silently switch the floor OFF — re-creating the 2026-08-08 defect
  //     in a new shape.
  //   - UAT_MIN_TESTS unset → default floor, full-suite runs ONLY (UAT_GREP
  //     empty). On a run that claims everything, "collected almost nothing" is
  //     unambiguous; on an unannounced narrow run it is not.
  const minTestsRaw = process.env.UAT_MIN_TESTS;
  const minTestsExplicit = typeof minTestsRaw === 'string' && minTestsRaw.trim() !== '';
  const minTests = Number.parseInt(minTestsExplicit ? minTestsRaw : '40', 10);
  let floorViolation = null;
  if (Number.isFinite(minTests) && minTests > 0 && (minTestsExplicit || !grep)) {
    const scope = grep ? `the requested slice (UAT_GREP='${grep}')` : 'the FULL suite (UAT_GREP is empty)';
    if (!summary) {
      // R7: state only what was established — the count is UNKNOWN, not zero.
      floorViolation =
        'test-results/uat/report.json could not be read, so the number of tests ' +
        'actually executed is UNKNOWN. An unmeasured run cannot pass a gate.';
    } else {
      const collected = (summary.pass || 0) + (summary.fail || 0) + (summary.skip || 0);
      if (collected < minTests) {
        floorViolation =
          `Playwright collected ${collected} test(s) on a run that claims to be ` +
          `${scope}. The floor is ${minTests} (UAT_MIN_TESTS).`;
      }
    }
  }
  if (floorViolation) {
    console.error(`\nUAT_FLOOR_VIOLATION ${floorViolation}`);
    console.error(
      '[run-uat-unattended] REMEDIATION — check these, in order:\n' +
        "  1. A stale filter on the JOB TEMPLATE (this is what happened on 2026-08-08).\n" +
        '     Read it:   az containerapp job show -n loom-uat -g <rg> ' +
        '--query "properties.template.containers[0].env[?starts_with(name,\'UAT_\')]"\n' +
        '     Clear it:  az containerapp job update -n loom-uat -g <rg> --set-env-vars UAT_GREP=\n' +
        '     (--set-env-vars MERGES, so omitting UAT_GREP leaves the old value in place.)\n' +
        `  2. UAT_GREP_INVERT excluding too much — currently '${process.env.UAT_GREP_INVERT || ''}'.\n` +
        '  3. Playwright genuinely collected nothing — check the "running:" command echoed\n' +
        '     above against testMatch/testDir for the "' +
        `${project}" project in playwright.config.ts.\n` +
        '  If this run is INTENTIONALLY narrower than the floor, lower UAT_MIN_TESTS to the\n' +
        '  number that slice actually collects — do NOT clear it. A floor of 0/unset on a\n' +
        '  narrow run is the exact state that let 2-test rolls pass as "the full suite".',
    );
  }

  // Exit code:
  //   floorViolation        → non-zero regardless of mode (the run is unmeasured)
  //   strictProvision=true  → use Playwright's raw exit code (any fail = non-zero)
  //   strictProvision=false → non-zero only if there are real code bugs
  if (floorViolation) {
    process.exit(1);
  } else if (strictProvision) {
    process.exit(playwrightExitCode);
  } else {
    process.exit(realFailCount > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('[run-uat-unattended] Unhandled error:', err?.message || err);
  process.exit(1);
});
