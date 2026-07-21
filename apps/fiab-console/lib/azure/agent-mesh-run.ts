/**
 * agent-mesh-run — WS-9 REAL wiring for the Sovereign Agent Mesh runner.
 *
 * Builds the `MeshDeps` the pure `runMeshTask` (agent-mesh.ts) consumes, backed by
 * the actual platform services (no-vaporware.md — no mocks):
 *
 *   - authorize → the structural inter-agent policy (meshInterAgentPolicy, a hard
 *     sovereignty deny) composed with the PDP (lib/auth/pdp authorize()) honoring
 *     `LOOM_PDP_ENFORCE` (shadow logs / enforce blocks / fail-closed on error).
 *   - runAgent  → each agent's REAL Azure-native grounded turn (chatGrounded over
 *     its bound item's sources), with PER-AGENT MCP scoping (scopeMcpServersForAgent)
 *     and EGRESS enforcement (classifyMeshEgress) applied first — on an air-gap
 *     profile every non-air-gap-safe tool is refused (fail-closed) and recorded as
 *     an egress-blocked tool call, so nothing leaves the VNet boundary.
 *   - audit     → one row per hop written to the real `_auditLog` container.
 *
 * Gov AOAI is reached DIRECT on the Gov host (*.openai.azure.us) by the underlying
 * chatGrounded → copilot-orchestrator resolver — no Power BI / Fabric dependency
 * (no-fabric-dependency.md). This module is the impure edge; the pure logic it
 * composes is unit-tested in agent-mesh.test.ts + agent-registry.test.ts.
 */

import type { SessionPayload } from '@/lib/auth/session';
import type { Action, Principal, ResourceRef } from '@/lib/auth/pdp/resource-ref';
import { authorize } from '@/lib/auth/pdp/authorize';
import { pdpEnforceMode } from '@/lib/auth/pdp/enforce';
import { auditLogContainer } from './cosmos-client';
import { chatGrounded, type ChatTurn } from './data-agent-client';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { flowStateToConfig, type AgentFlowState } from './agent-flow-run';
import { listMcpServers } from './mcp-config-store';
import {
  scopeMcpServersForAgent,
  classifyMeshEgress,
  meshInterAgentPolicy,
  type MeshAgentDef,
  type InterAgentPolicyCtx,
} from '@/lib/copilot/agent-registry';
import { meshEgressAllowSuffixes } from './agent-registry-store';
import { runMeshTask, type MeshDeps, type MeshRunResult, type MeshToolCall } from './agent-mesh';

/** Build the PDP Principal from the BFF session (mirrors lib/auth/pdp/enforce.ts). */
function principalFromSession(session: SessionPayload): Principal {
  const c = session.claims;
  return {
    oid: c.oid,
    upn: c.upn || c.email || c.oid,
    groups: c.groups || [],
    tenantId: process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || 'common',
  };
}

/**
 * Compose the inter-agent authorization: the structural sovereignty policy (a hard
 * deny) THEN the PDP (shadow logs, enforce blocks, fail-closed on error). A deny at
 * either layer blocks the hop.
 */
async function meshAuthorize(
  session: SessionPayload,
  caller: MeshAgentDef,
  callee: MeshAgentDef,
  action: Action,
  ctx: InterAgentPolicyCtx,
): Promise<{ effect: 'allow' | 'deny'; reason: string; source?: string }> {
  // 1) Structural sovereignty rule — a deny here is final.
  const structural = meshInterAgentPolicy(caller, callee, ctx);
  if (structural.effect === 'deny') {
    return { effect: 'deny', reason: structural.reason, source: 'mesh-structural' };
  }

  // 2) PDP consult (per LOOM_PDP_ENFORCE).
  const mode = pdpEnforceMode();
  if (mode === 'off') return { effect: 'allow', reason: structural.reason, source: 'mesh-structural' };
  try {
    const principal = principalFromSession(session);
    const resource: ResourceRef = { level: 'item', id: callee.id, itemType: 'mesh-agent' };
    const decision = await authorize(principal, resource, action);
    if (mode === 'enforce' && decision.effect === 'deny') {
      return { effect: 'deny', reason: decision.reason, source: decision.source };
    }
    return {
      effect: 'allow',
      reason: decision.effect === 'allow' ? decision.reason : `PDP shadow: ${decision.reason} (not enforced)`,
      source: decision.source,
    };
  } catch (e: any) {
    if (mode === 'enforce') {
      return { effect: 'deny', reason: 'authorization unavailable — failing closed', source: 'pdp' };
    }
    return { effect: 'allow', reason: `PDP unavailable (shadow): ${e?.message || String(e)}`, source: 'pdp' };
  }
}

/** Resolve an agent's grounded DataAgentConfig from its bound item (best-effort). */
async function agentConfig(agent: MeshAgentDef, oid: string, findings: string[]) {
  let instructions = agent.instructions;
  if (findings.length) {
    instructions +=
      `\n\n## Connected-agent findings (from your mesh peers — reconcile + cite them)\n` +
      findings.join('\n\n');
  }
  let sources: any[] = [];
  if (agent.itemId && agent.itemType) {
    try {
      const item = await loadOwnedItem(agent.itemId, agent.itemType, oid);
      if (item) {
        const state = (item.state || {}) as AgentFlowState;
        const cfg = flowStateToConfig(state);
        instructions = cfg.instructions?.trim() ? `${instructions}\n\n${cfg.instructions}` : instructions;
        sources = cfg.sources || [];
        if (sources.length === 0 && Array.isArray((state as any).sources)) {
          sources = ((state as any).sources as any[])
            .map((sc) => ({
              id: String(sc.id || sc.name || ''),
              type: sc.type,
              name: String(sc.name || ''),
              tables: sc.tables ? String(sc.tables) : undefined,
              instructions: sc.instructions ? String(sc.instructions) : undefined,
            }))
            .filter((sc) => sc.id && sc.type);
        }
      }
    } catch {
      /* bound item unavailable — run on instructions alone (honest, not empty) */
    }
  }
  return { instructions, sources };
}

/**
 * Enforce per-agent MCP scoping + egress and return the tool-call trace. Allowed
 * in-scope servers are recorded as executed in-VNet tool calls; servers refused by
 * the egress profile (air-gap non-air-gap-safe, or a host the profile forbids) are
 * recorded as egress-blocked — NOT called. Real enforcement, not a claim.
 */
async function scopedToolCalls(agent: MeshAgentDef, oid: string): Promise<MeshToolCall[]> {
  const calls: MeshToolCall[] = [];
  // Native, in-VNet tools the agent is scoped to (never egress).
  for (const kind of agent.toolScope) {
    if (kind === 'mcp' || kind === 'openapi' || kind === 'bing-grounding') continue;
    calls.push({ agentId: agent.id, kind, executed: true, detail: 'in-VNet native tool' });
  }
  // Per-agent MCP scope + egress.
  if (agent.mcpServerIds.length) {
    const allow = meshEgressAllowSuffixes();
    let tenantServers: Array<{ name: string; endpoint?: string; catalogId?: string; id?: string }> = [];
    try {
      tenantServers = (await listMcpServers(oid)).map((s: any) => ({
        name: s.name,
        endpoint: s.endpoint,
        catalogId: s.catalogId,
        id: s.id,
      }));
    } catch {
      tenantServers = [];
    }
    const { allowed, blockedByProfile } = scopeMcpServersForAgent(agent, tenantServers);
    for (const b of blockedByProfile) {
      calls.push({
        agentId: agent.id,
        kind: `mcp:${b.server.catalogId || b.server.name}`,
        executed: false,
        egressBlocked: true,
        egressReason: b.reason,
      });
    }
    for (const srv of allowed) {
      let host = '';
      try {
        host = srv.endpoint ? new URL(srv.endpoint).hostname : '';
      } catch {
        host = '';
      }
      const egress = host ? classifyMeshEgress(agent.egressProfile, host, allow) : { allowed: true, reason: 'no external host' };
      calls.push({
        agentId: agent.id,
        kind: `mcp:${srv.catalogId || srv.name}`,
        executed: egress.allowed,
        egressBlocked: egress.allowed ? undefined : true,
        egressReason: egress.allowed ? undefined : egress.reason,
        detail: egress.reason,
      });
    }
  }
  return calls;
}

/** Build the real MeshDeps for a signed-in caller. */
export function buildMeshDeps(session: SessionPayload, ctx: InterAgentPolicyCtx = {}): MeshDeps {
  const oid = session.claims.oid;
  return {
    authorize: (caller, callee, action) => meshAuthorize(session, caller, callee, action, ctx),
    runAgent: async (agent, task, findings) => {
      const toolCalls = await scopedToolCalls(agent, oid);
      const { instructions, sources } = await agentConfig(agent, oid, findings);
      const history: ChatTurn[] = [];
      const answer = await chatGrounded({ instructions, sources }, history, task, { tenantId: oid });
      return { answer: String(answer.answer || ''), toolCalls };
    },
    audit: async (row) => {
      try {
        const c = await auditLogContainer();
        await c.items.create({
          id: `mesh-hop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: row.to,
          tenantId: principalFromSession(session).tenantId,
          who: oid,
          at: row.at,
          timestamp: row.at,
          kind: 'mesh.hop',
          category: 'agent-mesh',
          taskId: row.taskId,
          from: row.from,
          to: row.to,
          action: row.action,
          effect: row.effect,
          reason: row.reason,
        });
      } catch (e) {
        console.error('[mesh:audit] non-fatal audit write error', e);
      }
    },
  };
}

/**
 * Execute a mesh task for a signed-in caller. `agents[0]` is the lead; the rest are
 * members. Returns the full governed trace (policy checks, steps, egress-blocked
 * tool calls, final answer).
 */
export async function executeMeshTask(
  session: SessionPayload,
  agents: MeshAgentDef[],
  task: string,
  ctx: InterAgentPolicyCtx = {},
): Promise<MeshRunResult> {
  const deps = buildMeshDeps(session, ctx);
  return runMeshTask(agents, task, deps);
}
