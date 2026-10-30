/** Where findings read observed state from (W1-3 inventory); endpoints join in W2. */
import type { GatewayMcpServer } from './findings';
import type { ClassifiableResource } from './types';

export interface FindingsSource {
  gatewayMcpServers(tenantId: string): Promise<GatewayMcpServer[]>;
  mcpEndpoints(tenantId: string): Promise<Array<ClassifiableResource & { url: string }>>;
}
