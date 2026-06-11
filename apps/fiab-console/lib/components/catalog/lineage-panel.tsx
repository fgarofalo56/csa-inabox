'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular } from '@fluentui/react-icons';
import { LineageCanvas, type LineageCanvasHandle, type CanvasLineageNode, type CanvasLineageEdge } from './lineage-canvas';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, height: '100%' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  sourceRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
});

interface LineagePanelProps { source: 'purview'|'unity-catalog'|'onelake'; id: string; host?: string; workspaceId?: string; itemId?: string; }

interface SourceStatus { source: string; ok: boolean; gate?: string; hint?: unknown; nodeCount?: number; }

const SOURCE_LABEL: Record<string, string> = {
  purview: 'Purview',
  'unity-catalog': 'Unity Catalog',
  onelake: 'OneLake / Fabric',
  weave: 'Weave',
};

export function LineagePanel({ source, id, host, workspaceId, itemId }: LineagePanelProps) {
  const s = useStyles();
  const canvasRef = useRef<LineageCanvasHandle>(null);
  const [nodes, setNodes] = useState<CanvasLineageNode[]>([]);
  const [edges, setEdges] = useState<CanvasLineageEdge[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);
  // Fabric/OneLake assets can't be unified (the admin scan is opt-in only), so
  // the merge toggle is only meaningful for the Azure-native Purview / UC paths.
  const mergeable = source === 'purview' || source === 'unity-catalog';
  const [merge, setMerge] = useState(mergeable);

  const loadLineage = (isRefresh?: boolean) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    setSources([]);
    const params = new URLSearchParams({ source, id });
    if (host) params.set('host', host);
    if (workspaceId) params.set('workspaceId', workspaceId);
    if (itemId) params.set('itemId', itemId);
    if (merge && mergeable) params.set('merge', 'true');
    fetch(`/api/catalog/lineage/item?${params.toString()}`)
      .then(r => r.json())
      .then(j => {
        if (!j.ok) { setError(j.error); setHint(j.hint); return; }
        setNodes(j.nodes || []);
        setEdges(j.edges || []);
        setSources(Array.isArray(j.sources) ? j.sources : []);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadLineage(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [source, id, host, workspaceId, itemId, merge]);

  const gatedSources = sources.filter((x) => !x.ok);

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <Button icon={<ArrowSync20Regular />} onClick={() => loadLineage(true)} disabled={loading}>Refresh</Button>
        {mergeable && (
          <Switch
            checked={merge}
            onChange={(_, d) => setMerge(!!d.checked)}
            label="Unified (Purview + Unity Catalog + Weave)"
          />
        )}
        {merge && sources.length > 0 && (
          <div className={s.sourceRow}>
            {sources.map((src) => (
              <Badge
                key={src.source}
                appearance={src.ok ? 'tint' : 'outline'}
                color={src.ok ? 'success' : 'warning'}
                size="small"
              >
                {SOURCE_LABEL[src.source] || src.source}{src.ok ? ` · ${src.nodeCount ?? 0}` : ' · gated'}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {loading && <Spinner label="Loading lineage" />}
      {error && <MessageBar intent="warning"><MessageBarBody><strong>Lineage unavailable:</strong> {error}{hint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}</MessageBarBody></MessageBar>}
      {!loading && !error && gatedSources.map((src) => (
        <MessageBar key={src.source} intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{SOURCE_LABEL[src.source] || src.source} lineage not merged</MessageBarTitle>
            {src.gate}
            {!!src.hint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(src.hint, null, 2)}</pre>}
          </MessageBarBody>
        </MessageBar>
      ))}
      {!loading && !error && nodes.length === 0 && <MessageBar><MessageBarBody>No lineage edges found for this asset.</MessageBarBody></MessageBar>}
      {!loading && !error && nodes.length > 0 && <LineageCanvas ref={canvasRef} nodes={nodes} edges={edges} focusId={id} />}
    </div>
  );
}
