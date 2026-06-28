'use client';

/**
 * DashboardEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * no-fabric-dependency.md: the Loom dashboard canvas is Azure-native by DEFAULT.
 * Streaming tiles run on Azure Data Explorer (ADX); Q&A tiles run DAX on Azure
 * Analysis Services / Power BI; the grid layout + Loom tiles persist to Cosmos
 * (pbi-dashboard-overlays) via PUT /api/items/dashboard/[id]. NO Power BI /
 * Fabric workspace is required — the Power BI embed + "pin from a PBI dashboard"
 * clone path are the opt-in Fabric-family surface. The editor's exclusive
 * helpers move with it verbatim: LoomTileBody, LoomTileCard, PinnedPbiTile,
 * PinTileDialog, QaTileDialog, StreamingTileDialog, randomTileId, plus the
 * DashboardLite / TileLite shapes. The shared KQL results/visualization cluster
 * (TileVisual / KqlResult / TileViz) is imported from ./kql-results, the shared
 * Power BI workspace picker (usePowerBiWorkspaces / WorkspacePicker) from
 * ./workspace-picker, and the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports DashboardEditor from a barrel line so the
 * registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, SpinButton,
  tokens,
} from '@fluentui/react-components';
import {
  Pin20Regular, Sparkle20Regular, Flash20Regular, Save20Regular,
  DataBarVertical20Regular, ArrowSync20Regular, Open20Regular,
  Database20Regular, ArrowMaximize20Regular, Delete20Regular,
  Play20Regular, Add20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from '../item-editor-chrome';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type { LoomTile, TileLayout, TileVizKind, LoomTileKind } from '@/lib/azure/dashboard-overlay';
import { usePowerBiWorkspaces, WorkspacePicker } from './workspace-picker';
import { TileVisual, type KqlResult, type TileViz } from './kql-results';
import { useStyles } from './styles';

interface DashboardLite { id: string; displayName: string; webUrl?: string; embedUrl?: string; isReadOnly?: boolean; }
interface TileLite { id: string; title?: string; subTitle?: string; reportId?: string; datasetId?: string; embedUrl?: string; rowSpan?: number; colSpan?: number; }

export function DashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [dashboards, setDashboards] = useState<DashboardLite[] | null>(null);
  const [dashId, setDashId] = useState('');
  const [tiles, setTiles] = useState<TileLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; dashboardId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'canvas' | 'pbi'>('canvas');

  // ---- Loom overlay (Azure-native tiles + grid layout, persisted to Cosmos) --
  const [loomTiles, setLoomTiles] = useState<LoomTile[]>([]);
  const [layout, setLayout] = useState<Record<string, TileLayout>>({});
  const [loomResults, setLoomResults] = useState<Record<string, KqlResult>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [addDialog, setAddDialog] = useState<'pin' | 'qa' | 'streaming' | null>(null);
  const [fullscreenTile, setFullscreenTile] = useState<string | null>(null);

  // Responsive: collapse the 12-col grid to a single column on narrow viewports.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const onResize = () => setNarrow(typeof window !== 'undefined' && window.innerWidth < 720);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const selectedDash = (dashboards || []).find((d) => d.id === dashId);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDashboards([]); setErr(j.error); return; }
      setDashboards(j.dashboards || []);
      setDashId((prev) => prev || (j.dashboards?.[0]?.id ?? ''));
    } catch (e: any) { setDashboards([]); setErr(e?.message || String(e)); }
  }, []);

  // Load the Loom overlay (always — Azure-native, no PBI workspace required).
  const loadOverlay = useCallback(async (wsId: string, dId: string) => {
    try {
      const qs = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dId || id)}${qs}`);
      const j = await r.json();
      if (j.ok) {
        if (wsId && dId) setTiles(j.tiles || []);
        setLoomTiles(j.overlay?.loomTiles || []);
        setLayout(j.overlay?.layout || {});
        setDirty(false);
      } else if (wsId) { setErr(j.error); }
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  // Auto-pick the first Power BI workspace so the PBI list loads. The Loom
  // canvas does NOT depend on this — it loads its overlay by the Loom item id.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  // Overlay loads against the Loom item id regardless of PBI selection.
  useEffect(() => { loadOverlay(workspaceId, dashId); }, [workspaceId, dashId, loadOverlay]);

  useEffect(() => {
    if (!workspaceId || !dashId || tab !== 'pbi') { return; }
    let cancelled = false;
    (async () => {
      setEmbedErr(null);
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashId)}/embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, dashboardId: j.dashboardId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) {
        if (!cancelled) setEmbedErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, dashId, tab]);

  // ---- Tile execution (real backend per tile kind) -------------------------
  const runLoomTile = useCallback(async (tile: LoomTile) => {
    setLoomResults((prev) => ({ ...prev, [tile.id]: { ok: true, rows: prev[tile.id]?.rows, columns: prev[tile.id]?.columns } as KqlResult }));
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(id)}/tile-query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: tile.kind,
          query: tile.query,
          workspaceId: tile.workspaceId,
          datasetId: tile.datasetId,
          database: tile.database,
        }),
      });
      const j = await r.json();
      setLoomResults((prev) => ({
        ...prev,
        [tile.id]: j.ok
          ? { ok: true, columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount, executionMs: j.executionMs, truncated: j.truncated }
          : { ok: false, error: j.hint ? `${j.error} — ${j.hint}` : j.error },
      }));
    } catch (e: any) {
      setLoomResults((prev) => ({ ...prev, [tile.id]: { ok: false, error: e?.message || String(e) } }));
    }
  }, [id]);

  // Run every tile once on load / when the tile set changes.
  useEffect(() => {
    loomTiles.forEach((t) => { if (!loomResults[t.id]) runLoomTile(t); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loomTiles]);

  // Auto-refresh streaming tiles on their configured interval.
  useEffect(() => {
    const timers = loomTiles
      .filter((t) => t.kind === 'streaming-adx' && t.autoRefreshMs && t.autoRefreshMs >= 5000)
      .map((t) => setInterval(() => runLoomTile(t), t.autoRefreshMs));
    return () => timers.forEach(clearInterval);
  }, [loomTiles, runLoomTile]);

  const saveOverlay = useCallback(async () => {
    setSaving(true); setSaveErr(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pbiWorkspaceId: workspaceId, pbiDashboardId: dashId, loomTiles, layout }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveErr(j.error || 'save failed'); return; }
      setDirty(false);
    } catch (e: any) { setSaveErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [id, workspaceId, dashId, loomTiles, layout]);

  const addLoomTile = useCallback((tile: LoomTile) => {
    setLoomTiles((prev) => [...prev, tile]);
    setDirty(true);
    setAddDialog(null);
    runLoomTile(tile);
  }, [runLoomTile]);

  const removeLoomTile = useCallback((tileId: string) => {
    setLoomTiles((prev) => prev.filter((t) => t.id !== tileId));
    setLayout((prev) => { const n = { ...prev }; delete n[tileId]; return n; });
    setLoomResults((prev) => { const n = { ...prev }; delete n[tileId]; return n; });
    setDirty(true);
  }, []);

  // Auto-arrange: pack tiles left-to-right in a 12-col grid (3-wide default).
  const autoArrange = useCallback(() => {
    const next: Record<string, TileLayout> = {};
    let col = 0, row = 0;
    const place = (tileId: string, w: number, h: number) => {
      if (col + w > 12) { col = 0; row += 2; }
      next[tileId] = { col, row, w, h };
      col += w;
    };
    tiles.forEach((t) => place(t.id, t.colSpan || 3, t.rowSpan || 2));
    loomTiles.forEach((t) => place(t.id, t.w || 4, t.h || 2));
    setLayout(next);
    setDirty(true);
  }, [tiles, loomTiles]);

  const refreshDash = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    loadOverlay(workspaceId, dashId);
  }, [workspaceId, dashId, loadList, loadOverlay]);
  const openDashInPbi = useCallback(() => {
    if (selectedDash?.webUrl) window.open(selectedDash.webUrl, '_blank', 'noreferrer');
  }, [selectedDash?.webUrl]);

  const dashRibbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Add tile', actions: [
        { label: 'Pin from report', icon: <Pin20Regular />, onClick: () => setAddDialog('pin'), title: 'clone an already-pinned Power BI tile onto this dashboard' },
        { label: 'Q&A tile (Copilot → DAX)', icon: <Sparkle20Regular />, onClick: () => setAddDialog('qa'), title: 'ask a question in natural language → Copilot generates + runs DAX' },
        { label: 'Streaming tile (ADX/KQL)', icon: <Flash20Regular />, onClick: () => setAddDialog('streaming'), title: 'live tile over Azure Data Explorer — Azure-native, no Power BI needed' },
      ]},
      { label: 'Layout', actions: [
        { label: saving ? 'Saving…' : 'Save layout', icon: <Save20Regular />, onClick: dirty && !saving ? saveOverlay : undefined, disabled: !dirty || saving, title: dirty ? 'persist tiles + grid to Cosmos' : 'no unsaved changes' },
        { label: 'Auto-arrange', icon: <DataBarVertical20Regular />, onClick: (tiles.length + loomTiles.length) > 0 ? autoArrange : undefined, disabled: (tiles.length + loomTiles.length) === 0 },
      ]},
      { label: 'Metadata', actions: [
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: refreshDash, title: 'reload tiles + overlay' },
        { label: 'Open in Power BI', icon: <Open20Regular />, onClick: selectedDash?.webUrl ? openDashInPbi : undefined, disabled: !selectedDash?.webUrl, title: !selectedDash?.webUrl ? 'select a Power BI dashboard first' : 'open Power BI Web to pin new visuals' },
      ]},
    ]},
  ], [dirty, saving, tiles.length, loomTiles.length, selectedDash?.webUrl, saveOverlay, autoArrange, refreshDash, openDashInPbi]);

  const span = (w?: number) => narrow ? '1 / -1' : `span ${Math.max(1, Math.min(12, w ?? 4))}`;
  const fsTile = loomTiles.find((t) => t.id === fullscreenTile);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={dashRibbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>Power BI dashboards</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace to link a Power BI dashboard (optional).</Caption1>}
          {dashboards && dashboards.length === 0 && <Caption1>No dashboards in this workspace.</Caption1>}
          <Tree aria-label="Dashboards">
            {(dashboards || []).map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDashId(d.id)}>
                <TreeItemLayout>{dashId === d.id ? <strong>{d.displayName}</strong> : d.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Dashboard</Badge>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'canvas' | 'pbi')}>
              <Tab value="canvas">Tiles ({tiles.length + loomTiles.length})</Tab>
              <Tab value="pbi">Power BI view</Tab>
            </TabList>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}

          {tab === 'canvas' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Azure-native dashboard canvas</MessageBarTitle>
                  Streaming tiles run on <strong>Azure Data Explorer</strong> and Q&amp;A tiles run DAX on
                  Azure Analysis Services / Power BI — no Microsoft Fabric capacity required. Add tiles from the
                  ribbon, drag to arrange, then <strong>Save layout</strong> to persist to Cosmos.
                </MessageBarBody>
              </MessageBar>
              <div style={{
                display: 'grid',
                gridTemplateColumns: narrow ? '1fr' : 'repeat(12, 1fr)',
                gap: tokens.spacingVerticalM, paddingTop: 12,
              }}>
                {/* Pinned Power BI tiles (single-tile embed) */}
                {tiles.map((t) => {
                  const pos = layout[t.id];
                  return (
                    <div key={t.id} style={{
                      gridColumn: span(pos?.w ?? t.colSpan ?? 4),
                      border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge,
                      overflow: 'hidden', minHeight: 220, position: 'relative', background: tokens.colorNeutralBackground1,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                        <Pin20Regular />
                        <Caption1 style={{ fontWeight: 600, flex: 1 }}>{t.title || t.subTitle || 'Power BI tile'}</Caption1>
                        {t.reportId && (
                          <Tooltip content="Drill to the source report in Power BI" relationship="label">
                            <Button size="small" appearance="subtle" icon={<Open20Regular />} onClick={() => {
                              if (!workspaceId || !t.reportId) return;
                              try { window.open(`https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(t.reportId)}`, '_blank', 'noreferrer'); } catch { /* popup */ }
                            }} />
                          </Tooltip>
                        )}
                      </div>
                      <PinnedPbiTile workspaceId={workspaceId} dashboardId={dashId} tile={t} />
                    </div>
                  );
                })}

                {/* Loom-native tiles (DAX / KQL / streaming) */}
                {loomTiles.map((t) => {
                  const pos = layout[t.id];
                  return (
                    <div key={t.id} style={{ gridColumn: span(pos?.w ?? t.w ?? 4), minWidth: 0 }}>
                      <LoomTileCard
                        tile={t}
                        result={loomResults[t.id]}
                        onRefresh={() => runLoomTile(t)}
                        onFullscreen={() => setFullscreenTile(t.id)}
                        onRemove={() => removeLoomTile(t.id)}
                      />
                    </div>
                  );
                })}

                {(tiles.length + loomTiles.length) === 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      No tiles yet. Use <strong>Add tile</strong> in the ribbon to pin a visual, add a Copilot Q&amp;A tile, or add a streaming ADX tile.
                    </Caption1>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'pbi' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Power BI dashboard embed (read-only)</MessageBarTitle>
                  Authoring (pin visual, dashboard theme) lives in <strong>Power BI Web</strong>. This tab embeds
                  the selected Power BI dashboard. The opt-in path requires a Power BI workspace; the Loom canvas
                  tab is fully functional without one.
                </MessageBarBody>
              </MessageBar>
              {!workspaceId && <Caption1>Select a Power BI workspace to embed a dashboard.</Caption1>}
              {embedErr ? (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                    {embedErr}. Confirm the Console UAMI is added to this workspace and that "Service principals can use Fabric APIs" is enabled.
                  </MessageBarBody>
                </MessageBar>
              ) : embed ? (
                <PowerBIEmbedFrame embedType="dashboard" id={embed.dashboardId} embedUrl={embed.embedUrl} accessToken={embed.token} height={620} />
              ) : (
                dashId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
              )}
            </>
          )}

          {/* ---- Fullscreen a Loom tile ---- */}
          <Dialog open={!!fsTile} onOpenChange={(_, d) => { if (!d.open) setFullscreenTile(null); }}>
            <DialogSurface style={{ maxWidth: '92vw', width: '92vw' }}>
              <DialogBody>
                <DialogTitle>{fsTile?.title}</DialogTitle>
                <DialogContent>
                  {fsTile && <LoomTileBody tile={fsTile} result={loomResults[fsTile.id]} large />}
                </DialogContent>
                <DialogActions>
                  {fsTile && <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => runLoomTile(fsTile)}>Refresh</Button>}
                  <Button appearance="primary" onClick={() => setFullscreenTile(null)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ---- Add-tile dialogs ---- */}
          {addDialog === 'pin' && (
            <PinTileDialog
              dashboardItemId={id}
              workspaceId={workspaceId}
              dashboards={dashboards || []}
              selectedDashWebUrl={selectedDash?.webUrl}
              onClose={() => setAddDialog(null)}
              onPinned={() => { setAddDialog(null); refreshDash(); }}
            />
          )}
          {addDialog === 'qa' && (
            <QaTileDialog
              dashboardItemId={id}
              workspaceId={workspaceId}
              onClose={() => setAddDialog(null)}
              onAdd={addLoomTile}
            />
          )}
          {addDialog === 'streaming' && (
            <StreamingTileDialog
              dashboardItemId={id}
              onClose={() => setAddDialog(null)}
              onAdd={addLoomTile}
            />
          )}
        </div>
      }
    />
  );
}

/** Renders a single Loom tile result (table / chart / stat) with drill support. */
function LoomTileBody({ tile, result, large }: { tile: LoomTile; result?: KqlResult; large?: boolean }) {
  if (!result) return <Spinner size="tiny" label="Running…" />;
  if (!result.ok) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody><MessageBarTitle>Tile gated</MessageBarTitle>{result.error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!result.rows || result.rows.length === 0) return <Caption1>No rows.</Caption1>;
  return (
    <div style={{ maxHeight: large ? '70vh' : 220, overflow: 'auto' }}>
      <TileVisual
        viz={(tile.viz as TileViz) || 'table'}
        result={result}
      />
    </div>
  );
}

/** Loom tile card: header (kind badge + actions) + body. */
function LoomTileCard({ tile, result, onRefresh, onFullscreen, onRemove }: {
  tile: LoomTile; result?: KqlResult;
  onRefresh: () => void; onFullscreen: () => void; onRemove: () => void;
}) {
  const kindLabel: Record<LoomTileKind, string> = { dax: 'DAX', kusto: 'KQL', 'streaming-adx': 'Streaming' };
  const kindIcon: Record<LoomTileKind, JSX.Element> = {
    dax: <Sparkle20Regular />, kusto: <Database20Regular />, 'streaming-adx': <Flash20Regular />,
  };
  return (
    <div style={{
      border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge,
      background: tokens.colorNeutralBackground1, minHeight: 220, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
        {kindIcon[tile.kind]}
        <Caption1 style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tile.title}</Caption1>
        <Badge appearance="tint" size="small">{kindLabel[tile.kind]}</Badge>
        {tile.kind === 'streaming-adx' && tile.autoRefreshMs ? <Badge appearance="outline" size="small">{Math.round(tile.autoRefreshMs / 1000)}s</Badge> : null}
        <Tooltip content="Refresh" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={onRefresh} /></Tooltip>
        <Tooltip content="Fullscreen" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowMaximize20Regular />} onClick={onFullscreen} /></Tooltip>
        <Tooltip content="Remove tile" relationship="label"><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={onRemove} /></Tooltip>
      </div>
      <div style={{ padding: tokens.spacingVerticalM, flex: 1 }}>
        <LoomTileBody tile={tile} result={result} />
      </div>
    </div>
  );
}

/** Single Power BI tile embed (lazy: mints a tile token when scrolled into view). */
function PinnedPbiTile({ workspaceId, dashboardId, tile }: { workspaceId: string; dashboardId: string; tile: TileLite }) {
  const [tok, setTok] = useState<{ token: string; embedUrl: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !dashboardId || !tile.embedUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardId)}/tile-embed-token`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, tileId: tile.id }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token) setTok({ token: j.token, embedUrl: tile.embedUrl! });
        else setErr(j.error || `HTTP ${r.status}`);
      } catch (e: any) { if (!cancelled) setErr(e?.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, dashboardId, tile.id, tile.embedUrl]);
  if (err) return <div style={{ padding: tokens.spacingVerticalM }}><Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Caption1></div>;
  if (!tok) return <div style={{ padding: tokens.spacingVerticalM }}><Spinner size="tiny" label="Embedding tile…" /></div>;
  return <PowerBIEmbedFrame embedType="tile" id={tile.id} embedUrl={tok.embedUrl} accessToken={tok.token} height={180} />;
}

/** Pin (clone) an existing Power BI tile onto this dashboard. */
function PinTileDialog({ dashboardItemId, workspaceId, dashboards, selectedDashWebUrl, onClose, onPinned }: {
  dashboardItemId: string; workspaceId: string; dashboards: DashboardLite[];
  selectedDashWebUrl?: string; onClose: () => void; onPinned: () => void;
}) {
  const [sourceDash, setSourceDash] = useState('');
  const [srcTiles, setSrcTiles] = useState<TileLite[]>([]);
  const [tileId, setTileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !sourceDash) { setSrcTiles([]); return; }
    (async () => {
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(sourceDash)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        setSrcTiles(j.ok ? (j.tiles || []) : []);
      } catch { setSrcTiles([]); }
    })();
  }, [workspaceId, sourceDash]);
  const pin = useCallback(async () => {
    if (!workspaceId || !sourceDash || !tileId) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/pin`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, sourceDashboardId: sourceDash, tileId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      onPinned();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, workspaceId, sourceDash, tileId, onPinned]);
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Pin a tile</DialogTitle>
          <DialogContent>
            <MessageBar intent="info">
              <MessageBarBody>
                Pinning a brand-new visual happens in <strong>Power BI Web</strong> (open a report → pin a visual to
                this dashboard). Below you can <strong>clone an already-pinned tile</strong> from another Power BI
                dashboard onto this one.
              </MessageBarBody>
              {selectedDashWebUrl && (
                <MessageBarActions>
                  <Button size="small" icon={<Open20Regular />} onClick={() => window.open(selectedDashWebUrl, '_blank', 'noreferrer')}>Open in Power BI</Button>
                </MessageBarActions>
              )}
            </MessageBar>
            {!workspaceId && <MessageBar intent="warning"><MessageBarBody>Select a Power BI workspace first (the clone API is a Power BI REST call).</MessageBarBody></MessageBar>}
            <Field label="Source dashboard" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={sourceDash} onChange={(_, d) => { setSourceDash(d.value); setTileId(''); }}>
                <option value="">— choose —</option>
                {dashboards.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
              </Select>
            </Field>
            <Field label="Tile to clone" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={tileId} onChange={(_, d) => setTileId(d.value)} disabled={srcTiles.length === 0}>
                <option value="">{srcTiles.length === 0 ? '— pick a source dashboard with tiles —' : '— choose —'}</option>
                {srcTiles.map((t) => <option key={t.id} value={t.id}>{t.title || t.subTitle || t.id}</option>)}
              </Select>
            </Field>
            {err && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!workspaceId || !sourceDash || !tileId || busy} onClick={pin} icon={busy ? <Spinner size="tiny" /> : <Pin20Regular />}>Pin tile</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Q&A tile: Copilot generates DAX from a natural-language question, runs it. */
function QaTileDialog({ dashboardItemId, workspaceId, onClose, onAdd }: {
  dashboardItemId: string; workspaceId: string; onClose: () => void; onAdd: (t: LoomTile) => void;
}) {
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [nl, setNl] = useState('');
  const [title, setTitle] = useState('');
  const [dax, setDax] = useState('');
  const [result, setResult] = useState<KqlResult | null>(null);
  const [viz, setViz] = useState<TileVizKind>('table');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const semanticBackend = (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_LOOM_SEMANTIC_BACKEND || '')) || '';
  const aasMode = semanticBackend.toLowerCase() === 'analysis-services';

  useEffect(() => {
    if (aasMode || !workspaceId) return;
    (async () => {
      try {
        const r = await fetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        if (j.ok) setDatasets((j.datasets || []).filter((d: any) => d.id && d.name).map((d: any) => ({ id: d.id, name: d.name })));
      } catch { /* honest gate shown on run */ }
    })();
  }, [workspaceId, aasMode]);

  const ask = useCallback(async () => {
    if (!nl.trim()) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/tile-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'dax', nlPrompt: nl, workspaceId, datasetId: aasMode ? undefined : datasetId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      setDax(j.generatedQuery || '');
      setResult({ ok: true, columns: j.columns || [], rows: j.rows || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, nl, workspaceId, datasetId, aasMode]);

  const runEdited = useCallback(async () => {
    if (!dax.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/tile-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'dax', query: dax, workspaceId, datasetId: aasMode ? undefined : datasetId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      setResult({ ok: true, columns: j.columns || [], rows: j.rows || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, dax, workspaceId, datasetId, aasMode]);

  const add = useCallback(() => {
    onAdd({
      id: randomTileId(), kind: 'dax', title: title.trim() || nl.trim().slice(0, 60) || 'Q&A tile',
      query: dax, viz, workspaceId: aasMode ? undefined : workspaceId, datasetId: aasMode ? undefined : datasetId, w: 4, h: 2,
    });
  }, [onAdd, title, nl, dax, viz, workspaceId, datasetId, aasMode]);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Q&amp;A tile — Copilot → DAX</DialogTitle>
          <DialogContent>
            <MessageBar intent="info"><MessageBarBody>
              Ask in natural language; Copilot (Azure OpenAI) writes the DAX and runs it on
              {aasMode ? ' Azure Analysis Services' : ' the selected Power BI semantic model'}. Edit the DAX before adding if needed.
            </MessageBarBody></MessageBar>
            {!aasMode && (
              <Field label="Semantic model (dataset)" style={{ marginTop: tokens.spacingVerticalS}}>
                <Select value={datasetId} onChange={(_, d) => setDatasetId(d.value)}>
                  <option value="">{datasets.length === 0 ? '— select a Power BI workspace with datasets —' : '— choose —'}</option>
                  {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Question" style={{ marginTop: tokens.spacingVerticalS}}>
              <Textarea value={nl} onChange={(_, d) => setNl(d.value)} placeholder="e.g. Show total sales by region for the last 12 months" rows={2} />
            </Field>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={!nl.trim() || busy} onClick={ask} style={{ marginTop: tokens.spacingVerticalS}}>Ask Copilot</Button>
            {dax && (
              <>
                <Field label="Generated DAX (editable)" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Textarea value={dax} onChange={(_, d) => setDax(d.value)} rows={4} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} />
                </Field>
                <Button appearance="secondary" icon={<Play20Regular />} onClick={runEdited} disabled={busy} style={{ marginTop: tokens.spacingVerticalS}}>Run DAX</Button>
              </>
            )}
            {err && <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {result && result.ok && (
              <div style={{ marginTop: tokens.spacingVerticalM}}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS}}>
                  <Label>Visual</Label>
                  <Select value={viz} onChange={(_, d) => setViz(d.value as TileVizKind)}>
                    {(['table', 'stat', 'bar', 'column', 'line', 'pie'] as TileVizKind[]).map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                  <Field label="Tile title" style={{ flex: 1 }}>
                    <Input value={title} onChange={(_, d) => setTitle(d.value)} placeholder="optional" />
                  </Field>
                </div>
                <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, maxHeight: 240, overflow: 'auto' }}>
                  <TileVisual viz={viz as TileViz} result={result} />
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!result?.ok || !dax.trim()} onClick={add} icon={<Add20Regular />}>Add to dashboard</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Streaming tile: live ADX/KQL query with auto-refresh. Azure-native. */
function StreamingTileDialog({ dashboardItemId, onClose, onAdd }: {
  dashboardItemId: string; onClose: () => void; onAdd: (t: LoomTile) => void;
}) {
  const [kql, setKql] = useState('');
  const [database, setDatabase] = useState('');
  const [title, setTitle] = useState('');
  const [refreshSec, setRefreshSec] = useState(30);
  const [viz, setViz] = useState<TileVizKind>('timechart');
  const [result, setResult] = useState<KqlResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const test = useCallback(async () => {
    if (!kql.trim()) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/tile-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'streaming-adx', query: kql, database }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      setResult({ ok: true, columns: j.columns || [], rows: j.rows || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, kql, database]);

  const add = useCallback(() => {
    onAdd({
      id: randomTileId(), kind: 'streaming-adx', title: title.trim() || 'Streaming tile',
      query: kql, database: database.trim() || undefined, viz,
      autoRefreshMs: Math.max(5, Math.min(300, refreshSec)) * 1000, w: 6, h: 2,
    });
  }, [onAdd, title, kql, database, viz, refreshSec]);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Streaming tile — Azure Data Explorer (KQL)</DialogTitle>
          <DialogContent>
            <MessageBar intent="info"><MessageBarBody>
              Event Hub AMQP receive is not exposed via the Loom HTTPS-only data plane. Instead, query the
              <strong> ADX table</strong> that the Event Hub data connection ingests into — the tile auto-refreshes on
              your interval. Fully Azure-native (no Power BI / Fabric).
            </MessageBarBody></MessageBar>
            <Field label="KQL query" style={{ marginTop: tokens.spacingVerticalS}}>
              <Textarea value={kql} onChange={(_, d) => setKql(d.value)} rows={4}
                placeholder={'Events\n| where Timestamp > ago(1h)\n| summarize count() by bin(Timestamp, 1m)\n| render timechart'}
                style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} />
            </Field>
            <div style={{ display: 'flex', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
              <Field label="Database (blank = default)">
                <Input value={database} onChange={(_, d) => setDatabase(d.value)} placeholder="ADX database" />
              </Field>
              <Field label="Auto-refresh (seconds)">
                <SpinButton value={refreshSec} min={5} max={300} onChange={(_, d) => setRefreshSec(Number(d.value ?? d.displayValue ?? 30) || 30)} />
              </Field>
              <Field label="Visual">
                <Select value={viz} onChange={(_, d) => setViz(d.value as TileVizKind)}>
                  {(['timechart', 'line', 'column', 'bar', 'table', 'stat', 'pie'] as TileVizKind[]).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Tile title" style={{ flex: 1 }}>
                <Input value={title} onChange={(_, d) => setTitle(d.value)} placeholder="optional" />
              </Field>
            </div>
            <Button appearance="secondary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} onClick={test} disabled={!kql.trim() || busy} style={{ marginTop: tokens.spacingVerticalS}}>Test query</Button>
            {err && <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {result?.ok && (
              <div style={{ marginTop: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, maxHeight: 240, overflow: 'auto' }}>
                <TileVisual viz={viz as TileViz} result={result} />
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!kql.trim()} onClick={add} icon={<Add20Regular />}>Add tile</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function randomTileId(): string {
  try { return (globalThis.crypto as Crypto).randomUUID(); }
  catch { return `tile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}
