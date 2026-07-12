'use client';

/**
 * useConnections — the ONE client hook that reads the caller's saved, Key
 * Vault-backed Loom Connections (GET /api/connections) so any surface can REUSE
 * them: the Connections page, the shared <ConnectionPicker/>, notebook "read
 * from connection", the lakehouse shortcut builder, and pipeline linked
 * services. Connections are entered once → this hook is how everything else
 * picks one up (no re-typing creds, no per-surface fetch boilerplate).
 *
 * Real backend only (no-vaporware): it hits the live route and surfaces the
 * server's honest error; it never returns mock rows. `types` filters client-side
 * to the connection types a surface can consume (e.g. a SQL-only picker).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import type { ConnectionType } from '@/lib/azure/connections-store';

/** The no-secret connection shape the list route returns (mirror of LoomConnectionView). */
export interface SavedConnection {
  id: string;
  name: string;
  type: ConnectionType;
  authMethod: string;
  hasSecret: boolean;
  host?: string;
  database?: string;
  username?: string;
  description?: string;
  origin?: 'manual' | 'existing';
}

export interface UseConnectionsResult {
  /** null while the first load is in flight; [] once loaded (possibly empty). */
  connections: SavedConnection[] | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch (e.g. after creating a connection inline). */
  reload: () => Promise<void>;
}

/**
 * Load the caller's saved connections. Pass `types` to restrict to the
 * connection types the mounting surface can actually use.
 */
export function useConnections(types?: readonly ConnectionType[]): UseConnectionsResult {
  const [all, setAll] = useState<SavedConnection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/connections');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setError(j?.error || `HTTP ${r.status}`);
        setAll([]);
        return;
      }
      setAll(Array.isArray(j.connections) ? (j.connections as SavedConnection[]) : []);
    } catch (e: any) {
      setError(e?.message || String(e));
      setAll([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Stable key so the memo doesn't re-run every render on a fresh array literal.
  const typeKey = types ? types.join(',') : '';
  const connections = useMemo(() => {
    if (all === null) return null;
    if (!typeKey) return all;
    const allow = new Set(typeKey.split(','));
    return all.filter((c) => allow.has(c.type));
  }, [all, typeKey]);

  return { connections, loading, error, reload };
}
