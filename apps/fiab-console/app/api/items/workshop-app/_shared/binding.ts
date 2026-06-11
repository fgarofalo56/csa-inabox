/**
 * Shared resolution for Atelier (workshop-app) data + write-back routes.
 *
 * An Atelier app binds a Loom Ontology; each ontology entity type is backed by
 * a real Azure-native data source (a Synapse dedicated SQL pool table, recorded
 * on the ontology's state.entityBindings[]). The /data (read) and /run-action
 * (read + write) routes both need the same three things:
 *   1. the app's bound ontology id,
 *   2. the warehouse binding for the requested entity type,
 *   3. a live Synapse target (or an honest infra-gate when env is unset).
 *
 * This module centralizes that so both routes resolve identically. Per
 * .claude/rules/no-fabric-dependency.md the backend is Azure-native (Synapse) by
 * default — nothing here reads a Fabric workspace.
 *
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 */
import { loadOwnedItem } from '../../_lib/item-crud';
import { dedicatedTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import type { OntologyEntityBinding } from '@/lib/editors/_family-utils';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const WORKSHOP_ITEM_TYPE = 'workshop-app';

/** A safe SQL identifier — letters/digits/underscore, max 128, else null. */
export function safeIdent(name: string): string | null {
  return /^[A-Za-z_][\w]{0,127}$/.test(name) ? name : null;
}

/** Resolution result: either a ready Synapse target+table, or an honest gate/error. */
export type BindingResolution =
  | { ok: true; target: SynapseTarget; table: string }
  | { ok: false; status: number; error: string; code: string; gate?: Record<string, unknown> };

/**
 * Resolve the Synapse table + target backing `entityType` for a workshop app.
 * Returns honest 4xx/503 results (never throws for the expected gates) so the
 * caller maps them straight onto a JSON response.
 */
export async function resolveEntityBinding(
  appId: string,
  entityType: string,
  tenantId: string,
): Promise<BindingResolution> {
  const app = await loadOwnedItem(appId, WORKSHOP_ITEM_TYPE, tenantId);
  if (!app) return { ok: false, status: 404, error: 'workshop app not found', code: 'not_found' };

  const boundOntologyId = String(((app.state || {}) as Record<string, unknown>).boundOntologyId || '');
  if (!boundOntologyId) {
    return { ok: false, status: 409, error: 'Bind an ontology to this Atelier app first.', code: 'no_ontology' };
  }

  const onto: WorkspaceItem | null = await loadOwnedItem(boundOntologyId, 'ontology', tenantId);
  if (!onto) return { ok: false, status: 404, error: 'bound ontology not found', code: 'ontology_not_found' };

  const bindings = (((onto.state || {}) as Record<string, unknown>).entityBindings as OntologyEntityBinding[]) || [];
  const binding = bindings.find((b) => (b.entityTypes || []).includes(entityType) && b.sourceKind === 'warehouse');
  if (!binding) {
    return {
      ok: false, status: 409, code: 'no_binding',
      error: `No warehouse data source is bound to entity type "${entityType}" on the ontology.`,
      gate: {
        reason: 'An Atelier component / action reads the warehouse table behind the ontology entity type.',
        remediation: `Open the bound ontology and use "Bind to data source" to map a Warehouse table to ${entityType}.`,
      },
    };
  }

  const table = safeIdent(entityType);
  if (!table) return { ok: false, status: 400, error: 'entity type is not a safe SQL identifier', code: 'bad_ident' };

  let target: SynapseTarget;
  try {
    target = dedicatedTarget();
  } catch (e: unknown) {
    return {
      ok: false, status: 503, code: 'synapse_not_configured',
      error: 'Azure Synapse dedicated SQL pool not configured.',
      gate: {
        reason: 'The Azure-native Atelier backend reads/writes entity rows in the bound Synapse warehouse.',
        remediation: 'Set LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_DB on the Console. No Microsoft Fabric required.',
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }

  return { ok: true, target, table };
}
