/**
 * AIF-13 — AgentOps per-agent cost/latency rollup.
 *   GET /api/foundry/agents/rollup?agent=<name>
 *     → { ok, rollup, runs[] } aggregated over the CALLER's persisted runs for
 *       this agent (Cosmos loom-agent-memory, docType:'thread'). Token counts
 *       are real (live usage); $ cost is an ESTIMATE (rel-T85 list price).
 *
 * Owner-scoped: threads are keyed by the session `oid`, so a caller only ever
 * sees their own runs — no cross-tenant read.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listThreads } from '@/lib/azure/agent-memory-client';
import { rollupAgentRuns, type RunRecordLike } from '@/lib/foundry/agentops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const userOid = session.claims.oid;
  const agent = req.nextUrl.searchParams.get('agent')?.trim();
  if (!agent) return NextResponse.json({ ok: false, error: 'agent (agent name) required' }, { status: 400 });
  try {
    const threads = await listThreads(agent, userOid, 200);
    const records: RunRecordLike[] = threads.map((t) => ({
      status: t.status,
      model: t.model,
      costUsd: t.costUsd,
      latencyMs: t.latencyMs,
      usage: t.usage,
    }));
    const rollup = rollupAgentRuns(agent, records);
    const runs = threads.slice(0, 25).map((t) => ({
      threadId: t.threadId,
      runId: t.runId,
      status: t.status,
      model: t.model,
      costUsd: t.costUsd ?? 0,
      latencyMs: t.latencyMs ?? 0,
      totalTokens: t.usage?.totalTokens ?? 0,
      createdAt: t.createdAt,
    }));
    return NextResponse.json({ ok: true, rollup, runs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
