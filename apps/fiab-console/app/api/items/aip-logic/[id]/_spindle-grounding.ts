/**
 * Spindle ontology-grounding helper.
 *
 * Turns a bound Weave ontology (its parsed classes + Lakehouse/Warehouse data
 * bindings) into the typed DataAgentSource[] that the data-agent runtime
 * (chatGrounded) and the orchestrator can ground on. This is what makes Spindle
 * logic / agents "run against the ontology" — the function's steps execute with
 * the ontology's entity types and the real Synapse-backed data sources attached,
 * so the model writes real T-SQL/Spark-SQL and the platform runs it read-only.
 *
 * 100% Azure-native (Cosmos read + Synapse execution via data-agent-execute).
 * No Fabric workspace required.
 */
import { loadOntologySurface, type OntologySurface } from '../../_lib/palantir-crud';
import type { DataAgentSource } from '@/lib/azure/data-agent-client';

export interface GroundingResult {
  /** Typed sources to attach to the data-agent / orchestrator (may be empty). */
  sources: DataAgentSource[];
  /** The resolved ontology surface (null when no ontology is bound / found). */
  surface: OntologySurface | null;
  /** Entity-type (class) names exposed by the ontology. */
  entityTypes: string[];
}

/**
 * Resolve the grounding sources for an aip-logic function from its bound
 * ontology. When no ontology is bound (or it can't be loaded), returns an empty
 * grounding so the caller falls through to the ungrounded single-turn path.
 */
export async function resolveSpindleGrounding(
  boundOntologyId: string | undefined | null,
  tenantId: string,
): Promise<GroundingResult> {
  if (!boundOntologyId) return { sources: [], surface: null, entityTypes: [] };
  const surface = await loadOntologySurface(boundOntologyId, tenantId);
  if (!surface) return { sources: [], surface: null, entityTypes: [] };

  const entityTypes = surface.classes.map((c) => c.name);
  const classDescById = new Map(surface.classes.map((c) => [c.name.toLowerCase(), c.description || '']));
  const sources: DataAgentSource[] = [];

  // 1) Each Lakehouse/Warehouse data binding becomes a real, queryable source.
  for (const b of surface.bindings || []) {
    const boundClasses = (b.entityTypes || []).filter(Boolean);
    const desc = boundClasses.length
      ? `Materializes ontology entity types: ${boundClasses.join(', ')}.`
      : `Bound ${b.sourceKind} for ontology "${surface.displayName}".`;
    sources.push({
      id: b.sourceItemId,
      type: b.sourceKind, // 'lakehouse' | 'warehouse' — both execute via Synapse
      name: b.sourceDisplayName,
      tables: boundClasses.join(', ') || undefined,
      description: desc,
      instructions:
        `This source holds rows for the following Weave ontology entity types: ` +
        `${boundClasses.map((c) => `${c}${classDescById.get(c.toLowerCase()) ? ` (${classDescById.get(c.toLowerCase())})` : ''}`).join('; ') || '(unmapped)'}. ` +
        `Each entity type corresponds to a physical table/view of the same name.`,
    });
  }

  // 2) Always attach an ontology source describing the full entity surface so
  //    the model understands the semantic layer even when no data is bound yet.
  if (entityTypes.length) {
    sources.push({
      id: surface.id,
      type: 'ontology',
      name: surface.displayName,
      tables: entityTypes.join(', '),
      description: `Weave ontology "${surface.displayName}" — the semantic object model this function reasons over.`,
      instructions:
        `Entity types (objects): ${surface.classes.map((c) => `${c.name}${c.description ? ` — ${c.description}` : ''}`).join('; ')}. ` +
        (surface.links.length
          ? `Links: ${surface.links.map((l) => `${l.from} ${l.kind} ${l.to}`).join('; ')}.`
          : 'No links defined.'),
    });
  }

  return { sources, surface, entityTypes };
}
