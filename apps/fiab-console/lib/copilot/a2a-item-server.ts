/**
 * a2a-item-server — shared wiring for a PUBLISHED Loom agent's own A2A endpoint
 * (WS-5.2). A published data-agent / agent-flow registers as an A2A agent card at
 * `/api/items/<type>/[id]/a2a` and accepts task delegation there — the sibling of
 * its MCP endpoint (data-agent-mcp.ts). This module builds the per-agent card +
 * the A2A server context (execute → the agent's real `ask` backend, Cosmos task
 * store, audit) so the two per-item routes stay thin.
 *
 * The agent exposes ONE skill, `ask-<agent>`, that runs the agent's real grounded
 * chat / flow turn — governed (owner-scoped by the route) + audited. Azure-native;
 * no Fabric.
 */

import {
  buildAgentCard, messageText, type A2aAgentCard, type A2aServerContext,
  type A2aExecuteResult, type A2aTask,
} from './a2a-protocol';
import { agentMcpToolName } from './data-agent-mcp';
import { saveA2aTask, loadA2aTask } from '@/lib/azure/a2a-task-store';
import { auditA2aDelegation } from '@/lib/azure/a2a-audit';

/** The single skill id a published agent exposes over A2A. */
export function agentA2aSkillId(nameOrId: string): string {
  // Reuse the MCP tool-name slug, swapping ask_ → ask- (A2A skill-id convention).
  return agentMcpToolName(nameOrId).replace(/^ask_/, 'ask-');
}

/** Build the per-agent A2A card for a published data-agent / agent-flow. */
export function buildItemAgentCard(opts: {
  name: string;
  description?: string;
  endpoint: string;
  kind: 'data agent' | 'agent flow';
}): A2aAgentCard {
  const skillId = agentA2aSkillId(opts.name);
  return buildAgentCard({
    name: opts.name,
    description: opts.description || `A published CSA Loom ${opts.kind}, delegable over A2A. It answers grounded on its configured backend.`,
    url: opts.endpoint,
    skills: [{
      id: skillId,
      name: `Ask ${opts.name}`,
      description: `Delegate a natural-language task to the "${opts.name}" Loom ${opts.kind}. Send a text part with the request; it runs the ${opts.kind}'s real, governed backend and returns the answer.`,
      tags: [opts.kind === 'agent flow' ? 'agent-flow' : 'data-agent', 'nl-query', 'grounded'],
      examples: [`Ask ${opts.name}: "summarize the latest results"`],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    }],
  });
}

/**
 * Build the A2A server context for a published agent. `ask` runs the agent's real
 * backend for one question; `audit` identifies the delegating caller.
 */
export function buildItemA2aContext(opts: {
  card: A2aAgentCard;
  ask: (question: string) => Promise<string>;
  tenantId: string;
  actorOid: string;
  actorUpn: string;
}): A2aServerContext {
  return {
    agentCard: opts.card,
    execute: async ({ text, message }): Promise<A2aExecuteResult> => {
      const question = text || messageText(message);
      if (!question) return { parts: [{ kind: 'text', text: 'no question was provided' }], state: 'failed', statusText: 'no question was provided' };
      const answer = await opts.ask(question); // throwing → dispatcher marks the task failed
      return { parts: [{ kind: 'text', text: answer }], state: 'completed' };
    },
    saveTask: (task: A2aTask) => saveA2aTask(task, opts.tenantId, opts.actorOid),
    loadTask: (id: string) => loadA2aTask(id, opts.tenantId),
    onAudit: (ev) => auditA2aDelegation({
      actorOid: opts.actorOid, actorUpn: opts.actorUpn, tenantId: opts.tenantId,
      direction: 'inbound', method: ev.method, skillId: ev.skillId,
      taskId: ev.taskId, contextId: ev.contextId, outcome: ev.outcome, detail: ev.detail,
    }),
  };
}
