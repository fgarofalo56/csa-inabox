'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * LineageGraph — the /catalog lineage host that fetches the federated lineage
 * subgraph from GET /api/catalog/lineage and renders it on the SHARED
 * @xyflow/react LineageCanvas (the same canvas the Unified Catalog Lineage
 * tab, /governance/lineage, and /thread use).
 *
 * L5 upgraded this surface from the old read-only radial SVG to the full
 * canvas (ux-baseline: a touched surface is brought up to the canvas
 * standard), and wired the L1 column facet end-to-end:
 *   - the request always carries `?columns=true` so the REAL column-grain
 *     lineage (Databricks `system.access.column_lineage` today; Purview
 *     columnMapping via L4) rides along;
 *   - a "Column lineage" toggle shows/hides the column grain (table→column
 *     fan-out affordances on the canvas — matching the Databricks Catalog
 *     Explorer "See column lineage" toggle);
 *   - the canvas toolbar carries the Impact-analysis mode (select a column →
 *     highlight only its downstream column chain).
 *
 * No fabricated data: the graph renders exactly what the BFF returned; an
 * empty graph renders the honest EmptyState, a configuration gap renders the
 * MessageBar gate, and zero captured column lineage renders an honest
 * "nothing captured yet" hint instead of empty fan-outs.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Spinner, Caption1, MessageBar, MessageBarBody, Switch, Link as FluentLink,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { BranchFork16Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import {
  LineageCanvas, type CanvasLineageNode, type CanvasLineageEdge, type LineageSource,
} from './lineage-canvas';
import { deriveColumnGraphFromEdges } from './lineage-column-model';

interface Node { id: string; label: string; type?: string; source: string; deleted?: boolean; columns?: string[]; }
interface Edge { from: string; to: string; type?: string; }

interface Props {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  host?: string;
  workspaceId?: string;
}

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  toolbarSpacer: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
});

export function LineageGraph({ source, id, host, workspaceId }: Props) {
  const s = useStyles();
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[]; columnEdges?: CanvasLineageEdge[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // Column grain shown by default (default-ON, opt-out) — the toggle only
  // controls rendering; the real column data is always fetched alongside.
  const [showColumns, setShowColumns] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setHint(null);
    const params = new URLSearchParams({ source, id });
    if (host) params.set('host', host);
    if (workspaceId) params.set('workspaceId', workspaceId);
    // L1/L5: always request the column facet — the payload degrades honestly
    // (empty columnEdges) when no source captured column-grain lineage.
    params.set('columns', 'true');
    clientFetch(`/api/catalog/lineage?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) { setError(j.error); setHint(j.hint); return; }
        setData({ nodes: j.nodes, edges: j.edges, columnEdges: j.columnEdges });
      })
      .catch((e) => { if (alive) setError(e?.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, id, host, workspaceId]);

  // Adapt the BFF payload onto the shared canvas model: table-grain nodes as-is
  // (focus = the resolved asset), plus — when the toggle is on — the L1 column
  // nodes derived from the canonical `col:<table>::<column>` edge endpoints,
  // each anchored to its owning table node for the fan-out grouping.
  const graph = useMemo(() => {
    if (!data) return { nodes: [] as CanvasLineageNode[], edges: [] as CanvasLineageEdge[] };
    const tables: CanvasLineageNode[] = data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type,
      source: n.source as LineageSource,
      focus: n.id === id,
      ...(n.deleted ? { deleted: true } : {}),
      ...(n.columns?.length ? { columns: n.columns } : {}),
    }));
    const edges: CanvasLineageEdge[] = data.edges.map((e) => ({
      from: e.from, to: e.to, ...(e.type ? { type: e.type } : {}),
    }));
    if (!showColumns || !data.columnEdges?.length) return { nodes: tables, edges };
    const col = deriveColumnGraphFromEdges(tables, data.columnEdges);
    return {
      nodes: [...tables, ...(col.nodes as CanvasLineageNode[])],
      edges: [...edges, ...(col.edges as CanvasLineageEdge[])],
    };
  }, [data, id, showColumns]);

  const columnEdgeCount = data?.columnEdges?.length || 0;
  // The request opted into the column facet but no source has captured
  // column-grain lineage for this asset yet — honest empty affordance.
  const columnsEmpty = !!data && Array.isArray(data.columnEdges) && data.columnEdges.length === 0;

  if (loading) return <Spinner label="Resolving lineage…" />;
  if (error) return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <strong>Lineage unavailable:</strong> {error}
        {hint && <pre style={{ marginTop: tokens.spacingVerticalS, fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}
      </MessageBarBody>
    </MessageBar>
  );
  if (!data || data.nodes.length === 0) return (
    <EmptyState
      icon={<BranchFork16Regular />}
      title="No lineage edges"
      body="No upstream or downstream lineage was recorded for this asset. Run a Purview scan, trigger a Databricks job, or publish a pipeline to build lineage."
    />
  );

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <Switch
          checked={showColumns}
          onChange={(_, d) => setShowColumns(!!d.checked)}
          label="Column lineage"
          aria-label="Show column-level lineage"
        />
        {showColumns && columnsEmpty && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }} data-testid="columns-empty-hint">
            No column-level lineage captured yet for this asset. Column lineage flows in from
            Databricks jobs (Unity Catalog), Spark runs (OpenLineage), and Weave transforms —{' '}
            <FluentLink href="/governance/lineage">open the lineage hub</FluentLink> to see what each
            source is contributing.
          </Caption1>
        )}
        <div className={s.toolbarSpacer} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {data.nodes.length} nodes · {data.edges.length} edges
          {columnEdgeCount > 0 ? ` · ${columnEdgeCount} column edges` : ''}
        </Caption1>
      </div>
      <LineageCanvas nodes={graph.nodes} edges={graph.edges} focusId={id} />
    </div>
  );
}
