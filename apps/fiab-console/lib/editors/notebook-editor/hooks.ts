'use client';

// hooks.ts — self-contained data hooks for the notebook-editor.
// Extracted verbatim from notebook-editor.tsx; each hook owns its own state and
// fetches via clientFetch. No JSX.

import { useState, useEffect, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import type { WorkspaceLite, ComputeTarget, MyCiState } from './types';

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await clientFetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setHint(j.hint || null); setWorkspaces([]); }
      else setWorkspaces(j.workspaces || []);
    } catch (e: any) { setError(e?.message || String(e)); setWorkspaces([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { workspaces, error, hint, loading, reload: load };
}

export function useComputes() {
  const [computes, setComputes] = useState<ComputeTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const j = await (await clientFetch('/api/loom/compute-targets')).json();
      if (j.ok) setComputes(j.computes || []);
      else setError(j.error || 'failed to list compute');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { computes, loading, error, refresh };
}

/** Detect whether the AML notebook path is wired (LOOM_AML_WORKSPACE set), and
 *  surface the bicep default Compute Instance name (LOOM_AML_DEFAULT_COMPUTE)
 *  so the editor can auto-select it the moment that CI exists. */
export function useAmlConfigured() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [defaultCompute, setDefaultCompute] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const j = await (await clientFetch('/api/aml/compute-instances')).json();
        if (!cancelled) {
          setConfigured(j.ok === true || j.configured === true);
          setDefaultCompute(typeof j.defaultCompute === 'string' && j.defaultCompute ? j.defaultCompute : null);
        }
      } catch { if (!cancelled) setConfigured(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  return { configured, defaultCompute };
}

export function useMyCi() {
  const [state, setState] = useState<MyCiState>({ loading: true, enabled: true, myName: null, mine: null, policy: null, quota: null });
  const refresh = useCallback(async () => {
    try {
      const j = await (await clientFetch('/api/aml/compute-instances/mine')).json();
      setState({
        loading: false,
        enabled: j?.enabled !== false,
        myName: typeof j?.myName === 'string' ? j.myName : null,
        mine: j?.mine || null,
        policy: j?.policy || null,
        quota: j?.quota || null,
      });
    } catch {
      setState((p) => ({ ...p, loading: false }));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { ...state, refresh };
}
