'use strict';
/*
 * LoomListPipelines@1 — list the tenant's Loom-native deployment pipelines (a
 * "management" verb so a pipeline can discover the pipeline/stage ids it needs
 * to feed LoomDeploy / LoomCompare). Optionally fails when a named pipeline is
 * not found.
 *
 * Wraps: GET /api/deployment-pipelines/loom
 *   → { ok, data: { pipelines: LoomPipeline[] } }
 */
const path = require('node:path');
const L = require(path.join(__dirname, '..', 'common', 'loom-http.js'));

async function main() {
  const baseUrl = L.getInput('loomBaseUrl', true);
  const userOid = L.getInput('userOid', true);
  const token = L.getInput('loomToken', true);
  const expectName = L.getInput('expectPipelineName', false);

  console.log('##[section]Loom: list deployment pipelines');

  let res;
  try {
    res = await L.request('GET', baseUrl, '/api/deployment-pipelines/loom', token, userOid, null);
  } catch (e) {
    return L.fail('Request to Loom failed: ' + e.message);
  }

  if (res.status === 401) return L.fail(L.unauthorizedHint());
  if (!res.json || res.json.ok !== true) {
    const err = res.json && res.json.error ? res.json.error : (res.text || '').slice(0, 300);
    return L.fail(`Loom list failed (HTTP ${res.status}): ${err}`);
  }

  const pipelines = (res.json.data && res.json.data.pipelines) || [];
  L.setOutput('pipelineCount', pipelines.length);

  console.log('##[group]Pipelines');
  for (const p of pipelines) {
    const stages = (p.stages || []).map((st) => `${st.displayName}(${st.id})`).join(' → ');
    console.log(`  ${p.displayName} [${p.id}] : ${stages}`);
  }
  console.log('##[endgroup]');
  console.log(`Found ${pipelines.length} pipeline(s).`);

  if (expectName) {
    const match = pipelines.find((p) => p.displayName === expectName);
    if (!match) {
      return L.fail(`Expected pipeline "${expectName}" was not found among ${pipelines.length} pipeline(s).`);
    }
    L.setOutput('matchedPipelineId', match.id);
    console.log(`Matched pipeline "${expectName}" → id ${match.id}`);
  }

  return L.succeed(`Listed ${pipelines.length} pipeline(s).`);
}

main().catch((e) => L.fail('Unexpected error: ' + ((e && e.stack) || e)));
