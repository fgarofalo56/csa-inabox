'use client';

/**
 * ObjectViewPanel (WS-4.1, Foundry-parity row Foundry-1.1-A8) — the per-instance
 * "Object View" for the Weave ontology: open one object instance and see its
 * overview, a type-badged properties inspector, its linked objects (traversed
 * from the live Apache-AGE graph and grouped by link type × direction), a
 * time-series chart, and a map — all from REAL AGE data (no-vaporware).
 *
 * Structure mirrors Palantir Foundry's Object View (overview header → widgets →
 * property inspector). Fluent v9 + Loom tokens; a G3 `SplitPane` splits the
 * view (widgets) from the property inspector; honest MessageBar gate when the
 * AGE backend env is unset; honest `EmptyState` when a widget's data is absent.
 * Azure-native (AGE/Postgres) + GeoJSON (MapLibre-compatible), Gov-safe — no
 * Fabric/Foundry REST.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Badge, Spinner, Body1, Caption1, Subtitle2, Text, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Card, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowLeft20Regular, ArrowSync20Regular, Cube20Regular, BranchFork20Regular,
  DataArea20Regular, Location20Regular, Table20Regular, Info20Regular, Calculator20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { loomDocUrl } from '@/lib/learn/content';
import { TimeSeriesChart } from '@/lib/components/adx/time-series-chart';
import { GeoJsonMap } from '@/lib/components/graph/geojson-map';
import type { OntoProperty } from '@/lib/editors/ontology-model';
import type { ObjectViewPanelKind } from '@/lib/foundry/object-view';
import type { DerivedValue } from '@/lib/foundry/derived-properties';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap', minWidth: 0,
  },
  titleWrap: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
  // Height comes from the surrounding ResizableCanvasRegion (G3 user-set,
  // persisted under loom.canvasHeight.object-view) — was a fixed 620px.
  split: { height: '100%', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden' },
  main: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL, overflowY: 'auto', minWidth: 0, width: '100%',
  },
  inspector: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM, overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground2, minWidth: 0, width: '100%',
  },
  panelCard: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  panelHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  panelIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  factGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM, minWidth: 0,
  },
  fact: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  factVal: { overflowWrap: 'anywhere', color: tokens.colorNeutralForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere' },
  propRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS },
  propHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  chartHost: { minHeight: '260px', minWidth: 0, width: '100%' },
  mapHost: { height: '320px', minWidth: 0, width: '100%' },
  linkSectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
});

interface WeaveObj { id: string; objectType: string; properties: Record<string, unknown> }
interface LinkedSection { key: string; linkType: string; direction: 'out' | 'in'; label: string; count: number; neighbors: WeaveObj[] }
interface TsGrid { columns: string[]; rows: unknown[][]; columnTypes: string[]; timeProp: string; valueProp: string }
interface ViewResponse {
  ok: boolean; error?: string; code?: string; gate?: { reason?: string; remediation?: string };
  objectType: string; object: WeaveObj;
  view: { panels: ObjectViewPanelKind[]; timeProp?: string; valueProp?: string; geoProp?: string };
  properties: OntoProperty[]; titleKey: string | null;
  linked: LinkedSection[]; timeseries: TsGrid | null; geo: unknown | null;
  derived?: DerivedValue[];
}

function neighborLabel(o: WeaveObj): string {
  const p = o.properties || {};
  for (const k of ['name', 'title', 'label', 'displayName']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return `${o.objectType} #${o.id}`;
}

function propsPreview(p: Record<string, unknown>): string {
  return Object.entries(p || {})
    .filter(([k]) => !k.startsWith('_'))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('  ');
}

export function ObjectViewPanel({
  ontologyId, objectType, vertexId, onClose,
}: {
  ontologyId: string;
  objectType: string;
  vertexId: string;
  onClose: () => void;
}) {
  const s = useStyles();
  const [data, setData] = useState<ViewResponse | null>(null);
  const [gate, setGate] = useState<{ reason?: string; remediation?: string; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setGate(null); setError(null);
    try {
      const r = await clientFetch(
        `/api/items/ontology/${encodeURIComponent(ontologyId)}/objects/${encodeURIComponent(vertexId)}/view?objectType=${encodeURIComponent(objectType)}`,
      );
      const j = (await r.json().catch(() => ({}))) as ViewResponse;
      if (!j?.ok) {
        if (j?.code === 'weave_not_configured') { setGate({ ...(j.gate || {}), error: j.error }); setData(null); return; }
        setError(j?.error || `HTTP ${r.status}`); setData(null); return;
      }
      setData(j);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [ontologyId, objectType, vertexId]);

  useEffect(() => { void load(); }, [load]);

  const panels = data?.view.panels ?? [];
  const has = useCallback((k: ObjectViewPanelKind) => panels.includes(k), [panels]);

  const title = useMemo(() => {
    if (!data) return `${objectType} #${vertexId}`;
    const tk = data.titleKey;
    const tv = tk ? data.object.properties?.[tk] : undefined;
    if (tv !== undefined && tv !== null && String(tv).trim()) return String(tv);
    return neighborLabel(data.object);
  }, [data, objectType, vertexId]);

  // Union of declared properties + any extra keys present on the instance.
  const propertyRows = useMemo(() => {
    type Row = { apiName: string; displayName?: string; baseType?: string; arrayOf?: boolean; value: unknown; declared: boolean };
    if (!data) return [] as Row[];
    const declared = data.properties || [];
    const seen = new Set(declared.map((p) => p.apiName));
    const rows: Row[] = declared.map((p) => ({
      apiName: p.apiName, displayName: p.displayName, baseType: p.baseType, arrayOf: p.arrayOf,
      value: data.object.properties?.[p.apiName], declared: true,
    }));
    for (const [k, v] of Object.entries(data.object.properties || {})) {
      if (k.startsWith('_') || seen.has(k)) continue;
      rows.push({ apiName: k, value: v, declared: false });
    }
    return rows;
  }, [data]);

  const header = (
    <div className={s.header}>
      <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onClose}>Back to instances</Button>
      <div className={s.titleWrap}>
        <div className={s.badgeRow}>
          <Cube20Regular className={s.panelIcon} />
          <Subtitle2 truncate wrap={false}>{title}</Subtitle2>
          <Badge appearance="tint" color="brand">{objectType}</Badge>
          <Badge appearance="outline" color="informative">AGE id {vertexId}</Badge>
        </div>
      </div>
      <LearnPopover
        title="Object view"
        content="An object view renders a single ontology object instance — its properties, the objects it links to, a time-series, and a map — from the live Weave graph (Apache AGE on Postgres)."
        tips={['Properties come from the AGE vertex', 'Linked objects are traversed over real graph edges', 'Time-series & map render only when the data is present']}
        learnMoreHref={loomDocUrl('fiab/parity/ontology')}
      />
      <Button size="small" icon={<ArrowSync20Regular />} onClick={() => void load()} disabled={busy}>Refresh</Button>
    </div>
  );

  if (gate) {
    return (
      <div className={s.root}>
        {header}
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Object graph not configured</MessageBarTitle>
            {gate.remediation || gate.reason || gate.error}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (error) {
    return (
      <div className={s.root}>
        {header}
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody><MessageBarTitle>Could not load object</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  if (busy && !data) {
    return (
      <div className={s.root}>
        {header}
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
          <Spinner size="tiny" /><Caption1>Loading object view…</Caption1>
        </div>
      </div>
    );
  }

  if (!data) return <div className={s.root}>{header}</div>;

  const main = (
    <div className={s.main}>
      {/* Overview */}
      {has('overview') && (
        <Card className={s.panelCard}>
          <div className={s.panelHead}>
            <span className={s.panelIcon}><Info20Regular /></span>
            <Subtitle2>Overview</Subtitle2>
          </div>
          <div className={s.factGrid}>
            <div className={s.fact}><Caption1>Object type</Caption1><Body1 className={s.factVal}>{objectType}</Body1></div>
            <div className={s.fact}><Caption1>AGE vertex id</Caption1><Body1 className={s.mono}>{data.object.id}</Body1></div>
            <div className={s.fact}><Caption1>Title</Caption1><Body1 className={s.factVal}>{title}</Body1></div>
            <div className={s.fact}><Caption1>Linked objects</Caption1><Body1 className={s.factVal}>{data.linked.reduce((n, l) => n + l.count, 0)}</Body1></div>
          </div>
        </Card>
      )}

      {/* Derived properties (WS-4.2) — live rollups + function-backed values */}
      {(data.derived?.length ?? 0) > 0 && (
        <Card className={s.panelCard}>
          <div className={s.panelHead}>
            <span className={s.panelIcon}><Calculator20Regular /></span>
            <Subtitle2>Derived properties</Subtitle2>
            <Badge appearance="tint" color="brand">{data.derived!.length}</Badge>
          </div>
          <div className={s.factGrid}>
            {data.derived!.map((dp) => (
              <div key={dp.apiName} className={s.fact}>
                <div className={s.propHead}>
                  <Caption1>{dp.displayName || dp.apiName}</Caption1>
                  <Badge appearance="outline" size="small" color={dp.kind === 'function' ? 'important' : 'informative'}>{dp.kind}</Badge>
                </div>
                {dp.gated ? (
                  <span className={s.factVal} style={{ color: tokens.colorNeutralForeground3 }}>
                    — <Caption1>({dp.error || 'not available'})</Caption1>
                  </span>
                ) : (
                  <Body1 className={s.factVal}>{dp.value === null || dp.value === undefined ? '—' : (typeof dp.value === 'object' ? JSON.stringify(dp.value) : String(dp.value))}</Body1>
                )}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{dp.summary}</Caption1>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Time series */}
      {has('timeseries') && (
        <Card className={s.panelCard}>
          <div className={s.panelHead}>
            <span className={s.panelIcon}><DataArea20Regular /></span>
            <Subtitle2>Time series</Subtitle2>
            {data.timeseries && (
              <Badge appearance="tint" color="brand">{data.timeseries.valueProp} over {data.timeseries.timeProp}</Badge>
            )}
          </div>
          {data.timeseries ? (
            <div className={s.chartHost}>
              <TimeSeriesChart columns={data.timeseries.columns} rows={data.timeseries.rows} columnTypes={data.timeseries.columnTypes} height={220} />
            </div>
          ) : (
            <EmptyState icon={<DataArea20Regular />} title="No time-series data"
              body="This object and its linked objects have no timestamp + numeric property pair to plot. Add a date/timestamp and a numeric property (or link to objects that carry them) to populate this chart." />
          )}
        </Card>
      )}

      {/* Map */}
      {has('map') && (
        <Card className={s.panelCard}>
          <div className={s.panelHead}>
            <span className={s.panelIcon}><Location20Regular /></span>
            <Subtitle2>Map</Subtitle2>
          </div>
          {data.geo ? (
            <div className={s.mapHost}><GeoJsonMap geojson={data.geo} /></div>
          ) : (
            <EmptyState icon={<Location20Regular />} title="No location data"
              body="This object and its linked objects have no geopoint / geoshape property. Add a geo property to place this object on the map." />
          )}
        </Card>
      )}

      {/* Linked objects */}
      {has('linkedObjects') && (
        <Card className={s.panelCard}>
          <div className={s.panelHead}>
            <span className={s.panelIcon}><BranchFork20Regular /></span>
            <Subtitle2>Linked objects</Subtitle2>
            <Badge appearance="tint" color="brand">{data.linked.reduce((n, l) => n + l.count, 0)}</Badge>
          </div>
          {data.linked.length === 0 ? (
            <Caption1>No links from this object yet. Connect it to another instance in the Links section.</Caption1>
          ) : (
            data.linked.map((sec) => (
              <div key={sec.key}>
                <div className={s.linkSectionHead}>
                  <Text weight="semibold">{sec.label}</Text>
                  <Badge appearance="outline">{sec.direction === 'out' ? '→' : '←'}</Badge>
                  <Badge appearance="tint">{sec.count}</Badge>
                </div>
                <Table size="small" aria-label={`${sec.label} linked objects`}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>id</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Object</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sec.neighbors.slice(0, 100).map((n) => (
                      <TableRow key={`${sec.key}-${n.id}`}>
                        <TableCell><span className={s.mono}>{n.id}</span></TableCell>
                        <TableCell><Badge appearance="tint" color="brand">{n.objectType}</Badge></TableCell>
                        <TableCell><span className={s.mono}>{neighborLabel(n)} · {propsPreview(n.properties)}</span></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))
          )}
        </Card>
      )}
    </div>
  );

  const inspector = (
    <div className={s.inspector}>
      <div className={s.panelHead}>
        <span className={s.panelIcon}><Table20Regular /></span>
        <Subtitle2>Properties</Subtitle2>
        <Badge appearance="tint">{propertyRows.length}</Badge>
      </div>
      <Divider />
      {propertyRows.length === 0 ? (
        <Caption1>This object has no properties.</Caption1>
      ) : (
        propertyRows.map((p) => (
          <div key={p.apiName} className={s.propRow}>
            <div className={s.propHead}>
              <Text weight="semibold">{p.displayName || p.apiName}</Text>
              {p.baseType && <Badge appearance="outline" size="small" color="informative">{p.baseType}{p.arrayOf ? '[]' : ''}</Badge>}
              {!p.declared && <Badge appearance="outline" size="small">undeclared</Badge>}
            </div>
            <span className={s.factVal}>{p.value === undefined || p.value === null || p.value === '' ? '—' : String(p.value)}</span>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className={s.root}>
      {header}
      {busy && <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}><Spinner size="tiny" /><Caption1>Refreshing…</Caption1></div>}
      {panels.includes('properties') ? (
        <ResizableCanvasRegion storageKey="object-view" defaultPx={620} minPx={320} ariaLabel="Resize object view height">
          <div className={s.split}>
            <SplitPane direction="horizontal" primary="second" defaultSize="340px" minSize={240} maxSize={520}
              storageKey="ontology-object-view" dividerLabel="Resize property inspector">
              {main}
              {inspector}
            </SplitPane>
          </div>
        </ResizableCanvasRegion>
      ) : (
        <ResizableCanvasRegion storageKey="object-view" defaultPx={620} minPx={320} ariaLabel="Resize object view height">
          <div className={s.split}>{main}</div>
        </ResizableCanvasRegion>
      )}
    </div>
  );
}
