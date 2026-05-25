/**
 * Cosmos singleton for the Loom Console BFF.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential so local dev works against the
 * same account via `az login`. The UAMI must hold the Cosmos DB
 * Built-in Data Contributor role at account scope.
 *
 * Containers are created on first access (idempotent) so a fresh
 * environment doesn't require an ARM/Bicep pre-step beyond the
 * account+database.
 */

import { CosmosClient, type Container, type Database } from '@azure/cosmos';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

let _client: CosmosClient | null = null;
let _db: Database | null = null;
let _workspaces: Container | null = null;
let _items: Container | null = null;
let _copilotSessions: Container | null = null;
let _ensured = false;

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT not set');
  return v;
}

function databaseId(): string {
  return process.env.LOOM_COSMOS_DATABASE || 'loom';
}

function credential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(...chain);
}

function client(): CosmosClient {
  if (_client) return _client;
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: credential() });
  return _client;
}

async function ensure() {
  if (_ensured) return;
  const c = client();
  const { database } = await c.databases.createIfNotExists({ id: databaseId() });
  _db = database;
  const { container: ws } = await database.containers.createIfNotExists({
    id: 'workspaces',
    partitionKey: { paths: ['/tenantId'] },
  });
  _workspaces = ws;
  const { container: it } = await database.containers.createIfNotExists({
    id: 'items',
    partitionKey: { paths: ['/workspaceId'] },
  });
  _items = it;
  const { container: cs } = await database.containers.createIfNotExists({
    id: 'copilot-sessions',
    partitionKey: { paths: ['/sessionId'] },
  });
  _copilotSessions = cs;
  _ensured = true;
}

export async function workspacesContainer(): Promise<Container> {
  await ensure();
  return _workspaces!;
}

export async function itemsContainer(): Promise<Container> {
  await ensure();
  return _items!;
}

export async function copilotSessionsContainer(): Promise<Container> {
  await ensure();
  return _copilotSessions!;
}
