'use client';

/**
 * UcLineagePanel — the Lineage tab body for the Databricks SQL Warehouse editor.
 *
 * Fetches Unity Catalog table lineage (upstream + downstream) from the BFF route
 * `/api/databricks/unity-catalog/lineage?full_name=catalog.schema.table` (which
 * resolves the workspace host server-side and calls the real Databricks lineage
 * service: POST /api/2.0/lineage-tracking/table-lineage) and renders it on the
 * shared interactive React Flow `LineageCanvas` — the same canvas the Unified
 * Catalog → Lineage tab uses.
 *
 * Parity: Databricks Catalog Explorer "Lineage" graph for a table.
 * Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/data-lineage
 *
 * No fabricated data: empty → honest empty-state; gov / preview-disabled →
 * honest MessageBar quoting the service error.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Caption1, MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular } from '@fluentui/react-icons';
import {
  LineageCanvas,
  type CanvasLineageNode,
  type CanvasLineageEdge,
} from '@/lib/components/catalog/lineage-canvas';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalM, minHeight: 0, flex: 1 },
  head: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS },
  target: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  emptyHint: { color: tokens.colorNeutralForeground3 },
});

export interface UcLineagePanelProps {
  /** catalog.schema.table — null until a table is picked in the tree. */
  fullName: string | null;
}

export function UcLineagePanel({ fullName }: UcLineagePanelProps) {
  const s = useStyles();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [nodes, setNodes] = useState<CanvasLineageNode[]>([]);
  const [edges, setEdges] = useState<CanvasLineageEdge[]>([]);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    if (!fullName) return;
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch(`/api/databricks/unity-catalog/lineage?full_name=${encodeURIComponent(fullName)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setHint(j.hint || null); setNodes([]); setEdges([]); return; }
      setNodes(j.nodes || []);
      setEdges(j.edges || []);
      setFocusId(j.focusId || fullName);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [fullName]);

  useEffect(() => { void load(); }, [load]);

  if (!fullName) {
    return (
      <div className={s.wrap}>
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Select a table</MessageBarTitle>
            Open a catalog and schema in the left tree, then click a table (or its lineage button) to
            draw its Unity Catalog lineage graph here.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <span className={s.target}>{fullName}</span>
        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()} disabled={loading} aria-label="Refresh lineage">
          Refresh
        </Button>
        {loading && <Spinner size="tiny" label="Loading lineage…" />}
      </div>

      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Lineage unavailable</MessageBarTitle>
            {error}{hint ? ` — ${hint}` : ''}
            {' '}Unity Catalog data lineage is a preview feature; it is not enabled on Azure Government
            (GCC-High/DoD) workspaces and requires the table to have been read/written by a job or query
            for edges to appear.
          </MessageBarBody>
        </MessageBar>
      )}

      {!error && !loading && edges.length === 0 && (
        <Caption1 className={s.emptyHint}>
          No upstream or downstream lineage recorded for this table yet. Run a job or query that reads
          from / writes to it, then refresh.
        </Caption1>
      )}

      {!error && nodes.length > 0 && (
        <LineageCanvas nodes={nodes} edges={edges} focusId={focusId} />
      )}
    </div>
  );
}
