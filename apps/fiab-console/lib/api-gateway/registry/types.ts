/**
 * API Gateway Plane — gateway registry types (W1-2).
 *
 * The `gateway` record shape follows PRPs/active/loom-api-gateway-plane/
 * ARCHITECTURE.md (key entity shapes). Documents live in `apiplane-desired`
 * (PK /tenantId, docType 'gateway').
 */
import type { ApiplaneDoc } from '../types';

export type GatewayCloud = 'AzureCloud' | 'AzureUSGovernment' | 'AzureDOD';
export type ManagementMode = 'observe' | 'manage';
export type GatewayOwner = 'deploy' | 'registered';

export interface MissingRole {
  /** Built-in role definition GUID (not the full resource id). */
  roleDefinitionId: string;
  roleName: string;
  scope: string;
  /** Exact command an operator can run; names the principal object id when known. */
  azCommand: string;
}

export interface GatewayAccess {
  canRead: boolean;
  canWrite: boolean;
  missingRole?: MissingRole;
  checkedAt: string;
  /** 'permissions' = effective permissions at the scope; 'probe' = fell back to a GET of the service. */
  source: 'permissions' | 'probe';
  /** Object id of the principal that was checked (the `oid` claim of the ARM token), when decodable. */
  principalId?: string;
}

export interface GatewayDoc extends ApiplaneDoc {
  docType: 'gateway';
  kind: 'gateway';
  displayName: string;
  resourceId: string;
  cloud: GatewayCloud;
  /** undefined = host identity (Console UAMI). */
  connectionId?: string;
  managementMode: ManagementMode;
  /** Environment catalog key; null = Unclassified (default). Written ONLY by the classification store. */
  environmentKey: string | null;
  /** Tags as seen on the ARM response (suggestions only; never written back). */
  armTags?: Record<string, string>;
  /** Cosmos concurrency token; assigned by the repository on every write. */
  _etag?: string;
  access: GatewayAccess;
  capabilities: {
    skuName?: string;
    tier: 'v2' | 'classic' | 'consumption' | 'unknown';
    gatewayUrl?: string;
    identity?: { principalId: string };
    mcpServers: 'available' | 'unavailable' | 'unknown';
    llmPolicies: 'available' | 'unavailable' | 'unknown';
  };
  inventory: {
    apis: number;
    products: number;
    subscriptions: number;
    backends: number;
    namedValues: number;
    mcpServers: number;
    lastSyncAt?: string;
    partialTypes: string[];
  };
  ownedBy: GatewayOwner;
  createdAt: string;
  createdBy: string;
}

export interface ParsedApimResourceId {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
  /** Canonical casing: `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<name>`. */
  resourceId: string;
}
