/**
 * read-activity.mjs — recent ADF / Synapse pipeline runs for the targets the
 * console state named (nothing hard-coded). EVERY failure is returned as
 * {ok:false, reason}; nothing is swallowed, and the idle policy turns ok:false
 * into a skip.
 */
import { defaultSpawn } from './token.mjs';
import { boundaryInfo, FIELD } from './contract.mjs';

const ADF_ID = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[\w.()-]+\/providers\/Microsoft\.DataFactory\/factories\/[\w-]+$/;
const SYNAPSE_NAME = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
export const MAX_PAGES = 5;

function azRest(spawn, args) {
  const r = spawn('az', ['rest', '--only-show-errors', '--output', 'json', ...args]);
  if (r.error || r.status !== 0) return { ok: false, reason: `az rest failed (exit ${r.status ?? 'none'}): ${String(r.stderr ?? '').trim().slice(0, 300) || 'no stderr'}` };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, reason: 'az rest did not return JSON' };
  }
}

function mapRuns(json) {
  const v = json?.value;
  if (!Array.isArray(v)) return null;
  return v.map((x) => ({ startedAt: x?.runStart ?? x?.runStartTime ?? null, status: x?.status ?? null }));
}

/**
 * @param {object} p
 * @param {Array<{kind:string,id?:string,name?:string}>|undefined} p.targets
 * @param {string} p.boundary
 * @param {Date} p.now
 * @param {number} p.windowHours
 */
export function readRecentPipelineRuns({ targets, boundary, now, windowHours, spawn = defaultSpawn }) {
  const info = boundaryInfo(boundary);
  if (!info) return { ok: false, reason: `unknown boundary '${boundary}'` };
  if (!Array.isArray(targets)) return { ok: false, reason: `the console state carried no ${FIELD.activityTargets} list, so which factory/workspace to read is unknown` };
  if (!Number.isFinite(windowHours) || windowHours <= 0) return { ok: false, reason: 'windowHours is not a positive number' };
  const after = new Date(now.getTime() - windowHours * 3600 * 1000).toISOString();
  const before = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const runs = [];

  for (const t of targets) {
    const kind = String(t?.kind ?? '');
    let url;
    let extra = [];
    if (kind === 'adf') {
      if (!ADF_ID.test(String(t?.id ?? ''))) return { ok: false, reason: `activity target ${JSON.stringify(t?.name ?? t?.id ?? null)} is not a Microsoft.DataFactory factory resource id` };
      url = `${info.arm}${t.id}/queryPipelineRuns?api-version=2018-06-01`;
    } else if (kind === 'synapse') {
      if (!SYNAPSE_NAME.test(String(t?.name ?? ''))) return { ok: false, reason: `activity target ${JSON.stringify(t?.name ?? null)} is not a valid Synapse workspace name` };
      url = `https://${t.name}.${info.synapseDev}/queryPipelineRuns?api-version=2020-12-01`;
      extra = ['--resource', `https://${info.synapseDev}`];
    } else {
      return { ok: false, reason: `activity target kind ${JSON.stringify(kind)} is not supported (adf or synapse)` };
    }

    let token;
    for (let page = 0; page <= MAX_PAGES; page += 1) {
      if (page === MAX_PAGES) return { ok: false, reason: `pipeline run listing for ${t.name ?? t.id} had more than ${MAX_PAGES} pages; refusing to call a partial read idle` };
      const body = { lastUpdatedAfter: after, lastUpdatedBefore: before, ...(token ? { continuationToken: token } : {}) };
      const r = azRest(spawn, ['--method', 'post', '--url', url, '--headers', 'Content-Type=application/json', '--body', JSON.stringify(body), ...extra]);
      if (!r.ok) return { ok: false, reason: `${kind} ${t.name ?? t.id}: ${r.reason}` };
      const page_runs = mapRuns(r.json);
      if (!page_runs) return { ok: false, reason: `${kind} ${t.name ?? t.id}: response had no value array` };
      runs.push(...page_runs);
      token = r.json?.continuationToken;
      if (!token) break;
    }
  }
  return { ok: true, runs };
}
