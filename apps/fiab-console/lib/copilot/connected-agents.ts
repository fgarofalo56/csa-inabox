/**
 * connected-agents — typed multi-agent composition model (AIF-4).
 *
 * Lets a data-agent reference OTHER Loom agents as sub-agents of an
 * orchestrator. A connection is a structured `SubAgentRef` (typed item picker +
 * role + description), persisted in `state.subAgents[]`. Two real backends
 * consume it:
 *
 *   1. OPT-IN Foundry path — `subAgentToFoundryTool()` maps each ref to the
 *      Azure AI Foundry Agent Service connected-agent tool JSON
 *      ({type:'connected_agent', connected_agent:{id,name,description}}), emitted
 *      into FoundryAgentBody.tools on publish. (Learn: connected agents.)
 *   2. DEFAULT Loom orchestrator path — lib/azure/agent-orchestrator.ts runs
 *      each referenced agent's real grounded chat and synthesizes a final answer
 *      (no Foundry tenant required — Azure-native default).
 *
 * Pure module (no JSX / SDK) so it is unit-tested without the Fluent bundle.
 */

/** Agent item types that can be composed as sub-agents. */
export const SUB_AGENT_ITEM_TYPES = ['data-agent', 'operations-agent'] as const;
export type SubAgentItemType = (typeof SUB_AGENT_ITEM_TYPES)[number];

/** One connected sub-agent of an orchestrator. */
export interface SubAgentRef {
  /** Stable client id (list-key + canvas node id seed). */
  id: string;
  /** The referenced Loom item id. */
  itemId: string;
  /** The referenced Loom item type. */
  itemType: SubAgentItemType;
  /** Display name of the referenced agent (for the picker + canvas + trace). */
  name: string;
  /** Short role the orchestrator plays this agent in (e.g. "finance analyst"). */
  role?: string;
  /** When the orchestrator should delegate to this agent. */
  description?: string;
}

function genId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Construct a new sub-agent reference bound to a picked item. */
export function newSubAgentRef(itemId: string, itemType: SubAgentItemType, name: string): SubAgentRef {
  return { id: genId(), itemId, itemType, name };
}

/** Normalize a persisted `subAgents` value into a clean SubAgentRef[]. */
export function normalizeSubAgents(raw: unknown): SubAgentRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: String(r.id || genId()),
      itemId: String(r.itemId || ''),
      itemType: (SUB_AGENT_ITEM_TYPES as readonly string[]).includes(String(r.itemType))
        ? (r.itemType as SubAgentItemType)
        : 'data-agent',
      name: String(r.name || r.itemId || ''),
      role: r.role ? String(r.role) : undefined,
      description: r.description ? String(r.description) : undefined,
    }))
    .filter((r) => r.itemId);
}

/** True when a connection is bound to a real item (drives the "incomplete" badge). */
export function isSubAgentConfigured(ref: SubAgentRef): boolean {
  return !!ref.itemId;
}

/**
 * Map a sub-agent ref to the Foundry Agent Service connected-agent tool JSON.
 * `agentIdResolver` turns a Loom item id into the published Foundry agent name
 * (the same deterministic name publish uses); returns null when unresolved so a
 * half-bound connection is never emitted.
 */
export function subAgentToFoundryTool(
  ref: SubAgentRef,
  agentIdResolver: (itemId: string, itemType: SubAgentItemType) => string | undefined,
): Record<string, unknown> | null {
  if (!isSubAgentConfigured(ref)) return null;
  const agentId = agentIdResolver(ref.itemId, ref.itemType);
  if (!agentId) return null;
  return {
    type: 'connected_agent',
    connected_agent: {
      id: agentId,
      name: (ref.role || ref.name || agentId).slice(0, 63),
      description: (ref.description || `Delegate to ${ref.name}`).slice(0, 512),
    },
  };
}

/** Map a whole sub-agent list to Foundry connected-agent tools, dropping unresolved. */
export function subAgentsToFoundryTools(
  refs: SubAgentRef[],
  agentIdResolver: (itemId: string, itemType: SubAgentItemType) => string | undefined,
): Array<Record<string, unknown>> {
  return refs
    .map((r) => subAgentToFoundryTool(r, agentIdResolver))
    .filter((t): t is Record<string, unknown> => t !== null);
}

/**
 * Deterministic Foundry agent name for a Loom item — mirrors the publish
 * routes (`loom-data-<id>` / `loom-ops-<id>`) so connected-agent references
 * resolve to the same published agent name without a Foundry round-trip.
 */
export function foundryAgentNameFor(itemId: string, itemType: SubAgentItemType): string {
  const prefix = itemType === 'operations-agent' ? 'loom-ops' : 'loom-data';
  const base = `${prefix}-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `${prefix}-${itemId.slice(0, 8)}`;
}
