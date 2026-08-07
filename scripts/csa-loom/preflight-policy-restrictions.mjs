#!/usr/bin/env node
/**
 * preflight-policy-restrictions.mjs — discover Azure Policy restrictions the
 * deploy is subject to BEFORE submitting it (deploy-integrity.md R5).
 *
 * WHY (run 31100384405, 2026-08-06 — the D5 leaf)
 *
 *   The 'catalog' nested deployment was rejected at Purview RP preflight
 *   (error 21010 → RequestDisallowedByPolicy): the management-group assignment
 *   MCAPSGovDeployPolicies (definition StorageAccount_PublicNetwork_Modify)
 *   requires Microsoft.Storage/storageAccounts/publicNetworkAccess=Disabled,
 *   and the RP simulated its MANAGED storage account as publicly reachable.
 *   The template now complies by default (catalog.bicep
 *   purviewManagedResourcesPublicNetworkAccess=Disabled), but the POLICY was
 *   invisible until a 20-minute deploy died on it. R5 says the platform
 *   DISCOVERS what governs the estate and says so up front.
 *
 * WHAT IT DOES
 *
 *   Calls the Azure Policy `checkPolicyRestrictions` API (Microsoft.
 *   PolicyInsights, the same engine ARM preflight consults) with a synthetic
 *   storage-account resource and asks which restrictions apply to the fields
 *   Loom's deploy is known to be policy-sensitive on. For each restriction it
 *   prints the required values and the EXACT policy assignment id, and — where
 *   the template already carries a compliance default — says so, so the
 *   operator knows the deploy is expected to pass.
 *
 * WHAT IT IS NOT (disclosed, deliberate — and MEASURED)
 *
 *   This is R5 DISCOVERY, not a gate. The enforcing control is ARM/RP
 *   preflight at deploy time, which cannot be bypassed; failing the run here
 *   on a restriction the template complies with would block deploys that
 *   would succeed. It therefore never fails a run for a DISCOVERED policy —
 *   it names it. In --advisory mode an UNREADABLE policy engine also does not
 *   fail the run, but it is reported in exactly those words ("policy posture
 *   is UNKNOWN"), never as "no restrictions" (R7). Without --advisory an
 *   unreadable engine exits 3.
 *
 *   AN EMPTY ANSWER IS NOT "NO POLICIES" — measured on the live Commercial
 *   estate 2026-08-06: this probe (RG scope, explicit publicNetworkAccess
 *   candidates) returned ZERO field restrictions from the caller's context,
 *   while the Purview RP's OWN restriction check in the same subscription was
 *   denied by the MG-scoped MCAPSGovDeployPolicies assignment. Management-
 *   group assignments outside the caller's read scope, and RP-internal checks
 *   over MANAGED resources (Purview error 21010), are invisible to this
 *   probe. The renderer says so on every empty answer. The AUTHORITATIVE
 *   policy check for the deploy remains `az deployment sub what-if` /
 *   `validate`, which runs the real RP preflight — proven by the D5 A/B
 *   receipt (catalog module validate: NotSpecified => RequestDisallowedByPolicy,
 *   Disabled => Succeeded).
 *
 * USAGE
 *   node scripts/csa-loom/preflight-policy-restrictions.mjs \
 *     --subscription <id> --location <region> \
 *     [--resource-group <rg>] [--advisory] [--json]
 *
 *   Exit: 0 read-and-reported (or --advisory unreadable) | 2 usage | 3 unreadable.
 *
 * Tests: node --test scripts/csa-loom/__tests__/preflight-policy-restrictions.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, UNREADABLE: 3 });

export const API_VERSION = '2023-03-01';

/**
 * Fields the Loom deploy is KNOWN to be policy-sensitive on, with the
 * compliance default the template already carries (named so the report can say
 * "Loom complies" rather than leaving the operator to work it out). Extend
 * this list when a new RequestDisallowedByPolicy leaf is observed — the
 * taxonomy signal config.disallowed-by-policy points here.
 */
export const KNOWN_COMPLIANCE = {
  'microsoft.storage/storageaccounts/publicnetworkaccess': {
    requiredValue: 'Disabled',
    compliedBy:
      'catalog.bicep purviewManagedResourcesPublicNetworkAccess=Disabled (Purview managed storage; the D5 fix for run 31100384405); direct Loom storage accounts are sealed by the platform Modify policy and reached over private endpoints (#2958).',
  },
};

/** The synthetic resource the restriction check is evaluated against. */
export function probeBody(location) {
  return {
    resourceDetails: {
      resourceContent: {
        type: 'Microsoft.Storage/storageAccounts',
        name: 'loompolicyprobe',
        location,
        sku: { name: 'Standard_LRS' },
        kind: 'StorageV2',
        properties: {},
      },
      apiVersion: '2023-05-01',
    },
    // Candidate VALUES, not just the field name: the engine evaluates which of
    // the candidates a deny-effect policy would refuse, which a bare field
    // probe does not always surface.
    pendingFields: [
      { field: 'Microsoft.Storage/storageAccounts/publicNetworkAccess', values: ['Enabled', 'Disabled'] },
    ],
  };
}

/** Real `az rest`, stderr captured (R7). Body via a temp file — no shell quoting. */
export function azRunner(args) {
  const bin = process.env.LOOM_AZ_BIN ?? (process.platform === 'win32' ? 'az.cmd' : 'az');
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: /\.(cmd|bat)$/i.test(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) return { status: 127, stdout: '', stderr: `${res.error.message}` };
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const lower = (s) => String(s ?? '').toLowerCase();

/** Last path segment of an ARM id — enough to NAME an assignment without printing the full id. */
export const idTail = (id) => String(id ?? '').split('/').filter(Boolean).slice(-1)[0] ?? '<unknown>';

/**
 * Turn a checkPolicyRestrictions response into findings.
 * @returns {Array<{field:string, result:string, values:string[], assignment:string, definition:string, compliedBy:string|null}>}
 */
export function evaluateRestrictions(response) {
  const out = [];
  for (const fr of response?.fieldRestrictions ?? []) {
    const field = fr?.field ?? '<unknown field>';
    for (const r of fr?.restrictions ?? []) {
      const known = KNOWN_COMPLIANCE[lower(field)];
      const values = Array.isArray(r?.values) ? r.values : [];
      const complies =
        known && lower(r?.result) === 'required' && values.length === 1 && lower(values[0]) === lower(known.requiredValue);
      out.push({
        field,
        result: r?.result ?? '<unknown>',
        values,
        assignment: idTail(r?.policy?.policyAssignmentId),
        definition: idTail(r?.policy?.policyDefinitionId),
        compliedBy: complies ? known.compliedBy : null,
      });
    }
  }
  return out;
}

/**
 * Run the check. Pure given `run`.
 * @returns {{status:'ok'|'unreadable', scope:string, findings:Array, reason:string|null}}
 */
export function check({ subscription, location, resourceGroup = null, run = azRunner, writeBody = null }) {
  const body = probeBody(location);
  const bodyPath =
    writeBody ??
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-policy-probe-')), 'body.json');
  fs.writeFileSync(bodyPath, JSON.stringify(body), 'utf8');

  const scopes = [];
  if (resourceGroup) scopes.push(`/subscriptions/${subscription}/resourceGroups/${resourceGroup}`);
  scopes.push(`/subscriptions/${subscription}`);

  const attempts = [];
  for (const scope of scopes) {
    const url = `${scope}/providers/Microsoft.PolicyInsights/checkPolicyRestrictions?api-version=${API_VERSION}`;
    const res = run(['rest', '--method', 'post', '--url', url, '--body', `@${bodyPath}`, '-o', 'json']);
    if (res.status === 0) {
      let parsed;
      try {
        parsed = JSON.parse(res.stdout || 'null');
      } catch {
        attempts.push(`${scope}: az answered but the response was not JSON`);
        continue;
      }
      return { status: 'ok', scope, findings: evaluateRestrictions(parsed), reason: null };
    }
    attempts.push(
      `${scope}: az exit ${res.status}: ${(res.stderr || 'no output').trim().split(/\r?\n/)[0]}`,
    );
    // An RG that does not exist yet (greenfield) legitimately falls through to
    // the subscription scope; every other failure is also retried at the wider
    // scope — the ATTEMPT LIST keeps each failure attributed either way.
  }
  return {
    status: 'unreadable',
    scope: '',
    findings: [],
    reason:
      `the policy engine could not be read at any scope, so the policy posture is UNKNOWN — ` +
      `nothing is asserted about what will or will not be allowed. ${attempts.join(' | ')}`,
  };
}

export function renderFindings(result) {
  if (result.status !== 'ok') {
    return `policy-restrictions: UNREADABLE — ${result.reason}`;
  }
  if (result.findings.length === 0) {
    return (
      `policy-restrictions: the policy engine answered at ${result.scope} and reported no field restrictions ` +
      `for the probed fields FROM THIS CALLER'S CONTEXT. That is NOT "no policies": management-group ` +
      `assignments outside this caller's read scope and RP-internal restriction checks over managed ` +
      `resources (e.g. Purview error 21010) are invisible to this probe — the authoritative check is the ` +
      `what-if/validate RP preflight that runs next.`
    );
  }
  const lines = [`policy-restrictions: ${result.findings.length} restriction(s) reported at ${result.scope}:`];
  for (const f of result.findings) {
    const req = f.values.length ? ` => ${f.result} [${f.values.join(', ')}]` : ` => ${f.result}`;
    lines.push(`  ${f.field}${req}  (assignment: ${f.assignment}, definition: ${f.definition})`);
    lines.push(
      f.compliedBy
        ? `    Loom COMPLIES by default: ${f.compliedBy}`
        : `    NO compliance default is declared for this restriction in KNOWN_COMPLIANCE — if the deploy fails RequestDisallowedByPolicy on this field, this assignment is the cause (quote it to the policy owner).`,
    );
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { subscription: null, location: null, resourceGroup: null, advisory: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--subscription') out.subscription = argv[++i];
    else if (a === '--location') out.location = argv[++i];
    else if (a === '--resource-group' || a === '-g') out.resourceGroup = argv[++i];
    else if (a === '--advisory') out.advisory = true;
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`preflight-policy-restrictions: ${e.message}\n`);
    process.exit(EXIT.USAGE);
  }
  if (!args.subscription || !args.location) {
    process.stderr.write('preflight-policy-restrictions: --subscription and --location are required.\n');
    process.exit(EXIT.USAGE);
  }

  const r = check(args);
  process.stdout.write(args.json ? `${JSON.stringify(r, null, 2)}\n` : `${renderFindings(r)}\n`);
  if (r.status !== 'ok') {
    if (args.advisory) {
      // Loud, honest, non-blocking: UNKNOWN is stated as unknown (R7), and the
      // enforcing control (ARM preflight) still stands at deploy time.
      process.stdout.write(`::warning::${renderFindings(r)}\n`);
      process.exit(EXIT.OK);
    }
    process.exit(EXIT.UNREADABLE);
  }
  process.exit(EXIT.OK);
}
