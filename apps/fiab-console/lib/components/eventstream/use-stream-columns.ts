'use client';

/**
 * useStreamColumns — the REAL column names flowing through an eventstream,
 * for the geo operators' column-mapping dropdowns (no freeform typing —
 * loom_no_freeform_config).
 *
 * Source of truth, in order:
 *   1. LIVE events peeked from the stream's source via the existing
 *      `GET /api/items/eventstream/[id]/events` route (the same real backend
 *      the DataPreviewDock renders), shaped with shapeEventPreview — body
 *      columns only (system partition/enqueued columns excluded).
 *   2. Column names already referenced elsewhere in the saved topology
 *      (groupBy / selectFields / cdcColumns / manage-fields sources / geo
 *      lat-lon slots …) — so a designer editing offline still gets options.
 *
 * When neither yields anything the hook reports an HONEST empty state with the
 * exact remediation (send a test event from the Data preview dock) — never a
 * fabricated column list (no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { shapeEventPreview, SYS_PARTITION, SYS_ENQUEUED, type RawPreviewEvent } from './preview-shaping';

/** Pure: collect every column name the topology already references. */
export function topologyColumnHints(topology: { sources?: any[]; transforms?: any[]; sinks?: any[] }): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && !v.includes('(') && !v.includes('*')) out.add(v.trim());
  };
  for (const t of topology?.transforms || []) {
    (t?.groupBy || []).forEach(add);
    (t?.selectFields || []).forEach(add);
    (t?.cdcColumns || []).forEach(add);
    (t?.cdcKeyColumns || []).forEach(add);
    (Array.isArray(t?.fieldMap) ? t.fieldMap : []).forEach((m: any) => { add(m?.source); add(m?.target); });
    (Array.isArray(t?.aggregates) ? t.aggregates : []).forEach((a: any) => { add(a?.field); add(a?.alias); });
    add(t?.timestampBy);
    add(t?.expandField); add(t?.expandOutput);
    // Geo slots — a downstream node can pick what an upstream geo node emits.
    add(t?.latColumn); add(t?.lonColumn); add(t?.pointColumn); add(t?.pointAlias);
    add(t?.fenceOutputColumn); add(t?.distanceAlias); add(t?.regionColumn);
    add(t?.rightLatColumn); add(t?.rightLonColumn); add(t?.rightPointColumn);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export interface StreamColumnsState {
  /** Union of live body columns + topology hints, sorted; live columns first. */
  columns: string[];
  /** Columns that came from REAL peeked events (subset of `columns`). */
  liveColumns: string[];
  loading: boolean;
  /** Honest remediation when no live columns could be discovered. */
  gate: string | null;
  refresh: () => void;
}

const LAST_24H_MS = 24 * 60 * 60 * 1000;

/**
 * Discover the stream's real columns. `itemId` may be absent (pre-save /new
 * surface) — then only topology hints are returned, with the honest gate.
 */
export function useStreamColumns(
  itemId: string | undefined,
  topology: { sources?: any[]; transforms?: any[]; sinks?: any[] },
): StreamColumnsState {
  const [liveColumns, setLiveColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!itemId || itemId === 'new') {
      setGate('Save the stream, then send a test event from the Data preview dock to discover live columns.');
      return;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await clientFetch(
          `/api/items/eventstream/${itemId}/events?nodeIdx=0&maxEvents=30&sinceMs=${LAST_24H_MS}`,
        );
        const j = await r.json().catch(() => null);
        if (!alive) return;
        const events: RawPreviewEvent[] = Array.isArray(j?.events) ? j.events : [];
        if (j?.ok && events.length) {
          const shape = shapeEventPreview(events);
          const cols = shape.columns
            .filter((c) => !c.system && c.key !== SYS_PARTITION && c.key !== SYS_ENQUEUED)
            .map((c) => c.key);
          setLiveColumns(cols);
          setGate(cols.length ? null : 'The peeked events carried no body columns — send a richer test event from the Data preview dock.');
        } else {
          setLiveColumns([]);
          setGate(
            j?.hint || j?.error ||
            'No live events available yet — send a test event from the Data preview dock (POST /events) or provision the source, then Refresh.',
          );
        }
      } catch (e: any) {
        if (!alive) return;
        setLiveColumns([]);
        setGate(e?.message || 'Live column discovery failed — send a test event from the Data preview dock, then Refresh.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [itemId, nonce]);

  const hints = useMemo(() => topologyColumnHints(topology), [topology]);

  const columns = useMemo(() => {
    const seen = new Set(liveColumns);
    return [...liveColumns, ...hints.filter((h) => !seen.has(h))];
  }, [liveColumns, hints]);

  return { columns, liveColumns, loading, gate, refresh };
}
