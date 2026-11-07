/** Client helpers for Settings -> Environments / Findings. Thin: the API owns every rule (permits() is never reimplemented here). */
import { clientFetch } from '@/lib/client-fetch';
import type { EnvironmentDef, EnvironmentSettings, Verdict } from '@/lib/api-gateway/environments/types';
import type { TagSuggestion } from '@/lib/api-gateway/environments/tags';
import type { Finding } from '@/lib/api-gateway/environments/findings';

const BASE = '/api/admin/api-gateway/environments';

export interface Blocking { id: string; displayName: string; reason: string }
export interface ApiResult<T> { ok: boolean; status: number; data?: T; error?: string; blocking?: Blocking[] }

export interface CatalogData {
  environments: EnvironmentDef[];
  settings: EnvironmentSettings;
  usage: Record<string, number>;
  unclassified: number;
  registryAvailable: boolean;
}
export interface MatrixData {
  keys: Array<string | null>;
  cells: Array<{ gatewayEnv: string | null; resourceEnv: string | null; verdict: Verdict }>;
}
export interface SuggestionsData { suggestions: TagSuggestion[]; registryAvailable: boolean }
export interface FindingsData { findings: Finding[]; available: boolean }

export async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  try {
    // A computed URL (wide `string`) passes clientFetch's route check by design; the
    // R17 guard (scripts/ci/check-known-client-routes.mjs) matches the literal prefix.
    const url: string = `${BASE}${path}`;
    const res = await clientFetch(url, {
      method: init?.method ?? 'GET',
      cache: 'no-store',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: Boolean(json.ok), status: res.status, data: json.data, error: json.error, blocking: json.blocking };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

export const getCatalog = () => call<CatalogData>('');
export const getMatrix = () => call<MatrixData>('/matrix');
export const getSuggestions = () => call<SuggestionsData>('/suggestions');
export const getFindings = () => call<FindingsData>('/findings');
