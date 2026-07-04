'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ReportEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * no-fabric-dependency.md: the Report editor's DEFAULT path renders visuals by
 * querying the bound AAS tabular model with DAX — NO Power BI / Fabric workspace
 * required (LoomNativeReportEditor → ReportDesigner). The live Power BI embed
 * (ReportLikeEditor) is strictly opt-in via NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi.
 * The editor's exclusive helpers move with it verbatim: PRESET_THEMES, the
 * ReportLite type, the Report Copilot (CopilotStep / PendingVisual / Loom*Entry
 * + ReportCopilotPanel), ReportLikeEditor, and the Loom-native renderer pieces
 * (LoomVisualDef / LoomReportPage / LoomReportDetail / VisualState / CHART_TYPES
 * / LoomVisual / LoomVisualDefinition / LoomNativeReportEditor /
 * _LoomNativeReportViewer_legacy). The shared Power BI workspace-picker
 * (usePowerBiWorkspaces / WorkspacePicker) is imported from ./workspace-picker;
 * the shared phase3 styles hook from ./styles. phase3-editors.tsx re-exports
 * ReportEditor + the ReportLite type from barrel lines, so the registry and
 * phase3/paginated-report-editor.tsx resolve them unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Field, Body1,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Textarea, Switch, Tooltip, InfoLabel, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, ArrowSync20Regular,
  Sparkle16Regular, DataBarVertical20Regular,
  Eye20Regular, ArrowDownload20Regular,
} from '@fluentui/react-icons';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import { ManageAccessPanel, EndorsementControl } from '@/lib/components/powerbi/powerbi-governance';
import { ItemEditorChrome } from '../item-editor-chrome';
import { ReportDesigner } from '../report-designer';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import { ReportVisualDesigner } from '../components/report-visual-designer';
import { ReportSubscriptionsPanel } from '../components/report-subscriptions-panel';
import { usePowerBiWorkspaces, WorkspacePicker } from './workspace-picker';
import { useStyles } from './styles';

const PRESET_THEMES: Array<{ key: string; label: string; theme: Record<string, unknown> }> = [
  {
    key: 'loom-light', label: 'Loom Light',
    theme: {
      name: 'Loom Light',
      dataColors: ['#0F6CBD', '#13A10E', '#C19C00', '#D13438', '#8764B8', '#038387', '#CA5010', '#5C2E91'],
      background: '#FFFFFF', foreground: '#242424', tableAccent: '#0F6CBD',
    },
  },
  {
    key: 'loom-dark', label: 'Loom Dark',
    theme: {
      name: 'Loom Dark',
      dataColors: ['#479EF5', '#54B054', '#E6B400', '#F1707B', '#B393E0', '#3FC5C9', '#F08A4B', '#A47BD4'],
      background: '#1B1A19', foreground: '#F3F2F1', tableAccent: '#479EF5',
      visualStyles: { '*': { '*': { background: [{ color: { solid: { color: '#252423' } } }] } } },
    },
  },
  {
    key: 'high-contrast', label: 'High Contrast',
    theme: {
      name: 'High Contrast',
      dataColors: ['#000000', '#FFFFFF', '#FFFF00', '#00FFFF', '#FF00FF', '#00FF00', '#FF0000', '#0000FF'],
      background: '#000000', foreground: '#FFFFFF', tableAccent: '#FFFF00',
    },
  },
];

export interface ReportLite {
  id: string; name: string; embedUrl?: string; webUrl?: string; datasetId?: string;
  modifiedDateTime?: string; modifiedBy?: string; reportType?: string;
}

// ── Report Copilot ────────────────────────────────────────────────────────
// Narrative-summary + suggest-visuals over the Loom tabular semantic layer
// (Synapse Dedicated SQL pool) — NO Power BI dependency (no-fabric-dependency.md).
// Streams from POST /api/items/report/copilot; an approved visual is POSTed to
// /api/items/report/<id>/visual which writes it to the report's state.content
// where the Loom-native viewer renders it.

type CopilotStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: any; error?: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string };

interface PendingVisual {
  visualType: string; title: string; field: string; sql: string;
  position?: { x: number; y: number; width: number; height: number };
}

interface LoomVisualEntry { type: string; title: string; field?: string; config?: any }
interface LoomPageEntry { name: string; displayName?: string; visuals?: LoomVisualEntry[] }

/**
 * ReportCopilotPanel — bound to the report item's Cosmos id (`reportId`).
 * Grounds its narrative on real Synapse aggregates and lets the user approve a
 * suggested visual, which is written to the report's Loom-native content.
 */
function ReportCopilotPanel({ reportId, reportName }: { reportId: string; reportName?: string }) {
  const s = useStyles();
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<CopilotStep[]>([]);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingVisual | null>(null);
  const [aoaiGate, setAoaiGate] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pages, setPages] = useState<LoomPageEntry[]>([]);

  // Load the report's Loom-native content (pages + visuals) so newly-added
  // visuals are visible immediately. Reads state.content via the loom: pages route.
  const loadLoomContent = useCallback(async () => {
    if (!reportId) return;
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent('loom:' + reportId)}/pages?workspaceId=loom-native`);
      const j = await r.json();
      setPages(j.ok && Array.isArray(j.pages) ? j.pages : []);
    } catch { setPages([]); }
  }, [reportId]);
  useEffect(() => { loadLoomContent(); }, [loadLoomContent]);

  const run = useCallback(async () => {
    const p = prompt.trim();
    if (!p || running) return;
    setRunning(true); setSteps([]); setNarrative(null); setPending(null);
    setAoaiGate(null); setTopError(null); setApplyMsg(null);
    try {
      const res = await fetch('/api/items/report/copilot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: p, reportId }),
      });
      if (res.status === 503) {
        const j = await res.json().catch(() => ({}));
        setAoaiGate(j.error || 'No AOAI deployment wired to the Foundry hub.');
        setRunning(false); return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setTopError(j.error || `HTTP ${res.status}`); setRunning(false); return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = ''; let currentEvent = 'message';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (currentEvent === 'step') {
                const step = parsed as CopilotStep;
                setSteps((prev) => [...prev, step]);
                if (step.kind === 'final') setNarrative(step.content || '');
                if (step.kind === 'tool_result' && step.name === 'report_suggest_visual' && step.result?.ok && step.result?.suggestion) {
                  setPending(step.result.suggestion as PendingVisual);
                }
              }
            } catch { /* skip malformed SSE line */ }
          }
        }
      }
    } catch (e: any) {
      setTopError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [prompt, running, reportId]);

  const addVisual = useCallback(async () => {
    if (!pending || !reportId) return;
    setApplyBusy(true); setApplyMsg(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/visual`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visual: pending }),
      });
      const j = await r.json();
      if (j.ok) {
        setApplyMsg({ ok: true, text: `Added "${j.visual?.title}" to ${j.pageName || 'the report'} (${j.backend}).` });
        setPending(null);
        await loadLoomContent();
      } else {
        setApplyMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
      }
    } catch (e: any) {
      setApplyMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setApplyBusy(false);
    }
  }, [pending, reportId, loadLoomContent]);

  const totalVisuals = pages.reduce((n, p) => n + (p.visuals?.length || 0), 0);

  return (
    <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS}}>
        <Sparkle16Regular />
        <Subtitle2>Report Copilot</Subtitle2>
        <Badge appearance="tint" color="brand">Loom-native · Synapse</Badge>
      </div>
      <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>
        Generate a narrative summary of {reportName ? `“${reportName}”` : 'this report'} grounded on real aggregates from the bound
        CSA Loom semantic model (Synapse Dedicated SQL pool), and get a suggested visual you can add to the report. No Power BI required.
      </Caption1>
      <Textarea
        placeholder='e.g. "Summarize total revenue by product category and suggest a chart."'
        value={prompt}
        onChange={(_e, d) => setPrompt(d.value)}
        rows={2}
        disabled={running}
      />
      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalS}}>
        <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Sparkle16Regular />} disabled={running || !prompt.trim()} onClick={run}>
          {running ? 'Working…' : 'Generate narrative & visual'}
        </Button>
      </div>

      {aoaiGate && (
        <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}>
          <MessageBarBody>
            <MessageBarTitle>Copilot model not deployed</MessageBarTitle>
            {aoaiGate} Deploy a gpt-4o / gpt-4.1 class model in Azure AI Foundry, then set it under Admin → Tenant settings → Copilot &amp; Agents.
          </MessageBarBody>
        </MessageBar>
      )}
      {topError && (
        <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{topError}</MessageBarBody></MessageBar>
      )}

      {narrative && (
        <div className={s.card} style={{ marginTop: tokens.spacingVerticalS, backgroundColor: tokens.colorNeutralBackground2 }}>
          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS}}>Narrative summary</Subtitle2>
          <Body1 style={{ whiteSpace: 'pre-wrap' }}>{narrative}</Body1>
        </div>
      )}

      {pending && (
        <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalS}}>
          <MessageBarBody>
            <MessageBarTitle>Suggested visual</MessageBarTitle>
            <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS}}>
              <Badge appearance="filled" color="brand">{pending.visualType}</Badge>
              <span><strong>{pending.title}</strong></span>
              <Caption1>field: {pending.field}</Caption1>
            </div>
            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, fontFamily: 'var(--loom-font-mono, ui-monospace, monospace)' }}>{pending.sql}</Caption1>
          </MessageBarBody>
          <MessageBarActions>
            <Button appearance="primary" icon={applyBusy ? <Spinner size="tiny" /> : <Add20Regular />} disabled={applyBusy} onClick={addVisual}>
              {applyBusy ? 'Adding…' : 'Add to report'}
            </Button>
            <Button appearance="subtle" disabled={applyBusy} onClick={() => setPending(null)}>Dismiss</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {applyMsg && (
        <MessageBar intent={applyMsg.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{applyMsg.text}</MessageBarBody></MessageBar>
      )}

      <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
        <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>Report content (Loom-native) · {totalVisuals} visual{totalVisuals === 1 ? '' : 's'}</Subtitle2>
        {pages.length === 0 && <Caption1>No Loom-native visuals yet. Generate one above to add the first.</Caption1>}
        {pages.map((p, i) => (
          <div key={p.name || i} style={{ marginBottom: tokens.spacingVerticalS}}>
            <Caption1><strong>{p.displayName || p.name}</strong></Caption1>
            {(p.visuals || []).length === 0 && <div><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>— no visuals</Caption1></div>}
            {(p.visuals || []).map((v, j) => (
              <div key={j} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', padding: `${tokens.spacingVerticalXXS} 0` }}>
                <Badge appearance="outline" color="brand">{v.type}</Badge>
                <span>{v.title}</span>
                {v.field && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· {v.field}</Caption1>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportLikeEditor({
  item, id, kind, listPath, detailPathBase,
}: {
  item: FabricItemType; id: string; kind: 'report' | 'paginated';
  listPath: string; detailPathBase: string;
}) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [reports, setReports] = useState<ReportLite[] | null>(null);
  const [reportId, setReportId] = useState('');
  const [report, setReport] = useState<ReportLite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; reportId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [exportBusy, setExportBusy] = useState<'PDF' | 'PPTX' | 'PNG' | 'XLSX' | 'DOCX' | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  // Report viewer state — pages, bookmarks, view/edit mode, live embed handle.
  const [pages, setPages] = useState<Array<{ name: string; displayName?: string }>>([]);
  const [activePage, setActivePage] = useState<string>('');
  const [bookmarks, setBookmarks] = useState<Array<{ name: string; displayName: string }>>([]);
  const [editMode, setEditMode] = useState(false);
  const [viewerErr, setViewerErr] = useState<string | null>(null);
  // Drill-through / cross-highlight / theme / format-pane state (Power BI
  // report viewer parity). drillContext = the filter context carried onto the
  // active page after a drill-through navigation; lastSelection = the most
  // recent cross-highlight / hierarchy drill selection from the embed.
  const [drillContext, setDrillContext] = useState<any[] | null>(null);
  const [lastSelection, setLastSelection] = useState<{ visualName?: string; pageDisplayName?: string; filterCount: number; pointCount: number } | null>(null);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [themePreset, setThemePreset] = useState<string>(PRESET_THEMES[0].key);
  const [themeJson, setThemeJson] = useState(() => JSON.stringify(PRESET_THEMES[0].theme, null, 2));
  const [themeApplying, setThemeApplying] = useState(false);
  const [themeErr, setThemeErr] = useState<string | null>(null);
  const [themeMsg, setThemeMsg] = useState<string | null>(null);
  const [showFormatPane, setShowFormatPane] = useState(false);
  const embedRef = useRef<any>(null);
  // Power BI is opt-in (no-fabric-dependency.md): render Loom-native report
  // metadata by default; expose embed/refresh/export only when configured.
  const powerBiConfigured = !!(ws.workspaces && ws.workspaces.length > 0 && !ws.error);
  // Report main view: the in-Loom Visual designer (build visuals over the
  // model with Fields/Format/Filters panes) vs the live Power BI embed.
  const [reportView, setReportView] = useState<'design' | 'view'>('design');
  // Report Copilot (narrative + suggest-visuals) — Loom-native, bound to this
  // report item's Cosmos id (the editor `id` prop). Works with or without PBI.
  const [copilotOpen, setCopilotOpen] = useState(kind === 'report');

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`${listPath}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setReports([]); setErr(j.error); return; }
      setReports(j.reports || []);
      setReportId((prev) => prev || (j.reports?.[0]?.id ?? ''));
    } catch (e: any) { setReports([]); setErr(e?.message || String(e)); }
  }, [listPath]);

  const loadDetail = useCallback(async (wsId: string, rId: string) => {
    try {
      const r = await fetch(`${detailPathBase}/${encodeURIComponent(rId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setReport(j.report);
      else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [detailPathBase]);

  // Auto-pick the first Power BI workspace so the list loads and the first
  // report auto-selects — embed/refresh/export enable on load instead of
  // sitting behind a manual workspace pick.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && reportId) loadDetail(workspaceId, reportId); }, [workspaceId, reportId, loadDetail]);

  // Per-editor ribbon. Authoring (new page / new visual / bookmarks /
  // format / filters) is out-of-scope: Power BI Desktop is the authoring
  // surface, the Loom editor is metadata + embed + launcher. Every action
  // in this ribbon wires to a real handler. See no-vaporware.md.
  const canRefresh = !!workspaceId;
  const refreshSelected = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    if (workspaceId && reportId) loadDetail(workspaceId, reportId);
  }, [workspaceId, reportId, loadList, loadDetail]);
  const openInDesktop = useCallback(() => {
    if (!report?.webUrl) return;
    try { window.open(report.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ }
  }, [report?.webUrl]);
  const copyReportLink = useCallback(async () => {
    if (!report?.webUrl) return;
    try { await navigator.clipboard.writeText(report.webUrl); } catch { /* ignore */ }
  }, [report?.webUrl]);

  // Refresh the report's underlying semantic model (a report has no data of
  // its own). Hits POST /api/items/report/{id}/refresh which resolves the
  // datasetId and queues a real Power BI dataset refresh. Paginated/RDL
  // reports may not have a refreshable dataset — the route says so honestly.
  const refreshData = useCallback(async () => {
    if (!workspaceId || !reportId) return;
    setRefreshBusy(true); setRefreshMsg(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json();
      setRefreshMsg(j.ok ? { ok: true, text: 'Dataset refresh queued.' } : { ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setRefreshMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRefreshBusy(false); }
  }, [workspaceId, reportId]);

  // Export the report to PDF/PPTX via the real Power BI async ExportTo job.
  // The BFF drives start->poll->download and streams the binary back, which
  // we save via an object URL. Paginated reports use a different export SDK,
  // so export is offered for standard PBI reports only.
  const exportReport = useCallback(async (format: 'PDF' | 'PPTX' | 'PNG' | 'XLSX' | 'DOCX') => {
    if (!workspaceId || !reportId) return;
    // Paginated reports (RDL) render through the SSRS engine — the BFF must send
    // `paginated:true` so Power BI attaches a paginatedReportConfiguration body.
    const paginated = kind === 'paginated';
    setExportBusy(format); setExportErr(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, format, paginated }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setExportErr(j.error || `export failed (HTTP ${r.status})`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report?.name || 'report'}.${format.toLowerCase()}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) { setExportErr(e?.message || String(e)); }
    finally { setExportBusy(null); }
  }, [workspaceId, reportId, report?.name, kind]);

  // Load the report's pages so the viewer can render a Pages list and the
  // embed can setPage(). Real REST: GET /reports/{id}/pages.
  useEffect(() => {
    if (!workspaceId || !reportId || kind === 'paginated') { setPages([]); setActivePage(''); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/pages?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) { setPages(j.pages || []); setActivePage((j.pages?.[0]?.name) || ''); }
        else setPages([]);
      } catch { if (!cancelled) setPages([]); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, reportId, kind]);

  // Pages / bookmarks / refresh-visuals / view-mode all drive the live embed
  // via the powerbi-client report JS API (the same API the Power BI service
  // viewer toolbar uses). embedRef is set by PowerBIEmbedFrame.onEmbedded.
  const gotoPage = useCallback(async (name: string) => {
    setActivePage(name); setViewerErr(null);
    try { await embedRef.current?.setPage?.(name); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const refreshVisuals = useCallback(async () => {
    setViewerErr(null);
    try { await embedRef.current?.refresh?.(); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const reloadBookmarks = useCallback(async () => {
    setViewerErr(null);
    try {
      const list = await embedRef.current?.bookmarksManager?.getBookmarks?.();
      setBookmarks((list || []).map((b: any) => ({ name: b.name, displayName: b.displayName })));
    } catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const applyBookmark = useCallback(async (name: string) => {
    setViewerErr(null);
    try { await embedRef.current?.bookmarksManager?.apply?.(name); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  // Bookmark slideshow — drives bookmarksManager.play (the Power BI web
  // viewer "View → Bookmarks → View" slideshow). On = cycle bookmarks; Off =
  // stop. Real powerbi-client API; surfaces engine errors verbatim.
  const [slideshow, setSlideshow] = useState(false);
  const toggleSlideshow = useCallback(async () => {
    const next = !slideshow;
    setSlideshow(next); setViewerErr(null);
    try {
      // models.BookmarksPlayMode: On = 0, Off = 1.
      await embedRef.current?.bookmarksManager?.play?.(next ? 0 : 1);
    } catch (e: any) { setViewerErr(e?.message || String(e)); setSlideshow(!next); }
  }, [slideshow]);

  const captureBookmark = useCallback(async () => {
    setViewerErr(null);
    try {
      // Capture the current visual/filter state as a personal (transient)
      // bookmark and apply it; surfaced in the in-session bookmarks list.
      const captured = await embedRef.current?.bookmarksManager?.capture?.();
      if (captured) {
        await embedRef.current?.bookmarksManager?.applyState?.(captured.state);
        setBookmarks((prev) => [
          ...prev,
          { name: captured.name || `capture-${prev.length + 1}`, displayName: `Captured ${new Date().toLocaleTimeString()}` },
        ]);
      }
    } catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const toggleEditMode = useCallback(async () => {
    const next = !editMode;
    setEditMode(next); setViewerErr(null);
    try { await embedRef.current?.switchMode?.(next ? 'edit' : 'view'); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, [editMode]);

  // Apply a Power BI report theme at runtime (parity with the service
  // "View → Themes" picker). Real powerbi-client API: report.applyTheme.
  // Accepts a preset key, a raw JSON string, or a theme object.
  const applyTheme = useCallback(async (input: string | object) => {
    setThemeErr(null); setThemeMsg(null); setThemeApplying(true);
    try {
      let themeObj: any;
      if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) throw new Error('Paste a Power BI theme JSON or pick a preset.');
        themeObj = JSON.parse(trimmed);
      } else { themeObj = input; }
      await embedRef.current?.applyTheme?.({ themeJson: themeObj });
      setThemeMsg(`Applied theme "${themeObj?.name || 'custom'}".`);
    } catch (e: any) { setThemeErr(e?.message || String(e)); }
    finally { setThemeApplying(false); }
  }, []);

  // Reset the report to its authored theme (report.resetTheme).
  const resetTheme = useCallback(async () => {
    setThemeErr(null); setThemeMsg(null);
    try { await embedRef.current?.resetTheme?.(); setThemeMsg('Reset to the report’s authored theme.'); }
    catch (e: any) { setThemeErr(e?.message || String(e)); }
  }, []);

  // Show/hide the Power BI visualizations + fields panes (parity with the
  // service edit-mode formatting pane). Real API: report.updateSettings.
  const toggleFormatPane = useCallback(async () => {
    const next = !showFormatPane;
    setShowFormatPane(next); setViewerErr(null);
    try {
      await embedRef.current?.updateSettings?.({
        panes: {
          visualizations: { visible: next, expanded: next },
          fields: { visible: next, expanded: false },
          filters: { visible: true, expanded: false },
        },
      });
    } catch (e: any) { setViewerErr(e?.message || String(e)); setShowFormatPane(!next); }
  }, [showFormatPane]);

  // Mirror the active page when the user navigates inside the embed, and read
  // the drill-through filter context carried onto the newly-active page.
  const onEmbedded = useCallback((embed: any) => {
    embedRef.current = embed;
    try {
      embed?.on?.('loaded', () => { reloadBookmarks(); });
      embed?.on?.('pageChanged', async (ev: any) => {
        const name = ev?.detail?.newPage?.name;
        if (name) setActivePage(name);
        // Drill-through carries source-page filters onto the target page; read
        // them off the now-active page so the viewer can show what arrived.
        try {
          const pg = await embedRef.current?.getActivePage?.();
          const filters = await pg?.getFilters?.();
          setDrillContext(Array.isArray(filters) && filters.length ? filters : null);
        } catch { setDrillContext(null); }
      });
      // Native bookmarks pane / programmatic apply → re-sync the Loom list +
      // the active page (a bookmark can navigate pages).
      embed?.on?.('bookmarkApplied', async () => {
        reloadBookmarks();
        try {
          const pg = await embedRef.current?.getActivePage?.();
          if (pg?.name) setActivePage(pg.name);
        } catch { /* best-effort */ }
      });
      // Cross-highlight + hierarchy drill selection surface (dataSelected fires
      // on visual selection and drill-down node clicks).
      embed?.on?.('dataSelected', (ev: any) => {
        const d = ev?.detail || {};
        const filters = Array.isArray(d.filters) ? d.filters : [];
        const dataPoints = Array.isArray(d.dataPoints) ? d.dataPoints : [];
        if (!dataPoints.length && !filters.length) { setLastSelection(null); return; }
        setLastSelection({
          visualName: d?.visual?.name,
          pageDisplayName: d?.page?.displayName,
          filterCount: filters.length,
          pointCount: dataPoints.length,
        });
      });
      // The `error` event fires for both standard and paginated reports (the
      // latter does NOT emit `loaded`/`rendered`, so this is the only signal we
      // get on a paginated render failure). Surface it in the viewer banner.
      embed?.on?.('error', (ev: any) => {
        const msg = ev?.detail?.message || ev?.detail?.detailedMessage;
        if (msg) setViewerErr(String(msg));
      });
    } catch { /* event wiring best-effort */ }
  }, [reloadBookmarks]);

  const hasReport = !!reportId;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Open', actions: [
        { label: kind === 'paginated' ? 'Open paginated report' : 'Open in Power BI', onClick: report?.webUrl ? openInDesktop : undefined, disabled: !report?.webUrl, title: !report?.webUrl ? 'select a report first' : 'opens Power BI Web — use Edit there to author' },
        { label: 'Copy link', onClick: report?.webUrl ? copyReportLink : undefined, disabled: !report?.webUrl, title: !report?.webUrl ? 'select a report first' : 'copy the workspace URL to clipboard' },
      ]},
      { label: 'Data', actions: [
        { label: refreshBusy ? 'Refreshing…' : 'Refresh data', onClick: hasReport && !refreshBusy ? refreshData : undefined, disabled: !hasReport || refreshBusy, title: !hasReport ? 'select a report first' : 'queue a refresh of the report’s underlying semantic model' },
        { label: 'Reload metadata', onClick: canRefresh ? refreshSelected : undefined, disabled: !canRefresh, title: !canRefresh ? 'select a workspace first' : 'reload list + selected report metadata' },
      ]},
      ...(kind === 'paginated' ? [{ label: 'Export', actions: [
        // Paginated reports render through the SSRS engine — PDF / Excel / Word
        // are the parity exports the Power BI service exposes for RDL.
        { label: exportBusy === 'PDF' ? 'Exporting…' : 'Export PDF', onClick: hasReport && !exportBusy ? () => exportReport('PDF') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the paginated report to PDF via Power BI REST (ExportTo + paginatedReportConfiguration)' },
        { label: exportBusy === 'XLSX' ? 'Exporting…' : 'Export Excel', onClick: hasReport && !exportBusy ? () => exportReport('XLSX') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the paginated report to Excel (.xlsx) via Power BI REST' },
        { label: exportBusy === 'DOCX' ? 'Exporting…' : 'Export Word', onClick: hasReport && !exportBusy ? () => exportReport('DOCX') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the paginated report to Word (.docx) via Power BI REST' },
      ]}] : [{ label: 'Export', actions: [
        { label: exportBusy === 'PDF' ? 'Exporting…' : 'Export PDF', onClick: hasReport && !exportBusy ? () => exportReport('PDF') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the report to PDF via Power BI REST' },
        { label: exportBusy === 'PPTX' ? 'Exporting…' : 'Export PPTX', onClick: hasReport && !exportBusy ? () => exportReport('PPTX') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the report to PowerPoint via Power BI REST' },
        { label: exportBusy === 'PNG' ? 'Exporting…' : 'Export PNG', onClick: hasReport && !exportBusy ? () => exportReport('PNG') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the report to PNG via Power BI REST' },
      ]}]),
      ...(kind === 'paginated' ? [] : [{ label: 'View', actions: [
        { label: 'Refresh visuals', onClick: hasReport ? refreshVisuals : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'reload the embedded report visuals (report.refresh)' },
        { label: editMode ? 'Switch to View' : 'Switch to Edit', onClick: hasReport ? toggleEditMode : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'toggle the embedded report between View and Edit modes' },
        { label: 'Capture bookmark', onClick: hasReport ? captureBookmark : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'capture the current visual + filter state as a personal bookmark' },
        { label: slideshow ? 'Stop slideshow' : 'Play bookmarks', onClick: hasReport ? toggleSlideshow : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'play the report bookmarks as a slideshow (bookmarksManager.play)' },
        { label: showFormatPane ? 'Hide format pane' : 'Show format pane', onClick: hasReport && editMode ? toggleFormatPane : undefined, disabled: !hasReport || !editMode, title: !hasReport ? 'select a report first' : (!editMode ? 'switch to Edit mode first to author visuals' : 'show/hide the Power BI visualizations + fields panes (report.updateSettings)') },
      ]}]),
      ...(kind === 'paginated' ? [] : [{ label: 'Theme', actions: [
        { label: 'Apply theme', onClick: hasReport ? () => setShowThemeDialog(true) : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'apply a built-in or custom JSON theme to the embedded report (report.applyTheme)' },
        { label: 'Reset theme', onClick: hasReport ? resetTheme : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'reset the report to its authored theme (report.resetTheme)' },
      ]}]),
      ...(kind === 'paginated' ? [] : [{ label: 'Copilot', actions: [
        { label: copilotOpen ? 'Hide Report Copilot' : 'Report Copilot', onClick: () => setCopilotOpen((v) => !v), title: 'narrative summary + suggested visuals over the bound Loom semantic model (no Power BI required)' },
      ]}]),
    ]},
  ], [kind, canRefresh, refreshSelected, openInDesktop, copyReportLink, report?.webUrl, hasReport, refreshBusy, refreshData, exportBusy, exportReport, refreshVisuals, editMode, toggleEditMode, captureBookmark, slideshow, toggleSlideshow, showFormatPane, toggleFormatPane, resetTheme, copilotOpen]);

  // Mint a per-report embed token whenever the selected report changes.
  //
  // Paginated reports (RDL) use IPaginatedReportLoadConfiguration through the
  // SAME powerbi-client SDK — there is no separate `pbi-paginated` package. They
  // mint their token through the MULTI-RESOURCE GenerateToken (reports[] +
  // referenced semantic-model datasets[]), so they hit a dedicated BFF route.
  useEffect(() => {
    if (!workspaceId || !reportId) { setEmbed(null); return; }
    let cancelled = false;
    if (kind === 'paginated') {
      (async () => {
        setEmbedErr(null);
        try {
          const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/paginated-embed-token`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId, datasetIds: report?.datasetId ? [report.datasetId] : [] }),
          });
          const j = await r.json();
          if (cancelled) return;
          if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, reportId: j.reportId });
          else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
        } catch (e: any) {
          if (!cancelled) setEmbedErr(e?.message || String(e));
        }
      })();
      return () => { cancelled = true; };
    }
    (async () => {
      setEmbedErr(null);
      try {
        const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, accessLevel: editMode ? 'Edit' : 'View' }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, reportId: j.reportId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) {
        if (!cancelled) setEmbedErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, reportId, kind, editMode, report?.datasetId]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>{kind === 'paginated' ? 'Paginated reports' : 'Reports'}</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {reports && reports.length === 0 && <Caption1>No {kind === 'paginated' ? 'paginated ' : ''}reports in this workspace.</Caption1>}
          <Tree aria-label="Reports">
            {(reports || []).map((r) => (
              <TreeItem key={r.id} itemType="leaf" value={r.id} onClick={() => setReportId(r.id)}>
                <TreeItemLayout>{reportId === r.id ? <strong>{r.name}</strong> : r.name}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">{kind === 'paginated' ? 'Paginated report' : 'Power BI report'}</Badge>
            {powerBiConfigured && (
              <>
                <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Reload</Button>
              </>
            )}
            {report?.webUrl && <Button appearance="outline" onClick={openInDesktop}>Open in Power BI</Button>}
            <Button appearance="primary" icon={refreshBusy ? <Spinner size="tiny" /> : <ArrowSync20Regular />} onClick={refreshData} disabled={!reportId || refreshBusy || !powerBiConfigured} title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : undefined}>{refreshBusy ? 'Refreshing…' : 'Refresh data'}</Button>
            {kind !== 'paginated' && powerBiConfigured && (
              <>
                <Tooltip relationship="label" content="Render this report as a PDF document (one page per report page) via the Power BI REST ExportTo job, then download it.">
                  <Button appearance="outline" onClick={() => exportReport('PDF')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PDF' ? 'Exporting…' : 'Export PDF'}</Button>
                </Tooltip>
                <Tooltip relationship="label" content="Export to a PowerPoint deck (.pptx) — each report page becomes a slide — via the Power BI REST ExportTo job.">
                  <Button appearance="outline" onClick={() => exportReport('PPTX')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PPTX' ? 'Exporting…' : 'Export PPTX'}</Button>
                </Tooltip>
                <Tooltip relationship="label" content="Export the current report view as a PNG image via the Power BI REST ExportTo job.">
                  <Button appearance="outline" onClick={() => exportReport('PNG')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PNG' ? 'Exporting…' : 'Export PNG'}</Button>
                </Tooltip>
                <Tooltip relationship="label" content="Reload the embedded report's visuals against the latest data (report.refresh) without re-loading the whole report.">
                  <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={refreshVisuals} disabled={!reportId}>Refresh visuals</Button>
                </Tooltip>
                <Tooltip relationship="label" content="Toggle the embedded report between read-only View and authoring Edit mode. Edit mode unlocks the format pane to add and style visuals.">
                  <Switch label={editMode ? 'Edit mode' : 'View mode'} checked={editMode} onChange={toggleEditMode} disabled={!reportId} />
                </Tooltip>
              </>
            )}
            {kind === 'paginated' && powerBiConfigured && (
              <>
                <Tooltip relationship="label" content="Render the paginated (RDL) report to a pixel-perfect, print-ready PDF via the Power BI REST ExportTo job, then download it.">
                  <Button appearance="outline" icon={exportBusy === 'PDF' ? <Spinner size="tiny" /> : <ArrowDownload20Regular />} onClick={() => exportReport('PDF')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PDF' ? 'Exporting…' : 'Export PDF'}</Button>
                </Tooltip>
                <Tooltip relationship="label" content="Export the paginated report to an Excel workbook (.xlsx) — rows and tables become spreadsheet cells — via the Power BI REST ExportTo job.">
                  <Button appearance="outline" icon={exportBusy === 'XLSX' ? <Spinner size="tiny" /> : <ArrowDownload20Regular />} onClick={() => exportReport('XLSX')} disabled={!reportId || !!exportBusy}>{exportBusy === 'XLSX' ? 'Exporting…' : 'Export Excel'}</Button>
                </Tooltip>
                <Tooltip relationship="label" content="Export the paginated report to a Word document (.docx) via the Power BI REST ExportTo job.">
                  <Button appearance="outline" icon={exportBusy === 'DOCX' ? <Spinner size="tiny" /> : <ArrowDownload20Regular />} onClick={() => exportReport('DOCX')} disabled={!reportId || !!exportBusy}>{exportBusy === 'DOCX' ? 'Exporting…' : 'Export Word'}</Button>
                </Tooltip>
              </>
            )}
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {refreshMsg && <MessageBar intent={refreshMsg.ok ? 'success' : 'error'}><MessageBarBody>{refreshMsg.text}</MessageBarBody></MessageBar>}
          {exportErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Export failed</MessageBarTitle>{exportErr}</MessageBarBody></MessageBar>}
          {kind === 'report' && copilotOpen && <ReportCopilotPanel reportId={id} reportName={report?.name} />}
          {!powerBiConfigured && (
            <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM}}>
              <MessageBarBody>
                <MessageBarTitle>Power BI embed is opt-in</MessageBarTitle>
                The Console identity isn&rsquo;t registered in Power BI / not in any workspace. This editor shows report metadata. To enable embedding, dataset refresh, export, and the visual viewer, register the Console UAMI in your Power BI tenant and add it to a workspace. <a href="https://learn.microsoft.com/power-bi/admin/service-principal-api-considerations" target="_blank" rel="noreferrer">Power BI service principal setup</a>.
              </MessageBarBody>
            </MessageBar>
          )}
          {powerBiConfigured && kind !== 'paginated' && (
            <TabList selectedValue={reportView} onTabSelect={(_, d) => setReportView(d.value as 'design' | 'view')} style={{ marginBottom: tokens.spacingVerticalS}}>
              <Tab value="design" icon={<DataBarVertical20Regular />}>Visual designer</Tab>
              <Tab value="view" icon={<Eye20Regular />}>Live embed</Tab>
            </TabList>
          )}
          {powerBiConfigured && kind !== 'paginated' && reportView === 'design' && report && report.datasetId && (
            <div className={s.card} style={{ marginBottom: tokens.spacingVerticalS}}>
              <ReportVisualDesigner workspaceId={workspaceId} datasetId={report.datasetId} reportId={reportId} />
            </div>
          )}
          {powerBiConfigured && kind !== 'paginated' && reportView === 'design' && report && !report.datasetId && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No bound semantic model</MessageBarTitle>
                This report has no dataset bound, so there are no model fields to build visuals over.
                Select a report backed by a semantic model, or use the <strong>Live embed</strong> tab.
              </MessageBarBody>
            </MessageBar>
          )}
          {powerBiConfigured && kind !== 'paginated' && reportView === 'view' && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Live Power BI embed</MessageBarTitle>
                This pane embeds the live report, triggers a dataset refresh, and exports to PDF/PPTX — all against the real
                Power BI REST API. To build visuals inside Loom over the model, switch to the <strong>Visual designer</strong> tab.
              </MessageBarBody>
            </MessageBar>
          )}
          {report && (!powerBiConfigured || kind === 'paginated' || reportView === 'view') && (
            <>
              <div className={s.card}>
                <Subtitle2>{report.name}</Subtitle2>
                <Caption1>type: {report.reportType || (kind === 'paginated' ? 'PaginatedReport' : 'PowerBIReport')} · datasetId: {report.datasetId || '—'}</Caption1>
                <Caption1>modified: {report.modifiedDateTime || '—'} by {report.modifiedBy || '—'}</Caption1>
                {report.webUrl && <Caption1><a href={report.webUrl} target="_blank" rel="noreferrer">Open in Power BI</a></Caption1>}
              </div>
              {kind !== 'paginated' && reportId && (
                <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                  <EndorsementControl workspaceId={workspaceId} itemId={reportId} itemType="reports" />
                </div>
              )}
              <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                <ManageAccessPanel workspaceId={workspaceId} />
              </div>
              {kind !== 'paginated' && reportId && (
                <div className={s.card} style={{ marginTop: tokens.spacingVerticalS}}>
                  <ReportSubscriptionsPanel
                    reportId={reportId}
                    workspaceId={workspaceId}
                    reportName={report?.name}
                    itemId={id}
                  />
                </div>
              )}
              {!powerBiConfigured ? (
                <div className={s.card}>
                  <Subtitle2 style={{ marginBottom: tokens.spacingVerticalM}}>Report metadata (Loom-native view)</Subtitle2>
                  <Caption1 style={{ marginBottom: tokens.spacingVerticalS, display: 'block' }}>To embed the live report and enable refresh/export, configure Power BI workspace access above.</Caption1>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div><strong>Name:</strong> {report?.name || '—'}</div>
                    <div><strong>Type:</strong> {report?.reportType || (kind === 'paginated' ? 'PaginatedReport' : 'PowerBIReport')}</div>
                    <div><strong>Dataset ID:</strong> {report?.datasetId || '—'}</div>
                    {report?.webUrl && <div><strong>Web URL:</strong> <a href={report.webUrl} target="_blank" rel="noreferrer">{report.webUrl}</a></div>}
                  </div>
                </div>
              ) : kind === 'paginated' ? (
                embed ? (
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    {viewerErr && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalS}}><MessageBarBody>{viewerErr}</MessageBarBody></MessageBar>}
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
                      onEmbedded={onEmbedded}
                    />
                  </div>
                ) : embedErr ? (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>Could not mint paginated embed token</MessageBarTitle>
                      {embedErr}. The Console UAMI must be a workspace <strong>Member</strong> (not Contributor/Viewer)
                      and the tenant setting <strong>"Service principals can use Fabric APIs"</strong> must be enabled
                      with the UAMI's security group. In GCC-High / DoD set{' '}
                      <code>LOOM_POWERBI_BASE=https://api.powerbigov.us/v1.0/myorg</code>.
                    </MessageBarBody>
                  </MessageBar>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: `${tokens.spacingVerticalXXXL} 0` }}>
                    <Spinner size="medium" label="Loading paginated report embed…" labelPosition="below" />
                  </div>
                )
              ) : embedErr ? (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                    {embedErr}. Confirm the Console UAMI is added to this workspace (Member or above) and that the tenant setting
                    <strong> "Service principals can use Fabric APIs"</strong> is enabled with the UAMI's security group.
                  </MessageBarBody>
                </MessageBar>
              ) : embed ? (
                <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'flex-start' }}>
                  <div style={{ width: 220, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <div className={s.card}>
                      <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>Pages ({pages.length})</Subtitle2>
                      {pages.length === 0 && <Caption1>No pages reported.</Caption1>}
                      <Tree aria-label="Report pages">
                        {pages.map((p) => (
                          <Tooltip key={p.name} relationship="label" content={`Go to report page "${p.displayName || p.name}" — navigates the live embed (report.setPage) to this page.`}>
                            <TreeItem itemType="leaf" value={p.name} onClick={() => gotoPage(p.name)}>
                              <TreeItemLayout>{activePage === p.name ? <strong>{p.displayName || p.name}</strong> : (p.displayName || p.name)}</TreeItemLayout>
                            </TreeItem>
                          </Tooltip>
                        ))}
                      </Tree>
                    </div>
                    <div className={s.card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacingVerticalS}}>
                        <Subtitle2>Bookmarks ({bookmarks.length})</Subtitle2>
                        <Tooltip relationship="label" content="Reload the report's saved bookmarks. A bookmark captures a saved view — the current filters, slicers, and visual state — so reloading picks up bookmarks added in the report.">
                          <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={reloadBookmarks} aria-label="Reload report bookmarks" />
                        </Tooltip>
                      </div>
                      {bookmarks.length === 0 && <Caption1>No bookmarks. Use Capture bookmark.</Caption1>}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                        {bookmarks.map((b) => (
                          <Button key={b.name} size="small" appearance="subtle" onClick={() => applyBookmark(b.name)} style={{ justifyContent: 'flex-start' }}>{b.displayName || b.name}</Button>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
                        <Tooltip relationship="label" content="Capture the current view — active filters, slicers, and visual selections — as a new bookmark you can return to later.">
                          <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={captureBookmark}>Capture</Button>
                        </Tooltip>
                        <Tooltip relationship="label" content={slideshow ? 'Stop cycling through the report bookmarks.' : 'Play the bookmarks as a slideshow — automatically steps through each saved view in order (bookmarksManager.play).'}>
                          <Button size="small" appearance={slideshow ? 'primary' : 'outline'} icon={<Play20Regular />} onClick={toggleSlideshow}>{slideshow ? 'Stop' : 'Play'}</Button>
                        </Tooltip>
                      </div>
                    </div>
                    <div className={s.card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacingVerticalS}}>
                        <Subtitle2>Selection</Subtitle2>
                        <Button size="small" appearance="outline" onClick={() => setShowThemeDialog(true)} title="apply a report theme (report.applyTheme)">Theme…</Button>
                      </div>
                      {lastSelection ? (
                        <>
                          <Caption1 style={{ display: 'block' }}>
                            Cross-highlight: <strong>{lastSelection.visualName || 'visual'}</strong>
                            {lastSelection.pageDisplayName ? ` on ${lastSelection.pageDisplayName}` : ''}
                          </Caption1>
                          <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                            {lastSelection.pointCount} point(s){lastSelection.filterCount > 0 ? ` · ${lastSelection.filterCount} filter(s)` : ''}
                          </Caption1>
                          <Button size="small" appearance="subtle" onClick={() => setLastSelection(null)} style={{ marginTop: tokens.spacingVerticalXS}}>Clear</Button>
                        </>
                      ) : (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click a data point to cross-highlight; use a hierarchy axis to drill down/up.</Caption1>
                      )}
                    </div>
                  </div>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    {viewerErr && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalS}}><MessageBarBody>{viewerErr}</MessageBarBody></MessageBar>}
                    {drillContext && drillContext.length > 0 && (
                      <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalS}}>
                        <MessageBarBody>
                          <MessageBarTitle>Drill-through context · {drillContext.length} filter{drillContext.length > 1 ? 's' : ''} carried</MessageBarTitle>
                          {drillContext.slice(0, 6).map((f: any, i: number) => (
                            <Caption1 key={i} style={{ display: 'block' }}>
                              {(f?.target?.table ?? '?')}.{(f?.target?.column ?? f?.target?.hierarchy ?? f?.target?.measure ?? '?')}: {JSON.stringify(f?.values ?? f?.conditions ?? f?.operator ?? '—')}
                            </Caption1>
                          ))}
                        </MessageBarBody>
                        <MessageBarActions>
                          <Button size="small" appearance="subtle" onClick={() => setDrillContext(null)}>Dismiss</Button>
                        </MessageBarActions>
                      </MessageBar>
                    )}
                    <PowerBIEmbedFrame
                      embedType="report"
                      id={embed.reportId}
                      embedUrl={embed.embedUrl}
                      accessToken={embed.token}
                      height={620}
                      edit={editMode}
                      pageName={activePage || undefined}
                      onEmbedded={onEmbedded}
                      paneOverrides={{ bookmarks: { visible: true }, selection: { visible: true } }}
                    />
                  </div>
                </div>
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
              )}
            </>
          )}
          <Dialog open={showThemeDialog} onOpenChange={(_, d) => setShowThemeDialog(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Apply report theme</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <Caption1>
                      Pick a built-in Loom theme or paste a Power BI theme JSON. Applied live to the embedded
                      report via <code>report.applyTheme</code> — the same engine the Power BI service uses.
                    </Caption1>
                    <Field label={<InfoLabel info="A built-in Loom color/font theme (Light, Dark, High Contrast). Picking one fills the Theme JSON box below, which you can then tweak before applying.">Preset theme</InfoLabel>}>
                      <Dropdown
                        value={PRESET_THEMES.find((t) => t.key === themePreset)?.label || 'Custom'}
                        selectedOptions={[themePreset]}
                        onOptionSelect={(_, d) => {
                          const key = d.optionValue || '';
                          setThemePreset(key);
                          const preset = PRESET_THEMES.find((t) => t.key === key);
                          if (preset) setThemeJson(JSON.stringify(preset.theme, null, 2));
                        }}
                      >
                        {PRESET_THEMES.map((t) => <Option key={t.key} value={t.key} text={t.label}>{t.label}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label={<InfoLabel info="Power BI theme JSON — colors/fonts. The dataColors array, background, foreground, and visualStyles control the report's look; applied live to the embed via report.applyTheme (the same engine the Power BI service uses).">Theme JSON (editable)</InfoLabel>} hint="leave as a preset, or paste a custom Power BI report-theme JSON">
                      <Textarea
                        value={themeJson}
                        onChange={(_, d) => setThemeJson(d.value)}
                        placeholder={'{\n  "name": "My theme",\n  "dataColors": ["#0F6CBD", "#13A10E"]\n}'}
                        rows={12}
                        style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}}
                      />
                    </Field>
                    {themeErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Theme failed to apply</MessageBarTitle>{themeErr}</MessageBarBody></MessageBar>}
                    {themeMsg && <MessageBar intent="success"><MessageBarBody>{themeMsg}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={resetTheme}>Reset to authored</Button>
                  <Button
                    appearance="primary"
                    disabled={themeApplying}
                    onClick={() => {
                      const preset = PRESET_THEMES.find((t) => t.key === themePreset);
                      const src = themeJson.trim() ? themeJson : (preset ? JSON.stringify(preset.theme) : '');
                      applyTheme(src);
                    }}
                  >{themeApplying ? 'Applying…' : 'Apply theme'}</Button>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="subtle">Close</Button>
                  </DialogTrigger>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ── Loom-native report renderer (Azure Analysis Services, default backend) ──
//
// no-fabric-dependency.md: the Report editor's DEFAULT path renders visuals by
// querying the bound AAS tabular model with DAX (POST /query) — NO Power BI /
// Fabric workspace required. Power BI embed is strictly opt-in via
// NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi (see ReportEditor below).
type LoomVisualDef = { type: string; title?: string; field?: string; config?: any };
type LoomReportPage = { name: string; displayName?: string; order?: number; visuals?: LoomVisualDef[] };
type LoomReportDetail = {
  report: { id: string; name: string; reportType?: string };
  aasServer: string | null;
  aasDatabase: string | null;
  pages: LoomReportPage[];
};
type VisualState = { rows: Array<Record<string, unknown>>; loading: boolean; err: string | null };

/** Chart type values that LoomChart handles natively. */
const CHART_TYPES: ReadonlySet<string> = new Set(['bar', 'column', 'line', 'area', 'donut', 'pie', 'scatter']);

/** Render a single visual's AAS query result.
 *  - card  → big KPI number
 *  - bar / column / line / area / donut / pie / scatter → real SVG chart
 *  - table → Fluent Table
 *  - anything else with non-numeric rows → table fallback (no "follow-up" messaging)
 */
function LoomVisual({ visual, state }: { visual: LoomVisualDef; state?: VisualState }) {
  if (!state || state.loading) return <Spinner size="tiny" label="Querying model…" />;
  if (state.err) return <MessageBar intent="error"><MessageBarBody>{state.err}</MessageBarBody></MessageBar>;
  const rows = state.rows;

  // ── Card visual ──────────────────────────────────────────────────────────
  if (visual.type === 'card' && rows.length >= 1) {
    const val = Object.values(rows[0])[0];
    return (
      <div>
        <Caption1>{visual.title || '(untitled)'}</Caption1>
        <div style={{ fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold }}>
          {val == null ? '—' : String(val)}
        </div>
      </div>
    );
  }

  // ── Chart visual ─────────────────────────────────────────────────────────
  if (CHART_TYPES.has(visual.type)) {
    // Detect whether the data actually has a numeric column; if not, degrade
    // to a plain table (no accusatory banner, no "follow-up" wording).
    const hasNumeric = rows.length > 0 && Object.values(rows[0]).some(
      (v) => v != null && v !== '' && !Number.isNaN(Number(v)),
    );
    if (hasNumeric) {
      return (
        <LoomChart
          type={visual.type as LoomChartType}
          rows={rows}
          title={visual.title}
          height={240}
        />
      );
    }
  }

  // ── Table / non-numeric fallback ─────────────────────────────────────────
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return (
    <div>
      <Caption1><strong>{visual.title || '(untitled)'}</strong></Caption1>
      {rows.length === 0 ? <Caption1>No rows returned.</Caption1> : (
        <Table size="small">
          <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
          <TableBody>
            {rows.slice(0, 100).map((row, ri) => (
              <TableRow key={ri}>{cols.map((c) => <TableCell key={c}>{row[c] == null ? '—' : String(row[c])}</TableCell>)}</TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Config-only visual preview shown when no AAS model is bound yet. */
function LoomVisualDefinition({ visual }: { visual: LoomVisualDef }) {
  return (
    <div>
      <Caption1><strong>{visual.title || '(untitled visual)'}</strong></Caption1>
      <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
        type: {visual.type} · field: {visual.field || '—'}
      </Caption1>
    </div>
  );
}

function LoomNativeReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  // The Loom-native report editor IS a designer (create/author, not just view):
  // pages + a visual canvas + a Visualizations/Fields pane that drag-binds the
  // bound AAS tabular model into field wells and live-renders real DAX rows.
  // Extracted to its own file to keep this module small.
  return <ReportDesigner item={item} id={id} />;
}

// Legacy read-only viewer pieces (LoomVisual / LoomVisualDefinition) are retained
// above for reference + reuse; the active editor is ReportDesigner.
function _LoomNativeReportViewer_legacy({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [detail, setDetail] = useState<LoomReportDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePage, setActivePage] = useState(0);
  const [visualRows, setVisualRows] = useState<Record<string, VisualState>>({});

  const loadDetail = useCallback(async () => {
    setLoading(true); setDetailErr(null); setVisualRows({});
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok) {
        setDetail({ report: j.report, aasServer: j.aasServer ?? null, aasDatabase: j.aasDatabase ?? null, pages: j.pages || [] });
        setActivePage(0);
      } else setDetailErr(j.error || `HTTP ${r.status}`);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const bound = !!(detail?.aasServer && detail?.aasDatabase);
  const pages = useMemo(() => detail?.pages || [], [detail]);
  const page = pages[activePage];

  const runVisual = useCallback(async (key: string, visual: LoomVisualDef) => {
    if (!visual.field) { setVisualRows((p) => ({ ...p, [key]: { rows: [], loading: false, err: 'visual has no field binding' } })); return; }
    setVisualRows((p) => ({ ...p, [key]: { rows: p[key]?.rows || [], loading: true, err: null } }));
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visual: { type: visual.type, field: visual.field } }),
      });
      const j = await r.json();
      if (j.ok) setVisualRows((p) => ({ ...p, [key]: { rows: j.rows || [], loading: false, err: null } }));
      else setVisualRows((p) => ({ ...p, [key]: { rows: [], loading: false, err: j.error || `HTTP ${r.status}` } }));
    } catch (e: any) {
      setVisualRows((p) => ({ ...p, [key]: { rows: [], loading: false, err: e?.message || String(e) } }));
    }
  }, [id]);

  // When the bound page changes, fire a DAX query per visual (real AAS rows).
  useEffect(() => {
    if (!bound || !page) return;
    (page.visuals || []).forEach((v, i) => { runVisual(`${activePage}:${i}`, v); });
  }, [bound, activePage, page, runVisual]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Data', actions: [
        { label: 'Refresh', onClick: loadDetail, title: 'reload the report definition and re-run all visual queries' },
      ]},
      { label: 'View', actions: pages.map((p, i) => ({
        label: p.displayName || p.name, onClick: () => setActivePage(i), title: 'show this report page',
      })) },
    ]},
  ], [loadDetail, pages]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>Pages ({pages.length})</Subtitle2>
          {pages.length === 0 && !loading && <Caption1>No pages defined.</Caption1>}
          <Tree aria-label="Report pages">
            {pages.map((p, i) => (
              <TreeItem key={p.name || i} itemType="leaf" value={String(i)} onClick={() => setActivePage(i)}>
                <TreeItemLayout>{activePage === i ? <strong>{p.displayName || p.name}</strong> : (p.displayName || p.name)}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Report · Loom-native (Azure Analysis Services)</Badge>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadDetail}>Refresh</Button>
          </div>
          {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
          {loading && <Spinner label="Loading report…" />}
          {!bound && detail && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Bind an Azure Analysis Services model</MessageBarTitle>
                This report renders visuals by querying a bound AAS tabular model with DAX — no Power BI workspace required.
                Set <strong>state.aasServer</strong> (XMLA URI, e.g. <code>asazure://eastus2.asazure.windows.net/my-server</code>)
                and <strong>state.aasDatabase</strong> on this item, or configure <strong>LOOM_AAS_SERVER</strong> + <strong>LOOM_AAS_DATABASE</strong>
                {' '}(admin-plane/main.bicep). The Console UAMI must be a server admin on the AAS instance.
              </MessageBarBody>
            </MessageBar>
          )}
          {detail && page && (
            <div className={s.card}>
              <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>{page.displayName || page.name}</Subtitle2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacingVerticalM}}>
                {(page.visuals || []).map((v, i) => (
                  <div key={i} className={s.card}>
                    {bound
                      ? <LoomVisual visual={v} state={visualRows[`${activePage}:${i}`]} />
                      : <LoomVisualDefinition visual={v} />}
                  </div>
                ))}
                {(page.visuals || []).length === 0 && <Caption1>This page has no visuals.</Caption1>}
              </div>
            </div>
          )}
          {detail && pages.length === 0 && !loading && <Caption1>This report has no pages defined.</Caption1>}
        </div>
      }
    />
  );
}

export function ReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  // no-fabric-dependency.md: Loom-native AAS renderer is the DEFAULT. Power BI
  // embed is opt-in only via NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi.
  const biBackend = (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || '').toLowerCase();
  if (biBackend === 'powerbi') {
    return <ReportLikeEditor item={item} id={id} kind="report" listPath="/api/items/report" detailPathBase="/api/items/report" />;
  }
  return <LoomNativeReportEditor item={item} id={id} />;
}
