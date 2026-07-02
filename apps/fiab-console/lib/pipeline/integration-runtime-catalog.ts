/**
 * integration-runtime-catalog — the structured definition of the three Azure
 * Data Factory / Synapse Integration Runtime (IR) types and the config fields
 * each exposes. This is the single source of truth the
 * `IntegrationRuntimeManager` renders its "New integration runtime" wizard from
 * (pick type → structured form → POST to the BFF), per loom-no-freeform-config:
 * NO JSON textareas — every field is a typed control (dropdown / number /
 * text / boolean) with allowed values, bounds, and helper text.
 *
 * The IR is the compute infrastructure ADF/Synapse use for data movement, data
 * flow execution, activity dispatch, and SSIS package execution. There are
 * exactly three types (grounded in Microsoft Learn
 * https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime):
 *
 *   1. Azure        — fully-managed Azure compute. Auto-resolves its region by
 *                     default ("AutoResolve"), or you pin a region. A managed
 *                     virtual network adds TTL + Spark compute (computeType /
 *                     core count) for data-flow execution and private-endpoint
 *                     access to firewalled stores.
 *   2. Self-Hosted  — a gateway you install on an on-prem machine or VM (or a
 *                     node set) to reach data behind a firewall / private
 *                     network. After creation you register each node with the
 *                     factory using the install (auth) key. Can be SHARED to
 *                     other factories, or LINKED from one.
 *   3. Azure-SSIS   — a managed cluster of Azure VMs that natively executes
 *                     SSIS packages. Scale up via node size, out via node count;
 *                     pick the SQL Server edition + licensing (Azure Hybrid
 *                     Benefit).
 *
 * Field-to-ARM mapping (Microsoft.DataFactory/factories/integrationRuntimes
 * 2018-06-01, see `integrationRuntimeSpecFromForm` below) lives entirely in this
 * file so the manager component stays declarative. The BFF
 * (`/api/items/data-pipeline/[id]/integration-runtimes`) and the factory-level
 * `/api/adf/integration-runtimes` route both call adf-client.upsertIntegrationRuntime
 * with the spec this catalog builds — real ARM REST, no mocks (no-vaporware).
 *
 * NOTE: Synapse pipelines support only the Azure and Self-Hosted IR types
 * (Azure-SSIS is ADF-only) — `irTypesForEngine('synapse')` reflects that.
 */

import type { AdfIntegrationRuntime } from '@/lib/azure/adf-client';
import {
  AZURE_PUBLIC_REGIONS,
  AZURE_USGOV_REGIONS,
  AZURE_USDOD_REGIONS,
  type RegionBoundary,
} from '@/lib/azure/azure-regions';

/**
 * A single structured config field. This mirrors the `ConfigField` shape used
 * by the pipeline connector catalog (a closed enum / bounded number / pattern-
 * constrained text — never freeform JSON) so the same form renderer drives both
 * surfaces. Self-contained here because the IR catalog ships independently.
 */
export interface ConfigField {
  /** Stable key the form value is collected under (and the catalog maps to ARM). */
  key: string;
  /** Control label shown to the operator. */
  label: string;
  /** Which Fluent control to render. */
  type: 'select' | 'number' | 'text' | 'password' | 'boolean';
  /** Allowed options for `select` (value + display label). */
  options?: { value: string; label: string }[];
  /** Bounds for `number` (inclusive). */
  min?: number;
  max?: number;
  /** Default value shown when nothing is entered (also the ARM/portal default). */
  default?: string | number | boolean;
  /** Placeholder for `text` / `password` controls. */
  placeholder?: string;
  /** Regex a `text` value must match (Azure naming / runtime constraint). */
  pattern?: string;
  /** Whether the field must be supplied before the form can submit. */
  required?: boolean;
  /** One-line helper rendered under the control. */
  help?: string;
  /**
   * Render this field only when another field in the same form equals one of
   * these values (e.g. show managed-VNet compute only when `managedVnet` is on).
   */
  showWhen?: { key: string; equals: (string | number | boolean)[] };
}

/** The ARM IR `properties.type` discriminator. Azure-SSIS is also `Managed` on the wire. */
export type IrTypeId = 'azure' | 'self-hosted' | 'azure-ssis';

/** A pipeline-engine flavour — used to scope which IR types are offered. */
export type PipelineEngine = 'adf' | 'synapse';

export interface IntegrationRuntimeType {
  id: IrTypeId;
  /** Display name matching the Azure portal "New integration runtime" tile. */
  title: string;
  /** One-line summary shown on the type-picker card. */
  summary: string;
  /** Longer description for the card body / tooltip. */
  description: string;
  /** Fluent icon name (resolved by the manager to a `@fluentui/react-icons` glyph). */
  icon: 'cloud' | 'gateway' | 'server';
  /** The ARM `properties.type` this maps to. */
  armType: 'Managed' | 'SelfHosted';
  /** True when this IR type is available for the given engine. */
  engines: PipelineEngine[];
  /** The structured config fields rendered for this type. */
  fields: ConfigField[];
  /** Microsoft Learn deep-link for the "Learn more" affordance. */
  learnMoreUrl: string;
}

// ---------------------------------------------------------------------------
// Region options — reuse the boundary-accurate region list (azure-regions) so
// the Azure IR / Azure-SSIS location picker is a CLOSED enum, never freeform.
// "AutoResolve" is prepended for the Azure IR (its default behaviour).
// ---------------------------------------------------------------------------

function regionOptions(boundary: RegionBoundary): { value: string; label: string }[] {
  const list =
    boundary === 'GCC-High' || boundary === 'IL5'
      ? AZURE_USGOV_REGIONS
      : boundary === 'DoD'
        ? AZURE_USDOD_REGIONS
        : AZURE_PUBLIC_REGIONS;
  return list.map((r) => ({ value: r.name, label: r.display }));
}

/** Region options for the Azure IR — AutoResolve first, then the boundary list. */
export function azureIrRegionOptions(boundary: RegionBoundary = 'Commercial'): { value: string; label: string }[] {
  return [{ value: 'AutoResolve', label: 'Auto-resolve (recommended)' }, ...regionOptions(boundary)];
}

/** Region options for the Azure-SSIS IR — an explicit region is required (no AutoResolve). */
export function ssisIrRegionOptions(boundary: RegionBoundary = 'Commercial'): { value: string; label: string }[] {
  return regionOptions(boundary);
}

// ---------------------------------------------------------------------------
// Shared option sets (grounded in Microsoft Learn create-* docs).
// ---------------------------------------------------------------------------

/** Data-flow compute types for a managed-VNet Azure IR (Spark cluster class). */
const DATA_FLOW_COMPUTE_TYPES: { value: string; label: string }[] = [
  { value: 'General', label: 'General purpose' },
  { value: 'MemoryOptimized', label: 'Memory optimized' },
  { value: 'ComputeOptimized', label: 'Compute optimized' },
];

/** Allowed data-flow core counts (Spark cluster sizes ADF exposes). */
const DATA_FLOW_CORE_COUNTS: { value: string; label: string }[] = [
  { value: '8', label: '8 (4+4 driver+worker)' },
  { value: '16', label: '16' },
  { value: '32', label: '32' },
  { value: '48', label: '48' },
  { value: '80', label: '80' },
  { value: '144', label: '144' },
  { value: '272', label: '272' },
];

/**
 * Azure-SSIS node sizes (Standard / D / E series). Standard_E64i_v3 is the
 * compute-isolated size required for IL5/DoD per Learn (azure-secure-isolation).
 */
const SSIS_NODE_SIZES: { value: string; label: string }[] = [
  { value: 'Standard_D2_v3', label: 'Standard_D2_v3 (2 vCPU, 8 GB)' },
  { value: 'Standard_D4_v3', label: 'Standard_D4_v3 (4 vCPU, 16 GB)' },
  { value: 'Standard_D8_v3', label: 'Standard_D8_v3 (8 vCPU, 32 GB)' },
  { value: 'Standard_D16_v3', label: 'Standard_D16_v3 (16 vCPU, 64 GB)' },
  { value: 'Standard_D32_v3', label: 'Standard_D32_v3 (32 vCPU, 128 GB)' },
  { value: 'Standard_D64_v3', label: 'Standard_D64_v3 (64 vCPU, 256 GB)' },
  { value: 'Standard_E2_v3', label: 'Standard_E2_v3 (2 vCPU, 16 GB)' },
  { value: 'Standard_E4_v3', label: 'Standard_E4_v3 (4 vCPU, 32 GB)' },
  { value: 'Standard_E8_v3', label: 'Standard_E8_v3 (8 vCPU, 64 GB)' },
  { value: 'Standard_E16_v3', label: 'Standard_E16_v3 (16 vCPU, 128 GB)' },
  { value: 'Standard_E32_v3', label: 'Standard_E32_v3 (32 vCPU, 256 GB)' },
  { value: 'Standard_E64_v3', label: 'Standard_E64_v3 (64 vCPU, 432 GB)' },
  { value: 'Standard_E64i_v3', label: 'Standard_E64i_v3 (compute-isolated — IL5/DoD)' },
];

const SSIS_EDITIONS: { value: string; label: string }[] = [
  { value: 'Standard', label: 'Standard' },
  { value: 'Enterprise', label: 'Enterprise (advanced features)' },
];

const SSIS_LICENSE_TYPES: { value: string; label: string }[] = [
  { value: 'BasePrice', label: 'Azure Hybrid Benefit — bring your own SQL license (save money)' },
  { value: 'LicenseIncluded', label: 'License included' },
];

// ---------------------------------------------------------------------------
// The catalog.
// ---------------------------------------------------------------------------

export const INTEGRATION_RUNTIME_TYPES: IntegrationRuntimeType[] = [
  {
    id: 'azure',
    title: 'Azure',
    summary: 'Fully-managed Azure compute for data movement, data flows, and activity dispatch.',
    description:
      'A serverless, auto-scaling integration runtime hosted in Azure. By default it auto-resolves the best region for each activity; pin a region for compliance or proximity. Enable a managed virtual network to run mapping data flows on dedicated Spark compute and reach firewalled stores over managed private endpoints.',
    icon: 'cloud',
    armType: 'Managed',
    engines: ['adf', 'synapse'],
    learnMoreUrl: 'https://learn.microsoft.com/azure/data-factory/create-azure-integration-runtime',
    fields: [
      {
        key: 'region',
        label: 'Region',
        type: 'select',
        options: azureIrRegionOptions(),
        default: 'AutoResolve',
        required: true,
        help: 'Auto-resolve picks the region closest to the source/sink per activity. Pin a region to keep compute in a specific geography.',
      },
      {
        key: 'managedVnet',
        label: 'Enable managed virtual network',
        type: 'boolean',
        default: false,
        help: 'Runs data flows on dedicated compute and reaches firewalled data stores over managed private endpoints. Compute is reserved by TTL and cannot auto-scale while TTL is set.',
      },
      {
        key: 'dataFlowComputeType',
        label: 'Data flow compute type',
        type: 'select',
        options: DATA_FLOW_COMPUTE_TYPES,
        default: 'General',
        showWhen: { key: 'managedVnet', equals: [true] },
        help: 'Spark cluster class used to execute mapping data flows on this IR.',
      },
      {
        key: 'dataFlowCoreCount',
        label: 'Data flow core count',
        type: 'select',
        options: DATA_FLOW_CORE_COUNTS,
        default: '8',
        showWhen: { key: 'managedVnet', equals: [true] },
        help: 'Total cores for the data-flow Spark cluster (driver + workers).',
      },
      {
        key: 'timeToLiveMin',
        label: 'Time to live (minutes)',
        type: 'number',
        min: 0,
        max: 1440,
        default: 10,
        showWhen: { key: 'managedVnet', equals: [true] },
        help: 'Keeps the data-flow cluster warm for this many minutes after a run so back-to-back data flows skip cluster startup. 0 disables TTL.',
      },
    ],
  },
  {
    id: 'self-hosted',
    title: 'Self-Hosted',
    summary: 'A gateway you install on-prem or on a VM to reach data behind a firewall or private network.',
    description:
      'Create the self-hosted IR here, then install the Microsoft Integration Runtime on one or more Windows machines and register each node with the factory using the install (auth) key. Use this to copy data from on-premises or private-network sources without Express Route / VPN to a managed VNet. Optionally share this IR to other factories, or link from an existing shared IR.',
    icon: 'gateway',
    armType: 'SelfHosted',
    engines: ['adf', 'synapse'],
    learnMoreUrl: 'https://learn.microsoft.com/azure/data-factory/create-self-hosted-integration-runtime',
    fields: [
      {
        key: 'description',
        label: 'Description',
        type: 'text',
        placeholder: 'e.g. On-prem SQL Server gateway (DC1)',
        help: 'Optional. Describe where the gateway nodes live so operators can find them.',
      },
      {
        key: 'sharingMode',
        label: 'Sharing',
        type: 'select',
        options: [
          { value: 'standalone', label: 'Standalone (this factory only)' },
          { value: 'linked', label: 'Linked — reuse a shared IR from another factory' },
        ],
        default: 'standalone',
        help: 'Standalone installs new gateway nodes. Linked reuses an IR another factory already shares (no new install).',
      },
      {
        key: 'sharedResourceId',
        label: 'Shared IR resource ID',
        type: 'text',
        placeholder: '/subscriptions/.../integrationRuntimes/<shared-ir-name>',
        showWhen: { key: 'sharingMode', equals: ['linked'] },
        pattern: '^/subscriptions/.+/integrationRuntimes/.+$',
        help: 'The ARM resource ID of the shared self-hosted IR to link. The Console identity needs at least Contributor on the source factory.',
      },
      {
        key: 'interactiveAuthoring',
        label: 'Self-contained interactive authoring',
        type: 'boolean',
        default: false,
        showWhen: { key: 'sharingMode', equals: ['standalone'] },
        help: 'Enables test-connection / preview-data authoring when the node cannot reach Azure Relay. Adds a short startup delay on the node.',
      },
    ],
  },
  {
    id: 'azure-ssis',
    title: 'Azure-SSIS',
    summary: 'A managed cluster of Azure VMs that natively executes SQL Server Integration Services packages.',
    description:
      'Lift-and-shift existing SSIS workloads to a fully-managed cluster. Scale up with node size and out with node count, pick the SQL Server edition, and choose Azure Hybrid Benefit to bring your own license. After creation, start the IR to run Execute SSIS Package activities. (Editing/deleting requires the IR to be stopped.)',
    icon: 'server',
    armType: 'SelfHosted', // discriminator only — real ARM type is Managed+ssisProperties (see spec builder)
    engines: ['adf'],
    learnMoreUrl: 'https://learn.microsoft.com/azure/data-factory/create-azure-ssis-integration-runtime',
    fields: [
      {
        key: 'region',
        label: 'Location',
        type: 'select',
        options: ssisIrRegionOptions(),
        default: 'eastus2',
        required: true,
        help: 'Region for the SSIS VM cluster. Use the same region as the database server hosting SSISDB for best performance.',
      },
      {
        key: 'nodeSize',
        label: 'Node size',
        type: 'select',
        options: SSIS_NODE_SIZES,
        default: 'Standard_D4_v3',
        required: true,
        help: 'Scale up. Pick a larger size for compute- or memory-intensive packages. Standard_E64i_v3 is required for IL5/DoD compute isolation.',
      },
      {
        key: 'nodeCount',
        label: 'Node count',
        type: 'number',
        min: 1,
        max: 10,
        default: 1,
        required: true,
        help: 'Scale out. More nodes run more packages in parallel. (Limited by your subscription SSIS vCPU quota.)',
      },
      {
        key: 'maxParallelPerNode',
        label: 'Max parallel executions per node',
        type: 'number',
        min: 1,
        max: 8,
        default: 2,
        help: 'How many packages each node runs concurrently. Raise for many lightweight packages; lower for heavy ones.',
      },
      {
        key: 'edition',
        label: 'Edition',
        type: 'select',
        options: SSIS_EDITIONS,
        default: 'Standard',
        required: true,
        help: 'SQL Server edition. Choose Enterprise for advanced SSIS features.',
      },
      {
        key: 'licenseType',
        label: 'License',
        type: 'select',
        options: SSIS_LICENSE_TYPES,
        default: 'LicenseIncluded',
        required: true,
        help: 'Azure Hybrid Benefit lets you bring your own SQL Server license with Software Assurance to save money.',
      },
      {
        key: 'subnetId',
        label: 'VNet subnet (optional)',
        type: 'text',
        help: 'Join the SSIS cluster to a VNet subnet to reach private data sources. Full ARM resource id of the subnet, or leave blank for public.',
      },
      {
        key: 'useCatalog',
        label: 'Host SSIS catalog (SSISDB)',
        type: 'boolean',
        default: false,
        help: 'Deploy the SSISDB project catalog to an Azure SQL server. Required to deploy and run Integration Services projects.',
      },
      {
        key: 'catalogServerEndpoint',
        label: 'Catalog SQL server',
        type: 'text',
        showWhen: { key: 'useCatalog', equals: [true] },
        help: 'Azure SQL server endpoint that hosts SSISDB, e.g. myserver.database.windows.net.',
      },
      {
        key: 'catalogAdminUser',
        label: 'Catalog admin user',
        type: 'text',
        showWhen: { key: 'useCatalog', equals: [true] },
        help: 'SQL admin username for the SSISDB server.',
      },
      {
        key: 'catalogAdminPassword',
        label: 'Catalog admin password',
        type: 'password',
        showWhen: { key: 'useCatalog', equals: [true] },
        help: 'SQL admin password for the SSISDB server. Stored only in the IR spec sent to ARM.',
      },
      {
        key: 'catalogPricingTier',
        label: 'Catalog pricing tier',
        type: 'select',
        options: [
          { value: 'Basic', label: 'Basic' },
          { value: 'S0', label: 'Standard S0' },
          { value: 'S1', label: 'Standard S1' },
          { value: 'S2', label: 'Standard S2' },
          { value: 'S3', label: 'Standard S3' },
        ],
        default: 'S0',
        showWhen: { key: 'useCatalog', equals: [true] },
        help: 'SSISDB database tier.',
      },
    ],
  },
];

/** Total catalog size (for receipts / tests). */
export const INTEGRATION_RUNTIME_TYPE_COUNT = INTEGRATION_RUNTIME_TYPES.length;

/** Look up an IR type definition by id. */
export function integrationRuntimeType(id: IrTypeId): IntegrationRuntimeType | undefined {
  return INTEGRATION_RUNTIME_TYPES.find((t) => t.id === id);
}

/** The IR types available for a given pipeline engine (Synapse excludes Azure-SSIS). */
export function irTypesForEngine(engine: PipelineEngine): IntegrationRuntimeType[] {
  return INTEGRATION_RUNTIME_TYPES.filter((t) => t.engines.includes(engine));
}

/** Default form values for a type (key → its `default`). */
export function defaultFormValues(id: IrTypeId): Record<string, string | number | boolean> {
  const t = integrationRuntimeType(id);
  const out: Record<string, string | number | boolean> = {};
  for (const f of t?.fields || []) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/** True when a field should render given the current form values (honors showWhen). */
export function fieldVisible(field: ConfigField, values: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.equals.includes(values[field.showWhen.key] as string | number | boolean);
}

/**
 * Validate a form against the catalog. Returns a per-field error map (empty when
 * valid). Only checks VISIBLE fields. Required/min/max/pattern only — the BFF +
 * ARM are the authoritative validators (no-vaporware: this is fast client UX,
 * not a substitute for the real backend).
 */
export function validateForm(
  id: IrTypeId,
  values: Record<string, unknown>,
): Record<string, string> {
  const t = integrationRuntimeType(id);
  const errors: Record<string, string> = {};
  for (const f of t?.fields || []) {
    if (!fieldVisible(f, values)) continue;
    const v = values[f.key];
    const empty = v === undefined || v === null || v === '';
    if (f.required && empty) { errors[f.key] = `${f.label} is required`; continue; }
    if (empty) continue;
    if (f.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) errors[f.key] = `${f.label} must be a number`;
      else if (f.min !== undefined && n < f.min) errors[f.key] = `${f.label} must be ≥ ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `${f.label} must be ≤ ${f.max}`;
    }
    if (f.type === 'text' && f.pattern && typeof v === 'string') {
      try { if (!new RegExp(f.pattern).test(v)) errors[f.key] = `${f.label} has an invalid format`; }
      catch { /* invalid catalog pattern — skip */ }
    }
  }
  return errors;
}

/**
 * Build the real ARM `AdfIntegrationRuntime` spec from a validated form. This is
 * the ONLY place the catalog field keys map to the
 * Microsoft.DataFactory/factories/integrationRuntimes 2018-06-01 shape — keeping
 * the manager + BFF declarative. The result is POSTed to the BFF, which passes
 * it straight to adf-client.upsertIntegrationRuntime (real ARM PUT).
 *
 * Grounded in the ARM template:
 *   - Managed (Azure IR):   typeProperties.computeProperties.{location,
 *                           dataFlowProperties:{computeType,coreCount,timeToLive}}
 *                           + managedVirtualNetwork ref when the managed VNet is on.
 *   - SelfHosted:           typeProperties.{linkedInfo:{authorizationType:'RBAC',
 *                           resourceId} (linked) | selfContainedInteractiveAuthoringEnabled}.
 *   - Azure-SSIS:           Managed + computeProperties.{location,nodeSize,
 *                           numberOfNodes,maxParallelExecutionsPerNode}
 *                           + ssisProperties.{edition,licenseType,catalogInfo?}.
 */
export function integrationRuntimeSpecFromForm(
  id: IrTypeId,
  name: string,
  values: Record<string, unknown>,
): AdfIntegrationRuntime {
  const str = (k: string, dflt = ''): string => {
    const v = values[k];
    return v === undefined || v === null ? dflt : String(v);
  };
  const num = (k: string, dflt: number): number => {
    const n = Number(values[k]);
    return Number.isFinite(n) ? n : dflt;
  };
  const bool = (k: string): boolean => values[k] === true || values[k] === 'true';

  if (id === 'azure') {
    const managedVnet = bool('managedVnet');
    const region = str('region', 'AutoResolve');
    const computeProperties: Record<string, unknown> = {
      location: region,
    };
    if (managedVnet) {
      computeProperties.dataFlowProperties = {
        computeType: str('dataFlowComputeType', 'General'),
        coreCount: num('dataFlowCoreCount', 8),
        timeToLive: num('timeToLiveMin', 10),
      };
    }
    return {
      name,
      properties: {
        type: 'Managed',
        description: str('description') || undefined,
        ...(managedVnet
          ? { managedVirtualNetwork: { referenceName: 'default', type: 'ManagedVirtualNetworkReference' } as unknown }
          : {}),
        typeProperties: { computeProperties },
      } as AdfIntegrationRuntime['properties'],
    };
  }

  if (id === 'self-hosted') {
    const linked = str('sharingMode', 'standalone') === 'linked';
    const typeProperties: Record<string, unknown> = {};
    if (linked) {
      typeProperties.linkedInfo = {
        authorizationType: 'RBAC',
        resourceId: str('sharedResourceId'),
      };
    } else if (bool('interactiveAuthoring')) {
      typeProperties.selfContainedInteractiveAuthoringEnabled = true;
    }
    return {
      name,
      properties: {
        type: 'SelfHosted',
        description: str('description') || undefined,
        ...(Object.keys(typeProperties).length ? { typeProperties } : {}),
      } as AdfIntegrationRuntime['properties'],
    };
  }

  // azure-ssis → ARM "Managed" with computeProperties + ssisProperties.
  const ssisProperties: Record<string, unknown> = {
    edition: str('edition', 'Standard'),
    licenseType: str('licenseType', 'LicenseIncluded'),
  };
  if (bool('useCatalog')) {
    ssisProperties.catalogInfo = {
      catalogServerEndpoint: str('catalogServerEndpoint'),
      catalogAdminUserName: str('catalogAdminUser'),
      ...(str('catalogAdminPassword') ? { catalogAdminPassword: { type: 'SecureString', value: str('catalogAdminPassword') } } : {}),
      catalogPricingTier: str('catalogPricingTier', 'S0'),
    };
  }
  const computeProperties: Record<string, unknown> = {
    location: str('region', 'eastus2'),
    nodeSize: str('nodeSize', 'Standard_D4_v3'),
    numberOfNodes: num('nodeCount', 1),
    maxParallelExecutionsPerNode: num('maxParallelPerNode', 2),
  };
  if (str('subnetId')) {
    computeProperties.vNetProperties = { subnetId: str('subnetId') };
  }
  return {
    name,
    properties: {
      type: 'Managed',
      description: str('description') || undefined,
      typeProperties: { computeProperties, ssisProperties },
    } as AdfIntegrationRuntime['properties'],
  };
}
