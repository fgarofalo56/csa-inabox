'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { LineageGraph } from '@/lib/components/catalog/lineage-graph';
import { CrossSourceActions } from '@/lib/components/catalog/cross-source-actions';
import {
  Spinner, Badge, MessageBar, MessageBarBody, Button, Subtitle2, Caption1,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  tokens, Card, CardHeader,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';

export default function AssetDetailPage() {
  const params = useParams();
  const search = useSearchParams();
  const source = String(params.source);
  const id = decodeURIComponent(String(params.id));
  const host = search.get('host') || '';
  const workspaceId = search.get('workspace') || '';
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const p = new URLSearchParams({ source });
    if (host) p.set('host', host);
    if (workspaceId) p.set('workspaceId', workspaceId);
    fetch(`/api/catalog/asset/${encodeURIComponent(id)}?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) { setError(j.error); setHint(j.hint); return; }
        setDetail(j);
      })
      .catch((e) => { if (alive) setError(e?.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, id, host, workspaceId]);

  return (
    <CatalogShell sectionTitle={id} sectionBadge={source}>
      {loading && <Spinner label="Loading asset…" />}
      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <strong>Asset detail unavailable:</strong> {error}
            {hint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}
          </MessageBarBody>
        </MessageBar>
      )}
      {detail && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Card>
            <CardHeader header={<Subtitle2>Overview</Subtitle2>} />
            <div style={{ padding: 12 }}>
              {source === 'unity-catalog' && detail.detail && (
                <>
                  <div><strong>Full name:</strong> {detail.detail.full_name}</div>
                  <div><strong>Type:</strong> {detail.detail.table_type || '—'}</div>
                  <div><strong>Format:</strong> {detail.detail.data_source_format || '—'}</div>
                  <div><strong>Owner:</strong> {detail.detail.owner || '—'}</div>
                  <div><strong>Comment:</strong> {detail.detail.comment || '—'}</div>
                </>
              )}
              {source === 'purview' && detail.detail?.entity?.attributes && (
                <>
                  <div><strong>Name:</strong> {detail.detail.entity.attributes.name}</div>
                  <div><strong>Type:</strong> {detail.detail.entity.typeName}</div>
                  <div><strong>Qualified name:</strong> {detail.detail.entity.attributes.qualifiedName}</div>
                  <div><strong>Status:</strong> {detail.detail.entity.status || '—'}</div>
                </>
              )}
              {detail.upstreamLink && (
                <a href={detail.upstreamLink} target="_blank" rel="noreferrer" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 12, fontSize: 13,
                }}>
                  Open in upstream tool <Open16Regular />
                </a>
              )}
            </div>
          </Card>

          {source === 'unity-catalog' && detail.detail?.columns?.length > 0 && (
            <Card>
              <CardHeader header={<Subtitle2>Schema</Subtitle2>} />
              <div style={{ padding: 12 }}>
                <Table aria-label="Schema">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Column</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Nullable</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {detail.detail.columns.map((c: any) => (
                      <TableRow key={c.name}>
                        <TableCell><code>{c.name}</code></TableCell>
                        <TableCell>{c.type_text || c.type_name}</TableCell>
                        <TableCell>{c.nullable === false ? 'NOT NULL' : 'YES'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}

          {source === 'purview' && detail.detail?.entity?.classifications && (
            <Card>
              <CardHeader header={<Subtitle2>Classifications</Subtitle2>} />
              <div style={{ padding: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {detail.detail.entity.classifications.map((c: any) => (
                  <Badge key={c.typeName} appearance="filled" color="severe">{c.typeName}</Badge>
                ))}
              </div>
            </Card>
          )}

          {source === 'onelake' && detail.detail && !detail.detail._error && (
            <Card>
              <CardHeader header={<Subtitle2>OneLake item</Subtitle2>} />
              <div style={{ padding: 12 }}>
                <div><strong>Display name:</strong> {detail.detail.displayName}</div>
                <div><strong>Type:</strong> {detail.detail.type || '—'}</div>
                <div><strong>Workspace:</strong> {workspaceId}</div>
                <div><strong>Description:</strong> {detail.detail.description || '—'}</div>
              </div>
            </Card>
          )}

          {source === 'onelake' && Array.isArray(detail.shortcuts) && detail.shortcuts.length > 0 && (
            <Card style={{ gridColumn: '1 / -1' }}>
              <CardHeader header={<Subtitle2>Shortcuts</Subtitle2>} />
              <div style={{ padding: 12 }}>
                <Table aria-label="Shortcuts">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Path</TableHeaderCell>
                      <TableHeaderCell>Target</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.shortcuts.map((sc: any, i: number) => (
                      <TableRow key={`${sc.path}/${sc.name}/${i}`}>
                        <TableCell><code>{sc.name}</code></TableCell>
                        <TableCell>{sc.path}</TableCell>
                        <TableCell><pre style={{ margin: 0, fontSize: 11 }}>{JSON.stringify(sc.target, null, 2)}</pre></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}

          <Card style={{ gridColumn: '1 / -1' }}>
            <CardHeader header={<Subtitle2>Cross-source actions</Subtitle2>} />
            <div style={{ padding: 12 }}>
              <CrossSourceActions
                source={source as 'purview' | 'unity-catalog' | 'onelake'}
                id={id}
                host={host}
                workspaceId={workspaceId}
                detail={detail}
              />
            </div>
          </Card>

          <Card style={{ gridColumn: '1 / -1' }}>
            <CardHeader header={<Subtitle2>Lineage</Subtitle2>} />
            <div style={{ padding: 12 }}>
              <LineageGraph source={source as any} id={id} host={host} workspaceId={workspaceId} />
            </div>
          </Card>
        </div>
      )}
    </CatalogShell>
  );
}
