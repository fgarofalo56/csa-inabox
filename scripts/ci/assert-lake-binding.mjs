#!/usr/bin/env node
/**
 * assert-lake-binding.mjs — a deploy must never REMOVE the lake wiring from a
 * console that has a lake.
 *
 * ── WHY THIS EXISTS (#3701, deploy-integrity.md R1/R3/R6/R7) ────────────────
 *
 * `modules/admin-plane/main.bicep` does not emit the lake variables as
 * "unset if unknown". It emits them CONDITIONALLY:
 *
 *     !empty(loomStorageAccount) ? [ … 7 vars … ] : []
 *
 * so an empty `loomStorageAccount` does not leave the running Container App
 * alone — it re-renders the env array WITHOUT LOOM_BRONZE_URL, LOOM_SILVER_URL,
 * LOOM_GOLD_URL, LOOM_LANDING_URL, LOOM_CSV_IMPORTS_URL, LOOM_SAMPLE_ADLS and
 * LOOM_RECYCLE_RETENTION_DAYS (and, from the sibling array,
 * LOOM_ORG_VISUALS_URL). Configuration that was live is DELETED, and ARM
 * reports the deployment as succeeded, because from ARM's point of view it did.
 *
 * `main.bicep` composes that string from exactly two sources:
 *
 *     loomStorageAccount = adoptName(adopt,'storage-adls')
 *                       |> or, when useSingleDlz, the saloomdefault<hash> name
 *                       |> or ''
 *
 * and `useSingleDlz` is false for the topology every stock Commercial param
 * file pins (`topology = 'tenant'` ⇒ `deployLandingZones` false). So on this
 * estate the adopt plan is the ONLY source, and an empty plan is a destructive
 * outcome rather than a no-op.
 *
 * MEASURED: runs 31870181337 / 31932209496 / 32004118361 (schedule, 08-15..17)
 * all produced `adopting: (none)` and all concluded SUCCESS, between them
 * deleting what run 31898068403 (dispatch, 08-15) had wired. The nightly was a
 * ratchet with a 24-hour period.
 *
 * ── WHAT THIS ASSERTS, AND WHAT IT DOES NOT (R7) ────────────────────────────
 *
 * It establishes two things independently and compares them:
 *
 *   1. What `loomStorageAccount` WILL compose to, by mirroring main.bicep's
 *      expression against the adopt plan and the topology that will actually
 *      reach ARM.
 *   2. Whether this estate ALREADY HAS a Data Lake Gen2 (HNS) storage account
 *      that Loom owns — read from Azure Resource Graph, in its own query, NOT
 *      by trusting the adopt plan. That independence is the point:
 *      discover-dlz-adopt-plan.sh looks the account up through a helper that
 *      ends `2>/dev/null || true`, so an unreadable storage list there is
 *      indistinguishable from an absent one and yields the same empty plan.
 *      A check that consumed the plan alone would inherit that blindness.
 *
 * It does NOT assert that a lake is absent when the read fails. "Could not
 * determine" is reported as UNKNOWN and REFUSES, because the action it is
 * guarding is destructive and the alternative to refusing is deleting
 * configuration on a guess.
 *
 * GREENFIELD IS UNAFFECTED. An estate with no Loom-owned HNS account produces
 * `binding: none, estate: none` — consistent, allowed, silent. The first deploy
 * of a new estate does not trip this.
 *
 * Usage:
 *   node scripts/ci/assert-lake-binding.mjs \
 *     --adopt-json "$LOOM_ADOPT_JSON" --region <region> \
 *     [--topology <topology>] [--deployment-mode <mode>] \
 *     [--param-file platform/fiab/bicep/params/commercial.bicepparam] \
 *     [--github-output "$GITHUB_OUTPUT"]
 *
 * Exit: 0 consistent | 1 DESTRUCTIVE (would strip the lake env) | 2 usage
 *       3 could not determine the estate.
 *
 * Tests: node --test scripts/ci/__tests__/assert-lake-binding.test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, DESTRUCTIVE: 1, USAGE: 2, UNKNOWN: 3 });

/**
 * Loom-owned Data Lake Gen2 accounts for ONE estate.
 *
 * Scoped to `rg-csa-loom-*` deliberately. A customer's unrelated lake elsewhere
 * in the tenant is not something this deploy ever bound, so flagging it would
 * make brownfield subscriptions unable to deploy — the opposite of R5. Scoped to
 * the estate's REGION for the same reason the rest of this workflow is: the
 * region IS the estate's identity (#3029).
 */
export const HNS_QUERY = [
  'resources',
  "| where type =~ 'microsoft.storage/storageaccounts'",
  '| where properties.isHnsEnabled == true',
  "| where resourceGroup startswith 'rg-csa-loom-'",
  '| project name, resourceGroup, subscriptionId, location',
].join(' ');

/** Mirrors main.bicep: `adoptMode(a,k) == 'adopt' ? (a[?k].?target.?name ?? '') : ''`. */
export function adoptName(plan, key) {
  const entry = plan && typeof plan === 'object' ? plan[key] : null;
  if (!entry || typeof entry !== 'object') return '';
  if ((entry.mode ?? 'create') !== 'adopt') return '';
  return String(entry.target?.name ?? '');
}

/**
 * Mirrors main.bicep:1116-1119.
 *   deployLandingZones = effectiveTopology != 'tenant'
 *   useSingleDlz       = deployLandingZones && effectiveTopology == 'single-sub'
 */
export function useSingleDlz(effectiveTopology) {
  return effectiveTopology !== 'tenant' && effectiveTopology === 'single-sub';
}

/**
 * `effectiveTopology = empty(topology) ? deploymentMode : topology`, where an
 * EMPTY workflow topology means the param file's value stands — the compose step
 * only appends `--parameters topology=…` when CSA_LOOM_TOPOLOGY is non-empty.
 */
export function effectiveTopology({ topology, paramTopology, deploymentMode, paramDeploymentMode }) {
  const t = String(topology || '') || String(paramTopology || '');
  if (t) return t;
  return String(deploymentMode || '') || String(paramDeploymentMode || '');
}

/** `param topology = 'tenant'` → `tenant`. Null when the file does not say. */
export function paramValue(paramFileText, name) {
  const m = new RegExp(`^\\s*param\\s+${name}\\s*=\\s*'([^']*)'`, 'm').exec(paramFileText || '');
  return m ? m[1] : null;
}

/**
 * What `loomStorageAccount` composes to.
 *
 * The single-DLZ branch is `take('saloomdefault${uniqueString(singleDlzRg.id)}',24)`
 * — a value only ARM can evaluate. It cannot be computed here, but what matters
 * is that it is NON-EMPTY, so the binding is reported as present with an unknown
 * literal rather than guessed.
 */
export function composeLakeBinding({ adoptPlan, topology }) {
  const adopted = adoptName(adoptPlan, 'storage-adls');
  if (adopted) return { bound: true, name: adopted, source: 'adopt-plan' };
  if (useSingleDlz(topology)) return { bound: true, name: null, source: 'single-dlz-convention' };
  return { bound: false, name: '', source: 'none' };
}

/**
 * The verdict. Pure, so it is testable without Azure.
 *
 * @param {{bound:boolean,source:string,name:string|null}} binding
 * @param {{status:'present'|'absent'|'unknown', accounts?:string[], reason?:string}} estate
 */
export function verdict(binding, estate) {
  if (estate.status === 'unknown') {
    return {
      code: EXIT.UNKNOWN,
      ok: false,
      message:
        'Could NOT determine whether this estate has a Loom-owned Data Lake Gen2 account: ' +
        `${estate.reason || 'no reason given'}. That is UNKNOWN, not "no lake". This deploy re-renders ` +
        'the console env array, and doing so with an unverified empty lake binding would DELETE ' +
        'LOOM_BRONZE_URL/SILVER/GOLD/LANDING/CSV_IMPORTS/SAMPLE_ADLS/RECYCLE_RETENTION_DAYS from the ' +
        'running app. Refusing rather than guessing (#3701).',
    };
  }
  if (binding.bound) {
    return {
      code: EXIT.OK,
      ok: true,
      message:
        `loomStorageAccount will compose to ${binding.name ? `'${binding.name}'` : 'the single-DLZ convention name'} ` +
        `(source: ${binding.source}). The lake env vars will be emitted.`,
    };
  }
  if (estate.status === 'absent') {
    return {
      code: EXIT.OK,
      ok: true,
      message:
        'loomStorageAccount composes EMPTY and this estate owns no Loom Data Lake Gen2 account. ' +
        'Consistent — this is the greenfield answer, and nothing is being removed.',
    };
  }
  return {
    code: EXIT.DESTRUCTIVE,
    ok: false,
    message:
      `DESTRUCTIVE: loomStorageAccount composes to '' (no 'storage-adls' in the adopt plan, and the ` +
      'topology does not take the single-DLZ branch) while this estate DOES own a Loom Data Lake Gen2 ' +
      `account: ${(estate.accounts || []).join(', ')}. ` +
      'Because modules/admin-plane/main.bicep emits the lake variables as `!empty(loomStorageAccount) ? [ … ] : []`, ' +
      'applying this would REMOVE LOOM_BRONZE_URL, LOOM_SILVER_URL, LOOM_GOLD_URL, LOOM_LANDING_URL, ' +
      'LOOM_CSV_IMPORTS_URL, LOOM_SAMPLE_ADLS and LOOM_RECYCLE_RETENTION_DAYS from the running console ' +
      '(plus LOOM_ORG_VISUALS_URL), and report success. Refusing. ' +
      'Fix the adopt step: the DLZ resolver must find this account and emit it as `storage-adls` (#3701).',
  };
}

// ── Embedded controls ───────────────────────────────────────────────────────
// A guard whose population can legitimately be zero needs a control that proves
// it can still say NO (guard_with_zero_population_needs_embedded_control). These
// run before any live read; a disagreement aborts before a verdict is issued.
const FIXTURES = [
  {
    name: 'the #3701 nightly: empty plan, tenant topology, estate HAS a lake -> DESTRUCTIVE',
    plan: {}, topology: 'tenant',
    estate: { status: 'present', accounts: ['saloomdefaulttr4nm4dcgsq'] },
    expect: EXIT.DESTRUCTIVE,
  },
  {
    name: 'the 08-15 dispatch: plan adopts the lake -> OK',
    plan: { 'storage-adls': { mode: 'adopt', target: { name: 'saloomdefaulttr4nm4dcgsq', rg: 'rg-csa-loom-dlz-default-centralus', sub: 'SUB-B' } } },
    topology: 'tenant', estate: { status: 'present', accounts: ['saloomdefaulttr4nm4dcgsq'] },
    expect: EXIT.OK,
  },
  {
    name: 'greenfield: empty plan, tenant topology, NO lake in the estate -> OK',
    plan: {}, topology: 'tenant', estate: { status: 'absent', accounts: [] },
    expect: EXIT.OK,
  },
  {
    name: 'single-sub takes the convention branch, so an empty plan still binds -> OK',
    plan: {}, topology: 'single-sub', estate: { status: 'present', accounts: ['saloomdefaultabc'] },
    expect: EXIT.OK,
  },
  {
    name: 'dlz-attach does NOT take the convention branch -> DESTRUCTIVE when a lake exists',
    plan: {}, topology: 'dlz-attach', estate: { status: 'present', accounts: ['saloomdefaultabc'] },
    expect: EXIT.DESTRUCTIVE,
  },
  {
    name: "mode=create is not an adoption, so it does not bind -> DESTRUCTIVE",
    plan: { 'storage-adls': { mode: 'create', target: { name: 'sa' } } }, topology: 'tenant',
    estate: { status: 'present', accounts: ['sa'] }, expect: EXIT.DESTRUCTIVE,
  },
  {
    name: 'a plan adopting OTHER services but not the lake does not bind -> DESTRUCTIVE',
    plan: { synapse: { mode: 'adopt', target: { name: 'syn' } } }, topology: 'tenant',
    estate: { status: 'present', accounts: ['sa'] }, expect: EXIT.DESTRUCTIVE,
  },
  {
    name: 'an unreadable estate is UNKNOWN, never "no lake"',
    plan: {}, topology: 'tenant', estate: { status: 'unknown', reason: 'graph query exited 1' },
    expect: EXIT.UNKNOWN,
  },
];

export function verifyControls() {
  const failures = [];
  for (const f of FIXTURES) {
    const got = verdict(composeLakeBinding({ adoptPlan: f.plan, topology: f.topology }), f.estate).code;
    if (got !== f.expect) failures.push(`${f.name}: expected exit ${f.expect}, got ${got}`);
  }
  return { total: FIXTURES.length, failures };
}

// ── Live measurement ────────────────────────────────────────────────────────

function azBinary() {
  return process.env.AZ_BIN || (process.platform === 'win32' ? 'az.cmd' : 'az');
}

/** Same @file argument-loading dance as resolve-dlz-coordinates.mjs: a KQL `|` is a shell pipe on Windows. */
export function azGraphRunner(query) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lake-assert-'));
  const qf = path.join(dir, 'query.kql');
  fs.writeFileSync(qf, query, 'utf8');
  const bin = azBinary();
  try {
    const res = spawnSync(bin, ['graph', 'query', '-q', `@${qf}`, '--first', '1000', '-o', 'json'], {
      encoding: 'utf8', shell: /\.(cmd|bat)$/i.test(bin), stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) return { status: 127, stdout: '', stderr: res.error.message };
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** stderr is kept and reported — never merged into the value, never discarded. */
export function readEstateLakes(region, run = azGraphRunner) {
  const res = run(HNS_QUERY);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
    return { status: 'unknown', reason: `az graph query exited ${res.status}: ${detail || '<no output>'}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || 'null');
  } catch (e) {
    return { status: 'unknown', reason: `az graph query returned output that is not JSON: ${e.message}` };
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(rows)) {
    return { status: 'unknown', reason: 'az graph query returned no `data` array; nothing is asserted about the estate.' };
  }
  const here = rows.filter((r) => !region || String(r.location || '').toLowerCase() === String(region).toLowerCase());
  return here.length
    ? { status: 'present', accounts: here.map((r) => r.name).sort() }
    : { status: 'absent', accounts: [] };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
  };

  const controls = verifyControls();
  if (controls.failures.length) {
    console.error('[assert-lake-binding] REFUSING: its own controls failed, so no verdict it produced could be trusted:');
    for (const f of controls.failures) console.error(`  - ${f}`);
    process.exit(EXIT.UNKNOWN);
  }

  const region = arg('--region');
  if (!region) {
    console.error('[assert-lake-binding] --region is required. The region is the estate’s identity; without it this would measure a different estate.');
    process.exit(EXIT.USAGE);
  }

  let adoptPlan;
  try {
    adoptPlan = JSON.parse(arg('--adopt-json') || '{}');
  } catch (e) {
    console.error(`[assert-lake-binding] --adopt-json is not valid JSON: ${e.message}. That is a defect in the adopt step, not a verdict about the estate.`);
    process.exit(EXIT.USAGE);
  }

  let paramTopology = null;
  let paramDeploymentMode = null;
  const paramFile = arg('--param-file');
  if (paramFile) {
    let text;
    try {
      text = readFileSync(paramFile, 'utf8');
    } catch (e) {
      console.error(`[assert-lake-binding] could not read --param-file ${paramFile}: ${e.message}. The topology that will reach ARM is therefore unknown.`);
      process.exit(EXIT.UNKNOWN);
    }
    paramTopology = paramValue(text, 'topology');
    paramDeploymentMode = paramValue(text, 'deploymentMode');
    if (!paramTopology && !paramDeploymentMode) {
      console.error(`[assert-lake-binding] DISCOVERY FLOOR: parsed neither \`param topology\` nor \`param deploymentMode\` out of ${paramFile}. The parser stopped matching, so the topology below would be a guess.`);
      process.exit(EXIT.UNKNOWN);
    }
  }

  const topology = effectiveTopology({
    topology: arg('--topology'),
    paramTopology,
    deploymentMode: arg('--deployment-mode'),
    paramDeploymentMode,
  });
  if (!topology) {
    console.error('[assert-lake-binding] could not establish the effective topology from --topology, --deployment-mode or --param-file. Refusing rather than assuming one.');
    process.exit(EXIT.UNKNOWN);
  }

  const binding = composeLakeBinding({ adoptPlan, topology });
  const estate = readEstateLakes(region);
  const v = verdict(binding, estate);

  console.log(`[assert-lake-binding] controls: ${controls.total}/${controls.total} passed`);
  console.log(`[assert-lake-binding] topology=${topology} useSingleDlz=${useSingleDlz(topology)} binding=${binding.source} estate=${estate.status}`);

  const out = arg('--github-output');
  if (out) {
    fs.appendFileSync(out, `lake_bound=${binding.bound}\nlake_estate=${estate.status}\n`, 'utf8');
  }

  if (v.ok) {
    console.log(`[assert-lake-binding] ${v.message}`);
    process.exit(EXIT.OK);
  }
  console.error(`::error::[assert-lake-binding] ${v.message}`);
  process.exit(v.code);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
