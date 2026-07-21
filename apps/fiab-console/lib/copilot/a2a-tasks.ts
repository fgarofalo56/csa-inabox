/**
 * a2a-tasks — the Loom platform A2A skill catalog (WS-5.2).
 *
 * The platform A2A endpoint (`/api/a2a`) exposes Loom's governed surfaces as
 * delegable A2A **skills** (task types), so an external ADK / Foundry agent can
 * discover them on the agent card and delegate a task in. Each skill maps 1:1 to
 * a REAL, already-governed Loom backend:
 *
 *   - `query-data-agent`     → a published data agent's grounded chat (chatGrounded)
 *   - `run-agent-flow`       → a published agent flow (runAgentFlowTurn)
 *   - `query-ontology-object`→ WS-6 ontology object instances (OSDK read; weave-ontology-store.listObjects)
 *   - `run-ontology-action`  → WS-6 ontology action type write-back (OSDK action; runActionType)
 *
 * "Expose ontology objects/actions/OSDK endpoints as A2A tasks" is exactly the
 * last two skills: the ontology object/action REST endpoints ARE the Loom OSDK
 * data-plane, surfaced here as A2A task types. Each skill declares the structured
 * `data`-part params an A2A client sends (via a DataPart) plus a free-text form.
 *
 * PURE descriptors only — the executor lives in the route (which injects the real
 * backends + the session/PDP/audit governance). Azure-native; no Fabric.
 */

import type { A2aAgentSkill } from './a2a-protocol';
import { buildAgentCard, type A2aAgentCard } from './a2a-protocol';

/** Stable skill ids the platform A2A endpoint routes on. */
export const A2A_SKILL = {
  QUERY_DATA_AGENT: 'query-data-agent',
  RUN_AGENT_FLOW: 'run-agent-flow',
  QUERY_ONTOLOGY_OBJECT: 'query-ontology-object',
  RUN_ONTOLOGY_ACTION: 'run-ontology-action',
} as const;

export type A2aSkillId = (typeof A2A_SKILL)[keyof typeof A2A_SKILL];

/** The A2A skill descriptors advertised on the platform agent card. */
export const PLATFORM_SKILLS: A2aAgentSkill[] = [
  {
    id: A2A_SKILL.QUERY_DATA_AGENT,
    name: 'Query a Loom data agent',
    description:
      'Delegate a natural-language question to a published Loom data agent. Send a text part with the ' +
      'question and a data part { "agentId": "<data-agent item id>" }. Returns the agent\'s grounded answer, ' +
      'governed by the caller\'s Loom permissions.',
    tags: ['data-agent', 'nl-query', 'rag', 'grounded'],
    examples: ['{ "agentId": "da-123" } + "What were Q2 sales by region?"'],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain'],
  },
  {
    id: A2A_SKILL.RUN_AGENT_FLOW,
    name: 'Run a Loom agent flow',
    description:
      'Delegate a task to a published Loom agent flow (multi-agent orchestration with tools, ontology-object ' +
      'nodes, sub-agent handoffs, and guardrails). Send a text part with the request and a data part ' +
      '{ "flowId": "<agent-flow item id>" }. Returns the flow\'s final answer, governed.',
    tags: ['agent-flow', 'orchestration', 'multi-agent'],
    examples: ['{ "flowId": "af-9" } + "Investigate the anomaly in the payments stream"'],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain'],
  },
  {
    id: A2A_SKILL.QUERY_ONTOLOGY_OBJECT,
    name: 'Query ontology object instances (OSDK)',
    description:
      'Read typed instances of a WS-6 ontology object type through the Loom OSDK data-plane. Send a data part ' +
      '{ "ontologyId": "<ontology item id>", "objectType": "<declared object type>", "top": 50 }. Returns the ' +
      'object rows the caller is cleared to see (object-level security enforced server-side).',
    tags: ['ontology', 'osdk', 'objects', 'weave'],
    examples: ['{ "ontologyId": "onto-1", "objectType": "Customer", "top": 25 }'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
  {
    id: A2A_SKILL.RUN_ONTOLOGY_ACTION,
    name: 'Run an ontology action (OSDK write-back)',
    description:
      'Invoke a declared WS-6 ontology action type (create/update/delete write-back) through the Loom OSDK ' +
      'data-plane. Send a data part { "ontologyId": "<id>", "action": "<declared action>", "params": {…}, ' +
      '"reason": "…" }. Enforces object/action security, submission criteria, justification + approval gates, ' +
      'and emits lineage — exactly as the in-product action runner does.',
    tags: ['ontology', 'osdk', 'actions', 'write-back', 'governed'],
    examples: ['{ "ontologyId": "onto-1", "action": "promoteCustomer", "params": { "id": "c-42", "tier": "gold" } }'],
    inputModes: ['application/json'],
    outputModes: ['application/json'],
  },
];

/** True when `id` is a recognized platform skill id. */
export function isPlatformSkill(id: string | undefined): id is A2aSkillId {
  return !!id && PLATFORM_SKILLS.some((s) => s.id === id);
}

/**
 * Infer the skill from the delegated `data` when the client did not name one:
 * a flowId → run-agent-flow, an agentId → query-data-agent, an action → run
 * action, an objectType → query object. Keeps a bare text delegation usable.
 */
export function inferSkillId(data: Record<string, unknown>): A2aSkillId | undefined {
  if (typeof data.flowId === 'string') return A2A_SKILL.RUN_AGENT_FLOW;
  if (typeof data.agentId === 'string') return A2A_SKILL.QUERY_DATA_AGENT;
  if (typeof data.action === 'string') return A2A_SKILL.RUN_ONTOLOGY_ACTION;
  if (typeof data.objectType === 'string') return A2A_SKILL.QUERY_ONTOLOGY_OBJECT;
  return undefined;
}

/**
 * Build the platform-level Loom A2A agent card served at
 * `/.well-known/agent-card.json` (+ the legacy `/.well-known/agent.json`) and by
 * `GET /api/a2a`. `baseUrl` is the deployment origin; the card's JSON-RPC `url`
 * points at `/api/a2a`.
 */
export function buildPlatformAgentCard(baseUrl: string): A2aAgentCard {
  const origin = (baseUrl || '').replace(/\/+$/, '');
  return buildAgentCard({
    name: 'CSA Loom',
    description:
      'CSA Loom exposes its governed data agents, agent flows, and WS-6 ontology objects/actions (OSDK) as ' +
      'delegable A2A tasks. Delegate a task in and receive a result governed by the caller\'s Loom permissions, ' +
      'PDP policy, and audit — Azure-native, sovereign, no Microsoft Fabric dependency.',
    url: `${origin}/api/a2a`,
    documentationUrl: `${origin}/learn`,
    skills: PLATFORM_SKILLS,
  });
}
