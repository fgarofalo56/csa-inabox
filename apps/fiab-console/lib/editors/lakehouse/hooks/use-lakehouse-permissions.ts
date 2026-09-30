'use client';
import { useState, useCallback, useEffect } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import type {
  PermAssignment, PermRole, PermsTab, SqlGrant, SqlTableRef, SqlColRef,
  RlsPolicy, ResolvedPrincipal,
} from '../types';

interface Params {
  /** The lakehouse item; every permissions read is authorized against it. */
  lakehouseId: string;
  activeContainer: string | null;
  confirm: (opts: { title: string; body: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
}

export function useLakehousePermissions({ lakehouseId, activeContainer, confirm }: Params) {
  // The permissions GET is scoped to one lakehouse, so every read names it.
  const readUrl = useCallback(
    (q: Record<string, string>) =>
      `/api/lakehouse/permissions?${new URLSearchParams({ ...q, lakehouseId }).toString()}`,
    [lakehouseId],
  );
  // ── RBAC (Object tab) ────────────────────────────────────────────────────
  const [permsOpen, setPermsOpen] = useState(false);
  const [permsRows, setPermsRows] = useState<PermAssignment[]>([]);
  const [permsRoles, setPermsRoles] = useState<PermRole[]>([]);
  const [permsBusy, setPermsBusy] = useState(false);
  const [permsError, setPermsError] = useState<string | null>(null);
  const [newPrincipalId, setNewPrincipalId] = useState('');
  const [newPrincipalType, setNewPrincipalType] = useState<'User' | 'Group' | 'ServicePrincipal'>('User');
  const [newRole, setNewRole] = useState('Storage Blob Data Reader');

  // ── SQL-plane tabs ────────────────────────────────────────────────────────
  const [permsTab, setPermsTab] = useState<PermsTab>('object');
  const [sqlGate, setSqlGate] = useState<{ missing: string; hint: string } | null>(null);
  const [sqlGrants, setSqlGrants] = useState<SqlGrant[]>([]);
  const [sqlTables, setSqlTables] = useState<SqlTableRef[]>([]);
  const [selTableId, setSelTableId] = useState<number | null>(null);
  const [sqlCols, setSqlCols] = useState<SqlColRef[]>([]);
  const [selColIds, setSelColIds] = useState<number[]>([]);
  const [rlsPolicies, setRlsPolicies] = useState<RlsPolicy[]>([]);
  const [rlsFilterColId, setRlsFilterColId] = useState<number | null>(null);
  const [rlsSubject, setRlsSubject] = useState<'USER_NAME()' | 'SUSER_SNAME()'>('USER_NAME()');

  // ── Principal picker ──────────────────────────────────────────────────────
  const [principalQuery, setPrincipalQuery] = useState('');
  const [principalResults, setPrincipalResults] = useState<ResolvedPrincipal[]>([]);
  const [selectedPrincipal, setSelectedPrincipal] = useState<ResolvedPrincipal | null>(null);
  const [principalBusy, setPrincipalBusy] = useState(false);

  // Debounced Entra user search
  useEffect(() => {
    if (permsTab === 'object') return;
    const q = principalQuery.trim();
    if (q.length < 2) { setPrincipalResults([]); return; }
    const h = setTimeout(async () => {
      setPrincipalBusy(true);
      try {
        const r = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&kind=user`);
        const j = await r.json();
        setPrincipalResults(
          (j.results || [])
            .filter((p: any) => p.upn)
            .map((p: any) => ({ id: p.id, displayName: p.displayName, upn: p.upn })),
        );
      } catch { setPrincipalResults([]); }
      finally { setPrincipalBusy(false); }
    }, 300);
    return () => clearTimeout(h);
  }, [principalQuery, permsTab]);

  // ── RBAC callbacks ────────────────────────────────────────────────────────
  const loadPerms = useCallback(async () => {
    if (!activeContainer) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await clientFetch(readUrl({ container: activeContainer }));
      const j = await parseJsonOrError<{ ok: boolean; error?: string; assignments?: PermAssignment[]; knownRoles?: PermRole[] }>(r, 'List permissions');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPermsRows(j.assignments || []);
      setPermsRoles(j.knownRoles || []);
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [activeContainer, readUrl]);

  const openPerms = useCallback(() => {
    if (!lakehouseId) return; // unsaved lakehouse: no item to read through
    setPermsOpen(true);
    setPermsTab('object');
    setPermsError(null);
    loadPerms();
  }, [lakehouseId, loadPerms]);

  // The object-tab writes name the lakehouse too: the server grants and revokes
  // on the container and storage account the item is bound to, the same ones
  // the listing above reads.
  const grantPerm = useCallback(async () => {
    if (!lakehouseId || !activeContainer || !newPrincipalId.trim()) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'object', lakehouseId, container: activeContainer, principalId: newPrincipalId.trim(), principalType: newPrincipalType, role: newRole }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Grant permission');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNewPrincipalId('');
      await loadPerms();
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [lakehouseId, activeContainer, newPrincipalId, newPrincipalType, newRole, loadPerms]);

  const revokePerm = useCallback(async (armId: string) => {
    if (!lakehouseId || !activeContainer) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const qs = new URLSearchParams({ tab: 'object', lakehouseId, container: activeContainer, id: armId });
      const r = await clientFetch(`/api/lakehouse/permissions?${qs.toString()}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Revoke permission');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadPerms();
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [lakehouseId, activeContainer, loadPerms]);

  // ── SQL-plane callbacks ───────────────────────────────────────────────────
  const loadSqlPerms = useCallback(async (t: PermsTab) => {
    if (t === 'object') return;
    setPermsBusy(true); setPermsError(null); setSqlGate(null);
    try {
      if (t === 'row') {
        const r = await clientFetch(readUrl({ tab: 'row' }));
        const j = await r.json();
        if (j.gate) { setSqlGate({ missing: j.missing, hint: j.hint }); return; }
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setRlsPolicies(j.policies || []);
      } else {
        const r = await clientFetch(readUrl({ tab: t }));
        const j = await r.json();
        if (j.gate) { setSqlGate({ missing: j.missing, hint: j.hint }); return; }
        if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setSqlGrants(j.grants || []);
      }
      const tr = await clientFetch(readUrl({ tab: t, list: 'tables' }));
      const tj = await tr.json();
      if (tj.gate) { setSqlGate({ missing: tj.missing, hint: tj.hint }); return; }
      if (tj.ok) setSqlTables(tj.tables || []);
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [readUrl]);

  const loadSqlColumns = useCallback(async (objectId: number) => {
    try {
      const r = await clientFetch(readUrl({ tab: 'column', list: 'columns', objectId: String(objectId) }));
      const j = await r.json();
      if (j.ok) setSqlCols(j.columns || []);
    } catch { /* surfaced when the grant is attempted */ }
  }, [readUrl]);

  const selectPermsTab = useCallback((t: PermsTab) => {
    setPermsTab(t);
    setPermsError(null);
    setSelTableId(null); setSqlCols([]); setSelColIds([]); setRlsFilterColId(null);
    setSelectedPrincipal(null); setPrincipalQuery(''); setPrincipalResults([]);
    if (t === 'object') loadPerms(); else loadSqlPerms(t);
  }, [loadPerms, loadSqlPerms]);

  const onPickTable = useCallback((objectId: number | null) => {
    setSelTableId(objectId);
    setSelColIds([]); setSqlCols([]); setRlsFilterColId(null);
    if (objectId != null) loadSqlColumns(objectId);
  }, [loadSqlColumns]);

  const grantSqlTable = useCallback(async () => {
    if (!selectedPrincipal || selTableId == null) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'table', upn: selectedPrincipal.upn, objectId: selTableId }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('table');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [selectedPrincipal, selTableId, loadSqlPerms]);

  const grantSqlColumn = useCallback(async () => {
    if (!selectedPrincipal || selTableId == null || selColIds.length === 0) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'column', upn: selectedPrincipal.upn, objectId: selTableId, columnIds: selColIds }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('column');
      setSelColIds([]);
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [selectedPrincipal, selTableId, selColIds, loadSqlPerms]);

  const createRls = useCallback(async () => {
    if (selTableId == null || rlsFilterColId == null) return;
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'row', objectId: selTableId, filterColumnId: rlsFilterColId, subject: rlsSubject }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('row');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [selTableId, rlsFilterColId, rlsSubject, loadSqlPerms]);

  const revokeSqlGrant = useCallback(async (g: SqlGrant) => {
    const tbl = sqlTables.find((t) => t.schema === g.schema && t.name === g.table);
    if (!tbl) { setPermsError(`Could not resolve object_id for ${g.schema}.${g.table}`); return; }
    setPermsBusy(true); setPermsError(null);
    try {
      let columnIds: number[] = [];
      if (g.column) {
        const cr = await clientFetch(readUrl({ tab: 'column', list: 'columns', objectId: String(tbl.objectId) }));
        const cj = await cr.json();
        const hit = (cj.columns || []).find((c: any) => c.name === g.column);
        if (hit) columnIds = [hit.columnId];
      }
      const r = await clientFetch(`/api/lakehouse/permissions?tab=${g.column ? 'column' : 'table'}`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ upn: g.principal, objectId: tbl.objectId, columnIds }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms(g.column ? 'column' : 'table');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [sqlTables, loadSqlPerms, readUrl]);

  const dropRls = useCallback(async (p: RlsPolicy) => {
    setPermsBusy(true); setPermsError(null);
    try {
      const r = await clientFetch(`/api/lakehouse/permissions?tab=row&policyObjectId=${p.policyObjectId}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadSqlPerms('row');
    } catch (e: any) { setPermsError(e?.message || String(e)); }
    finally { setPermsBusy(false); }
  }, [loadSqlPerms]);

  const toggleCol = useCallback((columnId: number, checked: boolean) => {
    setSelColIds((prev) => (checked ? Array.from(new Set([...prev, columnId])) : prev.filter((c) => c !== columnId)));
  }, []);

  return {
    permsOpen, setPermsOpen, openPerms,
    permsRows, setPermsRows, permsRoles, setPermsRoles,
    permsBusy, setPermsBusy, permsError, setPermsError,
    newPrincipalId, setNewPrincipalId,
    newPrincipalType, setNewPrincipalType,
    newRole, setNewRole,
    permsTab, setPermsTab,
    sqlGate, setSqlGate,
    sqlGrants, setSqlGrants,
    sqlTables, setSqlTables,
    selTableId, setSelTableId,
    sqlCols, setSqlCols,
    selColIds, setSelColIds,
    rlsPolicies, setRlsPolicies,
    rlsFilterColId, setRlsFilterColId,
    rlsSubject, setRlsSubject,
    principalQuery, setPrincipalQuery,
    principalResults, setPrincipalResults,
    selectedPrincipal, setSelectedPrincipal,
    principalBusy, setPrincipalBusy,
    loadPerms, grantPerm, revokePerm,
    loadSqlPerms, loadSqlColumns,
    selectPermsTab, onPickTable,
    grantSqlTable, grantSqlColumn,
    createRls, revokeSqlGrant, dropRls, toggleCol,
  };
}
