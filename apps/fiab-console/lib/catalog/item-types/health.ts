import type { FabricItemType } from './types';

/**
 * Health data (LHDS) - item-type catalog slice.
 *
 * `health-tenant` is the first Health Data Services item (W1-7). Creating one
 * provisions and binds a tenant on a stamp through the health control plane
 * (lib/install/provisioners/health-tenant.ts); its backing is Azure-native end
 * to end (PostgreSQL Flexible Server, Blob, Event Hubs, Key Vault, managed
 * identity) with no Fabric or Power BI dependency (no-fabric-dependency.md).
 * Recomposed into FABRIC_ITEM_TYPES by the barrel.
 */
export const healthItems: FabricItemType[] = [
  { slug: 'health-tenant', displayName: 'Health tenant', restType: 'HealthTenant', category: 'Health data',
    description: 'A Health Data Services tenant on a stamp: its own PostgreSQL database, Blob storage, Event Hubs hub and Key Vault keys, provisioned and read back for you.',
    learnContent: {
      overview: 'A Health tenant is the isolation boundary for Health Data Services. Creating one registers it in the health control plane and deploys its database, storage, event hub, identity and per-tenant keys on a stamp, then reads every resource back. The control plane holds identities and routing only, never clinical data.',
      steps: [
        { title: 'Create the item', body: 'Name it. The tenant carries your exact name; its id is a lowercase slug derived from it and shown on the Overview.' },
        { title: 'Watch it provision', body: 'The Overview opens immediately and shows the create job step by step. Nothing to bind or configure.' },
        { title: 'Check the readback', body: 'When the job finishes, every resource it created is listed with its Azure name, read back from Azure rather than assumed.' },
        { title: 'Self-heal', body: 'If a resource is deleted out of band, the next verification rebuilds it. A failed job offers Retry with the exact reason.' },
      ],
      docsUrl: 'https://learn.microsoft.com/azure/healthcare-apis/healthcare-apis-overview',
    } },
];
