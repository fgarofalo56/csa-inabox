/**
 * _w0-policies.mjs - family `policies` (PRP item W0-2; also #4442 Wave 0 task 2
 * / #4460: one measurement serving both programs).
 *
 * Question: is each of `llm-token-limit`, `llm-emit-token-metric`, `trace`
 * (with metadata), `validate-azure-ad-token`, `include-fragment`,
 * `rate-limit-by-key` and `quota-by-key` AUTHORABLE on this gateway - accepted
 * by a policy-fragment PUT AND still there when the fragment is read back.
 *
 * TWO SHAPES, ON PURPOSE. The PRP's combined seven-element fragment is PUT, and
 * so is ONE single-element fragment per element: a combined PUT reports only the
 * FIRST invalid element, so only the single-element fragments give a status per
 * element. A 2xx whose GET-back (format=rawxml) has fewer of an element than was
 * sent is recorded `rejected (silently dropped)` - a 2xx alone proves nothing.
 *
 * CONTROLS (a measurement that cannot fail is not a measurement)
 *   positive  a known-good `rate-limit-by-key` fragment MUST be accepted and come
 *             back: otherwise the probe cannot see an accepted fragment at all.
 *   negative  a bogus element `w0-apiplane-not-a-policy` MUST NOT come back: if
 *             APIM accepts it and returns it, APIM is not validating and every
 *             "accepted" row in this family is meaningless.
 *   A failed control makes the family INVALID (exit 2).
 *
 * A rejection whose message names an ATTRIBUTE (not the element) is a
 * probe-authoring defect: unknown:tooling-error, never `rejected`.
 *
 * SCRATCH: everything is named `w0-apiplane-*`, created after a start sweep and
 * removed by an end sweep in `finally`; the family ends with a leftover listing.
 *
 * ELEMENT SHAPES - each from its Learn policy page, fetched 2026-10-29. FIXTURES
 * ARE SYNTHETIC (from the Learn example), NOT OBSERVED; the first live run is the
 * real validation.
 *   llm-token-limit          counter-key + tokens-per-minute + estimate-prompt-tokens (required: counter-key, estimate-prompt-tokens, one of rate/quota)
 *     https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy
 *   llm-emit-token-metric    namespace + one or more <dimension name=... />
 *     https://learn.microsoft.com/en-us/azure/api-management/llm-emit-token-metric-policy
 *   trace                    source + severity, <message>, <metadata name value/>
 *     https://learn.microsoft.com/en-us/azure/api-management/trace-policy
 *   validate-azure-ad-token  tenant-id (well-known "organizations" - no real tenant id in a public repo) + <audiences>
 *     https://learn.microsoft.com/en-us/azure/api-management/validate-azure-ad-token-policy
 *   include-fragment         fragment-id
 *     https://learn.microsoft.com/en-us/azure/api-management/include-fragment-policy
 *   rate-limit-by-key        calls + renewal-period (max 300) + counter-key
 *     https://learn.microsoft.com/en-us/azure/api-management/rate-limit-by-key-policy
 *   quota-by-key             calls + renewal-period (min 300) + counter-key. NOTE Learn's "applies to" line
 *                            lists Developer | Basic | Standard | Premium - NOT the v2 tiers - while its
 *                            usage section lists "classic, v2" gateways; the page contradicts itself, which is
 *                            exactly why this row is measured rather than assumed.
 *     https://learn.microsoft.com/en-us/azure/api-management/quota-by-key-policy
 *   Fragment wrapper and PUT body ({format:"xml", value:"<fragment>...</fragment>"}), GET ?format=rawxml:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/policy-fragment/get
 *   API-scope policy PUT body ({format, value:"<policies>..."}), GET ?format=rawxml:
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api-policy/create-or-update
 *     https://learn.microsoft.com/en-us/rest/api/apimanagement/api-policy/get
 */
import {
  API, armUrl, assertScratchName, deleteScratch, getApiPolicyRaw, getNamedValue, isValidationRejection, measured,
  putAndReadBack, putApi, putApiPolicy, putNamedValue, quote, reasonForFailure, unknown, waitProvisioned, withScratch,
} from './_w0-core.mjs';

const F = 'policies';
const id = (s) => `${F}.${s}`;

export const ELEMENTS = Object.freeze([
  'llm-token-limit', 'llm-emit-token-metric', 'trace', 'validate-azure-ad-token',
  'include-fragment', 'rate-limit-by-key', 'quota-by-key',
]);

export const CELL_IDS = Object.freeze([
  'namedValue.put', 'namedValue.get', 'namedValue.delete', 'control.positive', 'control.negative',
  ...ELEMENTS.map((e) => `element.${e}.single`),
  'combined.put',
  ...ELEMENTS.map((e) => `element.${e}.combined`),
  'include-fragment.apiScope', 'cleanup',
].map(id));

const NV_ID = 'w0-apiplane-nv';
const CTL_POSITIVE_ID = 'w0-apiplane-ctl-positive';
const CTL_NEGATIVE_ID = 'w0-apiplane-ctl-negative';
const COMBINED_ID = 'w0-apiplane-combined';
const API_ID = 'w0-apiplane-pol-api';
const BOGUS = 'w0-apiplane-not-a-policy';
const ROLE = 'API Management Service Contributor';

/** SYNTHETIC (from Learn example), not observed. */
export const FRAGMENT_XML = Object.freeze({
  'llm-token-limit': '<llm-token-limit counter-key="@(context.Request.IpAddress)" tokens-per-minute="5000" estimate-prompt-tokens="false" />',
  'llm-emit-token-metric': '<llm-emit-token-metric namespace="w0-apiplane"><dimension name="API ID" /></llm-emit-token-metric>',
  trace: '<trace source="w0-apiplane" severity="information"><message>w0-apiplane probe</message><metadata name="w0-apiplane" value="probe" /></trace>',
  'validate-azure-ad-token': '<validate-azure-ad-token tenant-id="organizations"><audiences><audience>api://w0-apiplane-synthetic</audience></audiences></validate-azure-ad-token>',
  'include-fragment': `<include-fragment fragment-id="${CTL_POSITIVE_ID}" />`,
  'rate-limit-by-key': '<rate-limit-by-key calls="10" renewal-period="60" counter-key="@(context.Request.IpAddress)" />',
  'quota-by-key': '<quota-by-key calls="10000" renewal-period="3600" counter-key="@(context.Request.IpAddress)" />',
});

const wrap = (inner) => `<fragment>${inner}</fragment>`;
export const COMBINED_XML = wrap(ELEMENTS.map((e) => FRAGMENT_XML[e]).join(''));
export const API_INCLUDE_POLICY = `<policies><inbound><base />${FRAGMENT_XML['include-fragment']}</inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`;

// A PUT helper like the ones in _w0-core.mjs: async, and the scratch-name guard comes FIRST (a source-shape test pins it).
// Exported so the guard can be exercised directly.
export const putFragment = async (ctx, fragId, xml) => {
  assertScratchName(fragId, 'write');
  return ctx.client.request({
    service: 'arm', method: 'PUT', url: armUrl(ctx, `/policyFragments/${encodeURIComponent(fragId)}`, API.apim),
    body: { properties: { format: 'xml', description: 'w0-apiplane scratch fragment (deleted in the same run)', value: xml } },
  });
};
const readFragment = (ctx, fragId) => ctx.client.request({ service: 'arm', url: armUrl(ctx, `/policyFragments/${fragId}`, API.apim, 'format=rawxml') });

const attempt = putAndReadBack;

function evidenceOf(a, extra = {}) {
  // diagnostics first, the (long) sent XML last: the markdown column is capped and must keep status, code and counts
  return {
    put: quote(a.put),
    getBack: a.counts ?? null,
    getStatus: a.get?.status ?? null,
    note: a.note ?? null,
    ...extra,
    sent: a.xml,
  };
}
const httpOf = (a) => [a.put.status, a.get?.status].filter(Number.isInteger);

/** One row for a single-element (or control / API-scope) attempt. */
function rowCell(cellId, a, { attributeRule = true, acceptedText = 'accepted' } = {}) {
  switch (a.outcome) {
    case 'accepted':
      return measured(cellId, acceptedText, { http: httpOf(a), evidence: evidenceOf(a) });
    case 'silent-drop':
      return measured(cellId, 'rejected (silently dropped)', { http: httpOf(a), evidence: evidenceOf(a, { dropped: a.mismatched }) });
    case 'rejected-failed':
      return measured(cellId, 'rejected (provisioningState Failed after a 2xx PUT)', { http: httpOf(a), evidence: evidenceOf(a) });
    case 'rejected':
      if (attributeRule && a.attribute) {
        return unknown(cellId, 'tooling-error', {
          evidence: evidenceOf(a, { why: 'the rejection names an ATTRIBUTE, not the element: a probe-authoring defect, not a finding' }),
        });
      }
      return measured(cellId, 'rejected', { http: a.put.status, evidence: evidenceOf(a) });
    default:
      return unknown(cellId, a.reason, { evidence: evidenceOf(a) });
  }
}

/** The per-element row inside the combined fragment. */
function combinedElementCell(cellId, a, el) {
  const own = a.counts?.[el];
  const ev = evidenceOf(a, { element: el, thisElement: own ?? null });
  if (a.outcome === 'accepted') return measured(cellId, 'accepted', { http: httpOf(a), evidence: ev });
  if (a.outcome === 'silent-drop') {
    return own && own.got === own.sent
      ? measured(cellId, 'accepted', { http: httpOf(a), evidence: ev })
      : measured(cellId, 'rejected (silently dropped)', { http: httpOf(a), evidence: ev });
  }
  if (a.outcome === 'rejected' && a.attribute) {
    return unknown(cellId, 'tooling-error', { evidence: { ...ev, why: 'the combined rejection names an ATTRIBUTE: a probe-authoring defect' } });
  }
  if (a.outcome === 'rejected' || a.outcome === 'rejected-failed') {
    return measured(cellId, 'rejected (the combined PUT was rejected as a whole; APIM names only the first invalid element, see the single-element row)', {
      http: a.put.status, evidence: ev,
    });
  }
  return unknown(cellId, a.reason, { evidence: ev });
}

async function namedValueBlock(ctx, cells) {
  const put = await putNamedValue(ctx, NV_ID, 'w0-apiplane-probe');
  const early = reasonForFailure(put, { role: ROLE, scope: 'apim' });
  if (early || !put.ok) {
    // `rejected` only for a validation answer (400 / 422); a 409 / 412 is `early` (transient-exhausted); any other status is the
    // probe's request failing (tooling-error), not the gateway judging the named value.
    let putCell;
    if (early) putCell = unknown(id('namedValue.put'), early, { evidence: { put: quote(put) } });
    else if (isValidationRejection(put)) putCell = measured(id('namedValue.put'), 'rejected', { http: put.status, evidence: { put: quote(put) } });
    else putCell = unknown(id('namedValue.put'), 'tooling-error', { evidence: { put: quote(put), note: `HTTP ${put.status} is not a validation response (400/422): not a verdict on the named value` } });
    cells.push(putCell);
    for (const n of ['namedValue.get', 'namedValue.delete']) {
      cells.push(early
        ? unknown(id(n), early, { evidence: { note: 'not attempted: the PUT could not be made' } })
        : unknown(id(n), 'tooling-error', { evidence: { note: 'not attempted: the named value PUT was not accepted' } }));
    }
    return;
  }
  const w = await waitProvisioned(ctx, () => getNamedValue(ctx, NV_ID));
  cells.push(measured(id('namedValue.put'), 'accepted', { http: put.status, evidence: { put: quote(put), provisioningAfterPut: w.state } }));
  if (w.state === 'read-failed') {
    cells.push(unknown(id('namedValue.get'), reasonForFailure(w.last, { role: ROLE, scope: 'apim' }) ?? 'tooling-error', { evidence: { get: quote(w.last) } }));
  } else {
    const matches = w.last.json?.properties?.displayName === NV_ID;
    cells.push(measured(id('namedValue.get'), matches ? 'readable (displayName matches)' : 'readable but displayName does NOT match what was PUT', {
      http: [put.status, w.last.status], evidence: { provisioningState: w.state, displayNameMatches: matches },
    }));
  }
  const del = await deleteScratch(ctx, 'namedValue', NV_ID);
  const gone = await getNamedValue(ctx, NV_ID);
  if (del.status !== null && [200, 202, 204].includes(del.status) && gone.status === 404) {
    cells.push(measured(id('namedValue.delete'), 'deleted (GET after DELETE: 404)', { http: [del.status, gone.status] }));
  } else if (gone.status === 200) {
    cells.push(measured(id('namedValue.delete'), 'NOT deleted (GET after DELETE still answers 200)', { http: [del.status, 200].filter(Number.isInteger), evidence: { delete: quote(del) } }));
  } else {
    cells.push(unknown(id('namedValue.delete'), reasonForFailure(del, { role: ROLE, scope: 'apim' }) ?? reasonForFailure(gone, { role: ROLE, scope: 'apim' }) ?? 'tooling-error', { evidence: { delete: quote(del), get: quote(gone) } }));
  }
}

async function apiScopeInclude(ctx, cells) {
  const cellId = id('include-fragment.apiScope');
  const api = await putApi(ctx, API_ID, { displayName: API_ID, path: 'w0-apiplane-pol', protocols: ['https'], subscriptionRequired: true });
  const early = reasonForFailure(api, { role: ROLE, scope: 'apim' });
  if (early) { cells.push(unknown(cellId, early, { evidence: { api: quote(api) } })); return; }
  if (!api.ok) { cells.push(unknown(cellId, 'tooling-error', { evidence: { note: 'the scratch API PUT was rejected, so the API-scope test could not run', api: quote(api) } })); return; }
  const a = await attempt(ctx, {
    put: () => putApiPolicy(ctx, API_ID, API_INCLUDE_POLICY),
    read: () => getApiPolicyRaw(ctx, API_ID),
    xml: API_INCLUDE_POLICY,
    count: ['include-fragment'],
  });
  cells.push(rowCell(cellId, a));
}

/**
 * @param {object} ctx
 * @param {{cells:Array, controls:Array}} acc
 */
export async function run(ctx, acc) {
  const { cells, controls } = acc;
  await withScratch(ctx, F, acc, async () => {
    await namedValueBlock(ctx, cells);

    const fragment = (fragId, inner, count) => attempt(ctx, {
      put: () => putFragment(ctx, fragId, inner),
      read: () => readFragment(ctx, fragId),
      xml: inner,
      count,
    });

    // ---- positive control ----
    const pos = await fragment(CTL_POSITIVE_ID, wrap(FRAGMENT_XML['rate-limit-by-key']), ['rate-limit-by-key']);
    cells.push(rowCell(id('control.positive'), pos));
    controls.push({
      id: 'positive-known-good-fragment-accepted-and-returned',
      status: pos.outcome === 'accepted' ? 'passed' : (pos.outcome === 'unknown' ? 'unrunnable' : 'failed'),
      detail: pos.outcome === 'accepted'
        ? 'a known-good rate-limit-by-key fragment was accepted and came back'
        : `the known-good fragment was not accepted-and-returned (${pos.outcome}); the probe cannot see an accepted fragment`,
    });

    // ---- negative control ----
    const neg = await fragment(CTL_NEGATIVE_ID, wrap(`<${BOGUS} />`), [BOGUS]);
    cells.push(rowCell(id('control.negative'), neg, { attributeRule: false }));
    let negStatus;
    if (neg.outcome === 'accepted') negStatus = 'failed';
    else if (neg.outcome === 'silent-drop' || neg.outcome === 'rejected-failed') negStatus = 'passed';
    else if (neg.outcome === 'rejected') negStatus = [400, 422].includes(neg.put.status) ? 'passed' : 'unrunnable';
    else negStatus = 'unrunnable';
    controls.push({
      id: 'negative-bogus-element-not-retained',
      status: negStatus,
      detail: negStatus === 'failed'
        ? 'APIM accepted AND returned a bogus element: it is not validating, so every "accepted" in this family is meaningless'
        : `the bogus element was not retained (${neg.outcome}, HTTP ${neg.put.status ?? 'network'})`,
    });
    if (controls.some((c) => c.status === 'failed')) return;

    // ---- one fragment per element ----
    for (const el of ELEMENTS) {
      const a = await fragment(`w0-apiplane-el-${el}`, wrap(FRAGMENT_XML[el]), [el]);
      cells.push(rowCell(id(`element.${el}.single`), a));
    }

    // ---- the PRP's combined fragment ----
    const c = await fragment(COMBINED_ID, COMBINED_XML, ELEMENTS.slice());
    cells.push(rowCell(id('combined.put'), c, {
      acceptedText: `accepted (all ${ELEMENTS.length} elements retained)`,
    }));
    for (const el of ELEMENTS) cells.push(combinedElementCell(id(`element.${el}.combined`), c, el));

    // ---- include-fragment in a scratch API-scope policy (the thin policy ADR-003 relies on) ----
    await apiScopeInclude(ctx, cells);
  });
}
