'use strict';
/*
 * LoomDeploy@1 — promote content between two stages of a Loom-native
 * deployment pipeline via the Loom REST API. This is the Azure DevOps parity
 * for Fabric's `ms-fabric.fabric-devops-pipelines` deploy task, pointed at the
 * tenant's own Loom Console instead of api.fabric.microsoft.com.
 *
 * Wraps: POST /api/deployment-pipelines/loom/{pipelineId}/deploy
 *   body: { sourceStageId, targetStageId, items?, note? }
 *   → { ok, data: { operationId, status, diff, deployedItemIds, steps } }
 */
const path = require('node:path');
const L = require(path.join(__dirname, '..', 'common', 'loom-http.js'));

async function main() {
  const baseUrl = L.getInput('loomBaseUrl', true);
  const pipelineId = L.getInput('pipelineId', true);
  const sourceStageId = L.getInput('sourceStageId', true);
  const targetStageId = L.getInput('targetStageId', true);
  const userOid = L.getInput('userOid', true);
  const token = L.getInput('loomToken', true);
  const deployMode = (L.getInput('deployMode', false) || 'full').toLowerCase();
  const note = L.getInput('note', false);
  const failOnPartial = L.getBool('failOnPartial');

  const body = { sourceStageId, targetStageId };
  if (note) body.note = note;
  if (deployMode === 'selective') {
    const items = L.parseItemLines(L.getInput('items', false));
    if (!items.length) {
      L.fail(
        'deployMode=selective but no items were supplied. Provide one "itemType:sourceItemId" per line in the items input, or set deployMode=full.',
      );
    }
    body.items = items;
  }

  console.log(
    `##[section]Loom deploy: stage ${sourceStageId} → ${targetStageId} (${deployMode}) on pipeline ${pipelineId}`,
  );

  let res;
  try {
    res = await L.request(
      'POST',
      baseUrl,
      `/api/deployment-pipelines/loom/${encodeURIComponent(pipelineId)}/deploy`,
      token,
      userOid,
      body,
    );
  } catch (e) {
    return L.fail('Request to Loom failed: ' + e.message);
  }

  if (res.status === 401) return L.fail(L.unauthorizedHint());
  if (!res.json || res.json.ok !== true) {
    const err = res.json && res.json.error ? res.json.error : (res.text || '').slice(0, 300);
    return L.fail(`Loom deploy failed (HTTP ${res.status}): ${err}`);
  }

  const d = res.json.data || {};
  const deployed = Array.isArray(d.deployedItemIds) ? d.deployedItemIds : [];
  L.setOutput('operationId', d.operationId || '');
  L.setOutput('status', d.status || '');
  L.setOutput('deployedCount', deployed.length);

  console.log('##[group]Deploy steps');
  for (const step of d.steps || []) console.log('  ' + step);
  console.log('##[endgroup]');
  console.log(`Deployed ${deployed.length} item(s). operationId=${d.operationId} status=${d.status}`);

  if (d.status === 'failed') return L.fail('Deploy status=failed — no items were promoted. See steps above.');
  if (d.status === 'partial') {
    if (failOnPartial) return L.fail('Deploy status=partial and failOnPartial=true. See steps above.');
    L.logWarn('Deploy status=partial — some items deployed, some failed. See steps above.');
    return L.complete('SucceededWithIssues', 'Partial deploy.');
  }
  return L.succeed('Deploy succeeded.');
}

main().catch((e) => L.fail('Unexpected error: ' + ((e && e.stack) || e)));
