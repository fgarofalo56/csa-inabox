'use client';

import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import {
  Spinner, Button, Input, Field, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Subtitle2, Caption1, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular } from '@fluentui/react-icons';

interface UnityMeta { metastore_id: string; name: string; region?: string; workspace_hostname: string; }
interface OneLakeWs { id: string; displayName: string; capacityId?: string; }

export default function MetastoresPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hostname, setHostname] = useState('');
  const [probeResult, setProbeResult] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/catalog/metastores');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setData(j);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function probe() {
    if (!hostname) return;
    setProbeResult(null);
    const r = await fetch('/api/catalog/metastores', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'unity-catalog', hostname }),
    });
    const j = await r.json();
    setProbeResult(j);
  }

  return (
    <CatalogShell sectionTitle="Metastores & accounts">
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {loading && !error && <Spinner label="Loading metastores…" />}

      {data && (
        <>
          <Subtitle2 style={{ marginTop: 16, marginBottom: 8 }}>Databricks Unity Catalog</Subtitle2>
          {data.unityError ? (
            <MessageBar intent="warning"><MessageBarBody>
              <MessageBarTitle>Unity Catalog not configured</MessageBarTitle>{data.unityError}
              {data.unityHint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(data.unityHint, null, 2)}</pre>}
            </MessageBarBody></MessageBar>
          ) : data.unity?.length === 0 ? (
            <Caption1>No metastores discovered. Check that the Loom UAMI is in the UC metastore admin group.</Caption1>
          ) : (
            <Table aria-label="Unity metastores">
              <TableHeader><TableRow>
                <TableHeaderCell>Metastore</TableHeaderCell>
                <TableHeaderCell>Region</TableHeaderCell>
                <TableHeaderCell>Workspace</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {(data.unity as UnityMeta[]).map((m) => (
                  <TableRow key={m.metastore_id}>
                    <TableCell><strong>{m.name}</strong> <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{m.metastore_id}</Caption1></TableCell>
                    <TableCell>{m.region || '—'}</TableCell>
                    <TableCell>{m.workspace_hostname}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div style={{
            display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'flex-end',
            marginTop: 12, padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
          }}>
            <Field label="Register new Databricks workspace (probe-only — persistence is via bicep)">
              <Input value={hostname} onChange={(_, d) => setHostname(d.value)} placeholder="adb-…azuredatabricks.net" />
            </Field>
            <Button icon={<Add24Regular />} onClick={probe} disabled={!hostname}>Probe</Button>
          </div>

          {probeResult && (
            <pre style={{
              marginTop: 8, padding: 12, fontSize: 11, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, whiteSpace: 'pre-wrap',
              backgroundColor: tokens.colorNeutralBackground2,
            }}>{JSON.stringify(probeResult, null, 2)}</pre>
          )}

          <Subtitle2 style={{ marginTop: 24, marginBottom: 8 }}>Fabric / OneLake</Subtitle2>
          {data.onelakeError ? (
            <MessageBar intent="warning"><MessageBarBody>{data.onelakeError}</MessageBarBody></MessageBar>
          ) : (
            <Table aria-label="OneLake workspaces">
              <TableHeader><TableRow>
                <TableHeaderCell>Workspace</TableHeaderCell>
                <TableHeaderCell>Capacity</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {(data.onelake as OneLakeWs[]).map((w) => (
                  <TableRow key={w.id}>
                    <TableCell><strong>{w.displayName}</strong></TableCell>
                    <TableCell>{w.capacityId || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <Subtitle2 style={{ marginTop: 24, marginBottom: 8 }}>Microsoft Purview</Subtitle2>
          {data.purview ? (
            <Caption1>Account: <code>{data.purview.account}</code> ({data.purview.endpoint})</Caption1>
          ) : (
            <MessageBar intent="warning"><MessageBarBody>{data.purviewError}</MessageBarBody></MessageBar>
          )}

          <Button onClick={load} icon={<ArrowSync24Regular />} style={{ marginTop: 16 }}>Refresh</Button>
        </>
      )}
    </CatalogShell>
  );
}
