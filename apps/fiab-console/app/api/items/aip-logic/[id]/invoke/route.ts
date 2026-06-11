/**
 * POST /api/items/aip-logic/[id]/invoke
 *   body: { inputs: Record<string, unknown> }
 *   → { ok, output, model, usage? } | { ok:false, notDeployed, gate }
 *
 * Runs the AIP-Logic typed function: composes the persisted typed-input schema +
 * ordered steps + typed output into a system prompt and executes ONE turn
 * against the LIVE Azure OpenAI deployment the Foundry hub resolves (reuses the
 * data-agent chatGrounded path). Azure-native default — no Fabric. Honest gate
 * when no AOAI deployment exists.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig } from '@/lib/azure/data-agent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'aip-logic';
function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

interface AipInput { name: string; type: string; description?: string }
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
  for (const i of inputs) lines.push(`- ${i.name} (${i.type})${i.description ? `: ${i.description}` : ''}`);
  lines.push('');
  lines.push('Ordered steps:');
  steps.forEach((st, n) => lines.push(`${n + 1}. [${st.kind}] ${st.name || ''}${st.prompt ? ` — ${st.prompt}` : ''}`));
  lines.push('');
  lines.push(`Return a single ${outputType} value as the output${outputDesc ? ` (${outputDesc})` : ''}. Do not include explanations.`);
  return lines.join('\n');
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the function before invoking (no id yet)', 400, 'no_id');
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return err('aip-logic function not found', 404, 'not_found');
  const body = await req.json().catch(() => ({} as any));
  const inputs = body?.inputs && typeof body.inputs === 'object' ? body.inputs : {};

  const state = (fn.state || {}) as Record<string, unknown>;
  const steps = Array.isArray(state.steps) ? state.steps : [];
  if (steps.length === 0) return err('add at least one step before invoking', 400, 'no_steps');

  const cfg: DataAgentConfig = { instructions: composePrompt(state), sources: [] };
  const userMsg = `Inputs:\n${JSON.stringify(inputs, null, 2)}`;
  try {
    const answer = await chatGrounded(cfg, [], userMsg);
    return NextResponse.json({ ok: true, output: answer.answer, model: answer.model, usage: answer.usage });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({
        ok: false, notDeployed: true, error: e.message,
        gate: { reason: 'AIP-Logic runs against Azure OpenAI.', remediation: 'Open the AI Foundry hub → Quota + usage → deploy a model (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric required.' },
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
