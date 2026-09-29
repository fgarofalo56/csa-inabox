'use client';
/**
 * "Check variables" — a READ-ONLY health check over the Variable Libraries in
 * this lakehouse's workspace. It reports which variables fail to resolve. It
 * changes nothing.
 *
 * WHAT IT CALLS. Two existing routes, both reads:
 *   1. `GET  /api/items?type=variable-library&workspaceId=…` — the libraries.
 *   2. `POST /api/items/variable-library/<id>/resolve`       — per library.
 *      The route loads the library, runs the pure `resolveVariableSet`
 *      (`lib/variables/resolve.ts`), dereferences `secret-ref` rows out of Key
 *      Vault server-side, and returns JSON. It persists nothing and invalidates
 *      no cache, and the Key Vault reads are `cache: 'no-store'`. POST is the
 *      route's verb, not a write. Secret MATERIAL never crosses this boundary;
 *      the route masks it.
 * So nothing on the estate differs after a check. That is why this is not
 * called "update" — an earlier revision was, and the label claimed an effect
 * the code does not have (`no-vaporware.md`, `deploy-integrity.md` R7).
 *
 * WHAT IT IS NOT: Fabric's Lakehouse-ribbon "Update all variables". Per
 * Microsoft Learn (`fabric/cicd/variable-library/variable-library-overview`,
 * "Supported items", and `fabric/onelake/assign-variables-to-shortcuts`) a
 * lakehouse consumes a Variable Library only through VARIABLE-BOUND SHORTCUTS,
 * and that command re-evaluates them. Loom's lakehouse shortcuts are not
 * variable-bound, so there is nothing for such a command to act on yet. That
 * parity gap is #3538 and stays open; this check is a Loom-only affordance.
 *
 * THREE OUTCOMES ARE KEPT DISTINCT (`deploy-integrity.md` R7):
 *   - the LIST call failed            → `cvLoadError`, and no check is offered;
 *   - a library's RESOLVE call failed → that row's `error`;
 *   - a library resolved but some VARIABLES did not → that row's `failed` count
 *     plus `firstError`.
 * Collapsing the last two would let "the call never landed" render as "0
 * variables failed".
 *
 * THE WORKSPACE IS REQUIRED. Without it the list route drops its filter and
 * returns every library the caller owns in EVERY workspace, which is not what
 * this lakehouse's check should report on. The ribbon action is disabled until
 * the item has loaded; `openCheckVariables` refuses on its own as well, so a
 * caller that is not the ribbon cannot reach the unfiltered list either.
 */
import { useState, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import type { VariableLibraryRow, VariableCheckResult } from '../types';

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

/** The load error shown when the check is opened before the item has loaded. */
export const CHECK_VARIABLES_NO_WORKSPACE =
  'This lakehouse has not finished loading, so its workspace is not known yet. Try again in a moment.';

export function useCheckVariables(workspaceId?: string) {
  const [cvOpen, setCvOpen] = useState(false);
  const [cvLibraries, setCvLibraries] = useState<VariableLibraryRow[] | null>(null);
  const [cvLoadError, setCvLoadError] = useState<string | null>(null);
  /**
   * `/api/items` bounds its walk and SAYS SO. A check over a partial list
   * reported as covering "every library" would be a false claim, so the flag is
   * carried through to the dialog rather than dropped here.
   */
  const [cvTruncatedHint, setCvTruncatedHint] = useState<string | null>(null);
  const [cvBusy, setCvBusy] = useState(false);
  const [cvResults, setCvResults] = useState<VariableCheckResult[] | null>(null);

  const openCheckVariables = useCallback(async () => {
    setCvOpen(true);
    setCvLibraries(null); setCvLoadError(null); setCvResults(null); setCvTruncatedHint(null);
    if (!workspaceId) {
      setCvLoadError(CHECK_VARIABLES_NO_WORKSPACE);
      return;
    }
    try {
      const qs = new URLSearchParams({ type: 'variable-library', workspaceId });
      const r = await clientFetch(`/api/items?${qs.toString()}`);
      const j = await parseJsonOrError<ListResponse>(r, 'List variable libraries');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCvLibraries(j.items || []);
      if (j.truncated === true) {
        setCvTruncatedHint(j.hint || 'This list is incomplete — the item walk was bounded.');
      }
    } catch (e: any) {
      setCvLoadError(e?.message || String(e));
    }
  }, [workspaceId]);

  const checkAllVariables = useCallback(async () => {
    const libs = cvLibraries || [];
    // Nothing to check is NOT "0 libraries checked, all fine". Without this the
    // results would become `[]` and the dialog would render a green summary
    // over a check that examined nothing.
    if (!libs.length) return;
    setCvBusy(true); setCvResults(null);
    const out: VariableCheckResult[] = [];
    // Sequential on purpose: each resolve can hit Key Vault, and a workspace
    // with a dozen libraries fanned out in parallel is a throttling incident.
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
    setCvResults(out);
    setCvBusy(false);
  }, [cvLibraries]);

  return {
    cvOpen, setCvOpen,
    cvLibraries, cvLoadError, cvTruncatedHint,
    cvBusy, cvResults,
    openCheckVariables, checkAllVariables,
  };
}
