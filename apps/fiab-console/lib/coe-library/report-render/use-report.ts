'use client';

/**
 * useReportModel — fetch a CoE report's render model from a BFF endpoint and
 * expose loading / error / data to a client component.
 *
 * Used by every report viewer surface (template Preview "Report" tab, cloned
 * template "Open", and the org-reports consumer gallery), each pointing at its
 * own session-gated endpoint:
 *   /api/admin/coe-library/render?templateId= | ?cloneId=  [&mode=live]
 *   /api/org-reports/render?id=                            [&mode=live]
 *
 * The hook accepts either a plain GET url (back-compat) or a {@link FetchSpec}
 * (so a live render with parameter overrides can POST a JSON body). It returns
 * the parsed ReportModel + the bundled SAMPLE data and, for a live render, the
 * per-entity `live` table-set + `dataSources` provenance and effective `params`.
 * Real fetch only — no mock data.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReportModel } from './pbir-parse';
import type { SampleData } from './tmdl-sample';

export type EntitySource = 'live' | 'empty' | 'error';
export interface EntityProvenance { source: EntitySource; note?: string }

export interface ReportParams {
  tenantId: string;
  subscriptionId: string;
  subscriptionIds: string[];
  billingScope: string;
  logAnalyticsWorkspaceId: string;
  managementApiBase: string;
}

export interface ReportPayload {
  model: ReportModel;
  sample: SampleData;
  /** Live render: per-entity render data (live table when available, else a real empty table). */
  live?: SampleData;
  /** Live render: per-entity provenance for truthful labelling. */
  dataSources?: Record<string, EntityProvenance>;
  /** Effective parameters used by the render (defaults from env + overrides). */
  params?: ReportParams;
  template?: { title: string; description?: string; category?: string };
  published?: boolean;
  mode?: string;
  /** Set when the whole live render failed defensively; per-entity tables render empty. */
  liveError?: string;
}

export interface FetchSpec {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export interface UseReportResult {
  data: ReportPayload | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function normalize(spec: string | FetchSpec | null): FetchSpec | null {
  if (spec == null) return null;
  if (typeof spec === 'string') return { url: spec, method: 'GET' };
  return spec;
}

/** Stable key so an inline-object spec doesn't refetch on every render. */
function specKey(spec: FetchSpec | null): string {
  if (!spec) return '';
  return `${spec.method || 'GET'} ${spec.url} ${spec.body ? JSON.stringify(spec.body) : ''}`;
}

export function useReportModel(spec: string | FetchSpec | null): UseReportResult {
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const norm = normalize(spec);
  const key = specKey(norm);
  const specRef = useRef(norm);
  specRef.current = norm;

  const load = useCallback(async () => {
    const s = specRef.current;
    if (!s) return;
    setLoading(true);
    setError(null);
    try {
      const init: RequestInit = { method: s.method || 'GET' };
      if (s.method === 'POST') {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(s.body ?? {});
      }
      const r = await fetch(s.url, init);
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j?.error || `HTTP ${r.status}`);
        setData(null);
        return;
      }
      setData({
        model: j.model,
        sample: j.sample,
        live: j.live,
        dataSources: j.dataSources,
        params: j.params,
        template: j.template,
        published: j.published,
        mode: j.mode,
        liveError: j.liveError,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    if (key) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load]);

  return { data, loading, error, reload: load };
}
