/**
 * POST /api/items/dataflow/copilot — the Dataflow Gen2 Copilot backend.
 *
 * One JSON endpoint behind the Copilot pane in the Dataflow Gen2 editor. It maps
 * a fixed, server-validated intent onto one real Power Query (M) operation via
 * `dataflow-engine-client.ts` and returns a response card the editor renders.
 * Generated queries/steps are validated structurally (same parser as the Applied
 * Steps pane) BEFORE they are returned; the editor only mutates the real M after
 * the user approves the diff. There is no fabricated step list.
 *
 *   Body: { intent, prompt?, mScript, activeQuery, sourceQuery? }
 *   intent ∈ { generate_query | reference_query | explain | add_step | undo }
 *
 *   200 { ok:true, kind:'new_query', queryName, mBody, validatedStepCount } |
 *       { ok:true, kind:'explain', explanation } |
 *       { ok:true, kind:'transform', stepName, stepExpr } |
 *       { ok:true, kind:'undo', newBody, removedStep }
 *   400 { ok:false, error }                       — bad request / unusable model output
 *   401 { ok:false, error:'unauthenticated' }
 *   503 { ok:false, code:'no_aoai', error, hint } — AOAI not wired (honest gate)
 *
 * Azure-native by default (no-fabric-dependency): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset; no Fabric / Power BI host is contacted.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  generateQueryFromNL,
  generateReferenceQuery,
  explainQuery,
  generateTransformStep,
  validateMScript,
  parseSharedQueries,
  parseLetBody,
  buildLetBody,
  DataflowCopilotError,
} from '@/lib/azure/dataflow-engine-client';

// Fixed, server-validated intent allowlist (no free-form intent injection).
const INTENTS = ['generate_query', 'reference_query', 'explain', 'add_step', 'undo'] as const;
type Intent = (typeof INTENTS)[number];

interface CopilotBody {
  intent?: string;
  prompt?: string;
  mScript?: string;
  activeQuery?: string;
  sourceQuery?: string;
}

/** Pull a query's let-body out of the full section text by name. */
function bodyOf(mScript: string, queryName: string): string {
  const q = parseSharedQueries(mScript).find((x) => x.name === queryName);
  return q?.body || '';
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: CopilotBody = {};
  try {
    body = (await req.json()) as CopilotBody;
  } catch {
    /* fall through to validation */
  }

  const intent = String(body.intent || '').toLowerCase() as Intent;
  if (!INTENTS.includes(intent)) {
    return NextResponse.json(
      { ok: false, error: `intent must be one of: ${INTENTS.join(', ')}` },
      { status: 400 },
    );
  }
  const mScript = String(body.mScript || '');
  const activeQuery = String(body.activeQuery || '');
  const prompt = String(body.prompt || '');
  if (!mScript.trim()) {
    return NextResponse.json({ ok: false, error: 'mScript is required' }, { status: 400 });
  }

  const queries = parseSharedQueries(mScript);
  const existingNames = queries.map((q) => q.name);
  const activeBody = bodyOf(mScript, activeQuery);

  // --- Undo is pure M manipulation: no AOAI required. ---
  if (intent === 'undo') {
    if (!activeBody) {
      return NextResponse.json({ ok: false, error: `active query "${activeQuery}" not found` }, { status: 400 });
    }
    const { steps } = parseLetBody(activeBody);
    if (steps.length <= 1) {
      return NextResponse.json({ ok: false, error: 'Cannot remove the last remaining step.' }, { status: 400 });
    }
    const nextSteps = steps.slice(0, -1);
    const newBody = buildLetBody(nextSteps, nextSteps[nextSteps.length - 1].name);
    return NextResponse.json({
      ok: true,
      kind: 'undo',
      queryName: activeQuery,
      removedStep: steps[steps.length - 1].name,
      newBody,
    });
  }

  // --- All other intents call AOAI; resolve target (honest 503 gate). ---
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  let target;
  try {
    target = await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a chat ' +
          'deployment under Admin → Tenant settings → Copilot & Agents (deploy the AI Foundry project — ' +
          'platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true).';
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  try {
    switch (intent) {
      case 'generate_query': {
        if (!prompt.trim()) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
        const g = await generateQueryFromNL(prompt, existingNames, target);
        const v = validateMScript(g.mBody);
        return NextResponse.json({
          ok: true,
          kind: 'new_query',
          queryName: g.queryName,
          mBody: g.mBody,
          validatedStepCount: v.queries[0]?.stepCount ?? 0,
        });
      }
      case 'reference_query': {
        if (!prompt.trim()) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
        const sourceQuery = String(body.sourceQuery || activeQuery);
        if (!sourceQuery) return NextResponse.json({ ok: false, error: 'sourceQuery is required' }, { status: 400 });
        const g = await generateReferenceQuery(
          prompt, sourceQuery, bodyOf(mScript, sourceQuery), existingNames, target,
        );
        const v = validateMScript(g.mBody);
        return NextResponse.json({
          ok: true,
          kind: 'new_query',
          queryName: g.queryName,
          mBody: g.mBody,
          validatedStepCount: v.queries[0]?.stepCount ?? 0,
        });
      }
      case 'explain': {
        if (!activeBody) return NextResponse.json({ ok: false, error: `active query "${activeQuery}" not found` }, { status: 400 });
        const explanation = await explainQuery(activeQuery, activeBody, target);
        return NextResponse.json({ ok: true, kind: 'explain', queryName: activeQuery, explanation });
      }
      case 'add_step': {
        if (!prompt.trim()) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
        if (!activeBody) return NextResponse.json({ ok: false, error: `active query "${activeQuery}" not found` }, { status: 400 });
        const step = await generateTransformStep(prompt, activeQuery, activeBody, target);
        return NextResponse.json({
          ok: true,
          kind: 'transform',
          queryName: activeQuery,
          stepName: step.stepName,
          stepExpr: step.stepExpr,
        });
      }
      default:
        return NextResponse.json({ ok: false, error: 'unsupported intent' }, { status: 400 });
    }
  } catch (e: any) {
    const status = e instanceof DataflowCopilotError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
