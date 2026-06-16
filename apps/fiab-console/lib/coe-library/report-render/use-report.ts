'use client';

/**
 * useReportModel — fetch a CoE report's render model (+ sample data) from a BFF
 * endpoint and expose loading / error / data to a client component.
 *
 * Used by every report viewer surface (template Preview "Report" tab, cloned
 * template "Open", and the org-reports consumer gallery), each pointing at its
 * own session-gated endpoint:
 *   /api/admin/coe-library/render?templateId= | ?cloneId=
 *   /api/org-reports/render?id=
 *
 * Returns the parsed ReportModel and SampleData; the actual rendering is done by
 * <ReportCanvas>. Real fetch only — no mock data.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReportModel } from './pbir-parse';
import type { SampleData } from './tmdl-sample';

export interface ReportPayload {
  model: ReportModel;
  sample: SampleData;
  template?: { title: string; description?: string; category?: string };
  published?: boolean;
}

export interface UseReportResult {
  data: ReportPayload | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useReportModel(url: string | null): UseReportResult {
  const [data, setData] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j?.error || `HTTP ${r.status}`);
        setData(null);
        return;
      }
      setData({ model: j.model, sample: j.sample, template: j.template, published: j.published });
    } catch (e: any) {
      setError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setData(null);
    if (url) load();
  }, [url, load]);

  return { data, loading, error, reload: load };
}
