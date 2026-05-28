/**
 * Phase 2 — AI Search index provisioner.
 *
 * Real REST: PUT /indexes/{name}?api-version=2024-07-01 (idempotent
 * upsert) followed by POST /indexes/{name}/docs/index for sample
 * documents.
 *
 * Auth: DefaultAzureCredential / UAMI against
 * https://{service}.search.windows.net/.default
 *
 * Remediation gates:
 *   - LOOM_AI_SEARCH_SERVICE missing → set it.
 *   - 403 → UAMI lacks Search Service Contributor on the service.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import type { Provisioner, ProvisionResult } from './types';

const SEARCH_API = '2024-07-01';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://search.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire AAD token for AI Search');
  return t.token;
}

export const aiSearchProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const svc = input.target.aiSearchService || process.env.LOOM_AI_SEARCH_SERVICE;
  if (!svc) {
    return {
      status: 'remediation',
      gate: {
        reason: 'AI Search service not configured.',
        remediation: 'Set LOOM_AI_SEARCH_SERVICE to the service name (without .search.windows.net).',
        link: 'https://learn.microsoft.com/azure/search/',
      },
      steps,
    };
  }
  const content = input.content as any;
  const schema = content?.schema;
  if (!schema?.fields || !Array.isArray(schema.fields)) {
    return { status: 'skipped', steps: ['No schema in bundle; nothing to provision.'] };
  }
  const indexName = input.displayName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 128) || 'loom-index';
  steps.push(`Target: https://${svc}.search.windows.net/indexes/${indexName}`);

  const tok = await token();
  const indexBody = {
    name: indexName,
    fields: schema.fields,
    ...(content.vectorConfig
      ? {
          vectorSearch: {
            algorithms: [{
              name: 'default-hnsw',
              kind: 'hnsw',
              hnswParameters: { metric: 'cosine', m: 4, efConstruction: 400, efSearch: 500 },
            }],
            profiles: [{ name: 'default-profile', algorithm: 'default-hnsw' }],
          },
        }
      : {}),
    ...(Array.isArray(content.scoringProfiles) ? { scoringProfiles: content.scoringProfiles } : {}),
  };

  const putRes = await fetch(`https://${svc}.search.windows.net/indexes/${indexName}?api-version=${SEARCH_API}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(indexBody),
    cache: 'no-store',
  });
  if (putRes.status === 401 || putRes.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `AI Search ${putRes.status}: cannot create/update index.`,
        remediation:
          'Grant the Console UAMI Search Service Contributor on the AI Search service: az role assignment create --assignee <uami-objectid> --role "Search Service Contributor" --scope /subscriptions/.../Microsoft.Search/searchServices/<service>',
        link: 'https://learn.microsoft.com/azure/search/search-howto-managed-identities-data-sources',
      },
      steps,
    };
  }
  if (!putRes.ok) {
    const t = await putRes.text();
    return { status: 'failed', error: `Search index PUT ${putRes.status}: ${t.slice(0, 300)}`, steps };
  }
  steps.push(`Index PUT ${putRes.status} OK.`);

  // Push sample docs if any.
  const sampleDocs: any[] = Array.isArray(content.sampleDocs) ? content.sampleDocs : [];
  if (sampleDocs.length > 0) {
    const ingestRes = await fetch(`https://${svc}.search.windows.net/indexes/${indexName}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: sampleDocs.map((d) => ({ '@search.action': 'mergeOrUpload', ...d })) }),
      cache: 'no-store',
    });
    if (ingestRes.ok) {
      steps.push(`Pushed ${sampleDocs.length} sample docs.`);
    } else {
      const t = await ingestRes.text();
      steps.push(`Sample-doc push failed ${ingestRes.status}: ${t.slice(0, 200)}`);
    }
  }

  return {
    status: putRes.status === 201 ? 'created' : 'exists',
    resourceId: indexName,
    secondaryIds: { service: svc, endpoint: `https://${svc}.search.windows.net/indexes/${indexName}` },
    steps,
  };
};
