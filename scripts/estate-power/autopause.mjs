#!/usr/bin/env node
/**
 * autopause.mjs — the scheduled idle auto-pause driver (#4876 step 3).
 *
 *   node scripts/estate-power/autopause.mjs --boundary Commercial|GCC-High [--dry-run]
 *
 * read console state -> read recent pipeline runs -> idle policy -> (pause via
 * the same runPower() the manual CLI uses). One cheap job, no model calls.
 *
 * A SKIP is always visible: the decision and its reason go to stdout and to
 * $GITHUB_STEP_SUMMARY, and an unestablished read is also a ::warning::. Exit
 * 0 on skip, 1 when the state read or the pause itself failed.
 *
 * PUBLICATION-SINKS: 2
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIELD, boundaryInfo, pauseSetOf } from './contract.mjs';
import { acquireToken, assertBoundary, defaultSpawn, sanitizeLine, scrub } from './token.mjs';
import { callConsole, endpointUrl, EXIT, runPower } from './estate-power.mjs';
import { decideIdlePause } from './idle-policy.mjs';
import { discoverActivityTargets, readRecentPipelineRuns } from './read-activity.mjs';
import { classifyPauseDeclaration, PAUSE_DECLARATION_PATH } from '../ci/_estate-pause-declaration.mjs';

const stdoutSink = (s) => process.stdout.write(`${s}\n`);
const stderrSink = (s) => process.stderr.write(`${s}\n`);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Register read: absent/unparseable -> null (the declaration module treats null as NOT declared). */
export function readRegister(root = process.cwd()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, PAUSE_DECLARATION_PATH), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * PURE. The console's server-side pipeline read, normalised to the policy's
 * `{ok, reason?, runs}` shape — or null when the console sent none. A present
 * but malformed block is NOT null: it becomes `ok:false`, so a broken console
 * answer can never fall through to "no runs" and read as idle.
 */
export function consolePipelineActivity(state) {
  const pa = state?.[FIELD.power]?.[FIELD.pipelineActivity];
  if (pa === undefined || pa === null) return null;
  const sources = Array.isArray(pa.sources) ? pa.sources.map(String) : [];
  if (typeof pa !== 'object' || typeof pa.ok !== 'boolean') {
    return { ok: false, reason: 'the console sent a malformed pipelineActivity block', sources };
  }
  if (!pa.ok) return { ok: false, reason: `console: ${String(pa.reason ?? 'no reason reported')}`, sources };
  if (!Array.isArray(pa.runs)) return { ok: false, reason: 'the console reported ok but sent no runs array', sources };
  return { ok: true, runs: pa.runs, sources };
}

export async function runAutopause({ boundary, dryRun = false }, deps = {}) {
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? defaultSpawn;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const sleep = deps.sleep ?? realSleep;
  const nowDate = deps.now ? new Date(deps.now()) : new Date();
  const secrets = [];
  const out = (s) => (deps.out ?? stdoutSink)(scrub(s, secrets));
  const err = (s) => (deps.err ?? stderrSink)(scrub(s, secrets));
  const summary = (s) => {
    const f = deps.summaryFile ?? env.GITHUB_STEP_SUMMARY;
    if (f) fs.appendFileSync(f, `${scrub(s, secrets)}\n`);
  };
  const skip = (decision) => {
    out(`AUTOPAUSE ${boundary}: ${decision.decision.toUpperCase()} (${decision.code}) - ${decision.reason}`);
    summary(`### Estate idle auto-pause (${boundary})\n\nDecision: **${decision.decision}** (${decision.code})\n\n${decision.reason}`);
  };

  if (!boundaryInfo(boundary)) { err('ERROR: --boundary must be Commercial or GCC-High'); return EXIT.USAGE; }
  const url = endpointUrl(env.CSA_LOOM_CONSOLE_URL);
  if (!url) { err('ERROR: CSA_LOOM_CONSOLE_URL must be an https origin with no credentials and no path'); return EXIT.USAGE; }

  const cloud = assertBoundary(boundary, spawn);
  if (!cloud.ok) { err(`ERROR: refusing to act on ${boundary}: ${cloud.reason}. No token was requested and no console call was made.`); return EXIT.BOUNDARY; }
  const tok = acquireToken(env.CSA_LOOM_CONSOLE_AUDIENCE, spawn);
  if (!tok.ok) { err(`ERROR: ${tok.reason}`); return EXIT.FAILED; }
  secrets.push(tok.token);

  const st = await callConsole({ url, token: tok.token, body: { action: 'state' }, mutating: false, fetchFn, sleep, boundary });
  if (!st.ok) {
    err(`ERROR: state read failed [${st.kind}] after ${st.attempts} attempt(s): ${st.message}`);
    err(`REMEDIATION: ${st.remediation}`);
    return EXIT.FAILED;
  }
  const state = st.data;

  const declared = classifyPauseDeclaration({
    register: deps.register !== undefined ? deps.register : readRegister(),
    boundary,
    today: nowDate.toISOString().slice(0, 10),
  });

  // Cheap pass first: pipeline activity can only ADD a skip, so when the console
  // fields alone say skip there is no reason to spend ARM calls on the reads.
  const cheap = decideIdlePause({ state, activity: { ok: true, runs: [] }, now: nowDate, declared });
  if (cheap.decision !== 'pause') {
    skip(cheap);
    return EXIT.OK;
  }

  // Prefer the console's SERVER-SIDE read: the runner cannot reach a private
  // Synapse endpoint (PublicNetworkAccessDenied, run 39242926745). Fall back to
  // the runner read only when the console did not send one (older console).
  const fromConsole = consolePipelineActivity(state);
  let activity;
  if (fromConsole) {
    activity = fromConsole;
    out(`pipeline activity: read by the console (sources: ${fromConsole.sources.join(', ') || 'none configured'})`);
  } else {
    const windowHours = Number(state[FIELD.power]?.[FIELD.autoPause]?.[FIELD.autoPauseIdleHours]);
    const found = discoverActivityTargets({ state, spawn });
    activity = found.ok
      ? readRecentPipelineRuns({ targets: found.targets, boundary, now: nowDate, windowHours, spawn })
      : found;
    out('pipeline activity: read from the runner (the console sent none)');
  }
  if (!activity.ok) out(`::warning::pipeline activity not established: ${sanitizeLine(scrub(activity.reason, secrets))}`);

  const decision = decideIdlePause({ state, activity, now: nowDate, declared });
  skip(decision);
  if (decision.decision !== 'pause') return EXIT.OK;

  // The typed confirmation the console demands is the estate id (handlePausePost).
  const estateId = state[FIELD.estateId];
  if (typeof estateId !== 'string' || estateId === '') {
    err('ERROR: the state response carried no estateId, which is the typed pause confirmation; nothing was sent.');
    return EXIT.FAILED;
  }
  out(`pausing ${pauseSetOf(state)?.length ?? 'an unreported number of'} resource(s) via the console.`);
  return runPower({ boundary, action: 'pause', dryRun, confirm: estateId, timeoutMin: 20 }, { ...deps, env, spawn, fetchFn, sleep });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--boundary');
  const boundary = i >= 0 ? argv[i + 1] : null;
  runAutopause({ boundary, dryRun: argv.includes('--dry-run') }).then((c) => { process.exitCode = c; });
}
