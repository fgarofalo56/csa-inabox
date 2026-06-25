/**
 * POST /api/items/copilot-studio-channel/[id]/publish
 *   body: { envId, channelType, config? }
 *   Note: [id] is the agentId (not a channel id) — channels are created per
 *   publish call and keyed off the parent agent.
 *
 * Honest-gate passthrough (round-2). The channel client refuses to fake a
 * "Published" result for channels whose real enablement is an Azure Bot Service
 * / OAuth registration it cannot perform: publishToChannel() throws
 * CopilotStudioError(501) for those — Teams, web chat, Direct Line, Slack,
 * Facebook, and the 'custom' channel (a Direct Line token/endpoint exchange or
 * an Azure Bot relay with a custom adapter, NEVER a msdyn_botchannels insert).
 * This route forwards that status VERBATIM (the catch block below maps
 * CopilotStudioError.status → HTTP status and echoes it in the JSON `status`
 * field) so the editor's ChannelsPanel renders the 501 as a per-channel warning
 * gate — the badge stays "Not published" — instead of a generic error or a fake
 * success. No `msdyn_enabled: true` / "Published" is ever reported off a bare
 * Dataverse insert (no-vaporware).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { publishToChannel, CopilotStudioError } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  if (!body?.channelType) return NextResponse.json({ ok: false, error: 'channelType is required' }, { status: 400 });
  try {
    const channel = await publishToChannel(
      String(body.envId),
      (await ctx.params).id,
      String(body.channelType),
      body.config || {},
    );
    return NextResponse.json({ ok: true, channel });
  } catch (e: any) {
    // Forward the client's status verbatim so honest gates reach the UI intact:
    //  • 501 — channel needs Azure Bot Service / OAuth registration (incl. the
    //    'custom' channel) → ChannelsPanel shows a per-channel warning gate.
    //  • any other CopilotStudioError status (e.g. 503 enablement, 502 schema)
    //    → surfaced as the real cause; non-CopilotStudioError → 502 (bad gateway).
    const status = e instanceof CopilotStudioError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, status }, { status });
  }
}
