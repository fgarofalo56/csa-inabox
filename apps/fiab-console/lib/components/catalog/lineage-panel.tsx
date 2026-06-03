'use client';
import { useEffect, useRef, useState } from 'react';
import { Spinner, MessageBar, MessageBarBody, Button, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowSync20Regular } from '@fluentui/react-icons';
import { LineageCanvas, type LineageCanvasHandle, type CanvasLineageNode, type CanvasLineageEdge } from './lineage-canvas';

const useStyles = makeStyles({ wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, height: '100%' }, toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' } });

interface LineagePanelProps { source: 'purview'|'unity-catalog'|'onelake'; id: string; host?: string; workspaceId?: string; }

export function LineagePanel({ source, id, host, workspaceId }: LineagePanelProps) {
  const s = useStyles();
  const canvasRef = useRef<LineageCanvasHandle>(null);
  const [nodes, setNodes] = useState<CanvasLineageNode[]>([]);
  const [edges, setEdges] = useState<CanvasLineageEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);

  const loadLineage = (isRefresh?: boolean) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    const params = new URLSearchParams({ source, id });
    if (host) params.set('host', host);
    if (workspaceId) params.set('workspaceId', workspaceId);
    fetch(`/api/catalog/lineage/item?${params.toString()}`).then(r => r.json()).then(j => { if (!j.ok) { setError(j.error); setHint(j.hint); return; } setNodes(j.nodes || []); setEdges(j.edges || []); }).catch(e => setError(e?.message || String(e))).finally(() => setLoading(false));
  };

  useEffect(() => { loadLineage(); }, [source, id, host, workspaceId]);

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}><Button icon={<ArrowSync20Regular />} onClick={() => loadLineage(true)} disabled={loading}>Refresh</Button></div>
      {loading && <Spinner label="Loading lineage" />}
      {error && <MessageBar intent="warning"><MessageBarBody><strong>Lineage unavailable:</strong> {error}{hint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}</MessageBarBody></MessageBar>}
      {!loading && !error && nodes.length === 0 && <MessageBar><MessageBarBody>No lineage edges found for this asset.</MessageBarBody></MessageBar>}
      {!loading && !error && nodes.length > 0 && <LineageCanvas ref={canvasRef} nodes={nodes} edges={edges} focusId={id} />}
    </div>
  );
}
