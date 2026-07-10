'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * DataflowGen2Editor — Azure-native Dataflow Gen2 (Power Query Online parity).
 *
 * Backend: no Fabric. Authored Power Query (M) is saved to Cosmos and, on Run,
 * compiled into an ADF WranglingDataFlow that executes on ADF Spark and writes
 * the output query to the chosen ADLS / Azure SQL destination. Per
 * no-fabric-dependency.md this is the only backend — the editor renders fully
 * and Runs against Azure with no Fabric capacity or workspace.
 *
 * Workspace selector below is the LOOM (Cosmos) workspace the dataflow item
 * lives in — NOT a Fabric workspace — so dataflows scope to a Loom workspace
 * exactly like every other Loom item.
 *
 * Backed by /api/loom/workspaces + /api/items/dataflow/** + /api/items/dataflow/config.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input,
  Tree, TreeItem, TreeItemLayout, Select, Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Save20Regular, ArrowSync20Regular, Play20Regular, Delete20Regular, Flow20Regular,
  Sparkle20Regular,
  Add24Regular,
  Flow24Regular, Table24Regular, DocumentTable24Regular, DocumentText24Regular,
  Database24Regular, Globe24Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { useCollapsibleState, CollapsedRail } from '@/lib/components/collapsible-side-panel';
import { GuidedEmptyState, type GuidedPath } from '@/lib/components/shared/guided-empty-state';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { PowerQueryHost } from '@/lib/components/pipeline/dataflow/power-query-host';
import { DataflowCopilotPane } from '@/lib/components/pipeline/dataflow/dataflow-copilot-pane';
import { DestinationPicker } from '@/lib/components/pipeline/dataflow/destination-picker';
import { parseSharedQueries, type DataflowSink } from '@/lib/components/pipeline/dataflow/m-script';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: tokens.spacingHorizontalS },
  // Long dynamic strings (errors, receipts, env-var lists, paths) must wrap, never overflow the surface.
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' },
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
interface DataflowLite { id: string; displayName: string; description?: string; }

function useWorkspaces() {
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
  return { workspaces, error, hint, loading };
}

interface DataflowConfig { backend: string; adfConfigured: boolean; adfMissing: string | null; adlsConfigured: boolean; }
function useDataflowConfig() {
  const [config, setConfig] = useState<DataflowConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/items/dataflow/config');
        const j = await r.json();
        if (!cancelled && j.ok) setConfig(j);
      } catch { /* non-fatal — editor still renders */ }
    })();
    return () => { cancelled = true; };
  }, []);
  return config;
}

const STARTER_M = `section Section1;

shared Query1 = let
    Source = #table({"region","amount"}, {{"east", 10}, {"west", 20}}),
    Filtered = Table.SelectRows(Source, each [amount] > 0)
in
    Filtered;`;

/** Blank single-query section — the "start from nothing" import path. */
const BLANK_M = `section Section1;

shared Query1 = let
    Source = ""
in
    Source;`;

/**
 * Real Power Query (M) starter templates, one per get-data source (Fabric's
 * Dataflow "import from …" cards, fabric-ux-observations §29). Each writes a
 * runnable-once-configured M query with a clearly-editable placeholder — exactly
 * how Fabric seeds starter queries — so every card performs a real action
 * (no dead tiles, per no-vaporware.md). Placeholders are replaced by the author
 * in the Power Query editor; on Run the M compiles to an ADF WranglingDataFlow.
 */
const IMPORT_SOURCES: { key: string; title: string; body: string; icon: GuidedPath['icon']; m: string }[] = [
  {
    key: 'blank', title: 'Blank query', body: 'Start from an empty query and build it step by step in Power Query.',
    icon: Flow24Regular, m: BLANK_M,
  },
  {
    key: 'sample', title: 'Sample table', body: 'Begin from a small in-memory table you can transform immediately.',
    icon: Table24Regular,
    m: `section Section1;

shared Query1 = let
    Source = #table({"region","amount"}, {{"east", 10}, {"west", 20}}),
    Filtered = Table.SelectRows(Source, each [amount] > 0)
in
    Filtered;`,
  },
  {
    key: 'excel', title: 'Import from Excel', body: 'Load a workbook — replace the URL with your .xlsx source.',
    icon: DocumentTable24Regular,
    m: `section Section1;

shared Query1 = let
    Source = Excel.Workbook(Web.Contents("https://REPLACE_WITH_YOUR_WORKBOOK_URL/book.xlsx"), null, true),
    Sheet1 = Source{[Item="Sheet1",Kind="Sheet"]}[Data]
in
    Sheet1;`,
  },
  {
    key: 'csv', title: 'Import from Text/CSV', body: 'Parse a delimited file — replace the URL with your .csv source.',
    icon: DocumentText24Regular,
    m: `section Section1;

shared Query1 = let
    Source = Csv.Document(Web.Contents("https://REPLACE_WITH_YOUR_CSV_URL/data.csv"), [Delimiter=",", Encoding=65001]),
    Promoted = Table.PromoteHeaders(Source, [PromoteAllScalars=true])
in
    Promoted;`,
  },
  {
    key: 'sql', title: 'SQL Server / Azure SQL', body: 'Query a table — replace server, database, and table names.',
    icon: Database24Regular,
    m: `section Section1;

shared Query1 = let
    Source = Sql.Database("REPLACE_SERVER.database.windows.net", "REPLACE_DATABASE"),
    Table = Source{[Schema="dbo",Item="REPLACE_TABLE"]}[Data]
in
    Table;`,
  },
  {
    key: 'odata', title: 'OData feed', body: 'Connect to an OData service — replace the feed URL.',
    icon: Globe24Regular,
    m: `section Section1;

shared Query1 = let
    Source = OData.Feed("https://REPLACE_WITH_YOUR_ODATA_SERVICE_URL", null, [Implementation="2.0"])
in
    Source;`,
  },
];

function toB64(s: string): string {
  return typeof window === 'undefined' ? Buffer.from(s, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)));
}
function fromB64(b: string): string {
  try {
    return typeof window === 'undefined' ? Buffer.from(b, 'base64').toString('utf-8')
      : decodeURIComponent(escape(atob(b)));
  } catch { return ''; }
}

interface Props { item: FabricItemType; id: string; }

export function DataflowGen2Editor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const config = useDataflowConfig();
  const [workspaceId, setWorkspaceId] = useState('');
  const [dataflows, setDataflows] = useState<DataflowLite[] | null>(null);
  const [dataflowId, setDataflowId] = useState('');
  const [defText, setDefText] = useState(STARTER_M);
  const [partPath, setPartPath] = useState('mashup.pq');
  const [sink, setSink] = useState<DataflowSink | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'authoring' | 'output' | 'script'>('authoring');
  // Copilot pane open/collapsed persists PER SURFACE — collapsed hands the
  // Power Query canvas its full width back, leaving a thin re-expand rail.
  // `collapsed` is the inverse of the existing `copilotOpen` flag, so every
  // call site below keeps working (incl. the `(v) => !v` updater form).
  const [copilotCollapsed, setCopilotCollapsed] = useCollapsibleState(`dataflow-copilot.${id}`, false);
  const copilotOpen = !copilotCollapsed;
  const setCopilotOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCopilotCollapsed((prev) => !(typeof v === 'function' ? (v as (p: boolean) => boolean)(!prev) : v));
  }, [setCopilotCollapsed]);
  const [activeQuery, setActiveQuery] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [runHint, setRunHint] = useState<string | null>(null);
  const [runOk, setRunOk] = useState<boolean | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const isM = /\.(pq|m)$/i.test(partPath);
  const queryNames = useMemo(() => (isM ? parseSharedQueries(defText).map((q) => q.name) : []), [isM, defText]);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null); setListHint(null);
    try {
      const r = await clientFetch(`/api/items/dataflow?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDataflows([]); setListErr(j.error); setListHint(j.hint); return; }
      setDataflows(j.dataflows || []);
      if ((j.dataflows || []).length && !dataflowId) setDataflowId(j.dataflows[0].id);
    } catch (e: any) { setDataflows([]); setListErr(e?.message || String(e)); }
  }, [dataflowId]);

  const loadDetail = useCallback(async (wsId: string, dId: string) => {
    setDetailErr(null); setRunMsg(null); setRunHint(null); setRunOk(null);
    try {
      const r = await clientFetch(`/api/items/dataflow/${encodeURIComponent(dId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      const parts: Array<{ path: string; payload: string }> = j.definition?.parts || [];
      const main = parts.find((p) => /mashup\.(pq|m)$/i.test(p.path))
        || parts.find((p) => /queryMetadata\.json$/i.test(p.path))
        || parts[0];
      if (main?.payload) { setPartPath(main.path); setDefText(fromB64(main.payload)); }
      else { setPartPath('mashup.pq'); setDefText(STARTER_M); }
      setSink((j.sink as DataflowSink) || null);
      setDirty(false);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && dataflowId) loadDetail(workspaceId, dataflowId); }, [workspaceId, dataflowId, loadDetail]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!workspaceId || !dataflowId) return false;
    setSaving(true); setDetailErr(null);
    let textSnapshot = defText;
    setDefText((prev) => { textSnapshot = prev; return prev; });
    let sinkSnapshot = sink;
    setSink((prev) => { sinkSnapshot = prev; return prev; });
    try {
      const definition = { parts: [{ path: partPath, payload: toB64(textSnapshot), payloadType: 'InlineBase64' }] };
      const r = await clientFetch(`/api/items/dataflow/${encodeURIComponent(dataflowId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition, sink: sinkSnapshot }),
      });
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error || 'save failed'); return false; }
      setDirty(false);
      return true;
    } catch (e: any) {
      setDetailErr(e?.message || String(e));
      return false;
    } finally { setSaving(false); }
  }, [workspaceId, dataflowId, partPath, defText, sink]);

  // Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (workspaceId && dataflowId && dirty && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceId, dataflowId, dirty, saving, save]);

  // Run = Save (if dirty) then dispatch the ADF WranglingDataFlow run.
  const run = useCallback(async () => {
    if (!workspaceId || !dataflowId) return;
    setRunning(true); setRunMsg(null); setRunHint(null); setRunOk(null);
    try {
      if (dirty) { const ok = await save(); if (!ok) { setRunOk(false); setRunMsg('Save failed — fix the error above before running.'); return; } }
      const r = await clientFetch(`/api/items/dataflow/${encodeURIComponent(dataflowId)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setRunOk(false); setRunMsg(j.error || 'Run failed'); setRunHint(j.hint || null); return; }
      setRunOk(true);
      setRunMsg(`Run dispatched on ADF (${j.backend}). runId ${j.runId} · writes ${j.outputQuery} → ${j.pipelineName}.`);
    } catch (e: any) { setRunOk(false); setRunMsg(e?.message || String(e)); }
    finally { setRunning(false); }
  }, [workspaceId, dataflowId, dirty, save]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const r = await clientFetch(`/api/items/dataflow?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCreateName('');
      await loadList(workspaceId);
      if (j.dataflow?.id) setDataflowId(j.dataflow.id);
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, loadList]);

  const del = useCallback(async () => {
    if (!workspaceId || !dataflowId) return;
    if (!confirm('Delete this dataflow? This cannot be undone.')) return;
    await clientFetch(`/api/items/dataflow/${encodeURIComponent(dataflowId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setDataflowId('');
    await loadList(workspaceId);
  }, [workspaceId, dataflowId, loadList]);

  const canRun = !running && !saving && !!dataflowId;
  const canSave = !saving && !!dataflowId && dirty;
  const canDelete = !!dataflowId;
  const canCreate = !!workspaceId;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: running ? 'Running…' : 'Save & Run', onClick: canRun ? run : undefined, disabled: !canRun },
      ]},
      { label: 'Item', actions: [
        { label: 'New dataflow', onClick: canCreate ? () => setCreateOpen(true) : undefined, disabled: !canCreate },
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: 'Delete', onClick: canDelete ? del : undefined, disabled: !canDelete },
      ]},
      { label: 'Assist', actions: [
        { label: copilotOpen ? 'Hide Copilot' : 'Copilot', onClick: () => setCopilotOpen((v) => !v) },
      ]},
    ]},
  ], [running, canRun, run, canCreate, saving, canSave, save, canDelete, del, copilotOpen]);

  return (
    <ItemEditorChrome splitKeyPrefix={item.slug} item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <Flow20Regular /> Dataflows Gen2
          </Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && dataflows === null && <Spinner size="tiny" label="Loading…" />}
          {dataflows && dataflows.length === 0 && !listErr && <Caption1>No dataflows.</Caption1>}
          <Tree aria-label="Dataflows">
            {(dataflows || []).map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDataflowId(d.id)}>
                <TreeItemLayout iconBefore={<Flow20Regular />}>
                  {dataflowId === d.id ? <strong>{d.displayName}</strong> : d.displayName}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <TeachingBanner
            surfaceKey="dataflow-gen2-editor"
            title="Shape data with Power Query"
            message="Import from any connector, transform with Power Query M steps, and land the result to your lakehouse or warehouse. Loom runs this Azure-native on Azure Data Factory — no Fabric capacity required."
            learnMoreHref="https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview"
          />
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Dataflow Gen2</Badge>
            <Badge appearance="outline" color="success">
              Azure-native (ADF)
            </Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 280 }}>
              <Caption1>Workspace</Caption1>
              <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · dedicated' : ''}</option>
                ))}
              </Select>
            </div>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh list</Button>
            <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create dataflow Gen2</DialogTitle>
                  <DialogContent>
                    <Input placeholder="displayName" value={createName} onChange={(_, d) => setCreateName(d.value)} style={{ width: '100%' }} />
                    {createErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody className={s.breakText}>{createErr}</MessageBarBody></MessageBar>}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={create}>{createBusy ? 'Creating…' : 'Create'}</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
            <Button appearance="outline" icon={<Save20Regular />} disabled={!canSave} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={!canRun} onClick={run}>{running ? 'Running…' : 'Save & Run'}</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!dataflowId} onClick={del}>Delete</Button>
            <Button appearance={copilotOpen ? 'primary' : 'outline'} icon={<Sparkle20Regular />} onClick={() => setCopilotOpen((v) => !v)}>{copilotOpen ? 'Copilot on' : 'Copilot'}</Button>
          </div>

          {config && !config.adfConfigured && (
            <MessageBar intent="warning">
              <MessageBarBody className={s.breakText}>
                <MessageBarTitle>Data Factory not configured</MessageBarTitle>
                Authoring + Save work, but Run needs ADF. Set <code>{config.adfMissing || 'LOOM_ADF_NAME / LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID'}</code> on
                the Console app — deployed by <code>platform/fiab/bicep/modules/landing-zone/adf.bicep</code>.
              </MessageBarBody>
            </MessageBar>
          )}

          {(ws.error || listErr) && (
            <MessageBar intent="error">
              <MessageBarBody className={s.breakText}>
                <MessageBarTitle>Workspace list unavailable</MessageBarTitle>
                {ws.error || listErr}
                {(ws.hint || listHint) && <><br /><Caption1>{ws.hint || listHint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {detailErr && <MessageBar intent="error"><MessageBarBody className={s.breakText}>{detailErr}</MessageBarBody></MessageBar>}
          {runMsg && (
            <MessageBar intent={runOk === false ? 'error' : runOk ? 'success' : 'info'}>
              <MessageBarBody className={s.breakText}>
                {runMsg}
                {runHint && <><br /><Caption1>{runHint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}

          {!dataflowId && (
            <GuidedEmptyState
              variant="block"
              heroIcon={Flow24Regular}
              title="Design a dataflow"
              intro="Author Power Query (M), set an output destination, and Run it on ADF — no Fabric required. Start with a blank dataflow, then bring in Excel, CSV, SQL Server, or OData sources in the Power Query editor."
              columns={1}
              ariaLabel="Create a dataflow"
              paths={canCreate ? [{
                key: 'new', title: 'New dataflow',
                body: 'Create a dataflow in this workspace, then choose a get-data source.',
                icon: Add24Regular, onClick: () => setCreateOpen(true),
              }] : []}
              askCopilot={{ onClick: () => setCopilotOpen(true), body: 'Describe the transform in words and let Copilot draft the Power Query.' }}
              learnMoreHref="https://learn.microsoft.com/power-query/power-query-what-is-power-query"
            />
          )}
          {dataflowId && dirty && <Badge appearance="outline" color="warning" style={{ alignSelf: 'flex-start' }}>unsaved</Badge>}
          {dataflowId && <Caption1 className={s.breakText}>Definition part: <code>{partPath}</code></Caption1>}

          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'authoring' | 'output' | 'script')}>
              <Tab value="authoring">Power Query</Tab>
              <Tab value="output">Output destination</Tab>
              <Tab value="script">Script ({isM ? 'M' : 'JSON'})</Tab>
            </TabList>
          </div>

          {tab === 'authoring' && isM && dataflowId && defText === STARTER_M && !dirty && (
            <GuidedEmptyState
              variant="block"
              heroIcon={Flow24Regular}
              title="Get data"
              intro="Choose a source to start your Power Query. Each option drops a real, editable M query on the canvas — replace the placeholders with your connection details, then Run on ADF."
              ariaLabel="Import data into this dataflow"
              paths={IMPORT_SOURCES.map((src) => ({
                key: src.key, title: src.title, body: src.body, icon: src.icon,
                onClick: () => { setDefText(src.m); setDirty(true); },
              }))}
              askCopilot={{ onClick: () => setCopilotOpen(true), body: 'Describe the transform in words and let Copilot draft the Power Query.' }}
              learnMoreHref="https://learn.microsoft.com/power-query/connectors/"
            />
          )}
          {tab === 'authoring' && !(isM && dataflowId && defText === STARTER_M && !dirty) && (
            isM ? (
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flex: 1, minHeight: 0 }}>
                <PowerQueryHost
                  mScript={defText}
                  onChange={(v) => { setDefText(v); setDirty(true); }}
                  onActiveQueryChange={setActiveQuery}
                />
                {copilotOpen ? (
                  <DataflowCopilotPane
                    mScript={defText}
                    activeQuery={activeQuery}
                    onApply={(nextM) => { setDefText(nextM); setDirty(true); }}
                  />
                ) : (
                  <CollapsedRail side="right" label="Copilot" onExpand={() => setCopilotOpen(true)} />
                )}
              </div>
            ) : (
              <MessageBar intent="info">
                <MessageBarBody>
                  The Power Query editor projects Power Query (M). This dataflow part is
                  <code> {partPath}</code> — edit it on the Script tab.
                </MessageBarBody>
              </MessageBar>
            )
          )}

          {tab === 'output' && (
            <DestinationPicker
              sink={sink}
              queries={queryNames}
              onChange={(next) => { setSink(next); setDirty(true); }}
            />
          )}

          {tab === 'script' && (
            <MonacoTextarea
              value={defText}
              onChange={(v) => { setDefText(v); setDirty(true); }}
              language={isM ? 'plaintext' : 'json'}
              height={360}
              minHeight={280}
              ariaLabel="Dataflow definition"
            />
          )}
        </div>
      }
    />
  );
}
