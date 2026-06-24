'use client';

/**
 * useCopyResources — single fetch of the factory's datasets + linked services,
 * shared across the Copy activity's Source / Sink / Mapping / Settings tabs.
 *
 * Both the dataset pickers (Source/Sink) and the staging/redirect linked-service
 * pickers (Settings) read the same two ARM lists, and Mapping derives schemas
 * from the already-loaded datasets — so we fetch once here and pass the result
 * down as props rather than firing four parallel requests per Copy node.
 *
 * Real BFF routes, no mocks:
 *   GET /api/adf/datasets         → { ok, datasets:  AdfDataset[] }
 *   GET /api/adf/linked-services  → { ok, linkedServices: AdfLinkedService[] }
 *
 * When the factory isn't configured both routes 503 with
 * `{ ok:false, code:'not_configured', error:'… set LOOM_… .' }`; we surface
 * that text via `gateError` so each tab can render an honest MessageBar while
 * still showing its full control surface (per no-vaporware.md / ui-parity.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdfDataset, AdfLinkedService } from '@/lib/azure/adf-client';

export interface CopyResources {
  datasets: AdfDataset[];
  linkedServices: AdfLinkedService[];
  /** Honest infra-gate text (names the missing env var) or generic load error. */
  gateError: string | null;
  loading: boolean;
  /**
   * Re-fetch both lists. The Source / Sink tabs call this after the inline
   * "＋ New" dataset wizard upserts a dataset, so the freshly-created dataset's
   * full `properties` (type, schema, linked service) become available to the
   * Mapping tab and the per-store format/store settings without a remount.
   */
  reload: () => Promise<void>;
}

export function useCopyResources(): CopyResources {
  const [datasets, setDatasets] = useState<AdfDataset[]>([]);
  const [linkedServices, setLinkedServices] = useState<AdfLinkedService[]>([]);
  const [gateError, setGateError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dsRes, lsRes] = await Promise.all([
        fetch('/api/adf/datasets').then((r) => r.json()).catch(() => ({ ok: false })),
        fetch('/api/adf/linked-services').then((r) => r.json()).catch(() => ({ ok: false })),
      ]);
      if (!aliveRef.current) return;
      let nextGate: string | null = null;
      if (dsRes?.ok && Array.isArray(dsRes.datasets)) {
        setDatasets(dsRes.datasets);
      } else if (dsRes?.error) {
        nextGate = String(dsRes.error);
      }
      if (lsRes?.ok && Array.isArray(lsRes.linkedServices)) {
        setLinkedServices(lsRes.linkedServices);
      } else if (lsRes?.error && !dsRes?.error) {
        nextGate = String(lsRes.error);
      }
      setGateError(nextGate);
    } catch {
      if (aliveRef.current) setGateError('Could not reach the Data Factory API.');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => { aliveRef.current = false; };
  }, [load]);

  return { datasets, linkedServices, gateError, loading, reload: load };
}
