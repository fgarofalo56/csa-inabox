/**
 * Shared fixtures for the cost tests.
 *
 * PUBLIC REPO: every identifier here is a placeholder. No tenant, subscription,
 * object or resource id from the operator's estate appears in this repository.
 * The GUIDs below are visibly synthetic (`1111…`, `2222…`) for exactly that
 * reason — a plausible-looking GUID in a fixture is indistinguishable from a
 * leaked one at review time.
 */

import { azureResourceNodeId } from '../../graph/node-id';
import type { AzureResourceNode, ScaleFacts } from '../../types';

/** A synthetic subscription id. Not real, and visibly so. */
export const SUB_A = '11111111-1111-1111-1111-111111111111';
/** A second synthetic subscription, for multi-sub cases. */
export const SUB_B = '22222222-2222-2222-2222-222222222222';

export function containerAppArmId(sub: string, rg: string, name: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${name}`;
}

/**
 * Build an `AzureResourceNode` for a Container App.
 *
 * `scale` and `location` are OPTIONAL on purpose: their absence is the
 * NOT-MEASURED state the cost layer must refuse to price, and several tests
 * depend on being able to construct exactly that.
 */
export function containerAppNode(args: {
  name: string;
  sub?: string;
  resourceGroup?: string;
  location?: string;
  scale?: ScaleFacts;
  provisioningState?: string;
}): AzureResourceNode {
  const sub = args.sub ?? SUB_A;
  const rg = args.resourceGroup ?? 'rg-loom';
  const armId = containerAppArmId(sub, rg, args.name);
  return {
    id: azureResourceNodeId(armId),
    kind: 'azure-resource',
    displayName: args.name,
    source: 'resource-graph',
    resourceId: armId,
    resourceType: 'Microsoft.App/containerApps',
    subscriptionId: sub,
    resourceGroup: rg,
    location: args.location,
    tags: {},
    scale: args.scale,
    provisioningState: args.provisioningState ?? 'Succeeded',
  };
}

/**
 * THE FOUNDING MEASURED EXAMPLE, as scale facts.
 *
 * `loom-capacity-broker` runs `minReplicas: 2` at 0.5 vCPU and 1 GiB per
 * replica, is healthy, has an internal FQDN — and `admin-plane/main.bicep:4730`
 * emits `LOOM_BROKER_URL: ''`, so it has ZERO inbound `configured` edges. A
 * billing service with no inbound edge. The cost layer's job is to say what
 * that costs, and to be honest that the number is derived.
 */
export const BROKER_SCALE: ScaleFacts = {
  minReplicas: 2,
  maxReplicas: 4,
  cpu: 0.5,
  memory: '1Gi',
  source: 'resource-graph',
};

/** A scale-to-zero app — the shape 10 of Loom's 29 apps have. */
export const SCALE_TO_ZERO: ScaleFacts = {
  minReplicas: 0,
  cpu: 0.25,
  memory: '0.5Gi',
  source: 'resource-graph',
};
