'use client';
/**
 * "Update all variables" — the one Lakehouse-ribbon command Fabric has and Loom
 * did not (#3538, measured 2026-08-15 against `fabriccaplimitlessdatadev`).
 *
 * WHAT IT DOES, AND WHY IT IS A REAL CALL RATHER THAN A LABEL. Fabric's command
 * re-reads every Variable Library the item can see so a pipeline/notebook run
 * picks up values changed since the workspace was opened. Loom's equivalent is
 * the same two real routes the Variable Library editor itself uses:
 *   1. `GET  /api/items?type=variable-library[&workspaceId=…]` — the libraries.
 *   2. `POST /api/items/variable-library/<id>/resolve`          — per library,
 *      which re-reads the active value set and dereferences `secret-ref` rows
 *      out of Key Vault server-side. Secret MATERIAL never crosses this
 *      boundary; the route masks it (`resolve/route.ts`).
 * No Fabric workspace is involved on either (`no-fabric-dependency.md`), and
 * nothing here asks the operator to bind anything (`auto-bind-by-default.md`).
 *
 * THREE OUTCOMES ARE KEPT DISTINCT, deliberately (`deploy-integrity.md` R7):
 *   - the LIST call failed          → `loadError`, and no update is offered;
 *   - a library's RESOLVE call failed → that row's `error`;
 *   - a library resolved but some VARIABLES did not → that row's `failed` count
 *     plus `firstError`.
 * Collapsing the last two would let "the call never landed" render as "0
 * variables failed", which is the shape R7 forbids.
 */
import { useState, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import type { VariableLibraryRow, VariableUpdateResult } from '../types';

interface ListResponse {
  ok?: boolean;
  error?: string;
  items?: VariableLibraryRow[];
  truncated?: boolean;
  hint?: string;
}

interface ResolveResponse {
  ok?: boolean;
  error?: string;
  valueSet?: string;
  resolved?: { name: string; error?: string }[];
}

export function useUpdateVariables(workspaceId?: string) {
  const [uvOpen, setUvOpen] = useState(false);
  const [uvLibraries, setUvLibraries] = useState<VariableLibraryRow[] | null>(null);
  const [uvLoadError, setUvLoadError] = useState<string | null>(null);
  /**
   * `/api/items` bounds its walk and SAYS SO. A partial list re-resolved and
   * reported as "all variable libraries" would be a false claim, so the flag is
   * carried through to the dialog rather than dropped here.
   */
  const [uvTruncatedHint, setUvTruncatedHint] = useState<string | null>(null);
  const [uvBusy, setUvBusy] = useState(false);
  const [uvResults, setUvResults] = useState<VariableUpdateResult[] | null>(null);

  const openUpdateVariables = useCallback(async () => {
    setUvOpen(true);
    setUvLibraries(null); setUvLoadError(null); setUvResults(null); setUvTruncatedHint(null);
    try {
      const qs = new URLSearchParams({ type: 'variable-library' });
      if (workspaceId) qs.set('workspaceId', workspaceId);
      const r = await clientFetch(`/api/items?${qs.toString()}`);
      const j = await parseJsonOrError<ListResponse>(r, 'List variable libraries');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setUvLibraries(j.items || []);
      if (j.truncated === true) {
        setUvTruncatedHint(j.hint || 'This list is incomplete — the item walk was bounded.');
      }
    } catch (e: any) {
      setUvLoadError(e?.message || String(e));
    }
  }, [workspaceId]);

  const updateAllVariables = useCallback(async () => {
    const libs = uvLibraries || [];
    if (!libs.length) return;
    setUvBusy(true); setUvResults(null);
    const out: VariableUpdateResult[] = [];
    // Sequential on purpose: each resolve can hit Key Vault, and a workspace
    // with a dozen libraries fanned out in parallel is a throttling incident,
    // not a faster refresh.
    for (const lib of libs) {
      try {
        const r = await clientFetch(`/api/items/variable-library/${encodeURIComponent(lib.id)}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j = await parseJsonOrError<ResolveResponse>(r, 'Resolve variables');
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        const rows = j.resolved || [];
        const failedRows = rows.filter((v) => !!v.error);
        out.push({
          id: lib.id,
          name: lib.displayName,
          valueSet: j.valueSet,
          resolved: rows.length - failedRows.length,
          failed: failedRows.length,
          firstError: failedRows[0]?.error,
        });
      } catch (e: any) {
        out.push({ id: lib.id, name: lib.displayName, resolved: 0, failed: 0, error: e?.message || String(e) });
      }
    }
    setUvResults(out);
    setUvBusy(false);
  }, [uvLibraries]);

  return {
    uvOpen, setUvOpen,
    uvLibraries, uvLoadError, uvTruncatedHint,
    uvBusy, uvResults,
    openUpdateVariables, updateAllVariables,
  };
}
