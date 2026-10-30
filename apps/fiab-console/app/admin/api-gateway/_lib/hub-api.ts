/** Client helpers for the API Gateway hub (W1-5). Thin: the W1-2/W1-3 routes own every rule. */
import { clientFetch } from '@/lib/client-fetch';
import type { GatewayDoc, MissingRole } from '@/lib/api-gateway/registry/types';

const BASE = '/api/admin/api-gateway/gateways';

export interface HubResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  code?: string;
  /** Present on a 422 gateway_role_missing: the exact role, scope and az command. */
  missingRole?: MissingRole;
}

export interface GatewayList {
  gateways: GatewayDoc[];
  deployRegistration: { ok: boolean; gatewayId?: string | null; code?: string; error?: string };
}

export interface SyncData {
  status: 'synced';
  gatewayId: string;
  counts: Record<string, number>;
  partialTypes: string[];
  swept: number;
  mcp: 'available' | 'unavailable' | 'unknown';
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<HubResult<T>> {
  try {
    // Computed URL (wide `string`) passes clientFetch's route check by design; the R17 guard
    // matches the literal prefix in BASE.
    const url: string = `${BASE}${path}`;
    const res = await clientFetch(url, {
      method: init?.method ?? 'GET',
      cache: 'no-store',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = await res.json().catch(() => ({}));
    return {
      ok: Boolean(json.ok),
      status: res.status,
      data: json.data,
      error: json.error,
      code: json.code,
      missingRole: json.data?.missingRole,
    };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

export const listGateways = () => call<GatewayList>('');
export const registerGateway = (resourceId: string, displayName?: string) =>
  call<GatewayDoc>('', { method: 'POST', body: { resourceId, ...(displayName ? { displayName } : {}) } });
export const syncGateway = (id: string) => call<SyncData>(`/${encodeURIComponent(id)}/sync`, { method: 'POST' });
export const removeGateway = (id: string) => call<{ id: string }>(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
