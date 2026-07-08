/**
 * Index-my-estate wizard — SERVER-SIDE plan resolution (AIF-3).
 *
 * Shared by the `prepare` (preview) and `run` (orchestrate) routes so BOTH derive
 * the connection, embedding target, artifact names, and honest gates from the
 * SAME live-estate resolution — the client never supplies the storage ResourceId
 * or embedding endpoint (security: those are resolved server-side from the item's
 * provisioned Azure coordinates, per no-vaporware.md).
 *
 * Fabric-free: a lakehouse resolves to the internal DLZ ADLS Gen2 root (no
 * OneLake / Fabric workspace). Real backend only.
 */
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { resolveLakehouseAbfss } from './lakehouse-abfss';
import { discoverResourceCoordsByName } from './resource-graph-coords';
import { resolveAoaiTarget } from './copilot-orchestrator';
import { isSearchConfigured } from './search-index-client';
import {
  sourceSupport,
  deriveArtifactNames,
  parseAbfss,
  storageAccountResourceId,
  embeddingDimensions,
  buildFieldMappingTable,
  type IndexableSourceType,
  type SourceColumn,
  type ArtifactNames,
  type SourceSupport,
} from './index-my-data';

export interface EmbeddingTarget {
  resourceUri: string;
  deploymentId: string;
  modelName: string;
  dimensions: number;
}

export interface ResolvedConnection {
  container: string;
  account: string;
  root: string;
  abfss: string;
  storageResourceId: string;
}

export interface IndexPlan {
  ok: boolean;
  /** Set when the item can't be loaded / accessed. */
  notFound?: boolean;
  sourceType: IndexableSourceType;
  itemId: string;
  itemName: string;
  support: SourceSupport;
  names: ArtifactNames;
  embedding: EmbeddingTarget | null;
  embeddingGate: string | null;
  searchConfigured: boolean;
  connection: ResolvedConnection | null;
  connectionGate: string | null;
  tableChoices: string[];
  columns: SourceColumn[];
  fieldMapping: ReturnType<typeof buildFieldMappingTable>;
}

/** Best-effort parse of a lakehouse Delta table's columns from stored DDL/schema. */
export function parseDeltaColumns(t: any): SourceColumn[] {
  if (!t) return [];
  const sch = t.schema;
  if (Array.isArray(sch)) {
    return sch
      .map((c: any) => ({ name: String(c?.name ?? c?.column ?? ''), type: String(c?.type ?? c?.dataType ?? 'string') }))
      .filter((c) => c.name);
  }
  if (typeof sch === 'string' && sch.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(sch);
      if (Array.isArray(arr)) {
        return arr
          .map((c: any) => ({ name: String(c?.name ?? ''), type: String(c?.type ?? 'string') }))
          .filter((c) => c.name);
      }
    } catch { /* fall through */ }
  }
  const ddl = typeof t.ddl === 'string' ? t.ddl : '';
  const paren = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'));
  if (!paren) return [];
  return paren
    .split(',')
    .map((frag: string) => frag.trim())
    .filter(Boolean)
    .map((frag: string) => {
      const m = /^[`"\[]?([A-Za-z0-9_ ]+?)[`"\]]?\s+([A-Za-z0-9_()]+)/.exec(frag);
      return m ? { name: m[1].trim(), type: m[2].trim() } : null;
    })
    .filter((c: SourceColumn | null): c is SourceColumn => !!c && !!c.name);
}

/**
 * Resolve the full plan for a source item. Never throws for an expected gate —
 * it returns the gate string on `embeddingGate` / `connectionGate` so the UI can
 * surface the honest MessageBar. Throws only on an unexpected backend fault.
 */
export async function resolveIndexPlan(opts: {
  sourceType: IndexableSourceType;
  itemId: string;
  tenantId: string;
}): Promise<IndexPlan> {
  const { sourceType, itemId, tenantId } = opts;

  const item = await loadOwnedItem(itemId, sourceType, tenantId, { allowReadRoles: true });
  const support = sourceSupport(sourceType);
  const names = deriveArtifactNames(sourceType, item?.displayName || sourceType, itemId);
  const base: IndexPlan = {
    ok: !!item,
    notFound: !item,
    sourceType,
    itemId,
    itemName: item?.displayName || sourceType,
    support,
    names,
    embedding: null,
    embeddingGate: null,
    searchConfigured: isSearchConfigured(),
    connection: null,
    connectionGate: null,
    tableChoices: [],
    columns: [],
    fieldMapping: [],
  };
  if (!item) return base;

  // Embedding target (Foundry AOAI).
  try {
    const target = await resolveAoaiTarget(null);
    const deploymentId = process.env.LOOM_AOAI_EMBED_DEPLOYMENT || 'text-embedding-3-large';
    const modelName = deploymentId;
    base.embedding = { resourceUri: target.endpoint, deploymentId, modelName, dimensions: embeddingDimensions(modelName) };
  } catch (e: any) {
    base.embeddingGate =
      (e?.message ? String(e.message) : String(e)) ||
      'Azure OpenAI is not configured. Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_EMBED_DEPLOYMENT (a text-embedding-3-* deployment on the Foundry hub).';
  }

  if (sourceType === 'lakehouse') {
    const resolved = await resolveLakehouseAbfss(itemId, item.workspaceId);
    if (!resolved) {
      base.connectionGate =
        'No ADLS Gen2 path resolved for this lakehouse yet. It resolves once the lakehouse is provisioned and ' +
        'requires the internal Data Landing Zone storage to be configured — set LOOM_LANDING_URL (and/or ' +
        'LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL) to the DLZ ADLS Gen2 container URLs the DLZ bicep emits.';
    } else {
      const parts = parseAbfss(resolved.abfss) || { account: '', container: resolved.container, root: resolved.root };
      let sub = process.env.LOOM_SUBSCRIPTION_ID || '';
      let rg = process.env.LOOM_DLZ_RG || '';
      if (parts.account) {
        const coords = await discoverResourceCoordsByName({
          resourceType: 'Microsoft.Storage/storageAccounts',
          name: parts.account,
        }).catch(() => null);
        if (coords) { sub = coords.subscriptionId; rg = coords.resourceGroup; }
      }
      if (!sub || !rg || !parts.account) {
        base.connectionGate =
          `Could not resolve the storage account ARM coordinates for "${parts.account || 'the lakehouse'}". ` +
          'Set LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG, or grant the Console identity Reader on the DLZ subscription.';
      } else {
        base.connection = {
          container: resolved.container,
          account: parts.account,
          root: resolved.root,
          abfss: resolved.abfss,
          storageResourceId: storageAccountResourceId(sub, rg, parts.account),
        };
      }
    }
    const content = (item.state as any)?.content || {};
    const deltaTables = Array.isArray(content.deltaTables) ? content.deltaTables : [];
    base.tableChoices = deltaTables.map((t: any) => String(t?.name || '')).filter(Boolean);
    if (deltaTables.length) base.columns = parseDeltaColumns(deltaTables[0]);
    base.fieldMapping = buildFieldMappingTable(base.columns);
  }

  return base;
}
