/**
 * _w0-mcp.mjs - family `mcp` (PRP item W0-3).
 *
 * Question: does this boundary serve the MCP API type (`type: mcp`) at
 * `2025-09-01-preview`, what does its `mcpProperties` look like once APIM has
 * created a passthrough MCP API, can an API-scoped policy be PUT on it, and can
 * a blank-path API carry a `.well-known/...` operation?
 *
 * Everything here is MANAGEMENT-PLANE (ARM). No call goes through the gateway, so
 * no cell is data-plane and an unreachable gateway does not affect this family.
 *
 * ONE DEVIATION FROM THE PRP TEXT, FOUND IN LEARN. The PRP says
 * `GET .../apis?api-version=2025-09-01-preview&$filter=type eq 'mcp'`. Learn's
 * "Api - List By Service" page for 2025-09-01-preview lists the supported
 * `$filter` fields as name, displayName, description, serviceUrl, path and
 * isCurrent - NOT `type`. The probe issues the type filter exactly as written and
 * quotes the status verbatim, AND lists the APIs unfiltered and counts
 * `properties.type == 'mcp'` itself. The CONTROL is "a list call answers 200 with
 * value[]": satisfied by the filtered call, else by the unfiltered one. A 400 from
 * the filter is then a measured fact about the filter, not a failed control (a
 * control that cannot pass is the failure mode assertion-design.md records).
 *
 * THE CREATE BODY IS NOT OBSERVED. Variant A (what the portal's "existing MCP
 * server" form implies): type + path + serviceUrl + mcpProperties.transportType,
 * no endpoints, so whatever `endpoints` the GET-back shows is APIM's own. Variant B
 * (the Learn REST sample `ApiManagementCreateMcpApi`, which sends endpoints) is
 * tried only if A is rejected. Every attempt is recorded verbatim. If the create
 * is rejected in BOTH clouds that is an INSTRUMENT defect, not a finding - a
 * per-run script cannot see the other cloud, so each cell carries that rule.
 *
 * GROUNDING (Learn, fetched 2026-10-29)
 *   API create body incl. `type: "mcp"`, `mcpProperties{transportType, endpoints[{name,uriTemplate}]}`
 *   (sample ApiManagementCreateMcpApi, 2025-09-01-preview), and the response echoing mcpProperties:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api/create-or-update
 *   transportType enum 'sse' | 'streamable', endpoint uriTemplate must start with '/':
 *     https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/apis?pivots=deployment-language-bicep
 *   List filter fields:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api/list-by-service
 *   Passthrough MCP server (base URL https://learn.microsoft.com/api/mcp, Streamable HTTP default) and the
 *   MCP-scope policy example (rate-limit-by-key + trace with metadata):
 *     https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server
 *   Operation PUT body (displayName, method, urlTemplate - all required), 2024-05-01:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api-operation/create-or-update
 */
import {
  API, armUrl, getApi, getOperation, isApiVersionError, listAll, measured, notMeasured, putAndReadBack,
  putApi, putApiPolicy, getApiPolicyRaw, putOperation, quote, reasonForFailure, unknown, waitProvisioned,
  withScratch,
} from './_w0-core.mjs';

const F = 'mcp';
const id = (s) => `${F}.${s}`;

export const CELL_IDS = Object.freeze([
  'list.typeFilter', 'list.mcpApiCount', 'create.passthrough', 'create.mcpProperties',
  'create.policy', 'blankPath.api', 'blankPath.wellKnownOperation', 'cleanup',
].map(id));

const MCP_API_ID = 'w0-apiplane-mcp-api';
const WK_API_ID = 'w0-apiplane-mcp-wk';
const WK_OP_ID = 'w0-apiplane-mcp-wk-op';
const WK_URL = '/.well-known/w0-apiplane-probe';
const PREVIEW = API.apimPreview;
const ROLE_READ = 'API Management Service Reader';
const ROLE_WRITE = 'API Management Service Contributor';
const CROSS_RUN_RULE = 'PRP W0-3: a create body rejected in BOTH clouds is an instrument defect (unknown:tooling-error), not a finding; this single run cannot see the other cloud';

/** SYNTHETIC (from the Learn REST sample), not observed. */
export const MCP_BODY_A = Object.freeze({
  type: 'mcp',
  path: 'w0-apiplane-mcp',
  displayName: MCP_API_ID,
  description: 'w0-apiplane scratch MCP API (deleted in the same run)',
  protocols: ['https'],
  serviceUrl: 'https://learn.microsoft.com/api/mcp',
  subscriptionRequired: true,
  mcpProperties: { transportType: 'streamable' },
});
export const MCP_BODY_B = Object.freeze({
  ...MCP_BODY_A,
  mcpProperties: { transportType: 'streamable', endpoints: [{ name: 'message', uriTemplate: '/mcp/messages' }] },
});

/** SYNTHETIC (from the Learn MCP page): the policy the page shows for an MCP server. */
export const MCP_POLICY = '<policies><inbound><base /><rate-limit-by-key calls="5" renewal-period="30" counter-key="@(context.Request.IpAddress)" />'
  + '<trace source="w0-apiplane-mcp" severity="information"><message>w0-apiplane probe</message><metadata name="agent-id" value="n/a" /></trace>'
  + '</inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>';

/** The cell a failed preview-version call implies, or null when it is a verdict-bearing answer. */
function structuralOrFailure(cellId, res, role) {
  if (isApiVersionError(res.status, res.errorCode, res.errorMessage)) {
    return notMeasured(cellId, 'api-version-unsupported-in-boundary', { evidence: { ...quote(res), apiVersion: PREVIEW } });
  }
  const reason = reasonForFailure(res, { role, scope: 'apim' });
  return reason ? unknown(cellId, reason, { evidence: quote(res) }) : null;
}

async function listCells(ctx, cells, controls) {
  const filter = `$filter=${encodeURIComponent("type eq 'mcp'")}`;
  const filtered = await ctx.client.request({ service: 'arm', url: armUrl(ctx, '/apis', PREVIEW, filter) });
  const unfiltered = await listAll(ctx, armUrl(ctx, '/apis', PREVIEW));
  const filteredOk = filtered.ok && Array.isArray(filtered.json?.value);

  // ---- the type-filter call, quoted as the PRP wrote it ----
  const cellId = id('list.typeFilter');
  if (filteredOk) {
    cells.push(measured(cellId, `type filter accepted; ${filtered.json.value.length} MCP API(s) returned`, { http: filtered.status, evidence: { count: filtered.json.value.length } }));
  } else if (filtered.ok) {
    cells.push(unknown(cellId, 'tooling-error', { evidence: { note: 'HTTP 200 without value[]', status: filtered.status } }));
  } else {
    const s = structuralOrFailure(cellId, filtered, ROLE_READ);
    cells.push(s ?? measured(cellId, 'rejected (the type filter was not accepted)', {
      http: filtered.status,
      evidence: { ...quote(filtered), learnFilterFields: 'name, displayName, description, serviceUrl, path, isCurrent (Learn api/list-by-service 2025-09-01-preview) - not type' },
    }));
  }

  // ---- the unfiltered list, counted client-side ----
  const countId = id('list.mcpApiCount');
  if (unfiltered.ok) {
    const mcp = unfiltered.items.filter((a) => a?.properties?.type === 'mcp').length;
    cells.push(measured(countId, `${mcp} of ${unfiltered.items.length} API(s) are type mcp`, { http: unfiltered.last.status, evidence: { total: unfiltered.items.length, mcp, truncated: unfiltered.truncated } }));
  } else if (unfiltered.malformed) {
    cells.push(unknown(countId, 'tooling-error', { evidence: { note: 'HTTP 200 without value[]' } }));
  } else {
    cells.push(structuralOrFailure(countId, unfiltered.last, ROLE_READ)
      ?? unknown(countId, 'tooling-error', { evidence: quote(unfiltered.last) }));
  }

  // ---- CONTROL: some list call answers 200 with value[] ----
  let status;
  let detail;
  if (filteredOk) { status = 'passed'; detail = 'the type-filtered list answered 200 with value[]'; }
  else if (unfiltered.ok) { status = 'passed'; detail = 'the type filter was not accepted; the unfiltered list answered 200 with value[] and serves as the control'; }
  else if ((filtered.ok && !filteredOk) || unfiltered.malformed) { status = 'failed'; detail = 'a list call answered 200 without value[]: not an API list'; }
  else { status = 'unrunnable'; detail = `no list call answered (filtered HTTP ${filtered.status ?? 'network'}, unfiltered HTTP ${unfiltered.last?.status ?? 'network'})`; }
  controls.push({ id: 'a-list-call-answers-200-with-value', status, detail });
}

async function createCells(ctx, cells) {
  const attempts = [];
  let put = null;
  for (const [variant, body] of [['A: transportType only', MCP_BODY_A], ['B: Learn sample with endpoints', MCP_BODY_B]]) {
    put = await putApi(ctx, MCP_API_ID, body, PREVIEW);
    attempts.push({ variant, ...quote(put), sent: body });
    const stop = put.ok || put.transientExhausted || [401, 403].includes(put.status) || isApiVersionError(put.status, put.errorCode, put.errorMessage);
    if (stop) break;
  }
  const cid = id('create.passthrough');
  const mid = id('create.mcpProperties');
  const pid = id('create.policy');

  if (!put.ok) {
    const s = structuralOrFailure(cid, put, ROLE_WRITE);
    cells.push(s ?? measured(cid, 'rejected', { http: put.status, evidence: { attempts, crossRunRule: CROSS_RUN_RULE } }));
    const dep = (cellId) => (s
      ? { ...s, id: cellId, evidence: { dependsOn: cid, ...s.evidence } }
      : unknown(cellId, 'tooling-error', { evidence: { note: 'not attempted: the MCP API create was rejected', dependsOn: cid } }));
    cells.push(dep(mid), dep(pid));
    return;
  }

  const w = await waitProvisioned(ctx, () => getApi(ctx, MCP_API_ID, PREVIEW));
  if (w.state === 'read-failed') {
    const r = reasonForFailure(w.last, { role: ROLE_READ, scope: 'apim' }) ?? 'tooling-error';
    cells.push(measured(cid, 'accepted (read-back failed: type unconfirmed)', { http: put.status, evidence: { attempts, readBack: quote(w.last) } }));
    cells.push(unknown(mid, r, { evidence: { readBack: quote(w.last) } }));
  } else {
    const props = w.last.json?.properties ?? {};
    const retained = props.type === 'mcp';
    cells.push(retained
      ? measured(cid, 'accepted (type mcp retained)', { http: [put.status, w.last.status], evidence: { attempts, usedVariant: attempts[attempts.length - 1].variant, provisioningState: w.state } })
      : measured(cid, 'rejected (silently dropped)', { http: [put.status, w.last.status], evidence: { attempts, gotType: props.type ?? null, hasMcpProperties: props.mcpProperties !== undefined, crossRunRule: CROSS_RUN_RULE } }));
    cells.push(props.mcpProperties !== undefined && props.mcpProperties !== null
      ? measured(mid, props.mcpProperties, { http: w.last.status, evidence: { note: 'verbatim GET-back of properties.mcpProperties; its shape was unknown a priori' } })
      : measured(mid, 'absent from the GET-back', { http: w.last.status, evidence: { gotType: props.type ?? null } }));
  }

  // ---- API-scoped policy on the MCP API ----
  const a = await putAndReadBack(ctx, {
    put: () => putApiPolicy(ctx, MCP_API_ID, MCP_POLICY, PREVIEW),
    read: () => getApiPolicyRaw(ctx, MCP_API_ID, PREVIEW),
    xml: MCP_POLICY,
    count: ['rate-limit-by-key', 'trace'],
  });
  // diagnostics first, the long sent XML last: the markdown evidence column is capped
  const base = { put: quote(a.put), getBack: a.counts ?? null, note: a.note ?? null, sent: MCP_POLICY };
  if (a.outcome === 'unknown') {
    cells.push(unknown(pid, a.reason, { evidence: base }));
  } else if (a.outcome === 'accepted') {
    cells.push(measured(pid, 'accepted', { http: [a.put.status, a.get.status], evidence: base }));
  } else if (a.outcome === 'silent-drop') {
    cells.push(measured(pid, 'rejected (silently dropped)', { http: [a.put.status, a.get.status], evidence: { ...base, dropped: a.mismatched } }));
  } else if (isApiVersionError(a.put.status, a.put.errorCode, a.put.errorMessage)) {
    cells.push(notMeasured(pid, 'api-version-unsupported-in-boundary', { evidence: base }));
  } else {
    cells.push(measured(pid, 'rejected', { http: a.put.status, evidence: base }));
  }
}

async function blankPathCells(ctx, cells) {
  const aid = id('blankPath.api');
  const oid = id('blankPath.wellKnownOperation');
  const sentApi = { displayName: WK_API_ID, path: '', protocols: ['https'], subscriptionRequired: true };
  const api = await putApi(ctx, WK_API_ID, sentApi);
  const early = reasonForFailure(api, { role: ROLE_WRITE, scope: 'apim' });
  if (early) {
    cells.push(unknown(aid, early, { evidence: { sent: sentApi, put: quote(api) } }), unknown(oid, early, { evidence: { dependsOn: aid } }));
    return;
  }
  if (!api.ok) {
    cells.push(measured(aid, 'rejected', { http: api.status, evidence: { sent: sentApi, put: quote(api), note: 'a path conflict with an existing blank-path API in this estate would also look like this; the message is quoted verbatim' } }));
    cells.push(unknown(oid, 'tooling-error', { evidence: { note: 'not attempted: the blank-path API PUT was rejected', dependsOn: aid } }));
    return;
  }
  cells.push(measured(aid, 'accepted (blank path)', { http: api.status, evidence: { sent: sentApi } }));

  const sentOp = { displayName: 'w0-apiplane well-known', method: 'GET', urlTemplate: WK_URL };
  const op = await putOperation(ctx, WK_API_ID, WK_OP_ID, sentOp);
  const opEarly = reasonForFailure(op, { role: ROLE_WRITE, scope: 'apim' });
  if (opEarly) { cells.push(unknown(oid, opEarly, { evidence: { sent: sentOp, put: quote(op) } })); return; }
  if (!op.ok) { cells.push(measured(oid, 'rejected', { http: op.status, evidence: { sent: sentOp, put: quote(op) } })); return; }
  const back = await getOperation(ctx, WK_API_ID, WK_OP_ID);
  if (!back.ok) {
    cells.push(unknown(oid, reasonForFailure(back, { role: ROLE_READ, scope: 'apim' }) ?? 'tooling-error', { evidence: { sent: sentOp, put: quote(op), get: quote(back) } }));
    return;
  }
  const got = back.json?.properties?.urlTemplate;
  cells.push(got === WK_URL
    ? measured(oid, 'accepted (urlTemplate retained)', { http: [op.status, back.status], evidence: { sent: sentOp, gotUrlTemplate: got } })
    : measured(oid, 'rejected (silently dropped or altered)', { http: [op.status, back.status], evidence: { sent: sentOp, gotUrlTemplate: got ?? null } }));
}

/**
 * @param {object} ctx
 * @param {{cells:Array, controls:Array}} acc
 */
export async function run(ctx, acc) {
  await withScratch(ctx, F, acc, async () => {
    await listCells(ctx, acc.cells, acc.controls);
    await createCells(ctx, acc.cells);
    await blankPathCells(ctx, acc.cells);
  });
}
