/**
 * Phase 2 — shared types for the install-time provisioning engine.
 *
 * Each provisioner takes:
 *   - the Cosmos item that was just created by createOwnedItem(),
 *   - the bundle content stamped onto state.content,
 *   - the deployment mode (shared vs dedicated),
 *   - a target descriptor that resolves which Fabric workspace / ADX
 *     database / Synapse server / etc. to provision against.
 *
 * And returns a structured result that includes either the live resource
 * id(s) created in Azure, or a remediation envelope explaining exactly
 * what the tenant admin must do to unblock the next attempt.
 *
 * Per .claude/rules/no-vaporware.md, every provisioner calls REAL Azure
 * REST. There are no mock branches in the production path — only the
 * environment / authorization gates that surface as structured remediation
 * when the surrounding tenant config is not in place yet.
 */
import type { SessionPayload } from '@/lib/auth/session';

export type ProvisionerSession = SessionPayload;

/** What this Phase 2 install creates the artifact in. */
export type DeploymentMode = 'shared' | 'dedicated';

/** Resolved per-app provisioning target.  When `mode==='shared'`, every
 * field below points at the customer's existing tenant-wide Fabric /
 * Synapse / ADX / etc. — the same resources powering every other Loom
 * editor.  When `mode==='dedicated'`, the install wizard pre-provisioned
 * an isolated set and the fields point at those instead. */
export interface ProvisionTarget {
  mode: DeploymentMode;
  /** Fabric workspace id to create notebooks / lakehouses / pipelines / activator rules in. */
  fabricWorkspaceId?: string;
  /** ADX cluster URI for KQL-backed items. */
  kustoClusterUri?: string;
  /** ADX database name for KQL-backed items. */
  kustoDatabase?: string;
  /** Synapse workspace name for Synapse-backed items. */
  synapseWorkspace?: string;
  /** Azure SQL / Fabric Warehouse server. */
  warehouseServer?: string;
  /** Warehouse database name. */
  warehouseDatabase?: string;
  /** AI Search service name (without .search.windows.net suffix). */
  aiSearchService?: string;
  /** ADLS Gen2 account + container for Lakehouse / Bronze-Silver-Gold. */
  adlsAccount?: string;
  adlsContainer?: string;
  /**
   * Per-item backend selectors (see .claude/rules/no-fabric-dependency.md).
   * Each DEFAULTS to its Azure-native option; 'fabric' is opt-in only and
   * additionally requires a bound fabricWorkspaceId. No item may hard-gate on
   * Fabric — when fabric is selected but no workspace is bound, the provisioner
   * silently falls back to the Azure-native path.
   */
  pipelineBackend?: 'synapse' | 'adf' | 'fabric';   // data-pipeline → Synapse (default) / ADF / Fabric
  eventBackend?: 'eventhubs' | 'fabric';            // eventstream → Event Hubs (default) / Fabric
  activatorBackend?: 'azure-monitor' | 'fabric';    // activator → Azure Monitor alert (default) / Fabric Reflex
  dashboardBackend?: 'adx' | 'fabric';              // kql-dashboard → Loom-native over ADX (default) / Fabric RTD
  mirrorBackend?: 'adf-cdc' | 'synapse-link' | 'fabric'; // mirrored-database → ADF CDC → ADLS Bronze (default) / Fabric Mirroring
  lakehouseBackend?: 'adls' | 'fabric';             // lakehouse → ADLS Gen2 + Delta (default) / OneLake
  semanticBackend?: 'loom-native' | 'analysis-services' | 'powerbi'; // semantic-model → Loom-native tabular over warehouse (default)
  /** Event Hubs namespace for the eventstream Azure-native backend. */
  eventhubsNamespace?: string;
}

export type ProvisionStatus =
  | 'created'           // resource newly provisioned
  | 'exists'            // resource already provisioned, content updated
  | 'skipped'           // user opted out
  | 'remediation'       // failed with structured remediation; user clicks Retry
  | 'failed';           // unexpected error; user can Skip and continue

export interface RemediationGate {
  /** Short reason e.g. "Fabric workspace not bound to capacity." */
  reason: string;
  /** Specific env var, role, or admin step required to unblock. */
  remediation: string;
  /** Optional URL to docs / portal blade. */
  link?: string;
}

export interface ProvisionResult {
  status: ProvisionStatus;
  /** When status==='created' or 'exists', the live Azure / Fabric resource id. */
  resourceId?: string;
  /** Optional secondary identifiers — e.g. lakehouse id + onelake path. */
  secondaryIds?: Record<string, string>;
  /** When status==='remediation' or 'failed'. */
  error?: string;
  /** When status==='remediation'. */
  gate?: RemediationGate;
  /** Best-effort step log shown in the wizard UI. */
  steps?: string[];
}

export interface ProvisionerInput {
  session: ProvisionerSession;
  target: ProvisionTarget;
  cosmosItemId: string;
  workspaceId: string;
  displayName: string;
  /** state.content from the bundle (NotebookContent / KqlDatabaseContent / ...). */
  content: unknown;
  /** Bundle's source app id e.g. 'app-iot-realtime'. */
  appId: string;
}

export type Provisioner = (input: ProvisionerInput) => Promise<ProvisionResult>;
