'use client';

/**
 * Paginated report (RDL) editor — extracted from phase3-editors.tsx.
 *
 * Loom-native parity with a Power BI Paginated Report (.rdl), Azure-native by
 * DEFAULT (no Fabric / Power BI required). Moved BYTE-FOR-BYTE out of
 * phase3-editors.tsx; behavior is identical. The Power BI WorkspacePicker trio
 * (`PbiWorkspaceLite` / `usePowerBiWorkspaces` / `WorkspacePicker`) is duplicated
 * locally here — matching the sibling scorecard/activator editors — so this
 * module carries no import cycle back to the barrel; the `ReportLite` type is
 * imported directly from its defining sibling (`./report-editor`), not the barrel.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field, InfoLabel,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, Switch, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular,
  Save20Regular, Delete20Regular, ArrowSync20Regular,
  Table20Regular,
  Eye20Regular, Form20Regular,
} from '@fluentui/react-icons';
import { getItem } from '@/lib/api/workspaces';
import { ItemEditorChrome } from '../item-editor-chrome';
import { NotConfiguredBar, type NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';
import type {
  RdlReportDefinition, RdlDataSource, RdlDataset, RdlTablix, RdlParameter,
  RdlField, RdlDataSourceType, RdlExportFormat,
} from '@/lib/azure/paginated-report-client';
import { NewItemCreateGate } from '../new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import { type ReportLite } from './report-editor';
import { useStyles } from './styles';

interface PbiWorkspaceLite { id: string; name: string; description?: string; }

/**
 * usePowerBiWorkspaces — list real Power BI groups (NOT Loom workspaces).
 *
 * Power BI's list/detail/embed-token REST APIs key on a `workspaceId` that
 * is a Power BI groupId. Passing a Loom Cosmos UUID to those endpoints
 * returns 404 PowerBIEntityNotFound. This hook is the dedicated source for
 * the Report / Paginated Report / Dashboard / Semantic Model / Scorecard /
 * Dataflow editors.
 */
function usePowerBiWorkspaces() {
  const [workspaces, setWorkspaces] = useState<PbiWorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/powerbi/workspaces');
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || 'failed to list Power BI workspaces');
        setHint(j.hint || null);
        setWorkspaces([]);
      } else {
        // Power BI returns name + capacity SKU; surface the capacity in a
        // separate description field so the picker can show it as a hint
        // without polluting the displayed name.
        setWorkspaces(
          (j.workspaces || []).map((w: any) => ({
            id: w.id,
            name: w.name || w.displayName || w.id,
            description: w.capacityType ? `${w.capacityType}${w.isOnDedicatedCapacity ? ' · dedicated' : ''}` : undefined,
          })),
        );
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { workspaces, error, hint, loading, reload: load };
}

function WorkspacePicker({
  value, onChange, error, hint, loading, workspaces,
}: {
  value: string; onChange: (id: string) => void;
  error: string | null; hint: string | null; loading: boolean;
  workspaces: PbiWorkspaceLite[] | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 280 }}>
      <Caption1>Workspace</Caption1>
      <Select value={value} onChange={(_: unknown, d: any) => onChange(d.value)} disabled={loading || (workspaces?.length ?? 0) === 0}>
        {!value && <option value="">{loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
        {(workspaces || []).map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
            {error}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {!loading && !error && (workspaces?.length ?? 0) === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No Power BI workspaces</MessageBarTitle>
            The Console service principal can&apos;t see any Power BI workspaces. Create one (or get added to one) in Power BI, then Refresh.
            <br />
            <Button appearance="primary" size="small" style={{ marginTop: tokens.spacingVerticalS}}
              onClick={() => { try { window.open('https://app.powerbi.com/groups/me/list', '_blank', 'noreferrer'); } catch { /* popup blocked */ } }}>
              Open Power BI
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

export function PaginatedReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  return <PaginatedReportDesigner item={item} id={id} />;
}

// ============================================================
// Paginated report (RDL) designer — Azure-native, no Fabric/Power BI.
//
// Loom-native parity with a Power BI Paginated Report (.rdl): author data
// sources + dataset SQL + a tablix (columns / row groups / expressions) +
// parameters + page setup, then export to PDF / Excel / Word via the
// paginated-report-renderer Azure Function. The whole surface works with
// LOOM_DEFAULT_FABRIC_WORKSPACE UNSET (no-fabric-dependency.md). Export is the
// only honest-gated control (LOOM_PAGINATED_RENDER_URL); authoring is always on.
// ============================================================

const RDL_DS_TYPES: RdlDataSourceType[] = ['AzureSQL', 'Synapse', 'Cosmos', 'ADLS'];
const RDL_FIELD_TYPES: RdlField['type'][] = ['String', 'Int', 'Decimal', 'DateTime', 'Boolean'];
const RDL_PARAM_TYPES: RdlParameter['type'][] = ['String', 'Int', 'Boolean', 'DateTime'];
const RDL_AGGS = ['', 'Sum', 'Count', 'Avg', 'Max', 'Min'] as const;

function rdlId(prefix: string): string {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${rnd}`;
}

/** Build a default detail-row cell expression for a field. */
function fieldExpr(field: string): string { return `Fields!${field}.Value`; }
/** Build an aggregate expression token. */
function aggExpr(agg: string, field: string): string { return agg ? `=${agg}(Fields!${field}.Value)` : fieldExpr(field); }
/** Parse {agg, field} back out of a stored cell expression (for the picker). */
function parseExpr(expr: string): { agg: string; field: string } {
  const m = /^=(\w+)\(Fields!(.+?)\.Value\)$/.exec(expr);
  if (m) return { agg: m[1], field: m[2] };
  const f = /^Fields!(.+?)\.Value$/.exec(expr);
  return { agg: '', field: f ? f[1] : '' };
}

function PaginatedReportDesigner({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [workspaceId, setWorkspaceId] = useState('');
  const [def, setDef] = useState<RdlReportDefinition | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [renderDeployed, setRenderDeployed] = useState(false);
  const [exportBusy, setExportBusy] = useState<RdlExportFormat | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [exportHint, setExportHint] = useState<NotConfiguredHint | undefined>(undefined);

  // ── Power BI in-place embed (OPT-IN) ─────────────────────────────────────
  // The Azure-native designer + export above are the DEFAULT and work with no
  // Power BI / Fabric (no-fabric-dependency.md). When the Console identity is
  // registered in Power BI and added to a workspace, an additional "Live
  // preview (Power BI)" tab embeds a published paginated (RDL) report in place
  // via IPaginatedReportLoadConfiguration — the same renderer + multi-resource
  // embed-token route the report editor uses. The operator picks the Power BI
  // workspace + published paginated report to view; the RDL parameter form
  // seeds the report parameters (rp:) the viewer exposes.
  const pbiWs = usePowerBiWorkspaces();
  const powerBiConfigured = !!(pbiWs.workspaces && pbiWs.workspaces.length > 0 && !pbiWs.error);
  const [designView, setDesignView] = useState<'designer' | 'preview'>('designer');
  const [pbiWorkspaceId, setPbiWorkspaceId] = useState('');
  const [pbiReports, setPbiReports] = useState<ReportLite[] | null>(null);
  const [pbiReportId, setPbiReportId] = useState('');
  const [pbiListErr, setPbiListErr] = useState<string | null>(null);
  const [pbiListBusy, setPbiListBusy] = useState(false);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; reportId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [viewerErr, setViewerErr] = useState<string | null>(null);

  // Dialogs
  const [dsDialog, setDsDialog] = useState<{ open: boolean; editing?: RdlDataSource }>(() => ({ open: false }));
  const [dsetDialog, setDsetDialog] = useState<{ open: boolean; editing?: RdlDataset }>(() => ({ open: false }));
  const [tablixWizard, setTablixWizard] = useState(false);
  const [paramDialog, setParamDialog] = useState<{ open: boolean; editing?: RdlParameter }>(() => ({ open: false }));
  const [selectedTablix, setSelectedTablix] = useState<string>('');

  const isNew = id === 'new';

  // Resolve the owning Loom workspace (partition key) from the item.
  useEffect(() => {
    if (isNew) { setLoadErr(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const it = await getItem(item.slug, id);
        if (!cancelled) setWorkspaceId(it.workspaceId);
      } catch (e: any) { if (!cancelled) setLoadErr(e?.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [item.slug, id, isNew]);

  // Load the RDL definition once the workspace is known.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/paginated-report/${encodeURIComponent(id)}/definition?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) { setDef(j.definition); setSelectedTablix(j.definition.tablixes?.[0]?.id || ''); setIsDirty(false); }
        else setLoadErr(j.error || `HTTP ${r.status}`);
      } catch (e: any) { if (!cancelled) setLoadErr(e?.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, id]);

  // Renderer capability probe (pre-disable Export with the exact remediation).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/items/paginated-report/capabilities');
        const j = await r.json();
        if (!cancelled && j.ok) setRenderDeployed(!!j.renderDeployed);
      } catch { /* leave disabled */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const patch = useCallback((mut: (d: RdlReportDefinition) => RdlReportDefinition) => {
    setDef((prev) => (prev ? mut(structuredClone(prev)) : prev));
    setIsDirty(true);
    setSaveMsg(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!def) return;
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await fetch(`/api/items/paginated-report/${encodeURIComponent(id)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(def),
      });
      const j = await r.json();
      if (j.ok) { setDef(j.definition); setIsDirty(false); setSaveMsg({ ok: true, text: 'Report saved.' }); }
      else setSaveMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [def, id]);

  const doExport = useCallback(async (format: RdlExportFormat) => {
    if (!def || !workspaceId) return;
    setExportBusy(format); setExportErr(null); setExportHint(undefined);
    try {
      // Export goes through the binary /export route (real PDF / Excel / Word
      // bytes from the renderer Function), NOT /render (which returns the
      // on-screen JSON page-model). Send the authored definition so the export
      // reflects exactly what's on screen. Parameter defaults seed the renderer
      // as structured values (not a free-form blob — loom-no-freeform-config).
      const parameterValues = (def.parameters || [])
        .filter((p) => p.defaultValue != null && p.defaultValue !== '')
        .map((p) => ({ name: p.name, value: String(p.defaultValue) }));
      const r = await fetch(`/api/items/paginated-report/${encodeURIComponent(id)}/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: def, workspaceId, format, parameterValues }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setExportErr(j.error || `export failed (HTTP ${r.status})`);
        if (j.hint) setExportHint(j.hint);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(def.name || 'report').replace(/[^A-Za-z0-9._-]+/g, '_')}.${format}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) { setExportErr(e?.message || String(e)); }
    finally { setExportBusy(null); }
  }, [def, workspaceId, id]);

  // Default the Power BI workspace to the first one the Console can see, so the
  // preview tab loads its paginated-report list without a manual pick.
  useEffect(() => {
    if (!pbiWorkspaceId && pbiWs.workspaces && pbiWs.workspaces.length > 0) setPbiWorkspaceId(pbiWs.workspaces[0].id);
  }, [pbiWorkspaceId, pbiWs.workspaces]);

  // List the published Power BI paginated (RDL) reports in the picked workspace.
  // Real REST via the BFF (GET /api/items/paginated-report?workspaceId=…). Kept
  // as a callback so the toolbar "Reload" button can re-run it in place when a
  // report is published while the preview tab is open.
  const loadPbiReports = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!powerBiConfigured || !pbiWorkspaceId) { setPbiReports(null); return; }
    setPbiListErr(null);
    setPbiListBusy(true);
    try {
      const r = await fetch(`/api/items/paginated-report?workspaceId=${encodeURIComponent(pbiWorkspaceId)}`);
      const j = await r.json();
      if (signal?.cancelled) return;
      if (j.ok) {
        setPbiReports(j.reports || []);
        setPbiReportId((prev) => prev || (j.reports?.[0]?.id ?? ''));
      } else { setPbiReports([]); setPbiListErr(j.error || `HTTP ${r.status}`); }
    } catch (e: any) { if (!signal?.cancelled) { setPbiReports([]); setPbiListErr(e?.message || String(e)); } }
    finally { if (!signal?.cancelled) setPbiListBusy(false); }
  }, [powerBiConfigured, pbiWorkspaceId]);

  useEffect(() => {
    const signal = { cancelled: false };
    void loadPbiReports(signal);
    return () => { signal.cancelled = true; };
  }, [loadPbiReports]);

  // Mint a per-report paginated embed token whenever the selected published
  // Power BI report changes. Paginated reports use the MULTI-RESOURCE
  // GenerateToken (reports[] + referenced semantic-model datasets[]) — the same
  // dedicated BFF route the report editor uses (no separate pbi-paginated SDK).
  useEffect(() => {
    if (!powerBiConfigured || designView !== 'preview' || !pbiWorkspaceId || !pbiReportId) { setEmbed(null); return; }
    let cancelled = false;
    (async () => {
      setEmbedErr(null); setViewerErr(null);
      try {
        const sel = pbiReports?.find((r) => r.id === pbiReportId);
        const r = await fetch(`/api/items/report/${encodeURIComponent(pbiReportId)}/paginated-embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: pbiWorkspaceId, datasetIds: sel?.datasetId ? [sel.datasetId] : [] }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, reportId: j.reportId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) { if (!cancelled) { setEmbedErr(e?.message || String(e)); setEmbed(null); } }
    })();
    return () => { cancelled = true; };
  }, [powerBiConfigured, designView, pbiWorkspaceId, pbiReportId, pbiReports]);

  // Structured `rp:` parameter values seeded into the embed from the RDL
  // parameter form — NOT a free-form JSON blob (loom-no-freeform-config.md).
  // Only parameters that carry a default value are sent; the viewer's parameter
  // bar lets the user change them in place. (Multi-value is unsupported when
  // embedding paginated reports, so each parameter contributes a single value.)
  const paramValues = useMemo<Array<{ name: string; value: string }>>(
    () => (def?.parameters || [])
      .filter((p) => p.defaultValue != null && p.defaultValue !== '')
      .map((p) => ({ name: p.name, value: String(p.defaultValue) })),
    [def?.parameters],
  );

  // The `error` event is the ONLY load signal paginated embeds emit (Microsoft
  // documents that `loaded`/`rendered` do not fire for paginated reports), so we
  // wire just that to surface a render failure in the viewer banner.
  const onEmbedded = useCallback((e: any) => {
    try {
      e?.on?.('error', (ev: any) => {
        const msg = ev?.detail?.message || ev?.detail?.detailedMessage;
        if (msg) setViewerErr(String(msg));
      });
    } catch { /* event wiring best-effort */ }
  }, []);

  if (isNew) {
    return (
      <NewItemCreateGate item={item} createLabel="New paginated report"
        intro="Author a Loom-native paginated (RDL) report — data sources, dataset queries, a tablix, and parameters — then export to PDF, Excel, or Word. No Microsoft Fabric or Power BI workspace required." />
    );
  }

  const hasDefinition = !!def && def.tablixes.length > 0;
  const exportDisabledReason = !renderDeployed
    ? 'Set LOOM_PAGINATED_RENDER_URL to enable export'
    : !hasDefinition ? 'Add a tablix first' : isDirty ? 'Save the report first' : undefined;

  const ribbon: RibbonTab[] = [
    { id: 'home', label: 'Home', groups: [
      { label: 'Report', actions: [
        { label: saveBusy ? 'Saving…' : 'Save', icon: <Save20Regular />, onClick: def ? handleSave : undefined, disabled: !def || saveBusy || !isDirty },
      ]},
      { label: 'Data', actions: [
        { label: 'Add data source', icon: <Database20Regular />, onClick: () => setDsDialog({ open: true }), disabled: !def,
          title: 'Connect to Azure SQL / Synapse / Cosmos / ADLS' },
        { label: 'Add dataset', icon: <DocumentTable20Regular />, onClick: () => setDsetDialog({ open: true }), disabled: !def || (def?.dataSources.length ?? 0) === 0,
          title: (def?.dataSources.length ?? 0) === 0 ? 'Add a data source first' : 'Define a SQL query over a data source; its fields bind into tables' },
      ]},
      { label: 'Design', actions: [
        { label: 'Add tablix', icon: <Table20Regular />, onClick: () => setTablixWizard(true), disabled: !def || (def?.datasets.length ?? 0) === 0,
          title: (def?.datasets.length ?? 0) === 0 ? 'Add a dataset first' : 'Add a table or matrix with row/column groups' },
        { label: 'Add parameter', icon: <Form20Regular />, onClick: () => setParamDialog({ open: true }), disabled: !def,
          title: 'A value the report viewer is prompted for at render time' },
      ]},
      { label: 'Export', actions: [
        { label: exportBusy === 'pdf' ? 'Exporting…' : 'Export PDF', onClick: () => doExport('pdf'),
          disabled: !!exportDisabledReason || !!exportBusy, title: exportDisabledReason },
        { label: exportBusy === 'xlsx' ? 'Exporting…' : 'Export Excel', onClick: () => doExport('xlsx'),
          disabled: !!exportDisabledReason || !!exportBusy, title: exportDisabledReason },
        { label: exportBusy === 'docx' ? 'Exporting…' : 'Export Word', onClick: () => doExport('docx'),
          disabled: !!exportDisabledReason || !!exportBusy, title: exportDisabledReason },
      ]},
    ]},
  ];

  const selTablix = def?.tablixes.find((t) => t.id === selectedTablix) || null;

  const leftPanel = def ? (
    <div className={s.treePad}>
      <Tree aria-label="Paginated report objects" defaultOpenItems={['ds', 'dsets', 'items', 'params']}>
        <TreeItem itemType="branch" value="ds">
          <TreeItemLayout iconBefore={<Database20Regular />}>Data sources ({def.dataSources.length})</TreeItemLayout>
          <Tree>
            {def.dataSources.map((ds) => (
              <TreeItem key={ds.id} itemType="leaf" value={ds.id}>
                <TreeItemLayout onClick={() => setDsDialog({ open: true, editing: ds })}>{ds.name} · {ds.type}</TreeItemLayout>
              </TreeItem>
            ))}
            {def.dataSources.length === 0 && <TreeItem itemType="leaf" value="ds-empty"><TreeItemLayout><Caption1>none yet</Caption1></TreeItemLayout></TreeItem>}
          </Tree>
        </TreeItem>
        <TreeItem itemType="branch" value="dsets">
          <TreeItemLayout iconBefore={<DocumentTable20Regular />}>Datasets ({def.datasets.length})</TreeItemLayout>
          <Tree>
            {def.datasets.map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id}>
                <TreeItemLayout onClick={() => setDsetDialog({ open: true, editing: d })}>{d.name} ({d.fields.length} fields)</TreeItemLayout>
              </TreeItem>
            ))}
            {def.datasets.length === 0 && <TreeItem itemType="leaf" value="dset-empty"><TreeItemLayout><Caption1>none yet</Caption1></TreeItemLayout></TreeItem>}
          </Tree>
        </TreeItem>
        <TreeItem itemType="branch" value="items">
          <TreeItemLayout iconBefore={<Table20Regular />}>Report items ({def.tablixes.length})</TreeItemLayout>
          <Tree>
            {def.tablixes.map((t) => (
              <TreeItem key={t.id} itemType="leaf" value={t.id}>
                <TreeItemLayout onClick={() => setSelectedTablix(t.id)}
                  style={t.id === selectedTablix ? { fontWeight: 600 } : undefined}>{t.name}</TreeItemLayout>
              </TreeItem>
            ))}
            {def.tablixes.length === 0 && <TreeItem itemType="leaf" value="tbx-empty"><TreeItemLayout><Caption1>none yet</Caption1></TreeItemLayout></TreeItem>}
          </Tree>
        </TreeItem>
        <TreeItem itemType="branch" value="params">
          <TreeItemLayout iconBefore={<Form20Regular />}>Parameters ({def.parameters.length})</TreeItemLayout>
          <Tree>
            {def.parameters.map((p) => (
              <TreeItem key={p.name} itemType="leaf" value={p.name}>
                <TreeItemLayout onClick={() => setParamDialog({ open: true, editing: p })}>{p.name} · {p.type}</TreeItemLayout>
              </TreeItem>
            ))}
            {def.parameters.length === 0 && <TreeItem itemType="leaf" value="param-empty"><TreeItemLayout><Caption1>none yet</Caption1></TreeItemLayout></TreeItem>}
          </Tree>
        </TreeItem>
      </Tree>
    </div>
  ) : undefined;

  const main = (
    <div className={s.pad}>
      {loadErr && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load report</MessageBarTitle>{loadErr}</MessageBarBody></MessageBar>
      )}
      {saveMsg && (
        <MessageBar intent={saveMsg.ok ? 'success' : 'error'}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>
      )}
      {exportErr && (
        <NotConfiguredBar surface="Paginated report export" hint={exportHint} rawError={exportErr} />
      )}
      {!renderDeployed && designView === 'designer' && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Export renderer not wired in this deployment</MessageBarTitle>
          Authoring works fully. To enable PDF / Excel / Word export, deploy{' '}
          <code>azure-functions/paginated-report-renderer/deploy/main.bicep</code> and set{' '}
          <code>LOOM_PAGINATED_RENDER_URL</code> on the Console.
        </MessageBarBody></MessageBar>
      )}

      {/* Designer (Azure-native DEFAULT) vs. opt-in Power BI live preview. The
          preview tab is disabled-with-reason until Power BI is configured, so
          there is never a dead control (no-vaporware.md). */}
      <TabList selectedValue={designView} onTabSelect={(_, d) => setDesignView(d.value as 'designer' | 'preview')} style={{ marginBottom: tokens.spacingVerticalS}}>
        <Tab value="designer" icon={<Table20Regular />}>Designer</Tab>
        <Tab value="preview" icon={<Eye20Regular />} disabled={!powerBiConfigured}
          title={powerBiConfigured ? 'Embed a published Power BI paginated report in place' : 'Power BI embed is opt-in; the Console identity is not registered in any Power BI workspace'}>
          Live preview (Power BI)
        </Tab>
      </TabList>

      {designView === 'preview' && (
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className={s.toolbar} style={{ marginBottom: tokens.spacingVerticalS, alignItems: 'end' }}>
            <Badge appearance="filled" color="brand" style={{ marginBottom: tokens.spacingVerticalS}}>Power BI live preview</Badge>
            <WorkspacePicker value={pbiWorkspaceId} onChange={(v) => { setPbiWorkspaceId(v); setPbiReportId(''); }} {...pbiWs} />
            <Field label="Published paginated report" style={{ minWidth: 280 }}>
              <Select value={pbiReportId} onChange={(_, d) => setPbiReportId((d as any).value)} disabled={!pbiReports || pbiReports.length === 0}>
                {!pbiReportId && <option value="">{pbiReports == null ? 'Loading…' : 'Select a paginated report'}</option>}
                {(pbiReports || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            </Field>
            <Button appearance="outline" icon={pbiListBusy ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
              onClick={() => void loadPbiReports()} disabled={!pbiWorkspaceId || pbiListBusy}
              title="Re-list the published paginated reports in this Power BI workspace">
              {pbiListBusy ? 'Reloading…' : 'Reload'}
            </Button>
          </div>
          {pbiListErr && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalS}}><MessageBarBody><MessageBarTitle>Could not list paginated reports</MessageBarTitle>{pbiListErr}</MessageBarBody></MessageBar>}
          {pbiReports && pbiReports.length === 0 && !pbiListErr && (
            <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalS}}>
              <MessageBarBody>
                <MessageBarTitle>No published paginated reports</MessageBarTitle>
                This Power BI workspace has no paginated (RDL) reports to embed. Publish one to Power BI (or pick a different
                workspace). The Loom-native <strong>Designer</strong> + <strong>Export</strong> path needs no Power BI.
              </MessageBarBody>
            </MessageBar>
          )}
          {viewerErr && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalS}}><MessageBarBody>{viewerErr}</MessageBarBody></MessageBar>}
          {pbiReportId && (
            embed ? (
              <>
                <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalS}}>
                  <MessageBarBody>
                    <MessageBarTitle>Paginated report — in-place embed</MessageBarTitle>
                    Rendered live via the Power BI paginated viewer (IPaginatedReportLoadConfiguration).
                    Use the parameter bar to filter; drill-through links inside the report navigate in place.
                    Use the <strong>Export</strong> ribbon (PDF / Excel / Word) for a downloadable copy.
                  </MessageBarBody>
                </MessageBar>
                <PowerBIEmbedFrame
                  embedType="report"
                  embedVariant="paginated"
                  id={embed.reportId}
                  embedUrl={embed.embedUrl}
                  accessToken={embed.token}
                  height={680}
                  parameterValues={paramValues}
                  onEmbedded={onEmbedded}
                />
              </>
            ) : embedErr ? (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Could not mint paginated embed token</MessageBarTitle>
                  {embedErr}. The Console UAMI must be a workspace <strong>Member</strong> (not Contributor/Viewer)
                  and the tenant setting <strong>&ldquo;Service principals can use Fabric APIs&rdquo;</strong> must be enabled
                  with the UAMI&rsquo;s security group. In GCC-High / DoD set{' '}
                  <code>LOOM_POWERBI_BASE=https://api.powerbigov.us/v1.0/myorg</code>.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'center', padding: `${tokens.spacingVerticalXXXL} 0` }}>
                <Spinner size="medium" label="Loading paginated report embed…" labelPosition="below" />
              </div>
            )
          )}
        </div>
      )}

      {designView === 'designer' && def && (
        <>
          {/* Report + page setup */}
          <div className={s.card}>
            <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>Report</Subtitle2>
            <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', alignItems: 'end' }}>
              <Field label="Name" style={{ minWidth: 260 }}>
                <Input value={def.name} onChange={(_, d) => patch((x) => ({ ...x, name: d.value }))} />
              </Field>
              <Field label="Page size" style={{ minWidth: 130 }}>
                <Dropdown selectedOptions={[def.pageSize]} value={def.pageSize}
                  onOptionSelect={(_, d) => patch((x) => ({ ...x, pageSize: (d.optionValue as RdlReportDefinition['pageSize']) || x.pageSize }))}>
                  {['Letter', 'A4', 'Legal'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Orientation" style={{ minWidth: 140 }}>
                <Dropdown selectedOptions={[def.pageOrientation]} value={def.pageOrientation}
                  onOptionSelect={(_, d) => patch((x) => ({ ...x, pageOrientation: (d.optionValue as RdlReportDefinition['pageOrientation']) || x.pageOrientation }))}>
                  {['Portrait', 'Landscape'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                </Dropdown>
              </Field>
            </div>
          </div>

          {/* Selected tablix designer */}
          {selTablix ? (
            <TablixDesignSurface
              tablix={selTablix}
              dataset={def.datasets.find((d) => d.id === selTablix.datasetId) || null}
              onChange={(next) => patch((x) => ({ ...x, tablixes: x.tablixes.map((t) => (t.id === next.id ? next : t)) }))}
              onDelete={() => { patch((x) => ({ ...x, tablixes: x.tablixes.filter((t) => t.id !== selTablix.id) })); setSelectedTablix(''); }}
            />
          ) : (
            <div className={s.card}>
              <Caption1>
                No report item selected. Use <strong>Add data source → Add dataset → Add tablix</strong> to design a paginated report,
                then <strong>Export PDF / Excel / Word</strong>.
              </Caption1>
            </div>
          )}
        </>
      )}
      {designView === 'designer' && !def && !loadErr && <Spinner label="Loading report…" />}
    </div>
  );

  return (
    <>
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} leftPanel={leftPanel} main={main} />
      {def && (
        <>
          <DataSourceDialog
            open={dsDialog.open}
            editing={dsDialog.editing}
            onClose={() => setDsDialog({ open: false })}
            onSave={(ds) => {
              patch((x) => {
                const exists = x.dataSources.some((d) => d.id === ds.id);
                return { ...x, dataSources: exists ? x.dataSources.map((d) => (d.id === ds.id ? ds : d)) : [...x.dataSources, ds] };
              });
              setDsDialog({ open: false });
            }}
            onDelete={dsDialog.editing ? (dsId) => { patch((x) => ({ ...x, dataSources: x.dataSources.filter((d) => d.id !== dsId) })); setDsDialog({ open: false }); } : undefined}
          />
          <DatasetDialog
            open={dsetDialog.open}
            editing={dsetDialog.editing}
            dataSources={def.dataSources}
            reportId={id}
            onClose={() => setDsetDialog({ open: false })}
            onSave={(d) => {
              patch((x) => {
                const exists = x.datasets.some((q) => q.id === d.id);
                return { ...x, datasets: exists ? x.datasets.map((q) => (q.id === d.id ? d : q)) : [...x.datasets, d] };
              });
              setDsetDialog({ open: false });
            }}
            onDelete={dsetDialog.editing ? (dId) => { patch((x) => ({ ...x, datasets: x.datasets.filter((q) => q.id !== dId) })); setDsetDialog({ open: false }); } : undefined}
          />
          <AddTablixWizard
            open={tablixWizard}
            datasets={def.datasets}
            onClose={() => setTablixWizard(false)}
            onCreate={(t) => { patch((x) => ({ ...x, tablixes: [...x.tablixes, t] })); setSelectedTablix(t.id); setTablixWizard(false); }}
          />
          <ParameterDialog
            open={paramDialog.open}
            editing={paramDialog.editing}
            onClose={() => setParamDialog({ open: false })}
            onSave={(p) => {
              patch((x) => {
                const exists = x.parameters.some((q) => q.name === p.name);
                return { ...x, parameters: exists ? x.parameters.map((q) => (q.name === p.name ? p : q)) : [...x.parameters, p] };
              });
              setParamDialog({ open: false });
            }}
            onDelete={paramDialog.editing ? (name) => { patch((x) => ({ ...x, parameters: x.parameters.filter((q) => q.name !== name) })); setParamDialog({ open: false }); } : undefined}
          />
        </>
      )}
    </>
  );
}

// --- Tablix design surface: header labels + per-column expression picker ---
function TablixDesignSurface({ tablix, dataset, onChange, onDelete }: {
  tablix: RdlTablix; dataset: RdlDataset | null;
  onChange: (t: RdlTablix) => void; onDelete: () => void;
}) {
  const s = useStyles();
  const fieldNames = dataset?.fields.map((f) => f.name) ?? [];
  const detailRow = tablix.cells[0] ?? [];

  const setHeader = (ci: number, label: string) => {
    const headerRow = [...tablix.headerRow]; headerRow[ci] = label;
    onChange({ ...tablix, headerRow });
  };
  const setExpr = (ci: number, expr: string) => {
    const cells = tablix.cells.map((r) => [...r]);
    if (!cells[0]) cells[0] = [];
    cells[0][ci] = { ...(cells[0][ci] || { expression: '' }), expression: expr };
    onChange({ ...tablix, cells });
  };

  return (
    <div className={s.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacingVerticalS}}>
        <Subtitle2>Tablix · {tablix.name}</Subtitle2>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
          <Switch label="Column headers" checked={tablix.showColumnHeaders}
            onChange={(_, d) => onChange({ ...tablix, showColumnHeaders: d.checked })} />
          <Switch label="Page break" checked={tablix.pageBreak}
            onChange={(_, d) => onChange({ ...tablix, pageBreak: d.checked })} />
          <Button appearance="subtle" icon={<Delete20Regular />} onClick={onDelete}>Delete tablix</Button>
        </div>
      </div>
      <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>
        Dataset: {dataset?.name || '—'} · row groups: {tablix.rowGroups.length ? tablix.rowGroups.join(', ') : 'none'}
      </Caption1>
      <div className={s.tableWrap}>
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: 120 }}>Field</TableHeaderCell>
              <TableHeaderCell>Header label</TableHeaderCell>
              <TableHeaderCell style={{ width: 360 }}>Cell expression</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tablix.columns.map((col, ci) => {
              const parsed = parseExpr(detailRow[ci]?.expression || fieldExpr(col));
              return (
                <TableRow key={col}>
                  <TableCell><Badge appearance="outline">{col}</Badge></TableCell>
                  <TableCell>
                    <Input size="small" value={tablix.headerRow[ci] ?? col} onChange={(_, d) => setHeader(ci, d.value)} />
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                      <Dropdown size="small" style={{ minWidth: 110 }}
                        selectedOptions={[parsed.agg]} value={parsed.agg || '(value)'}
                        onOptionSelect={(_, d) => setExpr(ci, aggExpr(d.optionValue || '', parsed.field || col))}>
                        {RDL_AGGS.map((a) => <Option key={a || 'none'} value={a}>{a || '(value)'}</Option>)}
                      </Dropdown>
                      <Dropdown size="small" style={{ minWidth: 140 }}
                        selectedOptions={[parsed.field || col]} value={parsed.field || col}
                        onOptionSelect={(_, d) => setExpr(ci, aggExpr(parsed.agg, d.optionValue || col))}>
                        {(fieldNames.length ? fieldNames : [col]).map((f) => <Option key={f} value={f}>{f}</Option>)}
                      </Dropdown>
                      <Caption1 style={{ fontFamily: 'Consolas, monospace' }}>{detailRow[ci]?.expression || fieldExpr(col)}</Caption1>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// --- Data source dialog ---
function DataSourceDialog({ open, editing, onClose, onSave, onDelete }: {
  open: boolean; editing?: RdlDataSource;
  onClose: () => void; onSave: (ds: RdlDataSource) => void; onDelete?: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<RdlDataSourceType>('AzureSQL');
  const [server, setServer] = useState('');
  const [database, setDatabase] = useState('');
  useEffect(() => {
    if (open) {
      setName(editing?.name || '');
      setType(editing?.type || 'AzureSQL');
      setServer(editing?.server || '');
      setDatabase(editing?.database || '');
    }
  }, [open, editing]);
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{editing ? 'Edit data source' : 'Add data source'}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
              <Field label="Name" required><Input value={name} onChange={(_, d) => setName(d.value)} /></Field>
              <Field label="Type">
                <Dropdown selectedOptions={[type]} value={type} onOptionSelect={(_, d) => setType((d.optionValue as RdlDataSourceType) || 'AzureSQL')}>
                  {RDL_DS_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Server / host" hint="e.g. myserver.database.windows.net (AzureSQL) or ws-ondemand.sql.azuresynapse.net (Synapse)">
                <Input value={server} onChange={(_, d) => setServer(d.value)} />
              </Field>
              <Field label="Database / pool"><Input value={database} onChange={(_, d) => setDatabase(d.value)} /></Field>
            </div>
          </DialogContent>
          <DialogActions>
            {editing && onDelete && <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => onDelete(editing.id)}>Delete</Button>}
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!name.trim()}
              onClick={() => onSave({ id: editing?.id || rdlId('ds'), name: name.trim(), type, server: server.trim() || undefined, database: database.trim() || undefined })}>
              {editing ? 'Save' : 'Add'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// --- Dataset dialog (Monaco SQL + Run preview → fields/sampleRows) ---
function DatasetDialog({ open, editing, dataSources, reportId, onClose, onSave, onDelete }: {
  open: boolean; editing?: RdlDataset; dataSources: RdlDataSource[]; reportId: string;
  onClose: () => void; onSave: (d: RdlDataset) => void; onDelete?: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [dataSourceId, setDataSourceId] = useState('');
  const [query, setQuery] = useState('');
  const [fields, setFields] = useState<RdlField[]>([]);
  const [sampleRows, setSampleRows] = useState<Array<Record<string, unknown>>>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewMsg, setPreviewMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.name || '');
      setDataSourceId(editing?.dataSourceId || dataSources[0]?.id || '');
      setQuery(editing?.query || 'SELECT TOP 50 * FROM dbo.YourTable');
      setFields(editing?.fields || []);
      setSampleRows(editing?.sampleRows || []);
      setPreviewMsg(null);
    }
  }, [open, editing, dataSources]);

  const runPreview = useCallback(async () => {
    const ds = dataSources.find((d) => d.id === dataSourceId);
    if (!ds) { setPreviewMsg({ ok: false, text: 'pick a data source first' }); return; }
    setPreviewBusy(true); setPreviewMsg(null);
    try {
      const r = await fetch(`/api/items/paginated-report/${encodeURIComponent(reportId)}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataSource: { type: ds.type, server: ds.server, database: ds.database }, query }),
      });
      const j = await r.json();
      if (j.ok) {
        setFields(j.fields);
        setSampleRows(j.sampleRows);
        setPreviewMsg({ ok: true, text: `${j.fields.length} fields · ${j.sampleRows.length} sample rows captured${j.truncated ? ' (truncated)' : ''}` });
      } else setPreviewMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setPreviewMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setPreviewBusy(false); }
  }, [dataSources, dataSourceId, query, reportId]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>{editing ? 'Edit dataset' : 'Add dataset'}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
              <Field label="Name" required><Input value={name} onChange={(_, d) => setName(d.value)} /></Field>
              <Field label="Data source">
                <Dropdown selectedOptions={[dataSourceId]} value={dataSources.find((d) => d.id === dataSourceId)?.name || ''}
                  onOptionSelect={(_, d) => setDataSourceId(d.optionValue || '')}>
                  {dataSources.map((d) => <Option key={d.id} value={d.id} text={`${d.name} (${d.type})`}>{d.name} ({d.type})</Option>)}
                </Dropdown>
              </Field>
              <Field label="Query (T-SQL)">
                <MonacoTextarea value={query} onChange={setQuery} language="sql" minHeight={160} />
              </Field>
              <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                <Button appearance="secondary" icon={<Play20Regular />} onClick={runPreview} disabled={previewBusy || !dataSourceId}>
                  {previewBusy ? 'Running…' : 'Run preview'}
                </Button>
                {previewMsg && <Caption1 style={{ color: previewMsg.ok ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>{previewMsg.text}</Caption1>}
              </div>
              {fields.length > 0 && (
                <Field label={`Fields (${fields.length})`}>
                  <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                    {fields.map((f) => <Badge key={f.name} appearance="outline">{f.name}: {f.type}</Badge>)}
                  </div>
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {editing && onDelete && <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => onDelete(editing.id)}>Delete</Button>}
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!name.trim() || !dataSourceId || fields.length === 0}
              title={fields.length === 0 ? 'Run preview to capture fields first' : undefined}
              onClick={() => onSave({ id: editing?.id || rdlId('dset'), name: name.trim(), dataSourceId, query, fields, sampleRows })}>
              {editing ? 'Save' : 'Add'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// --- Add tablix wizard: dataset → columns → row groups → headers ---
function AddTablixWizard({ open, datasets, onClose, onCreate }: {
  open: boolean; datasets: RdlDataset[];
  onClose: () => void; onCreate: (t: RdlTablix) => void;
}) {
  const [name, setName] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [rowGroups, setRowGroups] = useState<string[]>([]);
  const [headers, setHeaders] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setName(`Table ${Math.floor(Math.random() * 900 + 100)}`);
      const first = datasets[0];
      setDatasetId(first?.id || '');
      setColumns(first?.fields.map((f) => f.name) || []);
      setRowGroups([]);
      setHeaders(Object.fromEntries((first?.fields || []).map((f) => [f.name, f.name])));
    }
  }, [open, datasets]);

  const ds = datasets.find((d) => d.id === datasetId) || null;
  const allFields = ds?.fields.map((f) => f.name) ?? [];

  const onPickDataset = (dsetId: string) => {
    setDatasetId(dsetId);
    const next = datasets.find((d) => d.id === dsetId);
    const fns = next?.fields.map((f) => f.name) || [];
    setColumns(fns);
    setHeaders(Object.fromEntries(fns.map((f) => [f, f])));
    setRowGroups([]);
  };

  const create = () => {
    if (!ds || columns.length === 0) return;
    const t: RdlTablix = {
      id: rdlId('tbx'),
      name: name.trim() || 'Table',
      datasetId,
      columns,
      rowGroups,
      headerRow: columns.map((c) => headers[c] || c),
      cells: [columns.map((c) => ({ expression: fieldExpr(c) }))],
      showColumnHeaders: true,
      pageBreak: false,
    };
    onCreate(t);
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Add tablix</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
              <Field label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} /></Field>
              <Field label="Dataset">
                <Dropdown selectedOptions={[datasetId]} value={ds?.name || ''} onOptionSelect={(_, d) => onPickDataset(d.optionValue || '')}>
                  {datasets.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
                </Dropdown>
              </Field>
              <Field label={`Columns (${columns.length})`}>
                <Dropdown multiselect selectedOptions={columns}
                  value={columns.join(', ')}
                  onOptionSelect={(_, d) => setColumns(d.selectedOptions)}>
                  {allFields.map((f) => <Option key={f} value={f}>{f}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Row groups (optional)">
                <Dropdown multiselect selectedOptions={rowGroups}
                  value={rowGroups.join(', ')}
                  onOptionSelect={(_, d) => setRowGroups(d.selectedOptions)}>
                  {allFields.map((f) => <Option key={f} value={f}>{f}</Option>)}
                </Dropdown>
              </Field>
              {columns.length > 0 && (
                <Field label="Column headers">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    {columns.map((c) => (
                      <div key={c} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                        <Badge appearance="outline" style={{ minWidth: 120 }}>{c}</Badge>
                        <Input size="small" value={headers[c] ?? c} onChange={(_, d) => setHeaders((h) => ({ ...h, [c]: d.value }))} />
                      </div>
                    ))}
                  </div>
                </Field>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!ds || columns.length === 0} onClick={create}>Add tablix</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// --- Parameter dialog ---
function ParameterDialog({ open, editing, onClose, onSave, onDelete }: {
  open: boolean; editing?: RdlParameter;
  onClose: () => void; onSave: (p: RdlParameter) => void; onDelete?: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<RdlParameter['type']>('String');
  const [prompt, setPrompt] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  useEffect(() => {
    if (open) {
      setName(editing?.name || '');
      setType(editing?.type || 'String');
      setPrompt(editing?.prompt || '');
      setDefaultValue(editing?.defaultValue || '');
    }
  }, [open, editing]);
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{editing ? 'Edit parameter' : 'Add parameter'}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
              <Field label="Name" required><Input value={name} disabled={!!editing} onChange={(_, d) => setName(d.value)} /></Field>
              <Field label={<InfoLabel info="The data type the viewer is prompted for: String (free text), Int (whole number), Boolean (true/false), or DateTime (date/time picker). It controls the prompt control and how the value is passed to the dataset query.">Type</InfoLabel>}>
                <Dropdown selectedOptions={[type]} value={type} onOptionSelect={(_, d) => setType((d.optionValue as RdlParameter['type']) || 'String')}>
                  {RDL_PARAM_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Prompt"><Input value={prompt} onChange={(_, d) => setPrompt(d.value)} /></Field>
              <Field label="Default value"><Input value={defaultValue} onChange={(_, d) => setDefaultValue(d.value)} /></Field>
            </div>
          </DialogContent>
          <DialogActions>
            {editing && onDelete && <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => onDelete(editing.name)}>Delete</Button>}
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!name.trim()}
              onClick={() => onSave({ name: name.trim(), type, prompt: prompt.trim(), defaultValue: defaultValue.trim() || undefined })}>
              {editing ? 'Save' : 'Add'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
