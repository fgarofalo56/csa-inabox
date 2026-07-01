/**
 * POST /api/items/operations-agent/[id]/run
 *
 * Run / test an operations agent. Two backends — Azure-native by DEFAULT (no
 * Microsoft Fabric, per .claude/rules/no-fabric-dependency.md):
 *
 *  1. Published Foundry agent (when deployed / opt-in): if the agent has been
 *     deployed to the Azure AI Foundry Agent Service (state.foundryAgentId) OR
 *     the caller passes { backend: 'foundry' }, run the published agent
 *     (thread → message → run → poll) and return the real per-tool run STEPS so
 *     an operator can see HOW it answered. Any Foundry failure that means "not
 *     configured / not published" falls back to the Azure-native grounded turn —
 *     the run ALWAYS works without Fabric/Foundry.
 *
 *  2. Azure-native grounded turn (DEFAULT): grounds the question on the agent's
 *     bound eventhouse. Resolves the Eventhouse item → its Azure Data Explorer
 *     (ADX) database, then runs the shared NL→KQL→execute→re-ground loop
 *     (chatGrounded, lib/azure/data-agent-client) — the model proposes KQL, the
 *     platform RUNS it read-only against ADX via lib/azure/kusto-client, and the
 *     final answer is grounded on the real rows. Reasoning uses the same AOAI
 *     deployment as cross-item Copilot (resolveAoaiTarget). Returns the grounded
 *     answer + the tools/queries it ran (with the real rows).
 *
 * Body: { question: string, history?: {role,content}[], backend?: 'foundry' }
 *
 * Honest gates (per .claude/rules/no-vaporware.md):
 *  - No AOAI deployment → 503 { notDeployed, hint }.
 *  - When the caller explicitly opted into Foundry, a non-"not-configured"
 *    Foundry error is surfaced verbatim; otherwise we silently fall back.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  chatGrounded,
  NoAoaiDeploymentError,
  type DataAgentConfig,
  type DataAgentSource,
  type ChatTurn,
} from '@/lib/azure/data-agent-client';
import {
  runAgentAndInspect,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
} from '@/lib/azure/foundry-agent-client';
import { loadKustoItem, resolveDatabase, defaultDatabase } from '@/lib/azure/kusto-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ITEM_TYPE = 'operations-agent';

/**
 * Resolve the ADX (Eventhouse) database backing the agent's `eventhouse`
 * binding. The binding is normally an Eventhouse item id — load it and read its
 * resolved database. A raw database name bound directly is honored. Falls back
 * to the shared default ADX database. Always Azure-native — no Microsoft Fabric.
 */
async function resolveEventhouseDb(binding: string, tenantId: string): Promise<string> {
  const b = (binding || '').trim();
  if (!b) return defaultDatabase();
  for (const type of ['eventhouse', 'kql-database']) {
    try {
      const item = await loadKustoItem(b, type, tenantId);
      if (item) return resolveDatabase(item);
    } catch { /* try the next candidate type */ }
  }
  // A raw ADX database name was bound directly (e.g. "loomdb-default").
  if (/^[A-Za-z0-9_-]+$/.test(b)) return b;
  return defaultDatabase();
}

/**
 * Build the grounded-run config from the ops-agent state. The bound eventhouse
 * becomes a live, executable KQL source (ADX) so answers are grounded on real
 * telemetry rows. The system prompt is the agent's instructions.
 */
function buildConfig(state: Record<string, unknown>, eventhouseDb: string, eventhouseBinding: string): DataAgentConfig {
  const sources: DataAgentSource[] = [];
  if (eventhouseBinding) {
    sources.push({
      id: `eventhouse:${eventhouseBinding}`,
      type: 'kql',
      name: eventhouseDb,
      description: 'Real-time operational telemetry (Eventhouse / Azure Data Explorer) this agent monitors — query recent signals, thresholds, and anomalies here.',
      instructions: '## When asked about\nQuery the most recent operational signals. Alert-worthy thresholds and anomalies live in this Eventhouse.',
    });
  }
  const instructions =
    (typeof state.systemPrompt === 'string' && state.systemPrompt.trim())
      ? state.systemPrompt.trim()
      : 'You monitor real-time operational signals and trigger actions when thresholds are breached.';
  return { instructions, description: 'CSA Loom operations agent', sources };
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
  if (!item) return NextResponse.json({ ok: false, error: 'operations-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const deployedAgent = typeof state.foundryAgentId === 'string' ? state.foundryAgentId.trim() : '';
  const explicitFoundry = body?.backend === 'foundry';

  // ── 1) Published Foundry agent (when deployed / opt-in) ──
  if (deployedAgent) {
    try {
      const insp = await runAgentAndInspect(deployedAgent, question);
      return NextResponse.json({
        ok: true,
        backend: 'foundry-published',
        answer: insp.answer,
        steps: insp.steps,
        runId: insp.runId,
        threadId: insp.threadId,
        status: insp.status,
        usage: insp.usage,
        lastError: insp.lastError,
      });
    } catch (e: any) {
      const notPublished =
        e instanceof FoundryAgentNotConfiguredError ||
        (e instanceof FoundryAgentError && e.status === 404);
      if (!notPublished && explicitFoundry) {
        // Caller explicitly asked for Foundry — surface the real error.
        const status = e instanceof FoundryAgentError ? (e.status || 502) : 502;
        return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
      }
      // Otherwise fall through to the Azure-native grounded turn (no Fabric dep).
    }
  }

  // ── 2) Azure-native grounded turn (DEFAULT) ──
  const eventhouse = typeof state.eventhouse === 'string' ? state.eventhouse.trim() : '';
  const db = eventhouse ? await resolveEventhouseDb(eventhouse, session.claims.oid) : defaultDatabase();
  const cfg = buildConfig(state, db, eventhouse);
  try {
    const ans = await chatGrounded(cfg, history, question);
    return NextResponse.json({ ok: true, backend: 'azure-native-grounded', boundEventhouseDb: eventhouse ? db : undefined, ...ans });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({
        ok: false,
        notDeployed: true,
        error: e.message,
        hint: 'Open the AI Foundry hub editor → "Quota + usage" → Deploy gpt-4o-mini (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). The operations-agent run loop reuses the same AOAI deployment as cross-item Copilot. No Microsoft Fabric required.',
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
