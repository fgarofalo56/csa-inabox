'use client';
/**
 * The caller's access to a lakehouse item, from `/api/lakehouse/access` — the
 * same decision the lakehouse routes apply. `canWrite` is `null` while it is
 * loading, for an unsaved item, or when the probe failed, so a caller never
 * disables an action on a guess.
 */
import { useQuery } from '@tanstack/react-query';
import { clientFetch } from '@/lib/client-fetch';

export function useLakehouseAccess(lakehouseId: string, isNewItem: boolean): { canWrite: boolean | null } {
  const q = useQuery({
    queryKey: ['lakehouse-access', lakehouseId],
    enabled: !!lakehouseId && !isNewItem,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await clientFetch(`/api/lakehouse/access?lakehouseId=${encodeURIComponent(lakehouseId)}`);
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; canWrite?: boolean };
      return j.ok === true && typeof j.canWrite === 'boolean' ? j.canWrite : null;
    },
  });
  // A failed probe is NOT "read-only": Loom could not tell, so it reports
  // unknown and the caller leaves the action enabled (the route still decides).
  if (q.isError) return { canWrite: null };
  return { canWrite: q.data ?? null };
}
