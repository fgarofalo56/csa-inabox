'use client';

/**
 * use-canvas-suggestion (W7) — the client hook that drives the ambient inline
 * Copilot ghost node. It serializes the CURRENT canvas graph, requests a
 * next-step suggestion from the canvas-suggest BFF route (REAL AOAI via the
 * unified client), and exposes the loading/suggestion/gate state the host feeds
 * into the ghost node's `aiSuggestion` variant. Accept → the host materializes
 * the suggested node; Dismiss → the host hides it (and suppresses re-suggesting
 * the same graph until it changes).
 *
 * Honest gate: when AOAI is unconfigured the route returns 503 code:'no_aoai';
 * this hook surfaces `gate` (the remediation hint) so the host can show a Fluent
 * MessageBar naming LOOM_AOAI_ENDPOINT rather than silently failing.
 */

import { useCallback, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import type { CanvasSuggestion, CanvasTopology } from './canvas-suggest';

export interface UseCanvasSuggestionResult {
  suggestion: CanvasSuggestion | null;
  loading: boolean;
  error: string | null;
  /** Set when AOAI is not configured — the honest remediation message. */
  gate: string | null;
  /** Request a suggestion for the given topology. No-op while already loading. */
  request: (topology: CanvasTopology) => Promise<void>;
  /** Clear the current suggestion (Dismiss / after Accept). */
  clear: () => void;
}

function url(itemType: string, itemId: string): string {
  return `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/canvas-suggest`;
}

export function useCanvasSuggestion(
  itemType: string,
  itemId: string | undefined,
): UseCanvasSuggestionResult {
  const [suggestion, setSuggestion] = useState<CanvasSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  const request = useCallback(async (topology: CanvasTopology) => {
    if (!itemId || loading) return;
    setLoading(true);
    setError(null);
    setGate(null);
    setSuggestion(null);
    try {
      const r = await clientFetch(url(itemType, itemId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topology }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.code === 'no_aoai') {
        setGate(j?.hint || j?.error || 'Azure OpenAI is not configured (set LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT).');
        return;
      }
      if (!r.ok || !j?.ok || !j?.suggestion) {
        setError(j?.error || `HTTP ${r.status}`);
        return;
      }
      setSuggestion(j.suggestion as CanvasSuggestion);
    } catch (e: any) {
      setError(e?.message || 'could not get a suggestion');
    } finally {
      setLoading(false);
    }
  }, [itemType, itemId, loading]);

  const clear = useCallback(() => { setSuggestion(null); setError(null); }, []);

  return { suggestion, loading, error, gate, request, clear };
}
