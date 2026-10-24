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
 * UNKNOWN), paused_by, paused_at, standdown ('true'|'false'), reason.
 *
 * DECISION (decideStandDown, pure):
 *   - PAUSING / PAUSED  -> stand down, unless an operator override on a
 *     workflow_dispatch run. A schedule / push / workflow_run event can NEVER
 *     override: nobody is there to have meant it.
 *   - RUNNING / RESUMING / RESUME_FAILED -> proceed. RESUMING and RESUME_FAILED
 *     mean the operator is waking the estate; deploying is what they want.
 *   - UNKNOWN -> PROCEED with a loud ::warning::. This FAILS OPEN on purpose. The
 *     read can fail for reasons unrelated to the estate (console briefly down,
 *     variable unset, token refused, a greenfield estate with no console yet).
 *     If an unreadable state froze deploys, one transient console fault would
 *     stop every lane, and a broken deploy path is P0 (deploy-integrity.md R1).
 *     The price is that an unreadable read during a pause lets the old
 *     behaviour through; the warning says so, and the state read is
 *     retried inside callConsole before giving up.
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

/** Events a human started. Everything else (schedule, push, workflow_run...) is unattended. */
export const OVERRIDE_EVENTS = Object.freeze(['workflow_dispatch']);

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
  return {
    state,
    pausedAt: typeof pausedAt === 'string' && pausedAt ? pausedAt : null,
    pausedBy: typeof pausedBy === 'string' && pausedBy ? pausedBy : null,
    ...(state === UNKNOWN ? { reason: `the console returned state ${JSON.stringify(raw ?? null)}, which is not one of ${Object.values(ESTATE_STATE).join('|')}` } : {}),
  };
}

/**
 * PURE. The stand-down decision.
 * @param {{state:string, event?:string, override?:unknown}} p
 * @returns {{standdown:boolean, overridden:boolean, overrideIgnored:boolean}}
 */
export function decideStandDown({ state, event, override }) {
  const wantsOverride = isTrue(override);
  const canOverride = OVERRIDE_EVENTS.includes(String(event ?? ''));
  const paused = STAND_DOWN_STATES.includes(state);
  if (!paused) return { standdown: false, overridden: false, overrideIgnored: false };
  if (wantsOverride && canOverride) return { standdown: false, overridden: true, overrideIgnored: false };
  return { standdown: true, overridden: false, overrideIgnored: wantsOverride && !canOverride };
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
      level: 'warning', text: `estate-pause-state is UNKNOWN for ${boundary}: ${reason ?? 'unreadable'}. PROCEEDING (fail-open: an unreadable state must not freeze every deploy). If the estate is paused this run WILL wake it.`,
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
  const read = await readEstateState({ boundary, env, spawn: deps.spawn, fetchFn: deps.fetchFn, sleep: deps.sleep });
  const event = env.GITHUB_EVENT_NAME ?? '';
  const decision = decideStandDown({ state: read.state, event, override: env.OVERRIDE_ESTATE_PAUSE });
  const v = renderVerdict({ boundary, ...read, decision, event });
  const outputs = {
    state: read.state,
    paused_by: read.pausedBy ?? '',
    paused_at: read.pausedAt ?? '',
    standdown: decision.standdown ? 'true' : 'false',
    reason: read.reason ?? '',
  };
  // Console-supplied text is untrusted: one line, no `::`, before any sink.
  log(`::${v.level}::${sanitizeLine(v.text)}`);
  const out = deps.outputFile ?? env.GITHUB_OUTPUT;
  if (out) for (const [k, val] of Object.entries(outputs)) appendFileSync(out, `${k}=${q(val)}\n`);
  const sum = deps.summaryFile ?? env.GITHUB_STEP_SUMMARY;
  if (sum) appendFileSync(sum, `${v.summary.split('\n').map((l) => l.replace(/::/g, ': :')).join('\n')}\n`);
  return { outputs, decision, read };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    // Last resort: still fail open, still say so.
    process.stdout.write(`::warning::estate-pause-state crashed (${sanitizeLine(e?.message)}); PROCEEDING.\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'state=UNKNOWN\nstanddown=false\n');
  });
}
