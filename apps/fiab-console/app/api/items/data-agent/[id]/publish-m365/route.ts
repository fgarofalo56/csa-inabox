/**
 * Publish a Loom data agent to Microsoft 365 Copilot (+ Microsoft Teams).
 *
 * Azure-native (Build 2026 #4 "Publish to Teams and Microsoft 365 Copilot"
 * flow): the agent must already be published to the Foundry Agent Service
 * (POST …/publish). This route wires the M365 surface that the Foundry portal
 * does behind the scenes — an Azure Bot Service registration fronting the
 * Foundry agent endpoint, the MsTeams channel (the M365 Copilot + Teams
 * surface), and a downloadable Teams/M365 app package for org-catalog
 * submission / sideload. No Microsoft Fabric / Power BI dependency.
 *
 * GET  → { ok, configured, foundryPublished, bot? , scope, gate? }
 *        status of the M365 publish (bot registration + readiness).
 *
 * POST { action:'publish', scope?, metadata? }
 *        → ensure Bot Service + enable MsTeams channel + persist m365 state.
 *      { action:'package', metadata? }
 *        → stream the Teams/M365 app package (.zip) as a download.
 *
 * Honest gates (per .claude/rules/no-vaporware.md):
 *  - Agent not yet published to Foundry → 409 with the exact next step.
 *  - Azure prereq missing (LOOM_M365_BOT_APP_ID, subscription, RBAC) → 501 +
 *    a precise remediation; never a mock success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  FoundryAgentNotConfiguredError,
  getProjectId,
  agentMessagingEndpoint,
} from '@/lib/azure/foundry-agent-client';
import {
  ensureBotRegistration,
  enableTeamsChannel,
  getBotRegistration,
  botResourceName,
  buildM365AppPackage,
  M365PublishNotConfiguredError,
  type M365ManifestArgs,
} from '@/lib/azure/m365-copilot-publish';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';
type PublishScope = 'organization' | 'individual';

function notConfigured(e: M365PublishNotConfiguredError) {
  return NextResponse.json(
    { ok: false, deferred: true, error: e.message, hint: e.hint },
    { status: 501 },
  );
}

/** The Foundry agent name a data agent publishes under (matches publish/route.ts). */
function foundryAgentName(itemId: string): string {
  const base = `loom-data-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `loom-data-${itemId.slice(0, 8)}`;
}

interface MetadataIn {
  displayName?: string;
  shortDescription?: string;
  fullDescription?: string;
  developerName?: string;
  version?: string;
  websiteUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
}

function resolveManifestArgs(
  item: WorkspaceItem,
  state: Record<string, unknown>,
  botAppId: string,
  metadata: MetadataIn | undefined,
): M365ManifestArgs {
  const m365 = (state.m365 || {}) as Record<string, unknown>;
  const display = String(metadata?.displayName || m365.displayName || item.displayName || 'Loom data agent');
  const shortDesc = String(
    metadata?.shortDescription || m365.shortDescription || state.description || `${display} — Loom data agent`,
  );
  const fullDesc = String(
    metadata?.fullDescription || m365.fullDescription || state.instructions || state.systemPrompt || shortDesc,
  );
  const developer = String(metadata?.developerName || m365.developerName || 'CSA Loom');
  const version = String(metadata?.version || m365.version || '1.0.0');
  // Stable manifest id (GUID) — reused across republishes so the M365 catalog
  // entry updates in place rather than forking.
  const manifestId = String(m365.manifestId || randomUUID());
  return {
    manifestId,
    botAppId,
    displayName: display,
    shortDescription: shortDesc,
    fullDescription: fullDesc,
    developerName: developer,
    version,
    websiteUrl: metadata?.websiteUrl || (m365.websiteUrl as string) || undefined,
    privacyUrl: metadata?.privacyUrl || (m365.privacyUrl as string) || undefined,
    termsUrl: metadata?.termsUrl || (m365.termsUrl as string) || undefined,
  };
}

async function loadItem(id: string, oid: string): Promise<WorkspaceItem | NextResponse> {
  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });
  return item;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const loaded = await loadItem(id, session.claims.oid);
  if (loaded instanceof NextResponse) return loaded;
  const item = loaded;
  const state = (item.state || {}) as Record<string, unknown>;
  const m365 = (state.m365 || {}) as Record<string, unknown>;
  const foundryPublished = Boolean(state.foundryAgentId);

  const botName = botResourceName(item.id);
  let bot = null;
  let configured = true;
  let gate: string | undefined;
  try {
    bot = await getBotRegistration(botName);
  } catch (e: any) {
    if (e instanceof M365PublishNotConfiguredError) {
      configured = false;
      gate = e.hint;
    } else {
      // Real Azure error (e.g. 403) — surface verbatim, still configured.
      gate = e?.message || String(e);
    }
  }

  return NextResponse.json({
    ok: true,
    configured,
    foundryPublished,
    scope: (m365.scope as PublishScope) || 'organization',
    bot,
    publishedAt: m365.publishedAt || null,
    manifestId: m365.manifestId || null,
    botAppId: process.env.LOOM_M365_BOT_APP_ID || null,
    gate,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'publish').trim();
  const metadata = (body?.metadata || undefined) as MetadataIn | undefined;

  if (!['publish', 'package'].includes(action)) {
    return NextResponse.json({ ok: false, error: 'action must be one of: publish, package' }, { status: 400 });
  }

  const loaded = await loadItem(id, session.claims.oid);
  if (loaded instanceof NextResponse) return loaded;
  const item = loaded;
  const state = (item.state || {}) as Record<string, unknown>;

  // Require a published Foundry agent first — that is what the M365 Bot Service
  // forwards activities to. This is an honest workflow gate, not a Fabric one.
  const agentName = String(state.foundryAgentId || '');
  if (!agentName) {
    return NextResponse.json(
      {
        ok: false,
        needsFoundryPublish: true,
        error: 'Publish this data agent to the Foundry Agent Service first.',
        hint: 'Run the "Publish" action (POST /api/items/data-agent/' + id +
          '/publish) so the agent has a stable Foundry endpoint, then publish to Microsoft 365 Copilot.',
      },
      { status: 409 },
    );
  }

  // ── action: package — stream the Teams/M365 app package as a download. ──
  if (action === 'package') {
    const botAppId = process.env.LOOM_M365_BOT_APP_ID;
    if (!botAppId) {
      return notConfigured(
        new M365PublishNotConfiguredError(
          'LOOM_M365_BOT_APP_ID',
          'Set LOOM_M365_BOT_APP_ID (the bot Entra app client id) before downloading the ' +
            'Microsoft 365 app package — the manifest binds to it as botId.',
        ),
      );
    }
    const manifestArgs = resolveManifestArgs(item, state, botAppId, metadata);
    const pkg = buildM365AppPackage(manifestArgs);
    // Persist the manifest id so a later "publish" reuses the same catalog entry.
    if (!(state.m365 as any)?.manifestId) {
      const now = new Date().toISOString();
      const nextState = { ...state, m365: { ...(state.m365 as object || {}), manifestId: manifestArgs.manifestId } };
      try {
        const items = await itemsContainer();
        await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({ ...item, state: nextState, updatedAt: now });
      } catch { /* download still proceeds even if persist fails */ }
    }
    return new NextResponse(new Uint8Array(pkg.zip), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${pkg.fileName}"`,
      },
    });
  }

  // ── action: publish — ensure Bot Service + enable MsTeams (M365) channel. ──
  const scope: PublishScope = body?.scope === 'individual' ? 'individual' : 'organization';
  const botName = botResourceName(item.id);

  let messagingEndpoint: string;
  let projectId: string;
  try {
    messagingEndpoint = agentMessagingEndpoint(agentName);
    projectId = getProjectId();
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json({ ok: false, deferred: true, error: e.message, hint: e.hint }, { status: 501 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  const display = String(metadata?.displayName || item.displayName || 'Loom data agent');
  const description = String(
    metadata?.shortDescription || state.description || `Loom data agent: ${item.displayName}`,
  );

  try {
    const bot = await ensureBotRegistration({
      botName,
      displayName: display,
      description,
      messagingEndpoint,
    });
    const channel = await enableTeamsChannel(botName);

    const now = new Date().toISOString();
    const botAppId = process.env.LOOM_M365_BOT_APP_ID || bot.msaAppId;
    const manifestArgs = resolveManifestArgs(item, state, botAppId, metadata);
    const nextState: Record<string, unknown> = {
      ...state,
      m365: {
        ...(state.m365 as object || {}),
        manifestId: manifestArgs.manifestId,
        botName: bot.name,
        botId: bot.id,
        botAppId,
        messagingEndpoint,
        teamsChannelEnabled: channel.enabled,
        scope,
        displayName: display,
        shortDescription: description,
        version: manifestArgs.version,
        publishedAt: now,
      },
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item, state: nextState, updatedAt: now,
    });

    return NextResponse.json({
      ok: true,
      bot,
      teamsChannelEnabled: channel.enabled,
      scope,
      manifestId: manifestArgs.manifestId,
      botAppId,
      foundryAgentId: agentName,
      foundryProjectId: projectId,
      publishedAt: now,
      // Next step the operator/admin completes (org scope needs admin approval).
      nextStep: scope === 'organization'
        ? 'Download the app package, then submit it to the Microsoft 365 admin center → Agents → Requests for admin approval, or upload it to the Teams admin center org catalog.'
        : 'Download the app package and sideload it in Teams (Apps → Manage your apps → Upload a custom app) to use the agent yourself.',
      item: resource,
    });
  } catch (e: any) {
    if (e instanceof M365PublishNotConfiguredError) return notConfigured(e);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
