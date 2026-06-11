'use strict';
/*
 * LoomCompare@1 — content-level diff between two stages of a Loom-native
 * deployment pipeline. Useful as a pre-deploy gate: fail the build when the
 * target stage is out of sync with the source.
 *
 * Wraps: GET /api/deployment-pipelines/loom/{pipelineId}/compare?source=&target=
 *   → { ok, data: { sourceStageId, targetStageId, pairs, summary } }
 *   summary = { same, different, onlyInSource, notInSource }
 */
const path = require('node:path');
const L = require(path.join(__dirname, '..', 'common', 'loom-http.js'));

async function main() {
  const baseUrl = L.getInput('loomBaseUrl', true);
  const pipelineId = L.getInput('pipelineId', true);
  const source = L.getInput('sourceStageId', true);
  const target = L.getInput('targetStageId', true);
  const userOid = L.getInput('userOid', true);
  const token = L.getInput('loomToken', true);
  const failOnDifferences = L.getBool('failOnDifferences');

  console.log(`##[section]Loom compare: stage ${source} vs ${target} on pipeline ${pipelineId}`);

  const qs = `?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`;
  let res;
  try {
    res = await L.request(
      'GET',
      baseUrl,
      `/api/deployment-pipelines/loom/${encodeURIComponent(pipelineId)}/compare${qs}`,
      token,
      userOid,
      null,
    );
  } catch (e) {
    return L.fail('Request to Loom failed: ' + e.message);
  }

  if (res.status === 401) return L.fail(L.unauthorizedHint());
  if (!res.json || res.json.ok !== true) {
    const err = res.json && res.json.error ? res.json.error : (res.text || '').slice(0, 300);
    return L.fail(`Loom compare failed (HTTP ${res.status}): ${err}`);
  }

  const d = res.json.data || {};
  const s = d.summary || { same: 0, different: 0, onlyInSource: 0, notInSource: 0 };
  const differences = (s.different || 0) + (s.onlyInSource || 0) + (s.notInSource || 0);

  L.setOutput('same', s.same || 0);
  L.setOutput('different', s.different || 0);
  L.setOutput('onlyInSource', s.onlyInSource || 0);
  L.setOutput('notInSource', s.notInSource || 0);
  L.setOutput('differences', differences);

  console.log('##[group]Item-level diff');
  for (const p of d.pairs || []) {
    const name = p.displayName || p.name || p.sourceItemId || '(unknown)';
    console.log(`  [${p.status}] ${p.itemType || ''} ${name}${p.detail ? ' — ' + p.detail : ''}`);
  }
  console.log('##[endgroup]');
  console.log(
    `Same=${s.same} Different=${s.different} OnlyInSource=${s.onlyInSource} NotInSource=${s.notInSource} (total differences=${differences})`,
  );

  if (differences > 0 && failOnDifferences) {
    return L.fail(`${differences} difference(s) found and failOnDifferences=true.`);
  }
  if (differences > 0) {
    L.logWarn(`${differences} difference(s) found between ${source} and ${target}.`);
    return L.complete('SucceededWithIssues', `${differences} difference(s).`);
  }
  return L.succeed('Stages are in sync (0 differences).');
}

main().catch((e) => L.fail('Unexpected error: ' + ((e && e.stack) || e)));
