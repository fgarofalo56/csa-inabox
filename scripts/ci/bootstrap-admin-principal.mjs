#!/usr/bin/env node
/**
 * bootstrap-admin-principal.mjs — REFUSE a deploy whose bootstrap tenant-admin
 * binding cannot be shown to be a human admin (refs #3109).
 *
 * WHY THIS EXISTS
 * ---------------
 * `loomTenantAdminOid` / `loomTenantAdminGroupId` are the two values that decide
 * who can open /admin/* on a fresh estate. The console resolves them with
 * apps/fiab-console/lib/auth/feature-gate.ts `isTenantAdmin()`:
 *
 *     groups: session.claims.groups?.some(g => LOOM_TENANT_ADMIN_GROUP_ID.split(',').includes(g))
 *     oid   : session.claims.oid === LOOM_TENANT_ADMIN_OID          // EXACT equality
 *
 * so every wrong SHAPE fails silently and identically to a correct one: the
 * container app comes up with the variable set, /admin/readiness reports the
 * binding present, and no human can pass the gate. Three ways to land there,
 * all seen on this repo's own estate:
 *
 *   1. A SERVICE PRINCIPAL object id in the OID slot. admin-plane/main.bicep
 *      used to fall back to `deployer().objectId` whenever no explicit oid was
 *      passed, and every CI deploy runs as a service principal — so the deploy
 *      SP became the estate's "bootstrap admin". A workload identity cannot
 *      complete an interactive sign-in, so that binding matches NOBODY. (That
 *      fallback is now restricted to an interactive deployer in the bicep; this
 *      script covers the other direction — an SP oid supplied by hand.)
 *   2. A GROUP object id in the OID slot (or a user oid in the GROUP slot).
 *      Both read as configured and match nobody.
 *   3. A comma-separated OID list. `isTenantAdmin` compares the WHOLE string
 *      with ===, so "a,b" matches neither a nor b.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT REFUSES TO GUESS (deploy-integrity R7)
 * ----------------------------------------------------------------------
 * Each id is classified by ONE authoritative read — Microsoft Graph
 * `GET /v1.0/directoryObjects/{id}` — whose `@odata.type` is the tenant's own
 * answer to "what kind of principal is this". Only that read can say
 * "servicePrincipal". Anything else the tool sees is reported as what it is:
 *
 *   - a 404 Request_ResourceNotFound  -> ABSENT   (the oid names no principal
 *                                                  in this tenant; a binding to
 *                                                  it is dead on arrival)
 *   - a denied / failed / unparseable read -> UNRESOLVED, and the message says
 *     the lookup did not complete rather than inventing a principal type.
 *
 * UNRESOLVED IS A FAILURE, NOT A PASS. An unknown binding is exactly the state
 * that shipped the outage; a check that shrugs at it is the "guard that cannot
 * fail" class this repo keeps paying for. Same for an EMPTY population: if the
 * run renders the Container Apps and there is nothing to classify, that is a
 * refusal, not a clean bill of health.
 *
 * CLOUD PARITY (cloud-parity.md)
 * -----------------------------
 * The Graph endpoint is read from `az cloud show`
 * (`endpoints.microsoftGraphResourceId`), never hard-coded — so this runs
 * unmodified in Commercial (graph.microsoft.com), GCC-High / IL5 / DoD
 * (graph.microsoft.us) and any other boundary `az` knows. As of #3109 the
 * COMMERCIAL lane (deploy-fiab-commercial.yml) is the only lane that binds
 * `loomTenantAdminOid`; deploy-fiab-gcch/il5/gcc bind only
 * `loomTenantAdminGroupId` (from FIAB_GOV_ADMIN_GROUP_ID) and therefore have no
 * OID to classify. That is a STATED, enforced boundary, not an assumption:
 * scripts/ci/check-bootstrap-admin-binding.mjs FAILS if any lane starts passing
 * an OID without running this refusal. The SP-as-bootstrap-admin path itself is
 * closed in every cloud by the bicep, which needs no Graph call at all.
 *
 * Usage (CI):   node scripts/ci/bootstrap-admin-principal.mjs
 * Usage (dev):  TENANT_ADMIN_OID=<oid> TENANT_ADMIN_GROUP_ID=<gid> \
 *                 DEPLOY_APPS_ENABLED=true node scripts/ci/bootstrap-admin-principal.mjs
 * Tests:        node --test scripts/ci/__tests__/bootstrap-admin-principal.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { redact } from './_azure-redact.mjs';

/** An Entra object id is a GUID. Anything else is a typo, not a principal. */
export const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Show enough of an object id to identify it without printing the whole thing. */
export const idHint = (id) => (id && id.length > 8 ? `${id.slice(0, 8)}…` : String(id ?? ''));

/**
 * Map a Graph `@odata.type` onto the principal kinds this check reasons about.
 * An unrecognised type is 'other' — NEVER silently treated as a user.
 */
export function classifyOdataType(odataType) {
  const t = String(odataType || '').trim().toLowerCase();
  if (t === '#microsoft.graph.user') return 'user';
  if (t === '#microsoft.graph.serviceprincipal') return 'servicePrincipal';
  if (t === '#microsoft.graph.group') return 'group';
  if (!t) return 'unresolved';
  return 'other';
}

/** stderr markers that mean "try again", not "the answer is no". */
const TRANSIENT = /\b(429|500|502|503|504)\b|too many requests|timed? ?out|temporarily unavailable|connection (reset|aborted)|ServiceUnavailable/i;
/** stderr markers that mean the object genuinely is not in the directory. */
const NOT_FOUND = /Request_ResourceNotFound|does not exist or one of its queried reference-property objects|\b404\b|Not Found/i;
/** stderr markers that mean the CALLER was refused — an UNKNOWN answer, not a negative one. */
const DENIED = /Authorization_RequestDenied|Insufficient privileges|\b40[13]\b|Forbidden|Unauthorized|AADSTS/i;

const HUMAN = {
  user: 'a user',
  servicePrincipal: 'a service principal (workload identity)',
  group: 'a group',
  other: 'a directory object of an unrecognised type',
  absent: 'not present in this tenant',
  unresolved: 'NOT CLASSIFIED — the directory lookup did not complete',
};

/**
 * The az launcher. On Windows `az` is a .cmd shim, which execFileSync cannot
 * spawn directly (ENOENT) — the CI runners are Linux, but this repo is
 * developed and mutation-proved on Windows, and a check that only runs on one
 * of the two is a check nobody exercises before it reaches CI.
 */
export const AZ_BIN = process.platform === 'win32' ? 'az.cmd' : 'az';
const IS_WIN = process.platform === 'win32';
/** Node >=20 refuses to execFile a .cmd without a shell (CVE-2024-27980), so on
 *  Windows the arguments go through cmd and must be quoted. Every argument this
 *  file passes is either a literal or a GUID that GUID_RE has already accepted. */
const quoteWin = (a) =>
  // Escape BACKSLASHES before quotes. Escaping only `"` leaves a trailing `\`
  // able to escape the closing quote and break out of the quoted argument
  // (CodeQL js/incomplete-sanitization). Every argument this file passes is a
  // literal or a GUID_RE-validated GUID, so this is defence in depth rather than
  // a live hole - but a quoting helper that is only correct for its current
  // callers is a trap for the next one.
  `"${String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Default process runner (separated so tests can drive the parsing directly). */
function runAz(args) {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const stdout = IS_WIN
      ? execFileSync(AZ_BIN, args.map(quoteWin), { ...opts, shell: true })
      : execFileSync(AZ_BIN, args, opts);
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    if (e.code === 'ENOENT') return { code: 127, stdout: '', stderr: 'az: command not found' };
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? String(e.message ?? '') };
  }
}

/**
 * Resolve the Microsoft Graph endpoint of the ACTIVE cloud. Never hard-coded —
 * a Commercial literal silently classifies nothing in a sovereign boundary.
 */
export function graphBase(exec = runAz) {
  const r = exec(['cloud', 'show', '--query', 'endpoints.microsoftGraphResourceId', '-o', 'tsv']);
  const base = (r.stdout || '').trim();
  if (r.code !== 0 || !base) {
    return { ok: false, detail: `az cloud show exited ${r.code}: ${redact((r.stderr || '(no stderr)').trim()).split('\n')[0]}` };
  }
  return { ok: true, base: base.replace(/\/+$/, '') };
}

/**
 * Classify ONE object id through Graph. Returns { kind, detail } where kind is
 * one of user | servicePrincipal | group | other | absent | unresolved.
 * Bounded retry on genuinely transient failures only (deploy-integrity R6);
 * exhaustion FAILS — a retry that cannot fail is forbidden.
 */
export function lookupPrincipal(id, { exec = runAz, base, attempts = 3, sleep = defaultSleep } = {}) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = exec(['rest', '--method', 'GET', '--url', `${base}/v1.0/directoryObjects/${id}`, '-o', 'json']);
    if (r.code === 0) {
      let parsed;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        return { kind: 'unresolved', detail: `Graph returned a body that is not JSON (${r.stdout.length} bytes) for ${idHint(id)}` };
      }
      const kind = classifyOdataType(parsed?.['@odata.type']);
      if (kind === 'unresolved') {
        return { kind: 'unresolved', detail: `Graph returned an object with no @odata.type for ${idHint(id)}` };
      }
      return { kind, detail: `Graph @odata.type=${parsed['@odata.type']}` };
    }
    const err = redact((r.stderr || r.stdout || '').trim());
    last = err.split('\n').filter(Boolean).slice(-1)[0] || `az exited ${r.code}`;
    if (NOT_FOUND.test(err) && !DENIED.test(err)) {
      return { kind: 'absent', detail: `Graph 404 Request_ResourceNotFound for ${idHint(id)}` };
    }
    if (DENIED.test(err)) {
      return {
        kind: 'unresolved',
        detail:
          `the deploy identity was REFUSED the directory read for ${idHint(id)} (${last}). ` +
          'Grant the deploy service principal the Microsoft Graph application permission ' +
          'Directory.Read.All (or the Directory Readers role) and re-run — this check does ' +
          'not guess a principal type it could not read.',
      };
    }
    if (!TRANSIENT.test(err) || attempt === attempts) {
      return { kind: 'unresolved', detail: `az rest exited ${r.code} for ${idHint(id)}: ${last}` };
    }
    sleep(attempt);
  }
  /* c8 ignore next */
  return { kind: 'unresolved', detail: `directory lookup for ${idHint(id)} exhausted ${attempts} attempts: ${last}` };
}

function defaultSleep(attempt) {
  const ms = 2000 * attempt;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Split a comma-separated binding into its non-empty members. */
export const splitIds = (raw) => String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * THE VERDICT. Pure: `lookup(id)` supplies the directory answer, so this is
 * exercised directly by the tests for every classification.
 *
 * @param {object} a
 * @param {string} a.oid              composed loomTenantAdminOid ('' when unbound)
 * @param {string} a.oidSource        where the oid came from, for the message
 * @param {string} a.groupRaw         composed loomTenantAdminGroupId ('' when unbound)
 * @param {string} a.groupSource      where the group came from, for the message
 * @param {string} a.deployAppsEnabled raw value; anything but 'false' means the
 *                                     Container Apps are rendered (UNKNOWN is
 *                                     treated as rendered — never as safe)
 * @param {string} a.lane             the workflow file this binding belongs to
 * @param {(id:string)=>{kind:string,detail:string}} a.lookup
 */
export function evaluateBinding({ oid = '', oidSource = '', groupRaw = '', groupSource = '', deployAppsEnabled = '', lane = '', lookup }) {
  const findings = [];
  const notes = [];
  const appsRendered = String(deployAppsEnabled).trim() !== 'false';
  const appsRenderedKnown = ['true', 'false'].includes(String(deployAppsEnabled).trim());
  if (!appsRenderedKnown) {
    notes.push(
      `DEPLOY_APPS_ENABLED was "${String(deployAppsEnabled).trim() || '(empty)'}" — not true/false. ` +
        'Treating this run as one that RENDERS the Container Apps, because an unknown value is unknown, not safe.',
    );
  }
  const fail = (code, message) => findings.push({ code, message });

  const oidValues = splitIds(oid);
  const groupValues = splitIds(groupRaw);
  let checked = 0;

  if (oidValues.length === 0 && groupValues.length === 0) {
    if (appsRendered) {
      fail(
        'no-binding',
        `No bootstrap tenant-admin binding was composed and this run renders the Container Apps. ` +
          `loom-console would come up with LOOM_TENANT_ADMIN_OID and LOOM_TENANT_ADMIN_GROUP_ID both empty, which shuts ` +
          `/admin/* for every user with no in-product remedy. Set the FIAB_ADMIN_GROUP_ID repo variable (or secret) to ` +
          `your Loom admin security-group object id, or dispatch ${lane || 'the deploy lane'} with tenant_admin_group_id / tenant_admin_oid.`,
      );
    } else {
      notes.push('No admin binding composed, and DEPLOY_APPS_ENABLED=false — no Container App is rendered on this run, so there is no console to lock out.');
    }
    return { ok: findings.length === 0, findings, notes, checked, appsRendered };
  }

  if (oidValues.length > 1) {
    fail(
      'oid-multi-valued',
      `The bootstrap admin OID (${oidSource || 'source unknown'}) carries ${oidValues.length} comma-separated values. ` +
        'apps/fiab-console/lib/auth/feature-gate.ts compares session.claims.oid === LOOM_TENANT_ADMIN_OID with EXACT ' +
        'equality — a list matches nobody, including the people in it. Bind ONE user oid here and put the rest in the ' +
        'admin GROUP, which IS comma-split.',
    );
  }

  for (const id of oidValues) {
    if (!GUID_RE.test(id)) {
      fail('oid-not-a-guid', `The bootstrap admin OID (${oidSource || 'source unknown'}) "${idHint(id)}" is not a GUID, so it is not an Entra object id.`);
      continue;
    }
    const { kind, detail } = lookup(id);
    checked++;
    if (kind === 'user') continue;
    if (kind === 'servicePrincipal') {
      fail(
        'oid-is-service-principal',
        `The bootstrap admin OID ${idHint(id)} (${oidSource || 'source unknown'}) is a SERVICE PRINCIPAL — ${detail}. ` +
          'A workload identity never completes an interactive sign-in, so this binding grants the console tenant-admin ' +
          'bypass to a principal that can never use it while every human keeps getting 403. This is the #3109 defect: ' +
          'the deploy SP became the estate bootstrap admin. Bind a USER object id ' +
          '(az ad signed-in-user show --query id -o tsv), or bind the admin GROUP instead.',
      );
      continue;
    }
    if (kind === 'group') {
      fail(
        'oid-is-group',
        `The bootstrap admin OID ${idHint(id)} (${oidSource || 'source unknown'}) is a GROUP — ${detail}. ` +
          'LOOM_TENANT_ADMIN_OID is compared against the caller\'s own oid, never against group membership. ' +
          'Move this id to the admin GROUP binding (loomTenantAdminGroupId / FIAB_ADMIN_GROUP_ID).',
      );
      continue;
    }
    if (kind === 'absent') {
      fail('oid-absent', `The bootstrap admin OID ${idHint(id)} (${oidSource || 'source unknown'}) resolves to no principal in this tenant — ${detail}. A binding to a non-existent object id makes nobody an admin.`);
      continue;
    }
    fail(
      kind === 'unresolved' ? 'oid-unresolved' : 'oid-other',
      `The bootstrap admin OID ${idHint(id)} (${oidSource || 'source unknown'}) is ${HUMAN[kind]} — ${detail}. ` +
        'This check does not pass a binding it could not establish is a human admin.',
    );
  }

  for (const id of groupValues) {
    if (!GUID_RE.test(id)) {
      fail('group-not-a-guid', `The bootstrap admin GROUP id (${groupSource || 'source unknown'}) "${idHint(id)}" is not a GUID, so it is not an Entra object id.`);
      continue;
    }
    const { kind, detail } = lookup(id);
    checked++;
    if (kind === 'group') continue;
    if (kind === 'unresolved') {
      fail('group-unresolved', `The bootstrap admin GROUP id ${idHint(id)} (${groupSource || 'source unknown'}) is ${HUMAN.unresolved} — ${detail}.`);
      continue;
    }
    if (kind === 'absent') {
      fail('group-absent', `The bootstrap admin GROUP id ${idHint(id)} (${groupSource || 'source unknown'}) resolves to no principal in this tenant — ${detail}. Nobody's groups claim can ever contain it.`);
      continue;
    }
    fail(
      'group-not-a-group',
      `The bootstrap admin GROUP id ${idHint(id)} (${groupSource || 'source unknown'}) is ${HUMAN[kind]}, not a group — ${detail}. ` +
        'LOOM_TENANT_ADMIN_GROUP_ID is matched against the caller\'s groups claim, which only ever contains GROUP object ids, ' +
        'so this binding matches nobody.',
    );
  }

  // EMPTY POPULATION IS A FAILURE. Values were supplied and none of them reached
  // a directory answer: the classifier drifted, not the tenant.
  if (checked === 0 && (oidValues.length > 0 || groupValues.length > 0) && findings.length === 0) {
    fail('nothing-checked', `A binding was composed (${oidValues.length} oid / ${groupValues.length} group value(s)) but NOT ONE of them was classified. Refusing to report a binding verified when nothing was read.`);
  }

  return { ok: findings.length === 0, findings, notes, checked, appsRendered };
}

/** GitHub annotations, one per finding, plus a human summary. */
export function formatReport(result, { oidSource, groupSource, boundary, lane }) {
  const lines = [];
  for (const n of result.notes) lines.push(`::notice::[bootstrap-admin] ${n}`);
  for (const f of result.findings) lines.push(`::error title=Bootstrap admin binding (${f.code})::${f.message}`);
  if (result.ok) {
    lines.push(
      `::notice::[bootstrap-admin] ${result.checked} bound principal(s) classified against the ${boundary} directory: ` +
        `oid=${oidSource || 'unbound'}, group=${groupSource || 'unbound'}. Every bound id is the kind ${lane} needs it to be. Values redacted.`,
    );
  }
  return lines.join('\n');
}

export function main(env = process.env, { exec = runAz, log = console.log } = {}) {
  const lane = env.DEPLOY_LANE || '.github/workflows/deploy-fiab-commercial.yml';
  const oid = env.TENANT_ADMIN_OID || '';
  const groupRaw = env.TENANT_ADMIN_GROUP_ID || '';
  const oidSource = env.TENANT_ADMIN_OID_SOURCE || (oid ? 'source unknown' : '');
  const groupSource = env.TENANT_ADMIN_GROUP_SOURCE || (groupRaw ? 'source unknown' : '');

  let lookup;
  let boundary = env.BOUNDARY || '';
  if (oid || groupRaw) {
    const g = graphBase(exec);
    if (!g.ok) {
      log(
        `::error title=Bootstrap admin binding (graph-endpoint-unresolved)::The Microsoft Graph endpoint of the active cloud could not be read, so no bound principal could be classified — ${g.detail}. ` +
          'This check refuses to pass a binding it could not verify; it does NOT assume the Commercial endpoint.',
      );
      return 1;
    }
    if (!boundary) {
      const c = exec(['cloud', 'show', '--query', 'name', '-o', 'tsv']);
      boundary = (c.stdout || '').trim() || 'the active cloud';
    }
    lookup = (id) => lookupPrincipal(id, { exec, base: g.base });
  } else {
    lookup = () => ({ kind: 'unresolved', detail: 'no directory read attempted — nothing was bound' });
    boundary = boundary || 'the active cloud';
  }

  const result = evaluateBinding({
    oid,
    oidSource,
    groupRaw,
    groupSource,
    deployAppsEnabled: env.DEPLOY_APPS_ENABLED ?? '',
    lane,
    lookup,
  });
  const report = formatReport(result, { oidSource, groupSource, boundary, lane });
  if (report) log(report);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### Bootstrap admin binding\n\n${report.replace(/^::[a-z]+[^:]*::/gm, '- ')}\n`);
    } catch {
      /* the summary is a convenience; its absence never changes the verdict */
    }
  }
  return result.ok ? 0 : 1;
}

// Same direct-invocation convention as scripts/ci/deploy-input-safety.mjs — a
// path compare would need Windows/POSIX normalisation the guards do not do.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('bootstrap-admin-principal.mjs');
if (invokedDirectly) {
  const code = main();
  if (code !== 0) {
    console.error(
      '\n[bootstrap-admin] REFUSED — the composed bootstrap tenant-admin binding was not shown to be a human admin. ' +
        'Nothing has been submitted to ARM. See scripts/ci/bootstrap-admin-principal.mjs.',
    );
  } else {
    console.log('[bootstrap-admin] OK — every bound admin principal was classified and is the kind the console can match.');
  }
  process.exit(code);
}
