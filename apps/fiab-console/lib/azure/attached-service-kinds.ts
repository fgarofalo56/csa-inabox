/**
 * attached-service-kinds — the pure vocabulary + mapping layer for the
 * brownfield Landing-Zone Service Registry (Phase 1).
 *
 * A brownfield "attach" takes an EXISTING Azure resource the operator already
 * owns and binds it to a Loom landing zone so it becomes part of Loom (the
 * registry doc; §2.1 of docs/fiab/research/brownfield-attach-design.md). This
 * module is the single source of truth for:
 *
 *   - the closed `AttachedServiceKind` enum (loom_no_freeform_config — never a
 *     free-text service type),
 *   - the ARM resource type ⇄ kind mapping used by discovery + preflight,
 *   - the human label per kind,
 *   - the navigator RBAC role the Console UAMI needs on each kind (the same
 *     role-GUID map `scripts/csa-loom/grant-navigator-rbac.sh` uses for BYO),
 *   - the `scan-services.ts` key ⇄ kind bridge used by the day-0 seed reconcile.
 *
 * It is intentionally FREE of the Azure SDK / cloud-endpoints credential chain
 * so it can be imported by BOTH the server routes AND the client attach wizard,
 * exactly like connectable-types.ts.
 */

/**
 * Every service type Loom can attach from a brownfield tenant. The core set are
 * the `scan-services.ts` keys (day-0 BYO ∪ day-2 attach speak the same
 * vocabulary — §2.6). Closed enum: the wizard offers discovered resources as
 * dropdown picks, never a free-text resource id.
 */
export type AttachedServiceKind =
  | 'synapse'
  | 'adx'
  | 'storage-adls'
  | 'databricks'
  | 'azure-sql'
  | 'cosmos'
  | 'eventhubs'
  | 'adf'
  | 'purview'
  | 'aml'
  | 'ai-search'
  | 'apim'
  | 'stream-analytics'
  | 'aoai'
  | 'maps';

/** The kinds Phase 1 discovers + attaches (Synapse / ADX / storage first, plus
 *  the fuller set the wizard offers). Ordered for a stable discovery grouping. */
export const ATTACHABLE_KINDS: AttachedServiceKind[] = [
  'synapse',
  'adx',
  'storage-adls',
  'databricks',
  'azure-sql',
  'cosmos',
  'eventhubs',
  'adf',
  'purview',
  'aml',
  'ai-search',
  'apim',
  'stream-analytics',
  'aoai',
  'maps',
];

export interface AttachedKindDef {
  kind: AttachedServiceKind;
  /** Human label shown in the picker group / chip. */
  label: string;
  /** Lower-case ARM resource type for the ARG `type in~ (...)` literal. */
  armType: string;
  /**
   * Optional case-insensitive `kind` discriminator on the ARM resource (AOAI is
   * an AIServices-kind Cognitive Services account, distinct from a Maps/other
   * account). Lowercased operand compared to the resource's `kind` field.
   */
  armKindFilter?: string;
  /** item-type-visual slug so tiles/rows reuse the existing icon registry. */
  tileSlug: string;
  /**
   * The built-in role definition GUID the Console UAMI needs on a resource of
   * this kind to drive its navigator — the SAME map `grant-navigator-rbac.sh`
   * uses for BYO reuse. Preflight reports the role name + this scope; Phase 2's
   * role-grant-client PUTs it. `roleName` is the human label for the gate copy.
   */
  roleGuid: string;
  roleName: string;
  /** The `scan-services.ts` key this kind corresponds to (day-0 seed bridge). */
  scanKey?: string;
}

// Built-in Azure role definition GUIDs — kept verbatim in step with
// scripts/csa-loom/grant-navigator-rbac.sh so attach preflight names the exact
// role BYO would grant.
const CONTRIBUTOR = 'b24988ac-6180-42a0-ab88-20f7382dd24c'; // Contributor
const STORAGE_BLOB_DATA_CONTRIB = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'; // Storage Blob Data Contributor
const COSMOS_CONTRIB = '5bd9cd88-fe45-4216-938b-f97437e15450'; // DocumentDB Account Contributor
const EH_DATA_OWNER = 'f526a384-b230-433a-b45c-95f59c4a2dec'; // Azure Event Hubs Data Owner
const ADF_CONTRIB = '673868aa-7521-48a0-acc6-0f60742d39f5'; // Data Factory Contributor
const SEARCH_CONTRIB = '7ca78c08-252a-4471-8644-bb5ff32d4ba0'; // Search Service Contributor
const COG_CONTRIB = '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68'; // Cognitive Services Contributor
const APIM_CONTRIB = '312a565d-c81f-4fd8-895a-4e21e48d571c'; // API Management Service Contributor
const PURVIEW_DATA_SOURCE_ADMIN = '200bba9e-f0c8-430f-892b-6f0794863803'; // Purview Data Source Administrator

/** The kind catalog. armType is what ARG filters on; roleGuid is what preflight
 *  reports (and Phase 2 grants). */
export const ATTACHED_KIND_DEFS: AttachedKindDef[] = [
  { kind: 'synapse',          label: 'Synapse Analytics',      armType: 'microsoft.synapse/workspaces',              tileSlug: 'synapse-serverless-sql-pool', roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: 'synapse' },
  { kind: 'adx',              label: 'Azure Data Explorer',    armType: 'microsoft.kusto/clusters',                  tileSlug: 'kql-database',                roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: 'adx' },
  { kind: 'storage-adls',     label: 'Storage / ADLS Gen2',    armType: 'microsoft.storage/storageaccounts',         tileSlug: 'storage-adls',                roleGuid: STORAGE_BLOB_DATA_CONTRIB, roleName: 'Storage Blob Data Contributor',   scanKey: undefined },
  { kind: 'databricks',       label: 'Azure Databricks',       armType: 'microsoft.databricks/workspaces',           tileSlug: 'databricks-sql-warehouse',    roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: 'databricks' },
  { kind: 'azure-sql',        label: 'Azure SQL',              armType: 'microsoft.sql/servers',                     tileSlug: 'azure-sql-database',          roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: undefined },
  { kind: 'cosmos',           label: 'Cosmos DB',              armType: 'microsoft.documentdb/databaseaccounts',     tileSlug: 'cosmos-account',              roleGuid: COSMOS_CONTRIB,            roleName: 'DocumentDB Account Contributor',  scanKey: 'cosmos' },
  { kind: 'eventhubs',        label: 'Event Hubs',             armType: 'microsoft.eventhub/namespaces',             tileSlug: 'event-hub',                   roleGuid: EH_DATA_OWNER,             roleName: 'Azure Event Hubs Data Owner',     scanKey: 'eventhubs' },
  { kind: 'adf',              label: 'Data Factory',           armType: 'microsoft.datafactory/factories',           tileSlug: 'data-pipeline',               roleGuid: ADF_CONTRIB,               roleName: 'Data Factory Contributor',        scanKey: 'adf' },
  { kind: 'purview',          label: 'Microsoft Purview',      armType: 'microsoft.purview/accounts',                tileSlug: 'purview',                     roleGuid: PURVIEW_DATA_SOURCE_ADMIN, roleName: 'Purview Data Source Administrator', scanKey: 'purview' },
  { kind: 'aml',              label: 'Azure ML',               armType: 'microsoft.machinelearningservices/workspaces', tileSlug: 'ml-model',                 roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: undefined },
  { kind: 'ai-search',        label: 'AI Search',              armType: 'microsoft.search/searchservices',           tileSlug: 'ai-search',                   roleGuid: SEARCH_CONTRIB,            roleName: 'Search Service Contributor',      scanKey: 'aisearch' },
  { kind: 'apim',             label: 'API Management',         armType: 'microsoft.apimanagement/service',           tileSlug: 'apim',                        roleGuid: APIM_CONTRIB,              roleName: 'API Management Service Contributor', scanKey: 'apim' },
  { kind: 'stream-analytics', label: 'Stream Analytics',       armType: 'microsoft.streamanalytics/streamingjobs',   tileSlug: 'stream-analytics-job',        roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: 'streamanalytics' },
  { kind: 'aoai',             label: 'Azure OpenAI / Foundry', armType: 'microsoft.cognitiveservices/accounts',      armKindFilter: 'aiservices', tileSlug: 'ai-foundry',      roleGuid: COG_CONTRIB,               roleName: 'Cognitive Services Contributor',  scanKey: 'foundry' },
  { kind: 'maps',             label: 'Azure Maps',             armType: 'microsoft.maps/accounts',                   tileSlug: 'azure-maps',                  roleGuid: CONTRIBUTOR,               roleName: 'Contributor',                     scanKey: 'maps' },
];

const BY_KIND: Record<string, AttachedKindDef> = Object.fromEntries(
  ATTACHED_KIND_DEFS.map((d) => [d.kind, d]),
);

/** Look up a kind def (undefined for an unknown kind). */
export function getKindDef(kind: string): AttachedKindDef | undefined {
  return BY_KIND[kind];
}

/** Human label for a kind (falls back to the raw kind). */
export function kindLabel(kind: string): string {
  return BY_KIND[kind]?.label ?? kind;
}

/** Type guard for the closed enum. */
export function isAttachedServiceKind(v: unknown): v is AttachedServiceKind {
  return typeof v === 'string' && v in BY_KIND;
}

/**
 * Map a discovered ARM resource (its lower-cased `type` + optional `kind`) to an
 * AttachedServiceKind. The AOAI vs Maps disambiguation is by the ARM `kind`
 * field (AOAI is an `AIServices` Cognitive Services account). Returns null when
 * the ARM type isn't attachable.
 */
export function armTypeToKind(armType: string, armResourceKind?: string): AttachedServiceKind | null {
  const t = (armType || '').toLowerCase();
  const k = (armResourceKind || '').toLowerCase();
  // Cognitive Services accounts split into AOAI (AIServices kind) — any other
  // kind (e.g. a Maps or generic Cognitive account) is not an attach target here.
  const matches = ATTACHED_KIND_DEFS.filter((d) => d.armType === t);
  if (matches.length === 0) return null;
  if (matches.length === 1 && !matches[0].armKindFilter) return matches[0].kind;
  // Multiple defs share this ARM type (Cognitive Services): pick by kind filter.
  const byKind = matches.find((d) => d.armKindFilter && k.includes(d.armKindFilter));
  if (byKind) return byKind.kind;
  // A kind-filtered def exists but the resource kind doesn't match → not a target.
  return matches.find((d) => !d.armKindFilter)?.kind ?? null;
}

/** Every ARM type ARG should query for discovery (deduped). */
export function discoveryArmTypes(): string[] {
  return Array.from(new Set(ATTACHED_KIND_DEFS.map((d) => d.armType)));
}

/** Bridge a `scan-services.ts` key → AttachedServiceKind (day-0 seed reconcile). */
export function scanKeyToKind(scanKey: string): AttachedServiceKind | null {
  return ATTACHED_KIND_DEFS.find((d) => d.scanKey === scanKey)?.kind ?? null;
}
