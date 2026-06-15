/**
 * topology-inventory — per-domain resource inventory via Azure Resource Graph.
 *
 * Each Data Landing Zone resource dlz-attach provisions is stamped with the
 * `loom-domain:<id>` chargeback tag (DOMAIN_TAG_KEY in domain-registry). This
 * client runs the documented ARG REST query
 *   POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
 * filtering on that tag, so /admin/domains can show exactly the Azure resources
 * that belong to a domain — real data, no mocks (no-vaporware.md).
 *
 * Sovereign-correct: ARM host + scope come from cloud-endpoints (armBase /
 * armScope), so the same code path works on Commercial, GCC, and the USGov
 * boundaries (GCC-High / IL5). NO Fabric dependency.
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential) — identical to the
 * other Loom ARM clients. The UAMI needs **Reader** on the domain's subscription
 * to enumerate its resources; without it ARG returns an empty set and the route
 * surfaces an honest gate naming the exact `az role assignment create` grant.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { DOMAIN_TAG_KEY } from '@/lib/azure/domain-registry';

const ARM = armBase();
const ARM_SCOPE = armScope();
const RESOURCE_GRAPH_API = '2022-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class InventoryError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

export interface InventoryResource {
  name: string;
  type: string;
  resourceGroup: string;
  location: string;
  subscriptionId: string;
  kind?: string;
  tags?: Record<string, string>;
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new InventoryError('Failed to acquire ARM token', 401);
  return t.token;
}

/**
 * Resource inventory for a domain: every Azure resource tagged
 * `loom-domain:<domainId>` (the chargeback tag), discovered via ARG.
 *
 * @param domainId  the domain id whose tag value to match
 * @param subscriptionIds  the domain's bound subscription(s); ARG scopes its
 *   search to these. When empty the query runs tenant-wide (ARG trims to the
 *   subscriptions the identity can read).
 */
export async function domainResourceInventory(
  domainId: string,
  subscriptionIds: string[],
): Promise<InventoryResource[]> {
  // KQL: match the chargeback tag value case-insensitively. ARG indexes the
  // `tags` bag; `tags['loom-domain']` is the documented tag-filter syntax.
  const tagValue = `${DOMAIN_TAG_KEY}:${domainId}`;
  const query = [
    'Resources',
    `| where tags['${DOMAIN_TAG_KEY}'] =~ '${tagValue}' or tags['${DOMAIN_TAG_KEY}'] =~ '${domainId}'`,
    '| project name, type, kind, resourceGroup, location, subscriptionId, tags',
    '| order by type asc, name asc',
  ].join('\n');

  const out: InventoryResource[] = [];
  let skipToken: string | undefined;
  let guard = 0;
  do {
    guard++;
    const options: Record<string, unknown> = { resultFormat: 'objectArray', $top: 1000 };
    if (skipToken) options.$skipToken = skipToken;
    const payload: Record<string, unknown> = { query, options };
    if (subscriptionIds.length) payload.subscriptions = subscriptionIds;

    const tk = await token();
    const res = await fetchWithTimeout(
      `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tk}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        cache: 'no-store',
      },
    );
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* leave null */
    }
    if (!res.ok) {
      const msg = (json?.error?.message || text || `ARG query failed (${res.status})`).toString();
      throw new InventoryError(msg, res.status);
    }
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    for (const row of data) {
      out.push({
        name: String(row?.name || ''),
        type: String(row?.type || ''),
        kind: row?.kind || undefined,
        resourceGroup: String(row?.resourceGroup || ''),
        location: String(row?.location || ''),
        subscriptionId: String(row?.subscriptionId || ''),
        tags: row?.tags && typeof row.tags === 'object' ? row.tags : undefined,
      });
    }
    skipToken = (json?.$skipToken as string) || undefined;
  } while (skipToken && guard < 20);

  return out;
}
