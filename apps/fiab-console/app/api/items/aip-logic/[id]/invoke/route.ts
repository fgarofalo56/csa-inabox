/**
 * POST /api/items/aip-logic/[id]/invoke
 *   body: { inputs: Record<string, unknown>, mode?: 'logic' | 'agent' }
 *   → logic mode: { ok, output, model, usage?, sourcesUsed?, tools? }
 *   → agent mode: { ok, output, model, usage?, steps[] }
 *   → { ok:false, notDeployed, gate } on honest infra gate (503)
 *
 * Runs a Spindle (Palantir AIP-Logic equivalent) typed function. Two runtimes:
 *
 *  - 'logic' (default): composes the persisted typed-input schema + ordered
 *    steps + typed output into a system prompt and runs ONE grounded turn
 *    against the LIVE Azure OpenAI deployment (data-agent chatGrounded). When an
 *    ontology is bound, the function is GROUNDED on the Weave: the ontology's
 *    entity types + its Lakehouse/Warehouse data bindings are attached as typed
 *    sources, so the model writes real T-SQL/Spark-SQL that the platform runs
 *    read-only and the answer cites real rows.
 *
 *  - 'agent': multi-step tool-calling runtime over the SAME AOAI deployment via
 *    the production copilot-orchestrator. The bound ontology's data sources +
 *    the full Loom tool registry are exposed so the agent can plan, call tools,
 *    and reason over the ontology's data — returning the per-step trace.
 *
 * Azure-native default — no Fabric. Honest gate when no AOAI deployment exists.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig } from '@/lib/azure/data-agent-client';
import { orchestrate, buildDefaultRegistry, type OrchestratorStep, type OrchestratorUsage } from '@/lib/azure/copilot-orchestrator';
import { resolveSpindleGrounding } from '../_spindle-grounding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'aip-logic';
function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

interface AipInput { name: string; type: string; objectType?: string; description?: string; required?: boolean }
interface AipStep { kind: string; name?: string; prompt?: string }

/** Compose the function definition into a strict system prompt. */
function composePrompt(state: Record<string, unknown>): string {
  const inputs = Array.isArray(state.inputs) ? (state.inputs as AipInput[]) : [];
  const steps = Array.isArray(state.steps) ? (state.steps as AipStep[]) : [];
  const outputType = String(state.outputType || 'string');
  const outputDesc = String(state.outputDescription || '');
  const lines: string[] = [];
  lines.push('You are a deterministic typed function (Palantir AIP-Logic equivalent). Execute the ordered steps below and return ONLY the typed output.');
  lines.push('');
  lines.push('Typed inputs:');
  for (const i of inputs) lines.push(`- ${i.name} (${i.type}${i.objectType ? ` of ${i.objectType}` : ''})${i.required ? ' [required]' : ''}${i.description ? `: ${i.description}` : ''}`);
  lines.push('');
  lines.push('Ordered steps:');
  steps.forEach((st, n) => lines.push(`${n + 1}. [${st.kind}] ${st.name || ''}${st.prompt ? ` — ${st.prompt}` : ''}`));
  lines.push('');
  lines.push(`Return a single ${outputType} value as the output${outputDesc ? ` (${outputDesc})` : ''}. Do not include explanations.`);
  return lines.join('\n');
}

const NO_AOAI_GATE = {
  reason: 'Spindle runs against Azure OpenAI.',
  remediation: 'Open the AI Foundry hub → Quota + usage → deploy a model (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric required.',
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the function before invoking (no id yet)', 400, 'no_id');
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return err('aip-logic function not found', 404, 'not_found');
  const body = await req.json().catch(() => ({} as any));
  const inputs = body?.inputs && typeof body.inputs === 'object' ? body.inputs : {};
  const mode: 'logic' | 'agent' = body?.mode === 'agent' ? 'agent' : 'logic';

  const state = (fn.state || {}) as Record<string, unknown>;
  const steps = Array.isArray(state.steps) ? state.steps : [];
  if (steps.length === 0) return err('add at least one step before invoking', 400, 'no_steps');

  // Ground on the bound Weave ontology (entity types + Lakehouse/Warehouse data
  // bindings). Empty when no ontology is bound → ungrounded single-turn path.
  const boundOntologyId = (state.boundOntologyId as string | undefined) || undefined;
  const grounding = await resolveSpindleGrounding(boundOntologyId, s.claims.oid).catch(() => ({ sources: [], surface: null, entityTypes: [] }));
  const systemPrompt = composePrompt(state);
  const userMsg = `Inputs:\n${JSON.stringify(inputs, null, 2)}`;

  // ── Agent mode: multi-step tool-calling over the ontology + Loom tools ──
  if (mode === 'agent') {
    try {
      const registry = buildDefaultRegistry();
      const ontologyContext = grounding.surface
        ? `\n\nYou are grounded on the Weave ontology "${grounding.surface.displayName}". ` +
          `Entity types: ${grounding.entityTypes.join(', ') || '(none)'}. ` +
          `Use the available Loom data tools (Synapse/ADX/ADLS, etc.) to query the data bound to these entity types.`
        : '\n\nNo ontology is bound — answer from the steps alone.';
      const stepsOut: OrchestratorStep[] = [];
      let finalContent = '';
      let model: string | undefined;
      let usage: OrchestratorUsage | undefined;
      for await (const step of orchestrate({
        prompt: `${userMsg}\n\nExecute the function and return only the typed output.`,
        sessionId: `spindle-agent-${id}`,
        userOid: s.claims.oid,
        registryOverride: registry,
        systemPromptOverride: systemPrompt + ontologyContext,
        maxIterations: 8,
      })) {
        stepsOut.push(step);
        if (step.kind === 'final') { finalContent = step.content; model = step.model; usage = step.usage; }
        if (step.kind === 'error') {
          return NextResponse.json({ ok: false, error: step.error, code: step.code, steps: stepsOut }, { status: 502 });
        }
      }
      return NextResponse.json({ ok: true, output: finalContent, model, usage, steps: stepsOut });
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) {
        return NextResponse.json({ ok: false, notDeployed: true, error: e.message, gate: NO_AOAI_GATE }, { status: 503 });
      }
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Logic mode: one grounded turn (sources attached when an ontology is bound) ──
  const cfg: DataAgentConfig = { instructions: systemPrompt, sources: grounding.sources };
  try {
    const answer = await chatGrounded(cfg, [], userMsg);
    return NextResponse.json({
      ok: true,
      output: answer.answer,
      model: answer.model,
      usage: answer.usage,
      sourcesUsed: answer.sourcesAvailable,
      tools: answer.tools,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({ ok: false, notDeployed: true, error: e.message, gate: NO_AOAI_GATE }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
