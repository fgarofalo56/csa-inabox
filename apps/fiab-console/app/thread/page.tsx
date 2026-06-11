'use client';

/**
 * Loom Thread — Lineage / mesh view.
 *
 * Renders the caller's Thread edge graph ("what feeds what"): every "Weave"
 * integration created across editors (notebook attach, data-agent source,
 * Power BI model, API publish). Real data from GET /api/thread/edges (Cosmos
 * `thread-edges`); an empty graph is an honest empty state, not an error.
 *
 * Fluent v9 + Loom tokens (loom-design-standards). A Tile | List ViewToggle
 * switches between an ItemTile grid (one card per edge, keyed on the target
 * item's visual) and the shared LoomDataTable (sortable / filterable /
 * resizable). Loom targets deep-link to their editor; external targets (e.g. a
 * Power BI model) open in the service. The view choice persists to localStorage.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Title2, Body1, Caption1, Badge, Card, Spinner, MessageBar, MessageBarBody,
  MessageBarTitle, Link as FluentLink, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Branch24Regular, ArrowRight16Regular, Open16Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';

interface ThreadEdge {
  id: string;
  fromItemId: string; fromType: string; fromName?: string;
  toItemId: string; toType: string; toName?: string;
  toExternal?: boolean; toLink?: string;
  action: string; createdAt: string; createdBy?: string;
}

const LS_VIEW = 'loom.thread.viewMode.v1';

const ACTION_LABEL: Record<string, string> = {
  'analyze-in-notebook': 'Analyze in a Notebook',
  'add-data-agent-source': 'Data Agent source',
  'build-powerbi-model': 'Power BI model',
  'publish-as-api': 'Published as API',
};

/**
 * Thread target/source type → item-type-visual slug. The Thread graph uses a
 * few logical type names that aren't registry slugs; map them so a tile reuses
 * the correct icon + brand colour. Known slugs (notebook, data-agent) pass
 * through; unknown ones fall to itemVisual()'s neutral glyph.
 */
const THREAD_TILE_TYPE: Record<string, string> = {
  'powerbi-model': 'semantic-model',
  'data-api-builder': 'graphql-api',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingVerticalXXL, maxWidth: '1200px', margin: '0 auto', width: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  headIcon: { color: tokens.colorBrandForeground1 },
  intro: { color: tokens.colorNeutralForeground2, maxWidth: '760px' },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: tokens.spacingHorizontalM },
  kpi: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  kpiNum: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: '1' },
  endpoint: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  arrow: { color: tokens.colorNeutralForeground3, verticalAlign: 'middle' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end' },
  tileFooter: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
});

function typeColor(t: string): 'brand' | 'success' | 'warning' | 'informative' | 'subtle' {
  if (t === 'powerbi-model') return 'warning';
  if (t === 'data-agent') return 'success';
  if (t === 'data-api-builder') return 'informative';
  if (t === 'notebook') return 'brand';
  return 'subtle';
}

export default function ThreadLineagePage() {
  const styles = useStyles();
  const router = useRouter();
  const [edges, setEdges] = useState<ThreadEdge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<LoomView>('tile');

  // Hydrate + persist the view choice (SSR-safe; ignore quota / private mode).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(LS_VIEW, view); } catch { /* ignore */ }
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/thread/edges');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); setEdges([]); return; }
        setEdges(j.edges || []);
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || String(e)); setEdges([]); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const kpis = useMemo(() => {
    const list = edges || [];
    const byAction = new Map<string, number>();
    const sources = new Set<string>();
    const targets = new Set<string>();
    for (const e of list) {
      byAction.set(e.action, (byAction.get(e.action) || 0) + 1);
      sources.add(e.fromItemId);
      targets.add(`${e.toType}:${e.toItemId}`);
    }
    return { total: list.length, sources: sources.size, targets: targets.size, byAction };
  }, [edges]);

  const openEdge = (e: ThreadEdge) => {
    if (e.toExternal && e.toLink) window.open(e.toLink, '_blank', 'noreferrer');
    else router.push(`/items/${e.toType}/${e.toItemId}`);
  };

  const columns: LoomColumn<ThreadEdge>[] = [
    {
      key: 'from', label: 'Source', sortable: true, filterable: true,
      getValue: (r) => r.fromName || r.fromItemId,
      render: (r) => (
        <span className={styles.endpoint}>
          <FluentLink onClick={() => router.push(`/items/${r.fromType}/${r.fromItemId}`)}>
            {r.fromName || r.fromItemId}
          </FluentLink>
          <Badge appearance="tint" size="small" color={typeColor(r.fromType)}>{r.fromType}</Badge>
        </span>
      ),
    },
    {
      key: 'action', label: 'Weave', sortable: true, filterable: true,
      getValue: (r) => ACTION_LABEL[r.action] || r.action,
      render: (r) => (
        <span className={styles.endpoint}>
          <ArrowRight16Regular className={styles.arrow} />
          <Badge appearance="outline" size="small">{ACTION_LABEL[r.action] || r.action}</Badge>
        </span>
      ),
    },
    {
      key: 'to', label: 'Target', sortable: true, filterable: true,
      getValue: (r) => r.toName || r.toItemId,
      render: (r) => (
        <span className={styles.endpoint}>
          {r.toExternal
            ? <FluentLink href={r.toLink} target="_blank" rel="noreferrer">{r.toName || r.toItemId} <Open16Regular /></FluentLink>
            : <FluentLink onClick={() => router.push(`/items/${r.toType}/${r.toItemId}`)}>{r.toName || r.toItemId}</FluentLink>}
          <Badge appearance="tint" size="small" color={typeColor(r.toType)}>{r.toType}</Badge>
        </span>
      ),
    },
    { key: 'createdAt', label: 'When', sortable: true, width: 180, getValue: (r) => r.createdAt, render: (r) => <Caption1>{new Date(r.createdAt).toLocaleString()}</Caption1> },
    { key: 'createdBy', label: 'By', sortable: true, filterable: true, width: 200, getValue: (r) => r.createdBy || '' },
  ];

  const hasRows = !!edges && edges.length > 0;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Branch24Regular className={styles.headIcon} />
        <Title2>Lineage</Title2>
      </div>
      <Body1 className={styles.intro}>
        The Loom Thread graph — every <strong>Weave</strong> integration you’ve created across editors,
        showing what feeds what. Use <strong>Weave</strong> on any item’s editor to add an edge.
      </Body1>

      <div className={styles.kpis}>
        <Card className={styles.kpi}><span className={styles.kpiNum}>{kpis.total}</span><Caption1>Total edges</Caption1></Card>
        <Card className={styles.kpi}><span className={styles.kpiNum}>{kpis.sources}</span><Caption1>Source items</Caption1></Card>
        <Card className={styles.kpi}><span className={styles.kpiNum}>{kpis.targets}</span><Caption1>Targets</Caption1></Card>
        {[...kpis.byAction.entries()].map(([a, n]) => (
          <Card key={a} className={styles.kpi}><span className={styles.kpiNum}>{n}</span><Caption1>{ACTION_LABEL[a] || a}</Caption1></Card>
        ))}
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load the lineage graph</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {hasRows && (
        <div className={styles.toolbar}>
          <ViewToggle value={view} onChange={setView} ariaLabel="Lineage view" />
        </div>
      )}

      {edges == null ? (
        <Spinner label="Loading lineage…" />
      ) : view === 'tile' && hasRows ? (
        <TileGrid>
          {edges.map((e) => (
            <ItemTile
              key={e.id}
              type={THREAD_TILE_TYPE[e.toType] ?? e.toType}
              title={e.toName || e.toItemId}
              subtitle={`${e.fromName || e.fromItemId} → ${ACTION_LABEL[e.action] || e.action}`}
              meta={new Date(e.createdAt).toLocaleString()}
              badge={e.toExternal ? <Open16Regular aria-label="Opens in service" /> : undefined}
              footer={
                <span className={styles.tileFooter}>
                  <Badge appearance="tint" size="small" color={typeColor(e.fromType)}>{e.fromType}</Badge>
                  <ArrowRight16Regular className={styles.arrow} />
                  <Badge appearance="tint" size="small" color={typeColor(e.toType)}>{e.toType}</Badge>
                </span>
              }
              onClick={() => openEdge(e)}
            />
          ))}
        </TileGrid>
      ) : (
        <LoomDataTable<ThreadEdge>
          columns={columns}
          rows={edges}
          getRowId={(r) => r.id}
          empty="No Weave edges yet. Open any data item’s editor and choose “Weave” to wire it into another Loom service."
        />
      )}
    </div>
  );
}
