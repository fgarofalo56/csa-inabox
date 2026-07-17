/**
 * Event Hub → workspace scoping for the Eventstream editor's namespace tree.
 *
 * Least-privilege default (defect: the left Event Hubs tree listed EVERY hub in
 * the deployment namespace to every user): the tree lists ONLY the hubs that
 * are referenced by eventstream items in workspaces the CALLER can access
 * (owned + ACL-shared, tenant-boundary applied via listAccessibleWorkspaces —
 * the same chokepoint the catalog search uses). Tenant admins may opt into the
 * full namespace listing with ?scope=all (the tree's admin-only toggle).
 *
 * Pure extraction (hubNamesFromEventstreamState) is unit-tested with no Cosmos.
 */
import { listAccessibleWorkspaces } from '@/lib/auth/workspace-access';
import { itemsContainer } from '@/lib/azure/cosmos-client';

/**
 * Collect every Event Hub ENTITY name an eventstream item's persisted state
 * references — canvas sources/sinks (eventHubName / kafka topic / provisioned
 * entityPath), the provisioned transport hub, and the ehId ARM resource id's
 * trailing `/eventhubs/{name}` segment. Names are returned lower-cased (Event
 * Hub entity names are case-insensitive on the data plane).
 */
export function hubNamesFromEventstreamState(state: Record<string, any> | undefined | null): string[] {
  if (!state || typeof state !== 'object') return [];
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase());
  };

  const sources: any[] = Array.isArray(state.sources) ? state.sources : (state.source ? [state.source] : []);
  for (const n of sources) {
    if (!n || typeof n !== 'object') continue;
    add(n.eventHubName);
    add(n.topic); // kafka source: topic == Event Hub entity on the Kafka endpoint
    add(n.provisionedEndpoint?.entityPath);
  }
  const sinks: any[] = Array.isArray(state.sinks) ? state.sinks : (state.sink ? [state.sink] : []);
  for (const n of sinks) {
    if (!n || typeof n !== 'object') continue;
    add(n.eventHubName);
  }

  // Provisioned transport hub (editor "Provision to Azure" + bundle installs).
  add(state.transportHub);
  // ehId is the full ARM resource id …/eventhubs/{name} — take the entity name.
  if (typeof state.ehId === 'string') {
    const m = /\/eventhubs\/([^/]+)\s*$/i.exec(state.ehId);
    if (m) add(decodeURIComponent(m[1]));
  }
  return [...out];
}

/**
 * The set of hub names (lower-cased) referenced by eventstream items in every
 * workspace the caller can access. Empty set when the caller has no workspaces
 * (or none of their streams reference a hub yet).
 */
export async function listCallerScopedHubNames(oid: string, callerTid?: string): Promise<Set<string>> {
  const workspaces = await listAccessibleWorkspaces(oid, { callerTid });
  const wsIds = workspaces.map((w) => w.id);
  if (wsIds.length === 0) return new Set();

  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ state?: Record<string, any> }>({
      query:
        "SELECT c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId) AND c.itemType = 'eventstream'",
      parameters: [{ name: '@w', value: wsIds }],
    })
    .fetchAll();

  const out = new Set<string>();
  for (const it of resources) {
    for (const name of hubNamesFromEventstreamState(it.state)) out.add(name);
  }
  return out;
}
