/**
 * POST /api/items/aip-logic/[id]/publish  →  publish the Spindle function as REST
 *   body: { serviceUrl?, path? }
 *   → { ok, api:{ id, name, path, displayName }, callableUrl?, curl?, eval } on success
 *   → { ok:false, code:'eval_gate_failed', eval } (409) when the eval suite fails
 *   → { ok:false, code:'apim_not_configured', gate } (503) when APIM is unset
 *
 * Publishes a typed Spindle (Palantir AIP-Logic) function as a first-class REST
 * endpoint through Azure API Management — the SAME real ARM import path
 * (importApiFromOpenApi) the OSDK / data-product marketplace uses. The generated
 * OpenAPI describes the function's typed inputs (request body) and typed output
 * (response); APIM's backend serviceUrl points at the console's own /invoke
 * route so a call runs the REAL block graph.
 *
 * EVALS-IN-CI GATE (the hard part): before it publishes ANYTHING, this route
 * runs the attached eval suite against the live block graph and BLOCKS the
 * publish (409) unless the suite passes its threshold. No suite ⇒ no publish.
 * On success it also snapshots a version. 100% Azure-native (APIM + AOAI +
 * Synapse) — no Fabric / Power BI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { importApiFromOpenApi, apimConfigGate, getServiceInfo, ApimError } from '@/lib/azure/apim-client';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { runSpindleEvalSuite, normalizeEvalSuite } from '../_spindle-eval';
import { appendVersion } from '../versions/route';
import { buildLogicOpenApi, slugifyApi } from '../_publish-openapi';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const ITEM_TYPE = 'aip-logic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the function before publishing', 400, { code: 'no_id' });
  const body = await req.json().catch(() => ({} as { serviceUrl?: string; path?: string }));

  const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!item) return apiError('aip-logic function not found', 404, { code: 'not_found' });
  const state = (item.state || {}) as Record<string, unknown>;
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  if (blocks.length === 0) return apiError('add at least one block before publishing', 400, { code: 'no_blocks' });

  // ── EVALS-IN-CI GATE ── run the attached suite against the REAL block graph;
  // publish is blocked unless it passes. No suite ⇒ blocked (parity with
  // "attach + pass an eval suite to publish").
  const cases = normalizeEvalSuite(state.evalSuite);
  if (cases.length === 0) {
    return apiError(
      'Publish is gated on evals: attach at least one eval case (inputs + criteria) and pass it before publishing this function as a REST API.',
      409, { code: 'eval_gate_no_suite' },
    );
  }
  const evalResult = await runSpindleEvalSuite(state, s.claims.oid);
  if (evalResult.notDeployed) {
    return NextResponse.json({
      ok: false, code: 'not_deployed',
      error: 'Cannot run the publish eval gate — no Azure OpenAI deployment configured.',
      gate: { reason: 'The evals-in-CI publish gate runs each case against Azure OpenAI.', remediation: 'Deploy a model on the AI Foundry hub (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric required.' },
    }, { status: 503 });
  }
  // Persist the gate run so the Evals panel reflects it.
  const lastEval = {
    ranAt: evalResult.ranAt, summary: evalResult.summary, passed: evalResult.passed,
    passThreshold: evalResult.passThreshold, minPassRate: evalResult.minPassRate,
    rows: evalResult.rows.map((r) => ({ id: r.id, name: r.name, criteria: r.criteria, score: r.score, status: r.status, answer: String(r.answer || '').slice(0, 600), rationale: r.rationale, error: r.error })),
    context: 'publish-gate',
  };
  if (!evalResult.passed) {
    await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: { ...state, lastEval } });
    const failed = evalResult.rows.filter((r) => r.status !== 'pass').length;
    return NextResponse.json({
      ok: false, code: 'eval_gate_failed',
      error: `Publish blocked: ${failed} of ${evalResult.summary.total} eval case(s) did not meet the pass threshold (${evalResult.passThreshold}/5, min pass-rate ${Math.round(evalResult.minPassRate * 100)}%). Fix the function or the cases, then re-publish.`,
      eval: lastEval,
    }, { status: 409 });
  }

  // ── APIM gate (honest infra gate, no Fabric) ──
  const gate = apimConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false, code: 'apim_not_configured',
      error: `Azure API Management not configured: set ${gate.missing}.`,
      gate: { reason: 'The function is published as REST through Azure API Management (APIM-first).', remediation: `Set ${gate.missing} on the Console. No Microsoft Fabric required.` },
      eval: lastEval,
    }, { status: 503 });
  }

  // ── Real APIM import ──
  const apiPath = slugifyApi(String(body?.path || item.displayName || 'spindle')) + '-spindle';
  const displayName = `${item.displayName || 'Spindle logic'} (Spindle REST)`;
  // Backend origin: the console's own invoke route runs the REAL block graph.
  const origin = req.nextUrl.origin;
  const serviceUrl = String(body?.serviceUrl || state.publishServiceUrl || '').trim() || `${origin}/api/items/${ITEM_TYPE}/${encodeURIComponent(id)}`;
  const openApi = buildLogicOpenApi({
    displayName,
    inputs: Array.isArray(state.inputs) ? (state.inputs as Record<string, unknown>[]) : [],
    outputType: String(state.outputType || 'string'),
    outputDescription: String(state.outputDescription || ''),
  });

  try {
    const api = await importApiFromOpenApi({
      apiId: apiPath, displayName, path: apiPath,
      format: 'openapi+json', value: JSON.stringify(openApi), serviceUrl,
    });
    const svc = await getServiceInfo().catch(() => null);
    const gatewayUrl = svc?.gatewayUrl?.replace(/\/+$/, '');
    const callableUrl = gatewayUrl ? `${gatewayUrl}/${api.path}/invoke` : undefined;
    const curl = callableUrl
      ? `curl -X POST "${callableUrl}" \\\n  -H "Ocp-Apim-Subscription-Key: <your-subscription-key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"inputs":${JSON.stringify(sampleInputs(state))},"mode":"logic"}'`
      : undefined;

    // Snapshot a version on publish + persist the published API + eval verdict.
    const { versions } = appendVersion(state, `Published REST · ${api.path}`, { publishedApiPath: api.path, evalPassRate: evalResult.summary.passRate });
    await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, {
      state: {
        ...state, versions, lastEval,
        publishedApiId: api.name, publishedApiPath: api.path, publishServiceUrl: serviceUrl,
        publishedAt: new Date().toISOString(), publishedCallableUrl: callableUrl || null,
      },
    });
    await recordThreadEdge(s, {
      fromItemId: id, fromType: ITEM_TYPE, fromName: item.displayName,
      toItemId: api.name || apiPath, toType: 'apim-api', toName: displayName,
      action: 'spindle-publish-apim',
    });

    return NextResponse.json({
      ok: true,
      api: { id: api.id, name: api.name, path: api.path, displayName: api.displayName },
      callableUrl, curl, eval: lastEval,
    });
  } catch (e: unknown) {
    const status = e instanceof ApimError ? (e.status || 502) : 502;
    return apiError(`APIM publish failed: ${e instanceof Error ? e.message : String(e)}`, status, { code: 'publish_failed' });
  }
}

/** A representative inputs object for the generated curl (typed defaults). */
function sampleInputs(state: Record<string, unknown>): Record<string, unknown> {
  const inputs = Array.isArray(state.inputs) ? (state.inputs as Record<string, unknown>[]) : [];
  const out: Record<string, unknown> = {};
  for (const i of inputs) {
    const name = String(i.name || '');
    if (!name) continue;
    const t = String(i.type || 'string');
    out[name] = t === 'boolean' ? true : /integer|long|double|float|number/.test(t) ? 0 : t === 'array' ? [] : t === 'struct' ? {} : '';
  }
  return out;
}
