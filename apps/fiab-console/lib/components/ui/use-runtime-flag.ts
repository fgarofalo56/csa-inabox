'use client';

/**
 * useRuntimeFlag — client half of the FLAG0 runtime kill-switch substrate.
 *
 * Reads the registered flag map from GET /api/runtime-flags (one shared,
 * 30 s-fresh react-query entry for ALL flags — a surface check costs zero
 * extra requests) and returns the flag's boolean. DEFAULT-ON contract
 * (loom_default_on_opt_out): while loading, on any fetch error, or for an
 * id the server doesn't report, the DEFAULT is returned — the kill-switch
 * subsystem can never gate a surface, only revert one when an admin
 * explicitly flips it OFF in /admin/runtime-flags.
 */

import { useContext, useState } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { clientFetch } from '@/lib/client-fetch';

async function fetchFlags(): Promise<Record<string, boolean> | null> {
  const res = await clientFetch('/api/runtime-flags', { cache: 'no-store' });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok !== true || typeof json.flags !== 'object') return null;
  return json.flags as Record<string, boolean>;
}

export function useRuntimeFlag(id: string, defaultValue = true): boolean {
  // Fail-open all the way down: a mount OUTSIDE the app's QueryClientProvider
  // (isolated embeds, unit tests) must return the default, never throw —
  // useQuery would throw without a client, so fall back to a local one.
  const ctxClient = useContext(QueryClientContext);
  const [fallbackClient] = useState(() =>
    ctxClient ? null : new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const { data } = useQuery({
    queryKey: ['runtime-flags'],
    queryFn: fetchFlags,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  }, ctxClient ?? fallbackClient!);
  const v = data?.[id];
  return typeof v === 'boolean' ? v : defaultValue;
}
