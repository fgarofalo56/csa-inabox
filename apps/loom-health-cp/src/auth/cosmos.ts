// Cosmos wiring for the Authorization Server's three containers. Same account
// and credential model as src/store/cosmos.ts (managed identity, no keys). The
// containers must exist before start; health-auth-replay and health-auth-grants
// need a default TTL of -1 (per-item `ttl` honoured). That is bicep work owned
// by another lane, listed in the PR.

import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { Config } from '../config.js';
import { CosmosCollection } from '../store/cosmos.js';
import { AUTH_CONTAINER_NAMES, type AuthStores } from './types.js';

export function createCosmosAuthStores(cfg: Config): AuthStores {
  const credential = new DefaultAzureCredential({ authorityHost: `https://${cfg.authorityHost}` });
  const db = new CosmosClient({ endpoint: cfg.cosmosEndpoint, aadCredentials: credential }).database(cfg.cosmosDatabase);
  const config = db.container(AUTH_CONTAINER_NAMES.config);
  return {
    bindings: new CosmosCollection(config),
    clients: new CosmosCollection(config),
    replay: new CosmosCollection(db.container(AUTH_CONTAINER_NAMES.replay)),
    grants: new CosmosCollection(db.container(AUTH_CONTAINER_NAMES.grants)),
  };
}
