/**
 * WS-1.5 — GET /api/foundry/agents/spans?agent=<name>&threadId=<id>
 *
 * Returns the OTel span waterfall for a specific agent thread.
 *
 * Reads the thread record from the loom-agent-memory Cosmos container (existing
 * — no new container) and builds the span tree from its `steps` array using
 * lib/foundry/span-tree. Returns:
 *   { ok: true, root: SpanNode, rollup: SpanTreeRollup }
 *
 * The `root` is the agent-turn root span with all child spans nested inside.
 * The `rollup` carries totalLatencyMs, totalTokens, errorCount, spanCount,
 * and the depth-first flat list for the waterfall renderer.
 *
 * Auth: session required (user's own minted-session cookie — reads own threads).
 * Honest-gated (503) when Cosmos is not configured. No mocks.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listThreads } from '@/lib/azure/agent-memory-client';
import { buildSpanTree, rollupSpanTree } from '@/lib/foundry/span-tree';
import { normalizeUsage } from '@/lib/foundry/agentops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const agent = sp.get('agent')?.trim() || '';
  const threadId = sp.get('threadId')?.trim() || '';

  if (!agent)    return NextResponse.json({ ok: false, error: 'agent is required' }, { status: 400 });
  if (!threadId) return NextResponse.json({ ok: false, error: 'threadId is required' }, { status: 400 });

  try {
    const userOid = session.claims.oid;
    // List the agent's threads and find the requested one.
    const threads = await listThreads(agent, userOid, 50);
    const thread = threads.find((t) => t.threadId === threadId);
    if (!thread) {
      return NextResponse.json({ ok: false, error: 'thread_not_found' }, { status: 404 });
    }

    const usage = normalizeUsage(
      (thread.usage as Record<string, unknown> | null | undefined) ?? null,
    );
    const root = buildSpanTree(
      (thread.steps as unknown[]) as Parameters<typeof buildSpanTree>[0],
      threadId,
      thread.model,
      usage,
    );
    const rollup = rollupSpanTree(root);

    return NextResponse.json({ ok: true, root, rollup });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not_configured') || msg.includes('COSMOS')) {
      return NextResponse.json(
        {
          ok: false,
          error: 'cosmos_not_configured',
          hint: 'Set LOOM_COSMOS_ENDPOINT on the Console app (Admin → Runtime configuration).',
          missing: 'LOOM_COSMOS_ENDPOINT',
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 502 });
  }
}
