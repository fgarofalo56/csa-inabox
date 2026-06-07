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

import { useEffect, useState } from 'react';
import type { AdfDataset, AdfLinkedService } from '@/lib/azure/adf-client';

export interface CopyResources {
  datasets: AdfDataset[];
  linkedServices: AdfLinkedService[];
  /** Honest infra-gate text (names the missing env var) or generic load error. */
  gateError: string | null;
  loading: boolean;
}

export function useCopyResources(): CopyResources {
  const [datasets, setDatasets] = useState<AdfDataset[]>([]);
  const [linkedServices, setLinkedServices] = useState<AdfLinkedService[]>([]);
  const [gateError, setGateError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [dsRes, lsRes] = await Promise.all([
          fetch('/api/adf/datasets').then((r) => r.json()).catch(() => ({ ok: false })),
          fetch('/api/adf/linked-services').then((r) => r.json()).catch(() => ({ ok: false })),
        ]);
        if (!alive) return;
        if (dsRes?.ok && Array.isArray(dsRes.datasets)) {
          setDatasets(dsRes.datasets);
        } else if (dsRes?.error) {
          setGateError(String(dsRes.error));
        }
        if (lsRes?.ok && Array.isArray(lsRes.linkedServices)) {
          setLinkedServices(lsRes.linkedServices);
        } else if (lsRes?.error && !dsRes?.error) {
          setGateError(String(lsRes.error));
        }
      } catch {
        if (alive) setGateError('Could not reach the Data Factory API.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return { datasets, linkedServices, gateError, loading };
}
