'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Tapestry — investigative graph workspace (the Azure-native Gotham-equivalent).
 *
 * Three coordinated analysis panes over the SAME materialized Node_* / Edge_* ADX
 * tables (no second engine, NO Microsoft Fabric — per no-fabric-dependency.md):
 *
 *   - Link     → force-directed graph from /api/items/tapestry/[id]/link
 *                (KQL make-graph + graph-match / graph-shortest-paths /
 *                graph-mark-components). Typed controls pick the analysis, hop
 *                depth, node label, and (for path/neighbors) the seed/target ids.
 *   - Geo      → GeoJsonMap from /api/items/tapestry/[id]/geo (node lat/lon →
 *                GeoJSON FeatureCollection); a live Azure Maps raster basemap
 *                layers behind it when NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY is set,
 *                else the keyless SVG overlay still renders (GCC-High/IL5 path).
 *   - Timeline → KustoResultsGrid from /api/items/tapestry/[id]/timeline
 *                (summarize count() by bin(ts, window), edgeLabel).
 *
 * Cross-filter: clicking a graph node sets the shared filter (seed id), which
 * the Geo + Timeline panes inherit on their next run. Every control calls a real
 * BFF route; missing-ADX surfaces an honest 503 MessageBar. No mocks
 * (no-vaporware.md). Typed forms throughout — no raw KQL textarea
 * (loom-no-freeform-config).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Badge, Button, Input, Label, Spinner, Field, InfoLabel,
  Tab, TabList, Dropdown, Option, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Search20Regular, ArrowClockwise20Regular,
  Database20Regular,
  Organization24Regular, Map24Regular, DataLine24Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ForceDirectedGraph, extractGraph, type GraphNode } from '@/lib/components/graph/force-directed-graph';
import { GeoJsonMap } from '@/lib/components/graph/geojson-map';
import { KustoResultsGrid } from '@/lib/components/adx/kusto-results-grid';

const useStyles = makeStyles({
  pad: {
    padding: tokens.spacingVerticalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minHeight: 0, minWidth: 0, flex: 1, overflowY: 'auto',
  },
  treePad: { padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  treeHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge },
  hint: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  tabStrip: {
    paddingInline: tokens.spacingHorizontalL,
    paddingBlockStart: tokens.spacingVerticalS,
    ...shorthands.borderBottom('1px', 'solid', tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground1,
  },
  filterBar: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap',
    ...shorthands.padding(tokens.spacingVerticalS, tokens.spacingHorizontalM),
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  grow: { flex: 1, minWidth: '160px' },
  narrow: { width: '120px' },
  graphWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, maxWidth: '100%' },
  graphCaption: { color: tokens.colorNeutralForeground3 },
  resultHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
});

type TabKey = 'link' | 'geo' | 'timeline';
type LinkAnalysis = 'pattern' | 'shortest-path' | 'components' | 'neighbors';
type TimelineWindow = 'hour' | 'day' | 'week';

const ANALYSIS_LABELS: Record<LinkAnalysis, string> = {
  pattern: 'Pattern match (all paths)',
  'shortest-path': 'Shortest path (source → target)',
  components: 'Connected components (clusters)',
  neighbors: 'Neighborhood (N-hop from seed)',
};

const WINDOW_LABELS: Record<TimelineWindow, string> = {
  hour: 'Hourly',
  day: 'Daily',
  week: 'Weekly',
};

function GateBar({ result, what }: { result: any; what: string }) {
  if (!result || result.ok) return null;
  const isGate = result.code === 'not_configured' || result.status === 503;
  return (
    <MessageBar intent={isGate ? 'warning' : 'error'}>
      <MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>
        <MessageBarTitle>{isGate ? `${what} backend not configured` : `${what} failed`}</MessageBarTitle>
        {result.error || 'Unknown error'}
      </MessageBarBody>
    </MessageBar>
  );
}

export function TapestryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<TabKey>('link');

  // Shared filter — cross-pane. A clicked graph node or a typed seed id flows
  // to the geo/timeline runs that follow.
  const [seedId, setSeedId] = useState<string>('');
  const [database, setDatabase] = useState<string>('');

  // Link pane state.
  const [analysis, setAnalysis] = useState<LinkAnalysis>('pattern');
  const [hops, setHops] = useState<number>(2);
  const [nodeLabel, setNodeLabel] = useState<string>('');
  const [targetId, setTargetId] = useState<string>('');
  const [linkResult, setLinkResult] = useState<any>(null);
  const [linkLoading, setLinkLoading] = useState(false);

  // Geo pane state.
  const [geoResult, setGeoResult] = useState<any>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  // Timeline pane state.
  const [twindow, setTwindow] = useState<TimelineWindow>('day');
  const [timelineResult, setTimelineResult] = useState<any>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  // Optional live Azure Maps raster basemap (client key). When unset the vector
  // overlay still renders (GCC-High / IL5 fallback).
  const mapsKey = process.env.NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY;

  const dbBody = useMemo(() => (database.trim() ? { database: database.trim() } : {}), [database]);

  const runLink = useCallback(async () => {
    setLinkLoading(true); setLinkResult(null);
    try {
      const r = await clientFetch(`/api/items/tapestry/${id}/link`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          analysis, hops,
          nodeLabel: nodeLabel || undefined,
          sourceId: seedId || undefined,
          targetId: targetId || undefined,
          ...dbBody,
        }),
      });
      setLinkResult(await r.json());
    } catch (e: any) { setLinkResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLinkLoading(false); }
  }, [id, analysis, hops, nodeLabel, seedId, targetId, dbBody]);

  const runGeo = useCallback(async () => {
    setGeoLoading(true); setGeoResult(null);
    try {
      const r = await clientFetch(`/api/items/tapestry/${id}/geo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...dbBody }),
      });
      setGeoResult(await r.json());
    } catch (e: any) { setGeoResult({ ok: false, error: e?.message || String(e) }); }
    finally { setGeoLoading(false); }
  }, [id, dbBody]);

  const runTimeline = useCallback(async () => {
    setTimelineLoading(true); setTimelineResult(null);
    try {
      const r = await clientFetch(`/api/items/tapestry/${id}/timeline`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ window: twindow, ...dbBody }),
      });
      setTimelineResult(await r.json());
    } catch (e: any) { setTimelineResult({ ok: false, error: e?.message || String(e) }); }
    finally { setTimelineLoading(false); }
  }, [id, twindow, dbBody]);

  // Run the active pane's analysis.
  const runActive = useCallback(() => {
    if (tab === 'link') return runLink();
    if (tab === 'geo') return runGeo();
    return runTimeline();
  }, [tab, runLink, runGeo, runTimeline]);

  // One-click: materialize the sample investigation graph (Node_*/Edge_* tables)
  // so the empty panes have real data to query, then re-run the active pane.
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const loadSampleGraph = useCallback(async () => {
    setSeeding(true); setSeedMsg(null);
    try {
      const r = await clientFetch('/api/admin/load-sample-data?kind=investigation', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setSeedMsg(j?.error || j?.gate?.message || `Could not load sample graph (HTTP ${r.status}).`);
        return;
      }
      setSeedMsg('Sample investigation graph loaded. Running analysis…');
      await Promise.all([runLink(), runGeo(), runTimeline()]);
    } catch (e: any) {
      setSeedMsg(e?.message || String(e));
    } finally {
      setSeeding(false);
    }
  }, [runLink, runGeo, runTimeline]);

  const linkGraph = useMemo(() => {
    if (!linkResult || !linkResult.ok) return null;
    // The route returns Kusto { columns, rows } — reshape rows into objects
    // carrying Source/Target so extractGraph() recognises them.
    const cols: string[] = linkResult.columns || [];
    const objs = (linkResult.rows || []).map((row: unknown[]) => {
      const o: Record<string, unknown> = {};
      cols.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
    const g = extractGraph(objs);
    // Carry through node-label groups from SourceGroup/TargetGroup when present.
    const groupById = new Map<string, string>();
    for (const o of objs) {
      if (typeof o.Source === 'string' && typeof o.SourceGroup === 'string') groupById.set(o.Source, o.SourceGroup);
      if (typeof o.Target === 'string' && typeof o.TargetGroup === 'string') groupById.set(o.Target, o.TargetGroup);
    }
    const nodes: GraphNode[] = g.nodes.map((n) => ({ ...n, group: groupById.get(n.id) ?? n.group, label: n.label ?? n.id }));
    if (nodes.length === 0) return null;
    return { nodes, edges: g.edges };
  }, [linkResult]);

  const geoFc = useMemo(() => {
    if (!geoResult || !geoResult.ok) return null;
    return geoResult.featureCollection || null;
  }, [geoResult]);

  const ribbon: RibbonTab[] = useMemo(() => {
    const busy = linkLoading || geoLoading || timelineLoading;
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'Analysis', actions: [
          { label: busy ? 'Running…' : 'Run analysis', icon: <Play20Regular />, onClick: busy ? undefined : runActive, disabled: busy },
          { label: 'Run all panes', icon: <ArrowClockwise20Regular />, onClick: busy ? undefined : () => { runLink(); runGeo(); runTimeline(); }, disabled: busy },
        ]},
        { label: 'Pane', actions: [
          { label: 'Link', onClick: () => setTab('link') },
          { label: 'Geo', onClick: () => setTab('geo') },
          { label: 'Timeline', onClick: () => setTab('timeline') },
        ]},
      ]},
    ];
  }, [linkLoading, geoLoading, timelineLoading, runActive, runLink, runGeo, runTimeline]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.treeHeader}>
            <Database20Regular />
            <Subtitle2>Investigation</Subtitle2>
          </div>
          <Caption1>
            Link + geo + timeline analysis over the materialized <code>Node_*</code> / <code>Edge_*</code> ADX tables.
            Azure-native — no Microsoft Fabric required.
          </Caption1>
          <Divider />
          <Field label={<InfoLabel info="Optional ADX (Azure Data Explorer) database to query instead of the default. Leave blank to use LOOM_KUSTO_DEFAULT_DB.">ADX database (optional)</InfoLabel>} hint="Defaults to LOOM_KUSTO_DEFAULT_DB.">
            <Input value={database} onChange={(_: unknown, d: any) => setDatabase(d.value)} placeholder="loomdb-default" />
          </Field>
          <Field label={<InfoLabel info="Starting node for neighbor expansion and the source for shortest-path. Set it by clicking a node in the graph, or type a node id here. It is carried across the Geo and Timeline panes.">Seed / focus node id (shared)</InfoLabel>} hint="Set by clicking a node, or type one. Used by shortest-path / neighbors and carried across panes.">
            <Input value={seedId} onChange={(_: unknown, d: any) => setSeedId(d.value)} placeholder="p-alice" />
          </Field>
          <Divider />
          <Button
            appearance="primary" icon={<Database20Regular />}
            onClick={loadSampleGraph} disabled={seeding}
          >
            {seeding ? 'Loading sample…' : 'Load sample investigation graph'}
          </Button>
          {seedMsg && <Caption1 className={s.hint}>{seedMsg}</Caption1>}
          <Caption1 className={s.hint}>
            Seeds the Node_*/Edge_* ADX tables (people, orgs, locations, events) so the link, geo, and
            timeline panes have a real graph to query. Idempotent — safe to re-run.
          </Caption1>
        </div>
      }
      main={
        <>
          <div className={s.tabStrip}>
            <TabList selectedValue={tab} onTabSelect={(_: unknown, d: any) => setTab(d.value)}>
              <Tab value="link" icon={<Organization24Regular />}>Link analysis</Tab>
              <Tab value="geo" icon={<Map24Regular />}>Geo</Tab>
              <Tab value="timeline" icon={<DataLine24Regular />}>Timeline</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            {tab === 'link' && (
              <>
                <div className={s.filterBar}>
                  <Field className={s.grow} label={<InfoLabel info="pattern = all matching paths; shortest-path = source → target; components = connected clusters; neighbors = N-hop from a seed">Analysis</InfoLabel>}>
                    <Dropdown
                      value={ANALYSIS_LABELS[analysis]} selectedOptions={[analysis]}
                      onOptionSelect={(_, d) => { if (d.optionValue) setAnalysis(d.optionValue as LinkAnalysis); }}
                    >
                      {(Object.keys(ANALYSIS_LABELS) as LinkAnalysis[]).map((a) => (
                        <Option key={a} value={a} text={ANALYSIS_LABELS[a]}>{ANALYSIS_LABELS[a]}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field className={s.narrow} label={<InfoLabel info="How many relationship hops to traverse, 1-6">Hops</InfoLabel>}>
                    <Input type="number" min={1} max={6} value={String(hops)} onChange={(_: unknown, d: any) => setHops(Math.max(1, Math.min(6, Number(d.value || '2'))))} />
                  </Field>
                  <Field className={s.grow} label={<InfoLabel info="Filter to a node type, e.g. Person / Org / Location">Node label (optional)</InfoLabel>}>
                    <Input value={nodeLabel} onChange={(_: unknown, d: any) => setNodeLabel(d.value)} placeholder="Person" />
                  </Field>
                  {analysis === 'shortest-path' && (
                    <Field className={s.grow} label={<InfoLabel info="Required for shortest-path: the destination node id">Target id</InfoLabel>}>
                      <Input value={targetId} onChange={(_: unknown, d: any) => setTargetId(d.value)} placeholder="p-frank" />
                    </Field>
                  )}
                  <Button appearance="primary" icon={linkLoading ? <Spinner size="tiny" /> : <Play20Regular />} onClick={runLink} disabled={linkLoading}>
                    {linkLoading ? 'Running…' : 'Run link'}
                  </Button>
                </div>
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>ADX graph engine</MessageBarTitle>
                    Runs KQL <code>make-graph</code> + <code>graph-match</code> / <code>graph-shortest-paths</code> /{' '}
                    <code>graph-mark-components</code> over <code>Node_*</code>/<code>Edge_*</code>. Click a node to set the shared seed
                    for the Geo + Timeline panes.
                  </MessageBarBody>
                </MessageBar>
                {linkLoading && <Spinner size="small" label="Running link analysis…" labelPosition="after" />}
                <GateBar result={linkResult} what="Link analysis" />
                {linkGraph && (
                  <div className={s.graphWrap} onClickCapture={(e) => {
                    // Capture a node click (force-directed graph nodes carry aria-label "Node <x>").
                    const t = (e.target as HTMLElement)?.closest('[aria-label^="Node "]');
                    const lbl = t?.getAttribute('aria-label');
                    if (lbl) {
                      const nodeName = lbl.slice(5);
                      const match = linkGraph.nodes.find((n) => (n.label || n.id) === nodeName || n.id === nodeName);
                      if (match) setSeedId(match.id);
                    }
                  }}>
                    <Caption1 className={s.graphCaption}>
                      Force-directed graph ({linkGraph.nodes.length} nodes, {linkGraph.edges.length} edges) · click a node to set the shared seed
                    </Caption1>
                    <ForceDirectedGraph nodes={linkGraph.nodes} edges={linkGraph.edges} />
                  </div>
                )}
                {linkResult?.ok && !linkGraph && (
                  <MessageBar intent="info"><MessageBarBody>Query returned {linkResult.rowCount ?? 0} row(s) but no Source/Target edges to plot. Try a different analysis or a smaller hop count.</MessageBarBody></MessageBar>
                )}
                {!linkLoading && !linkResult && (
                  <EmptyState
                    icon={<Organization24Regular />}
                    title="No graph yet"
                    body="Pick an analysis (pattern, shortest path, components, or neighborhood), set the hop depth, and run it to build a force-directed graph over the Node_*/Edge_* ADX tables. Click a node to set the shared seed for the Geo and Timeline panes."
                    primaryAction={{ label: linkLoading ? 'Running…' : 'Run link analysis', onClick: runLink }}
                    secondaryAction={{ label: seeding ? 'Loading sample…' : 'Load sample graph', onClick: loadSampleGraph, appearance: 'secondary' }}
                  />
                )}
              </>
            )}

            {tab === 'geo' && (
              <>
                <div className={s.filterBar}>
                  <Button appearance="primary" icon={geoLoading ? <Spinner size="tiny" /> : <Search20Regular />} onClick={runGeo} disabled={geoLoading}>
                    {geoLoading ? 'Loading…' : 'Plot located entities'}
                  </Button>
                  {geoResult?.ok && <Badge appearance="tint" color="brand">{geoResult.count ?? 0} located</Badge>}
                </div>
                {!mapsKey && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Vector overlay renders without Azure Maps</MessageBarTitle>
                      The located entities render as a live SVG map below regardless of basemap. To layer an Azure Maps raster
                      basemap behind it (Commercial / GCC only), provision <code>Microsoft.Maps/accounts</code> and set
                      <code>NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY</code> on the Console Container App.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {geoLoading && <Spinner size="small" label="Projecting node coordinates…" labelPosition="after" />}
                <GateBar result={geoResult} what="Geo analysis" />
                {geoFc && (
                  <>
                    <div className={s.resultHeader}>
                      <Subtitle2>Entity map</Subtitle2>
                      <Badge appearance="tint" color="brand">
                        {geoResult?.count ?? 0} located node{geoResult?.count === 1 ? '' : 's'}
                      </Badge>
                    </div>
                    <GeoJsonMap geojson={geoFc} rasterUrl={null} />
                  </>
                )}
                {geoResult?.ok && (geoResult.count ?? 0) === 0 && (
                  <MessageBar intent="info"><MessageBarBody>No nodes carry lat/lon properties yet. Seed the investigation dataset (kind=investigation) — Person/Org/Location nodes carry coordinates.</MessageBarBody></MessageBar>
                )}
                {!geoLoading && !geoResult && (
                  <EmptyState
                    icon={<Map24Regular />}
                    title="No entities plotted"
                    body="Plot the located entities to project node lat/lon coordinates onto a live map. A vector overlay renders without Azure Maps; set NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY to layer a raster basemap behind it."
                    primaryAction={{ label: geoLoading ? 'Loading…' : 'Plot located entities', onClick: runGeo }}
                    secondaryAction={{ label: seeding ? 'Loading sample…' : 'Load sample graph', onClick: loadSampleGraph, appearance: 'secondary' }}
                  />
                )}
              </>
            )}

            {tab === 'timeline' && (
              <>
                <div className={s.filterBar}>
                  <Field className={s.grow} label={<InfoLabel info="Time bucket for the timeline: hourly / daily / weekly">Bin window</InfoLabel>}>
                    <Dropdown
                      value={WINDOW_LABELS[twindow]} selectedOptions={[twindow]}
                      onOptionSelect={(_, d) => { if (d.optionValue) setTwindow(d.optionValue as TimelineWindow); }}
                    >
                      {(Object.keys(WINDOW_LABELS) as TimelineWindow[]).map((w) => (
                        <Option key={w} value={w} text={WINDOW_LABELS[w]}>{WINDOW_LABELS[w]}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Button appearance="primary" icon={timelineLoading ? <Spinner size="tiny" /> : <Play20Regular />} onClick={runTimeline} disabled={timelineLoading}>
                    {timelineLoading ? 'Running…' : 'Run timeline'}
                  </Button>
                </div>
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Event timeline</MessageBarTitle>
                    Bins every <code>Edge_*</code> event by the chosen window and edge label
                    (<code>summarize count() by bin(timestamp, …), edgeLabel</code>) so you can see how the relationships evolve over time.
                  </MessageBarBody>
                </MessageBar>
                {timelineLoading && <Spinner size="small" label="Binning events…" labelPosition="after" />}
                <GateBar result={timelineResult} what="Timeline analysis" />
                {timelineResult?.ok && (
                  <>
                    <div className={s.resultHeader}>
                      <Label>Events per {WINDOW_LABELS[twindow].toLowerCase()} bucket, by relationship</Label>
                      {typeof timelineResult.rowCount === 'number' && (
                        <Badge appearance="tint" color="brand">{timelineResult.rowCount} bucket{timelineResult.rowCount === 1 ? '' : 's'}</Badge>
                      )}
                    </div>
                    <KustoResultsGrid
                      columns={timelineResult.columns || []}
                      columnTypes={timelineResult.columnTypes}
                      rows={timelineResult.rows || []}
                      totalRowCount={timelineResult.rowCount}
                    />
                  </>
                )}
                {!timelineLoading && !timelineResult && (
                  <EmptyState
                    icon={<DataLine24Regular />}
                    title="No timeline yet"
                    body="Choose a bin window (hourly, daily, or weekly) and run the timeline to bin every Edge_* event by window and relationship label, so you can see how the graph's relationships evolve over time."
                    primaryAction={{ label: timelineLoading ? 'Running…' : 'Run timeline', onClick: runTimeline }}
                    secondaryAction={{ label: seeding ? 'Loading sample…' : 'Load sample graph', onClick: loadSampleGraph, appearance: 'secondary' }}
                  />
                )}
              </>
            )}
          </div>
        </>
      }
    />
  );
}
