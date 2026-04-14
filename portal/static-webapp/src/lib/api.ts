/**
 * API client for the CSA-in-a-Box shared FastAPI backend.
 *
 * In Azure Static Web Apps, /api/* routes are proxied to the managed API.
 * In local dev, Vite proxies /api to the FastAPI backend (localhost:8000).
 */

import type {
	SourceRecord,
	SourceRegistration,
	PipelineRecord,
	PipelineRun,
	DataProduct,
	AccessRequest,
	PlatformStats,
	ApiError
} from './types';

const BASE_URL = '/api';

/** Shared fetch wrapper with error handling. */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const url = `${BASE_URL}${path}`;

	const response = await fetch(url, {
		headers: {
			'Content-Type': 'application/json',
			...init?.headers
		},
		...init
	});

	if (!response.ok) {
		let detail = `Request failed: ${response.status} ${response.statusText}`;
		try {
			const err: ApiError = await response.json();
			detail = err.detail || detail;
		} catch {
			// response body was not JSON
		}

		if (response.status === 401) {
			// SWA handles auth — redirect to login
			window.location.href = '/.auth/login/aad';
		}

		throw new Error(detail);
	}

	// Handle 204 No Content
	if (response.status === 204) {
		return undefined as T;
	}

	return response.json();
}

// ─── Sources ────────────────────────────────────────────────────────────────

export async function listSources(params?: {
	domain?: string;
	status?: string;
	source_type?: string;
}): Promise<SourceRecord[]> {
	const query = new URLSearchParams();
	if (params?.domain) query.set('domain', params.domain);
	if (params?.status) query.set('status', params.status);
	if (params?.source_type) query.set('source_type', params.source_type);
	const qs = query.toString();
	return apiFetch<SourceRecord[]>(`/sources${qs ? `?${qs}` : ''}`);
}

export async function getSource(id: string): Promise<SourceRecord> {
	return apiFetch<SourceRecord>(`/sources/${id}`);
}

export async function registerSource(source: SourceRegistration): Promise<SourceRecord> {
	return apiFetch<SourceRecord>('/sources', {
		method: 'POST',
		body: JSON.stringify(source)
	});
}

export async function updateSource(
	id: string,
	updates: Partial<SourceRegistration>
): Promise<SourceRecord> {
	return apiFetch<SourceRecord>(`/sources/${id}`, {
		method: 'PATCH',
		body: JSON.stringify(updates)
	});
}

export async function decommissionSource(id: string): Promise<SourceRecord> {
	return apiFetch<SourceRecord>(`/sources/${id}/decommission`, {
		method: 'POST'
	});
}

// ─── Pipelines ──────────────────────────────────────────────────────────────

export async function listPipelines(params?: {
	source_id?: string;
	status?: string;
}): Promise<PipelineRecord[]> {
	const query = new URLSearchParams();
	if (params?.source_id) query.set('source_id', params.source_id);
	if (params?.status) query.set('status', params.status);
	const qs = query.toString();
	return apiFetch<PipelineRecord[]>(`/pipelines${qs ? `?${qs}` : ''}`);
}

export async function getPipeline(id: string): Promise<PipelineRecord> {
	return apiFetch<PipelineRecord>(`/pipelines/${id}`);
}

export async function getPipelineRuns(
	id: string,
	limit?: number
): Promise<PipelineRun[]> {
	const qs = limit ? `?limit=${limit}` : '';
	return apiFetch<PipelineRun[]>(`/pipelines/${id}/runs${qs}`);
}

export async function triggerPipeline(id: string): Promise<PipelineRun> {
	return apiFetch<PipelineRun>(`/pipelines/${id}/trigger`, {
		method: 'POST'
	});
}

// ─── Marketplace ────────────────────────────────────────────────────────────

export async function listDataProducts(params?: {
	domain?: string;
	search?: string;
	min_quality?: number;
}): Promise<DataProduct[]> {
	const query = new URLSearchParams();
	if (params?.domain) query.set('domain', params.domain);
	if (params?.search) query.set('search', params.search);
	if (params?.min_quality !== undefined) query.set('min_quality', String(params.min_quality));
	const qs = query.toString();
	return apiFetch<DataProduct[]>(`/marketplace/products${qs ? `?${qs}` : ''}`);
}

export async function getDataProduct(id: string): Promise<DataProduct> {
	return apiFetch<DataProduct>(`/marketplace/products/${id}`);
}

export async function listDomains(): Promise<{ name: string; product_count: number }[]> {
	return apiFetch('/marketplace/domains');
}

// ─── Access Requests ────────────────────────────────────────────────────────

export async function listAccessRequests(params?: {
	status?: string;
	product_id?: string;
}): Promise<AccessRequest[]> {
	const query = new URLSearchParams();
	if (params?.status) query.set('status', params.status);
	if (params?.product_id) query.set('data_product_id', params.product_id);
	const qs = query.toString();
	return apiFetch<AccessRequest[]>(`/access${qs ? `?${qs}` : ''}`);
}

export async function createAccessRequest(request: {
	product_id: string;
	justification: string;
	access_level: 'read' | 'read_write' | 'admin';
	duration_days: number;
}): Promise<AccessRequest> {
	return apiFetch<AccessRequest>('/access', {
		method: 'POST',
		body: JSON.stringify(request)
	});
}

export async function approveAccessRequest(
	id: string,
	notes?: string
): Promise<AccessRequest> {
	return apiFetch<AccessRequest>(`/access/${id}/approve`, {
		method: 'POST',
		body: JSON.stringify({ notes })
	});
}

export async function denyAccessRequest(
	id: string,
	notes?: string
): Promise<AccessRequest> {
	return apiFetch<AccessRequest>(`/access/${id}/deny`, {
		method: 'POST',
		body: JSON.stringify({ notes })
	});
}

// ─── Monitoring / Stats ─────────────────────────────────────────────────────

export async function getHealth(): Promise<{
	status: string;
	timestamp: string;
	version: string;
}> {
	return apiFetch('/health');
}

export async function getStats(): Promise<PlatformStats> {
	return apiFetch('/monitoring/stats');
}
