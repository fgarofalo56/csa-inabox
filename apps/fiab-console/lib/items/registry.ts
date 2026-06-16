/**
 * lib/items/registry.ts
 *
 * Item-type PAIRING rules for the install-time provisioning engine.
 *
 * When a parent item provisions successfully (status 'created' | 'exists'), the
 * engine consults this registry and auto-creates each declared paired item — a
 * real Cosmos item + a real provisioner call — so 1:1 pairings are guaranteed
 * without bundle authors having to list the sibling component by hand.
 *
 * Foundation pairing (no-fabric-dependency.md): every `lakehouse` is paired
 * with a `synapse-serverless-sql-pool` so F3 (lakehouse) and F14 (Serverless
 * SQL editor) share one Synapse Serverless built-in endpoint over the same lake
 * root. The pairing is ALWAYS applied on the Azure-native default path — no env
 * gate; deriveContent simply forwards the parent's abfss root and the paired
 * provisioner gates honestly if it (e.g. on the opt-in Fabric path) is absent.
 */
import type { ProvisionResult, ProvisionerInput } from '@/lib/install/provisioners/types';

export interface PairedItemDef {
  /** Item-type slug of the auto-created sibling. */
  pairedType: string;
  /**
   * Build the sibling's state.content from the parent result + input. Return
   * null to skip creating the sibling entirely (no data to pair on); return an
   * object (possibly with null fields) to create it and let the paired
   * provisioner gate on missing data with its own honest remediation.
   */
  deriveContent: (
    parentResult: ProvisionResult,
    parentInput: ProvisionerInput,
  ) => Record<string, unknown> | null;
  /** Derive the sibling's display name. Defaults to `${displayName} SQL Analytics`. */
  deriveName?: (parentInput: ProvisionerInput) => string;
}

/**
 * Maps parent item type → list of auto-paired item definitions. Consumed by
 * provisioning-engine.ts in a post-provision pass.
 */
export const ITEM_PAIRING_RULES: Record<string, PairedItemDef[]> = {
  lakehouse: [
    {
      pairedType: 'synapse-serverless-sql-pool',
      deriveContent: (result, input) => ({
        adlsRoot: result.secondaryIds?.adlsRoot ?? null,
        lakehouseItemId: input.cosmosItemId,
        lakehouseName: input.displayName,
      }),
      deriveName: (input) => `${input.displayName} SQL Analytics`,
    },
  ],
  // Mirrored database (no-fabric-dependency.md): the Azure-native ADF-CDC backend
  // lands each mirrored table as CSV under the ADLS Bronze container at
  // `mirrors/<workspaceId>/<mirrorId>/<schema>.<table>/`. We pair the mirror 1:1
  // with a `synapse-serverless-sql-pool` so the Bronze Delta/CSV is immediately
  // queryable as T-SQL — the same Serverless built-in endpoint, scoped to a
  // per-mirror user database with one OPENROWSET view per mirrored table.
  //
  // deriveContent returns null on the opt-in Fabric backend (result.secondaryIds
  // has no `adlsRoot` — Fabric manages Bronze as OneLake, which the Synapse MSI
  // can't read), so no pairing occurs and there is no Fabric dependency.
  'mirrored-database': [
    {
      pairedType: 'synapse-serverless-sql-pool',
      deriveContent: (result, input) => {
        // ADF-CDC path emits adlsRoot = abfss://bronze@<acct>.dfs.core.*/mirrors/<wsId>/<mirrorId>.
        const adlsRoot = result.secondaryIds?.adlsRoot ?? null;
        if (!adlsRoot) return null; // Fabric backend / Bronze not configured — honest skip (no pairing).
        const c = (input.content || {}) as Record<string, unknown>;
        const src = (c.source || {}) as Record<string, unknown>;
        // Mirror tables can arrive as `content.source.tables` (string[] like
        // 'dbo.Sales' — bundle shape) or `content.tables` (objects {schema,table}
        // — editor shape). Normalize both to {schema,table}[] so the paired
        // provisioner can emit one OPENROWSET view per mirrored table.
        const rawTables =
          (Array.isArray(src.tables) ? src.tables : undefined) ??
          (Array.isArray((c as any).tables) ? (c as any).tables : []);
        const tables = (rawTables as unknown[])
          .map((t) => {
            if (typeof t === 'string') {
              const parts = t.split('.');
              return parts.length > 1
                ? { schema: parts[0], table: parts.slice(1).join('.') }
                : { schema: 'dbo', table: parts[0] };
            }
            const o = (t || {}) as Record<string, unknown>;
            const table = String(o.table || '').trim();
            return table ? { schema: String(o.schema || 'dbo').trim(), table } : null;
          })
          .filter((t): t is { schema: string; table: string } => !!t && !!t.table && !t.table.endsWith('*'));
        const sanitized =
          String(input.displayName || 'mirror').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'mirror';
        return {
          adlsRoot,
          mirrorItemId: input.cosmosItemId,
          mirrorName: input.displayName,
          // Per-mirror Serverless user database — read back by the SQL-endpoint API.
          database: `loom_mirror_${sanitized}`.slice(0, 128),
          tables,
        };
      },
      deriveName: (input) => `${input.displayName} SQL Analytics`,
    },
  ],
  // Mirrored Databricks (audit H8 + no-fabric-dependency.md): a
  // MirroredAzureDatabricksCatalog mounts a Unity Catalog whose EXTERNAL Delta
  // tables already live in ADLS Gen2. We pair it 1:1 with a
  // `synapse-serverless-sql-pool` so the mounted catalog is QUERYABLE in Loom as
  // T-SQL — one OPENROWSET(...FORMAT='delta') view per UC table over the table's
  // own abfss storage location. This is the Azure-native "shortcut" (the missing
  // mirror half of the item); no Microsoft Fabric / OneLake.
  //
  // The mirrored-databricks provisioner resolves the UC tables + storage
  // locations and stamps them onto result.secondaryIds.ucTablesJson, which
  // deriveContent forwards. deriveContent returns null when Databricks is not
  // configured / the catalog has no resolvable Delta tables (honest skip — the
  // paired provisioner would otherwise have nothing to mount).
  'mirrored-databricks': [
    {
      pairedType: 'synapse-serverless-sql-pool',
      deriveContent: (result, input) => {
        const ucTablesJson = result.secondaryIds?.ucTablesJson;
        if (!ucTablesJson) return null; // Databricks unconfigured / no Delta tables — honest skip.
        let ucTables: Array<{ schema: string; table: string; storageLocation: string; format?: string }> = [];
        try {
          ucTables = JSON.parse(ucTablesJson);
        } catch {
          return null;
        }
        if (!Array.isArray(ucTables) || ucTables.length === 0) return null;
        const c = (input.content || {}) as Record<string, unknown>;
        return {
          databricksMirrorItemId: input.cosmosItemId,
          databricksMirrorName: input.displayName,
          ucCatalogName: (c.catalogName as string) || result.secondaryIds?.catalogName,
          ucTables,
        };
      },
      deriveName: (input) => `${input.displayName} SQL Analytics`,
    },
  ],
  // Data Marketplace (Wave 4): the data-product type is registered so the
  // provisioning engine treats it as a known item. It catalogs into Loom's own
  // Azure-native Cosmos DataProductStore (no Fabric / Purview-unified-catalog
  // dependency) — no auto-paired sibling item in v1.
  'data-product': [],
};
