#!/usr/bin/env node
/**
 * estate-resume.mjs — bring back exactly what was paused on 2026-08-23.
 *
 *   node scripts/measure/estate-resume.mjs --dry-run   # show what WOULD change
 *   node scripts/measure/estate-resume.mjs --apply     # do it
 *
 * Scope is a fixed list, deliberately. Of the 13 Container App environments in
 * these subscriptions only ONE is Loom's — the rest are a blog, Sentinel, two
 * Atlas estates and six others — so nothing here is discovered dynamically and
 * nothing outside this list is touched.
 *
 * Every action verifies its own outcome. A resume that reports success without
 * confirming state is the failure this directory exists to prevent.
 *
 * ── THE BOUNDARY GUARD (#4149) ──────────────────────────────────────────────
 * EVERY NAME IN THIS FILE IS COMMERCIAL. `rg-csa-loom-admin-centralus`,
 * `rg-csa-loom-dlz-default-centralus` and `adx-csa-loom-z52x3p` are the
 * Commercial estate's resources and nothing else, and `subFor()` resolves a
 * subscription BY RESOURCE NAME against whatever cloud the ambient `az` session
 * happens to point at.
 *
 * Nothing read the active cloud before the first mutation. So an operator who
 * had run `az cloud set --name AzureUSGovernment`, intending to resume Gov, got
 * one of two outcomes and could not tell them apart from the report:
 *
 *   - the Commercial names resolve to nothing in the Gov graph, and every row
 *     reads FAILED for a reason that looks like an access problem; or
 *   - worse, credentials for both are cached, the Commercial resources resolve,
 *     and the COMMERCIAL estate is silently mutated while the transcript says
 *     nothing about which boundary it acted on. A green report about the wrong
 *     estate.
 *
 * Three things close that:
 *
 *   1. FAIL CLOSED BEFORE THE FIRST MUTATION. `az account show` is read and
 *      `environmentName` must be exactly `AzureCloud`. Anything else — a
 *      sovereign cloud, an empty answer, an `az` that would not run — refuses,
 *      and refuses BEFORE `az containerapp update`, `az resource invoke-action
 *      --action resume` or `az kusto cluster start`. It refuses on `--dry-run`
 *      too: a dry-run report about the wrong boundary is the same defect one
 *      step earlier, and it is the report the operator would act on.
 *   2. NAME THE BOUNDARY AND THE SUBSCRIPTION ON EVERY LINE, so the transcript
 *      is self-describing after the fact. "loom-activator 0 -> 1 OK" is a fact
 *      about an estate the line does not identify.
 *   3. REFUSE AN AMBIGUOUS OR UNEXPECTED RESOLUTION. `subFor` took `limit 1`
 *      from a name-only query, i.e. it accepted whichever row the graph handed
 *      back first. It now takes no limit, requires the row's resource group to
 *      be the one this script is about to pass to `-g`, and refuses when the
 *      name resolves to more than one subscription or to none.
 *
 * WHY THE GUARD IS `AzureCloud`-ONLY AND NOT A CLOUD SELECTOR. Resuming the Gov
 * estate is not "the same script with a different environment name": the
 * resource names differ, the pause register differs, and per this repo's
 * standing rule Gov is never touched from a workstation `az` at all — Gov facts
 * come from a GitHub Actions run in the boundary. So the honest answer is a
 * refusal that says which cloud this script is FOR, not a flag that pretends
 * it generalises.
 *
 * Tests: node --test scripts/ci/__tests__/estate-resume-boundary-guard.test.mjs
 * (scripts/ci/__tests__ so it is covered by loom-guardrails.yml's explicit glob
 * step as well as by the tree-wide discovery runner — see the correction in that
 * file's header about which of those two claims was actually true.)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as defaultRun, az as defaultAz, MeasurementError } from './measure.mjs';

const RG_ADMIN = 'rg-csa-loom-admin-centralus';
const RG_DLZ = 'rg-csa-loom-dlz-default-centralus';

/**
 * THE MODULE'S ONE PUBLICATION SINK — and why it is a named wrapper rather than
 * `log = console.log` as a default parameter.
 *
 * PUBLICATION-SINKS: 1
 *
 * MEASURED DURING THIS CHANGE, and worth recording because it is the exact
 * "guard quietly stops watching" shape this repo keeps finding. Making `main()`
 * injectable moved every `console.log(...)` call behind a `log(...)` parameter.
 * The C4 publication extractor (apps/fiab-console/lib/brain/security/extract/
 * publications.ts) enumerates CALL SITES — `console.log(`,
 * `process.stdout.write(`, and the bracket/alias forms — and emits a node only
 * when it finds at least one. `log = console.log` is a REFERENCE, not a call, so
 * the module's sink count went 20 -> 0 and its
 * `sec:publication:scripts/measure/estate-resume.mjs#module` node VANISHED from
 * the generated graph. Nothing went red: the artifact re-derived cleanly, one
 * node lighter, and a publication surface had simply stopped being watched.
 *
 * So the default is a real call site. And since there is now exactly one, the
 * `PUBLICATION-SINKS:` marker above is DECLARED — which makes C4's declared-count
 * drift check LIVE for this module instead of inert (previously it was recorded
 * as skipped, since almost nothing in the repo declares a count). Add a second
 * `console.*` call here without updating that number and C4 raises a population
 * finding, which is the point.
 */
const emit = (text) => console.log(String(text));

/** The ONE cloud whose resources this file names. See the header. */
export const EXPECTED_ENVIRONMENT = 'AzureCloud';
/** What that cloud is called in the transcript. */
export const BOUNDARY = 'Commercial';

// Paused 2026-08-23. minReplicas restored to what each carried BEFORE.
export const APPS = [
  { name: 'loom-capacity-broker', rg: RG_ADMIN, min: 2 },
  { name: 'loom-activator', rg: RG_ADMIN, min: 1 },
  { name: 'loom-dbt-r2', rg: RG_ADMIN, min: 1 },
  { name: 'loom-direct-lake-shim', rg: RG_ADMIN, min: 1 },
  { name: 'loom-mirroring', rg: RG_ADMIN, min: 1 },
  { name: 'loom-onelake', rg: RG_ADMIN, min: 1 },
  { name: 'loom-prpt-r3', rg: RG_ADMIN, min: 1 },
  { name: 'loom-wrangler-h2', rg: RG_ADMIN, min: 1 },
];
export const AAS = [
  { name: 'aasloomk6mvh5sm6z7do', rg: RG_ADMIN, note: 'S1' },
  { name: 'loomdefault', rg: RG_DLZ, note: 'B1' },
];
export const ADX = { name: 'adx-csa-loom-z52x3p', rg: RG_ADMIN };

/**
 * Is this session pointed at the cloud this file is about? PURE (#4149).
 *
 * THREE WAYS TO SAY NO, and they are kept distinct because they need different
 * responses: a sovereign cloud is `az cloud set`, an unreadable answer is a
 * broken/unauthenticated CLI, and a missing subscription id is a session that
 * cannot name what it would act on. Collapsing them into "not Commercial" would
 * hand the operator a remediation for a cause nobody established
 * (deploy-integrity.md R7).
 *
 * UNKNOWN IS A REFUSAL, never a pass. An `environmentName` that could not be
 * read is not evidence of AzureCloud; the whole class of defect this repo keeps
 * finding is a control that reads "no answer" as "the good answer".
 *
 * @param {{environmentName?:string, id?:string, name?:string, tenantId?:string,
 *          error?:string}|null|undefined} account  the `az account show` projection
 * @returns {{ok:boolean, environmentName:string|null, subscriptionId:string|null,
 *            subscriptionName:string|null, tenantId:string|null, reason:string|null}}
 */
export function classifyBoundary(account) {
  const shell = {
    environmentName: null, subscriptionId: null, subscriptionName: null, tenantId: null,
  };
  if (!account || typeof account !== 'object') {
    return {
      ...shell,
      ok: false,
      reason: 'the active cloud could not be read at all — `az account show` returned nothing usable. '
        + 'That is UNKNOWN, not AzureCloud, so nothing here will run.',
    };
  }
  if (account.error) {
    return {
      ...shell,
      ok: false,
      reason: `the active cloud could not be read — ${account.error}. `
        + 'UNKNOWN is refused rather than assumed; sign in (`az login`) and re-run.',
    };
  }

  const env = typeof account.environmentName === 'string' ? account.environmentName.trim() : '';
  const id = typeof account.id === 'string' ? account.id.trim() : '';
  const subName = typeof account.name === 'string' ? account.name.trim() : '';
  const tenantId = typeof account.tenantId === 'string' ? account.tenantId.trim() : '';
  const measured = {
    environmentName: env || null,
    subscriptionId: id || null,
    subscriptionName: subName || null,
    tenantId: tenantId || null,
  };

  if (!env) {
    return {
      ...measured,
      ok: false,
      reason: '`az account show` produced no environmentName, so which cloud this session is on is '
        + 'UNKNOWN. Unknown is not AzureCloud.',
    };
  }
  if (env !== EXPECTED_ENVIRONMENT) {
    return {
      ...measured,
      ok: false,
      reason: `the active az session is on '${env}', and every resource named in this file belongs to `
        + `${EXPECTED_ENVIRONMENT} (${BOUNDARY}). Resuming ${BOUNDARY} from a '${env}' session would either `
        + 'fail for reasons that look like an access problem, or — with both credential sets cached — '
        + `mutate the ${BOUNDARY} estate while you believed you were acting on '${env}'. `
        + `Refusing. To act on ${BOUNDARY}: az cloud set --name ${EXPECTED_ENVIRONMENT} && az login. `
        + 'This script does NOT resume a sovereign estate — that runs from a GitHub Actions run inside '
        + 'the boundary, never from a workstation az.',
    };
  }
  if (!id) {
    return {
      ...measured,
      ok: false,
      reason: `the session reports ${EXPECTED_ENVIRONMENT} but no subscription id, so it cannot name the `
        + 'estate it would act on. A transcript that cannot say WHICH subscription was mutated is the '
        + 'defect this guard exists to prevent. Run `az account set --subscription <id>`.',
    };
  }
  return { ...measured, ok: true, reason: null };
}

/**
 * Resource names this file will interpolate into a resource-graph KQL query.
 *
 * Every name here is a hard-coded constant, so this is defence in depth rather
 * than a live exposure — but a KQL string built by concatenation is a sink
 * whatever feeds it, and `subFor` is exported. Validating at the boundary means
 * the property holds for any caller, not only for the table above.
 */
export const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/**
 * Decide which subscription a named resource lives in. PURE (#4149).
 *
 * THE OLD SHAPE WAS `limit 1` OVER A NAME-ONLY QUERY: it accepted whichever row
 * the graph returned first, with no check that the row was even in the resource
 * group the caller was about to pass to `-g`. Two names collide across estates
 * far more easily than they look like they would — `loomdefault` is not a
 * globally unique string — and the loser of that race is a mutation applied to
 * somebody else's resource, reported as a success.
 *
 * So: no limit, and three explicit refusals.
 *
 *   - NOTHING FOUND       → refuse. "not visible to this session" is stated as
 *                           exactly that; it is not evidence the resource does
 *                           not exist (it may be RBAC), and the message says so.
 *   - FOUND, WRONG GROUP  → refuse, and NAME where it actually is. This is the
 *                           branch that catches "right name, wrong estate".
 *   - MORE THAN ONE SUB   → refuse, and list them. An ambiguous answer is not a
 *                           weaker answer, it is no answer.
 *
 * @param {{name:string, rg:string, type?:string|null,
 *          rows:{sub?:string, rg?:string, type?:string}[]|null}} a
 * @returns {{ok:boolean, sub:string|null, reason:string|null}}
 */
export function classifySubResolution({ name, rg, type = null, rows }) {
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      sub: null,
      reason: `the resource-graph answer for '${name}' was not a list of rows, so where it lives is `
        + 'UNKNOWN — refusing to act on a guess.',
    };
  }
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  const matching = rows.filter((r) => eq(r?.rg, rg) && (type === null || eq(r?.type, type)));

  if (matching.length === 0) {
    if (rows.length === 0) {
      return {
        ok: false,
        sub: null,
        reason: `no resource named '${name}' is visible to this session. That is not proof it does not `
          + 'exist — it may be in a subscription this identity cannot read — so this refuses rather '
          + 'than reporting an absence it did not establish.',
      };
    }
    const where = rows
      .slice(0, 5)
      .map((r) => `${r?.rg || '?'} (sub ${r?.sub || '?'}${r?.type ? `, ${r.type}` : ''})`)
      .join('; ');
    return {
      ok: false,
      sub: null,
      reason: `'${name}' exists in ${rows.length} place(s), NONE of them in resource group '${rg}'`
        + `${type ? ` with type '${type}'` : ''}: ${where}`
        + `${rows.length > 5 ? `; … and ${rows.length - 5} more` : ''}. `
        + 'Right name, wrong estate — refusing to mutate a resource other than the one this script names.',
    };
  }

  const subs = [...new Set(matching.map((r) => String(r.sub || '')).filter(Boolean))];
  if (subs.length === 0) {
    return {
      ok: false,
      sub: null,
      reason: `'${name}' matched ${matching.length} row(s) in '${rg}' but none carried a subscription id, `
        + 'so the target subscription is UNKNOWN — refusing.',
    };
  }
  if (subs.length > 1) {
    return {
      ok: false,
      sub: null,
      reason: `'${name}' in resource group '${rg}' resolves to ${subs.length} different subscriptions `
        + `(${subs.join(', ')}). An ambiguous answer is no answer — name the subscription explicitly `
        + 'rather than letting this pick one.',
    };
  }
  return { ok: true, sub: subs[0], reason: null };
}

/** `az account show`, reduced to the four fields the guard reads. Never throws. */
export function readAccount(azImpl) {
  try {
    return azImpl(['account', 'show', '--query',
      '{environmentName:environmentName,id:id,name:name,tenantId:tenantId}']);
  } catch (e) {
    // A refusal to produce a value is itself the value the classifier needs; it
    // must never surface as an empty object that reads like a clean answer.
    return { error: String(e?.message || e).slice(0, 240) };
  }
}

/** The IO half of {@link classifySubResolution}. */
function resolveSub(name, rg, type, azImpl) {
  if (!RESOURCE_NAME.test(String(name))) {
    throw new MeasurementError(
      `'${name}' is not a plausible Azure resource name, so it will not be interpolated into a graph query`,
    );
  }
  let rows;
  try {
    const answer = azImpl(['graph', 'query', '-q',
      `resources | where name =~ '${name}' | project sub=subscriptionId, rg=resourceGroup, type`]);
    rows = answer?.data ?? answer;
  } catch (e) {
    // A FAILED QUERY IS NOT AN EMPTY RESULT. Passing null makes the classifier
    // say "UNKNOWN", never "no such resource".
    throw new MeasurementError(
      `could not resolve a subscription for '${name}' — the resource-graph query failed: `
      + `${String(e?.message || e).slice(0, 160)}`,
    );
  }
  const verdict = classifySubResolution({ name, rg, type, rows });
  if (!verdict.ok) throw new MeasurementError(verdict.reason);
  return verdict.sub;
}

/**
 * The whole script, with its IO injected so the guard can be proved
 * BEHAVIOURALLY rather than only by reading the source.
 *
 * That distinction is the point: an exported, unit-tested `classifyBoundary`
 * that `main` forgot to call would pass every test while guarding nothing —
 * this repo's most-repeated defect. The self-test drives THIS function with a
 * fake `az` on a sovereign cloud and asserts the injected `run` was never
 * called, which is the actual property ("fails closed before the first
 * mutation") rather than a proxy for it.
 *
 * @returns {number} the process exit code
 */
export function main({
  argv = process.argv,
  az: azImpl = defaultAz,
  run: runImpl = defaultRun,
  log = emit,
} = {}) {
  const APPLY = argv.includes('--apply');
  const DRY = argv.includes('--dry-run') || !APPLY;

  // ── THE GUARD, BEFORE ANYTHING ELSE ──────────────────────────────────────
  // Ahead of every read as well as every write: a dry-run report about the
  // wrong boundary is the report the operator would then act on.
  const boundary = classifyBoundary(readAccount(azImpl));
  if (!boundary.ok) {
    log(`[REFUSED] estate-resume targets ${BOUNDARY} (${EXPECTED_ENVIRONMENT}) and did NOT run.`);
    log(`[REFUSED] ${boundary.reason}`);
    log(`[REFUSED] measured: environmentName=${boundary.environmentName ?? 'UNKNOWN'} `
      + `subscription=${boundary.subscriptionId ?? 'UNKNOWN'} tenant=${boundary.tenantId ?? 'UNKNOWN'}`);
    log('[REFUSED] Nothing was read and nothing was changed.');
    return 2;
  }

  // Every line carries the boundary and the subscription it is about, so a
  // pasted transcript can never be about an estate nobody can identify.
  //
  // THE CLOUD IN THE TAG IS THE MEASURED ONE, never the constant. Past the guard
  // the two are provably equal — but a tag built from `EXPECTED_ENVIRONMENT`
  // would be a sentence asserting a boundary it did not read, and if the guard
  // above were ever weakened, every line of the transcript would then be a false
  // label rather than a true one under a broken gate. Measured during the
  // mutation proof for this change, where the bypassed guard printed
  // `[Commercial/AzureCloud sub=<a Gov subscription>]`.
  const tag = (sub) => `[${BOUNDARY}/${boundary.environmentName} sub=${sub}]`;
  const session = tag(boundary.subscriptionId);
  const say = (sub, text) => log(`${tag(sub)} ${text}`);

  log(`${session} estate-resume — ${DRY ? 'DRY RUN, nothing will be changed (pass --apply to act)' : 'APPLYING'}`);
  log(`${session} session: subscription '${boundary.subscriptionName ?? '(unnamed)'}' `
    + `tenant ${boundary.tenantId ?? '(none reported)'} — verified ${EXPECTED_ENVIRONMENT} before any call`);

  let changed = 0; let skipped = 0; let failed = 0;

  log(`${session} === Container Apps ===`);
  for (const a of APPS) {
    let sub = null;
    try {
      sub = resolveSub(a.name, a.rg, 'microsoft.app/containerapps', azImpl);
      const before = azImpl(['containerapp', 'show', '-n', a.name, '-g', a.rg, '--subscription', sub,
        '--query', 'properties.template.scale.minReplicas']);
      if (Number(before) >= a.min) {
        say(sub, `${a.name.padEnd(24)} already at ${before} (target ${a.min}) — skip`);
        skipped++; continue;
      }
      if (DRY) {
        say(sub, `${a.name.padEnd(24)} ${before} -> ${a.min}  [would change]`);
        changed++; continue;
      }
      runImpl('az', ['containerapp', 'update', '-n', a.name, '-g', a.rg, '--subscription', sub,
        '--min-replicas', String(a.min)]);
      const after = azImpl(['containerapp', 'show', '-n', a.name, '-g', a.rg, '--subscription', sub,
        '--query', 'properties.template.scale.minReplicas']);
      say(sub, `${a.name.padEnd(24)} ${before} -> ${after} ${Number(after) === a.min ? 'OK' : 'MISMATCH'}`);
      changed++;
    } catch (e) {
      say(sub ?? 'unresolved', `${a.name.padEnd(24)} FAILED: ${String(e.message).slice(0, 200)}`);
      failed++;
    }
  }

  log(`${session} === Analysis Services ===`);
  for (const s of AAS) {
    let sub = null;
    try {
      sub = resolveSub(s.name, s.rg, 'microsoft.analysisservices/servers', azImpl);
      const args = ['resource', 'show', '--resource-type', 'Microsoft.AnalysisServices/servers',
        '-n', s.name, '-g', s.rg, '--subscription', sub, '--query', 'properties.state'];
      const before = azImpl(args);
      if (String(before).toLowerCase() === 'succeeded') {
        say(sub, `${s.name.padEnd(24)} already running — skip`); skipped++; continue;
      }
      if (DRY) {
        say(sub, `${s.name.padEnd(24)} ${before} -> resume  [would change] (${s.note})`);
        changed++; continue;
      }
      runImpl('az', ['resource', 'invoke-action', '--resource-type', 'Microsoft.AnalysisServices/servers',
        '-n', s.name, '-g', s.rg, '--subscription', sub, '--action', 'resume']);
      const after = azImpl(args);
      say(sub, `${s.name.padEnd(24)} ${before} -> ${after} (${s.note})`);
      changed++;
    } catch (e) {
      say(sub ?? 'unresolved', `${s.name.padEnd(24)} FAILED: ${String(e.message).slice(0, 200)}`);
      failed++;
    }
  }

  log(`${session} === ADX ===`);
  {
    let sub = null;
    try {
      sub = resolveSub(ADX.name, ADX.rg, 'microsoft.kusto/clusters', azImpl);
      const before = azImpl(['kusto', 'cluster', 'show', '-n', ADX.name, '-g', ADX.rg,
        '--subscription', sub, '--query', 'state']);
      if (String(before) === 'Running') {
        say(sub, `${ADX.name} already Running — skip`); skipped++;
      } else if (DRY) {
        say(sub, `${ADX.name} ${before} -> Running  [would change]`); changed++;
      } else {
        runImpl('az', ['kusto', 'cluster', 'start', '-n', ADX.name, '-g', ADX.rg,
          '--subscription', sub, '--no-wait']);
        say(sub, `${ADX.name} ${before} -> start dispatched (takes several minutes; re-run to confirm)`);
        changed++;
      }
    } catch (e) {
      say(sub ?? 'unresolved', `${ADX.name} FAILED: ${String(e.message).slice(0, 200)}`);
      failed++;
    }
  }

  log(`${session} ${DRY ? 'WOULD CHANGE' : 'CHANGED'}: ${changed}   already-ok: ${skipped}   FAILED: ${failed}`);
  if (failed > 0) {
    log(`${session} Some actions failed — the estate is PARTIALLY resumed. Re-run to retry; it is idempotent.`);
    return 1;
  }
  log(`${session} NOTE: the Synapse dedicated pool (loompool) was already paused before 2026-08-23 and`);
  log(`${session} is NOT resumed here. Resume it deliberately if you need it — it is the largest line item.`);
  return 0;
}

// Importable without side effects, so the self-test can drive main() with fake
// IO. Before #4149 this file executed on import, which is why its guard had to
// be provable only by reading it.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
