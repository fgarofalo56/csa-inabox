/**
 * POST /api/thread/add-data-agent-source — Loom Thread edge.
 *
 * Weaves a sourceable Loom item (warehouse / lakehouse / KQL / semantic-model /
 * AI Search / SQL) into a Data Agent as a grounding source — picking an existing
 * agent or creating a new one. Real Cosmos writes (no mocks); owner-scoped.
 *
 * Body: { from: { id, type, name }, values: { agentId, newAgentName? } }
 *   agentId === '__new__' → create a new data-agent seeded with this source.
 * Returns: { ok, message, link, linkLabel }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, createOwnedItem } from '../../items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Map a source item slug → the data-agent source type its runtime understands. */
const SOURCE_TYPE: Record<string, string> = {
  'warehouse': 'warehouse',
  'synapse-dedicated-sql-pool': 'warehouse',
  'synapse-serverless-sql-pool': 'warehouse',
  'azure-sql-database': 'warehouse',
  'lakehouse': 'lakehouse',
  'kql-database': 'kql',
  'semantic-model': 'semantic-model',
  'ai-search-index': 'ai-search',
};

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as any));
  const from = body?.from || {};
  const agentId = String(body?.values?.agentId || '').trim();
  const newAgentName = String(body?.values?.newAgentName || '').trim();
  if (!from.id || !from.type) return NextResponse.json({ ok: false, error: 'missing source item' }, { status: 400 });
  if (!agentId) return NextResponse.json({ ok: false, error: 'pick a Data Agent (or create a new one)' }, { status: 400 });

  const daType = SOURCE_TYPE[from.type];
  if (!daType) return NextResponse.json({ ok: false, error: `${from.type} can't be a Data Agent source` }, { status: 400 });

  // Load the source item to resolve its real workspace + name (owner-scoped).
  const src = await loadOwnedItem(from.id, from.type, oid);
  if (!src) return NextResponse.json({ ok: false, error: 'source item not found' }, { status: 404 });

  const source = { id: src.id, type: daType, name: from.name || src.displayName };

  // ── Create a brand-new Data Agent seeded with this source ──────────────────
  if (agentId === '__new__') {
    const res = await createOwnedItem(session, 'data-agent', {
      workspaceId: src.workspaceId,
      displayName: newAgentName || `${source.name} agent`,
      state: {
        instructions: `Answer questions grounded in ${source.name}.`,
        sources: [source],
        description: `Auto-created via Thread from ${from.type} "${source.name}".`,
      },
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
    return NextResponse.json({
      ok: true,
      message: `Created Data Agent "${res.item.displayName}" grounded on ${source.name}.`,
      link: `/items/data-agent/${res.item.id}`,
      linkLabel: 'Open the Data Agent',
    });
  }

  // ── Append to an existing Data Agent ───────────────────────────────────────
  const agent = await loadOwnedItem(agentId, 'data-agent', oid);
  if (!agent) return NextResponse.json({ ok: false, error: 'Data Agent not found' }, { status: 404 });
  const state = (agent.state || {}) as Record<string, unknown>;
  const sources = Array.isArray(state.sources) ? [...(state.sources as any[])] : [];
  if (sources.some((s) => s?.id === source.id)) {
    return NextResponse.json({
      ok: true,
      message: `${source.name} is already a source on "${agent.displayName}".`,
      link: `/items/data-agent/${agent.id}`,
      linkLabel: 'Open the Data Agent',
    });
  }
  if (sources.length >= 5) {
    return NextResponse.json({ ok: false, error: `"${agent.displayName}" already has 5 sources (the max).` }, { status: 400 });
  }
  sources.push(source);
  const updated = await updateOwnedItem(agentId, 'data-agent', oid, { state: { ...state, sources } });
  if (!updated) return NextResponse.json({ ok: false, error: 'failed to update the Data Agent' }, { status: 500 });
  return NextResponse.json({
    ok: true,
    message: `Added ${source.name} as a source on "${agent.displayName}".`,
    link: `/items/data-agent/${agent.id}`,
    linkLabel: 'Open the Data Agent',
  });
}
