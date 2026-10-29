/**
 * Offline tests for scripts/measure/apiplane/w0-apim-probe.mjs (the W0 measurement
 * instrument of PRPs/active/loom-api-gateway-plane). Run:
 *   node --test "scripts/measure/apiplane/**\/*.test.mjs"
 * (`node --test scripts/measure/apiplane/` treats a directory as a FILE on Node 24 and fails
 * whatever the tests say; the glob form is the one that works.)
 *
 * assertion-design.md: every test states the input that would break it ("BREAKS IF").
 * A test that claims to catch a defect has been run against that defect in a SANDBOX COPY
 * (see the PR body for the mutation receipts); the tracked tree is never mutated.
 *
 * ALL FIXTURES ARE "SYNTHETIC (from Learn example), not observed": the fake APIM / Graph /
 * Monitor below is a model of what the Learn REST references describe, written by the same
 * author as the probe. It proves the probe REACTS correctly to those shapes; only the first
 * live Commercial run says whether Azure really answers that way.
 *
 * Nothing here touches the network, `az`, the clock or the disk: fetch, clock, sleep, DNS,
 * the token source and the file system are all injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from '../_w0-core.mjs';
import * as probe from '../w0-apim-probe.mjs';
import * as telemetry from '../_w0-telemetry.mjs';
import * as policies from '../_w0-policies.mjs';
import * as mcp from '../_w0-mcp.mjs';
import * as identity from '../_w0-identity.mjs';
import * as latency from '../_w0-latency.mjs';
import * as foundry from '../_w0-foundry.mjs';
import { parseWorkflow } from '../../../ci/_workflow-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_DIR = resolve(HERE, '..');
/** Exact membership of a token audience: array equality, never a URL substring test. */
const sawAudience = (est, audience) => est.audiences.some((a) => a === audience);
const WORKFLOW_DIR = resolve(HERE, '../../../../.github/workflows');

// ---------------------------------------------------------------------------
// fixtures: every GUID, address and token below is a NEEDLE the output must not carry
// ---------------------------------------------------------------------------
const SUB = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const TENANT = 'cccccccc-4444-5555-6666-dddddddddddd';
const PRINCIPAL = 'eeeeeeee-7777-8888-9999-ffffffffffff';
const GRAPH_SP_OBJECT = '12345678-aaaa-bbbb-cccc-1234567890ab';
const ROLE_DIRECTORY = '0a0a0a0a-1111-4222-8333-444444444444';
const ROLE_USER = '0b0b0b0b-1111-4222-8333-444444444444';
const ROLE_AGENT_RO = '0c0c0c0c-1111-4222-8333-444444444444';
const ROLE_AGENT_RW = '0d0d0d0d-1111-4222-8333-444444444444';
const OTHER_SP_OBJECT = '99999999-aaaa-bbbb-cccc-999999999999';
const WORKSPACE_CUSTOMER = 'ffffffff-0000-1111-2222-333333333333';
const IP_PUBLIC = '203.0.113.7'; // TEST-NET-3, documentation range
const IP_PRIVATE = '10.20.30.40';
const TOKEN = ['fixture', 'bearer', 'abcd', '1234', 'wxyz'].join('-'); // plain on purpose: redactSecrets cannot recognise it; assembled at run time so no key-shaped literal sits in the repo
// Assembled at runtime from fake segments so no JWT-shaped literal sits in the repo (gitleaks).
const JWT = ['eyJhbGciOiJGQUtFIn0', 'eyJzdWIiOiJmYWtlLXN1YmplY3QifQ', 'ZmFrZS1zaWduYXR1cmUtdmFsdWU'].join('.');

const APIM_NAME = 'apim-fixture';
const RG = 'rg-fixture';
const WS_RESOURCE_ID = `/subscriptions/${SUB}/resourcegroups/${RG}/providers/microsoft.operationalinsights/workspaces/law-fixture`;
const GATEWAY_ORIGIN = `https://${APIM_NAME}.azure-api.net`;
const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';

const apimArm = (name, extra = {}) => ({
  id: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ApiManagement/service/${name}`,
  name,
  location: 'Central US',
  sku: { name: 'PremiumV2', capacity: 1 },
  properties: {
    provisioningState: 'Succeeded',
    gatewayUrl: `https://${name}.azure-api.net`,
    virtualNetworkType: 'Internal',
    publicNetworkAccess: 'Enabled',
    publicIPAddresses: [IP_PUBLIC], // the probe must never read or print this
    ...extra,
  },
});

// ---------------------------------------------------------------------------
// test doubles
// ---------------------------------------------------------------------------

/** Fake clock: sleep() advances time and is recorded, so nothing ever really waits. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

const counterId = () => { let n = 0; return () => `0000000${(n += 1).toString(16)}`; };

const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const jsonRes = (status, json, headers = {}) => ({ status, json, headers });
const arm403 = jsonRes(403, { error: { code: 'AuthorizationFailed', message: `The client does not have authorization to perform the action over scope /subscriptions/${SUB}.` } });

function toResponse(r) {
  const headers = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const text = r.text !== undefined ? r.text : JSON.stringify(r.json ?? {});
  return { status: r.status, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, text: async () => text };
}

const KNOWN_ELEMENTS = new Set([
  'fragment', 'llm-token-limit', 'llm-emit-token-metric', 'dimension', 'trace', 'message', 'metadata',
  'validate-azure-ad-token', 'audiences', 'audience', 'include-fragment', 'rate-limit-by-key', 'quota-by-key',
  'policies', 'inbound', 'backend', 'outbound', 'on-error', 'base', 'return-response', 'set-status', 'set-header', 'value', 'set-body',
]);
const elementsIn = (xml) => [...String(xml).matchAll(/<([A-Za-z][\w-]*)/g)].map((m) => m[1]);
const removeElement = (xml, name) => xml.replace(new RegExp(`<${name}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${name}>)`, 'g'), '');

const APIM_BASE = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ApiManagement\/service\/([^/]+)(\/.*)?$/;
const notFound = () => jsonRes(404, { error: { code: 'ResourceNotFound', message: 'The requested resource was not found.' } });

/**
 * A fake estate - SYNTHETIC (from Learn example), not observed. State lives in Maps;
 * `rules` are consulted BEFORE the default handlers (first rule that returns a response
 * wins), so a test overrides exactly one behaviour. Every response shape below is the
 * one the Learn REST reference describes (named in the module header that uses it); the
 * platform behaviours it models (validation, async provisioning, propagation delay, the
 * computed mcpProperties.endpoints) are ASSUMPTIONS the first live run confirms or kills.
 */
function estate({ cloud = 'commercial', clock = fakeClock() } = {}) {
  const gov = cloud === 'gov';
  const e = {
    cloud, clock, calls: [], rules: [], audiences: [],
    arm: gov ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com',
    graph: gov ? 'https://graph.microsoft.us' : 'https://graph.microsoft.com',
    logs: gov ? 'https://api.loganalytics.us' : 'https://api.loganalytics.io',
    apims: [apimArm(APIM_NAME)],
    fragments: new Map(), namedValues: new Map(), apis: new Map(), apiPolicies: new Map(), operations: new Map(),
    previewOk: true, validate: true, drop: () => [], inProgressGets: 0, typeFilter: 'ok', mcpMode: 'ok',
    blankPathConflict: false, nvDeleteIgnored: false, gatewayDown: false,
    latency: { delayA: 7000, delayB: 42000, writes: [], apiReadyAt: null },
    categories: ['GatewayLogs', 'WebSocketConnectionLogs', 'DeveloperPortalAuditLogs'],
    metricCategories: ['AllMetrics'],
    diagSettings: [{ name: 'to-law', properties: { workspaceId: WS_RESOURCE_ID, logAnalyticsDestinationType: 'Dedicated', logs: [{ category: 'GatewayLogs', enabled: true }] } }],
    workspaces: [{ id: WS_RESOURCE_ID, name: 'law-fixture', properties: { customerId: WORKSPACE_CUSTOMER } }],
    tables: [
      { name: 'ApiManagementGatewayLogs', properties: { schema: { columns: null, standardColumns: [{ name: 'TimeGenerated' }, { name: 'TraceRecords' }] } } },
      { name: 'AzureActivity', properties: { schema: { columns: null, standardColumns: [{ name: 'TimeGenerated' }] } } },
    ],
    kql: () => jsonRes(200, { tables: [{ name: 'PrimaryResult', columns: [{ name: 'ColumnName' }], rows: [['TraceRecords']] }] }),
    graphSp: {
      id: GRAPH_SP_OBJECT, appId: GRAPH_APP_ID,
      appRoles: [
        { id: ROLE_DIRECTORY, value: 'Directory.Read.All', isEnabled: true, allowedMemberTypes: ['Application'] },
        { id: ROLE_USER, value: 'User.Read.All', isEnabled: true, allowedMemberTypes: ['Application'] },
        { id: ROLE_AGENT_RO, value: 'AgentIdentity.Read.All', isEnabled: true, allowedMemberTypes: ['Application'] },
        { id: ROLE_AGENT_RW, value: 'AgentIdentity.ReadWrite.All', isEnabled: true, allowedMemberTypes: ['Application'] },
      ],
    },
    identities: [{ name: 'uami-loom-console-centralus', properties: { principalId: PRINCIPAL, clientId: TENANT } }, { name: 'some-other-identity', properties: { principalId: OTHER_SP_OBJECT } }],
    assignments: { [PRINCIPAL]: [
      { appRoleId: ROLE_DIRECTORY, resourceId: GRAPH_SP_OBJECT },
      { appRoleId: ROLE_USER, resourceId: GRAPH_SP_OBJECT },
      { appRoleId: ROLE_AGENT_RO, resourceId: OTHER_SP_OBJECT }, // a role on ANOTHER api: counted, never named
    ] },
    apps: [{ id: OTHER_SP_OBJECT, displayName: 'CSA Loom Console (kv-fixture)', groupMembershipClaims: 'SecurityGroup' }],
    models: { centralus: [{ kind: 'OpenAI', model: { format: 'OpenAI', name: 'gpt-fixture' } }, { kind: 'AIServices', model: { format: 'Anthropic', name: 'claude-fixture-b' } }, { kind: 'AIServices', model: { format: 'Anthropic', name: 'claude-fixture-a' } }, { kind: 'AIServices', model: { format: 'Anthropic', name: 'claude-fixture-a' } }] },
    accounts: [],
  };

  const armBase = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ApiManagement/service/${APIM_NAME}`;

  const handlers = [
    // APIM service list
    (r) => (r.method === 'GET' && r.path === `/subscriptions/${SUB}/providers/Microsoft.ApiManagement/service`) ? jsonRes(200, { value: e.apims }) : undefined,

    // fragments / named values / apis (+ policy, operations)
    (r) => {
      const m = APIM_BASE.exec(r.path);
      if (!m) return undefined;
      const rest = m[2] || '';
      let x;
      if ((x = /^\/policyFragments(?:\/([^/]+))?$/.exec(rest))) {
        const id = x[1];
        if (!id && r.method === 'GET') return jsonRes(200, { value: [...e.fragments.keys()].map((name) => ({ name, properties: {} })) });
        if (r.method === 'PUT') {
          const xml = r.body?.properties?.value ?? '';
          if (e.validate) {
            const bad = elementsIn(xml).find((el) => !KNOWN_ELEMENTS.has(el));
            if (bad) return jsonRes(400, { error: { code: 'ValidationError', message: `Error in element 'fragment' on line 1, column 11: The element '${bad}' is not supported.`, details: [] } });
          }
          let stored = xml;
          for (const el of e.drop(id)) stored = removeElement(stored, el);
          e.fragments.set(id, { sent: xml, stored });
          return jsonRes(201, { name: id, properties: { format: 'xml', provisioningState: 'InProgress' } });
        }
        if (r.method === 'GET') {
          const f = e.fragments.get(id);
          if (!f) return notFound();
          const state = e.inProgressGets > 0 ? (e.inProgressGets -= 1, 'InProgress') : 'Succeeded';
          return jsonRes(200, { name: id, properties: { format: 'rawxml', value: f.stored, provisioningState: state } });
        }
        if (r.method === 'DELETE') return jsonRes(e.fragments.delete(id) ? 200 : 204, {});
      }
      if ((x = /^\/namedValues(?:\/([^/]+))?$/.exec(rest))) {
        const id = x[1];
        if (!id && r.method === 'GET') return jsonRes(200, { value: [...e.namedValues.keys()].map((name) => ({ name })) });
        if (r.method === 'PUT') {
          const existed = e.namedValues.has(id);
          e.namedValues.set(id, r.body.properties);
          if (id === 'w0-apiplane-latency') e.latency.writes.push({ value: r.body.properties.value, at: e.clock.now() });
          return jsonRes(existed ? 200 : 201, { name: id, properties: { displayName: r.body.properties.displayName, provisioningState: 'InProgress' } });
        }
        if (r.method === 'GET') {
          const nv = e.namedValues.get(id);
          return nv ? jsonRes(200, { name: id, properties: { displayName: nv.displayName, provisioningState: 'Succeeded' } }) : notFound();
        }
        if (r.method === 'DELETE') {
          if (e.nvDeleteIgnored) return jsonRes(200, {});
          return jsonRes(e.namedValues.delete(id) ? 200 : 204, {});
        }
      }
      if ((x = /^\/apis(?:\/([^/]+))?(?:\/(policies\/policy|operations(?:\/([^/]+))?))?$/.exec(rest))) {
        const [, apiId, sub, opId] = x;
        const version = r.query.get('api-version');
        if (version === '2025-09-01-preview' && !e.previewOk) return jsonRes(400, { error: { code: 'InvalidApiVersionParameter', message: `The api-version '${version}' is invalid. The supported versions are ...` } });
        if (!apiId && r.method === 'GET') {
          const filter = r.query.get('$filter');
          if (filter) {
            if (e.typeFilter === 'rejected') return jsonRes(400, { error: { code: 'InvalidFilter', message: "Property 'type' is not supported in $filter" } });
            return jsonRes(200, { value: [...e.apis].filter(([, p]) => p.type === 'mcp').map(([name, p]) => ({ name, properties: p })) });
          }
          return jsonRes(200, { value: [...e.apis].map(([name, p]) => ({ name, properties: p })) });
        }
        if (apiId && !sub) {
          if (r.method === 'PUT') {
            const p = { ...r.body.properties };
            if (p.type === 'mcp') {
              if (e.mcpMode === 'reject') return jsonRes(400, { error: { code: 'ValidationError', message: "Invalid value for 'mcpProperties'." } });
              if (e.mcpMode === 'reject-without-endpoints' && !p.mcpProperties?.endpoints) return jsonRes(400, { error: { code: 'ValidationError', message: "mcpProperties.endpoints is required." } });
              if (e.mcpMode === 'drop-type') { delete p.type; delete p.mcpProperties; } else if (!p.mcpProperties.endpoints) {
                // SYNTHETIC platform behaviour: APIM computes the endpoints when none were sent
                p.mcpProperties = { ...p.mcpProperties, endpoints: [{ name: 'mcp', uriTemplate: '/mcp' }] };
              }
            }
            if (p.path === '' && e.blankPathConflict) return jsonRes(409, { error: { code: 'ValidationError', message: 'Another API already uses the empty path.' } });
            e.apis.set(apiId, p);
            return jsonRes(201, { name: apiId, properties: { ...p, provisioningState: 'InProgress' } });
          }
          if (r.method === 'GET') return e.apis.has(apiId) ? jsonRes(200, { name: apiId, properties: { ...e.apis.get(apiId), provisioningState: 'Succeeded' } }) : notFound();
          if (r.method === 'DELETE') { e.apiPolicies.delete(apiId); return jsonRes(e.apis.delete(apiId) ? 200 : 204, {}); }
        }
        if (apiId && sub === 'policies/policy') {
          if (r.method === 'PUT') {
            e.apiPolicies.set(apiId, r.body.properties.value);
            if (apiId === 'w0-apiplane-lat-api') e.latency.apiReadyAt = e.clock.now();
            return jsonRes(201, { properties: { format: 'xml', value: r.body.properties.value } });
          }
          if (r.method === 'GET') return e.apiPolicies.has(apiId) ? jsonRes(200, { properties: { format: 'rawxml', value: e.apiPolicies.get(apiId) } }) : notFound();
        }
        if (apiId && opId) {
          if (r.method === 'PUT') { e.operations.set(`${apiId}/${opId}`, r.body.properties); return jsonRes(201, { name: opId, properties: r.body.properties }); }
          if (r.method === 'GET') return e.operations.has(`${apiId}/${opId}`) ? jsonRes(200, { name: opId, properties: e.operations.get(`${apiId}/${opId}`) }) : notFound();
        }
      }
      // Monitor
      if (r.method === 'GET' && rest === '/providers/Microsoft.Insights/diagnosticSettingsCategories') {
        return jsonRes(200, { value: [...e.categories.map((name) => ({ name, properties: { categoryType: 'Logs' } })), ...e.metricCategories.map((name) => ({ name, properties: { categoryType: 'Metrics' } }))] });
      }
      if (r.method === 'GET' && rest === '/providers/Microsoft.Insights/diagnosticSettings') return jsonRes(200, { value: e.diagSettings });
      return undefined;
    },

    // Log Analytics (management plane) and the query API
    (r) => {
      if (r.method === 'GET' && r.path === `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.OperationalInsights/workspaces`) return jsonRes(200, { value: e.workspaces });
      const w = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/([^/]+)(\/tables)?$/.exec(r.path);
      if (w && r.method === 'GET') {
        if (w[2]) return jsonRes(200, { value: e.tables });
        return jsonRes(200, { id: WS_RESOURCE_ID, name: w[1], properties: { customerId: WORKSPACE_CUSTOMER } });
      }
      if (r.method === 'POST' && r.origin === e.logs && /^\/v1\/workspaces\/[^/]+\/query$/.test(r.path)) return e.kql(r);
      return undefined;
    },

    // Graph
    (r) => {
      if (r.origin !== e.graph) return undefined;
      if (r.method === 'GET' && r.path === `/v1.0/servicePrincipals(appId='${GRAPH_APP_ID}')`) return jsonRes(200, e.graphSp);
      const a = /^\/v1\.0\/servicePrincipals\/([^/]+)\/appRoleAssignments$/.exec(r.path);
      if (a && r.method === 'GET') return e.assignments[a[1]] ? jsonRes(200, { value: e.assignments[a[1]] }) : notFound();
      if (r.method === 'GET' && r.path === '/v1.0/applications') return jsonRes(200, { value: e.apps });
      return undefined;
    },

    // ARM reads used by identity / foundry
    (r) => {
      if (r.origin !== e.arm || r.method !== 'GET') return undefined;
      if (r.path === `/subscriptions/${SUB}/providers/Microsoft.ManagedIdentity/userAssignedIdentities`) return jsonRes(200, { value: e.identities });
      if (r.path === `/subscriptions/${SUB}/providers/Microsoft.CognitiveServices/accounts`) return jsonRes(200, { value: e.accounts });
      const m = /^\/subscriptions\/[^/]+\/providers\/Microsoft\.CognitiveServices\/locations\/([^/]+)\/models$/.exec(r.path);
      if (m) return e.models[m[1]] ? jsonRes(200, { value: e.models[m[1]] }) : jsonRes(404, { error: { code: 'LocationNotAvailableForResourceType', message: 'no such location' } });
      return undefined;
    },

    // the gateway data plane
    (r) => {
      if (r.origin !== GATEWAY_ORIGIN) return undefined;
      if (e.gatewayDown) return { throw: netError('ETIMEDOUT') };
      if (r.path === '/status-0123456789abcdef') return { status: 200, text: 'Service Operational' };
      if (r.path === '/w0-apiplane-lat/value') {
        const L = e.latency;
        if (L.apiReadyAt === null || !e.apis.has('w0-apiplane-lat-api') || !e.namedValues.has('w0-apiplane-latency')) return { status: 404, text: '' };
        const now = e.clock.now();
        let visible = null;
        L.writes.forEach((w, i) => {
          const at = i === 0 ? Math.max(w.at, L.apiReadyAt) + L.delayA : w.at + L.delayB;
          if (now >= at) visible = w.value;
        });
        return visible === null ? { status: 404, text: '' } : { status: 200, text: visible };
      }
      return undefined;
    },
  ];

  e.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method: init.method || 'GET', url, origin: u.origin, path: decodeURIComponent(u.pathname), query: u.searchParams, body: init.body ? JSON.parse(init.body) : null, headers };
    e.calls.push(req);
    for (const rule of e.rules) {
      const hit = rule(req, e);
      if (hit) { if (hit.throw) throw hit.throw; return toResponse(hit); }
    }
    for (const h of handlers) {
      const hit = h(req);
      if (hit) { if (hit.throw) throw hit.throw; return toResponse(hit); }
    }
    throw new Error(`NO ROUTE ${req.method} ${req.origin}${req.path}`);
  };
  e.armBase = armBase;
  e.reset = () => { e.calls.length = 0; };
  e.callsMatching = (method, re) => e.calls.filter((c) => c.method === method && re.test(c.path));
  return e;
}

// ---------------------------------------------------------------------------
// harness helpers
// ---------------------------------------------------------------------------

function memFs() {
  const files = new Map();
  const key = (p) => resolve(p);
  return {
    files,
    fs: {
      mkdirSync: () => {},
      writeFileSync: (p, c) => { files.set(key(p), String(c)); },
      appendFileSync: (p, c) => { files.set(key(p), (files.get(key(p)) ?? '') + String(c)); },
      readdirSync: (d) => [...files.keys()].filter((k) => dirname(k) === key(d)).map((k) => basename(k)),
      readFileSync: (p) => { if (!files.has(key(p))) throw new Error(`ENOENT ${p}`); return files.get(key(p)); },
    },
  };
}

function mkDeps(est, extra = {}) {
  const m = memFs();
  const logs = [];
  const clock = est.clock;
  return {
    fetch: est.fetch, now: clock.now, nowIso: () => '2026-10-29T12:00:00.000Z', sleep: clock.sleep,
    azAccount: async () => ({ environmentName: est.cloud === 'gov' ? 'AzureUSGovernment' : 'AzureCloud', subscriptionId: SUB }),
    getToken: async (aud) => { est.audiences.push(aud); return TOKEN; },
    dnsLookup: async () => [IP_PRIVATE],
    idGen: counterId(),
    fs: m.fs, files: m.files, log: (l) => logs.push(l), logs,
    ...extra,
  };
}

async function mkCtx(est, { runner = 'in-vnet', latencyPollSeconds = 900, dns } = {}) {
  const cloud = core.CLOUDS[est.cloud];
  const requests = [];
  const client = core.createClient({
    fetchImpl: est.fetch, getToken: async (aud) => { est.audiences.push(aud); return TOKEN; },
    sleep: est.clock.sleep, clock: est.clock, cloud, requestLog: requests,
  });
  const ctx = {
    cloud, runner, subscriptionId: SUB, apim: null, clock: est.clock, sleep: est.clock.sleep, idGen: counterId(),
    dnsLookup: dns ?? (async () => [IP_PRIVATE]), options: { latencyPollSeconds }, client, requests,
  };
  const d = await probe.discoverApim(ctx, null);
  assert.equal(d.state, 'one', 'fixture estate must expose exactly one APIM');
  ctx.apim = d.apim;
  return ctx;
}

/** Run one family through the real entry path and return { result, est, deps }. */
async function runFamily(family, est, { runner = 'in-vnet', apimName = null, latencyPollSeconds = 900, deps = mkDeps(est) } = {}) {
  const result = await probe.runFamilyProbe({ cloud: est.cloud, family, runner, apimName, latencyPollSeconds, out: 'unused' }, deps);
  return { result, est, deps };
}

function cell(result, id) {
  const c = result.cells.find((x) => x.id === id);
  assert.ok(c, `no cell ${id}; have: ${result.cells.map((x) => x.id).join(', ')}`);
  return c;
}
const text = (result, id) => core.verdictText(cell(result, id));
const control = (result, id) => {
  const c = result.controls.find((x) => x.id === id);
  assert.ok(c, `no control ${id}; have: ${result.controls.map((x) => x.id).join(', ')}`);
  return c;
};
const scratchLeft = (est) => [...est.fragments.keys(), ...est.namedValues.keys(), ...est.apis.keys()].filter((n) => n.startsWith('w0-apiplane-'));

// ===========================================================================
// 1. the closed verdict taxonomy (R4) and exit codes (R6)
// ===========================================================================

test('measured() refuses null, undefined and a value that quotes no evidence', () => {
  // BREAKS IF: measured('x', null, ...) is allowed (a failed read published as a value),
  // or a value quoting neither an HTTP status nor a named source is allowed.
  assert.throws(() => core.measured('x.y', null, { http: 200 }), /UNKNOWN/);
  assert.throws(() => core.measured('x.y', undefined, { http: 200 }), /UNKNOWN/);
  assert.throws(() => core.measured('x.y', 'present'), /http status or a named source/);
  assert.throws(() => core.measured('x.y', 'present', { http: 99 }), /HTTP status/);
  // positives: a real zero quoting its status IS a measurement; a named source stands in for HTTP (DNS)
  assert.equal(core.measured('x.y', 0, { http: 200 }).value, 0);
  assert.equal(core.measured('x.y', 'resolves-private', { source: 'dns' }).source, 'dns');
});

test('the closed reason sets are exactly the documented ones, and constructors refuse anything else', () => {
  // BREAKS IF: a reason is added or removed without this test being edited (the set is CLOSED).
  assert.deepEqual([...core.NOT_MEASURED_REASONS], [
    'no-gateway-in-boundary', 'gateway-unreachable-from-runner', 'api-version-unsupported-in-boundary',
    'boundary-not-exercised', 'no-in-boundary-runner',
  ]);
  assert.deepEqual([...core.UNKNOWN_REASONS], ['transient-exhausted', 'tooling-error', 'workspace-not-discovered', 'not-located']);
  assert.throws(() => core.notMeasured('x.y', 'because-i-said-so'), /closed set/);
  assert.throws(() => core.unknown('x.y', 'no'), /closed set/);
  assert.throws(() => core.unknown('x.y', 'permission:Reader'), /closed set/, 'a permission reason must carry @<scope-kind>');
  assert.throws(() => core.unknown('x.y', 'permission:Reader@everywhere'), /closed set/);
  for (const r of core.NOT_MEASURED_REASONS) assert.equal(core.notMeasured('x.y', r).reason, r);
  assert.equal(core.unknown('x.y', 'permission:Monitoring Reader@apim').reason, 'permission:Monitoring Reader@apim');
});

test('verdictText quotes the status next to a value, and the reason for the other two verdicts', () => {
  // BREAKS IF: the HTTP status is dropped from a measured line (R4: "value plus the HTTP status quoted").
  assert.equal(core.verdictText(core.measured('a', 'present', { http: 200 })), 'measured: present (HTTP 200)');
  assert.equal(core.verdictText(core.measured('a', 'rejected (silently dropped)', { http: [201, 200] })), 'measured: rejected (silently dropped) (HTTP 201/200)');
  assert.equal(core.verdictText(core.measured('a', 'nxdomain', { source: 'dns' })), 'measured: nxdomain (source: dns)');
  assert.equal(core.verdictText(core.measured('a', { logs: ['GatewayLogs'] }, { http: 200 })), 'measured: {"logs":["GatewayLogs"]} (HTTP 200)');
  assert.equal(core.verdictText(core.notMeasured('a', 'no-gateway-in-boundary')), 'not-measured:no-gateway-in-boundary');
  assert.equal(core.verdictText(core.unknown('a', 'permission:Monitoring Reader@apim')), 'unknown:permission:Monitoring Reader@apim');
});

test('computeExit: 2 beats 3 beats 0, and only REQUIRED unknown cells or leftovers make a 3', () => {
  // BREAKS IF: a failed control is reported as 3 (or 0); a non-required unknown fails the run;
  // a required unknown passes; leftover scratch objects pass.
  const m = core.measured('f.a', 'x', { http: 200 });
  const uReq = core.unknown('f.b', 'tooling-error');
  const uOpt = core.unknown('f.c', 'tooling-error', { required: false });
  const pass = { id: 'p', status: 'passed' };
  const fail = { id: 'f', status: 'failed' };
  const unrunnable = { id: 'u', status: 'unrunnable' };
  assert.equal(core.computeExit({ cells: [m], controls: [pass] }), 0);
  assert.equal(core.computeExit({ cells: [m, uReq], controls: [pass] }), 3);
  assert.equal(core.computeExit({ cells: [m, uOpt], controls: [pass] }), 0);
  assert.equal(core.computeExit({ cells: [m], controls: [fail] }), 2);
  assert.equal(core.computeExit({ cells: [m, uReq], controls: [fail] }), 2, 'a failed control outranks an unknown cell');
  assert.equal(core.computeExit({ cells: [m], controls: [unrunnable] }), 0, 'an unrunnable control is recorded as an unknown cell elsewhere, not a failure');
  assert.equal(core.computeExit({ cells: [], controls: [], crashed: true }), 2);
  const clean = core.measured('f.cleanup', '0 leftovers', { http: 200, evidence: { leftovers: 0 } });
  const dirty = core.measured('f.cleanup', '2 leftovers', { http: 200, evidence: { leftovers: 2 } });
  assert.equal(core.computeExit({ cells: [m, clean], controls: [pass] }), 0);
  assert.equal(core.computeExit({ cells: [m, dirty], controls: [pass] }), 3);
});

// ===========================================================================
// 2. the publication choke point (R3)
// ===========================================================================

test('sanitize removes ids, addresses, tokens and registered secrets, and keeps the names a reader needs', () => {
  // BREAKS IF: any one rule is removed. Each needle below is the secret that rule targets
  // (GUID resource id, tenant id, bare GUID, IPv4, IPv6, JWT, Bearer header, SAS signature, a
  // registered RAW token with nothing around it that looks like a credential).
  core.clearSecretsForTest();
  core.registerSecret(TOKEN);
  const dirty = `scope /subscriptions/${SUB}/resourceGroups/${RG}/providers/x tenant /tenants/${TENANT} principal ${PRINCIPAL} `
    + `ip ${IP_PUBLIC} v6 2001:db8:85a3:0:0:8a2e:370:7334 jwt ${JWT} hdr Bearer abcdefghijklmnop raw ${TOKEN} sig=SECRETSIG123 name ${APIM_NAME}`;
  const clean = core.sanitize(dirty, 0);
  for (const needle of [SUB, TENANT, PRINCIPAL, IP_PUBLIC, '2001:db8:85a3', JWT, 'abcdefghijklmnop', TOKEN, 'SECRETSIG123']) {
    assert.ok(!clean.includes(needle), `leaked ${needle}`);
  }
  // positive pairs: deleting sanitize() or blanking the string would fail these
  for (const keep of [RG, APIM_NAME, '<redacted>', '<ip>', '<token>']) assert.ok(clean.includes(keep), `lost ${keep}`);
  core.clearSecretsForTest();
});

test('sanitize truncates to the cap and says so, so a long server message cannot flood a receipt', () => {
  // BREAKS IF: the cap is ignored (a 5,000-character message lands whole in the receipt).
  const long = 'x'.repeat(5000);
  const out = core.sanitize(long, 300);
  assert.equal(out.length, 303);
  assert.ok(out.endsWith('...'));
  assert.equal(core.sanitize('short', 300), 'short');
});

test('deepSanitize reaches strings at any depth and leaves numbers, booleans and keys alone', () => {
  // BREAKS IF: deepSanitize stops at the first level (a needle three levels down survives).
  const out = core.deepSanitize({ a: [{ b: { c: `id ${SUB} ip ${IP_PUBLIC}` } }], n: 7, ok: true, [SUB]: 'key-is-not-touched' });
  assert.ok(!JSON.stringify(out.a).includes(SUB));
  assert.ok(!JSON.stringify(out.a).includes(IP_PUBLIC));
  assert.equal(out.n, 7);
  assert.equal(out.ok, true);
  assert.equal(out[SUB], 'key-is-not-touched');
});

// ===========================================================================
// 3. the HTTP engine (R2, R4)
// ===========================================================================

function scripted(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const s = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (s instanceof Error) throw s;
      return toResponse(s);
    },
  };
}
function mkClient(fetchImpl, { clock = fakeClock(), getToken = async () => TOKEN, cloud = 'commercial' } = {}) {
  const requests = [];
  const client = core.createClient({ fetchImpl, getToken, sleep: clock.sleep, clock, cloud: core.CLOUDS[cloud], requestLog: requests });
  return { client, clock, requests };
}
const ARM = 'https://management.azure.com';
const ok200 = { status: 200, json: { ok: true } };

test('engine: 503, 503, 200 is retried with 1 s then 2 s backoff and then succeeds', async () => {
  // BREAKS IF: a 5xx is not retried (attempts 1), or the backoff is not slept (sleeps []), or the
  // third attempt is not made. Retries are spent ONLY on 429/5xx/network errors (R4).
  const s = scripted([{ status: 503, json: {} }, { status: 503, json: {} }, ok200]);
  const { client, clock } = mkClient(s.fetch);
  const r = await client.request({ service: 'arm', url: `${ARM}/x` });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.attempts, 3);
  assert.deepEqual(clock.sleeps, [1000, 2000]);
  assert.equal(s.calls.length, 3);
});

test('engine: exhaustion is transientExhausted with the LAST status, and no sleep follows the last attempt', async () => {
  // BREAKS IF: exhaustion is reported as a plain failure (so a 429 reads as "no"), or a 4th attempt is made.
  const s = scripted([{ status: 429, json: {} }]);
  const { client, clock } = mkClient(s.fetch);
  const r = await client.request({ service: 'arm', url: `${ARM}/x` });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.transientExhausted, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(clock.sleeps, [1000, 2000]);
});

test('engine: a network error keeps its CLASS only, never its message, and is retried', async () => {
  // BREAKS IF: the error message (which can carry an address or host) is kept, the class is wrong,
  // or a network failure is not retried.
  const s = scripted([Object.assign(netError('ENOTFOUND'), { message: `getaddrinfo ENOTFOUND ${IP_PUBLIC}` })]);
  const { client } = mkClient(s.fetch);
  const r = await client.request({ service: 'gateway', url: `${GATEWAY_ORIGIN}/x` });
  assert.equal(r.status, null);
  assert.equal(r.networkErrorClass, 'dns');
  assert.equal(r.transientExhausted, true);
  assert.equal(s.calls.length, 3);
  assert.ok(!JSON.stringify({ ...r, headers: null }).includes('getaddrinfo'));
  assert.ok(!JSON.stringify({ ...r, headers: null }).includes(IP_PUBLIC));
  for (const [code, klass] of [['ETIMEDOUT', 'timeout'], ['ECONNREFUSED', 'refused'], ['ECONNRESET', 'reset'], ['CERT_HAS_EXPIRED', 'tls'], ['EWHATEVER', 'other']]) {
    assert.equal(core.classifyNetworkError(netError(code)), klass, code);
  }
});

test('engine: 4xx answers are final (no retry) for every non-429 client status', async () => {
  // BREAKS IF: any of these is retried (a 403 retried three times is a permission verdict delayed and noisy).
  for (const status of [400, 401, 403, 404, 409, 412]) {
    const s = scripted([{ status, json: { error: { code: 'X', message: 'm' } } }]);
    const { client, clock } = mkClient(s.fetch);
    const r = await client.request({ service: 'arm', url: `${ARM}/x` });
    assert.equal(r.attempts, 1, `status ${status}`);
    assert.equal(r.transientExhausted, false, `status ${status}`);
    assert.deepEqual(clock.sleeps, [], `status ${status}`);
    assert.equal(r.errorCode, 'X');
  }
});

test('engine: Retry-After on a 429 is honoured instead of the table backoff', async () => {
  // BREAKS IF: the header is ignored (sleeps would be [1000]).
  const s = scripted([{ status: 429, json: {}, headers: { 'retry-after': '7' } }, ok200]);
  const { client, clock } = mkClient(s.fetch);
  const r = await client.request({ service: 'arm', url: `${ARM}/x` });
  assert.equal(r.status, 200);
  assert.deepEqual(clock.sleeps, [7000]);
});

test('engine: retry:false makes exactly one attempt, so a poll never hides sleeps inside its interval', async () => {
  // BREAKS IF: retry:false still retries (attempts 3 / sleeps [1000, 2000]).
  const s = scripted([{ status: 503, json: {} }]);
  const { client, clock } = mkClient(s.fetch);
  const r = await client.request({ service: 'gateway', url: `${GATEWAY_ORIGIN}/x`, retry: false });
  assert.equal(r.attempts, 1);
  assert.deepEqual(clock.sleeps, []);
  assert.equal(s.calls.length, 1);
});

test('engine: the bearer token goes only to the origin it was minted for, and a gateway call carries none', async () => {
  // BREAKS IF: a foreign origin (a hostile nextLink) is sent the token, or a gateway request carries Authorization.
  const s = scripted([ok200]);
  const { client } = mkClient(s.fetch);
  await assert.rejects(client.request({ service: 'arm', url: 'https://evil.example/x' }), /foreign origin/);
  await assert.rejects(client.request({ service: 'graph', url: `${ARM}/x` }), /foreign origin/, 'a graph token must not go to the ARM host');
  assert.equal(s.calls.length, 0, 'a refused request must not reach fetch');
  await client.request({ service: 'arm', url: `${ARM}/x` });
  assert.equal(s.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  await client.request({ service: 'gateway', url: `${GATEWAY_ORIGIN}/x` });
  assert.equal(s.calls[1].init.headers.authorization, undefined);
});

test('listAll refuses a nextLink on a foreign origin instead of following it with the token', async () => {
  // BREAKS IF: nextLink is followed blindly (the token would leave the ARM origin).
  const s = scripted([{ status: 200, json: { value: [{ name: 'a' }], nextLink: 'https://evil.example/page2' } }]);
  const { client } = mkClient(s.fetch);
  await assert.rejects(core.listAll({ client }, `${ARM}/list`), /foreign origin/);
  assert.equal(s.calls.length, 1, 'only the first page was fetched');
});

test('engine: tokens are cached for 20 minutes of clock time and re-minted after', async () => {
  // BREAKS IF: a token is minted per request (3 calls) or never refreshed (1 call).
  let minted = 0;
  const s = scripted([ok200]);
  const { client, clock } = mkClient(s.fetch, { getToken: async () => { minted += 1; return TOKEN; } });
  await client.request({ service: 'arm', url: `${ARM}/a` });
  await client.request({ service: 'arm', url: `${ARM}/b` });
  assert.equal(minted, 1);
  clock.advance(21 * 60 * 1000);
  await client.request({ service: 'arm', url: `${ARM}/c` });
  assert.equal(minted, 2);
});

test('engine: a server that echoes the raw token back cannot put it in an error message, and the log path carries no id', async () => {
  // BREAKS IF: the engine stops registering the token it minted (a bare token has no Bearer prefix
  // and is not JWT-shaped, so redactSecrets alone cannot catch it), or logs an unredacted path.
  core.clearSecretsForTest();
  const s = scripted([{ status: 400, json: { error: { code: 'BadRequest', message: `bad token ${TOKEN} for /subscriptions/${SUB}/x` } } }]);
  const { client, requests } = mkClient(s.fetch);
  const r = await client.request({ service: 'arm', url: `${ARM}/subscriptions/${SUB}/resourceGroups/${RG}/x?api-version=2024-05-01` });
  assert.ok(!r.errorMessage.includes(TOKEN));
  assert.ok(r.errorMessage.includes('<token>'));
  assert.ok(!r.errorMessage.includes(SUB));
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].path.includes(SUB));
  assert.ok(requests[0].path.includes('/subscriptions/<redacted>/resourceGroups/rg-fixture'));
  core.clearSecretsForTest();
});

test('engine: the api-version and attribute classifiers key on the code and the message', () => {
  // BREAKS IF: an api-version failure is not recognised (a boundary finding becomes an instrument error),
  // an ordinary 400 is mistaken for one, or an attribute-naming message is not recognised.
  assert.equal(core.isApiVersionError(400, 'InvalidApiVersionParameter', 'x'), true);
  assert.equal(core.isApiVersionError(400, 'NoRegisteredProviderFound', 'x'), true);
  assert.equal(core.isApiVersionError(400, 'SomethingElse', "The api-version '2025-09-01-preview' is not supported"), true);
  assert.equal(core.isApiVersionError(400, 'ValidationError', 'Required attribute calls is missing'), false);
  assert.equal(core.isApiVersionError(403, 'InvalidApiVersionParameter', 'x'), false, 'only 400/404 can be an api-version answer');
  assert.equal(core.namesAnAttribute("Error in element 'quota-by-key' on line 1: Required attribute 'calls' is missing"), true);
  assert.equal(core.namesAnAttribute("Error in element 'x': Unknown attribute 'foo'"), true);
  assert.equal(core.namesAnAttribute("Error in element 'fragment' on line 1: The element 'quota-by-key' is not supported."), false);
});

// ===========================================================================
// 4. scratch objects (R7)
// ===========================================================================

test('deleteScratch throws on every non-scratch name BEFORE building a request, and builds exactly one DELETE for a scratch name', async () => {
  // BREAKS IF: the prefix guard is removed or loosened - any of these names (a customer API, a bare
  // prefix, path traversal, a query injection, wrong case, empty, null, a number) reaches a DELETE.
  const est = estate();
  const ctx = await mkCtx(est);
  est.reset();
  for (const bad of ['production-api', 'w0-apiplane', 'w0-apiplane-', '../w0-apiplane-x', 'w0-apiplane-x?y=1', 'w0-apiplane-x/../prod', 'W0-APIPLANE-X', '', undefined, null, 42]) {
    await assert.rejects(core.deleteScratch(ctx, 'api', bad), /refusing to delete a non-scratch object/, `name ${String(bad)}`);
  }
  assert.equal(est.callsMatching('DELETE', /./).length, 0, 'a refused name must not even build a request');
  await core.deleteScratch(ctx, 'api', 'w0-apiplane-ok');
  const dels = est.calls.filter((c) => c.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].path, `${est.armBase}/apis/w0-apiplane-ok`);
  assert.equal(dels[0].headers['if-match'], '*');
  assert.equal(dels[0].query.get('api-version'), '2024-05-01');
  await assert.rejects(core.deleteScratch(ctx, 'bogus-kind', 'w0-apiplane-ok'), /unknown kind/);
});

test('SHAPE: the DELETE verb appears exactly once in the probe sources, inside deleteScratch', () => {
  // BREAKS IF: a second delete path is added anywhere (it would bypass the prefix guard). Positive pair:
  // the count is exactly 1, so deleting deleteScratch (count 0) is red too.
  const files = ['_w0-core.mjs', '_w0-telemetry.mjs', '_w0-policies.mjs', '_w0-mcp.mjs', '_w0-identity.mjs', '_w0-latency.mjs', '_w0-foundry.mjs', 'w0-apim-probe.mjs'];
  let total = 0;
  const where = [];
  for (const f of files) {
    const src = readFileSync(join(PROBE_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    const n = (src.match(/['"]DELETE['"]/g) || []).length;
    total += n;
    if (n) where.push(f);
  }
  assert.equal(total, 1);
  assert.deepEqual(where, ['_w0-core.mjs']);
  const core_ = readFileSync(join(PROBE_DIR, '_w0-core.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const start = core_.indexOf('export async function deleteScratch');
  const end = core_.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  assert.ok(core_.slice(start, end).includes("method: 'DELETE'"), 'the one DELETE must live inside deleteScratch');
  assert.ok(core_.slice(start, end).indexOf('SCRATCH_NAME_RE.test') < core_.slice(start, end).indexOf("method: 'DELETE'"), 'the guard must come before the request');
});

test('sweepScratch deletes only w0-apiplane-* objects, APIs before fragments before named values', async () => {
  // BREAKS IF: the prefix filter is dropped (a customer object is deleted, or deleteScratch throws on it),
  // or the order changes (a named value cannot be deleted while a policy references it).
  const est = estate();
  est.apis.set('production-api', { path: 'p' });
  est.apis.set('w0-apiplane-a', { path: 'w0-apiplane-a' });
  est.fragments.set('prod-fragment', { sent: '', stored: '' });
  est.fragments.set('w0-apiplane-f', { sent: '', stored: '' });
  est.namedValues.set('nv-prod', {});
  est.namedValues.set('w0-apiplane-n', {});
  const ctx = await mkCtx(est);
  est.reset();
  const sweep = await core.sweepScratch(ctx);
  assert.deepEqual([...est.apis.keys()], ['production-api']);
  assert.deepEqual([...est.fragments.keys()], ['prod-fragment']);
  assert.deepEqual([...est.namedValues.keys()], ['nv-prod']);
  assert.deepEqual(est.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.slice(est.armBase.length)), [
    '/apis/w0-apiplane-a', '/policyFragments/w0-apiplane-f', '/namedValues/w0-apiplane-n',
  ]);
  assert.equal(sweep.deleted.length, 3);
  assert.deepEqual(sweep.failed, []);
});

test('cleanupCell: a clean listing is "0 leftovers", a stuck delete is counted and is exit 3, a failed listing is unknown (never zero)', async () => {
  // BREAKS IF: leftovers are reported as zero, a failed LIST is reported as zero, or the delete passes are unbounded.
  const est = estate();
  const ctx = await mkCtx(est);
  const clean = await core.cleanupCell(ctx, 'policies', {});
  assert.equal(core.verdictText(clean), 'measured: 0 leftovers (HTTP 200)');
  assert.equal(clean.evidence.leftovers, 0);

  est.fragments.set('w0-apiplane-stuck', { sent: '', stored: '' });
  est.rules.push((r) => (r.method === 'DELETE' && /w0-apiplane-stuck$/.test(r.path) ? jsonRes(409, { error: { code: 'Conflict', message: 'in use' } }) : undefined));
  est.reset();
  const sweep = await core.sweepScratch(ctx);
  assert.equal(est.callsMatching('DELETE', /w0-apiplane-stuck$/).length, 3, 'exactly three bounded passes');
  assert.deepEqual(sweep.failed.map((f) => [f.name, f.status]), [['w0-apiplane-stuck', 409]]);
  const dirty = await core.cleanupCell(ctx, 'policies', {});
  assert.equal(dirty.evidence.leftovers, 1);
  assert.deepEqual(dirty.evidence.names, ['w0-apiplane-stuck']);
  assert.equal(core.computeExit({ cells: [dirty], controls: [] }), 3);

  est.rules.length = 0;
  est.rules.push((r) => (r.method === 'GET' && /policyFragments$/.test(r.path) ? arm403 : undefined));
  const blind = await core.cleanupCell(ctx, 'policies', {});
  assert.equal(blind.verdict, 'unknown');
  assert.equal(blind.reason, 'permission:API Management Service Reader@apim');
});

test('withScratch runs the end sweep when the body throws, appends the cleanup cell, and re-throws', async () => {
  // BREAKS IF: the end sweep is not in a finally (a crash leaves scratch objects on a live gateway).
  const est = estate();
  const ctx = await mkCtx(est);
  const acc = { cells: [], controls: [] };
  await assert.rejects(core.withScratch(ctx, 'policies', acc, async () => {
    est.fragments.set('w0-apiplane-made-by-body', { sent: '', stored: '' });
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(scratchLeft(est), []);
  const c = acc.cells.find((x) => x.id === 'policies.cleanup');
  assert.ok(c, 'the cleanup cell must still be recorded');
  assert.equal(core.verdictText(c), 'measured: 0 leftovers (HTTP 200)');
});

test('withScratch sweeps BEFORE the body too: a leftover from a crashed earlier run is gone before anything is measured', async () => {
  // BREAKS IF: the start sweep is removed (a stale w0-apiplane-* object from run N-1 pollutes run N).
  const est = estate();
  est.fragments.set('w0-apiplane-stale', { sent: '', stored: '' });
  const ctx = await mkCtx(est);
  let seenInBody = null;
  await core.withScratch(ctx, 'policies', { cells: [], controls: [] }, async () => { seenInBody = scratchLeft(est); });
  assert.deepEqual(seenInBody, []);
});

// ===========================================================================
// 5. telemetry (W0-1)
// ===========================================================================

test('telemetry: a category list WITHOUT GatewayLlmLogs is "absent" and the whole list is pasted; with it, "present"', async () => {
  // BREAKS IF: the cell says "present" for a list that lacks the category, says a bare yes/no with no list
  // (the PRP: "the receipt pastes the list, not a yes"), or loses the metrics/logs split.
  const est = estate();
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.diag.GatewayLlmLogs'), 'measured: absent (HTTP 200)');
  assert.deepEqual(cell(result, 'telemetry.diag.GatewayLlmLogs').evidence.pastedCategoryNames, ['AllMetrics', 'DeveloperPortalAuditLogs', 'GatewayLogs', 'WebSocketConnectionLogs']);
  assert.deepEqual(cell(result, 'telemetry.diag.categories').value, {
    logs: ['DeveloperPortalAuditLogs', 'GatewayLogs', 'WebSocketConnectionLogs'], metrics: ['AllMetrics'], total: 4,
  });
  assert.equal(control(result, 'categories-contain-GatewayLogs').status, 'passed');

  est.categories.push('GatewayLlmLogs');
  const { result: withLlm } = await runFamily('telemetry', est);
  assert.equal(text(withLlm, 'telemetry.diag.GatewayLlmLogs'), 'measured: present (HTTP 200)');
  assert.ok(cell(withLlm, 'telemetry.diag.GatewayLlmLogs').evidence.pastedCategoryNames.includes('GatewayLlmLogs'));
});

test('telemetry: near-miss category names are surfaced, so a wrong NAME is not read as an unavailable feature', async () => {
  // BREAKS IF: a category named like the UI label ("GenerativeAIGatewayLogs") is silently ignored.
  const est = estate();
  est.categories.push('GenerativeAIGatewayLogs');
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.diag.GatewayLlmLogs'), 'measured: absent (HTTP 200)', 'the cell stays an EXACT-name answer');
  assert.deepEqual(cell(result, 'telemetry.diag.GatewayLlmLogs').evidence.nearMatches, ['GenerativeAIGatewayLogs']);
});

test('telemetry CONTROL: a category list without GatewayLogs is not an APIM category list - exit 2, family invalid', async () => {
  // BREAKS IF: the GatewayLogs control is skipped or inverted (exit would be 0 and "absent" would be published).
  const est = estate();
  est.categories = ['WebSocketConnectionLogs'];
  const { result } = await runFamily('telemetry', est);
  assert.equal(control(result, 'categories-contain-GatewayLogs').status, 'failed');
  assert.equal(result.exitCode, 2);
  assert.equal(result.valid, false);
  assert.ok(result.notes.some((n) => /INVALID/.test(n)));
});

test('telemetry: a 403 on the category list is unknown:permission naming the role, never "absent" and never a failed control', async () => {
  // BREAKS IF: a 401/403 is rendered as a "no" (absent) or as exit 0.
  const est = estate();
  est.rules.push((r) => (r.method === 'GET' && /diagnosticSettingsCategories$/.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.diag.GatewayLlmLogs'), 'unknown:permission:Monitoring Reader@apim');
  assert.equal(text(result, 'telemetry.diag.categories'), 'unknown:permission:Monitoring Reader@apim');
  assert.equal(control(result, 'categories-contain-GatewayLogs').status, 'unrunnable');
  assert.equal(result.exitCode, 3, 'a required cell is unknown');
  assert.equal(result.valid, true, 'an unreadable list is not an invalid instrument');
});

test('telemetry: an absent TABLE is INCONCLUSIVE and says so; a present table is "present"', async () => {
  // BREAKS IF: an absent table is reported as plain "absent" (the PRP: only the category list answers
  // availability) or the INCONCLUSIVE caveat is dropped.
  const est = estate();
  const { result } = await runFamily('telemetry', est);
  const v = text(result, 'telemetry.law.table.ApiManagementGatewayLlmLog');
  assert.match(v, /^measured: absent \(INCONCLUSIVE: diagnostics may simply be unwired; only diag\.categories answers availability\) \(HTTP 200\)$/);

  est.tables.push({ name: 'ApiManagementGatewayLlmLog', properties: { schema: { standardColumns: [{ name: 'TimeGenerated' }] } } });
  const { result: present } = await runFamily('telemetry', est);
  assert.equal(text(present, 'telemetry.law.table.ApiManagementGatewayLlmLog'), 'measured: present (HTTP 200)');
});

test('telemetry: TraceRecords is read from standardColumns OR columns; a listed table with no schema is INCONCLUSIVE, not "absent"', async () => {
  // BREAKS IF: only one column list is read (a resource-specific table keeps its columns in standardColumns),
  // or a schema-less table is reported as "column absent".
  const est = estate();
  const { result: std } = await runFamily('telemetry', est);
  assert.equal(text(std, 'telemetry.law.column.TraceRecords'), 'measured: present (HTTP 200)');

  est.tables[0].properties.schema = { columns: [{ name: 'TraceRecords' }], standardColumns: [{ name: 'TimeGenerated' }] };
  const { result: custom } = await runFamily('telemetry', est);
  assert.equal(text(custom, 'telemetry.law.column.TraceRecords'), 'measured: present (HTTP 200)');

  est.tables[0].properties.schema = { columns: null, standardColumns: [{ name: 'TimeGenerated' }] };
  const { result: gone } = await runFamily('telemetry', est);
  assert.match(text(gone, 'telemetry.law.column.TraceRecords'), /^measured: absent \(table ApiManagementGatewayLogs listed, column not in its schema\)/);

  est.tables[0].properties.schema = null;
  const { result: blind } = await runFamily('telemetry', est);
  assert.match(text(blind, 'telemetry.law.column.TraceRecords'), /INCONCLUSIVE/);

  est.tables = [];
  const { result: noTable } = await runFamily('telemetry', est);
  assert.match(text(noTable, 'telemetry.law.column.TraceRecords'), /INCONCLUSIVE/);
});

test('telemetry: a 403 on the tables list is unknown:permission at the workspace, not "absent"', async () => {
  // BREAKS IF: an unreadable table list is reported as the table being absent.
  const est = estate();
  est.rules.push((r) => (r.method === 'GET' && /workspaces\/[^/]+\/tables$/.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.law.table.ApiManagementGatewayLlmLog'), 'unknown:permission:Log Analytics Reader@workspace');
  assert.equal(text(result, 'telemetry.law.column.TraceRecords'), 'unknown:permission:Log Analytics Reader@workspace');
  assert.equal(result.exitCode, 3);
});

test('telemetry: the workspace comes from the diagnostic setting first, then the resource group, else unknown:workspace-not-discovered', async () => {
  // BREAKS IF: discovery order flips (the RG scan would win), a workspace is invented when none exists,
  // or the destination type (legacy AzureDiagnostics vs resource-specific) is not reported.
  const est = estate();
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.law.discovered'), 'measured: 1 workspace(s) via diagnostic-setting (HTTP 200)');
  assert.deepEqual(cell(result, 'telemetry.law.discovered').evidence.workspaceNames, ['law-fixture']);
  assert.equal(cell(result, 'telemetry.law.discovered').evidence.diagnosticSettings[0].destinationType, 'resource-specific');
  assert.equal(est.callsMatching('GET', /OperationalInsights\/workspaces$/).length, 0, 'the RG scan must not run when a diagnostic setting names a workspace');
  assert.equal(est.callsMatching('GET', /workspaces\/law-fixture\/tables$/).length, 1);

  est.diagSettings = [{ name: 'legacy', properties: { workspaceId: WS_RESOURCE_ID, logs: [] } }];
  const { result: legacy } = await runFamily('telemetry', est);
  assert.equal(cell(legacy, 'telemetry.law.discovered').evidence.diagnosticSettings[0].destinationType, 'AzureDiagnostics (legacy)');

  est.diagSettings = [];
  const { result: scan } = await runFamily('telemetry', est);
  assert.equal(text(scan, 'telemetry.law.discovered'), 'measured: 1 workspace(s) via resource-group-scan (HTTP 200)');

  est.workspaces = [];
  const { result: none } = await runFamily('telemetry', est);
  assert.equal(text(none, 'telemetry.law.discovered'), 'unknown:workspace-not-discovered');
  assert.equal(text(none, 'telemetry.law.table.ApiManagementGatewayLlmLog'), 'unknown:workspace-not-discovered');
  assert.equal(cell(none, 'telemetry.law.kql.TraceRecords').required, false);
  assert.equal(none.exitCode, 3);
});

test('telemetry: gateway reachability is measured, an unreachable gateway keeps only an error CLASS, and no address is printed', async () => {
  // BREAKS IF: an unreachable gateway is not recorded, its class is dropped, or the APIM's public IP
  // (present in the fixture response) reaches the output.
  const est = estate();
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.gateway.reachability'), 'measured: reachable (status endpoint answered HTTP 200) (HTTP 200)');
  assert.ok(!JSON.stringify(result).includes(IP_PUBLIC), 'the fixture APIM carries a public IP; the probe must not read it');

  est.gatewayDown = true;
  const { result: down } = await runFamily('telemetry', est);
  assert.equal(text(down, 'telemetry.gateway.reachability'), 'measured: unreachable from this runner (error class: timeout) (source: network-probe)');
  assert.equal(cell(down, 'telemetry.gateway.reachability').dataPlane, true);
  assert.equal(down.exitCode, 0, 'an unreachable gateway is a finding, not a failure');
});

test('telemetry: APIM facts quote the list call status, and a property the service did not return says so', async () => {
  // BREAKS IF: a missing property is rendered as an empty/undefined "measurement".
  const est = estate();
  est.apims[0].properties.publicNetworkAccess = undefined;
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.apim.sku'), 'measured: PremiumV2 (HTTP 200)');
  assert.equal(text(result, 'telemetry.apim.capacity'), 'measured: 1 (HTTP 200)');
  assert.equal(text(result, 'telemetry.apim.virtualNetworkType'), 'measured: Internal (HTTP 200)');
  assert.equal(text(result, 'telemetry.apim.publicNetworkAccess'), 'measured: not returned by the service resource (HTTP 200)');
});

test('telemetry: the KQL getschema evidence is secondary - answered, table-missing, or a 403 are each recorded and none is required', async () => {
  // BREAKS IF: a KQL failure turns the family red (it is secondary), a missing table is called "absent"
  // without INCONCLUSIVE, or the query is not a getschema over the right table.
  const est = estate();
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.law.kql.TraceRecords'), 'measured: present (HTTP 200)');
  const q = est.calls.filter((c) => c.method === 'POST' && c.origin === 'https://api.loganalytics.io');
  assert.equal(q.length, 2);
  assert.match(q[0].body.query, /^ApiManagementGatewayLlmLog \| getschema/);
  assert.match(q[1].body.query, /^ApiManagementGatewayLogs \| getschema \| where ColumnName == 'TraceRecords'/);
  assert.ok(sawAudience(est, 'https://api.loganalytics.io'));
  assert.ok(q[0].path.includes(WORKSPACE_CUSTOMER) && !JSON.stringify(result).includes(WORKSPACE_CUSTOMER), 'the workspace id is used for the call and never printed');

  est.kql = () => jsonRes(400, { error: { code: 'BadArgumentError', message: "Failed to resolve table or column expression named 'ApiManagementGatewayLlmLog'" } });
  const { result: missing } = await runFamily('telemetry', est);
  assert.match(text(missing, 'telemetry.law.kql.ApiManagementGatewayLlmLog'), /^measured: absent \(INCONCLUSIVE: diagnostics may simply be unwired/);
  assert.equal(cell(missing, 'telemetry.law.kql.ApiManagementGatewayLlmLog').required, false);

  est.kql = () => arm403;
  const { result: denied } = await runFamily('telemetry', est);
  assert.equal(text(denied, 'telemetry.law.kql.TraceRecords'), 'unknown:permission:Log Analytics Reader@workspace');
  assert.equal(denied.exitCode, 0, 'secondary evidence never fails the family');
});

// ===========================================================================
// 6. policies (W0-2)
// ===========================================================================

const ELEMENTS = ['llm-token-limit', 'llm-emit-token-metric', 'trace', 'validate-azure-ad-token', 'include-fragment', 'rate-limit-by-key', 'quota-by-key'];
const rejectElementMessage = (el) => ({ error: { code: 'ValidationError', message: `Error in element '${el}' on line 1, column 11: The element '${el}' is not supported on this gateway.` } });

test('policies: the Learn-required attributes are present in every fixture fragment (fixtures checked against the rule they must satisfy)', () => {
  // BREAKS IF: a fixture drops an attribute Learn marks required, which would make APIM reject a good
  // element for the wrong reason (the "could not pass" failure). Required sets are transcribed from the Learn
  // policy pages named beside each row (retrieved 2026-10-29); the XML is lifted from the source at runtime.
  const required = {
    'llm-token-limit': ['counter-key=', 'estimate-prompt-tokens=', 'tokens-per-minute='], // llm-token-limit-policy: counter-key, estimate-prompt-tokens, rate or quota
    'llm-emit-token-metric': ['<dimension name='], // llm-emit-token-metric-policy: at least one dimension, name required
    trace: ['source=', '<message>', '<metadata name=', 'value='], // trace-policy: source, message, metadata name+value
    'validate-azure-ad-token': ['tenant-id=', '<audiences><audience>'], // validate-azure-ad-token-policy: tenant-id, audience or client application id
    'include-fragment': ['fragment-id='], // include-fragment-policy: fragment-id
    'rate-limit-by-key': ['calls=', 'renewal-period=', 'counter-key='], // rate-limit-by-key-policy
    'quota-by-key': ['calls=', 'renewal-period=', 'counter-key='], // quota-by-key-policy (calls or bandwidth, renewal-period, counter-key)
  };
  assert.deepEqual(Object.keys(policies.FRAGMENT_XML).sort(), [...ELEMENTS].sort());
  for (const [el, needles] of Object.entries(required)) {
    const xml = policies.FRAGMENT_XML[el];
    assert.ok(xml.startsWith(`<${el}`), `${el} fixture must be that element`);
    for (const n of needles) assert.ok(xml.includes(n), `${el} fixture lacks ${n}`);
  }
  assert.match(policies.FRAGMENT_XML['rate-limit-by-key'], /renewal-period="(\d+)"/);
  assert.ok(Number(/renewal-period="(\d+)"/.exec(policies.FRAGMENT_XML['rate-limit-by-key'])[1]) <= 300, 'rate-limit-by-key renewal-period max is 300 s');
  assert.ok(Number(/renewal-period="(\d+)"/.exec(policies.FRAGMENT_XML['quota-by-key'])[1]) >= 300, 'quota-by-key renewal-period min is 300 s');
  assert.equal(policies.FRAGMENT_XML['validate-azure-ad-token'].includes('tenant-id="organizations"'), true, 'a well-known tenant: no real tenant id in a public repo');
  // the combined fragment is the seven elements, in the PRP order, inside one <fragment>
  assert.ok(policies.COMBINED_XML.startsWith('<fragment>') && policies.COMBINED_XML.endsWith('</fragment>'));
  let at = -1;
  for (const el of ELEMENTS) {
    const i = policies.COMBINED_XML.indexOf(`<${el}`);
    assert.ok(i > at, `${el} out of PRP order in the combined fragment`);
    at = i;
  }
});

test('policies: when APIM accepts everything, all 22 element rows read accepted, controls pass, nothing is left, exit 0', async () => {
  // BREAKS IF: any row is not "accepted" on a gateway that accepts and returns every element, the controls
  // do not pass, scratch objects survive, or a non-scratch object is touched.
  const est = estate();
  const { result } = await runFamily('policies', est);
  for (const el of ELEMENTS) {
    assert.equal(text(result, `policies.element.${el}.single`), 'measured: accepted (HTTP 201/200)', `${el} single`);
    assert.equal(text(result, `policies.element.${el}.combined`), 'measured: accepted (HTTP 201/200)', `${el} combined`);
  }
  assert.equal(text(result, 'policies.combined.put'), 'measured: accepted (all 7 elements retained) (HTTP 201/200)');
  assert.equal(text(result, 'policies.control.positive'), 'measured: accepted (HTTP 201/200)');
  assert.equal(control(result, 'positive-known-good-fragment-accepted-and-returned').status, 'passed');
  assert.equal(control(result, 'negative-bogus-element-not-retained').status, 'passed');
  assert.equal(text(result, 'policies.namedValue.put'), 'measured: accepted (HTTP 201)');
  assert.equal(text(result, 'policies.namedValue.get'), 'measured: readable (displayName matches) (HTTP 201/200)');
  assert.equal(text(result, 'policies.namedValue.delete'), 'measured: deleted (GET after DELETE: 404) (HTTP 200/404)');
  assert.equal(text(result, 'policies.include-fragment.apiScope'), 'measured: accepted (HTTP 201/200)');
  assert.equal(text(result, 'policies.cleanup'), 'measured: 0 leftovers (HTTP 200)');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(scratchLeft(est), []);
  // a row carries the sent XML and the GET-back counts, so a wrong body is diagnosable from the artifact
  const row = cell(result, 'policies.element.quota-by-key.single');
  assert.deepEqual(row.evidence.getBack, { 'quota-by-key': { sent: 1, got: 1 } });
  assert.ok(row.evidence.sent.includes('<quota-by-key calls="10000"'));
  // every DELETE touched a scratch name only
  for (const d of est.calls.filter((c) => c.method === 'DELETE')) assert.match(d.path, /\/w0-apiplane-[a-z0-9-]+$/);
  // all fragments were read back as rawxml
  assert.ok(est.callsMatching('GET', /policyFragments\/w0-apiplane-el-trace$/).every((c) => c.query.get('format') === 'rawxml'));
});

test('policies: a 2xx PUT whose GET-back drops an element is "rejected (silently dropped)", per element, with the counts', async () => {
  // BREAKS IF: the GET-back comparison is removed (every row would read "accepted"), the drop is attributed to
  // the wrong element, or the single-element row for the same element is polluted by the combined result.
  const est = estate();
  est.drop = (id) => (id === 'w0-apiplane-combined' ? ['trace', 'quota-by-key'] : []);
  const { result } = await runFamily('policies', est);
  assert.equal(text(result, 'policies.element.trace.combined'), 'measured: rejected (silently dropped) (HTTP 201/200)');
  assert.equal(text(result, 'policies.element.quota-by-key.combined'), 'measured: rejected (silently dropped) (HTTP 201/200)');
  assert.equal(text(result, 'policies.element.llm-token-limit.combined'), 'measured: accepted (HTTP 201/200)');
  assert.equal(text(result, 'policies.combined.put'), 'measured: rejected (silently dropped) (HTTP 201/200)');
  assert.deepEqual(cell(result, 'policies.combined.put').evidence.dropped, ['trace', 'quota-by-key']);
  assert.deepEqual(cell(result, 'policies.element.trace.combined').evidence.thisElement, { sent: 1, got: 0 });
  assert.equal(text(result, 'policies.element.trace.single'), 'measured: accepted (HTTP 201/200)', 'the single-element fragment kept its element');
  assert.equal(result.exitCode, 0, 'a silent drop is a finding');
});

test('policies: a validation rejection is "rejected" with the status and the verbatim error code; the combined PUT is rejected as a whole', async () => {
  // BREAKS IF: the rejection is not quoted (status + code + message), the combined rows are called "accepted",
  // or the other elements are dragged down with the rejected one.
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /policyFragments\/w0-apiplane-(el-quota-by-key|combined)$/.test(r.path) ? jsonRes(400, rejectElementMessage('quota-by-key')) : undefined));
  const { result } = await runFamily('policies', est);
  assert.equal(text(result, 'policies.element.quota-by-key.single'), 'measured: rejected (HTTP 400)');
  const ev = cell(result, 'policies.element.quota-by-key.single').evidence;
  assert.equal(ev.put.status, 400);
  assert.equal(ev.put.code, 'ValidationError');
  assert.match(ev.put.message, /^Error in element 'quota-by-key' on line 1, column 11: The element 'quota-by-key' is not supported on this gateway\.$/);
  assert.equal(text(result, 'policies.element.rate-limit-by-key.single'), 'measured: accepted (HTTP 201/200)');
  assert.equal(text(result, 'policies.combined.put'), 'measured: rejected (HTTP 400)');
  for (const el of ELEMENTS) assert.match(text(result, `policies.element.${el}.combined`), /^measured: rejected \(the combined PUT was rejected as a whole/, el);
  assert.equal(result.exitCode, 0);
});

test('policies: a rejection that names an ATTRIBUTE is unknown:tooling-error (a probe defect), not "rejected"', async () => {
  // BREAKS IF: the attribute-vs-element classifier is removed - the SAME status and code, with an element-naming
  // message, must stay "rejected" (second half), so a classifier that always says tooling-error is red too.
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /policyFragments\/w0-apiplane-el-quota-by-key$/.test(r.path)
    ? jsonRes(400, { error: { code: 'ValidationError', message: "Error in element 'quota-by-key' on line 1, column 11: Required attribute 'calls' is missing" } }) : undefined));
  const { result } = await runFamily('policies', est);
  assert.equal(text(result, 'policies.element.quota-by-key.single'), 'unknown:tooling-error');
  assert.match(cell(result, 'policies.element.quota-by-key.single').evidence.why, /ATTRIBUTE/);
  assert.equal(result.exitCode, 3);

  const est2 = estate();
  est2.rules.push((r) => (r.method === 'PUT' && /policyFragments\/w0-apiplane-el-quota-by-key$/.test(r.path) ? jsonRes(400, rejectElementMessage('quota-by-key')) : undefined));
  const { result: r2 } = await runFamily('policies', est2);
  assert.equal(text(r2, 'policies.element.quota-by-key.single'), 'measured: rejected (HTTP 400)');
});

test('policies: a 403 on every write is unknown:permission naming the role - never "rejected" - and the controls are unrunnable, not failed', async () => {
  // BREAKS IF: a permission failure is reported as a rejected element (the PRP: 401/403 is never "no"),
  // the role is not named, or an unrunnable control invalidates the family (exit 2).
  const est = estate();
  est.rules.push((r) => ((r.method === 'PUT' || r.method === 'DELETE') && /policyFragments|namedValues|\/apis\//.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('policies', est);
  for (const el of ELEMENTS) {
    assert.equal(text(result, `policies.element.${el}.single`), 'unknown:permission:API Management Service Contributor@apim', el);
    assert.equal(text(result, `policies.element.${el}.combined`), 'unknown:permission:API Management Service Contributor@apim', el);
  }
  assert.equal(text(result, 'policies.namedValue.put'), 'unknown:permission:API Management Service Contributor@apim');
  assert.equal(text(result, 'policies.include-fragment.apiScope'), 'unknown:permission:API Management Service Contributor@apim');
  assert.equal(control(result, 'positive-known-good-fragment-accepted-and-returned').status, 'unrunnable');
  assert.equal(control(result, 'negative-bogus-element-not-retained').status, 'unrunnable');
  assert.equal(result.valid, true);
  assert.equal(result.exitCode, 3);
});

test('policies POSITIVE control: a known-good fragment that is rejected makes the family INVALID (exit 2) and stops the element rows', async () => {
  // BREAKS IF: the positive control is skipped - the element rows would run and exit would be 0 even though the
  // probe cannot get an accepted fragment through. Every declared cell must still be present (unknown, not absent).
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /policyFragments\/w0-apiplane-ctl-positive$/.test(r.path) ? jsonRes(400, rejectElementMessage('rate-limit-by-key')) : undefined));
  const { result } = await runFamily('policies', est);
  assert.equal(control(result, 'positive-known-good-fragment-accepted-and-returned').status, 'failed');
  assert.equal(result.exitCode, 2);
  assert.equal(result.valid, false);
  assert.equal(est.callsMatching('PUT', /policyFragments\/w0-apiplane-el-/).length, 0, 'no element row may run after a failed control');
  assert.deepEqual(result.cells.map((c) => c.id).sort(), [...policies.CELL_IDS].sort(), 'every declared cell is present');
  assert.equal(text(result, 'policies.element.trace.single'), 'unknown:tooling-error');
  assert.deepEqual(scratchLeft(est), [], 'cleanup still ran');
});

test('policies NEGATIVE control: a bogus element that APIM accepts and returns means APIM is not validating - exit 2; dropped or rejected passes', async () => {
  // BREAKS IF: the negative control is skipped or inverted. Three inputs: accepted+returned (must FAIL),
  // accepted but silently dropped (passes: the probe can see a non-retained element), explicitly rejected (passes).
  const est = estate();
  est.validate = false;
  const { result } = await runFamily('policies', est);
  assert.equal(control(result, 'negative-bogus-element-not-retained').status, 'failed');
  assert.match(control(result, 'negative-bogus-element-not-retained').detail, /not validating/);
  assert.equal(result.exitCode, 2);

  const dropper = estate();
  dropper.validate = false;
  dropper.drop = (id) => (id === 'w0-apiplane-ctl-negative' ? ['w0-apiplane-not-a-policy'] : []);
  const { result: dropped } = await runFamily('policies', dropper);
  assert.equal(control(dropped, 'negative-bogus-element-not-retained').status, 'passed');
  assert.equal(text(dropped, 'policies.control.negative'), 'measured: rejected (silently dropped) (HTTP 201/200)');
  assert.equal(dropped.exitCode, 0);

  const strict = estate();
  const { result: rejected } = await runFamily('policies', strict);
  assert.equal(text(rejected, 'policies.control.negative'), 'measured: rejected (HTTP 400)');
  assert.equal(control(rejected, 'negative-bogus-element-not-retained').status, 'passed');
});

test('policies: the include-fragment row targets the positive-control fragment, which is created first, and is also tested at API scope', async () => {
  // BREAKS IF: include-fragment references a fragment that does not exist yet, or the API-scope test is dropped.
  const est = estate();
  const { result } = await runFamily('policies', est);
  const puts = est.calls.filter((c) => c.method === 'PUT' && /policyFragments\//.test(c.path)).map((c) => c.path.split('/').pop());
  assert.ok(puts.indexOf('w0-apiplane-ctl-positive') >= 0 && puts.indexOf('w0-apiplane-ctl-positive') < puts.indexOf('w0-apiplane-el-include-fragment'));
  assert.ok(est.callsMatching('PUT', /policyFragments\/w0-apiplane-el-include-fragment$/)[0].body.properties.value.includes('fragment-id="w0-apiplane-ctl-positive"'));
  const apiPolicy = est.callsMatching('PUT', /apis\/w0-apiplane-pol-api\/policies\/policy$/)[0];
  assert.ok(apiPolicy.body.properties.value.includes('<include-fragment fragment-id="w0-apiplane-ctl-positive" />'));
  assert.equal(text(result, 'policies.include-fragment.apiScope'), 'measured: accepted (HTTP 201/200)');

  const est2 = estate();
  est2.rules.push((r) => (r.method === 'PUT' && /apis\/w0-apiplane-pol-api\/policies\/policy$/.test(r.path) ? jsonRes(400, rejectElementMessage('include-fragment')) : undefined));
  const { result: r2 } = await runFamily('policies', est2);
  assert.equal(text(r2, 'policies.include-fragment.apiScope'), 'measured: rejected (HTTP 400)');
  assert.equal(text(r2, 'policies.element.include-fragment.single'), 'measured: accepted (HTTP 201/200)', 'fragment scope and API scope are separate measurements');
});

test('policies: provisioningState InProgress is waited out on the injected clock; a state that never settles is unknown, not accepted', async () => {
  // BREAKS IF: the GET-back is read once without waiting (an InProgress read would be compared as the final
  // state), the wait spends real time, or a never-settling state is reported as accepted.
  const est = estate();
  est.inProgressGets = 2;
  const { result } = await runFamily('policies', est);
  assert.equal(text(result, 'policies.control.positive'), 'measured: accepted (HTTP 201/200)');
  assert.ok(est.clock.sleeps.includes(2000), 'the wait slept 2 s on the fake clock');

  const stuck = estate();
  stuck.inProgressGets = Infinity;
  const { result: r2 } = await runFamily('policies', stuck);
  assert.equal(text(r2, 'policies.control.positive'), 'unknown:transient-exhausted');
  assert.equal(control(r2, 'positive-known-good-fragment-accepted-and-returned').status, 'unrunnable');
});

test('policies: a named value PUT that is rejected or forbidden leaves the dependent cells unknown, and the scratch value is deleted with a 404 proof', async () => {
  // BREAKS IF: a forbidden PUT is called "rejected", a dependent cell is invented, or the delete proof
  // reads success without a GET that answered 404.
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /namedValues\//.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('policies', est);
  for (const n of ['put', 'get', 'delete']) assert.equal(text(result, `policies.namedValue.${n}`), 'unknown:permission:API Management Service Contributor@apim', n);

  const est2 = estate();
  est2.nvDeleteIgnored = true;
  const { result: r2 } = await runFamily('policies', est2);
  assert.equal(text(r2, 'policies.namedValue.delete'), 'measured: NOT deleted (GET after DELETE still answers 200) (HTTP 200/200)');
  assert.equal(r2.exitCode, 3, 'a leftover named value fails the family');
  assert.equal(r2.cells.find((c) => c.id === 'policies.cleanup').evidence.leftovers, 1);
});

// ===========================================================================
// 7. mcp (W0-3)
// ===========================================================================

const seedApis = (est) => {
  est.apis.set('existing-http-api', { type: 'http', path: 'a' });
  est.apis.set('existing-mcp-api', { type: 'mcp', path: 'b', mcpProperties: { transportType: 'sse' } });
  est.apis.set('another-api', { path: 'c' });
};

test('mcp: the fixture bodies satisfy the Learn constraints they were written from', () => {
  // BREAKS IF: a fixture violates a Learn-documented constraint, which would make APIM reject a good body for
  // the wrong reason. Constraints transcribed from the Learn ARM reference for service/apis (2025-09-01-preview):
  // transportType in {sse, streamable}; endpoint name 1..300 chars; uriTemplate ^/.*$; path max 400; serviceUrl max 2000.
  for (const body of [mcp.MCP_BODY_A, mcp.MCP_BODY_B]) {
    assert.equal(body.type, 'mcp');
    assert.ok(['sse', 'streamable'].includes(body.mcpProperties.transportType));
    assert.ok(body.path.length <= 400 && body.serviceUrl.length <= 2000);
    assert.deepEqual(body.protocols, ['https']);
    assert.equal(body.serviceUrl, 'https://learn.microsoft.com/api/mcp');
    assert.ok(/^[^*#&+:<>?]+$/.test(body.displayName), 'display name must satisfy the API id pattern too');
  }
  assert.equal(mcp.MCP_BODY_A.mcpProperties.endpoints, undefined, 'variant A sends no endpoints, so the GET-back endpoints are APIM\'s own');
  for (const ep of mcp.MCP_BODY_B.mcpProperties.endpoints) {
    assert.ok(ep.name.length >= 1 && ep.name.length <= 300);
    assert.match(ep.uriTemplate, /^\/.*$/);
  }
  assert.ok(/<rate-limit-by-key calls="5" renewal-period="30" counter-key=/.test(mcp.MCP_POLICY), 'the MCP policy is the Learn MCP page example');
});

test('mcp: happy path - filter + unfiltered list, passthrough create with mcpProperties recorded VERBATIM, policy, blank-path .well-known, nothing left', async () => {
  // BREAKS IF: mcpProperties is summarised instead of quoted, variant A sends endpoints (so the observed
  // endpoints would just be an echo), the MCP API is read back at the wrong api-version, a customer API is touched,
  // or the cleanup is incomplete.
  const est = estate();
  seedApis(est);
  const { result } = await runFamily('mcp', est);
  assert.equal(text(result, 'mcp.list.typeFilter'), 'measured: type filter accepted; 1 MCP API(s) returned (HTTP 200)');
  assert.equal(text(result, 'mcp.list.mcpApiCount'), 'measured: 1 of 3 API(s) are type mcp (HTTP 200)');
  assert.equal(text(result, 'mcp.create.passthrough'), 'measured: accepted (type mcp retained) (HTTP 201/200)');
  // verbatim: the object APIM (here: the fake) returned, including the endpoints it computed
  assert.deepEqual(cell(result, 'mcp.create.mcpProperties').value, { transportType: 'streamable', endpoints: [{ name: 'mcp', uriTemplate: '/mcp' }] });
  assert.equal(text(result, 'mcp.create.policy'), 'measured: accepted (HTTP 201/200)');
  assert.equal(text(result, 'mcp.blankPath.api'), 'measured: accepted (blank path) (HTTP 201)');
  assert.equal(text(result, 'mcp.blankPath.wellKnownOperation'), 'measured: accepted (urlTemplate retained) (HTTP 201/200)');
  assert.equal(text(result, 'mcp.cleanup'), 'measured: 0 leftovers (HTTP 200)');
  assert.equal(control(result, 'a-list-call-answers-200-with-value').status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.deepEqual([...est.apis.keys()].sort(), ['another-api', 'existing-http-api', 'existing-mcp-api'], 'only customer APIs remain');
  const sent = est.callsMatching('PUT', /apis\/w0-apiplane-mcp-api$/)[0];
  assert.equal(sent.query.get('api-version'), '2025-09-01-preview');
  assert.equal(sent.body.properties.type, 'mcp');
  assert.equal(sent.body.properties.mcpProperties.endpoints, undefined);
  assert.equal(sent.body.properties.serviceUrl, 'https://learn.microsoft.com/api/mcp');
  for (const c of est.callsMatching('GET', /apis\/w0-apiplane-mcp-api(\/policies\/policy)?$/)) assert.equal(c.query.get('api-version'), '2025-09-01-preview', 'MCP reads use the preview version');
  const wk = est.callsMatching('PUT', /apis\/w0-apiplane-mcp-wk$/)[0];
  assert.equal(wk.body.properties.path, '');
  assert.equal(wk.query.get('api-version'), '2024-05-01');
  assert.equal(est.callsMatching('PUT', /operations\/w0-apiplane-mcp-wk-op$/)[0].body.properties.urlTemplate, '/.well-known/w0-apiplane-probe');
  const typeFilterCall = est.calls.find((c) => c.method === 'GET' && /\/apis$/.test(c.path) && c.query.get('$filter'));
  assert.equal(typeFilterCall.query.get('$filter'), "type eq 'mcp'", 'the filter is issued exactly as the PRP wrote it');
});

test('mcp: when the type filter is rejected the unfiltered list is the control, and the 400 is a measured fact, not a failed control', async () => {
  // BREAKS IF: the control is tied to the FILTERED call (exit 2 on a boundary whose filter rejects `type`,
  // the "could not pass" shape), the 400 is not quoted, or the count is not taken client-side.
  const est = estate();
  seedApis(est);
  est.typeFilter = 'rejected';
  const { result } = await runFamily('mcp', est);
  assert.equal(text(result, 'mcp.list.typeFilter'), 'measured: rejected (the type filter was not accepted) (HTTP 400)');
  assert.equal(cell(result, 'mcp.list.typeFilter').evidence.code, 'InvalidFilter');
  assert.match(cell(result, 'mcp.list.typeFilter').evidence.learnFilterFields, /not type/);
  assert.equal(text(result, 'mcp.list.mcpApiCount'), 'measured: 1 of 3 API(s) are type mcp (HTTP 200)');
  assert.equal(control(result, 'a-list-call-answers-200-with-value').status, 'passed');
  assert.match(control(result, 'a-list-call-answers-200-with-value').detail, /unfiltered list/);
  assert.equal(result.exitCode, 0);
});

test('mcp: a boundary that does not serve the preview api-version is not-measured:api-version-unsupported-in-boundary, with the error code, and the stable-version cells still run', async () => {
  // BREAKS IF: an api-version rejection is read as "MCP unsupported" (rejected) or as an instrument error,
  // the code is not kept, dependent cells are invented, or the sweep cannot clean up through the stable version.
  const est = estate();
  est.previewOk = false;
  const { result } = await runFamily('mcp', est);
  for (const id of ['mcp.list.typeFilter', 'mcp.list.mcpApiCount', 'mcp.create.passthrough', 'mcp.create.mcpProperties', 'mcp.create.policy']) {
    assert.equal(text(result, id), 'not-measured:api-version-unsupported-in-boundary', id);
  }
  assert.equal(cell(result, 'mcp.create.passthrough').evidence.code, 'InvalidApiVersionParameter');
  assert.equal(cell(result, 'mcp.create.passthrough').evidence.apiVersion, '2025-09-01-preview');
  assert.equal(control(result, 'a-list-call-answers-200-with-value').status, 'unrunnable');
  assert.equal(text(result, 'mcp.blankPath.api'), 'measured: accepted (blank path) (HTTP 201)');
  assert.equal(text(result, 'mcp.cleanup'), 'measured: 0 leftovers (HTTP 200)');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(scratchLeft(est), []);
});

test('mcp: a create body rejected in both variants records both attempts verbatim, carries the cross-cloud rule, and leaves dependent cells unknown (exit 3)', async () => {
  // BREAKS IF: only one variant is tried, the attempts are not recorded with the bodies sent, the cross-run rule
  // ("rejected in both clouds is an instrument defect") is dropped, or the dependents are called measured.
  const est = estate();
  est.mcpMode = 'reject';
  const { result } = await runFamily('mcp', est);
  assert.equal(text(result, 'mcp.create.passthrough'), 'measured: rejected (HTTP 400)');
  const attempts = cell(result, 'mcp.create.passthrough').evidence.attempts;
  assert.deepEqual(attempts.map((a) => a.variant), ['A: transportType only', 'B: Learn sample with endpoints']);
  assert.deepEqual(attempts.map((a) => a.status), [400, 400]);
  assert.equal(attempts[1].sent.mcpProperties.endpoints[0].uriTemplate, '/mcp/messages');
  assert.match(cell(result, 'mcp.create.passthrough').evidence.crossRunRule, /BOTH clouds/);
  assert.equal(text(result, 'mcp.create.mcpProperties'), 'unknown:tooling-error');
  assert.equal(text(result, 'mcp.create.policy'), 'unknown:tooling-error');
  assert.equal(result.exitCode, 3);
});

test('mcp: variant B is used only when A is rejected, and the artifact says which one worked', async () => {
  // BREAKS IF: the fallback never happens (a body that needs endpoints reads as "MCP rejected"), or A is skipped.
  const est = estate();
  est.mcpMode = 'reject-without-endpoints';
  const { result } = await runFamily('mcp', est);
  assert.equal(text(result, 'mcp.create.passthrough'), 'measured: accepted (type mcp retained) (HTTP 201/200)');
  assert.equal(cell(result, 'mcp.create.passthrough').evidence.usedVariant, 'B: Learn sample with endpoints');
  assert.equal(cell(result, 'mcp.create.passthrough').evidence.attempts.length, 2);
  assert.deepEqual(cell(result, 'mcp.create.mcpProperties').value.endpoints, [{ name: 'message', uriTemplate: '/mcp/messages' }]);
  assert.equal(result.exitCode, 0);
});

test('mcp: a 2xx create whose GET-back lost the type is "rejected (silently dropped)" and mcpProperties is "absent"', async () => {
  // BREAKS IF: a 2xx PUT is trusted without reading the type back (the older-gateway shape: an unknown preview
  // property is ignored and a plain HTTP API is created).
  const est = estate();
  est.mcpMode = 'drop-type';
  const { result } = await runFamily('mcp', est);
  assert.equal(text(result, 'mcp.create.passthrough'), 'measured: rejected (silently dropped) (HTTP 201/200)');
  assert.equal(cell(result, 'mcp.create.passthrough').evidence.gotType, null);
  assert.equal(cell(result, 'mcp.create.passthrough').evidence.hasMcpProperties, false);
  assert.equal(text(result, 'mcp.create.mcpProperties'), 'measured: absent from the GET-back (HTTP 200)');
});

test('mcp: a 403 on the create is unknown:permission (and so are its dependents), never "rejected"', async () => {
  // BREAKS IF: a permission failure is read as the boundary rejecting the MCP type.
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /apis\/w0-apiplane-mcp-api$/.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('mcp', est);
  for (const id of ['mcp.create.passthrough', 'mcp.create.mcpProperties', 'mcp.create.policy']) {
    assert.equal(text(result, id), 'unknown:permission:API Management Service Contributor@apim', id);
  }
  assert.equal(est.callsMatching('PUT', /apis\/w0-apiplane-mcp-api$/).length, 1, 'a 403 is final: no second body variant is tried');
  assert.equal(result.exitCode, 3);
});

test('mcp: a blank-path API that conflicts is "rejected" with the verbatim message, and its operation is unknown (not attempted)', async () => {
  // BREAKS IF: a path conflict with an existing root API is hidden, or the operation is called measured.
  const est = estate();
  est.blankPathConflict = true;
  const { result } = await runFamily('mcp', est);
  assert.equal(text(result, 'mcp.blankPath.api'), 'measured: rejected (HTTP 409)');
  assert.equal(cell(result, 'mcp.blankPath.api').evidence.put.message, 'Another API already uses the empty path.');
  assert.equal(text(result, 'mcp.blankPath.wellKnownOperation'), 'unknown:tooling-error');
  assert.equal(result.exitCode, 3);
});

test('mcp: a leftover MCP API from a crashed earlier run is deleted through the preview version before anything is measured', async () => {
  // BREAKS IF: the sweep lists APIs only at the stable version (an MCP-type API could be invisible there) or
  // deletes it with the wrong version.
  const est = estate();
  est.apis.set('w0-apiplane-mcp-api', { type: 'mcp', path: 'w0-apiplane-mcp' });
  const { result } = await runFamily('mcp', est);
  const del = est.callsMatching('DELETE', /apis\/w0-apiplane-mcp-api$/)[0];
  assert.equal(del.query.get('api-version'), '2025-09-01-preview');
  assert.equal(text(result, 'mcp.cleanup'), 'measured: 0 leftovers (HTTP 200)');
});

// ===========================================================================
// 8. identity (W0-4)
// ===========================================================================

test('identity: all three reads answered - yes/no cells, role NAMES only, and none of the ids reach the output', async () => {
  // BREAKS IF: a role id / principal id / app id is printed, role names are not resolved, assignments to other
  // APIs are named as Graph roles, or the control is not recorded.
  const est = estate();
  const { result } = await runFamily('identity', est);
  assert.equal(text(result, 'identity.graph.agentIdentityReadAll'), 'measured: yes (HTTP 200)');
  assert.deepEqual(cell(result, 'identity.graph.agentIdentityReadAll').evidence.agentIdentityRoles, ['AgentIdentity.Read.All', 'AgentIdentity.ReadWrite.All']);
  assert.deepEqual(cell(result, 'identity.uami.graphAppRoles').value, {
    uami: 'uami-loom-console-centralus',
    graphAppRoles: ['Directory.Read.All', 'User.Read.All'],
    graphAssignmentsWithUnresolvedRoleName: 0,
    assignmentsToOtherApis: 1,
  });
  assert.equal(text(result, 'identity.signinApp.groupMembershipClaims'), 'measured: yes (HTTP 200)');
  assert.equal(control(result, 'graph-service-principal-read-succeeded').status, 'passed');
  assert.equal(result.exitCode, 0);
  const dump = JSON.stringify(result);
  for (const needle of [PRINCIPAL, GRAPH_SP_OBJECT, ROLE_DIRECTORY, ROLE_USER, ROLE_AGENT_RO, ROLE_AGENT_RW, OTHER_SP_OBJECT, GRAPH_APP_ID]) assert.ok(!dump.includes(needle), `leaked ${needle}`);
  // every Graph call used the run's own token audience and the right host
  assert.ok(sawAudience(est, 'https://graph.microsoft.com'));
  assert.equal(est.calls.filter((c) => c.origin === 'https://graph.microsoft.com').length, 3);
});

test('identity: AgentIdentity.Read.All absent from the Graph roles is a "no" with the neighbouring roles listed', async () => {
  // BREAKS IF: presence is decided by prefix (AgentIdentity.ReadWrite.All must not count), or the "no" carries
  // no evidence of what WAS there.
  const est = estate();
  est.graphSp = { ...est.graphSp, appRoles: est.graphSp.appRoles.filter((r) => r.value !== 'AgentIdentity.Read.All') };
  const { result } = await runFamily('identity', est);
  assert.equal(text(result, 'identity.graph.agentIdentityReadAll'), 'measured: no (HTTP 200)');
  assert.deepEqual(cell(result, 'identity.graph.agentIdentityReadAll').evidence.agentIdentityRoles, ['AgentIdentity.ReadWrite.All']);
  assert.equal(cell(result, 'identity.graph.agentIdentityReadAll').evidence.appRoleCount, 3);
});

test('identity: an unreadable Graph (403) is unknown:permission everywhere - never "no" - and exits 0 because none of it is required', async () => {
  // BREAKS IF: a 403 is rendered as "no" (the PRP: "an unreadable Graph is unknown, never no"), the permission
  // is not named, role names are invented without the Graph roles, or the family turns red for it.
  const est = estate();
  est.rules.push((r) => (r.origin === est.graph ? arm403 : undefined));
  const { result } = await runFamily('identity', est);
  for (const id of ['identity.graph.agentIdentityReadAll', 'identity.uami.graphAppRoles', 'identity.signinApp.groupMembershipClaims']) {
    assert.equal(text(result, id), 'unknown:permission:Application.Read.All@tenant', id);
    assert.equal(cell(result, id).required, false);
  }
  assert.equal(control(result, 'graph-service-principal-read-succeeded').status, 'unrunnable');
  assert.ok(!result.cells.some((c) => c.verdict === 'measured'), 'nothing may read as a measurement');
  assert.equal(result.exitCode, 0);
  assert.equal(result.valid, true);
});

test('identity CONTROL: a 200 that is not the Graph service principal makes the family INVALID (exit 2)', async () => {
  // BREAKS IF: the control is skipped: an empty or wrong directory answer would be published as "no".
  const est = estate();
  est.graphSp = { id: GRAPH_SP_OBJECT, appId: GRAPH_APP_ID };
  const { result } = await runFamily('identity', est);
  assert.equal(control(result, 'graph-service-principal-read-succeeded').status, 'failed');
  assert.equal(result.exitCode, 2);
  assert.equal(text(result, 'identity.graph.agentIdentityReadAll'), 'unknown:tooling-error');

  const est2 = estate();
  est2.graphSp = { ...est2.graphSp, appId: '11111111-2222-3333-4444-555555555555' };
  const { result: r2 } = await runFamily('identity', est2);
  assert.equal(control(r2, 'graph-service-principal-read-succeeded').status, 'failed', 'a different service principal is not Microsoft Graph');
});

test('identity: the sign-in app answers yes/no only when EXACTLY ONE app matches; zero or many is unknown:not-located', async () => {
  // BREAKS IF: no match is rendered as "no" (the flag is unread, not unset), several matches are merged into a
  // verdict, or a null / All claim is rendered as yes.
  const est = estate();
  est.apps = [];
  const { result: none } = await runFamily('identity', est);
  assert.equal(text(none, 'identity.signinApp.groupMembershipClaims'), 'unknown:not-located');
  assert.equal(cell(none, 'identity.signinApp.groupMembershipClaims').evidence.matchedApps, 0);

  est.apps = [{ displayName: 'CSA Loom Console (a)', groupMembershipClaims: 'SecurityGroup' }, { displayName: 'CSA Loom Console (b)', groupMembershipClaims: 'None' }];
  const { result: many } = await runFamily('identity', est);
  assert.equal(text(many, 'identity.signinApp.groupMembershipClaims'), 'unknown:not-located');
  assert.equal(cell(many, 'identity.signinApp.groupMembershipClaims').evidence.matchedApps, 2);

  for (const [claim, shown] of [[null, null], ['All', 'All'], ['SecurityGroup', 'SecurityGroup']]) {
    est.apps = [{ displayName: 'CSA Loom Console (kv)', groupMembershipClaims: claim }];
    const { result } = await runFamily('identity', est);
    assert.equal(text(result, 'identity.signinApp.groupMembershipClaims'), claim === 'SecurityGroup' ? 'measured: yes (HTTP 200)' : 'measured: no (HTTP 200)', String(claim));
    assert.equal(cell(result, 'identity.signinApp.groupMembershipClaims').evidence.groupMembershipClaims, shown);
  }
  const url = est.calls.filter((c) => c.path === '/v1.0/applications').pop();
  assert.equal(url.headers.consistencylevel, 'eventual');
  assert.equal(url.query.get('$count'), 'true');
  assert.equal(url.query.get('$filter'), "startswith(displayName,'CSA Loom Console')");
});

test('identity: a Console UAMI that is not among the identities is unknown:not-located, never "no roles"', async () => {
  // BREAKS IF: an identity that could not be found is reported as holding no roles.
  const est = estate();
  est.identities = [{ name: 'unrelated-identity', properties: { principalId: OTHER_SP_OBJECT } }];
  const { result } = await runFamily('identity', est);
  assert.equal(text(result, 'identity.uami.graphAppRoles'), 'unknown:not-located');
  assert.equal(cell(result, 'identity.uami.graphAppRoles').evidence.identitiesVisible, 1);
  assert.equal(cell(result, 'identity.uami.graphAppRoles').evidence.searchedNamePrefix, 'uami-loom-console');
});

test('identity: a 403 on the identities list names Reader on the subscription, and a 403 on the assignments names the Graph permission', async () => {
  // BREAKS IF: both are reported with the same role (the operator is told to grant the wrong thing).
  const est = estate();
  est.rules.push((r) => (r.origin === est.arm && /userAssignedIdentities$/.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('identity', est);
  assert.equal(text(result, 'identity.uami.graphAppRoles'), 'unknown:permission:Reader@subscription');

  const est2 = estate();
  est2.rules.push((r) => (/appRoleAssignments$/.test(r.path) ? arm403 : undefined));
  const { result: r2 } = await runFamily('identity', est2);
  assert.equal(text(r2, 'identity.uami.graphAppRoles'), 'unknown:permission:Application.Read.All@tenant');
});

test('identity in Government reads graph.microsoft.us with a graph.microsoft.us token', async () => {
  // BREAKS IF: a Gov run is sent to the Commercial Graph host (the Gov-only fake has no such route, so every
  // read would be unknown) or mints a token for the wrong audience.
  const est = estate({ cloud: 'gov' });
  const { result } = await runFamily('identity', est);
  assert.equal(text(result, 'identity.graph.agentIdentityReadAll'), 'measured: yes (HTTP 200)');
  assert.ok(sawAudience(est, 'https://graph.microsoft.us'));
  assert.ok(sawAudience(est, 'https://management.usgovcloudapi.net'));
  assert.ok(!sawAudience(est, 'https://graph.microsoft.com'));
  assert.equal(result.cloud, 'gov');
});

// ===========================================================================
// 9. latency (W0-6) - on a FAKE clock: sleep() advances it, nothing really waits
// ===========================================================================

test('latency: A and B are timed on the injected clock (7 s and 42 s by construction), every poll interval is >= 1 s, deletion is proven with 404s', async () => {
  // BREAKS IF: time is read from the wall clock (the fake clock would give ~0 s), the interval drops below 1 s,
  // the named value is deleted before the API that references it, or B is measured from a stale start. The expected
  // numbers are the fake gateway's own delays (7000 and 42000 ms), not computed by the code under test.
  const est = estate();
  const { result } = await runFamily('latency', est, { latencyPollSeconds: 900 });
  assert.equal(text(result, 'latency.valueA'), 'measured: 7 s (HTTP 200)');
  assert.equal(text(result, 'latency.valueB'), 'measured: 42 s (HTTP 200)');
  assert.equal(cell(result, 'latency.valueA').evidence.polls.polls, 8, 'polls at +0..+7000 ms, one per second');
  assert.equal(cell(result, 'latency.valueA').evidence.polls.notOk, 7, 'the route answered 404 until the policy propagated');
  assert.equal(cell(result, 'latency.valueB').evidence.polls.polls, 43);
  assert.equal(cell(result, 'latency.valueB').evidence.polls.otherBodies, 42, 'the OLD value A was served for 42 polls before B appeared');
  assert.equal(cell(result, 'latency.valueB').evidence.secondsFromPutReturned, 42);
  assert.ok(est.clock.sleeps.length === 49 && est.clock.sleeps.every((s) => s >= 1000), 'every poll sleep is at least 1 s');
  assert.equal(text(result, 'latency.delete.proof'), 'measured: both scratch objects deleted (GET: 404 / 404) (HTTP 404/404)');
  assert.equal(text(result, 'latency.cleanup'), 'measured: 0 leftovers (HTTP 200)');
  assert.equal(control(result, 'value-A-observed-at-the-gateway').status, 'passed');
  assert.equal(result.exitCode, 0);
  const order = est.calls.filter((c) => c.method === 'DELETE').map((c) => c.path.slice(est.armBase.length));
  assert.deepEqual(order, ['/apis/w0-apiplane-lat-api', '/namedValues/w0-apiplane-latency']);
  // the scratch objects are what the brief names, and the policy returns the named value by its DISPLAY name
  assert.equal(est.callsMatching('PUT', /namedValues\/w0-apiplane-latency$/)[0].body.properties.displayName, 'w0-apiplane-latency');
  assert.ok(est.callsMatching('PUT', /apis\/w0-apiplane-lat-api\/policies\/policy$/)[0].body.properties.value.includes('<set-body>{{w0-apiplane-latency}}</set-body>'));
  assert.equal(est.callsMatching('PUT', /apis\/w0-apiplane-lat-api$/)[0].body.properties.subscriptionRequired, false);
  // the second write is an UPDATE: it carries If-Match
  const nvPuts = est.callsMatching('PUT', /namedValues\/w0-apiplane-latency$/);
  assert.equal(nvPuts.length, 2);
  assert.equal(nvPuts[0].headers['if-match'], undefined);
  assert.equal(nvPuts[1].headers['if-match'], '*');
  assert.equal(nvPuts[0].body.properties.value, 'A-00000001');
  assert.equal(nvPuts[1].body.properties.value, 'B-00000002');
});

test('latency: a value B that is never seen is "not observed within <cap> s" - the cap, never a made-up number - after exactly cap+1 polls', async () => {
  // BREAKS IF: a number is printed for an unobserved value, the cap is not the --latency-poll-seconds input, the
  // loop ends early or late (61 polls at 60 s), or an unobserved B is treated as a failed control.
  const est = estate();
  est.latency.delayB = Infinity;
  const { result } = await runFamily('latency', est, { latencyPollSeconds: 60 });
  const b = cell(result, 'latency.valueB');
  assert.equal(b.value, 'not observed within 60 s');
  assert.equal(text(result, 'latency.valueB'), 'measured: not observed within 60 s (HTTP 200)');
  assert.equal(b.evidence.polls.matched, 0);
  assert.equal(b.evidence.polls.polls, 61);
  assert.equal(b.evidence.polls.otherBodies, 61, 'the gateway kept serving the old value');
  assert.equal(b.evidence.secondsFromPutReturned, undefined, 'no elapsed time may be quoted for an unobserved value');
  assert.match(b.evidence.note, /no latency is quoted/);
  assert.equal(text(result, 'latency.valueA'), 'measured: 7 s (HTTP 200)', 'A still reports its own observation');
  assert.equal(control(result, 'value-A-observed-at-the-gateway').status, 'passed');
  assert.equal(result.exitCode, 0, 'an unobserved B is a finding, not a failure');
  assert.ok(est.clock.sleeps.every((s) => s >= 1000));
});

test('latency CONTROL: if the first value A is never served the scratch API is broken - exit 2, B is not attempted', async () => {
  // BREAKS IF: the control is skipped (the run would go on to write B and publish "B not observed" about a
  // broken scratch API), or B is written anyway.
  const est = estate();
  est.latency.delayA = Infinity;
  const { result } = await runFamily('latency', est, { latencyPollSeconds: 60 });
  assert.equal(control(result, 'value-A-observed-at-the-gateway').status, 'failed');
  assert.match(control(result, 'value-A-observed-at-the-gateway').detail, /never answered the first value within 60 s/);
  assert.equal(result.exitCode, 2);
  assert.equal(result.valid, false);
  assert.equal(text(result, 'latency.valueB'), 'unknown:tooling-error');
  assert.equal(est.callsMatching('PUT', /namedValues\/w0-apiplane-latency$/).length, 1, 'B must not be written after a failed control');
  assert.deepEqual(scratchLeft(est), [], 'cleanup still ran');
});

test('latency: an unreachable gateway is not-measured:gateway-unreachable-from-runner for the whole family, exit 0, and nothing is created', async () => {
  // BREAKS IF: an unreachable gateway is reported as a latency or an error, scratch objects are created anyway,
  // or the error class is dropped. The cleanup sweep must still list.
  const est = estate();
  est.gatewayDown = true;
  const { result } = await runFamily('latency', est, { runner: 'hosted' });
  for (const id of ['latency.valueA', 'latency.valueB', 'latency.delete.proof']) {
    assert.equal(text(result, id), 'not-measured:gateway-unreachable-from-runner', id);
    assert.equal(cell(result, id).dataPlane, true);
  }
  assert.equal(cell(result, 'latency.valueA').evidence.errorClass, 'timeout');
  assert.equal(est.calls.filter((c) => c.method === 'PUT').length, 0, 'nothing may be created when the gateway cannot be polled');
  assert.equal(text(result, 'latency.cleanup'), 'measured: 0 leftovers (HTTP 200)');
  assert.equal(result.exitCode, 0);
});

test('latency: a forbidden named-value write blocks valueA/valueB as unknown:permission (required) and creates no API', async () => {
  // BREAKS IF: a management-plane permission failure is hidden behind exit 0 (the data-plane cells are optional,
  // the writes that feed them are not), or the API is created without its named value.
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /namedValues\//.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('latency', est);
  assert.equal(text(result, 'latency.valueA'), 'unknown:permission:API Management Service Contributor@apim');
  assert.equal(text(result, 'latency.valueB'), 'unknown:permission:API Management Service Contributor@apim');
  assert.equal(cell(result, 'latency.valueA').required, true);
  assert.equal(est.callsMatching('PUT', /apis\//).length, 0);
  assert.equal(result.exitCode, 3);
});

test('latency: a delete that did not delete is reported ("NOT deleted") and fails the family through the leftover count', async () => {
  // BREAKS IF: the delete proof says "deleted" without a 404, or a surviving scratch object is not exit 3.
  const est = estate();
  est.nvDeleteIgnored = true;
  const { result } = await runFamily('latency', est);
  assert.equal(text(result, 'latency.delete.proof'), 'measured: NOT deleted: a GET after DELETE still answers 200 (HTTP 404/200)');
  assert.equal(result.cells.find((c) => c.id === 'latency.cleanup').evidence.leftovers, 1);
  assert.equal(result.exitCode, 3);
});

// ===========================================================================
// 10. foundry (W0-7)
// ===========================================================================

test('foundry (Commercial): Anthropic model NAMES (unique, sorted) plus the distinct formats, from the APIM region; DNS is a class, never an address', async () => {
  // BREAKS IF: duplicates or ordering leak into the cell, the wrong region is listed, the formats list is lost,
  // the resolved address is printed, or the control is not recorded.
  const est = estate();
  const looked = [];
  const deps = mkDeps(est, { dnsLookup: async (host) => { looked.push(host); return [IP_PRIVATE]; } });
  const { result } = await runFamily('foundry', est, { deps });
  assert.equal(text(result, 'foundry.models.anthropic'), 'measured: claude-fixture-a, claude-fixture-b (HTTP 200)');
  assert.deepEqual(cell(result, 'foundry.models.formats').value, { formats: ['Anthropic', 'OpenAI'], totalModels: 4 });
  assert.equal(cell(result, 'foundry.models.anthropic').evidence.location, 'centralus', '"Central US" is normalised to the ARM location name');
  assert.equal(text(result, 'foundry.dns.servicesAiAzureCom'), 'measured: resolves-private (source: dns-lookup-from-in-vnet-runner)');
  assert.equal(cell(result, 'foundry.dns.servicesAiAzureCom').evidence.nameSource, 'synthetic');
  assert.deepEqual(looked, ['w0-apiplane-dns-probe.services.ai.azure.com']);
  assert.ok(!JSON.stringify(result).includes(IP_PRIVATE), 'the address must never be printed');
  assert.equal(control(result, 'models-list-is-a-real-list').status, 'passed');
  assert.equal(result.exitCode, 0);
});

test('foundry: a real AI Services account in the subscription supplies the DNS name (and the name is not printed)', async () => {
  // BREAKS IF: the discovered account is ignored (a made-up name says nothing about private resolution) or its name leaks.
  const est = estate();
  est.accounts = [{ kind: 'OpenAI', properties: { customSubDomainName: 'not-this-one' } }, { kind: 'AIServices', properties: { customSubDomainName: 'acct-fixture-name' } }];
  const looked = [];
  const { result } = await runFamily('foundry', est, { deps: mkDeps(est, { dnsLookup: async (h) => { looked.push(h); return [IP_PRIVATE]; } }) });
  assert.deepEqual(looked, ['acct-fixture-name.services.ai.azure.com']);
  assert.equal(cell(result, 'foundry.dns.servicesAiAzureCom').evidence.nameSource, 'discovered-ai-services-account');
  assert.ok(!JSON.stringify(result).includes('acct-fixture-name'));
});

test('foundry CONTROL (Commercial): a model list with no OpenAI format is not a real list - exit 2', async () => {
  // BREAKS IF: the OpenAI control is dropped (an incomplete catalogue would be published as "no Anthropic models").
  const est = estate();
  est.models.centralus = [{ kind: 'AIServices', model: { format: 'Anthropic', name: 'claude-fixture-a' } }];
  const { result } = await runFamily('foundry', est);
  assert.equal(control(result, 'models-list-is-a-real-list').status, 'failed');
  assert.match(control(result, 'models-list-is-a-real-list').detail, /no format OpenAI/);
  assert.equal(result.exitCode, 2);
});

test('foundry (Government): usgovvirginia is listed, an EMPTY list is a measured "none listed" (control still passes), and a hosted runner gives no VNet verdict', async () => {
  // BREAKS IF: the Gov control demands OpenAI (exit 2 on an honest empty list), the Gov region is not
  // usgovvirginia, the hosted runner's public view is published as a VNet verdict, or the address is printed.
  const est = estate({ cloud: 'gov' });
  est.models = { usgovvirginia: [] };
  const deps = mkDeps(est, { dnsLookup: async () => [IP_PUBLIC] });
  const { result } = await runFamily('foundry', est, { runner: 'hosted', deps });
  assert.equal(text(result, 'foundry.models.anthropic'), 'measured: none listed (HTTP 200)');
  assert.deepEqual(cell(result, 'foundry.models.formats').value, { formats: [], totalModels: 0 });
  assert.equal(control(result, 'models-list-is-a-real-list').status, 'passed');
  assert.equal(est.callsMatching('GET', /locations\/usgovvirginia\/models$/).length, 1);
  assert.equal(text(result, 'foundry.dns.servicesAiAzureCom'), 'not-measured:no-in-boundary-runner');
  assert.equal(cell(result, 'foundry.dns.servicesAiAzureCom').evidence.hostedRunnerView, 'resolves-public');
  assert.ok(!JSON.stringify(result).includes(IP_PUBLIC));
  assert.equal(result.exitCode, 0);
});

test('foundry: Anthropic is matched case-insensitively and the exact format strings are kept', async () => {
  // BREAKS IF: a casing surprise in the service's format string reads as "none listed".
  const est = estate();
  est.models.centralus.push({ kind: 'AIServices', model: { format: 'anthropic', name: 'claude-lower' } });
  const { result } = await runFamily('foundry', est);
  assert.match(text(result, 'foundry.models.anthropic'), /claude-lower/);
  assert.ok(cell(result, 'foundry.models.formats').value.formats.includes('anthropic'));
});

test('foundry DNS: ENOTFOUND is nxdomain, a persistent resolver failure is unknown:transient-exhausted after bounded retries', async () => {
  // BREAKS IF: a resolver timeout is reported as nxdomain (a "no"), or the retries are unbounded / not slept.
  const est = estate();
  const nx = mkDeps(est, { dnsLookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } });
  const { result } = await runFamily('foundry', est, { deps: nx });
  assert.equal(text(result, 'foundry.dns.servicesAiAzureCom'), 'measured: nxdomain (source: dns-lookup-from-in-vnet-runner)');

  const est2 = estate();
  let tries = 0;
  const flaky = mkDeps(est2, { dnsLookup: async () => { tries += 1; throw Object.assign(new Error('x'), { code: 'EAI_AGAIN' }); } });
  const { result: r2 } = await runFamily('foundry', est2, { deps: flaky });
  assert.equal(text(r2, 'foundry.dns.servicesAiAzureCom'), 'unknown:transient-exhausted');
  assert.equal(tries, 3);
  assert.deepEqual(est2.clock.sleeps, [1000, 2000]);
});

test('classifyAddress: private ranges are private, their neighbours are public', () => {
  // BREAKS IF: a boundary of a private range moves (172.32/12 edge, 100.64/10 edge), IPv6 ULA is called public.
  const expected = {
    '10.0.0.1': 'private', '10.255.255.254': 'private', '172.16.5.5': 'private', '172.31.255.255': 'private', '172.32.0.1': 'public',
    '172.15.255.255': 'public', '192.168.1.1': 'private', '192.169.0.1': 'public', '100.64.0.1': 'private', '100.127.255.255': 'private',
    '100.128.0.1': 'public', '127.0.0.1': 'private', '169.254.1.1': 'private', '8.8.8.8': 'public', '203.0.113.9': 'public',
    'fd00::1': 'private', 'fc00::1': 'private', 'fe80::1': 'private', '::1': 'private', '2001:db8::1': 'public',
  };
  for (const [addr, want] of Object.entries(expected)) assert.equal(foundry.classifyAddress(addr), want, addr);
});

test('foundry: a 403 on the model list is unknown:permission:Reader@subscription for both cells, unrunnable control, exit 0', async () => {
  // BREAKS IF: an unreadable catalogue reads as "none listed".
  const est = estate();
  est.rules.push((r) => (/locations\/[^/]+\/models$/.test(r.path) ? arm403 : undefined));
  const { result } = await runFamily('foundry', est);
  assert.equal(text(result, 'foundry.models.anthropic'), 'unknown:permission:Reader@subscription');
  assert.equal(text(result, 'foundry.models.formats'), 'unknown:permission:Reader@subscription');
  assert.equal(control(result, 'models-list-is-a-real-list').status, 'unrunnable');
  assert.equal(result.exitCode, 0);
});

// ===========================================================================
// 11. discovery, cloud guard, arguments and the written artifacts (R1, R3)
// ===========================================================================

const DECLARED = { telemetry: 14, policies: 22, mcp: 8, identity: 3, latency: 4, foundry: 3 };

test('every family declares unique, family-prefixed cell ids, and the counts are the documented ones', () => {
  // BREAKS IF: a cell id is duplicated, loses its family prefix, or a family gains/loses a cell without this
  // table (and the receipt template that quotes it) being revisited.
  const mods = { telemetry, policies, mcp, identity, latency, foundry };
  assert.deepEqual(Object.keys(mods).sort(), [...core.FAMILIES].sort());
  for (const [family, mod] of Object.entries(mods)) {
    assert.equal(new Set(mod.CELL_IDS).size, mod.CELL_IDS.length, `${family} has duplicate ids`);
    assert.ok(mod.CELL_IDS.every((id) => id.startsWith(`${family}.`)), `${family} ids must carry the family prefix`);
    assert.equal(mod.CELL_IDS.length, DECLARED[family], family);
  }
});

test('zero APIM instances: EVERY family emits every declared cell as not-measured:no-gateway-in-boundary and says how many it saw', async () => {
  // BREAKS IF: a family skips a cell, reports the empty subscription as a measurement or as an error, omits the
  // count it saw, or makes a call beyond the APIM listing.
  for (const family of core.FAMILIES) {
    const est = estate();
    est.apims = [];
    const { result } = await runFamily(family, est);
    assert.equal(result.cells.length, DECLARED[family], family);
    for (const c of result.cells) {
      assert.equal(core.verdictText(c), 'not-measured:no-gateway-in-boundary', c.id);
      assert.equal(c.evidence.apimInstancesSeen, 0, c.id);
    }
    assert.deepEqual(result.discovery, { state: 'zero', seen: 0, names: null });
    assert.equal(result.exitCode, 0);
    assert.equal(result.valid, true);
    assert.equal(est.calls.length, 1, `${family}: nothing but the APIM listing may be called`);
    assert.equal(result.apim, null);
  }
});

test('two APIM instances and no --apim-name: fail closed (exit 2) listing the NAMES; --apim-name picks one case-insensitively; an unknown name fails closed too', async () => {
  // BREAKS IF: the probe guesses (takes the first), the names are not listed, an id appears in the output, a name that
  // matches nothing is read as "no gateway in boundary", or the right gateway is not the one queried.
  const est = estate();
  est.apims = [apimArm('apim-a'), apimArm('apim-b')];
  const { result } = await runFamily('mcp', est);
  assert.equal(result.status, 'AMBIGUOUS-GATEWAY');
  assert.equal(result.exitCode, 2);
  assert.equal(result.valid, false);
  assert.deepEqual(result.cells, []);
  assert.match(result.notes[0], /^2 APIM instances are in this subscription and --apim-name was not given: refusing to guess\. Names: apim-a, apim-b$/);
  assert.ok(!JSON.stringify(result).includes(SUB));
  assert.equal(est.calls.length, 1, 'no family call may follow an ambiguous discovery');

  const est2 = estate();
  est2.apims = [apimArm('apim-a'), apimArm('apim-b')];
  const { result: picked } = await runFamily('mcp', est2, { apimName: 'APIM-B' });
  assert.equal(picked.apim.name, 'apim-b');
  assert.ok(est2.calls.some((c) => c.path.includes('/service/apim-b/')));
  assert.ok(!est2.calls.some((c) => c.path.includes('/service/apim-a/')), 'the other gateway must not be touched');

  const est3 = estate();
  est3.apims = [apimArm('apim-a'), apimArm('apim-b')];
  const { result: missing } = await runFamily('mcp', est3, { apimName: 'apim-zzz' });
  assert.equal(missing.status, 'NAMED-GATEWAY-NOT-FOUND');
  assert.equal(missing.exitCode, 2);
  assert.match(missing.notes[0], /matched none of the 2 APIM instances.*Names: apim-a, apim-b/);
});

test('a NAMED gateway in a subscription with NO APIM at all fails closed (exit 2, named-not-found) in every family; the same empty subscription with no name stays an honest not-measured', async () => {
  // BREAKS IF: --apim-name against an EMPTY subscription is read as "no gateway in the boundary" (state 'zero', exit 0, every
  // cell unmeasured: a green job over nothing). The breaking input is estate.apims = [] with apimName 'apim-zzz'. With one OTHER
  // instance present the same name already exited 2, so the empty subscription must not be the quieter case.
  // Positive pair (an absence-only test is satisfied by deleting the feature): the SAME empty subscription with NO name must
  // still be exit 0 with every cell not-measured:no-gateway-in-boundary - the honest negative is kept.
  for (const family of core.FAMILIES) {
    const est = estate();
    est.apims = [];
    const { result } = await runFamily(family, est, { apimName: 'apim-zzz' });
    assert.equal(result.status, 'NAMED-GATEWAY-NOT-FOUND', family);
    assert.equal(result.exitCode, 2, family);
    assert.equal(result.valid, false, family);
    assert.deepEqual(result.discovery, { state: 'named-not-found', seen: 0, names: [] }, family);
    assert.deepEqual(result.cells, [], `${family}: a hard stop publishes no cell`);
    assert.match(result.notes[0], /^--apim-name was given but this subscription holds no APIM instance .*Names: \(none\)$/, family);
    assert.equal(est.calls.length, 1, `${family}: nothing but the APIM listing may be called`);

    const unnamed = estate();
    unnamed.apims = [];
    const { result: honest } = await runFamily(family, unnamed);
    assert.equal(honest.discovery.state, 'zero', family);
    assert.equal(honest.exitCode, 0, family);
    assert.equal(honest.cells.length, DECLARED[family], family);
    assert.ok(honest.cells.every((c) => core.verdictText(c) === 'not-measured:no-gateway-in-boundary'), family);
  }
});

test('a name that matches TWO listed instances fails closed and the note says how many matched - it must not claim "none"', async () => {
  // BREAKS IF: the matched count is dropped from the note, so a listing that repeated the name reads "matched none of the 2"
  // (a false statement: deploy-integrity.md R7). The two names differ only by case, which --apim-name matches case-insensitively.
  // This pins the MESSAGE; the exit code and the state are pinned by the empty-subscription test above and by the two-instance
  // test, so a mutation that changes only the state is caught there, not here.
  const est = estate();
  est.apims = [apimArm('apim-dup'), apimArm('APIM-DUP')];
  const { result } = await runFamily('mcp', est, { apimName: 'apim-dup' });
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, 'NAMED-GATEWAY-NOT-FOUND');
  assert.match(result.notes[0], /^--apim-name matched 2 of the 2 APIM instances in this subscription \(exactly 1 is required\)\. Names: APIM-DUP, apim-dup$/);
  assert.ok(!/matched none/.test(result.notes[0]), result.notes[0]);
  assert.equal(est.calls.length, 1);
});

test('the cloud guard refuses BEFORE any read when az is logged into the other cloud', async () => {
  // BREAKS IF: the guard is removed (a --cloud gov run would read the Commercial subscription and call it Gov), or
  // it runs after the first request. The router has no route for ANYTHING here: zero calls is the proof.
  for (const [asked, azSays] of [['gov', 'AzureCloud'], ['commercial', 'AzureUSGovernment']]) {
    const est = estate({ cloud: asked });
    const deps = mkDeps(est, { azAccount: async () => ({ environmentName: azSays, subscriptionId: SUB }) });
    const { result } = await runFamily('identity', est, { deps });
    assert.equal(result.status, 'CRASHED');
    assert.equal(result.exitCode, 2);
    assert.match(result.notes[0], /cloud mismatch: --cloud .* needs az environment .* refusing before any read/);
    assert.equal(est.calls.length, 0, `${asked}: no request may be made`);
  }
});

test('a failed APIM listing is unknown:permission:Reader@subscription for every cell (exit 3), not "no gateway"', async () => {
  // BREAKS IF: an unreadable subscription is read as an empty one.
  const est = estate();
  est.rules.push((r) => (r.path === `/subscriptions/${SUB}/providers/Microsoft.ApiManagement/service` ? arm403 : undefined));
  const { result } = await runFamily('telemetry', est);
  assert.equal(result.cells.length, DECLARED.telemetry);
  for (const c of result.cells) assert.equal(core.verdictText(c), 'unknown:permission:Reader@subscription', c.id);
  assert.equal(result.exitCode, 3);
});

test('a family that crashes still reports: status CRASHED, exit 2, the cells it had, a sanitized message, and every declared cell', async () => {
  // BREAKS IF: a crash loses the cells measured so far, leaves the message unsanitized (a token / id in a public log),
  // is reported as anything but exit 2, or drops declared cells.
  core.clearSecretsForTest(); // the token below is never registered (getToken threw before returning it)
  const est = estate();
  const deps = mkDeps(est, { getToken: async () => { throw new Error(`az exploded: Bearer ${TOKEN} for /subscriptions/${SUB}`); } });
  const { result } = await runFamily('telemetry', est, { deps });
  assert.equal(result.status, 'CRASHED');
  assert.equal(result.exitCode, 2);
  assert.equal(result.valid, false);
  assert.match(result.notes[0], /^crashed: az exploded: Bearer <redacted> for \/subscriptions\/<redacted>$/);
  assert.ok(!JSON.stringify(result).includes(TOKEN) && !JSON.stringify(result).includes(SUB));
  assert.equal(result.cells.length, DECLARED.telemetry);
});

test('parseArgs: the documented flags parse, and every malformed invocation is a usage error (exit 2, no JSON)', async () => {
  // BREAKS IF: a bad family/cloud/runner/name/poll value is accepted, an unknown flag is ignored, or a usage error
  // writes a result file.
  const o = probe.parseArgs(['--cloud', 'gov', '--family', 'latency', '--latency-poll-seconds', '45', '--apim-name=apim-x', '--runner', 'in-vnet']);
  assert.deepEqual({ ...o }, {
    cloud: 'gov', family: 'latency', apimName: 'apim-x', out: join('temp', 'apiplane-w0'), runner: 'in-vnet',
    latencyPollSeconds: 45, aggregate: null, expect: null, summaryFile: null,
  });
  const bad = [
    [], ['--cloud', 'gov'], ['--cloud', 'gov', '--family', 'nope'], ['--cloud', 'azure', '--family', 'mcp'],
    ['--cloud', 'gov', '--family', 'mcp', '--runner', 'moon'], ['--cloud', 'gov', '--family', 'mcp', '--apim-name', 'bad name!'],
    ['--cloud', 'gov', '--family', 'mcp', '--latency-poll-seconds', '5'], ['--cloud', 'gov', '--family', 'mcp', '--latency-poll-seconds', 'abc'],
    ['--cloud', 'gov', '--family', 'mcp', '--latency-poll-seconds', '99999'], ['--cloud', 'gov', '--family', 'mcp', '--nope', 'x'],
    ['--cloud', 'gov', '--family', 'mcp', '--out'], ['--aggregate', 'd', '--cloud', 'gov'], ['--aggregate', 'd', '--cloud', 'gov', '--expect', 'bogus'],
  ];
  for (const argv of bad) {
    assert.throws(() => probe.parseArgs(argv), probe.UsageError, JSON.stringify(argv));
    const est = estate();
    const deps = mkDeps(est);
    assert.equal(await probe.runProbe(argv, deps), 2, JSON.stringify(argv));
    assert.equal(deps.files.size, 0, 'a usage error writes nothing');
    assert.ok(deps.logs[0].startsWith('usage error:'));
    assert.equal(est.calls.length, 0);
  }
});

test('parseArgs: a path flag may not climb out with ".." or carry a NUL byte, and an ordinary path still parses', async () => {
  // BREAKS IF: --out, --aggregate or --summary-file accepts a ".." segment (either slash style) or a NUL byte.
  // Positive pair: a plain relative path, an absolute path and a name that merely CONTAINS two dots all parse, so a
  // guard that rejects every path (or every dot) is red too.
  const climbing = ['../escape', 'a/../b', '..', 'a\\..\\b', '..\\x', 'out/..', 'nul\u0000byte'];
  for (const flag of ['--out', '--aggregate', '--summary-file']) {
    for (const value of climbing) {
      const argv = flag === '--aggregate'
        ? ['--aggregate', value, '--expect', 'mcp', '--cloud', 'gov']
        : ['--cloud', 'gov', '--family', 'mcp', flag, value];
      assert.throws(() => probe.parseArgs(argv), probe.UsageError, `${flag} ${JSON.stringify(value)}`);
    }
  }
  const fine = ['out-dir', 'temp/apiplane-w0', 'a..b', '/abs/dir', 'C:/abs/dir', '.hidden', 'dir.with.dots'];
  for (const value of fine) {
    assert.equal(probe.parseArgs(['--cloud', 'gov', '--family', 'mcp', '--out', value]).out, value);
    assert.equal(probe.parseArgs(['--cloud', 'gov', '--family', 'mcp', '--summary-file', value]).summaryFile, value);
    assert.equal(probe.parseArgs(['--aggregate', value, '--expect', 'mcp', '--cloud', 'gov']).aggregate, value);
  }
});

test('renderFamilyMarkdown: a backslash before a pipe cannot reopen a table column', () => {
  // BREAKS IF: esc() escapes the pipe but not the backslash (CodeQL js/incomplete-sanitization). The input `x\|y` then
  // renders as `x\\|y`, which a markdown table reads as an escaped backslash followed by a REAL column delimiter, so the
  // row grows an extra cell. Positive pair: a plain pipe stays inside one cell and a lone backslash is doubled so markdown
  // shows it once; an esc() that escapes nothing (or too much) is red too.
  const unescapedPipes = (row) => {
    let n = 0;
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] === '\\') i += 1; // a backslash escapes whatever follows it
      else if (row[i] === '|') n += 1;
    }
    return n;
  };
  const hostile = 'x\\|y';
  const plain = 'x|y';
  const lone = 'C:\\dir';
  const result = {
    cloud: 'gov', family: 'telemetry', exitCode: 0, valid: true, apim: null, discovery: { state: 'none', seen: 0 },
    runner: 'hosted', notes: [], requests: [],
    controls: [{ id: 'ctl', status: 'passed', detail: hostile }],
    cells: [
      core.measured('cell.hostile', hostile, { http: 200 }),
      core.measured('cell.plain', plain, { http: 200 }),
      core.measured('cell.lone', lone, { http: 200 }),
    ],
  };
  const rows = probe.renderFamilyMarkdown(result).split('\n').filter((l) => /^\| (ctl|cell\.[a-z]+) \|/.test(l));
  assert.equal(rows.length, 4, 'one control row and three cell rows');
  for (const row of rows) assert.equal(unescapedPipes(row), 4, row);
  const loneRow = rows.find((r) => r.startsWith('| cell.lone |'));
  assert.ok(loneRow.includes('C:\\\\dir'), loneRow);
});

test('runProbe writes <cloud>-<family>.json and .md, logs one line per cell, and returns the family exit code', async () => {
  // BREAKS IF: the file names or schema change, the markdown loses its verdict table or its INVALID banner, or the
  // exit code is not the family's.
  const est = estate();
  const deps = mkDeps(est);
  const code = await probe.runProbe(['--cloud', 'commercial', '--family', 'identity', '--out', 'out-dir'], deps);
  assert.equal(code, 0);
  const json = JSON.parse(deps.files.get(resolve('out-dir', 'commercial-identity.json')));
  assert.equal(json.schema, 'apiplane-w0-probe/1');
  assert.equal(json.cloud, 'commercial');
  assert.equal(json.family, 'identity');
  assert.equal(json.exitCode, 0);
  assert.equal(json.cells.length, DECLARED.identity);
  assert.equal(json.apim.name, APIM_NAME);
  assert.deepEqual(Object.keys(json.apim).sort(), ['capacity', 'gatewayHostKind', 'location', 'name', 'provisioningState', 'publicNetworkAccess', 'resourceGroup', 'sku', 'virtualNetworkType'], 'only names, resource group, SKU and state are printed');
  const md = deps.files.get(resolve('out-dir', 'commercial-identity.md'));
  assert.match(md, /^### commercial \/ identity - exit 0\n/);
  assert.match(md, /\| cell \| verdict \| evidence \|/);
  assert.match(md, /\| identity\.graph\.agentIdentityReadAll \| measured: yes \(HTTP 200\) \|/);
  assert.ok(deps.logs.includes('commercial/identity: exit 0'));
  assert.equal(deps.logs.filter((l) => l.startsWith('  identity.')).length, DECLARED.identity);

  const bad = estate();
  bad.graphSp = { id: GRAPH_SP_OBJECT, appId: GRAPH_APP_ID };
  const d2 = mkDeps(bad);
  assert.equal(await probe.runProbe(['--cloud', 'commercial', '--family', 'identity', '--out', 'out-dir'], d2), 2);
  const md2 = d2.files.get(resolve('out-dir', 'commercial-identity.md'));
  assert.match(md2, /^### commercial \/ identity - exit 2 - INVALID, cells NOT publishable\n/);
  assert.equal(JSON.parse(d2.files.get(resolve('out-dir', 'commercial-identity.json'))).valid, false);
  assert.ok(d2.logs.some((l) => l.includes('(INVALID: not publishable)')));
});

test('the pasted category list is rendered WHOLE in the markdown, not truncated inside a table cell', async () => {
  // BREAKS IF: a long category list is cut at the cell cap (the PRP: "the receipt pastes the list, not a yes").
  const est = estate();
  est.categories = ['GatewayLogs', ...Array.from({ length: 40 }, (_, i) => `ZzzLongCategoryName${i}`)];
  const deps = mkDeps(est);
  await probe.runProbe(['--cloud', 'commercial', '--family', 'telemetry', '--out', 'o'], deps);
  const md = deps.files.get(resolve('o', 'commercial-telemetry.md'));
  const line = md.split('\n').find((l) => l.startsWith('Pasted category list for `telemetry.diag.GatewayLlmLogs`'));
  assert.ok(line, 'the pasted list line is missing');
  assert.ok(line.includes('ZzzLongCategoryName39') && line.includes('GatewayLogs'));
});

// ===========================================================================
// 12. publication: ids, addresses and tokens never reach a file or a log line (R3)
// ===========================================================================

test('PUBLICATION: GUID resource ids, IPs, a JWT and a raw token planted in the data never appear in the JSON, the markdown or the console', async () => {
  // BREAKS IF: runProbe stops running its output through the redactor (the needles ride in on category NAMES, which no
  // lower layer sanitizes), or a log line prints evidence unsanitized. Positives: the APIM name, the resource group,
  // and the redaction markers must still be there, so deleting the output cannot pass.
  const est = estate();
  est.categories = ['GatewayLogs', `x-/subscriptions/${SUB}/resourceGroups/${RG}/ip/${IP_PUBLIC}/jwt/${JWT}`, `tenant-/tenants/${TENANT}`];
  est.rules.push((r) => (r.method === 'GET' && /workspaces\/[^/]+\/tables$/.test(r.path)
    ? jsonRes(403, { error: { code: 'AuthorizationFailed', message: `denied for ${TOKEN} at ${IP_PUBLIC} scope /subscriptions/${SUB}/resourceGroups/${RG}` } }) : undefined));
  const deps = mkDeps(est);
  await probe.runProbe(['--cloud', 'commercial', '--family', 'telemetry', '--out', 'pub'], deps);
  const everything = [...deps.files.values(), ...deps.logs].join('\n');
  for (const needle of [SUB, TENANT, IP_PUBLIC, JWT, TOKEN, JWT.split('.')[0]]) assert.ok(!everything.includes(needle), `leaked ${needle}`);
  for (const keep of [APIM_NAME, RG, '<redacted>', '<ip>']) assert.ok(everything.includes(keep), `lost ${keep}`);
  assert.ok(deps.files.get(resolve('pub', 'commercial-telemetry.json')).includes('x-/subscriptions/<redacted>/resourceGroups/rg-fixture'));
});

// ===========================================================================
// 13. aggregate (the workflows' last step)
// ===========================================================================

async function seededOutDir(est, families) {
  const m = memFs();
  const logs = [];
  for (const family of families) {
    const deps = mkDeps(est, { fs: m.fs, files: m.files, log: (l) => logs.push(l) });
    await probe.runProbe(['--cloud', 'commercial', '--family', family, '--out', 'agg'], deps);
  }
  return { m, logs };
}

test('aggregate: all expected families present and clean is exit 0, the receipt is written and appended to the summary file', async () => {
  // BREAKS IF: the receipt is not written, is not appended to the step summary, omits a family, or a clean set is not 0.
  const { m } = await seededOutDir(estate(), ['identity', 'foundry']);
  const logs = [];
  const code = await probe.runProbe(['--aggregate', 'agg', '--expect', 'identity,foundry', '--cloud', 'commercial', '--summary-file', 'summary.md'], { fs: m.fs, nowIso: () => '2026-10-29T12:00:00.000Z', log: (l) => logs.push(l) });
  assert.equal(code, 0);
  const receipt = m.files.get(resolve('agg', 'receipt.md'));
  assert.match(receipt, /^## Loom API plane W0 probe - commercial/);
  assert.match(receipt, /\| identity \| 0 \| true \| 3 \| 0 \| 0 \|/);
  assert.match(receipt, /\| foundry \| 0 \| true \| /);
  assert.equal(m.files.get(resolve('summary.md')), `${receipt}\n`);
});

test('aggregate: a MISSING family artifact is exit 2 and is named; a family with exit 3 is exit 3; exit 2 outranks 3', async () => {
  // BREAKS IF: a family that never wrote a result is silently skipped (green over nothing), or the exit code of the
  // worst family is not what the job fails with.
  const { m } = await seededOutDir(estate(), ['identity']);
  const logs = [];
  const deps = { fs: m.fs, nowIso: () => 't', log: (l) => logs.push(l) };
  assert.equal(await probe.runProbe(['--aggregate', 'agg', '--expect', 'identity,policies', '--cloud', 'commercial'], deps), 2);
  const receipt = m.files.get(resolve('agg', 'receipt.md'));
  assert.match(receipt, /\| policies \| MISSING \|/);
  assert.match(receipt, /FAILED: no artifact from policies/);
  assert.ok(logs.some((l) => /MISSING policies/.test(l)));

  // exit 3: a forbidden mcp create
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /apis\/w0-apiplane-mcp-api$/.test(r.path) ? arm403 : undefined));
  const three = await seededOutDir(est, ['mcp']);
  assert.equal(await probe.runProbe(['--aggregate', 'agg', '--expect', 'mcp', '--cloud', 'commercial'], { fs: three.m.fs, nowIso: () => 't', log: () => {} }), 3);
  assert.match(three.m.files.get(resolve('agg', 'receipt.md')), /FAILED: mcp=3/);

  // 2 outranks 3
  const bad = estate();
  bad.graphSp = { id: GRAPH_SP_OBJECT, appId: GRAPH_APP_ID };
  const both = await seededOutDir(bad, ['identity']);
  const est3 = estate();
  est3.rules.push((r) => (r.method === 'PUT' && /apis\/w0-apiplane-mcp-api$/.test(r.path) ? arm403 : undefined));
  const mcpDeps = mkDeps(est3, { fs: both.m.fs, files: both.m.files });
  await probe.runProbe(['--cloud', 'commercial', '--family', 'mcp', '--out', 'agg'], mcpDeps);
  assert.equal(await probe.runProbe(['--aggregate', 'agg', '--expect', 'identity,mcp', '--cloud', 'commercial'], { fs: both.m.fs, nowIso: () => 't', log: () => {} }), 2);
});

test('aggregate: the receipt is redacted again (a needle written straight into a result file does not reach it) and another cloud\'s files are ignored', async () => {
  // BREAKS IF: buildReceipt trusts the JSON it reads (a hand-edited or older artifact carrying an id reaches the public
  // step summary), or a Commercial receipt swallows Gov results.
  const { m } = await seededOutDir(estate(), ['identity']);
  const file = resolve('agg', 'commercial-identity.json');
  const doc = JSON.parse(m.files.get(file));
  doc.cells[0].evidence = { note: `leak /subscriptions/${SUB} from ${IP_PUBLIC} token ${JWT}` };
  m.files.set(file, JSON.stringify(doc));
  m.files.set(resolve('agg', 'gov-identity.json'), JSON.stringify({ ...doc, cloud: 'gov', exitCode: 2, valid: false }));
  const code = await probe.runProbe(['--aggregate', 'agg', '--expect', 'identity', '--cloud', 'commercial'], { fs: m.fs, nowIso: () => 't', log: () => {} });
  assert.equal(code, 0, 'the Gov file (exit 2) must not leak into the Commercial verdict');
  const receipt = m.files.get(resolve('agg', 'receipt.md'));
  assert.ok(receipt.includes('| identity | 0 | true |'));
  for (const needle of [SUB, IP_PUBLIC, JWT]) assert.ok(!receipt.includes(needle), `leaked ${needle}`);
  // positive: the planted note is still IN the receipt, redacted in place - so dropping the evidence column cannot pass
  assert.ok(receipt.includes('leak /subscriptions/<redacted> from <ip> token <redacted-jwt>'));
});

test('aggregate: the redaction keeps the receipt a MARKDOWN document (one table row per line), it does not flatten it', async () => {
  // BREAKS IF: the receipt is sanitized with the single-line sanitize() (every newline becomes a space and the tables
  // collapse into one unreadable line in the Actions step summary).
  const { m } = await seededOutDir(estate(), ['identity', 'foundry']);
  await probe.runProbe(['--aggregate', 'agg', '--expect', 'identity,foundry', '--cloud', 'commercial'], { fs: m.fs, nowIso: () => 't', log: () => {} });
  const lines = m.files.get(resolve('agg', 'receipt.md')).split('\n');
  assert.ok(lines.length > 20, `receipt has only ${lines.length} lines`);
  assert.ok(lines.some((l) => l.startsWith('| identity | 0 | true |')));
  assert.ok(lines.some((l) => l.startsWith('| identity.graph.agentIdentityReadAll | measured: yes (HTTP 200) |')));
  assert.ok(lines.some((l) => l === '### commercial / identity - exit 0'));
});

// ===========================================================================
// 14. the two workflows (they cannot run offline, so their SHAPE is pinned and the precheck is EXECUTED)
// ===========================================================================

const val = (n) => (n && typeof n === 'object' && !Array.isArray(n) && 'v' in n ? n.v : n);
const WF = {
  gov: { file: 'apiplane-w0-gov-probe.yml', cloud: 'gov', runner: 'hosted', secrets: ['AZURE_GOV_CLIENT_ID', 'AZURE_GOV_CLIENT_SECRET', 'AZURE_GOV_TENANT_ID', 'AZURE_GOV_SUBSCRIPTION_ID'], envNames: ['GOV_C', 'GOV_S', 'GOV_T', 'GOV_U'] },
  commercial: { file: 'apiplane-w0-commercial-probe.yml', cloud: 'commercial', runner: 'in-vnet', secrets: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID'], envNames: ['COM_C', 'COM_S', 'COM_T', 'COM_U'] },
};
const loadWf = (which) => {
  // normalise line endings: a Windows checkout may hold CRLF, and a CR inside a script would break bash and the regexes below
  const text = readFileSync(join(WORKFLOW_DIR, WF[which].file), 'utf8').split('\r\n').join('\n');
  return { text, doc: parseWorkflow(text) };
};
const stepsOf = (doc, job) => doc.jobs[job].steps;
const runOf = (step) => String(val(step.run) ?? '');

/** Run a precheck step's own script under bash with the given environment (exports inlined, so nothing depends on env passing). */
function runPrecheck(which, vars) {
  const { doc } = loadWf(which);
  const step = stepsOf(doc, 'precheck')[0];
  const exports = Object.entries(vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n');
  const r = spawnSync('bash', ['-c', `${exports}\n${runOf(step)}`], { encoding: 'utf8' });
  assert.equal(r.error, undefined, `bash must be runnable to execute the precheck: ${r.error}`);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

for (const which of ['gov', 'commercial']) {
  const W = WF[which];

  test(`${W.file}: manual dispatch only, contents:read only, serialised, run-name carries the cloud`, () => {
    // BREAKS IF: a schedule/push/pull_request trigger appears (a measurement that runs unattended), the token gains a
    // scope, two runs can overlap on one gateway (their sweeps would delete each other's scratch objects), or cancel-in-progress
    // is turned on (a cancelled run leaves scratch objects behind).
    const { doc } = loadWf(which);
    assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
    assert.deepEqual(Object.keys(doc.permissions), ['contents']);
    assert.equal(val(doc.permissions.contents), 'read');
    assert.equal(val(doc.concurrency['cancel-in-progress']), 'false');
    assert.equal(val(doc.concurrency.group), W.file.replace('.yml', ''));
    assert.ok(val(doc['run-name']).includes(W.cloud), 'run-name must name the cloud');
    const inputs = doc.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(inputs).sort(), ['apim_name', 'families', 'latency_poll_seconds']);
    assert.equal(val(inputs.families.default), 'all');
    assert.equal(val(inputs.latency_poll_seconds.default), '900');
    assert.equal(val(inputs.apim_name.default), '');
  });

  test(`${W.file}: no step discards a result - no continue-on-error, no "|| true", no stderr redirect (R8)`, () => {
    // BREAKS IF: any step of any job carries continue-on-error, swallows a status with `|| true`, or sends stderr to nowhere.
    // (Scanned on the parsed steps, so the header comments that NAME these patterns do not count.)
    const { doc } = loadWf(which);
    let scanned = 0;
    for (const job of Object.keys(doc.jobs)) {
      for (const step of stepsOf(doc, job)) {
        scanned += 1;
        assert.equal('continue-on-error' in step, false, `${job}/${val(step.name)} has continue-on-error`);
        const run = runOf(step);
        assert.ok(!/\|\|\s*true\b/.test(run), `${job}/${val(step.name)} has || true`);
        assert.ok(!/2>\s*\/dev\/null|&>\s*\/dev\/null|2>&-|2>>\s*\/dev\/null/.test(run), `${job}/${val(step.name)} discards stderr`);
        assert.ok(!/\$\{\{/.test(run), `${job}/${val(step.name)} interpolates an expression into a script (inputs must go through env:)`);
      }
    }
    assert.ok(scanned >= 12, `only ${scanned} steps scanned: the scan is not reading the workflow`);
  });

  test(`${W.file}: the precheck EXECUTES to exit 1 on any missing secret, even on a manual dispatch, and names the secret`, () => {
    // BREAKS IF: the precheck can skip green (the deploy-fiab-gcc.yml shape: warn and exit 0 on dispatch). Each of the four
    // secrets is removed in turn; GITHUB_EVENT_NAME=workflow_dispatch is exported too, because that is the trigger the
    // old pattern excused.
    const good = Object.fromEntries(W.envNames.map((n) => [n, 'present']));
    const base = { IN_APIM: '', IN_FAMILIES: 'all', IN_POLL: '900', GITHUB_EVENT_NAME: 'workflow_dispatch' };
    const ok = runPrecheck(which, { ...good, ...base });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /precheck ok/);
    W.envNames.forEach((envName, i) => {
      const r = runPrecheck(which, { ...good, ...base, [envName]: '' });
      assert.equal(r.code, 1, `${W.secrets[i]} missing must fail closed`);
      assert.ok(r.out.includes(`missing secret(s): ${W.secrets[i]}.`), r.out);
    });
    const none = runPrecheck(which, { ...Object.fromEntries(W.envNames.map((n) => [n, ''])), ...base });
    assert.equal(none.code, 1);
    assert.ok(none.out.includes(`missing secret(s): ${W.secrets.join(' ')}.`), none.out);
    const pre = runOf(stepsOf(loadWf(which).doc, 'precheck')[0]);
    assert.ok(!/GITHUB_EVENT_NAME|configured=false|GITHUB_OUTPUT/.test(pre), 'the precheck must have no skip-green path');
  });

  test(`${W.file}: the precheck rejects malformed inputs (apim_name, latency_poll_seconds, families) and accepts the documented ones`, () => {
    // BREAKS IF: an input reaches the probe unvalidated (a name with spaces, a poll of 5 or 3601 or "abc", an unknown family,
    // a family list with a space), or a valid one is refused.
    const good = Object.fromEntries(W.envNames.map((n) => [n, 'present']));
    const run = (extra) => runPrecheck(which, { ...good, IN_APIM: '', IN_FAMILIES: 'all', IN_POLL: '900', ...extra });
    for (const bad of [{ IN_APIM: 'bad name' }, { IN_APIM: '1abc' }, { IN_APIM: 'a'.repeat(51) }, { IN_POLL: '5' }, { IN_POLL: '3601' }, { IN_POLL: 'abc' }, { IN_POLL: '' },
      { IN_FAMILIES: 'telemetry,bogus' }, { IN_FAMILIES: 'telemetry, policies' }, { IN_FAMILIES: '' }]) {
      const r = run(bad);
      assert.equal(r.code, 1, `${JSON.stringify(bad)} must be refused: ${r.out}`);
    }
    for (const fine of [{ IN_APIM: 'apim-csa-loom-centralus' }, { IN_POLL: '30' }, { IN_POLL: '3600' }, { IN_FAMILIES: 'telemetry,mcp' }, { IN_FAMILIES: 'latency' }]) {
      const r = run(fine);
      assert.equal(r.code, 0, `${JSON.stringify(fine)} must be accepted: ${r.out}`);
    }
  });

  test(`${W.file}: the probe job needs the precheck, authenticates the right way, and runs on the right runner`, () => {
    // BREAKS IF: the probe can start without the precheck, the login is not the documented one, or the runner / approval gate is wrong.
    const { doc } = loadWf(which);
    const probeJob = doc.jobs.probe;
    assert.equal(val(probeJob.needs), '[precheck]');
    assert.equal(val(probeJob['timeout-minutes']), '90');
    const steps = stepsOf(doc, 'probe');
    const login = steps.find((s) => /azure\/login@/i.test(String(val(s.uses))));
    assert.ok(login, 'an azure/login step is required');
    const creds = String(val(login.with.creds));
    for (const s of W.secrets) assert.ok(creds.includes(`secrets.${s}`), `login must use ${s}`);
    assert.equal('permissions' in doc && 'id-token' in doc.permissions, false, 'client-secret login, not OIDC (the federated credential is pinned to main)');
    assert.equal('client-id' in login.with, false, 'no OIDC client-id input');
    if (which === 'gov') {
      assert.equal(val(probeJob['runs-on']), 'ubuntu-latest');
      assert.equal(val(probeJob.environment), 'gcc-high-deploy', 'one manual approval, as governance-w0-measure.yml');
      assert.equal(val(login.uses), 'Azure/login@v2');
      assert.equal(val(login.with.environment), 'AzureUSGovernment');
      const credsJson = JSON.parse(creds);
      assert.equal(credsJson.resourceManagerEndpointUrl, 'https://management.usgovcloudapi.net/');
      assert.equal(credsJson.activeDirectoryEndpointUrl, 'https://login.microsoftonline.us');
      const setCloud = steps.findIndex((s) => runOf(s).includes('az cloud set --name AzureUSGovernment'));
      assert.ok(setCloud > steps.indexOf(login), 'az cloud set must follow the login');
    } else {
      assert.equal(val(probeJob['runs-on']), '[self-hosted, loom-aca]');
      assert.equal('environment' in probeJob, false, 'no approval environment on the Commercial pool run');
      assert.equal(val(login.uses), 'azure/login@v2.3.0');
      assert.match(String(val(login.name)), /deploy SP/);
    }
  });

  test(`${W.file}: one step per family, each with if: always() and the right cloud/runner, latency gets its cap, nothing else does`, () => {
    // BREAKS IF: a family has no step (or two), a step can be skipped by an earlier failure, the cloud or runner flag is wrong
    // (a Gov run labelled in-vnet would publish a public DNS view as a VNet verdict), or the families list drifts from the code.
    const { doc } = loadWf(which);
    const steps = stepsOf(doc, 'probe');
    for (const family of core.FAMILIES) {
      const mine = steps.filter((s) => new RegExp(`--family ${family}\\b`).test(runOf(s)));
      assert.equal(mine.length, 1, `exactly one step for ${family}`);
      const s = mine[0];
      const cond = String(val(s.if));
      assert.ok(cond.includes('always()') && cond.includes(`'${family}'`) && cond.includes("env.FAMILIES == 'all'"), `${family}: ${cond}`);
      const run = runOf(s);
      assert.ok(run.includes(`--cloud ${W.cloud} `), `${family} cloud`);
      assert.ok(run.includes(`--runner ${W.runner} `), `${family} runner`);
      assert.ok(run.includes('--out "$OUT"'));
      assert.equal(run.includes('--latency-poll-seconds "$POLL_SECONDS"'), family === 'latency', `${family} poll flag`);
      assert.ok(/args\+=\(--apim-name "\$APIM_NAME"\)/.test(run));
      assert.ok(run.trimEnd().split('\n').pop().startsWith('node scripts/measure/apiplane/w0-apim-probe.mjs'), `${family}: the probe must be the LAST command (its exit code is the step's)`);
    }
    // the case list in the precheck and the aggregate default are the same six families the code declares
    const pre = runOf(stepsOf(doc, 'precheck')[0]);
    const caseList = /^\s*([a-z|]+)\) ;;$/m.exec(pre)[1].split('|').sort();
    assert.deepEqual(caseList, [...core.FAMILIES].sort());
    const agg = steps.find((s) => runOf(s).includes('--aggregate'));
    assert.ok(runOf(agg).includes(`expect="${core.FAMILIES.join(',')}"`));
  });

  test(`${W.file}: aggregate runs always, writes the redacted receipt to the step summary, ends on the node call; the artifact is uploaded always, last, and must not be empty`, () => {
    // BREAKS IF: the aggregate can be skipped, ends in a bare `exit 0` (the repo's annotation-teeth rule), is ordered after the
    // upload (receipt.md would not be in the artifact), or the upload can pass with no files / use an unpinned action.
    const { doc } = loadWf(which);
    const steps = stepsOf(doc, 'probe');
    const aggIdx = steps.findIndex((s) => runOf(s).includes('--aggregate'));
    const upIdx = steps.findIndex((s) => /upload-artifact@/.test(String(val(s.uses))));
    assert.ok(aggIdx > 0 && upIdx > aggIdx, 'aggregate before upload');
    assert.equal(upIdx, steps.length - 1, 'upload is the last step');
    const agg = steps[aggIdx];
    assert.equal(String(val(agg.if)), '${{ always() }}');
    const run = runOf(agg);
    assert.ok(run.includes('--summary-file "$GITHUB_STEP_SUMMARY"') && run.includes(`--cloud ${W.cloud}`) && run.includes('--expect "$expect"'));
    assert.ok(run.trimEnd().split('\n').pop().startsWith('node scripts/measure/apiplane/w0-apim-probe.mjs --aggregate'));
    assert.ok(!/^\s*exit 0\s*$/m.test(run));
    const up = steps[upIdx];
    assert.equal(String(val(up.if)), '${{ always() }}');
    assert.equal(val(up.uses), 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    assert.equal(val(up.with['if-no-files-found']), 'error');
    assert.equal(val(up.with.path), '${{ env.OUT }}');
  });

  test(`${W.file}: every action ref is copied VERBATIM from a precedent workflow (lifted at run time, not transcribed)`, () => {
    // BREAKS IF: a ref is invented or re-pinned (the brief: "copy action refs/pins VERBATIM from the precedent files").
    const precedent = ['governance-w0-measure.yml', 'health-w0-gov-probe.yml', 'loom-aca-runner-smoke.yml']
      .map((f) => readFileSync(join(WORKFLOW_DIR, f), 'utf8')).join('\n');
    const { text } = loadWf(which);
    // same-line only: `\s` would run across the newline into the next line's comment
    const uses = [...text.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+(\S+)(?:[ \t]+#[ \t]*(\S+))?/gm)].map((m) => ({ ref: m[1], comment: m[2] }));
    assert.ok(uses.length >= 3, `only ${uses.length} uses: lines found`);
    for (const { ref, comment } of uses) {
      const needle = comment ? `uses: ${ref} # ${comment}` : `uses: ${ref}`;
      assert.ok(precedent.includes(needle), `'${needle}' is not in any precedent workflow`);
    }
  });

  test(`${W.file}: the script it calls exists`, () => {
    // BREAKS IF: the workflow names a script path that is not in the repo (a dispatch would fail at the first family).
    const { text } = loadWf(which);
    assert.ok(text.includes('scripts/measure/apiplane/w0-apim-probe.mjs'));
    assert.ok(readFileSync(join(PROBE_DIR, 'w0-apim-probe.mjs'), 'utf8').length > 1000);
  });
}

// ===========================================================================
// 15. edge cases that close the gaps found while reviewing the controls
// ===========================================================================

test('mcp CONTROL: a list call that answers 200 WITHOUT value[] is not an API list - exit 2', async () => {
  // BREAKS IF: a malformed 200 is counted as "a list call answered" (the family would publish an MCP count over a
  // body that was never an API list), or reported as unrunnable (exit 3/0 instead of 2).
  const est = estate();
  est.rules.push((r) => (r.method === 'GET' && /\/apis$/.test(r.path) ? { status: 200, json: { notValue: [] } } : undefined));
  const { result } = await runFamily('mcp', est);
  assert.equal(control(result, 'a-list-call-answers-200-with-value').status, 'failed');
  assert.equal(result.exitCode, 2);
  assert.equal(text(result, 'mcp.list.mcpApiCount'), 'unknown:tooling-error');
  assert.equal(text(result, 'mcp.list.typeFilter'), 'unknown:tooling-error');
});

test('foundry CONTROL (Government): a 200 whose entries are not objects is not a model list - exit 2', async () => {
  // BREAKS IF: the Gov control only checks the status (a 200 carrying garbage would read as "none listed").
  const est = estate({ cloud: 'gov' });
  est.models = { usgovvirginia: ['not-a-model', 7] };
  const { result } = await runFamily('foundry', est, { runner: 'hosted' });
  assert.equal(control(result, 'models-list-is-a-real-list').status, 'failed');
  assert.equal(result.exitCode, 2);
});

test('telemetry CONTROL: a 200 for the category list that has no value[] array fails the control and leaves the cells unknown', async () => {
  // BREAKS IF: a body that is not a category list is published as "GatewayLlmLogs absent".
  const est = estate();
  est.rules.push((r) => (r.method === 'GET' && /diagnosticSettingsCategories$/.test(r.path) ? { status: 200, json: { value: 'nope' } } : undefined));
  const { result } = await runFamily('telemetry', est);
  assert.equal(control(result, 'categories-contain-GatewayLogs').status, 'failed');
  assert.equal(text(result, 'telemetry.diag.GatewayLlmLogs'), 'unknown:tooling-error');
  assert.equal(result.exitCode, 2);
});

test('a family that crashes MID-WAY keeps the cells it had already measured', async () => {
  // BREAKS IF: a crash discards the cells measured before it (the PRP: a negative or partial result is still evidence).
  // The crash is a hostile nextLink in the workspace listing, which the client refuses by throwing.
  const est = estate();
  est.diagSettings = [];
  est.rules.push((r) => (r.method === 'GET' && /OperationalInsights\/workspaces$/.test(r.path)
    ? { status: 200, json: { value: [], nextLink: 'https://evil.example/page2' } } : undefined));
  const { result } = await runFamily('telemetry', est);
  assert.equal(result.status, 'CRASHED');
  assert.equal(result.exitCode, 2);
  assert.match(result.notes[0], /^crashed: refusing to send a arm bearer token to a foreign origin/);
  assert.equal(text(result, 'telemetry.diag.GatewayLlmLogs'), 'measured: absent (HTTP 200)', 'a cell measured before the crash survives');
  assert.equal(text(result, 'telemetry.apim.sku'), 'measured: PremiumV2 (HTTP 200)');
  assert.equal(result.cells.length, DECLARED.telemetry);
  assert.equal(text(result, 'telemetry.law.discovered'), 'unknown:tooling-error', 'the cell the crash prevented is unknown, not absent');
});

test('a scratch-creating family that crashes still sweeps and lists: scratch objects gone, cleanup cell present, exit 2', async () => {
  // BREAKS IF: a crash after the scratch API and named value exist leaves them on a live gateway. The crash is the
  // injected sleep throwing during the first latency poll.
  const est = estate();
  const deps = mkDeps(est, { sleep: async () => { throw new Error('sleep exploded'); } });
  const { result } = await runFamily('latency', est, { deps });
  assert.equal(result.status, 'CRASHED');
  assert.equal(result.exitCode, 2);
  assert.deepEqual(scratchLeft(est), []);
  assert.equal(text(result, 'latency.cleanup'), 'measured: 0 leftovers (HTTP 200)');
  assert.ok(est.callsMatching('PUT', /namedValues\/w0-apiplane-latency$/).length >= 1, 'the crash really happened after scratch objects were created');
});

test('an APIM resource with no gatewayUrl is "unreachable" (error class no-gateway-url), never "reachable"', async () => {
  // BREAKS IF: a missing gatewayUrl crashes the probe or is read as a reachable gateway.
  const est = estate();
  est.apims[0].properties.gatewayUrl = undefined;
  const { result } = await runFamily('telemetry', est);
  assert.equal(text(result, 'telemetry.gateway.reachability'), 'measured: unreachable from this runner (error class: no-gateway-url) (source: network-probe)');
  assert.equal(est.calls.filter((c) => c.origin === GATEWAY_ORIGIN).length, 0, 'there was nothing to call');
});

test('listScratch: a name that only STARTS with the prefix is disclosed, never deleted and never counted as a leftover', async () => {
  // BREAKS IF: the list filter is looser than the delete guard (the sweep would throw on, or try to delete, an object this
  // probe did not create), or a foreign prefixed object makes the family fail forever.
  const est = estate();
  est.fragments.set('w0-apiplane-Mixed-Case', { sent: '', stored: '' });
  est.fragments.set('w0-apiplane-ours', { sent: '', stored: '' });
  const ctx = await mkCtx(est);
  est.reset();
  const sweep = await core.sweepScratch(ctx);
  assert.deepEqual([...est.fragments.keys()], ['w0-apiplane-Mixed-Case'], 'only the conforming name was deleted');
  assert.equal(est.callsMatching('DELETE', /Mixed-Case/).length, 0);
  assert.deepEqual(sweep.failed, []);
  const cleanup = await core.cleanupCell(ctx, 'policies', {});
  assert.equal(cleanup.evidence.leftovers, 0);
  assert.deepEqual(cleanup.evidence.notOursButPrefixed, ['policyFragment:w0-apiplane-Mixed-Case']);
  assert.equal(core.computeExit({ cells: [cleanup], controls: [] }), 0);
});

test('listScratch: a listing that never finishes is a FAILURE, so cleanup is unknown rather than "0 leftovers" over a half-read collection', async () => {
  // BREAKS IF: the 25-page cap silently truncates the list (leftovers beyond it would read as zero).
  const est = estate();
  let page = 0;
  est.rules.push((r) => {
    if (r.method !== 'GET' || !/policyFragments$/.test(r.path)) return undefined;
    page += 1;
    return { status: 200, json: { value: [], nextLink: `${est.arm}${est.armBase}/policyFragments?api-version=2024-05-01&page=${page}` } };
  });
  const ctx = await mkCtx(est);
  const cleanup = await core.cleanupCell(ctx, 'policies', {});
  assert.equal(cleanup.verdict, 'unknown');
  assert.equal(cleanup.reason, 'tooling-error');
  assert.equal(cleanup.evidence.listFailures[0].code, 'list-truncated');
  assert.equal(page, 25, 'exactly the page cap was read');
});

test('sanitize scrubs the compressed IPv6 forms but leaves times, Type::Name text and URLs alone', () => {
  // BREAKS IF: a compressed IPv6 address (fd00::1, 2001:db8::1, fe80::, ::1, a mid-compressed one) is not scrubbed,
  // or ordinary text (a 12:30:45 time, Foo::Bar, an http://host:8080 URL, an api-version) is shredded by the pattern.
  core.clearSecretsForTest();
  for (const addr of ['fd00::1', '2001:db8::1', 'fe80::', '::1', '2001:db8:85a3::8a2e:370:7334']) {
    assert.equal(core.sanitize(`addr ${addr} end`, 0), 'addr <ip> end', addr);
  }
  for (const benign of ['at 12:30:45 UTC', 'Type Foo::Bar failed', 'column 11: The element', 'Microsoft.ApiManagement/service/apis', '2024-05-01', 'http://host:8080/path']) {
    assert.equal(core.sanitize(benign, 0), benign, benign);
  }
});

test('the markdown evidence column keeps the status, the error code and the GET-back counts even for the ~1 KB combined fragment', async () => {
  // BREAKS IF: the long sent XML is serialised BEFORE the diagnostics and the column cap cuts the status / code / counts off
  // (the PRP wants "HTTP status, error code, GET-back element count vs sent" per row, readable in the receipt itself).
  const est = estate();
  est.rules.push((r) => (r.method === 'PUT' && /policyFragments\/w0-apiplane-combined$/.test(r.path) ? jsonRes(400, rejectElementMessage('quota-by-key')) : undefined));
  const deps = mkDeps(est);
  await probe.runProbe(['--cloud', 'commercial', '--family', 'policies', '--out', 'md-evidence'], deps);
  const md = deps.files.get(resolve('md-evidence', 'commercial-policies.md'));
  const rejected = md.split('\n').find((l) => l.startsWith('| policies.combined.put |'));
  assert.ok(rejected, 'the combined.put row is missing');
  assert.ok(rejected.includes('"status":400') && rejected.includes('"code":"ValidationError"'), rejected.slice(0, 300));
  assert.ok(rejected.includes('The element \'quota-by-key\' is not supported'), 'the verbatim message must be in the row');

  const est2 = estate();
  est2.drop = (id) => (id === 'w0-apiplane-combined' ? ['trace'] : []);
  const deps2 = mkDeps(est2);
  await probe.runProbe(['--cloud', 'commercial', '--family', 'policies', '--out', 'md-evidence'], deps2);
  const dropped = deps2.files.get(resolve('md-evidence', 'commercial-policies.md')).split('\n').find((l) => l.startsWith('| policies.element.trace.combined |'));
  assert.ok(dropped.includes('"trace":{"sent":1,"got":0}'), dropped.slice(0, 400));
  assert.ok(dropped.includes('measured: rejected (silently dropped) (HTTP 201/200)'));
});

test('every family JSON and the receipt quote the Actions run that produced them, from the five runner variables only', async () => {
  // BREAKS IF: the run id is not carried into the artifact and the receipt (the PRP receipts must name the run), more of the
  // environment than the five variables is copied into an output, or a local invocation claims to be an Actions run.
  const est = estate();
  const env = {
    GITHUB_RUN_ID: '987654321', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW: 'apiplane-w0-gov-probe', GITHUB_REF_NAME: 'feat/apigw-w00-lane-a',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567', UNRELATED_VARIABLE: 'must-not-be-copied', SOME_OTHER_VALUE: 'nor-this',
  };
  const m = memFs();
  await probe.runProbe(['--cloud', 'commercial', '--family', 'identity', '--out', 'run-ctx'], mkDeps(est, { fs: m.fs, files: m.files, env }));
  const json = JSON.parse(m.files.get(resolve('run-ctx', 'commercial-identity.json')));
  assert.deepEqual(json.run, { runId: '987654321', attempt: '2', workflow: 'apiplane-w0-gov-probe', ref: 'feat/apigw-w00-lane-a', sha: '0123456789ab' });
  const dump = JSON.stringify(json);
  assert.ok(!dump.includes('must-not-be-copied') && !dump.includes('nor-this'));

  const aggregateArgs = ['--aggregate', 'run-ctx', '--expect', 'identity', '--cloud', 'commercial'];
  await probe.runProbe(aggregateArgs, { fs: m.fs, nowIso: () => 't', log: () => {}, env });
  assert.match(m.files.get(resolve('run-ctx', 'receipt.md')), /Actions run 987654321 \(attempt 2\) of apiplane-w0-gov-probe on feat\/apigw-w00-lane-a at 0123456789ab\./);

  await probe.runProbe(aggregateArgs, { fs: m.fs, nowIso: () => 't', log: () => {}, env: {} });
  assert.match(m.files.get(resolve('run-ctx', 'receipt.md')), /Not an Actions run \(no GITHUB_RUN_ID\): a local invocation\./);
  assert.deepEqual(probe.runContext({}), { runId: null, attempt: null, workflow: null, ref: null, sha: null });
});
