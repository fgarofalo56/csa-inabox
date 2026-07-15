/**
 * @csa-loom/sdk — typed TypeScript client for the CSA Loom REST API.
 *
 * Consistent with the OpenAPI 3.1 contract the Loom deployment serves at
 * `GET /api/openapi.json`. Azure-native — no Microsoft Fabric tenant required.
 */

export { LoomClient } from './client.js';
export { LoomApiError, isLoomApiError } from './errors.js';
export { COOKIE_NAME, normalizeBaseUrl, type LoomClientOptions } from './http.js';
export { ITEM_TYPES, isKnownItemType } from './item-types.js';

export type {
  WhoAmI,
  Workspace,
  CreateWorkspaceInput,
  Item,
  CreateItemInput,
  UpdateItemInput,
  CatalogHit,
  CatalogSearchResult,
  CatalogSearchOptions,
  ThreadEdge,
  TokenScope,
  TokenView,
  CreateTokenInput,
  CreateTokenResult,
  SessionResult,
} from './types.js';

// Resource classes (exported for advanced typing / DI).
export { WorkspacesResource } from './resources/workspaces.js';
export { ItemsResource } from './resources/items.js';
export { CatalogResource } from './resources/catalog.js';
export { ThreadResource } from './resources/thread.js';
export { TokensResource } from './resources/tokens.js';
