'use client';

/**
 * ObjectExplorerPanel (Foundry-parity rows 2.6 + 4.7) — cross-type object browse
 * + FACETS / HISTOGRAMS + property-type-aware filters + link traversal + saved
 * explorations + a FULL-PAGE mode, over the shipped Weave AGE store (via
 * /api/items/ontology/[id]/explore). Fluent v9 + Loom tokens; honest weave-gate
 * + empty states. No Fabric — Apache AGE on Postgres.
 *
 * WS-4.7 additions:
 *  - Facets & histograms: per-property charts computed IN JS from the real AGE
 *    instances the search already fetched (AGE openCypher can't run the "any
 *    property" aggregate — see lib/foundry/object-facets). string→facet counts,
 *    number→histogram buckets, date→time buckets, bool→2-way, chosen from the
 *    object-type model's declared property types (shipped by the search route).
 *  - Type-aware filters: clicking a bar toggles a category/range/timerange/
 *    boolean filter; the instance list is filtered by ANDing them (real filter).
 *  - Full-page mode: a resizable, viewport-filling overlay (Esc / Close to exit)
 *    for a Foundry-grade browsing surface. Rail↔main and facets↔results use the
 *    shared SplitPane primitive (G3 resizable panels) with persisted sizes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Input, Badge, Spinner, Body1, Caption1, Subtitle2, Text, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, Cube20Regular, BranchFork20Regular, Save20Regular,
  ArrowSync20Regular, Dismiss16Regular, FullScreenMaximize20Regular, Filter16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { ObjectFacetCharts } from './object-facets-panel';
import {
  buildFacetCharts, applyFacetFilters, sameFilter, filterLabel,
  type ExplorerProperty, type FacetFilter,
} from '@/lib/foundry/object-facets';

const useStyles = makeStyles({
  rail: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, overflow: 'auto', height: '100%', padding: tokens.spacingHorizontalXXS },
  railItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium, cursor: 'pointer', border: `1px solid transparent` },
  railItemActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  main: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, height: '100%' },
  mainBody: { flex: 1, minHeight: 0, minWidth: 0 },
  scroll: { height: '100%', overflow: 'auto', minWidth: 0, paddingRight: tokens.spacingHorizontalXS },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  props: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere' },
  saved: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  filters: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
  // Bounded canvas (embedded); the full-page overlay uses the viewport instead.
  region: { height: 'clamp(360px, 62vh, 760px)', minHeight: 0, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden' },
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  overlayRegion: { flex: 1, minHeight: 0, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden' },
  headRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' },
  headLeft: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  resultHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
});

interface Obj { id: string; objectType: string; properties: Record<string, unknown> }
interface Facet { objectType: string; count: number }
interface Neighbor { linkType: string; direction: 'out' | 'in'; neighbor: Obj }
interface Saved { name: string; type: string; q?: string }

function propsPreview(p: Record<string, unknown>): string {
  return Object.entries(p || {}).filter(([k]) => !k.startsWith('_')).slice(0, 5).map(([k, v]) => `${k}=${String(v)}`).join('  ');
}

export function ObjectExplorerPanel({ ontologyId }: { ontologyId: string }) {
  const s = useStyles();
  const api = useCallback((p: string) => `/api/items/ontology/${encodeURIComponent(ontologyId)}${p}`, [ontologyId]);

  const [gate, setGate] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facet[]>([]);
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [objects, setObjects] = useState<Obj[]>([]);
  const [properties, setProperties] = useState<ExplorerProperty[]>([]);
  const [filters, setFilters] = useState<FacetFilter[]>([]);
  const [busy, setBusy] = useState(false);
  const [neighbors, setNeighbors] = useState<{ from: Obj; items: Neighbor[] } | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [fullPage, setFullPage] = useState(false);

  const loadFacets = useCallback(async () => {
    setBusy(true); setGate(null);
    try {
      const r = await clientFetch(api('/explore?mode=facets'));
      const j = await r.json();
      if (j.ok === false) { if (j.code === 'weave_not_configured') setGate(j.remediation || j.error); return; }
      setFacets(j.facets || []);
      if (!type && j.facets?.[0]) setType(j.facets[0].objectType);
    } catch { /* keep empty */ } finally { setBusy(false); }
  }, [api, type]);

  const loadSaved = useCallback(async () => {
    try { const r = await clientFetch(api('/explore?mode=saved')); const j = await r.json(); if (j.ok !== false) setSaved(j.explorations || []); } catch { /* */ }
  }, [api]);

  const search = useCallback(async (t = type, query = q) => {
    if (!t) return;
    setBusy(true); setNeighbors(null); setFilters([]);
    try {
      const r = await clientFetch(api(`/explore?mode=search&type=${encodeURIComponent(t)}&q=${encodeURIComponent(query)}&top=500`));
      const j = await r.json();
      if (j.ok === false) { setObjects([]); setProperties([]); }
      else { setObjects(j.objects || []); setProperties(Array.isArray(j.properties) ? j.properties : []); }
    } catch { setObjects([]); setProperties([]); } finally { setBusy(false); }
  }, [api, type, q]);

  const traverse = useCallback(async (o: Obj) => {
    setBusy(true);
    try {
      const r = await clientFetch(api(`/explore?mode=traverse&type=${encodeURIComponent(o.objectType)}&from=${encodeURIComponent(o.id)}`));
      const j = await r.json();
      setNeighbors({ from: o, items: j.ok === false ? [] : (j.neighbors || []) });
    } catch { setNeighbors({ from: o, items: [] }); } finally { setBusy(false); }
  }, [api]);

  const saveExploration = useCallback(async () => {
    if (!type) return;
    const name = `${type}${q ? `: ${q}` : ''}`.slice(0, 60);
    await clientFetch(api('/explore'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, type, q }) });
    await loadSaved();
  }, [api, type, q, loadSaved]);

  const removeSaved = useCallback(async (name: string) => {
    await clientFetch(api(`/explore?name=${encodeURIComponent(name)}`), { method: 'DELETE' });
    await loadSaved();
  }, [api, loadSaved]);

  useEffect(() => { void loadFacets(); void loadSaved(); }, [loadFacets, loadSaved]);
  useEffect(() => { if (type) void search(type, ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type]);

  // Esc closes full-page mode.
  useEffect(() => {
    if (!fullPage) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullPage(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullPage]);

  // Facets over the FULL fetched set (stable bars); the table shows the filtered set.
  const charts = useMemo(() => buildFacetCharts(objects, properties), [objects, properties]);
  const filtered = useMemo(() => applyFacetFilters(objects, filters), [objects, filters]);

  const toggleFilter = useCallback((f: FacetFilter) => {
    setFilters((prev) => (prev.some((x) => sameFilter(x, f)) ? prev.filter((x) => !sameFilter(x, f)) : [...prev, f]));
  }, []);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const o of filtered.slice(0, 20)) for (const k of Object.keys(o.properties || {})) if (!k.startsWith('_')) keys.add(k);
    return [...keys].slice(0, 6);
  }, [filtered]);

  if (gate) {
    return (
      <MessageBar intent="warning" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Object graph not configured</MessageBarTitle>
          {gate}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const header = (
    <div className={s.headRow}>
      <span className={s.headLeft}>
        <Subtitle2>Object Explorer</Subtitle2>
        <Button size="small" icon={<ArrowSync20Regular />} onClick={() => { void loadFacets(); void search(); }} disabled={busy}>Refresh</Button>
        {busy && <Spinner size="tiny" />}
      </span>
      {fullPage ? (
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setFullPage(false)}>Close full screen</Button>
      ) : (
        <Tooltip content="Open the explorer full screen" relationship="label">
          <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} onClick={() => setFullPage(true)}>Full screen</Button>
        </Tooltip>
      )}
    </div>
  );

  const savedRow = saved.length > 0 && (
    <div className={s.saved}>
      <Caption1>Saved:</Caption1>
      {saved.map((sv) => (
        <Badge key={sv.name} appearance="tint" color="brand" style={{ cursor: 'pointer' }}
          onClick={() => { setType(sv.type); setQ(sv.q || ''); void search(sv.type, sv.q || ''); }}>
          {sv.name}
          <Dismiss16Regular style={{ marginLeft: tokens.spacingHorizontalXS, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void removeSaved(sv.name); }} />
        </Badge>
      ))}
    </div>
  );

  const filterRow = filters.length > 0 && (
    <div className={s.filters}>
      <Filter16Regular />
      <Caption1>Filters:</Caption1>
      {filters.map((f, i) => (
        <Badge key={`${f.apiName}-${i}`} appearance="filled" color="brand" style={{ cursor: 'pointer' }}
          onClick={() => toggleFilter(f)}>
          {filterLabel(f)}
          <Dismiss16Regular style={{ marginLeft: tokens.spacingHorizontalXS }} />
        </Badge>
      ))}
      <Button size="small" appearance="subtle" onClick={() => setFilters([])}>Clear</Button>
    </div>
  );

  const typesRail = (
    <div className={s.rail}>
      <Caption1>Object types</Caption1>
      {facets.length === 0 && !busy && <Caption1>No instances yet.</Caption1>}
      {facets.map((f) => (
        <div key={f.objectType} className={`${s.railItem} ${type === f.objectType ? s.railItemActive : ''}`}
          onClick={() => setType(f.objectType)}>
          <span><Cube20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />{f.objectType}</span>
          <Badge appearance="tint" size="small">{f.count}</Badge>
        </div>
      ))}
    </div>
  );

  const resultsPane = (
    <div className={s.scroll}>
      <div className={s.resultHead}>
        <Text weight="semibold">Instances</Text>
        <Badge appearance="tint" color="informative">
          {filters.length > 0 ? `${filtered.length} of ${objects.length}` : `${objects.length}`}
        </Badge>
      </div>
      {filtered.length === 0 && !busy ? (
        <Caption1>{objects.length === 0 ? 'No objects — pick a type on the left, or create instances in the ontology.' : 'No instances match the active filters.'}</Caption1>
      ) : (
        <Table size="small" aria-label="Objects">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>id</TableHeaderCell>
              {columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice(0, 500).map((o) => (
              <TableRow key={o.id}>
                <TableCell><Caption1>{o.id}</Caption1></TableCell>
                {columns.map((c) => <TableCell key={c}><span className={s.props}>{String(o.properties?.[c] ?? '')}</span></TableCell>)}
                <TableCell><Button size="small" icon={<BranchFork20Regular />} onClick={() => void traverse(o)}>Traverse</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {neighbors && (
        <div>
          <Text weight="semibold">Links from object {neighbors.from.id}</Text>
          {neighbors.items.length === 0 ? (
            <Caption1 style={{ display: 'block' }}>No links from this object.</Caption1>
          ) : (
            <Table size="small" aria-label="Neighbors">
              <TableHeader><TableRow><TableHeaderCell>Link</TableHeaderCell><TableHeaderCell>Dir</TableHeaderCell><TableHeaderCell>Neighbor type</TableHeaderCell><TableHeaderCell>Neighbor</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {neighbors.items.map((n, i) => (
                  <TableRow key={i}>
                    <TableCell><Badge appearance="tint">{n.linkType}</Badge></TableCell>
                    <TableCell>{n.direction === 'out' ? '→' : '←'}</TableCell>
                    <TableCell>{n.neighbor.objectType}</TableCell>
                    <TableCell><span className={s.props}>{propsPreview(n.neighbor.properties)}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );

  // Main column: search row on top, then a facets↕results vertical split (when
  // there are charts) or just the results pane. Both panes scroll independently.
  const mainArea = (
    <div className={s.main}>
      <div className={s.row}>
        <Input contentBefore={<Search20Regular />} placeholder={`Search ${type || 'objects'} properties…`} value={q}
          onChange={(_, d) => setQ(d.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} style={{ minWidth: '260px' }} />
        <Button appearance="primary" icon={<Search20Regular />} onClick={() => void search()} disabled={busy || !type}>Search</Button>
        <Button size="small" icon={<Save20Regular />} onClick={saveExploration} disabled={!type}>Save exploration</Button>
      </div>
      <div className={s.mainBody}>
        {charts.length > 0 ? (
          <SplitPane direction="vertical" primary="first" defaultSize="46%" minSize={140}
            storageKey="onto-explorer-facets" dividerLabel="Resize facets panel">
            <div className={s.scroll}>
              <ObjectFacetCharts charts={charts} activeFilters={filters} onToggle={toggleFilter} busy={busy} />
            </div>
            {resultsPane}
          </SplitPane>
        ) : resultsPane}
      </div>
    </div>
  );

  const splitBody = (
    <SplitPane direction="horizontal" primary="first" defaultSize={224} minSize={168} maxSize={380}
      storageKey="onto-explorer-rail" dividerLabel="Resize object-types rail">
      {typesRail}
      {mainArea}
    </SplitPane>
  );

  if (fullPage) {
    return (
      <div className={s.overlay} role="dialog" aria-modal="true" aria-label="Object Explorer (full screen)">
        {header}
        <Body1>Browse object instances across every type, chart their properties, filter, and traverse links — over the live Weave graph (Apache AGE on Postgres).</Body1>
        {savedRow}
        {filterRow}
        <div className={s.overlayRegion}>{splitBody}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
      {header}
      <Body1>Browse object instances across every type, chart their properties, filter, and traverse links — over the live Weave graph (Apache AGE on Postgres).</Body1>
      {savedRow}
      {filterRow}
      <div className={s.region}>{splitBody}</div>
    </div>
  );
}
