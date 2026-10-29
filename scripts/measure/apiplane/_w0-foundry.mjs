/**
 * _w0-foundry.mjs - family `foundry` (PRP item W0-7).
 *
 * Question: are Anthropic models listed for this boundary's region, and does a
 * `*.services.ai.azure.com` name resolve privately from where the probe runs?
 *
 *   models  GET Microsoft.CognitiveServices/locations/{location}/models. The
 *           location is `usgovvirginia` in Government and the APIM's own region in
 *           Commercial. The cell is the model NAMES whose `model.format` is
 *           `Anthropic` (or "none listed") plus the distinct formats observed.
 *   dns     one name is resolved and reported ONLY as resolves-private |
 *           resolves-public | nxdomain - never the address. A name from a real AI
 *           Services account in this subscription is used when one exists (a
 *           made-up name says nothing about private resolution); otherwise a
 *           synthetic one, and the cell says which.
 *
 * CONTROL
 *   commercial  the list must contain format `OpenAI` - a Commercial region with no
 *               OpenAI models is not a real model list.
 *   gov         a 200 with a well-formed body. An EMPTY list is a measured
 *               "none listed", not a failed control: an absent model family is the
 *               answer this family exists to find.
 *
 * RUNNER. The Gov workflow runs on a GitHub-hosted runner, which is not inside any
 * VNet of the boundary: a VNet verdict from it is
 * `not-measured:no-in-boundary-runner` (what it saw is kept as evidence, labelled
 * as the hosted runner's view). Commercial runs on the in-VNet pool runner.
 *
 * None of the cells is REQUIRED (an unreadable catalogue is exit 0, as the PRP
 * allows); a failed control is still exit 2.
 *
 * GROUNDING (Learn, fetched 2026-10-29)
 *   Models - List (value[].model.format, kind, skuName), 2024-10-01:
 *     https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/models/list
 *   Accounts - List (kind, properties.customSubDomainName), 2024-10-01:
 *     https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/accounts/list
 *   Claude on Foundry base URL form https://<resource>.services.ai.azure.com/anthropic:
 *     https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-foundry-models-claude
 */
import {
  API, isApiVersionError, listAll, measured, normalizeLocation, notMeasured, quote, reasonForFailure,
  unknown,
} from './_w0-core.mjs';

const F = 'foundry';
const id = (s) => `${F}.${s}`;

export const CELL_IDS = Object.freeze(['models.anthropic', 'models.formats', 'dns.servicesAiAzureCom'].map(id));

export const GOV_LOCATION = 'usgovvirginia';
const ROLE = 'Reader';
const SYNTHETIC_HOST = 'w0-apiplane-dns-probe.services.ai.azure.com';

/** private = RFC 1918, CGNAT, loopback, link-local, IPv6 ULA / link-local / loopback. Anything else is public. */
export function classifyAddress(address) {
  const a = String(address);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [o1, o2] = [Number(v4[1]), Number(v4[2])];
    if (o1 === 10 || o1 === 127) return 'private';
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return 'private';
    if (o1 === 192 && o2 === 168) return 'private';
    if (o1 === 169 && o2 === 254) return 'private';
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return 'private';
    return 'public';
  }
  const low = a.toLowerCase();
  if (low === '::1' || /^f[cd][0-9a-f]{2}:/.test(low) || /^fe[89ab][0-9a-f]:/.test(low)) return 'private';
  return 'public';
}

/**
 * Resolve a host and return ONLY a class. `lookup(host)` returns a list of address
 * strings or throws an error with `.code`. ENOTFOUND / ENODATA are nxdomain; any
 * other failure is retried (bounded) and then reported as `error`, never as a verdict.
 */
export async function dnsVerdict(lookup, sleep, host) {
  let lastCode = 'other';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const addrs = await lookup(host);
      if (!Array.isArray(addrs) || addrs.length === 0) return { verdict: 'nxdomain' };
      return { verdict: addrs.every((x) => classifyAddress(x) === 'private') ? 'resolves-private' : 'resolves-public' };
    } catch (err) {
      const code = String(err?.code ?? '');
      if (/ENOTFOUND|ENODATA/i.test(code)) return { verdict: 'nxdomain' };
      lastCode = /EAI_AGAIN|TIMEOUT|ETIMEDOUT/i.test(code) ? 'timeout' : 'other';
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  return { verdict: null, errorClass: lastCode };
}

/**
 * @param {object} ctx
 * @param {{cells:Array, controls:Array}} acc
 */
export async function run(ctx, acc) {
  const { cells, controls } = acc;
  const opt = { required: false };
  const isGov = ctx.cloud.name === 'gov';
  const location = isGov ? GOV_LOCATION : normalizeLocation(ctx.apim.location);
  const subscription = encodeURIComponent(ctx.subscriptionId);

  // ---- regional model catalogue ----
  const r = await listAll(ctx, `${ctx.cloud.arm}/subscriptions/${subscription}/providers/Microsoft.CognitiveServices/locations/${encodeURIComponent(location)}/models?api-version=${API.cognitive}`);
  const aid = id('models.anthropic');
  const fid = id('models.formats');
  if (!r.ok && !r.malformed) {
    const res = r.last;
    const cell = isApiVersionError(res.status, res.errorCode, res.errorMessage)
      ? (cid) => notMeasured(cid, 'api-version-unsupported-in-boundary', { ...opt, evidence: { ...quote(res), apiVersion: API.cognitive } })
      : (cid) => unknown(cid, reasonForFailure(res, { role: ROLE, scope: 'subscription' }) ?? 'tooling-error', { ...opt, evidence: quote(res) });
    cells.push(cell(aid), cell(fid));
    controls.push({ id: 'models-list-is-a-real-list', status: 'unrunnable', detail: `the model list could not be read (HTTP ${res.status ?? 'network'})` });
  } else if (r.malformed) {
    controls.push({ id: 'models-list-is-a-real-list', status: 'failed', detail: 'HTTP 200 without a value[] array: not a model list' });
    cells.push(unknown(aid, 'tooling-error', { ...opt, evidence: { note: '200 without value[]' } }), unknown(fid, 'tooling-error', { ...opt, evidence: { note: '200 without value[]' } }));
  } else {
    const items = r.items;
    const wellFormed = items.every((m) => m && typeof m === 'object');
    const formats = [...new Set(items.map((m) => m?.model?.format).filter((f) => typeof f === 'string'))].sort();
    if (isGov) {
      controls.push({
        id: 'models-list-is-a-real-list',
        status: wellFormed ? 'passed' : 'failed',
        detail: wellFormed ? `a 200 with a well-formed body (${items.length} entries; an empty list is a measured answer)` : 'a list entry is not an object',
      });
    } else {
      const hasOpenAi = formats.includes('OpenAI');
      controls.push({
        id: 'models-list-is-a-real-list',
        status: wellFormed && hasOpenAi ? 'passed' : 'failed',
        detail: hasOpenAi ? 'the Commercial list contains format OpenAI' : `the Commercial list has no format OpenAI (formats seen: ${formats.join(', ') || 'none'}): not a real model list`,
      });
    }
    // Case-insensitive on purpose: the brief says format `Anthropic`, but a casing surprise must not read as "none listed".
    // `formats` keeps the exact strings the service sent.
    const names = [...new Set(items.filter((m) => /^anthropic$/i.test(String(m?.model?.format))).map((m) => m?.model?.name).filter((n) => typeof n === 'string'))].sort();
    const http = r.last.status;
    const call = `GET /subscriptions/{subscription}/providers/Microsoft.CognitiveServices/locations/${location}/models?api-version=${API.cognitive}`;
    cells.push(measured(aid, names.length ? names.join(', ') : 'none listed', { ...opt, http, evidence: { location, command: call, anthropicModelCount: names.length, totalModels: items.length } }));
    cells.push(measured(fid, { formats, totalModels: items.length }, { ...opt, http, evidence: { location, command: call } }));
  }

  // ---- DNS ----
  const did = id('dns.servicesAiAzureCom');
  let host = SYNTHETIC_HOST;
  let nameSource = 'synthetic';
  const accounts = await listAll(ctx, `${ctx.cloud.arm}/subscriptions/${subscription}/providers/Microsoft.CognitiveServices/accounts?api-version=${API.cognitive}`);
  if (accounts.ok) {
    const sub = accounts.items.find((a) => a?.kind === 'AIServices' && typeof a?.properties?.customSubDomainName === 'string' && /^[a-zA-Z0-9-]{2,64}$/.test(a.properties.customSubDomainName));
    if (sub) { host = `${sub.properties.customSubDomainName}.services.ai.azure.com`; nameSource = 'discovered-ai-services-account'; }
  }
  const d = await dnsVerdict(ctx.dnsLookup, ctx.sleep, host);
  const evidence = { hostPattern: '*.services.ai.azure.com', nameSource, accountListStatus: accounts.last?.status ?? null, runner: ctx.runner };
  if (d.verdict === null) {
    cells.push(unknown(did, 'transient-exhausted', { ...opt, evidence: { ...evidence, dnsErrorClass: d.errorClass } }));
  } else if (ctx.runner === 'in-vnet') {
    cells.push(measured(did, d.verdict, { ...opt, source: 'dns-lookup-from-in-vnet-runner', evidence }));
  } else {
    cells.push(notMeasured(did, 'no-in-boundary-runner', { ...opt, evidence: { ...evidence, hostedRunnerView: d.verdict, note: 'a GitHub-hosted runner is not inside the boundary VNet: what it resolves is the public view, not a VNet verdict' } }));
  }
}
