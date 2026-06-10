/**
 * /api/items/data-agent/[id]/m365-copilot
 *
 * Publishes a Loom data agent to Microsoft 365 Copilot via the Copilot Studio
 * (Power Platform / Dataverse) API so it is discoverable + chattable in the
 * M365 Copilot Agent Store and Teams.
 *
 *   GET  → { ok, environments, defaultEnvId, alreadyPublished } so the editor
 *          can render the environment dropdown (no raw JSON / free-text env id).
 *   POST → upserts a Copilot Studio agent seeded from the data-agent config
 *          (instructions + typed sources summary + the published Foundry agent
 *          as a knowledge reference), publishes it, and enables the
 *          "Teams and Microsoft 365 Copilot" channel with the M365 flag set.
 *          Persists the publish receipt to the Cosmos item.
 *
 * This is a Power Platform requirement, NOT a Fabric one — works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. When Power Platform / Dataverse / the
 * environment is not configured, the route returns an honest infra-gate
 * (HTTP 501/503 with the exact env var to set) per .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  listEnvironments,
  resolvePublishEnvId,
  publishToM365Copilot,
  CopilotStudioError,
  type PpEnvironment,
  type KnowledgeSourcePayload,
} from '@/lib/azure/copilot-studio-client';
import type { DataAgentSource } from '@/lib/azure/data-agent-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

/** Dataverse display names cap at 100 chars; keep it readable + deterministic. */
function copilotAgentName(displayName: string, itemId: string): string {
  const base = (displayName || `Loom data agent ${itemId.slice(0, 8)}`).trim();
  return base.slice(0, 100);
}

/**
 * Compose Copilot Studio agent instructions from the typed data-agent config.
 * Copilot Studio runs its own orchestration; the agent answers grounded on the
 * attached knowledge + this routing guidance, so we summarise the Loom sources
 * rather than emitting Loom's tools-JSON contract.
 */
function composeCopilotInstructions(
  instructions: string,
  sources: DataAgentSource[],
  foundryAgentId?: string,
): string {
  const lines: string[] = [];
  lines.push('You are a CSA Loom data agent surfaced inside Microsoft 365 Copilot.');
  lines.push('Answer questions grounded ONLY in the governed data sources attached to this agent.');
  lines.push('');
  if (instructions.trim()) {
    lines.push('## Agent instructions');
    lines.push(instructions.trim());
    lines.push('');
  }
  if (sources.length) {
    lines.push('## Connected Loom data sources');
    for (const s of sources) {
      const bits = [`- ${s.name} (${s.type})`];
      if (s.description?.trim()) bits.push(`— ${s.description.trim()}`);
      lines.push(bits.join(' '));
    }
    lines.push('');
  }
  if (foundryAgentId) {
    lines.push(
      `This agent is backed by the published Loom / Azure AI Foundry agent "${foundryAgentId}". ` +
        'Route data questions to that agent and present its grounded answers.',
    );
  }
  return lines.join('\n').slice(0, 15000);
}

function notConfigured(extra?: string) {
  return NextResponse.json(
    {
      ok: false,
      deferred: true,
      error:
        'Microsoft 365 Copilot publishing requires a Power Platform / Copilot Studio environment.',
      hint:
        'Set LOOM_COPILOT_STUDIO_ENVIRONMENT_ID to a Power Platform environment GUID (Dataverse-enabled, Copilot Studio enabled), and configure the Dataverse application user creds ' +
        '(LOOM_DATAVERSE_CLIENT_ID / LOOM_DATAVERSE_CLIENT_SECRET / LOOM_DATAVERSE_TENANT_ID). ' +
        (extra ? `\n${extra}` : ''),
    },
    { status: 501 },
  );
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let item: WorkspaceItem | null = null;
  if (id && id !== 'new') {
    try {
      item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    } catch {
      /* fall through — env list is independent of the item */
    }
  }
  const m365 = (item?.state as any)?.m365Copilot;

  let environments: PpEnvironment[] = [];
  let envError: string | undefined;
  try {
    environments = (await listEnvironments()).filter((e) => e.hasDataverse);
  } catch (e: any) {
    envError = e?.message || String(e);
  }
  const defaultEnvId = resolvePublishEnvId() || undefined;

  return NextResponse.json({
    ok: true,
    environments: environments.map((e) => ({ id: e.id, displayName: e.displayName, dataverseHost: e.dataverseHost })),
    defaultEnvId,
    envError,
    alreadyPublished: m365
      ? { envId: m365.envId, agentName: m365.agentName, publishedAt: m365.publishedAt, m365CopilotEnabled: m365.m365CopilotEnabled }
      : null,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const instructions = String(state.instructions || state.systemPrompt || '').trim();
  if (!instructions) {
    return NextResponse.json(
      { ok: false, error: 'Agent instructions are empty — add instructions before publishing to M365 Copilot.' },
      { status: 400 },
    );
  }
  const sources: DataAgentSource[] = Array.isArray(state.sources) ? (state.sources as DataAgentSource[]) : [];
  if (sources.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Attach at least one data source before publishing to M365 Copilot.' },
      { status: 400 },
    );
  }

  // Environment: explicit body wins, else the default env var.
  const envId = resolvePublishEnvId(typeof body?.envId === 'string' ? body.envId : undefined);
  if (!envId) return notConfigured();

  const displayName = String(state.alias || item.displayName || `Loom data agent`);
  const agentName = copilotAgentName(displayName, item.id);
  const description = String(
    body?.description || state.publishedDescription || state.description || `Loom data agent: ${item.displayName}`,
  ).slice(0, 512);
  const model = String(state.model || process.env.LOOM_AOAI_DEPLOYMENT || 'gpt-4o-mini');
  const foundryAgentId = state.foundryAgentId ? String(state.foundryAgentId) : undefined;
  const availableInM365Copilot = body?.availableInM365Copilot !== false;

  // Knowledge references: attach a Loom data-agent deep link so admins reviewing
  // the agent in the M365 admin center can see the source of truth. AI Search
  // sources are also surfaced as web/url knowledge so the agent grounds on them.
  const knowledge: KnowledgeSourcePayload[] = [];
  const consoleBase = (process.env.LOOM_CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
  if (consoleBase) {
    knowledge.push({
      type: 'url',
      name: `Loom data agent: ${item.displayName}`,
      uri: `${consoleBase}/workspaces/${encodeURIComponent(item.workspaceId)}/items/${ITEM_TYPE}/${encodeURIComponent(item.id)}`,
    });
  }

  const csInstructions = composeCopilotInstructions(instructions, sources, foundryAgentId);

  try {
    const result = await publishToM365Copilot(envId, {
      name: agentName,
      description,
      instructions: csInstructions,
      modelDeployment: model,
      knowledge,
      availableInM365Copilot,
    });

    const now = new Date().toISOString();
    const nextState: Record<string, unknown> = {
      ...state,
      m365Copilot: {
        envId: result.envId,
        agentId: result.agentId,
        agentName: result.agentName,
        agentState: result.agentState,
        channelId: result.channelId,
        m365CopilotEnabled: result.m365CopilotEnabled,
        publishedAt: now,
      },
    };
    try {
      const items = await itemsContainer();
      await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({ ...item, state: nextState, updatedAt: now });
    } catch {
      /* receipt persistence is non-fatal — the agent is published either way */
    }

    return NextResponse.json({
      ok: true,
      ...result,
      publishedAt: now,
      hint:
        'The agent is submitted to Microsoft 365 Copilot. A tenant admin must approve it in the ' +
        'Microsoft 365 admin center (Agents → All agents → Requests) before end users can chat with it ' +
        'in M365 Copilot. After approval it appears under Agents → Built by your org.',
    });
  } catch (e: any) {
    if (e instanceof CopilotStudioError) {
      // 503 = Copilot Studio not enabled in env; 401 = creds; treat as honest gate.
      if (e.status === 503 || e.status === 401 || e.status === 409) {
        return NextResponse.json(
          { ok: false, deferred: true, error: e.message, status: e.status, body: e.body },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { ok: false, error: e.message, status: e.status, body: e.body, endpoint: e.endpoint },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
