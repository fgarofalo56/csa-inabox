/**
 * POST /api/items/data-agent/[id]/copilot
 *
 * Data-agent config copilot (AGENT_CONFIG_COPILOT persona). Generates example
 * NL→query pairs + per-field descriptions for ONE bound source, grounded on the
 * source's REAL schema (Synapse SQL / ADX / AI Search), then persists the
 * approved result to the agent config doc in Cosmos.
 *
 * Body: { action: 'schema' | 'generate' | 'apply', sourceId: string, approved?: {...} }
 *   - schema   → { ok, schema?, gate? }            (real schema text; preview only)
 *   - generate → { ok, suggestion?, gate? }        (examples + descriptions; NOT persisted)
 *   - apply    → { ok }                            (writes approved → config doc)
 *
 * No AOAI deployment → 503 + Foundry-hub remediation (per .claude/rules/no-vaporware.md).
 * Unreachable / unconfigured backend → 200 { ok:true, gate } so the UI shows a
 * precise MessageBar, never a dead control.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  fetchSourceSchema,
  generateSuggestions,
  applyToSource,
  NoAoaiDeploymentError,
  type AgentConfigSuggestion,
} from '@/lib/copilot/agent-config-tools';
import type { DataAgentSource } from '@/lib/azure/data-agent-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function findSource(state: Record<string, unknown>, sourceId: string): DataAgentSource | null {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  const s = sources.find((x) => String(x?.id) === String(sourceId));
  if (!s) return null;
  return {
    id: String(s.id || ''),
    type: s.type,
    name: String(s.name || ''),
    tables: s.tables ? String(s.tables) : undefined,
    description: s.description ? String(s.description) : undefined,
    instructions: s.instructions ? String(s.instructions) : undefined,
    examples: Array.isArray(s.examples) ? s.examples : undefined,
  };
}

function notDeployed(e: NoAoaiDeploymentError) {
  return NextResponse.json(
    {
      ok: false,
      notDeployed: true,
      error: e.message,
      hint: 'Open the AI Foundry hub editor → "Quota + usage" → "Deploy gpt-4o-mini" (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). The config copilot reuses the same AOAI deployment as the data-agent test chat.',
    },
    { status: 503 },
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const action = String(body?.action || '').trim();
  const sourceId = String(body?.sourceId || '').trim();
  if (!['schema', 'generate', 'apply'].includes(action)) {
    return NextResponse.json({ ok: false, error: 'action must be one of: schema, generate, apply' }, { status: 400 });
  }
  if (!sourceId) return NextResponse.json({ ok: false, error: 'sourceId required' }, { status: 400 });

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const src = findSource(state, sourceId);
  if (!src) return NextResponse.json({ ok: false, error: 'source not found on this agent' }, { status: 404 });

  try {
    if (action === 'schema') {
      const { schemaText, gate } = await fetchSourceSchema(src);
      return NextResponse.json({ ok: true, schema: schemaText, gate });
    }

    if (action === 'generate') {
      const { schemaText, gate } = await fetchSourceSchema(src);
      if (gate) return NextResponse.json({ ok: true, gate });
      const suggestion = await generateSuggestions(src, schemaText);
      return NextResponse.json({ ok: true, suggestion });
    }

    // action === 'apply'
    const approved = body?.approved as Partial<AgentConfigSuggestion> | undefined;
    if (!approved || (!Array.isArray(approved.examples) && !approved.descriptions)) {
      return NextResponse.json({ ok: false, error: 'approved must include examples and/or descriptions' }, { status: 400 });
    }
    const r = await applyToSource(id, ITEM_TYPE, session.claims.oid, sourceId, approved, state);
    if (!r.ok) return NextResponse.json({ ok: false, error: 'apply failed — item not found or not owned' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) return notDeployed(e);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
