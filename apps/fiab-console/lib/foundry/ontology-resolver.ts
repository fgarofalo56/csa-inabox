/**
 * Ontology-Over-Everything (WS-6 / BTB-1) — the resolver service.
 *
 * Given an `OntologyBinding`, resolve the bound source's rows as TYPED INSTANCES
 * of the ontology object type — the substrate join. This is the I/O half of the
 * feature (the pure mapping + query builders live in ontology-binding.ts). Every
 * read hits a REAL Azure backend (no mocks, no `return []`); an unconfigured
 * backend returns an honest `{ gated, code, hint }` naming the exact env var to
 * set (per .claude/rules/no-vaporware.md).
 *
 * Wired source kinds → backend:
 *   - lakehouse-table  → Synapse Serverless SQL over Delta   (executeQuery)
 *   - warehouse-table  → Synapse Dedicated SQL pool          (executeQuery)
 *   - kql              → Azure Data Explorer (ADX)           (kustoExecute)
 *   - semantic-measure → Azure-native DAX (loom-native/AAS)  (evalDax)
 *   - shortcut         → WS-3.2 zero-copy engineObject (Synapse Serverless view /
 *                        Databricks UC table) resolved from the lakehouse-shortcuts
 *                        registry
 *   - azure-sql        → honest-gated this slice (named)
 *
 * The acceptance vertical: a lakehouse table, a KQL stream, and a semantic
 * measure all resolve as typed instances of ONE ontology object type via
 * resolveBindingInstances; resolveOntologyObjectInstances merges bindings from
 * MANY items onto one object type; resolveOntologyObjectForGrounding is the seam
 * the copilot/data-agent grounds through (object → bound sources → query → rows).
 *
 * Azure-native + sovereign (Synapse/ADX/AAS/AGE/UC) — no Fabric, no Power BI.
 */
import type { OntoObjectType } from '@/lib/editors/ontology-model';
import { objectTypeByName, objectTypeNames } from '@/lib/editors/ontology-model';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  serverlessTarget, dedicatedTarget, executeQuery as synapseExecute,
} from '@/lib/azure/synapse-sql-client';
import {
  executeQuery as kustoExecute, defaultDatabase, kustoConfigGate,
} from '@/lib/azure/kusto-client';
import { evalDax, TabularError } from '@/lib/azure/tabular-eval-client';
import { getShortcut } from '@/lib/azure/lakehouse-shortcuts';
import {
  type OntologyBinding, type OntologyBindingSourceKind, type ResolvedInstance,
  type SourceRows, normalizeOntologyBinding, mapRowsToInstances,
  buildSqlSelect, buildKql, buildDax, clampTop, sourceKindLabel,
} from './ontology-binding';

/** An honest-gate outcome — the resolver ran, but a backend/config is missing. */
export interface ResolveGate {
  gated: true;
  code: string;
  hint: string;
  sourceKind: OntologyBindingSourceKind;
}

/** A successful resolution — typed instances from one bound source. */
export interface ResolveSuccess {
  gated: false;
  instances: ResolvedInstance[];
  rowCount: number;
  executedQuery: string;
  sourceKind: OntologyBindingSourceKind;
}

export type ResolveOutcome = ResolveSuccess | ResolveGate;

function gate(sourceKind: OntologyBindingSourceKind, code: string, hint: string): ResolveGate {
  return { gated: true, code, hint, sourceKind };
}

/**
 * Resolve ONE binding to typed instances of its object type against the real
 * backend for its source kind. `ot` is the object type's effective schema (for
 * the column→property coercion); `opts.tenantId` (the caller oid) is required for
 * the owner-scoped semantic-measure (DAX) path.
 */
export async function resolveBindingInstances(
  binding: OntologyBinding,
  ot: OntoObjectType | null,
  opts: { top?: number; tenantId?: string } = {},
): Promise<ResolveOutcome> {
  const top = clampTop(opts.top);
  const { kind } = binding.source;

  try {
    switch (kind) {
      case 'lakehouse-table': {
        if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
          return gate(kind, 'serverless_not_configured',
            'Lakehouse-table resolution reads Delta via the Synapse Serverless SQL endpoint. Set ' +
            'LOOM_SYNAPSE_WORKSPACE (its -ondemand endpoint) and grant the Console UAMI Storage Blob Data Reader.');
        }
        const sql = buildSqlSelect(binding.source.ref, top);
        const res = await synapseExecute(serverlessTarget(binding.source.database || 'master'), sql);
        return ok(binding, ot, res, sql, kind);
      }
      case 'warehouse-table': {
        if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
          return gate(kind, 'warehouse_not_configured',
            'Warehouse-table resolution reads the Synapse Dedicated SQL pool. Set LOOM_SYNAPSE_WORKSPACE + ' +
            'LOOM_SYNAPSE_DEDICATED_POOL and grant the Console UAMI db_datareader.');
        }
        const sql = buildSqlSelect(binding.source.ref, top);
        const res = await synapseExecute(dedicatedTarget(), sql);
        return ok(binding, ot, res, sql, kind);
      }
      case 'kql': {
        const kgate = kustoConfigGate();
        if (kgate) {
          return gate(kind, 'adx_not_configured',
            `KQL-stream resolution reads Azure Data Explorer. Set ${kgate.missing} and grant the Console UAMI ` +
            'AllDatabasesViewer on the ADX cluster.');
        }
        const db = binding.source.database || defaultDatabase();
        const kql = buildKql(binding.source.ref, top);
        const res = await kustoExecute(db, kql);
        return ok(binding, ot, { columns: res.columns, rows: res.rows }, kql, kind);
      }
      case 'semantic-measure': {
        if (!opts.tenantId) {
          return gate(kind, 'no_owner_context',
            'Semantic-measure resolution runs Azure-native DAX owner-scoped; this call lacked the signed-in ' +
            'owner context. Resolve it through an authenticated route (the resolve route / data-agent chat).');
        }
        const modelId = binding.source.sourceItemId || binding.source.ref;
        const dax = buildDax(binding.source.ref, top, binding.source.measure);
        try {
          const res = await evalDax(modelId, dax, opts.tenantId, binding.source.database);
          const columns = res.columns;
          const rows = res.rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c] ?? null));
          return ok(binding, ot, { columns, rows }, dax, kind);
        } catch (e) {
          if (e instanceof TabularError) {
            return gate(kind, 'dax_backend', `Semantic-measure DAX not executed (${e.backend}): ${e.message}`);
          }
          throw e;
        }
      }
      case 'shortcut': {
        // WS-3.2 zero-copy: resolve the engineObject from the registry (or use a
        // literal ref), then SELECT from it on the Synapse Serverless engine.
        let engineObject = binding.source.ref;
        let engine: string | undefined = 'synapse';
        if (binding.source.lakehouseId && binding.source.shortcutId) {
          const sc = await getShortcut(binding.source.lakehouseId, binding.source.shortcutId);
          if (!sc) {
            return gate(kind, 'shortcut_not_found',
              `Shortcut '${binding.source.shortcutId}' was not found in lakehouse '${binding.source.lakehouseId}'. ` +
              'Create the Tables shortcut first (WS-3.2 lakehouse shortcuts).');
          }
          if (!sc.engineObject) {
            return gate(kind, 'shortcut_no_engine',
              `Shortcut '${sc.name}' has no queryable engine object yet (status: ${sc.status}). ` +
              'Only Tables shortcuts registered on a configured engine (Synapse Serverless / Databricks UC) resolve.');
          }
          engineObject = sc.engineObject;
          engine = sc.engine;
        }
        if (engine === 'databricks') {
          return gate(kind, 'shortcut_databricks_unwired',
            'Zero-copy resolution over a Databricks-UC-backed shortcut is not wired this slice; the Synapse ' +
            'Serverless engine (LOOM_SYNAPSE_WORKSPACE) resolves today. Re-create the shortcut on the Synapse engine, ' +
            'or query the UC table via a lakehouse-table binding.');
        }
        if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
          return gate(kind, 'serverless_not_configured',
            'Shortcut resolution queries the Synapse Serverless engine object. Set LOOM_SYNAPSE_WORKSPACE.');
        }
        const sql = buildSqlSelect(engineObject, top);
        const res = await synapseExecute(serverlessTarget('master'), sql);
        return ok(binding, ot, res, sql, kind);
      }
      case 'azure-sql':
        return gate(kind, 'azure_sql_unwired',
          'Azure SQL Database resolution is not wired this slice. Bind the table via a lakehouse-table (Synapse ' +
          'Serverless) or warehouse-table (Synapse Dedicated) source instead — both resolve today.');
      default:
        return gate(kind, 'unknown_kind', `Unknown ontology binding source kind '${kind}'.`);
    }
  } catch (e) {
    // A real backend error (not a documented gate) — surface a sanitized gate so
    // the caller sees an actionable message without leaking driver internals.
    const msg = e instanceof Error ? e.message : String(e);
    return gate(kind, 'resolve_failed',
      `${sourceKindLabel(kind)} resolution failed: ${msg.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

function ok(
  binding: OntologyBinding,
  ot: OntoObjectType | null,
  res: SourceRows,
  executedQuery: string,
  sourceKind: OntologyBindingSourceKind,
): ResolveSuccess {
  const instances = mapRowsToInstances(binding, ot, res);
  return { gated: false, instances, rowCount: instances.length, executedQuery, sourceKind };
}

// ============================================================
// Multi-source resolution onto ONE object type
// ============================================================

/** Per-source resolution result for the resolve route + grounding. */
export interface ResolvedSourceResult {
  /** The bound item id (or 'ontology-datasource' for the ontology's own binding). */
  itemId: string;
  itemName?: string;
  sourceKind: OntologyBindingSourceKind;
  resolved: boolean;
  rowCount: number;
  /** Present when resolved. */
  instances?: ResolvedInstance[];
  /** Present when the source honest-gated. */
  gate?: { code: string; hint: string };
}

/**
 * Resolve MANY bindings (from many items) onto ONE object type and return each
 * source's result plus a merged instance list — the acceptance shape: a
 * lakehouse table, a KQL stream, and a semantic measure all resolve as typed
 * instances of one object. Bindings for OTHER object types are ignored.
 */
export async function resolveOntologyObjectInstances(
  bindings: Array<{ itemId: string; itemName?: string; binding: OntologyBinding }>,
  objectType: string,
  ot: OntoObjectType | null,
  opts: { top?: number; tenantId?: string } = {},
): Promise<{ sources: ResolvedSourceResult[]; instances: ResolvedInstance[] }> {
  const sources: ResolvedSourceResult[] = [];
  const merged: ResolvedInstance[] = [];
  for (const { itemId, itemName, binding } of bindings) {
    if (binding.objectType !== objectType) continue;
    const outcome = await resolveBindingInstances(binding, ot, opts);
    if (outcome.gated) {
      sources.push({ itemId, itemName, sourceKind: outcome.sourceKind, resolved: false, rowCount: 0, gate: { code: outcome.code, hint: outcome.hint } });
    } else {
      sources.push({ itemId, itemName, sourceKind: outcome.sourceKind, resolved: true, rowCount: outcome.rowCount, instances: outcome.instances });
      merged.push(...outcome.instances);
    }
  }
  return { sources, instances: merged };
}

// ============================================================
// Discovery — which items bind to an ontology object type
// ============================================================

/**
 * All items in the ontology's workspace whose `state.ontologyBinding` targets
 * this ontology, PLUS the ontology's own per-object-type datasource (surfaced as
 * a virtual binding). Read-only, tenant-scoped. Returns [] when the caller can't
 * see the ontology's workspace.
 */
export async function discoverOntologyBindings(
  ontology: WorkspaceItem,
): Promise<Array<{ itemId: string; itemName?: string; binding: OntologyBinding }>> {
  const out: Array<{ itemId: string; itemName?: string; binding: OntologyBinding }> = [];
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>(
      {
        query: 'SELECT * FROM c WHERE c.workspaceId = @w AND IS_DEFINED(c.state.ontologyBinding) AND c.state.ontologyBinding.ontologyId = @oid',
        parameters: [
          { name: '@w', value: ontology.workspaceId },
          { name: '@oid', value: ontology.id },
        ],
      },
      { partitionKey: ontology.workspaceId },
    )
    .fetchAll();
  for (const it of resources) {
    const binding = normalizeOntologyBinding((it.state as Record<string, unknown> | undefined)?.ontologyBinding);
    if (binding) out.push({ itemId: it.id, itemName: it.displayName, binding });
  }
  return out;
}

// ============================================================
// Copilot / data-agent grounding seam
// ============================================================

/**
 * Ground a copilot / data-agent turn THROUGH the ontology graph: resolve an
 * ontology object type to its bound sources, query them, and return the typed
 * instances as a flat tabular result the model re-prompts over. This is what
 * "a copilot query grounds through the ontology" means — the model reasons over
 * typed object instances, not raw tables.
 *
 * `tenantId` is the caller oid; the ontology is loaded owner/ACL-scoped (a caller
 * who can't see it gets an honest gate, never another tenant's data).
 */
export async function resolveOntologyObjectForGrounding(
  ontologyId: string,
  objectType: string,
  tenantId: string,
  top = 25,
): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; sources: ResolvedSourceResult[] } | { gate: string }> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: ontologyId }, { name: '@t', value: 'ontology' }],
    })
    .fetchAll();
  const ontology = resources[0];
  if (!ontology) return { gate: `Ontology '${ontologyId}' was not found.` };
  const access = await resolveWorkspaceAccessByOid(tenantId, ontology.workspaceId);
  if (!access) return { gate: `You do not have access to ontology '${ontologyId}'.` };

  const state = (ontology.state || {}) as Record<string, unknown>;
  if (!objectTypeNames(state).has(objectType)) {
    return { gate: `'${objectType}' is not a declared object type on this ontology.` };
  }
  const ot = objectTypeByName(state, objectType);
  const bindings = await discoverOntologyBindings(ontology);
  if (bindings.filter((b) => b.binding.objectType === objectType).length === 0) {
    return { gate: `No item binds to the object type '${objectType}' yet — use the "Bind to ontology" Weave on a lakehouse/KQL/semantic-model to make its rows resolve as ${objectType} instances.` };
  }
  const { sources, instances } = await resolveOntologyObjectInstances(bindings, objectType, ot, { top, tenantId });

  // Flatten typed instances to a stable column set (the declared properties, or
  // the union of resolved property keys when the type declares none).
  const declared = (ot?.properties || []).map((p) => p.apiName);
  const cols = declared.length
    ? ['id', ...declared]
    : ['id', ...Array.from(new Set(instances.flatMap((i) => Object.keys(i.properties))))];
  const rows = instances.map((i) => cols.map((c) => (c === 'id' ? i.id : i.properties[c] ?? null)));
  return { columns: cols, rows, rowCount: instances.length, sources };
}
