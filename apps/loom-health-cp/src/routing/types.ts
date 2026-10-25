import type { Doc } from '../store/types.js';

export type RouteStatus = 'active' | 'paused' | 'unavailable';

export interface RoutingEntry {
  tenantSlug: string;
  stampId: string;
  stampBaseUrl: string;
  status: RouteStatus;
  /** Present for paused routes: the edge answers 503 with this Retry-After. */
  retryAfterSeconds?: number;
  reason?: string;
}

export interface RoutingMapDoc extends Doc {
  /** Always 'current': one single-writer document the edge reads. */
  id: 'current';
  /** sha256 over the canonical entries; unchanged map => unchanged version. */
  version: string;
  generatedAt: string;
  cacheTtlSeconds: number;
  entries: RoutingEntry[];
}
