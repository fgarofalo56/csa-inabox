#!/usr/bin/env node
/**
 * estate-pause-state.mjs - is the estate PAUSED, and so must this deploy lane
 * stand down? (PRP-02 step 6, refs #5111 #5099)
 *
 * WHY. 2026-10-24: the operator paused the estate (Estate Power) at 02:38Z. The
 * SCHEDULED deploy-fiab-commercial run at 10:36Z started ADX
 * (Microsoft.Kusto/clusters/start/action 10:51Z) and rewrote the paused
 * Container Apps (containerApps/write 11:04Z), taking minReplicas 0 back to 1.
 * Nothing in the deploy lanes knew the estate was paused.
 *
 * HOW THE STATE IS READ. The pause snapshot lives in a private-endpoint-only
 * Cosmos, which a GitHub-hosted runner cannot reach. The console owns it and is
 * never paused, so this calls the console's service-principal state route
 * (`POST /api/estate/power {action:'state'}`, the SAME call the idle auto-pause
 * lane makes) with the deploy SP's Entra token, reusing scripts/estate-power/*.
 * No new secret and no new role: the deploy SP already holds Estate.Power and the
 * console URL/audience repo variables already exist for the idle lane.
 *
 *   node scripts/ci/estate-pause-state.mjs --boundary Commercial|GCC-High|GCC|IL5
 *
 * Env: CSA_LOOM_CONSOLE_URL, CSA_LOOM_CONSOLE_AUDIENCE (from repo variables),
 *      GITHUB_EVENT_NAME, OVERRIDE_ESTATE_PAUSE ('true' to override; honoured
 *      ONLY on workflow_dispatch), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.
 *
 * OUTPUTS (GITHUB_OUTPUT): state (RUNNING|PAUSING|PAUSED|RESUMING|RESUME_FAILED|
 * UNKNOWN), paused_by, paused_at, standdown ('true'|'false'), reason,
 * measured_state (RUNNING|STOPPED|FAILED).
 *
 * RECONCILE (#5325). The console's recorded state can go STALE: on 2026-11-16 it
 * said PAUSED (since 2026-11-15T04:35:55Z) while Resource Graph showed
 * agw-lhds-dev01 and aks-lhds-dev01 Running and the console served traffic; the
 * estate had been resumed outside the console's resume path, so
 * deploy-fiab-commercial stood down on every scheduled run from 2026-10-24.
 * The recorded state is therefore checked against the MEASURED power state of
 * exactly what the pause stopped: the state body's `resources` array IS the
 * pause snapshot (what `pausePost` resolved from the deploy manifest, the
 * estate-tag Resource Graph sweep and the Container Apps list, #3922), each row
 * with its prePausePowerState. NO tag is relied on: on the live estate the
 * gateway and cluster carry no `loom-estate-id`. Rows that were already stopped
 * before the pause say nothing and are skipped. The rest are looked up by id in
 * Resource Graph (`az graph query`, the cloud the caller logged into) and
 * classified: Application Gateway operationalState, AKS powerState.code,
 * Container App minReplicas (the pause scales to 0 and restores min/max, so
 * min > 0 means resumed; the console itself is never in the snapshot) and ADX
 * state. Other snapshot types are not classifiable from Resource Graph and are
 * ignored.
 *
 *   recorded PAUSED   + measured RUNNING -> RUNNING (record is stale; ::warning::)
 *   recorded PAUSED   + measured STOPPED -> PAUSED  (stand down, as before)
 *   recorded RUNNING (no snapshot, so no inventory) -> measurement FAILED, the
 *                                           record stands (nothing to measure)
 *   recorded PAUSING/RESUMING/RESUME_FAILED/UNKNOWN -> the record stands (a
 *                                           transition in flight reads mixed)
 *   measurement FAILED (az error, extension missing, no inventory, snapshot rows
 *   not found, only unclassifiable rows) -> the record stands and the cause is
 *   printed. A failed query is never read as RUNNING (deploy-integrity.md R7).
 *
 * DECISION (decideStandDown, pure):
 *   - PAUSING / PAUSED  -> stand down, unless an operator override on a
 *     workflow_dispatch run. A schedule / push / workflow_run event can NEVER
 *     override: nobody is there to have meant it.
 *   - RUNNING / RESUMING / RESUME_FAILED -> proceed. RESUMING and RESUME_FAILED
 *     mean the operator is waking the estate; deploying is what they want.
 *   - UNKNOWN on a `schedule` run -> STAND DOWN (fail CLOSED, operator decision
 *     2026-10-24). Run 40113111843: the gate's azure/login hung until the job
 *     timeout, so no state was ever established, and an unattended run was
 *     heading for the ADX preflight that had started ADX during a pause that
 *     morning. A missed daily reconcile is cheap and the next scheduled run
 *     retries; nobody is there to have chosen to risk waking a paused estate.
 *   - UNKNOWN on `workflow_dispatch` -> PROCEED with a loud ::warning:: (fail
 *     OPEN): a human chose to deploy.
 *   - UNKNOWN on any OTHER event (push, workflow_run, ...) -> PROCEED with the
 *     ::warning:: (today's behaviour, deliberately unchanged: the decision named
 *     only schedule vs manual). The read can fail for reasons unrelated to the
 *     estate (console briefly down, variable unset, a greenfield estate with no
 *     console yet) and a broken deploy path is P0 (deploy-integrity.md R1); the
 *     read is retried inside callConsole before giving up.
 *
 * The workflow side of fail-closed (a gate JOB that fails, times out or is
 * cancelled leaves no outputs at all) lives in each lane's `if:` and in
 * estate-pause-gate.yml; this script cannot speak for a job that never reached it.
 *
 * Exit code is ALWAYS 0: this script decides, the workflow acts. It never throws.
 *
 * PUBLICATION-SINKS: 2
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FIELD, ESTATE_STATE } from '../estate-power/contract.mjs';
import { callConsole, endpointUrl } from '../estate-power/estate-power.mjs';
import { acquireToken, defaultSpawn, readActiveCloud, sanitizeLine, scrub } from '../estate-power/token.mjs';

export const UNKNOWN = 'UNKNOWN';
export const STATES = Object.freeze([...Object.values(ESTATE_STATE), UNKNOWN]);
export const STAND_DOWN_STATES = Object.freeze([ESTATE_STATE.pausing, ESTATE_STATE.paused]);

/**
 * Which az cloud each boundary's deploy lane is logged into. GCC is public-cloud
 * Azure under a government-community identity; IL5 and GCC-High are Gov.
 */
export const BOUNDARY_AZ_CLOUD = Object.freeze({
  Commercial: 'AzureCloud',
  GCC: 'AzureCloud',
  'GCC-High': 'AzureUSGovernment',
  IL5: 'AzureUSGovernment',
});

/** Resource types whose power state Resource Graph exposes, with how to read it. */
const GRAPH_TYPES = Object.freeze([
  'microsoft.network/applicationgateways',
  'microsoft.containerservice/managedclusters',
  'microsoft.app/containerapps',
  'microsoft.kusto/clusters',
]);

/** Resource Graph query: the types above, narrowed by the snapshot's resource groups (ids matched client-side). */
export function buildMeasureQuery(groups) {
  const rgs = [...new Set(groups.map((g) => String(g).replace(/[^A-Za-z0-9._()-]/g, '')))].filter(Boolean);
  return `Resources | where type in~ (${GRAPH_TYPES.map((t) => `'${t}'`).join(',')}) | where resourceGroup in~ (${rgs.map((g) => `'${g}'`).join(',')}) `
    + '| project id, name, type, op=tostring(properties.operationalState), power=tostring(properties.powerState.code), '
    + 'minRep=toint(properties.template.scale.minReplicas), kstate=tostring(properties.state)';
}

/** PURE. 'running' | 'stopped' | null (unclassifiable) for one Resource Graph row. */
export function classifyRow(r) {
  const t = String(r?.type ?? '').toLowerCase();
  const lc = (v) => String(v ?? '').toLowerCase();
  if (t === 'microsoft.network/applicationgateways') return ['running', 'starting'].includes(lc(r.op)) ? 'running' : ['stopped', 'stopping'].includes(lc(r.op)) ? 'stopped' : null;
  if (t === 'microsoft.containerservice/managedclusters') return lc(r.power) === 'running' ? 'running' : lc(r.power) === 'stopped' ? 'stopped' : null;
  if (t === 'microsoft.app/containerapps') return typeof r.minRep === 'number' ? (r.minRep > 0 ? 'running' : 'stopped') : null;
  if (t === 'microsoft.kusto/clusters') return lc(r.kstate) === 'running' ? 'running' : lc(r.kstate) === 'stopped' ? 'stopped' : null;
  return null;
}

/**
 * PURE. The pause's own inventory worth measuring: snapshot rows that were
 * running before the pause (a resource already stopped says nothing about
 * whether the estate is paused) and whose type Resource Graph can classify.
 */
export function measurableInventory(inventory) {
  return (Array.isArray(inventory) ? inventory : []).filter((e) => e?.id && GRAPH_TYPES.includes(String(e.type).toLowerCase()) && e.pre === 'Online');
}

/**
 * PURE. Match Resource Graph rows to the inventory by id (case-insensitive) and
 * classify. RUNNING if ANY matched row is running (a partly-running estate is
 * not paused); STOPPED only when at least one matched row is classifiable and
 * none runs; otherwise FAILED (empty / unmatched = failed, never RUNNING).
 */
export function classifyMeasurement(rows, inventory) {
  const want = new Set(measurableInventory(inventory).map((e) => String(e.id).toLowerCase()));
  if (want.size === 0) return { measured: 'FAILED', reason: 'the console state body names no resource that was running before the pause and is measurable (empty inventory is a failed measurement, not RUNNING)', running: [], stopped: [] };
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => want.has(String(r?.id ?? '').toLowerCase()));
  if (mine.length === 0) return { measured: 'FAILED', reason: `Resource Graph returned none of the ${want.size} snapshot resource(s) (deleted, or not visible to this login)`, running: [], stopped: [] };
  const running = []; const stopped = [];
  for (const r of mine) {
    const c = classifyRow(r);
    if (c === 'running') running.push(String(r.name ?? r.id));
    else if (c === 'stopped') stopped.push(String(r.name ?? r.id));
  }
  if (running.length) return { measured: 'RUNNING', running, stopped };
  if (stopped.length) return { measured: 'STOPPED', running, stopped };
  return { measured: 'FAILED', reason: `none of the ${mine.length} matched snapshot row(s) reported a recognisable power state`, running, stopped };
}

/** IO. Measure the pause inventory's power state; NEVER throws. */
export function measureEstate({ boundary, spawn = defaultSpawn, inventory }) {
  const failed = (reason) => ({ measured: 'FAILED', reason, running: [], stopped: [] });
  try {
    const wantCloud = BOUNDARY_AZ_CLOUD[boundary];
    if (!wantCloud) return failed(`unknown boundary ${JSON.stringify(boundary)}`);
    const inv = measurableInventory(inventory);
    if (inv.length === 0) return classifyMeasurement([], inventory);
    const cloud = readActiveCloud(spawn);
    if (cloud.environmentName !== wantCloud) return failed(`az is on cloud ${JSON.stringify(cloud.environmentName)}, not ${wantCloud}`);
    const ext = spawn('az', ['extension', 'add', '--name', 'resource-graph', '--only-show-errors']);
    if (ext.error || ext.status !== 0) return failed(`az extension add resource-graph failed (exit ${ext.status ?? 'none'}): ${String(ext.stderr ?? ext.error ?? '').slice(0, 200)}`);
    const q = buildMeasureQuery(inv.map((e) => e.resourceGroup));
    const r = spawn('az', ['graph', 'query', '--first', '1000', '--query', 'data', '--output', 'json', '-q', q]);
    if (r.error || r.status !== 0) return failed(`az graph query failed (exit ${r.status ?? 'none'}): ${String(r.stderr ?? r.error ?? '').slice(0, 200)}`);
    let rows;
    try { rows = JSON.parse(r.stdout); } catch { return failed('az graph query did not return JSON'); }
    return classifyMeasurement(rows, inventory);
  } catch (e) {
    return failed(`measurement threw: ${e?.message ?? 'unknown'}`);
  }
}

/**
 * PURE. Reconcile the recorded state with the measured one (table in the header).
 * Only PAUSED is ever overridden, and only by a measured RUNNING.
 * @returns {{state:string, stale:boolean, note:string|null}}
 */
export function reconcile({ recorded, measured }) {
  if (recorded === ESTATE_STATE.paused && measured === 'RUNNING') return { state: ESTATE_STATE.running, stale: true, note: 'recorded PAUSED but the resources the pause stopped measurably run' };
  return { state: recorded, stale: false, note: null };
}

/** Events a human started. Everything else (schedule, push, workflow_run...) is unattended. */
export const OVERRIDE_EVENTS = Object.freeze(['workflow_dispatch']);

/** Events where an UNREADABLE state fails CLOSED (stands down): unattended AND recurring. */
export const FAIL_CLOSED_EVENTS = Object.freeze(['schedule']);

const isTrue = (v) => v === true || String(v ?? '').trim().toLowerCase() === 'true';

/**
 * PURE. Map a console `state` body to a verdict about the estate.
 * Anything that is not exactly one of the five known states is UNKNOWN, so a
 * renamed field or an empty body cannot read as RUNNING.
 */
export function interpretState(data) {
  const raw = data?.[FIELD.state];
  const state = typeof raw === 'string' && Object.values(ESTATE_STATE).includes(raw) ? raw : UNKNOWN;
  const pausedAt = data?.pausedAt ?? data?.[FIELD.power]?.[FIELD.lastPausedAt] ?? null;
  // The console's state body does not carry who paused today; `pausedBy` /
  // `createdBy` are read if it ever does. Never invented.
  const pausedBy = data?.pausedBy ?? data?.createdBy ?? null;
  const inventory = (Array.isArray(data?.[FIELD.resources]) ? data[FIELD.resources] : [])
    .filter((r) => r && typeof r.resourceId === 'string' && r.resourceId)
    .map((r) => ({ id: r.resourceId, type: String(r.resourceType ?? ''), name: String(r.name ?? ''), resourceGroup: String(r.resourceGroup ?? ''), pre: String(r.prePausePowerState ?? '') }));
  return {
    state,
    inventory,
    pausedAt: typeof pausedAt === 'string' && pausedAt ? pausedAt : null,
    pausedBy: typeof pausedBy === 'string' && pausedBy ? pausedBy : null,
    ...(state === UNKNOWN ? { reason: `the console returned state ${JSON.stringify(raw ?? null)}, which is not one of ${Object.values(ESTATE_STATE).join('|')}` } : {}),
  };
}

/**
 * PURE. The stand-down decision.
 * @param {{state:string, event?:string, override?:unknown}} p
 * @returns {{standdown:boolean, overridden:boolean, overrideIgnored:boolean, failClosed:boolean}}
 *   `failClosed` is true when the stand-down is because the state is UNKNOWN on a
 *   scheduled run, as opposed to the estate being paused.
 */
export function decideStandDown({ state, event, override }) {
  const wantsOverride = isTrue(override);
  const canOverride = OVERRIDE_EVENTS.includes(String(event ?? ''));
  const paused = STAND_DOWN_STATES.includes(state);
  if (state === UNKNOWN && FAIL_CLOSED_EVENTS.includes(String(event ?? ''))) {
    return { standdown: true, overridden: false, overrideIgnored: wantsOverride && !canOverride, failClosed: true };
  }
  if (!paused) return { standdown: false, overridden: false, overrideIgnored: false, failClosed: false };
  if (wantsOverride && canOverride) return { standdown: false, overridden: true, overrideIgnored: false, failClosed: false };
  return { standdown: true, overridden: false, overrideIgnored: wantsOverride && !canOverride, failClosed: false };
}

/**
 * IO. Read the estate state; NEVER throws and never returns without a state.
 * @returns {Promise<{state:string, pausedAt:string|null, pausedBy:string|null, reason?:string}>}
 */
export async function readEstateState({ boundary, env, spawn = defaultSpawn, fetchFn = globalThis.fetch, sleep }) {
  const unknown = (reason) => ({ state: UNKNOWN, pausedAt: null, pausedBy: null, reason });
  try {
    const wantCloud = BOUNDARY_AZ_CLOUD[boundary];
    if (!wantCloud) return unknown(`unknown boundary ${JSON.stringify(boundary)}`);
    const url = endpointUrl(env.CSA_LOOM_CONSOLE_URL);
    if (!url) return unknown('CSA_LOOM_CONSOLE_URL is not set to an https origin (the repo variable for this boundary is missing)');
    const audience = env.CSA_LOOM_CONSOLE_AUDIENCE;
    if (!audience || !String(audience).trim()) return unknown('CSA_LOOM_CONSOLE_AUDIENCE is not set (the repo variable for this boundary is missing)');
    const cloud = readActiveCloud(spawn);
    if (cloud.environmentName !== wantCloud) {
      return unknown(`az is on cloud ${JSON.stringify(cloud.environmentName)}, not ${wantCloud}; no token was requested`);
    }
    const tok = acquireToken(audience, spawn);
    if (!tok.ok) return unknown(tok.reason);
    const r = await callConsole({
      url, token: tok.token, body: { action: 'state' }, mutating: false, fetchFn,
      sleep: sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))), boundary,
    });
    if (!r.ok) return unknown(scrub(`console state read failed [${r.kind}] after ${r.attempts} attempt(s): ${r.message}`, [tok.token]));
    return interpretState(r.data);
  } catch (e) {
    return unknown(`state read threw: ${e?.message ?? 'unknown'}`);
  }
}

/** PURE. The human-readable lines for a verdict. */
export function renderVerdict({ boundary, state, pausedAt, pausedBy, reason, decision, event }) {
  const who = pausedBy ?? 'not reported by the console state route (see the estate-power.pause audit rows)';
  const when = pausedAt ?? 'unknown';
  const how = 'Resume the estate in Admin > Scale by SKU > Estate power, or dispatch this workflow with override_estate_pause=true.';
  if (decision.failClosed) {
    return {
      level: 'notice', text: `STOOD DOWN: estate state UNKNOWN on a scheduled run: standing down (fail-closed); the next scheduled run retries (${boundary}: ${reason ?? 'unreadable'}).`,
      summary: [
        `### Stood down: estate state could not be established (${boundary})`,
        '',
        '**Nothing was deployed by this run.** Stood down: estate state could not be established on a scheduled run (fail-closed). '
          + `Could not read the estate state (${reason ?? 'unreadable'}). Deploying blind could wake a paused estate; the next scheduled run retries.`,
        '',
        'A manual dispatch is not stopped by an unreadable state (it proceeds with a warning). A stood-down run is NOT a deployed SHA: the deploy staleness check does not count it.',
      ].join('\n'),
    };
  }
  if (decision.standdown) {
    return {
      level: 'notice', text: `STOOD DOWN: the ${boundary} estate is ${state} (paused by ${who} at ${when}). The steps that would wake or rescale paused resources were skipped. ${how}`,
      summary: [
        `### Stood down: estate paused (${boundary})`,
        '',
        `**Nothing was deployed by this run.** The estate is **${state}**, paused by ${who} at ${when}. Deploying now would start ADX and rewrite the paused Container Apps, undoing the pause.`,
        '',
        how,
        '',
        'A stood-down run is NOT a deployed SHA: the deploy staleness check does not count it.',
      ].join('\n'),
    };
  }
  if (decision.overridden) {
    return {
      level: 'warning', text: `OVERRIDE: the ${boundary} estate is ${state} (paused by ${who} at ${when}) and this deploy was dispatched with override_estate_pause=true. It WILL wake or rescale paused resources.`,
      summary: `### Estate pause overridden (${boundary})\nThe estate is **${state}**; this dispatched run proceeds because override_estate_pause=true and will undo parts of the pause.`,
    };
  }
  if (state === UNKNOWN) {
    return {
      level: 'warning', text: `estate-pause-state is UNKNOWN for ${boundary}: ${reason ?? 'unreadable'}. PROCEEDING (fail-open for a dispatch or other non-scheduled event: an unreadable state must not freeze every deploy). If the estate is paused this run WILL wake it.`,
      summary: `### Estate pause state UNKNOWN (${boundary})\nCould not read the estate state (${reason ?? 'unreadable'}). The deploy proceeds; if the estate is paused it will be woken.`,
    };
  }
  const note = decision.overrideIgnored ? ' override_estate_pause was ignored (only a manual dispatch can override).' : '';
  return {
    level: 'notice', text: `estate-pause-state ${boundary}: ${state}; deploy proceeds.${note}`,
    summary: `### Estate pause state (${boundary}): ${state}\nThe deploy proceeds.${note}`,
  };
}

const q = (v) => sanitizeLine(String(v ?? ''));

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const bi = argv.indexOf('--boundary');
  const boundary = bi >= 0 ? argv[bi + 1] : undefined;
  const recorded = await readEstateState({ boundary, env, spawn: deps.spawn, fetchFn: deps.fetchFn, sleep: deps.sleep });
  const m = measureEstate({ boundary, spawn: deps.spawn, inventory: recorded.inventory });
  const rec = reconcile({ recorded: recorded.state, measured: m.measured });
  const read = rec.stale ? { ...recorded, state: rec.state } : recorded;
  const event = env.GITHUB_EVENT_NAME ?? '';
  const decision = decideStandDown({ state: read.state, event, override: env.OVERRIDE_ESTATE_PAUSE });
  const v = renderVerdict({ boundary, ...read, decision, event });
  const outputs = {
    state: read.state,
    paused_by: read.pausedBy ?? '',
    paused_at: read.pausedAt ?? '',
    standdown: decision.standdown ? 'true' : 'false',
    reason: read.reason ?? '',
    measured_state: m.measured,
  };
  const extra = [];
  if (rec.stale) {
    extra.push(`::warning::${sanitizeLine(`estate-pause-state ${boundary}: the console record is STALE (${rec.note}; recorded state ${recorded.state}, paused_at ${recorded.pausedAt ?? 'unknown'}; running: ${m.running.join(', ') || 'none'}; stopped: ${m.stopped.join(', ') || 'none'}). Using the measured state ${rec.state}.`)}`);
  } else if (m.measured === 'FAILED') {
    extra.push(`estate-pause-state ${boundary}: power-state measurement FAILED (${sanitizeLine(m.reason)}); using the console record ${recorded.state} unreconciled.`);
  }
  // Console-supplied text is untrusted: one line, no `::`, before any sink.
  log(`::${v.level}::${sanitizeLine(v.text)}`);
  for (const l of extra) log(l);
  const out = deps.outputFile ?? env.GITHUB_OUTPUT;
  if (out) for (const [k, val] of Object.entries(outputs)) appendFileSync(out, `${k}=${q(val)}\n`);
  const sum = deps.summaryFile ?? env.GITHUB_STEP_SUMMARY;
  if (sum) appendFileSync(sum, `${v.summary.split('\n').map((l) => l.replace(/::/g, ': :')).join('\n')}\n${extra.map((l) => l.replace(/::/g, ': :')).join('\n')}${extra.length ? '\n' : ''}`);
  return { outputs, decision, read, measured: m, reconciled: rec };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    // Last resort: same rule as UNKNOWN. A schedule fails closed; anything else says so and proceeds.
    const closed = FAIL_CLOSED_EVENTS.includes(process.env.GITHUB_EVENT_NAME ?? '');
    process.stdout.write(`::${closed ? 'notice' : 'warning'}::estate-pause-state crashed (${sanitizeLine(e?.message)}); ${closed ? 'STANDING DOWN (scheduled run, fail-closed)' : 'PROCEEDING'}.\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `state=UNKNOWN\nstanddown=${closed}\n`);
  });
}
