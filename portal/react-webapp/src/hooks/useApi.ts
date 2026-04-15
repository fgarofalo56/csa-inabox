/**
 * React Query hooks for the CSA-in-a-Box API.
 * Provides cached, auto-refreshing data access with optimistic updates.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type {
  SourceRegistration,
  SourceRecord,
  PipelineRecord,
  DataProduct,
  AccessRequest,
} from '@/types';

// ─── Source Hooks ──────────────────────────────────────────────────────────

export function useSources(params?: {
  domain?: string;
  status?: string;
  source_type?: string;
}) {
  return useQuery({
    queryKey: ['sources', params],
    queryFn: () => api.listSources(params),
    staleTime: 30_000,
  });
}

export function useSource(id: string) {
  return useQuery({
    queryKey: ['sources', id],
    queryFn: () => api.getSource(id),
    enabled: !!id,
  });
}

export function useRegisterSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: SourceRegistration) => api.registerSource(source),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useUpdateSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Partial<SourceRegistration>;
    }) => api.updateSource(id, updates),
    onSuccess: (data: SourceRecord) => {
      queryClient.setQueryData(['sources', data.id], data);
      queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

export function useDecommissionSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.decommissionSource(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

export function useProvisionSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.provisionSource(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
  });
}

// ─── Pipeline Hooks ────────────────────────────────────────────────────────

export function usePipelines(params?: {
  source_id?: string;
  status?: string;
}) {
  return useQuery({
    queryKey: ['pipelines', params],
    queryFn: () => api.listPipelines(params),
    staleTime: 15_000,
    refetchInterval: 30_000, // Auto-refresh for active monitoring
  });
}

export function usePipeline(id: string) {
  return useQuery({
    queryKey: ['pipelines', id],
    queryFn: () => api.getPipeline(id),
    enabled: !!id,
  });
}

export function usePipelineRuns(id: string, limit?: number) {
  return useQuery({
    queryKey: ['pipelines', id, 'runs', limit],
    queryFn: () => api.getPipelineRuns(id, { limit }),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

export function useTriggerPipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.triggerPipeline(id),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['pipelines', id, 'runs'] });
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
    },
  });
}

// ─── Marketplace Hooks ─────────────────────────────────────────────────────

export function useDataProducts(params?: {
  domain?: string;
  search?: string;
  min_quality?: number;
}) {
  return useQuery({
    queryKey: ['marketplace', 'products', params],
    queryFn: () => api.listDataProducts(params),
    staleTime: 60_000,
  });
}

export function useDataProduct(id: string) {
  return useQuery({
    queryKey: ['marketplace', 'products', id],
    queryFn: () => api.getDataProduct(id),
    enabled: !!id,
  });
}

export function useQualityHistory(productId: string, days?: number) {
  return useQuery({
    queryKey: ['marketplace', 'products', productId, 'quality', days],
    queryFn: () => api.getQualityHistory(productId, { days }),
    enabled: !!productId,
  });
}

export function useDomains() {
  return useQuery({
    queryKey: ['marketplace', 'domains'],
    queryFn: () => api.listDomains(),
    staleTime: 300_000,
  });
}

export function useMarketplaceStats() {
  return useQuery({
    queryKey: ['marketplace', 'stats'],
    queryFn: () => api.getMarketplaceStats(),
    staleTime: 60_000,
  });
}

// ─── Access Request Hooks ──────────────────────────────────────────────────

export function useAccessRequests(params?: {
  status?: string;
  data_product_id?: string;
}) {
  return useQuery({
    queryKey: ['access', params],
    queryFn: () => api.listAccessRequests(params),
    staleTime: 30_000,
  });
}

export function useCreateAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: {
      data_product_id: string;
      justification: string;
      access_level: 'read' | 'read_write' | 'admin';
      duration_days: number;
    }) => api.createAccessRequest(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useApproveAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      api.approveAccessRequest(id, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access'] });
    },
  });
}

export function useDenyAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      api.denyAccessRequest(id, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access'] });
    },
  });
}

// ─── Monitoring Hooks ──────────────────────────────────────────────────────

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useStats() {
  return useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats(),
    staleTime: 30_000,
  });
}

export function useDomainOverview() {
  return useQuery({
    queryKey: ['domains'],
    queryFn: () => api.getDomainOverview(),
    staleTime: 60_000,
  });
}
