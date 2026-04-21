/**
 * API client for the CSA-in-a-Box shared backend.
 * Communicates with portal/shared/api/ (FastAPI).
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-browser';
import type {
  SourceRecord,
  SourceRegistration,
  PipelineRecord,
  PipelineRun,
  DataProduct,
  QualityMetric,
  AccessRequest,
  PlatformStats,
  DomainOverview,
} from '@/types';
import { apiRequest } from './authConfig';
import { apiV1BaseUrl } from './apiClient';

/**
 * Base URL for all versioned CSA API calls.
 *
 * CSA-0123: resolved through `apiClient.apiV1BaseUrl` so that every
 * outbound call shares one source of truth for `NEXT_PUBLIC_API_URL`
 * with a `/api/v1` same-origin default. No hard-coded host/port.
 */
const API_URL = apiV1BaseUrl();

class ApiClient {
  private client: AxiosInstance;
  private msalInstance: PublicClientApplication | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor — acquires MSAL token silently
    this.client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      if (this.msalInstance) {
        const account = this.msalInstance.getActiveAccount();
        if (account) {
          try {
            const response = await this.msalInstance.acquireTokenSilent({
              scopes: apiRequest.scopes,
              account,
            });
            config.headers.Authorization = `Bearer ${response.accessToken}`;
          } catch (err) {
            if (err instanceof InteractionRequiredAuthError) {
              window.dispatchEvent(new CustomEvent('auth:expired'));
            }
          }
        }
      }
      return config;
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response?.status === 401) {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
        return Promise.reject(error);
      }
    );
  }

  /** Bind the MSAL instance so the interceptor can acquire tokens. */
  setMsalInstance(instance: PublicClientApplication): void {
    this.msalInstance = instance;
  }

  // ─── Sources ───────────────────────────────────────────────────────────

  async listSources(params?: {
    domain?: string;
    status?: string;
    source_type?: string;
  }): Promise<SourceRecord[]> {
    const { data } = await this.client.get('/sources', { params });
    return data;
  }

  async getSource(id: string): Promise<SourceRecord> {
    const { data } = await this.client.get(`/sources/${id}`);
    return data;
  }

  async registerSource(source: SourceRegistration): Promise<SourceRecord> {
    const { data } = await this.client.post('/sources', source);
    return data;
  }

  async updateSource(
    id: string,
    updates: Partial<SourceRegistration>
  ): Promise<SourceRecord> {
    const { data } = await this.client.patch(`/sources/${id}`, updates);
    return data;
  }

  async decommissionSource(id: string): Promise<SourceRecord> {
    const { data } = await this.client.post(`/sources/${id}/decommission`);
    return data;
  }

  async provisionSource(id: string): Promise<{ status: string; message: string }> {
    const { data } = await this.client.post(`/sources/${id}/provision`);
    return data;
  }

  async scanSource(id: string): Promise<{ status: string; scan_id: string }> {
    const { data } = await this.client.post(`/sources/${id}/scan`);
    return data;
  }

  // ─── Pipelines ─────────────────────────────────────────────────────────

  async listPipelines(params?: {
    source_id?: string;
    status?: string;
  }): Promise<PipelineRecord[]> {
    const { data } = await this.client.get('/pipelines', { params });
    return data;
  }

  async getPipeline(id: string): Promise<PipelineRecord> {
    const { data } = await this.client.get(`/pipelines/${id}`);
    return data;
  }

  async getPipelineRuns(
    id: string,
    params?: { limit?: number }
  ): Promise<PipelineRun[]> {
    const { data } = await this.client.get(`/pipelines/${id}/runs`, { params });
    return data;
  }

  async triggerPipeline(id: string): Promise<PipelineRun> {
    const { data } = await this.client.post(`/pipelines/${id}/trigger`);
    return data;
  }

  // ─── Marketplace ───────────────────────────────────────────────────────

  async listDataProducts(params?: {
    domain?: string;
    search?: string;
    min_quality?: number;
  }): Promise<DataProduct[]> {
    const { data } = await this.client.get('/marketplace/products', { params });
    return data;
  }

  async getDataProduct(id: string): Promise<DataProduct> {
    const { data } = await this.client.get(`/marketplace/products/${id}`);
    return data;
  }

  async getQualityHistory(
    productId: string,
    params?: { days?: number }
  ): Promise<QualityMetric[]> {
    const { data } = await this.client.get(
      `/marketplace/products/${productId}/quality`,
      { params }
    );
    return data;
  }

  async listDomains(): Promise<{ name: string; product_count: number }[]> {
    const { data } = await this.client.get('/marketplace/domains');
    return data;
  }

  async getMarketplaceStats(): Promise<Record<string, number>> {
    const { data } = await this.client.get('/marketplace/stats');
    return data;
  }

  // ─── Access Requests ───────────────────────────────────────────────────

  async listAccessRequests(params?: {
    status?: string;
    data_product_id?: string;
  }): Promise<AccessRequest[]> {
    const { data } = await this.client.get('/access', { params });
    return data;
  }

  async createAccessRequest(request: {
    data_product_id: string;
    justification: string;
    access_level: 'read' | 'read_write' | 'admin';
    duration_days: number;
  }): Promise<AccessRequest> {
    const { data } = await this.client.post('/access', request);
    return data;
  }

  async approveAccessRequest(
    id: string,
    notes?: string
  ): Promise<AccessRequest> {
    const { data } = await this.client.post(`/access/${id}/approve`, { notes });
    return data;
  }

  async denyAccessRequest(
    id: string,
    notes?: string
  ): Promise<AccessRequest> {
    const { data } = await this.client.post(`/access/${id}/deny`, { notes });
    return data;
  }

  // ─── Monitoring ────────────────────────────────────────────────────────

  async getHealth(): Promise<{
    status: string;
    timestamp: string;
    services: Record<string, string>;
  }> {
    const { data } = await this.client.get('/health');
    return data;
  }

  async getStats(): Promise<PlatformStats> {
    const { data } = await this.client.get('/stats');
    return data;
  }

  async getDomainOverview(): Promise<DomainOverview[]> {
    const { data } = await this.client.get('/domains');
    return data;
  }
}

// Singleton instance
export const api = new ApiClient();
export default api;
