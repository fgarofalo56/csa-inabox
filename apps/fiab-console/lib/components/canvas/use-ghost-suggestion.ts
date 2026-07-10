'use client';

/**
 * useGhostSuggestion — the client half of the W7 canvas suggestion engine.
 *
 * Any React Flow canvas that renders a node-kit ghost next-step node can adopt
 * AOAI-driven suggestions by handing this hook the current graph (item type +
 * nodes + edges + the palette keys it can legally add). The hook debounces a
 * POST to /api/canvas/suggest-next, exposes the top suggestion + a loading flag
 * for the ghost card, and remembers dismissals per graph-signature so a
 * dismissed suggestion does not immediately re-appear for the same graph.
 *
 * Fail-soft: any error / honest 503 gate / kill-switch `disabled` simply yields
 * no suggestion, and the ghost falls back to its static palette menu. No spend,
 * no crash. Uses clientFetch (bounded, same-session credentials) — never a bare
 * fetch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import type { CanvasSuggestion, SuggestNode, SuggestEdge } from '@/lib/copilot/canvas-suggest';

export interface GhostSuggestionInput {
  /** Master enable (default-ON per adopter; false → hook is inert). */
  enabled: boolean;
  /** Item type for grounding, e.g. 'data-pipeline'. */
  itemType: string;
  nodes: SuggestNode[];
  edges: SuggestEdge[];
  /** Palette keys the canvas can insert — constrains the suggestion. */
  paletteKeys: string[];
  /** Debounce before asking AOAI after the graph settles (ms). */
  debounceMs?: number;
}

export interface GhostSuggestionState {
  suggestion: CanvasSuggestion | null;
  loading: boolean;
  /** Hide the current suggestion and suppress it for this exact graph. */
  dismiss: () => void;
}

/** Stable signature of the graph the suggestion is grounded on. */
function signatureOf(itemType: string, nodes: SuggestNode[], edges: SuggestEdge[]): string {
  const nodeSig = nodes.map((n) => `${n.id}:${n.type ?? ''}`).sort().join('|');
  const edgeSig = edges.map((e) => `${e.source}>${e.target}`).sort().join('|');
  return `${itemType}#${nodeSig}#${edgeSig}`;
}

export function useGhostSuggestion(input: GhostSuggestionInput): GhostSuggestionState {
  const { enabled, itemType, nodes, edges, paletteKeys, debounceMs = 900 } = input;

  const [suggestion, setSuggestion] = useState<CanvasSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const dismissedRef = useRef<Set<string>>(new Set());
  const reqIdRef = useRef(0);

  const signature = useMemo(() => signatureOf(itemType, nodes, edges), [itemType, nodes, edges]);
  // Serialize the payload once so the effect depends on stable primitives.
  const payload = useMemo(
    () => JSON.stringify({ itemType, nodes, edges, paletteKeys }),
    [itemType, nodes, edges, paletteKeys],
  );

  const dismiss = useCallback(() => {
    dismissedRef.current.add(signature);
    setSuggestion(null);
  }, [signature]);

  useEffect(() => {
    // Inert when disabled, on an empty graph, or with no palette to draw from.
    if (!enabled || nodes.length === 0 || paletteKeys.length === 0) {
      setSuggestion(null);
      setLoading(false);
      return;
    }
    if (dismissedRef.current.has(signature)) {
      setSuggestion(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const reqId = ++reqIdRef.current;
    // Drop any stale suggestion from a prior graph so the ghost shows the
    // thinking state (not the old node) while we re-ground on the new graph.
    setSuggestion(null);
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await clientFetch('/api/canvas/suggest-next', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          suggestions?: CanvasSuggestion[];
        };
        if (cancelled || reqId !== reqIdRef.current) return;
        const top = j.ok && Array.isArray(j.suggestions) ? j.suggestions[0] ?? null : null;
        setSuggestion(top);
      } catch {
        // Fail-soft: no suggestion, ghost falls back to its static menu.
        if (!cancelled && reqId === reqIdRef.current) setSuggestion(null);
      } finally {
        if (!cancelled && reqId === reqIdRef.current) setLoading(false);
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // signature keys the dismissal set; payload carries the actual request body.
  }, [enabled, signature, payload, nodes.length, paletteKeys.length, debounceMs]);

  return { suggestion, loading, dismiss };
}
