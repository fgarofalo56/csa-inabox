'use client';

// data-product/hooks.ts — DataProductEditor's picker-source data hooks,
// extracted verbatim from data-product-editor.tsx (WS-E1 / R8 decomposition,
// pure move — no behavior change).
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';

// Workspace picker source for creating a brand-new data product on /new.
export function useDataProductWorkspaces() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/loom/workspaces');
        const j = await r.json();
        setWorkspaces(j.ok ? (j.workspaces || []) : []);
      } catch { setWorkspaces([]); }
      finally { setLoading(false); }
    })();
  }, []);
  return { workspaces, loading };
}

// Governance-domain picker source — resolves the Purview businessDomainId GUID
// that register-purview requires. Honest gate: 501 (Purview unprovisioned)
// surfaces as `notConfigured` so the form still renders.
export function useGovernanceDomains() {
  const [domains, setDomains] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/catalog/domains');
        const j = await r.json();
        if (r.status === 501) { setNotConfigured(true); setDomains([]); }
        else if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setDomains([]); }
        else setDomains(j.domains || []);
      } catch (e: any) { setError(e?.message || String(e)); setDomains([]); }
      finally { setLoading(false); }
    })();
  }, []);
  return { domains, error, notConfigured, loading };
}
