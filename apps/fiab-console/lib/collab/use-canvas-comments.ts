'use client';

/**
 * use-canvas-comments (W4) — the client hook backing the shared canvas-comment
 * layer. Loads the comments for one (item, canvas), and exposes add/edit/delete/
 * resolve — each a REAL clientFetch to the canvas-comments BFF routes (session
 * cookie carried; owner checks enforced server-side). Any canvas mounts it and
 * renders the returned comments as `StickyCommentNode`s.
 *
 * No-vaporware: no mock arrays — an empty canvas returns []. The BFF is the
 * single source of truth; local state mirrors it optimistically then reconciles
 * on the server response.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import type { CanvasCommentColor, CanvasCommentKind, CanvasCommentView } from './canvas-comment-model';

export interface UseCanvasCommentsResult {
  comments: CanvasCommentView[];
  loading: boolean;
  error: string | null;
  /** Reload from the server. */
  refresh: () => void;
  /** Create a comment/sticky at flow-coordinates. Returns the created view (or null). */
  add: (input: {
    text: string;
    x: number;
    y: number;
    kind?: CanvasCommentKind;
    color?: CanvasCommentColor;
  }) => Promise<CanvasCommentView | null>;
  /** Edit fields on a comment the caller authored. */
  edit: (id: string, patch: Partial<Pick<CanvasCommentView, 'text' | 'x' | 'y' | 'color' | 'resolved'>>) => Promise<void>;
  /** Delete a comment the caller authored. */
  remove: (id: string) => Promise<void>;
}

function base(itemType: string, itemId: string): string {
  return `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/canvas-comments`;
}

export function useCanvasComments(
  itemType: string,
  itemId: string | undefined,
  canvasKey = 'default',
): UseCanvasCommentsResult {
  const [comments, setComments] = useState<CanvasCommentView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!itemId) return;
    setLoading(true);
    setError(null);
    clientFetch(`${base(itemType, itemId)}?canvasKey=${encodeURIComponent(canvasKey)}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
        setComments(Array.isArray(j.comments) ? j.comments : []);
      })
      .catch((e) => setError(e?.message || 'could not load comments'))
      .finally(() => setLoading(false));
  }, [itemType, itemId, canvasKey]);

  useEffect(() => { refresh(); }, [refresh]);

  const add = useCallback<UseCanvasCommentsResult['add']>(async (input) => {
    if (!itemId) return null;
    const r = await clientFetch(base(itemType, itemId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasKey, ...input }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) { setError(j?.error || `HTTP ${r.status}`); return null; }
    setComments((prev) => [...prev, j.comment]);
    return j.comment as CanvasCommentView;
  }, [itemType, itemId, canvasKey]);

  const edit = useCallback<UseCanvasCommentsResult['edit']>(async (id, patch) => {
    if (!itemId) return;
    // Optimistic local merge; reconcile with the server view on success.
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const r = await clientFetch(`${base(itemType, itemId)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) { setError(j?.error || `HTTP ${r.status}`); refresh(); return; }
    setComments((prev) => prev.map((c) => (c.id === id ? (j.comment as CanvasCommentView) : c)));
  }, [itemType, itemId, refresh]);

  const remove = useCallback<UseCanvasCommentsResult['remove']>(async (id) => {
    if (!itemId) return;
    const prevList = comments;
    setComments((prev) => prev.filter((c) => c.id !== id)); // optimistic
    const r = await clientFetch(`${base(itemType, itemId)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) { setError(j?.error || `HTTP ${r.status}`); setComments(prevList); }
  }, [itemType, itemId, comments]);

  return { comments, loading, error, refresh, add, edit, remove };
}
