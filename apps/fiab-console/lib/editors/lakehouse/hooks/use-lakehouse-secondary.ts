'use client';
import { useState, useCallback, useEffect } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import { useCheckVariables } from './use-check-variables';
import type { HistoryRow, PathEntry, ReferenceLakehouse, RefSelection, PreviewResponse } from '../shared';
import type { DaAgentRow, SchemaRow } from '../types';
import type { WorkspaceItem } from '@/lib/api/workspaces';
import type { UseQueryResult } from '@tanstack/react-query';

interface Params {
  id: string;
  isNewItem: boolean;
  activeContainer: string | null;
  shortcutLakehouseId: string;
  schemasEnabled: boolean;
  setSchemasEnabled: (v: boolean) => void;
  loadPaths: (container: string, prefix: string) => Promise<void>;
  /**
   * `<lakehouse root>/Tables` — the REAL directory this lakehouse's tables live
   * in (#3904). Was hard-coded to the container-relative `'Tables'`, which for
   * an installed lakehouse (root `lakehouses/<Name>`) is a directory that does
   * not exist.
   */
  tablesPrefix: string;
  confirm: (opts: { title: string; body: string; danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
  itemQ: UseQueryResult<WorkspaceItem>;
  maintainTable: string;
  tab: string;
}

export function useLakehouseSecondary({
  id, isNewItem, activeContainer, shortcutLakehouseId, schemasEnabled, setSchemasEnabled,
  loadPaths, confirm, itemQ, maintainTable, tab, tablesPrefix,
}: Params) {
  // ── History ───────────────────────────────────────────────────────────────
  const [historyTable, setHistoryTable] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRestoring, setHistoryRestoring] = useState<number | null>(null);
  const [historyRestoreMsg, setHistoryRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [historyPreviewVersion, setHistoryPreviewVersion] = useState<number | null>(null);
  const [historyPreviewResult, setHistoryPreviewResult] = useState<PreviewResponse | null>(null);
  const [historyPreviewLoading, setHistoryPreviewLoading] = useState(false);

  const loadHistory = useCallback(async (tablePath: string) => {
    if (!activeContainer) return;
    setHistoryLoading(true); setHistoryError(null); setHistoryRows(null); setHistoryRestoreMsg(null); setHistoryPreviewResult(null);
    try {
      const qs = new URLSearchParams({ lakehouseId: id, container: activeContainer, tablePath });
      const r = await clientFetch(`/api/lakehouse/history?${qs.toString()}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; versions?: HistoryRow[] }>(r, 'Load history');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setHistoryRows(j.versions || []);
    } catch (e: any) { setHistoryError(e?.message || String(e)); setHistoryRows([]); }
    finally { setHistoryLoading(false); }
  }, [activeContainer, id]);

  const restoreToVersion = useCallback(async (tablePath: string, version: number) => {
    if (!activeContainer) return;
    const confirmed = await confirm({
      title: `Restore table "${tablePath.split('/').pop()}" to version ${version}?`,
      body: `This overwrites the current table state with version ${version}. Ensure the data files for that version have not been removed by VACUUM.`,
      danger: true, confirmLabel: 'Restore version',
    });
    if (!confirmed) return;
    setHistoryRestoring(version); setHistoryRestoreMsg(null);
    try {
      const r = await clientFetch('/api/lakehouse/history', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: id, container: activeContainer, tablePath, version, action: 'restore' }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; gated?: boolean; hint?: string }>(r, 'Restore');
      if (!j.ok) {
        setHistoryRestoreMsg({ ok: false, text: j.gated ? `Not available: ${j.hint}` : (j.error || 'Restore failed') });
      } else {
        setHistoryRestoreMsg({ ok: true, text: `Table restored to version ${version} at ${new Date().toLocaleTimeString()}` });
        await loadHistory(tablePath);
      }
    } catch (e: any) { setHistoryRestoreMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setHistoryRestoring(null); }
  }, [activeContainer, loadHistory, confirm, id]);

  const previewAsOf = useCallback(async (tablePath: string, version: number) => {
    if (!activeContainer) return;
    setHistoryPreviewLoading(true); setHistoryPreviewVersion(version); setHistoryPreviewResult(null);
    try {
      const r = await clientFetch('/api/lakehouse/history', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: id, container: activeContainer, tablePath, version, action: 'preview' }),
      });
      const j = await parseJsonOrError<PreviewResponse & { gated?: boolean; hint?: string }>(r, 'Preview as of');
      if (!j.ok && (j as any).gated) {
        setHistoryPreviewResult({ ok: false, error: `Not available: ${(j as any).hint}` });
      } else {
        setHistoryPreviewResult(j);
      }
    } catch (e: any) { setHistoryPreviewResult({ ok: false, error: e?.message || String(e) }); }
    finally { setHistoryPreviewLoading(false); }
  }, [activeContainer, id]);

  const openTableHistory = useCallback((tablePath: string) => {
    setHistoryTable(tablePath);
    setHistoryRows(null); setHistoryRestoreMsg(null); setHistoryPreviewResult(null);
    void loadHistory(tablePath);
  }, [loadHistory]);

  // ── Schemas ───────────────────────────────────────────────────────────────
  // schemasEnabled / setSchemasEnabled are owned by the shell and passed in.
  const [schemas, setSchemas] = useState<SchemaRow[] | null>(null);
  const [schemasBusy, setSchemasBusy] = useState(false);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const [schemasNotice, setSchemasNotice] = useState<string | null>(null);
  const [newSchemaOpen, setNewSchemaOpen] = useState(false);
  const [newSchemaName, setNewSchemaName] = useState('');
  const [newSchemaDesc, setNewSchemaDesc] = useState('');
  const [newSchemaBusy, setNewSchemaBusy] = useState(false);
  const [newSchemaError, setNewSchemaError] = useState<string | null>(null);
  const [moveTableOpen, setMoveTableOpen] = useState(false);
  const [moveTableName, setMoveTableName] = useState('');
  const [moveTableFrom, setMoveTableFrom] = useState('dbo');
  const [moveTableTo, setMoveTableTo] = useState('');
  const [moveTableBusy, setMoveTableBusy] = useState(false);
  const [moveTableError, setMoveTableError] = useState<string | null>(null);
  const [moveTableStatus, setMoveTableStatus] = useState<string | null>(null);

  // Schemas belong to the lakehouse ITEM (the registry is keyed by its id);
  // an unsaved item has none yet.
  const schemaItemId = isNewItem ? '' : id;

  useEffect(() => {
    if (tab === 'schemas' && schemaItemId) void loadSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, schemaItemId]);

  const loadSchemas = useCallback(async () => {
    if (!schemaItemId) return;
    setSchemasBusy(true); setSchemasError(null);
    try {
      const r = await clientFetch(`/api/lakehouse/schemas?lakehouseId=${encodeURIComponent(schemaItemId)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; schemas?: SchemaRow[] }>(r, 'List schemas');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setSchemas(j.schemas || []);
    } catch (e: any) { setSchemasError(e?.message || String(e)); setSchemas([]); }
    finally { setSchemasBusy(false); }
  }, [schemaItemId]);

  const createSchema = useCallback(async () => {
    if (!schemaItemId || !newSchemaName.trim()) return;
    setNewSchemaBusy(true); setNewSchemaError(null);
    try {
      const r = await clientFetch('/api/lakehouse/schemas', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: schemaItemId, name: newSchemaName.trim(), description: newSchemaDesc.trim() || undefined }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string; remediation?: string; note?: string }>(r, 'Create schema');
      if (!j.ok && r.status !== 503) throw new Error(j.hint || [j.error || `HTTP ${r.status}`, j.remediation].filter(Boolean).join(' '));
      setSchemasNotice(j.ok && j.note ? j.note : null);
      setNewSchemaOpen(false); setNewSchemaName(''); setNewSchemaDesc('');
      await loadSchemas();
    } catch (e: any) { setNewSchemaError(e?.message || String(e)); }
    finally { setNewSchemaBusy(false); }
  }, [schemaItemId, newSchemaName, newSchemaDesc, loadSchemas]);

  const deleteSchema = useCallback(async (name: string) => {
    if (!schemaItemId) return;
    const row = (schemas || []).find((s) => s.name === name);
    const ok = await confirm({
      title: `Delete schema "${name}"?`,
      body: row?.sparkDatabase && !row.legacy
        ? `This removes the schema from this lakehouse and drops its Spark database ${row.sparkDatabase} `
          + 'with every table in it (DROP SCHEMA … CASCADE). This cannot be undone.'
        : 'This removes the schema from this lakehouse\'s list. It was registered before lakehouse schemas had '
          + 'their own Spark databases, so Loom does not drop any Spark schema for it.',
      danger: true, confirmLabel: 'Delete schema',
    });
    if (!ok) return;
    setSchemasBusy(true); setSchemasError(null); setSchemasNotice(null);
    try {
      const r = await clientFetch(`/api/lakehouse/schemas?lakehouseId=${encodeURIComponent(schemaItemId)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; remediation?: string; note?: string; data?: { sparkSchemaKept?: boolean } }>(r, 'Delete schema');
      if (!j.ok) throw new Error([j.error || `HTTP ${r.status}`, j.remediation].filter(Boolean).join(' '));
      if (j.note) setSchemasNotice(j.note);
      await loadSchemas();
    } catch (e: any) { setSchemasError(e?.message || String(e)); }
    finally { setSchemasBusy(false); }
  }, [schemaItemId, schemas, loadSchemas, confirm]);

  const openMoveTable = useCallback((tableName: string, fromSchema: string) => {
    setMoveTableName(tableName); setMoveTableFrom(fromSchema || 'dbo');
    setMoveTableTo(''); setMoveTableError(null); setMoveTableStatus(null);
    setMoveTableOpen(true);
    if (schemas === null) void loadSchemas();
  }, [schemas, loadSchemas]);

  const submitMoveTable = useCallback(async () => {
    if (!schemaItemId || !moveTableName.trim() || !moveTableTo.trim()) return;
    setMoveTableBusy(true); setMoveTableError(null);
    try {
      const r = await clientFetch('/api/lakehouse/schemas', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: schemaItemId, tableName: moveTableName.trim(), fromSchema: moveTableFrom, toSchema: moveTableTo.trim() }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string; hint?: string; remediation?: string; data?: { sparkTable?: string } }>(r, 'Move table');
      if (!j.ok) throw new Error(j.hint || [j.error || `HTTP ${r.status}`, j.remediation].filter(Boolean).join(' '));
      setMoveTableStatus(
        j.data?.sparkTable
          ? `Moved to ${moveTableTo.trim()}. In a notebook, query it as ${j.data.sparkTable}.`
          : `Moved to ${moveTableTo.trim()}.`,
      );
      if (activeContainer) await loadPaths(activeContainer, tablesPrefix);
    } catch (e: any) { setMoveTableError(e?.message || String(e)); }
    finally { setMoveTableBusy(false); }
  }, [schemaItemId, moveTableName, moveTableFrom, moveTableTo, activeContainer, tablesPrefix, loadPaths]);

  // ── References ────────────────────────────────────────────────────────────
  const [references, setReferences] = useState<ReferenceLakehouse[] | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [workspaceLakehouses, setWorkspaceLakehouses] = useState<{ id: string; displayName: string }[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refOpenPrefixes, setRefOpenPrefixes] = useState<Record<string, PathEntry[] | 'loading' | { error: string }>>({});
  // The route's `note` for an empty listing (which container holds the files), by the same key.
  const [refPathNotes, setRefPathNotes] = useState<Record<string, string>>({});
  const [refSelection, setRefSelection] = useState<RefSelection | null>(null);
  const [refPreview, setRefPreview] = useState<PreviewResponse | null>(null);
  const [refPreviewLoading, setRefPreviewLoading] = useState(false);

  const loadReferences = useCallback(async () => {
    if (isNewItem) return;
    setRefsLoading(true); setRefsError(null);
    try {
      const r = await clientFetch(`/api/lakehouse/references?lakehouseId=${encodeURIComponent(id)}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; references?: ReferenceLakehouse[]; workspaceLakehouses?: { id: string; displayName: string }[] }>(r, 'Load references');
      if (!j.ok) throw new Error(j.error);
      setReferences(j.references ?? []);
      setWorkspaceLakehouses(j.workspaceLakehouses ?? []);
    } catch (e: any) { setRefsError(e?.message || String(e)); setReferences([]); }
    finally { setRefsLoading(false); }
  }, [id, isNewItem]);

  useEffect(() => { void loadReferences(); }, [loadReferences]);

  const addReference = useCallback(async (refId: string) => {
    setRefsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/references', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: id, addId: refId }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Add reference');
      if (!j.ok) throw new Error(j.error);
      await loadReferences();
    } catch (e: any) { setRefsError(e?.message || String(e)); }
  }, [id, loadReferences]);

  const removeReference = useCallback(async (refId: string) => {
    setRefsError(null);
    try {
      const r = await clientFetch('/api/lakehouse/references', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lakehouseId: id, removeId: refId }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Remove reference');
      if (!j.ok) throw new Error(j.error);
      if (refSelection?.refId === refId) { setRefSelection(null); setRefPreview(null); }
      await loadReferences();
    } catch (e: any) { setRefsError(e?.message || String(e)); }
  }, [id, loadReferences, refSelection]);

  const refCacheKey = useCallback((refId: string, container: string, prefix: string) => `ref::${refId}::${container}::${prefix}`, []);

  const loadRefPaths = useCallback(async (refId: string, container: string, prefix: string) => {
    const key = refCacheKey(refId, container, prefix);
    setRefOpenPrefixes((p) => ({ ...p, [key]: 'loading' }));
    try {
      const qs = new URLSearchParams({ refId, container, prefix });
      const r = await clientFetch(`/api/lakehouse/references/paths?${qs.toString()}`);
      const j = await parseJsonOrError<{ ok: boolean; error?: string; paths?: PathEntry[]; note?: string }>(r, 'Reference paths');
      setRefPathNotes((n) => {
        const next = { ...n };
        if (j.ok && j.note) next[key] = j.note; else delete next[key];
        return next;
      });
      setRefOpenPrefixes((p) => ({ ...p, [key]: j.ok ? (j.paths ?? []) : { error: j.error || `HTTP ${r.status}` } }));
    } catch (e: any) { setRefOpenPrefixes((p) => ({ ...p, [key]: { error: e?.message || String(e) } })); }
  }, [refCacheKey]);

  const selectRefFile = useCallback(async (ref: ReferenceLakehouse, container: string, entry: PathEntry) => {
    if (entry.isDirectory) { await loadRefPaths(ref.id, container, entry.name); return; }
    setRefSelection({ refId: ref.id, displayName: ref.displayName, account: ref.account, container, entry });
    setRefPreview(null); setRefPreviewLoading(true);
    try {
      // The referenced item is authorized server-side; its storage account comes
      // from the item, not from the request.
      const qs = new URLSearchParams({ refId: ref.id, container, path: entry.name });
      const r = await clientFetch(`/api/lakehouse/preview?${qs.toString()}`);
      const j = await parseJsonOrError<PreviewResponse>(r, 'Reference preview');
      setRefPreview(j);
    } catch (e: any) { setRefPreview({ ok: false, error: e?.message || String(e) }); }
    finally { setRefPreviewLoading(false); }
  }, [loadRefPaths]);

  // ── Share ─────────────────────────────────────────────────────────────────
  const [shareOpen, setShareOpen] = useState(false);
  const [sharePrincipal, setSharePrincipal] = useState('');
  const [sharePrincipalType, setSharePrincipalType] = useState<'User' | 'Group' | 'ServicePrincipal'>('User');
  const [shareRole, setShareRole] = useState('Storage Blob Data Reader');
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareSuccess, setShareSuccess] = useState<string | null>(null);

  // Share is the Permissions grant under another name: it names the lakehouse,
  // and the server grants on the container and storage account the item is
  // bound to. An unsaved item has neither, so nothing is sent.
  const grantShare = useCallback(async () => {
    if (isNewItem || !id || !activeContainer || !sharePrincipal.trim()) return;
    setShareBusy(true); setShareError(null); setShareSuccess(null);
    try {
      const r = await clientFetch('/api/lakehouse/permissions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'object', lakehouseId: id, container: activeContainer, principalId: sharePrincipal.trim(), principalType: sharePrincipalType, role: shareRole }),
      });
      const j = await parseJsonOrError<{ ok: boolean; error?: string }>(r, 'Share');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setShareSuccess(`Granted ${shareRole} to ${sharePrincipal.trim()} at ${new Date().toLocaleTimeString()}.`);
      setSharePrincipal('');
    } catch (e: any) { setShareError(e?.message || String(e)); }
    finally { setShareBusy(false); }
  }, [isNewItem, id, activeContainer, sharePrincipal, sharePrincipalType, shareRole]);

  // ── Data Agent ────────────────────────────────────────────────────────────
  const [daOpen, setDaOpen] = useState(false);
  const [daAgents, setDaAgents] = useState<DaAgentRow[] | null>(null);
  const [daLoadErr, setDaLoadErr] = useState<string | null>(null);
  const [daSel, setDaSel] = useState<string>('');
  const [daBusy, setDaBusy] = useState(false);
  const [daMsg, setDaMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const openAddToAgent = useCallback(async () => {
    setDaOpen(true); setDaMsg(null); setDaSel(''); setDaAgents(null); setDaLoadErr(null);
    try {
      const r = await clientFetch('/api/items/data-agent');
      const j = await parseJsonOrError<{ ok: boolean; items?: DaAgentRow[]; error?: string }>(r, 'List data agents');
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDaAgents(j.items || []);
    } catch (e: any) { setDaLoadErr(e?.message || String(e)); }
  }, []);

  const addToAgent = useCallback(async () => {
    const agent = (daAgents || []).find((a) => a.id === daSel);
    if (!agent) return;
    setDaBusy(true); setDaMsg(null);
    try {
      const lhName = itemQ.data?.displayName || `lakehouse-${id}`;
      const sourceId = `lakehouse:${id}`;
      const existing = Array.isArray(agent.state?.sources) ? agent.state!.sources! : [];
      if (existing.some((s: any) => s?.id === sourceId)) {
        setDaMsg({ intent: 'success', text: `${lhName} is already a source on ${agent.displayName}.` });
        setDaBusy(false); return;
      }
      const src = { id: sourceId, type: 'lakehouse', name: lhName, tables: maintainTable || '', instructions: '', description: `Lakehouse ${lhName} (${id})`, examples: [] };
      const nextState = { ...(agent.state || {}), sources: [...existing, src] };
      const r = await clientFetch(`/api/items/data-agent/${agent.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: nextState }),
      });
      const j = await parseJsonOrError<{ ok?: boolean; error?: string }>(r, 'Add source');
      if (j.error || j.ok === false) throw new Error(j.error || 'PATCH failed');
      setDaMsg({ intent: 'success', text: `Added ${lhName} to ${agent.displayName}. Open the agent's Build tab to ground it.` });
      setDaAgents((prev) => (prev || []).map((a) => a.id === agent.id ? { ...a, state: nextState } : a));
    } catch (e: any) { setDaMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDaBusy(false); }
  }, [daAgents, daSel, itemQ.data?.displayName, id, maintainTable]);

  // ── Check variables (read-only Variable Library health check) ─────────────
  // Lives in its own hook so it is reachable by `renderHook` without standing
  // up this hook's whole parameter surface; spread below so the shell picks it
  // up through the context it already builds from `...sec`.
  const cv = useCheckVariables(itemQ.data?.workspaceId);

  return {
    // History
    historyTable, setHistoryTable,
    historyRows, historyLoading, historyError,
    historyRestoring, historyRestoreMsg,
    historyPreviewVersion, historyPreviewResult, historyPreviewLoading,
    loadHistory, restoreToVersion, previewAsOf, openTableHistory,
    // Schemas
    schemas, schemasBusy, schemasError, schemasNotice,
    newSchemaOpen, setNewSchemaOpen,
    newSchemaName, setNewSchemaName,
    newSchemaDesc, setNewSchemaDesc,
    newSchemaBusy, newSchemaError,
    moveTableOpen, setMoveTableOpen,
    moveTableName, moveTableFrom,
    moveTableTo, setMoveTableTo,
    moveTableBusy, moveTableError, moveTableStatus,
    loadSchemas, createSchema, deleteSchema, openMoveTable, submitMoveTable,
    // References
    references, refsLoading, refsError,
    workspaceLakehouses,
    pickerOpen, setPickerOpen,
    refOpenPrefixes, refPathNotes, refSelection, setRefSelection, refPreview, setRefPreview, refPreviewLoading,
    addReference, removeReference, loadRefPaths, selectRefFile, loadReferences,
    // Share
    shareOpen, setShareOpen,
    sharePrincipal, setSharePrincipal,
    sharePrincipalType, setSharePrincipalType,
    shareRole, setShareRole,
    shareBusy, shareError, setShareError, shareSuccess, setShareSuccess,
    grantShare,
    // Data Agent
    daOpen, setDaOpen, openAddToAgent,
    daAgents, setDaAgents,
    daLoadErr, setDaLoadErr,
    daSel, setDaSel,
    daBusy, setDaBusy,
    daMsg, setDaMsg,
    addToAgent,
    // Check variables
    ...cv,
  };
}
