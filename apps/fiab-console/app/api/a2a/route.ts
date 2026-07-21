/**
 * /api/a2a — the platform Agent2Agent (A2A) endpoint (WS-5.2).
 *
 *   GET  → the Loom platform agent card (same body as /.well-known/agent-card.json).
 *   POST → JSON-RPC 2.0 A2A task delegation: message/send (+ legacy tasks/send),
 *          tasks/get, tasks/cancel. `message/send` routes the delegated task to a
 *          Loom skill (query-data-agent / run-agent-flow / query-ontology-object /
 *          run-ontology-action) and executes it against the REAL governed backend.
 *
 * Auth: getApiSession — a Console cookie OR a scoped `Authorization: Bearer
 * loom_pat_…` token, so an external ADK / Foundry agent authenticates with a
 * Loom token and delegates a task IN. Every task is owner-scoped to the caller,
 * PDP-checked implicitly by the per-item backends, and AUDITED (durable + SIEM).
 * Azure-native; sovereign; no Microsoft Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession, enforcePatAccess } from '@/lib/auth/api-session';
import { tenantScopeId } from '@/lib/auth/session';
import {
  handleA2aRpc, A2A_ERROR, type A2aServerContext, type A2aTask,
} from '@/lib/copilot/a2a-protocol';
import { buildPlatformAgentCard } from '@/lib/copilot/a2a-tasks';
import { executePlatformSkill } from '@/lib/copilot/a2a-platform-execute';
import { saveA2aTask, loadA2aTask } from '@/lib/azure/a2a-task-store';
import { auditA2aDelegation } from '@/lib/azure/a2a-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function baseUrl(req: NextRequest): string {
  try { return new URL(req.url).origin; } catch { return process.env.LOOM_PUBLIC_BASE_URL || ''; }
}

function rpcErr(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  // The agent card is public discovery metadata (no secrets); serve it openly so
  // an external agent can discover Loom's skills before presenting a token.
  return NextResponse.json(buildPlatformAgentCard(baseUrl(req)));
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return rpcErr(null, A2A_ERROR.PARSE, 'Invalid JSON'); }

  const session = await getApiSession(req);
  if (!session) {
    return rpcErr(
      Array.isArray(body) ? null : body?.id,
      A2A_ERROR.INVALID_REQUEST,
      'unauthenticated — present a Console session cookie or an Authorization: Bearer loom_pat_… token',
      401,
    );
  }
  // A read-only PAT may call tasks/get but not delegate work (message/send writes).
  const patBlock = enforcePatAccess(session, req.method || 'POST');
  if (patBlock) return patBlock;

  const tenantId = tenantScopeId(session);
  const ctx: A2aServerContext = {
    agentCard: buildPlatformAgentCard(baseUrl(req)),
    execute: (input) => executePlatformSkill(session, input),
    saveTask: (task: A2aTask) => saveA2aTask(task, tenantId, session.claims.oid),
    loadTask: (id: string) => loadA2aTask(id, tenantId),
    onAudit: (ev) => auditA2aDelegation({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.email || session.claims.oid,
      tenantId,
      direction: 'inbound',
      method: ev.method,
      skillId: ev.skillId,
      taskId: ev.taskId,
      contextId: ev.contextId,
      outcome: ev.outcome,
      detail: ev.detail,
    }),
  };

  if (Array.isArray(body)) {
    const out = [];
    for (const single of body) out.push(await handleA2aRpc(single, ctx));
    return NextResponse.json(out);
  }

  const { jsonrpc, id, method } = body || {};
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcErr(id, A2A_ERROR.INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request with a method');
  }
  const res = await handleA2aRpc(body, ctx);
  return NextResponse.json(res);
}
