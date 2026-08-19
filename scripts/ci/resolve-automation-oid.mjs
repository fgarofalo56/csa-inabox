#!/usr/bin/env node
/**
 * resolve-automation-oid.mjs — PRODUCE the automation identity instead of
 * asking a human to type it (#3373).
 *
 * WHY THIS EXISTS
 * ---------------
 * Six workflows mint a `loom_session` cookie and drive the console with it.
 * Every one of them read `vars.LOOM_AUTOMATION_OID` and had NO fallback:
 *
 *   csa-loom-exercise-services.yml   loom-parity-autopilot.yml
 *   deploy-loom-uat.yml              loom-ui-verify.yml
 *   deploy-loom-verify.yml           gov-bff-verify.yml
 *
 * `gh variable set` / the `actions/variables` API appear NOWHERE in this repo,
 * so no automation could ever produce that variable. The entire verification
 * lane — the thing that produces the browser-E2E receipts `ux-baseline.md` G1
 * demands — was gated on a value a human had to type by hand into repo
 * settings. That is `auto-bind-by-default.md` §5 verbatim: "'Set LOOM_X' as the
 * terminal user-facing state is a violation — the value must be produced by the
 * deploy."
 *
 * WHAT THE VALUE ACTUALLY IS (measured, not assumed)
 * --------------------------------------------------
 * The minted cookie carries `claims = { oid, name, upn, email }` and NO
 * `groups` array (scripts/csa-loom/loom-verify.js, gov-bff-verify.yml's inline
 * minter, perf-gate.yml's, e2e-receipt.mjs's — all four). The console decides
 * tenant-admin in apps/fiab-console/lib/auth/feature-gate.ts:
 *
 *     if (adminGroups.length && session.claims.groups?.some(...)) return true;
 *     if (bootstrapOid && session.claims.oid === bootstrapOid) return true;
 *
 * A minted session has no `groups`, so the group arm can never fire for
 * automation (and per #3175 the `groups` claim is never populated for real
 * sign-ins either). The ONLY arm that can pass is exact equality against
 * `process.env.LOOM_TENANT_ADMIN_OID` on the loom-console container app.
 *
 * So `LOOM_AUTOMATION_OID` is not a free-form identity at all — it is, by
 * definition, whatever `LOOM_TENANT_ADMIN_OID` the console is running with.
 * That value IS produced by the deploy: deploy-fiab-commercial.yml passes
 * `--parameters loomTenantAdminOid=<FIAB_TENANT_ADMIN_OID>` →
 * platform/fiab/bicep/main.bicep `loomTenantAdminOid` →
 * modules/admin-plane/main.bicep `effectiveTenantAdminOid` →
 * `{ name: 'LOOM_TENANT_ADMIN_OID', value: … }` on the app.
 *
 * Confirmed on the LIVE Commercial estate 2026-08-13: the console's
 * `LOOM_TENANT_ADMIN_OID` is byte-identical to `vars.LOOM_AUTOMATION_OID` and
 * to `vars.FIAB_TENANT_ADMIN_OID`. Three hand-maintained copies of one value,
 * any of which could drift. This script collapses them to one READ of the
 * producer.
 *
 * WHAT THIS DOES NOT DO, AND WHY (deploy-integrity.md R7)
 * -------------------------------------------------------
 * It does NOT fall back to the workflow's own authenticated identity. The
 * deploy service principal's object id is a plausible-looking GUID that matches
 * NOBODY — it is exactly the dead binding #3109 was filed for. Substituting it
 * here would turn a loud refusal into a silent 403 on every admin-gated probe.
 * The refusal is kept for the genuinely unresolvable case, and its message says
 * only what was established:
 *
 *   - the app was read and the variable is EMPTY   -> the DEPLOY did not bind
 *     it; the remediation names the deploy, not the operator's repo settings.
 *   - the app was read and it is a secretRef       -> stated as such; this tool
 *     does not read secrets.
 *   - the read DID NOT COMPLETE (denied/transient) -> reported as unknown. It
 *     never claims the value is missing on the strength of a failed read.
 *
 * CLOUD PARITY (cloud-parity.md)
 * ------------------------------
 * Nothing here is boundary-specific: `az containerapp show` follows whatever
 * cloud `az cloud set` selected, and no endpoint, suffix or tenant is
 * hard-coded. It runs unmodified in Commercial, GCC, GCC-High, IL5 and DoD.
 * It also FIXES a cloud-parity defect by construction: a single repo-wide
 * `LOOM_AUTOMATION_OID` cannot be a tenant admin in two different tenants, yet
 * gov-bff-verify.yml read that same Commercial variable while probing the Gov
 * console. Each boundary now derives its OWN console's binding.
 *
 * USAGE (CI)
 *   CONSOLE_RG=rg-… [CONSOLE_APP=loom-console] [CONSOLE_SUBSCRIPTION=…] \
 *   [EXPLICIT_OID=…] [CARRIED_OID=…] node scripts/ci/resolve-automation-oid.mjs
 *
 * Writes `LOOM_AUTOMATION_OID` to $GITHUB_ENV (masked) and `oid_source` to
 * $GITHUB_OUTPUT. Exits 1 — loudly, with a concrete remediation — when it
 * cannot establish a value.
 *
 * Tests: node --test scripts/ci/__tests__/resolve-automation-oid.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { redact } from './_azure-redact.mjs';

/** An Entra object id is a single GUID. Anything else is not one. */
export const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A placeholder/sentinel object id — all-zero except the final nibble. These are
 * GUID-SHAPED, so GUID_RE alone admits them; that is precisely how they reached
 * production (#3804). They name no Entra object, and a session minted under one
 * writes into a Cosmos partition no principal can sign in and enumerate (#3801).
 */
export const PLACEHOLDER_OID_RE = /^0{8}-0{4}-0{4}-0{4}-0{11}[0-9a-f]$/i;

/** The env var on the console that IS the tenant-admin binding. */
export const BINDING_VAR = 'LOOM_TENANT_ADMIN_OID';

/** Show enough of an object id to correlate two of them without printing either. */
export const idHint = (id) => (id && id.length > 8 ? `${id.slice(0, 8)}…` : String(id ?? ''));

/**
 * Why a candidate cannot be used. Returned as a REASON, never as a silent drop:
 * every rejection below produced an identical symptom in production — a session
 * that mints fine and 403s on every admin route.
 */
export function validateCandidate(raw) {
  const v = String(raw ?? '').replace(/\r/g, '').trim();
  if (!v) return { ok: false, code: 'empty', why: 'no value' };
  if (v.includes(',')) {
    return {
      ok: false,
      code: 'comma-list',
      why: `it is a comma-separated list. feature-gate.ts compares session.claims.oid === ${BINDING_VAR} with strict equality, so "a,b" matches neither a nor b`,
    };
  }
  if (!GUID_RE.test(v)) {
    return { ok: false, code: 'not-a-guid', why: 'it is not a GUID, so it names no Entra object' };
  }
  if (PLACEHOLDER_OID_RE.test(v)) {
    return {
      ok: false,
      code: 'placeholder',
      why:
        `it is a placeholder object id (${v}). It is GUID-shaped but names no Entra object, so ` +
        `isTenantAdmin() can never admit it — and every write the minted session makes lands in a ` +
        `Cosmos partition no principal can sign in and enumerate, which is how 24 workspaces went ` +
        `invisible for five weeks (#3801/#3804)`,
    };
  }
  return { ok: true, value: v };
}

/**
 * stderr markers, kept identical in spirit to bootstrap-admin-principal.mjs so
 * the two tools classify an Azure failure the same way. Drift between twin
 * classifiers is `csa_loom_guard_adoption_gap` in miniature.
 */
const TRANSIENT = /\b(429|500|502|503|504)\b|too many requests|timed? ?out|temporarily unavailable|connection (reset|aborted)|ServiceUnavailable/i;
const NOT_FOUND = /ResourceNotFound|could not be found|was not found|\b404\b|Not Found/i;
const DENIED = /AuthorizationFailed|Authorization_RequestDenied|Insufficient privileges|does not have authorization|\b40[13]\b|Forbidden|Unauthorized|AADSTS/i;

/**
 * Classify an `az` failure into one of the four things it can mean. `unknown`
 * is deliberately a distinct outcome from `notfound`: reporting a failed read
 * as "the resource is absent" is the R7 violation this repo keeps paying for.
 */
export function classifyAzFailure(stderr) {
  const s = String(stderr || '');
  if (TRANSIENT.test(s)) return 'transient';
  if (DENIED.test(s)) return 'denied';
  if (NOT_FOUND.test(s)) return 'notfound';
  return 'unknown';
}

/**
 * Pick the value, in priority order, and say WHY. Pure — every az read is done
 * by the caller and handed in, so precedence is unit-testable without Azure.
 *
 * @param {object} a
 * @param {string} [a.explicit]  vars.LOOM_AUTOMATION_OID / a dispatch input.
 * @param {object} a.derived     { status, value?, detail? } from the console read.
 * @param {string} [a.carried]   value already on a live ACA job (deploy-loom-* only).
 * @returns {{ok:boolean, oid?:string, source?:string, warnings:string[], error?:string}}
 */
export function decide({ explicit, derived, carried } = {}) {
  const warnings = [];
  const d = derived || { status: 'not-attempted' };
  const derivedOk = d.status === 'resolved' ? validateCandidate(d.value) : { ok: false, code: d.status };

  // 1. EXPLICIT OVERRIDE. #3373 asks for the repo var to be retained as an
  //    override, so it wins — but a silent disagreement with the producer is
  //    the drift that made three copies of this value dangerous, so it is
  //    surfaced rather than swallowed.
  if (explicit != null && String(explicit).trim() !== '') {
    const v = validateCandidate(explicit);
    if (!v.ok) {
      return {
        ok: false,
        warnings,
        error:
          `LOOM_AUTOMATION_OID was supplied explicitly but is unusable: ${v.why}. ` +
          `Correct or REMOVE the LOOM_AUTOMATION_OID repo variable — with it removed this ` +
          `workflow derives the value from the console's ${BINDING_VAR} and needs no variable at all.`,
      };
    }
    if (derivedOk.ok && derivedOk.value.toLowerCase() !== v.value.toLowerCase()) {
      warnings.push(
        `The explicit LOOM_AUTOMATION_OID (${idHint(v.value)}) DISAGREES with the console's ` +
          `${BINDING_VAR} (${idHint(derivedOk.value)}). The override is being honoured, but a ` +
          `minted session only passes isTenantAdmin() on exact equality with the console's value, ` +
          `so admin-gated probes will 403. Delete the LOOM_AUTOMATION_OID repo variable to track ` +
          `the deploy automatically.`,
      );
    }
    return { ok: true, oid: v.value, source: 'explicit-override', warnings };
  }

  // 2. DERIVED FROM THE PRODUCER — the intended path.
  if (derivedOk.ok) {
    return { ok: true, oid: derivedOk.value, source: `derived:${BINDING_VAR}`, warnings };
  }

  // 3. CARRY FORWARD from a live job. Last resort, and announced as such: it is
  //    whatever a PREVIOUS deploy wrote, which is exactly the stale-binding case
  //    if the console has been rebound since.
  if (carried != null && String(carried).trim() !== '') {
    const v = validateCandidate(carried);
    if (v.ok) {
      warnings.push(
        `Could not derive ${BINDING_VAR} from the console (${describeDerived(d)}). Carrying the ` +
          `value already on the live job forward so a working job is not stripped. This value is ` +
          `NOT verified against the console's current binding and may be stale.`,
      );
      return { ok: true, oid: v.value, source: 'carried-forward:live-job', warnings };
    }
    warnings.push(`The value on the live job is unusable (${v.why}); ignoring it.`);
  }

  return { ok: false, warnings, error: refusal(d) };
}

/** One sentence naming what the derivation actually established. */
export function describeDerived(d) {
  switch (d.status) {
    case 'resolved':
      return `${BINDING_VAR} was read but is unusable`;
    case 'empty':
      return `the console app was read and ${BINDING_VAR} is EMPTY`;
    case 'absent':
      return `the console app was read and carries no ${BINDING_VAR} at all`;
    case 'secretref':
      return `${BINDING_VAR} is wired as a secretRef, and this tool does not read secrets`;
    case 'app-not-found':
      return 'the console container app was not found';
    case 'ambiguous':
      return `the console app name matched ${d.detail ?? 'more than one'} resource groups`;
    case 'denied':
      return 'the read was REFUSED (authorization) — the value is unknown, not absent';
    case 'transient':
      return 'the read failed transiently after retries — the value is unknown, not absent';
    case 'unknown':
      return 'the read did not complete and the failure could not be classified — the value is unknown, not absent';
    case 'no-target':
      return 'no console app/resource group was supplied, so no read was attempted';
    default:
      return 'the derivation was not attempted';
  }
}

/**
 * The refusal. R6: it classifies, and hands back the concrete remediation for
 * THAT class. R7: for every "we could not read it" class it says the value is
 * unknown and never asserts the binding is missing.
 */
export function refusal(d) {
  const head = `LOOM_AUTOMATION_OID could not be resolved — ${describeDerived(d)}.`;
  const context =
    `It is the object id the minted loom_session asserts. A minted session carries no 'groups' ` +
    `claim, so apps/fiab-console/lib/auth/feature-gate.ts can only admit it via ` +
    `session.claims.oid === ${BINDING_VAR} on the loom-console container app. This workflow will ` +
    `not guess an identity: the deploy SP's own object id is a GUID that matches nobody (#3109).`;

  let fix;
  switch (d.status) {
    case 'resolved':
      // The read COMPLETED; the value is what is wrong. Saying "the read did not
      // complete" here (the old default branch) asserts a cause this run never
      // established — deploy-integrity R7.
      fix =
        `The console WAS read successfully and ${BINDING_VAR} came back as a value this workflow ` +
        `will not mint under: ${validateCandidate(d.value).why ?? 'it is unusable'}. Re-deploy with ` +
        `a real Entra object id — FIAB_TENANT_ADMIN_OID repo variable, or dispatch ` +
        `deploy-fiab-commercial.yml with tenant_admin_oid=<a HUMAN user's object id>.`;
      break;
    case 'empty':
    case 'absent':
      fix =
        `FIX THE DEPLOY, not this workflow. The console has no tenant-admin OID bound, so no minted ` +
        `session — and no human — can pass a requireTenantAdmin route on this estate. Set the ` +
        `FIAB_TENANT_ADMIN_OID repo variable (or dispatch deploy-fiab-commercial.yml with ` +
        `tenant_admin_oid=<a HUMAN user's object id>) and re-run the deploy; it flows through ` +
        `main.bicep loomTenantAdminOid -> admin-plane effectiveTenantAdminOid -> ${BINDING_VAR}. ` +
        `Binding only LOOM_TENANT_ADMIN_GROUP_ID will NOT fix this: the group arm needs a 'groups' ` +
        `claim that a minted session never carries (and that no session carries today, #3175).`;
      break;
    case 'secretref':
      fix =
        `${BINDING_VAR} must be a plain value on the container app — the bicep sets it as one ` +
        `(modules/admin-plane/main.bicep). An object id is an identifier, not a credential; ` +
        `re-deploy so it is written as a value rather than a secret reference.`;
      break;
    case 'app-not-found':
      fix =
        `Point this run at the right estate: pass admin_rg / set the LOOM_ADMIN_RG repo variable, ` +
        `and confirm the azure/login subscription is the one hosting the console.`;
      break;
    case 'ambiguous':
      fix =
        `More than one resource group in this subscription holds a container app with that name. ` +
        `Pass admin_rg (or set LOOM_ADMIN_RG) so the estate is named rather than guessed.`;
      break;
    case 'denied':
      fix =
        `Grant the workflow's identity Reader on the admin resource group (or the container app) so ` +
        `it can read the app's environment variables, then re-dispatch. Nothing about the binding ` +
        `itself has been established by this run.`;
      break;
    case 'transient':
      fix = `Re-dispatch. Nothing about the binding itself has been established by this run.`;
      break;
    case 'no-target':
      fix =
        `Supply CONSOLE_RG (admin_rg input / LOOM_ADMIN_RG repo variable) or let discovery run with ` +
        `an azure/login that can list container apps.`;
      break;
    default:
      fix =
        `The read did not complete. Check the azure/login step and the identity's Reader rights on ` +
        `the admin resource group, then re-dispatch. Nothing about the binding itself has been ` +
        `established by this run.`;
  }
  return `${head} ${context} ${fix}`;
}

// ───────────────────────── az plumbing (impure) ──────────────────────────────

/**
 * Run `az` and return {ok, stdout, stderr}. stderr is CAPTURED, never
 * discarded: `2>/dev/null` is how this repo turned a permission denial into a
 * false claim of absence (deploy-integrity R7 / the `csa_loom_gates_that_
 * measure_nothing` class). The `az containerapp` extension writes a banner to
 * stderr on success, so the EXIT CODE is the verdict — never stderr content.
 */
export function az(args, { retries = 2 } = {}) {
  let last = { ok: false, stdout: '', stderr: '' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = execFileSync(process.env.AZ_BIN || 'az', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      return { ok: true, stdout: String(stdout).replace(/\r/g, ''), stderr: '' };
    } catch (e) {
      last = {
        ok: false,
        stdout: String(e.stdout || '').replace(/\r/g, ''),
        stderr: String(e.stderr || e.message || '').replace(/\r/g, ''),
      };
      if (classifyAzFailure(last.stderr) !== 'transient') break;
      // Bounded backoff. Fails CLOSED on exhaustion — a retry that cannot fail
      // is forbidden (deploy-integrity R6).
      const ms = 2000 * (attempt + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }
  return last;
}

/** Locate the console's resource group when the caller did not name one. */
export function discoverResourceGroup(app, subArgs) {
  const r = az(['containerapp', 'list', ...subArgs, '--query', `[?name=='${app}'].resourceGroup`, '-o', 'json']);
  if (!r.ok) {
    const status = classifyAzFailure(r.stderr);
    // A 404 from a LIST is about the subscription/scope, not about the binding.
    return { status: status === 'notfound' ? 'app-not-found' : status, detail: redact(r.stderr).slice(0, 400) };
  }
  let groups;
  try {
    groups = JSON.parse(r.stdout || '[]');
  } catch {
    return { status: 'unknown', detail: 'container app list returned unparseable JSON' };
  }
  const uniq = [...new Set(groups.filter(Boolean))];
  if (uniq.length === 0) return { status: 'app-not-found' };
  if (uniq.length > 1) return { status: 'ambiguous', detail: String(uniq.length) };
  return { status: 'resolved', value: uniq[0] };
}

/**
 * Read the binding off the live console. Every container in the template is
 * searched, not `containers[0]`, so a sidecar cannot shadow the app.
 */
export function readBinding(app, rg, subArgs) {
  const r = az([
    'containerapp', 'show', '-n', app, '-g', rg, ...subArgs,
    '--query', 'properties.template.containers[].env', '-o', 'json',
  ]);
  if (!r.ok) {
    const status = classifyAzFailure(r.stderr);
    // A 404 here means the app or the resource group is not in this scope — a
    // MEASURED absence of the RESOURCE. It says nothing about the binding, and
    // the refusal for `app-not-found` points at the estate, not at the deploy.
    return { status: status === 'notfound' ? 'app-not-found' : status, detail: redact(r.stderr).slice(0, 400) };
  }
  let perContainer;
  try {
    perContainer = JSON.parse(r.stdout || '[]');
  } catch {
    return { status: 'unknown', detail: 'container app show returned unparseable JSON' };
  }
  return pickBinding(perContainer);
}

/**
 * Pure half of readBinding — given the app's env arrays, say what the binding
 * is. Exported so the empty / absent / secretRef branches are testable without
 * an Azure estate.
 */
export function pickBinding(perContainer) {
  const entries = (Array.isArray(perContainer) ? perContainer : [])
    .flatMap((envs) => (Array.isArray(envs) ? envs : []))
    .filter((e) => e && e.name === BINDING_VAR);
  if (entries.length === 0) return { status: 'absent' };
  const withValue = entries.find((e) => typeof e.value === 'string' && e.value.trim() !== '');
  if (withValue) return { status: 'resolved', value: withValue.value.trim() };
  if (entries.some((e) => e.secretRef)) return { status: 'secretref' };
  return { status: 'empty' };
}

// ───────────────────────────────── CLI ───────────────────────────────────────

export function main(env = process.env) {
  const app = (env.CONSOLE_APP || 'loom-console').trim();
  const sub = (env.CONSOLE_SUBSCRIPTION || '').trim();
  const subArgs = sub ? ['--subscription', sub] : [];
  let rg = (env.CONSOLE_RG || '').trim();

  let derived = { status: 'no-target' };
  if (!rg) {
    const found = discoverResourceGroup(app, subArgs);
    if (found.status === 'resolved') rg = found.value;
    else derived = found;
  }
  if (rg) derived = readBinding(app, rg, subArgs);

  const verdict = decide({
    explicit: env.EXPLICIT_OID,
    derived,
    carried: env.ALLOW_CARRY_FORWARD === 'false' ? '' : env.CARRIED_OID,
  });

  for (const w of verdict.warnings) console.log(`::warning::${w}`);

  if (!verdict.ok) {
    console.log(`::error::${verdict.error}`);
    return 1;
  }

  // An object id is an identifier rather than a credential, but every consuming
  // workflow already masks it, so this stays consistent with them.
  console.log(`::add-mask::${verdict.oid}`);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `LOOM_AUTOMATION_OID=${verdict.oid}\n`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `oid_source=${verdict.source}\n`);
    appendFileSync(env.GITHUB_OUTPUT, `console_rg=${rg}\n`);
  }
  console.log(
    `LOOM_AUTOMATION_OID <- ${verdict.source} (value masked; ${idHint(verdict.oid)}) ` +
      `[app=${app} rg=${rg || '<undiscovered>'}]`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('resolve-automation-oid.mjs');
if (invokedDirectly) process.exit(main());
