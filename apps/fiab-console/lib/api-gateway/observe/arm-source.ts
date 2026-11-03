/** Production ObserveSource: reads one registered gateway through the Console identity via apim-client. */
import { getPolicy, listMcpApis, listPolicyFragments, pagedGet, withApimGateway } from '@/lib/azure/apim-client';
import type { GatewayDoc } from '../registry/types';
import type { McpListing, ObservedType, ObserveSource, TypeListing } from './types';

const PATHS: Record<Exclude<ObservedType, 'mcp' | 'operation' | 'fragment'>, string> = {
  api: '/apis',
  product: '/products',
  subscription: '/subscriptions',
  user: '/users',
  group: '/groups',
  backend: '/backends',
  namedValue: '/namedValues',
};

const API_VERSION = '2024-06-01-preview';

export function armObserveSource(gw: GatewayDoc): ObserveSource {
  const rid = gw.resourceId;
  const toListing = (r: { items: any[]; complete: boolean; error?: string }): TypeListing => r;
  return {
    async list(type) {
      return toListing(await pagedGet(rid, PATHS[type], API_VERSION));
    },
    async operations(apiName) {
      return toListing(await pagedGet(rid, `/apis/${encodeURIComponent(apiName)}/operations`, API_VERSION));
    },
    async fragments() {
      return toListing(await listPolicyFragments(rid));
    },
    async mcpApis(): Promise<McpListing> {
      return listMcpApis(rid);
    },
    async apiPolicy(apiName) {
      const p = await withApimGateway(rid, () => getPolicy(`apis/${encodeURIComponent(apiName)}`));
      return p ? p.value : null;
    },
  };
}
