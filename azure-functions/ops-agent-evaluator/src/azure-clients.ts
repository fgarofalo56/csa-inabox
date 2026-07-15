/**
 * ops-agent-evaluator — real Azure data-plane clients (Cosmos read, ADX query,
 * AOAI chat, Logic App dispatch). All use the Function's managed identity via
 * DefaultAzureCredential — no keys, no mocks (no-vaporware). Azure-native, no
 * Microsoft Fabric dependency.
 */
import { DefaultAzureCredential } from '@azure/identity';
import { CosmosClient } from '@azure/cosmos';
import type { OpsAgentItem } from './evaluator-core';

const cred = new DefaultAzureCredential();

/** Read all operations-agent items (with their persisted triggers) from Cosmos. */
export async function readOpsAgents(endpoint: string, database: string): Promise<OpsAgentItem[]> {
  const client = new CosmosClient({ endpoint, aadCredentials: cred });
  const container = client.database(database).container('items');
  const { resources } = await container.items
    .query({
      query: 'SELECT c.id, c.displayName, c.workspaceId, c.state FROM c WHERE c.itemType = @t',
      parameters: [{ name: '@t', value: 'operations-agent' }],
    })
    .fetchAll();
  return resources as OpsAgentItem[];
}

/** Bearer token for a resource (ADX cluster, ARM, or AOAI). */
async function tokenFor(scope: string): Promise<string> {
  const t = await cred.getToken(scope);
  if (!t?.token) throw new Error(`failed to acquire token for ${scope}`);
  return t.token;
}

/** Run a KQL query against an ADX / Eventhouse cluster via the v2 REST API.
 *  Returns the first primary-result table's columns + rows. */
export async function adxQuery(
  clusterUri: string,
  database: string,
  query: string,
): Promise<{ columns: string[]; rows: unknown[][]; count: number }> {
  const token = await tokenFor(`${clusterUri.replace(/\/$/, '')}/.default`);
  const res = await fetch(`${clusterUri.replace(/\/$/, '')}/v2/rest/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ db: database, csl: query }),
  });
  if (!res.ok) throw new Error(`ADX query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const frames: any[] = await res.json();
  // v2 response: array of frames; the primary result is a Table frame of kind
  // 'PrimaryResult' with Columns[] + Rows[][].
  const primary = frames.find((f) => f?.TableKind === 'PrimaryResult' || (Array.isArray(f?.Columns) && Array.isArray(f?.Rows)));
  const columns: string[] = (primary?.Columns || []).map((c: any) => c.ColumnName || c.Name || '');
  const rows: unknown[][] = primary?.Rows || [];
  return { columns, rows, count: rows.length };
}

/** Azure OpenAI chat completion for the reasoning step. */
export async function aoaiChat(
  endpoint: string,
  deployment: string,
  messages: { role: string; content: string }[],
): Promise<string> {
  const base = endpoint.replace(/\/$/, '');
  // Cognitive Services scope for AAD-auth AOAI.
  const token = await tokenFor('https://cognitiveservices.azure.com/.default');
  const url = `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-08-01-preview`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 400, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`AOAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  return String(j?.choices?.[0]?.message?.content || '').trim();
}

/** Resolve a Consumption Logic App's manual-trigger callback URL via ARM, then
 *  POST the approval payload to it (fire the Teams adaptive-card approval). */
export async function dispatchApprovalLogicApp(
  armEndpoint: string,
  subscriptionId: string,
  resourceGroup: string,
  workflowName: string,
  payload: Record<string, unknown>,
): Promise<{ dispatched: boolean; status: number }> {
  const arm = armEndpoint.replace(/\/$/, '');
  const armToken = await tokenFor(`${arm}/.default`);
  const cbUrl =
    `${arm}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.Logic/workflows/${workflowName}/triggers/manual/listCallbackUrl?api-version=2016-06-01`;
  const cbRes = await fetch(cbUrl, { method: 'POST', headers: { authorization: `Bearer ${armToken}` } });
  if (!cbRes.ok) throw new Error(`listCallbackUrl ${cbRes.status}: ${(await cbRes.text()).slice(0, 200)}`);
  const cb: any = await cbRes.json();
  const invokeUrl: string = cb?.value || cb?.url;
  if (!invokeUrl) throw new Error('Logic App callback URL missing from listCallbackUrl response');
  const post = await fetch(invokeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { dispatched: post.ok, status: post.status };
}
