/**
 * POST /api/items/data-agent/[id]/chat
 *
 * Real grounded test-chat for a Loom data agent. Loads the agent's persisted
 * config (instructions + typed sources + per-source grounding + few-shot
 * pairs) from Cosmos, composes a grounded system prompt, and runs one turn
 * against the LIVE AOAI deployment the cross-item Copilot resolves.
 *
 * Body: { question: string, history?: {role, content}[] }
 *
 * No AOAI deployment → 503 + remediation (deploy a model from the Foundry hub
 * "Quota + usage" tab). See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig, type ChatTurn } from '@/lib/azure/data-agent-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function stateToConfig(state: Record<string, unknown>): DataAgentConfig {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  return {
    instructions: String(state.instructions || state.systemPrompt || ''),
    description: state.description ? String(state.description) : undefined,
    sources: sources.map((s) => ({
      id: String(s.id || s.name || ''),
      type: s.type,
      name: String(s.name || ''),
      tables: s.tables ? String(s.tables) : undefined,
      instructions: s.instructions ? String(s.instructions) : undefined,
      examples: Array.isArray(s.examples) ? s.examples : undefined,
    })),
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const question = String(body?.question || '').trim();
  if (!question) return NextResponse.json({ ok: false, error: 'question required' }, { status: 400 });
  const history: ChatTurn[] = Array.isArray(body?.history)
    ? body.history.filter((h: any) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').slice(-10)
    : [];

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const cfg = stateToConfig((item.state || {}) as Record<string, unknown>);

  try {
    const answer = await chatGrounded(cfg, history, question);
    return NextResponse.json({ ok: true, ...answer });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({
        ok: false,
        notDeployed: true,
        error: e.message,
        hint: 'Open the AI Foundry hub editor → "Quota + usage" tab → "Deploy gpt-4o-mini" (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). The data-agent test chat reuses the same AOAI deployment as cross-item Copilot.',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
