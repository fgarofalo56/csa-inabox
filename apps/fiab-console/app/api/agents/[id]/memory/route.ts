/**
 * /api/agents/[id]/memory — the formalized agent-memory service API (B-N14d).
 *
 *   GET    → the memories this caller may see for the agent, scoped to
 *            agent + workspace (+ their own private rows), with the retention
 *            policy in force and the recall block the agent would receive.
 *   POST   → write one or more memories (screened, redacted, retention-stamped,
 *            audited).  `{ memories: [{ content, category?, scope?, tags?,
 *            confidence?, retentionDays?, sourceThreadId? }] }` or a single
 *            `{ content, … }`.
 *   DELETE → `?memoryId=<id>` deletes one memory; `?purge=1[&scope=…]` purges
 *            every memory the caller can see for this agent.
 *
 * Authorization is REAL and two-layered:
 *   1. `withSession` (route-toolkit) requires a signed-in session;
 *   2. `resolveAgent` proves the caller can actually SEE this agent — a
 *      published `data-agent` / `agent-flow` workspace item they hold a role on
 *      (`loadOwnedItem`), or a mesh agent registered in their tenant. The
 *      **workspace dimension of the memory scope is taken from the resolved
 *      agent**, never from the request, so a caller cannot address a sibling
 *      workspace's agent memory even inside their own tenant.
 *
 * Real Cosmos reads/writes; every write attempt (stored or rejected) is
 * audited. Azure-native — no Fabric dependency.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiBadRequest, apiNotFound, apiHonestError } from '@/lib/api/respond';
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { getMeshAgent } from '@/lib/azure/agent-registry-store';
import {
  agentMemoryEnabled,
  agentMemoryRetentionPolicy,
  deleteAgentMemory,
  purgeAgentMemories,
  readAgentMemories,
  writeAgentMemories,
  AGENT_MEMORY_FLAG,
} from '@/lib/azure/agent-memory-service';
import {
  packAgentMemories,
  AGENT_MEMORY_CATEGORIES,
  type AgentMemoryActor,
  type AgentMemoryCandidate,
  type AgentMemoryScope,
} from '@/lib/copilot/agent-memory-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The agent the caller proved access to, plus the workspace it lives in. */
interface ResolvedAgent {
  agentId: string;
  displayName: string;
  kind: 'data-agent' | 'agent-flow' | 'mesh';
  /** Authoritative workspace id ('' for a tenant-level mesh agent). */
  workspaceId: string;
}

/**
 * Prove the caller can see this agent and return its AUTHORITATIVE workspace.
 * Returns null when the agent does not exist or the caller holds no role on it.
 */
async function resolveAgent(agentId: string, session: SessionPayload): Promise<ResolvedAgent | null> {
  const tenantId = tenantScopeId(session);
  for (const kind of ['data-agent', 'agent-flow'] as const) {
    const item = await loadOwnedItem(agentId, kind, tenantId, { allowReadRoles: true }).catch(() => null);
    if (item) {
      return {
        agentId,
        displayName: item.displayName || agentId,
        kind,
        workspaceId: item.workspaceId || '',
      };
    }
  }
  const mesh = await getMeshAgent(tenantId, agentId).catch(() => null);
  if (mesh) return { agentId, displayName: mesh.name || agentId, kind: 'mesh', workspaceId: '' };
  return null;
}

function actorFor(agent: ResolvedAgent, session: SessionPayload): AgentMemoryActor {
  return {
    userOid: session.claims.oid,
    tenantId: tenantScopeId(session),
    workspaceId: agent.workspaceId,
  };
}

function upnFrom(session: SessionPayload): string {
  return session.claims.upn || session.claims.email || session.claims.oid;
}

function parseScope(v: string | null): AgentMemoryScope | undefined {
  if (v === 'agent' || v === 'agent-user') return v;
  return undefined;
}

/** Normalize one untrusted candidate from the request body. */
function toCandidate(raw: unknown): AgentMemoryCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const content = typeof r.content === 'string' ? r.content : '';
  if (!content.trim()) return null;
  const category = AGENT_MEMORY_CATEGORIES.find((c) => c === r.category);
  return {
    content,
    ...(category ? { category } : {}),
    ...(r.scope === 'agent-user' || r.scope === 'agent' ? { scope: r.scope as AgentMemoryScope } : {}),
    ...(typeof r.confidence === 'number' ? { confidence: r.confidence } : {}),
    ...(Array.isArray(r.tags) ? { tags: r.tags.map((t) => String(t)) } : {}),
    ...(typeof r.retentionDays === 'number' ? { retentionDays: r.retentionDays } : {}),
    ...(typeof r.sourceThreadId === 'string' ? { sourceThreadId: r.sourceThreadId } : {}),
  };
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const agentId = (params.id || '').trim();
  if (!agentId) return apiBadRequest('an agent id is required');
  try {
    const agent = await resolveAgent(agentId, session);
    if (!agent) return apiNotFound('agent not found, or you do not have access to it');
    const actor = actorFor(agent, session);
    const policy = agentMemoryRetentionPolicy();
    const enabled = await agentMemoryEnabled();
    const scope = parseScope(req.nextUrl.searchParams.get('scope'));
    const memories = await readAgentMemories(agentId, actor, { scope });
    const packed = packAgentMemories(memories, { topK: policy.topK });
    return apiOk({
      enabled,
      // Honest state when the kill-switch is OFF: the surface still renders the
      // policy + the exact remediation instead of an unexplained empty list.
      ...(enabled
        ? {}
        : {
            notice: {
              intent: 'warning',
              message:
                `Agent memory is switched OFF for this deployment (runtime flag "${AGENT_MEMORY_FLAG}"). ` +
                'Recall returns nothing and new writes are rejected; stored memories are untouched.',
              fixItFlag: AGENT_MEMORY_FLAG,
              fixItHref: '/admin/flags',
            },
          }),
      agent: { id: agent.agentId, name: agent.displayName, kind: agent.kind, workspaceId: agent.workspaceId },
      policy,
      memories,
      recallBlock: packed.block,
      recalledIds: packed.selected.map((m) => m.id),
    });
  } catch (e) {
    return apiHonestError(e, 502, 'could not read agent memory');
  }
});

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const agentId = (params.id || '').trim();
  if (!agentId) return apiBadRequest('an agent id is required');
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return apiBadRequest('a JSON body is required');
  const rawList = Array.isArray(body.memories) ? body.memories : [body];
  const candidates = rawList.map(toCandidate).filter((c): c is AgentMemoryCandidate => c !== null);
  if (!candidates.length) return apiBadRequest('at least one memory with non-empty `content` is required');
  if (candidates.length > 25) return apiBadRequest('at most 25 memories may be written in one call');

  try {
    const agent = await resolveAgent(agentId, session);
    if (!agent) return apiNotFound('agent not found, or you do not have access to it');
    const results = await writeAgentMemories(agentId, candidates, actorFor(agent, session), {
      actorUpn: upnFrom(session),
    });
    const stored = results.filter((r) => r.ok);
    return apiOk({
      agentId,
      stored: stored.length,
      rejected: results.length - stored.length,
      results: results.map((r) => ({
        ok: r.ok,
        id: r.record?.id,
        scope: r.record?.scope,
        expiresAt: r.record?.expiresAt,
        reason: r.reason,
        detail: r.detail,
        flags: r.flags,
        redacted: r.redacted,
      })),
    });
  } catch (e) {
    return apiHonestError(e, 502, 'could not write agent memory');
  }
});

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const agentId = (params.id || '').trim();
  if (!agentId) return apiBadRequest('an agent id is required');
  const memoryId = req.nextUrl.searchParams.get('memoryId')?.trim();
  const purge = req.nextUrl.searchParams.get('purge');
  try {
    const agent = await resolveAgent(agentId, session);
    if (!agent) return apiNotFound('agent not found, or you do not have access to it');
    const actor = actorFor(agent, session);
    const upn = upnFrom(session);
    if (memoryId) {
      const ok = await deleteAgentMemory(agentId, memoryId, actor, { actorUpn: upn });
      if (!ok) return apiNotFound('memory not found in a scope you can address');
      return apiOk({ agentId, deleted: 1 });
    }
    if (purge === '1' || purge === 'true') {
      const scope = parseScope(req.nextUrl.searchParams.get('scope'));
      const deleted = await purgeAgentMemories(agentId, actor, { scope, actorUpn: upn });
      return apiOk({ agentId, deleted, scope: scope || 'all' });
    }
    return apiBadRequest('pass ?memoryId=<id> to delete one memory, or ?purge=1 to purge the scope');
  } catch (e) {
    return apiHonestError(e, 502, 'could not delete agent memory');
  }
});
