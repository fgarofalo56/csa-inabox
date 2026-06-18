'use client';

/**
 * /governance/scans — Microsoft Purview Data Map "Sources & scans" parity.
 *
 * One-for-one with the Purview portal Data Map experience:
 *   - registered data sources table (kind, endpoint, collection)
 *   - register a new source (kind picker + endpoint) — PUT /scan/datasources
 *   - per-source scans drawer + last-10 run history
 *   - trigger a scan run on demand
 *
 * All controls call the real Purview scan plane via /api/governance/scans.
 * When Purview isn't wired in this deployment (or is cross-cloud), the full
 * surface still renders; the honest gate explains the one-time fix and the
 * register/run actions disable themselves.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button, Input, Field, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, Delete20Regular, Play20Regular, Dismiss24Regular } from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';

interface Source { id: string; name: string; kind?: string; endpoint?: string; collectionId?: string; }
interface Scan { id: string; name: string; kind?: string; }
interface ScanRun { runId: string; status?: string; startTime?: string; endTime?: string; errorMessage?: string; }

// Purview source kinds (subset of the portal's "Register sources" gallery).
const SOURCE_KINDS = [
  'AdlsGen2', 'AzureSqlDatabase', 'AzureSynapseWorkspace', 'AzureBlobStorage',
  'AzureCosmosDb', 'AzureDataExplorer', 'PowerBI', 'Snowflake', 'Databricks', 'Teradata', 'Oracle',
];

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  spacer: { flex: 1 },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 380 },
  runStatus: { fontSize: 11, padding: '2px 8px', borderRadius: 999, display: 'inline-block' },
});

function runColor(status?: string): 'success' | 'danger' | 'warning' | 'informative' {
  const t = (status || '').toLowerCase();
  if (t.includes('succeed') || t === 'completed') return 'success';
  if (t.includes('fail') || t.includes('error')) return 'danger';
  if (t.includes('cancel')) return 'warning';
  return 'informative';
}

export default function GovernanceScansPage() {
  const s = useStyles();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const live = purview.configured && purview.reason === 'live';

  const [sources, setSources] = useState<Source[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // register dialog
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('AdlsGen2');
  const [endpoint, setEndpoint] = useState('');

  // scans drawer
  const [drawerSource, setDrawerSource] = useState<Source | null>(null);
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [runsByScan, setRunsByScan] = useState<Record<string, ScanRun[]>>({});

  const loadSources = useCallback(async () => {
    if (!live) { setSources(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/governance/scans');
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setSources(j.sources || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [live]);

  useEffect(() => { loadSources(); }, [loadSources]);

  async function register() {
    if (!name.trim()) { setActionErr('name required'); return; }
    setBusy(true); setActionErr(null);
    try {
      const r = await clientFetch('/api/governance/scans', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), kind, properties: endpoint ? { endpoint } : {} }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); setName(''); setEndpoint('');
      loadSources();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  async function removeSource(n: string) {
    if (!confirm(`De-register source "${n}"?`)) return;
    try {
      const r = await clientFetch(`/api/governance/scans?name=${encodeURIComponent(n)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) loadSources(); else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  async function openScans(src: Source) {
    setDrawerSource(src); setScans(null); setRunsByScan({});
    try {
      const r = await clientFetch(`/api/governance/scans?source=${encodeURIComponent(src.name)}`);
      const j = await r.json();
      if (j.ok) setScans(j.scans || []); else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  async function loadRuns(scanName: string) {
    if (!drawerSource) return;
    try {
      const r = await clientFetch(`/api/governance/scans?source=${encodeURIComponent(drawerSource.name)}&scan=${encodeURIComponent(scanName)}&runs=1`);
      const j = await r.json();
      if (j.ok) setRunsByScan((m) => ({ ...m, [scanName]: j.runs || [] }));
    } catch { /* ignore */ }
  }

  async function triggerRun(scanName: string) {
    if (!drawerSource) return;
    try {
      const r = await clientFetch('/api/governance/scans', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: drawerSource.name, scan: scanName, run: true }),
      });
      const j = await r.json();
      if (j.ok) loadRuns(scanName); else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const sourceColumns: LoomColumn<Source>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (src) => src.name, render: (src) => <strong>{src.name}</strong> },
    { key: 'kind', label: 'Kind', sortable: true, filterable: true, getValue: (src) => src.kind || '—', render: (src) => <Badge appearance="outline" size="small">{src.kind || '—'}</Badge> },
    { key: 'endpoint', label: 'Endpoint', sortable: true, filterable: true, getValue: (src) => src.endpoint || '—', render: (src) => <code style={{ fontSize: 11 }}>{src.endpoint || '—'}</code> },
    { key: 'collectionId', label: 'Collection', sortable: true, filterable: true, getValue: (src) => src.collectionId || '—', render: (src) => src.collectionId || '—' },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 160,
      render: (src) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="small" appearance="subtle" onClick={() => openScans(src)}>Scans</Button>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeSource(src.name)}>Remove</Button>
        </span>
      ),
    },
  ];

  return (
    <GovernanceShell sectionTitle="Scans & sources" sectionBadge="Data Map">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Register data sources, schedule scans, and monitor scan history — Azure SQL, ADLS, Synapse,
        Databricks, Power BI, Snowflake, on-prem Oracle/SAP. One-for-one with the Microsoft Purview Data Map.
      </Body1>

      <PurviewGate status={purview} surface="Scans & sources" reload={reloadStatus} />

      <div className={s.toolbar}>
        <div className={s.spacer} />
        <Button icon={<ArrowSync24Regular />} onClick={() => { reloadStatus(); loadSources(); }} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} disabled={!live} onClick={() => setOpen(true)}>Register source</Button>
      </div>

      {actionErr && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody><MessageBarTitle>Action failed</MessageBarTitle>{actionErr}</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody><MessageBarTitle>Could not load sources</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading data sources…" />}

      {live && !loading && !error && (sources?.length ?? 0) === 0 && (
        <div className={s.empty}>
          No data sources registered yet. Click <strong>Register source</strong> to add your first
          ADLS, Azure SQL, Synapse, or Databricks source.
        </div>
      )}

      {live && !loading && (sources?.length ?? 0) > 0 && (
        <LoomDataTable
          columns={sourceColumns}
          rows={sources || []}
          getRowId={(src: any) => src.id}
          empty="No data sources registered yet."
        />
      )}

      {/* Register source dialog */}
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Register data source</DialogTitle>
            <DialogContent>
              <div className={s.form}>
                <Field label="Source name"><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="csa-loom-lakehouse" /></Field>
                <Field label="Source kind">
                  <Dropdown value={kind} selectedOptions={[kind]} onOptionSelect={(_, d) => setKind(d.optionValue as string)}>
                    {SOURCE_KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Endpoint (optional)" hint="e.g. https://saloom.dfs.core.windows.net">
                  <Input value={endpoint} onChange={(_, d) => setEndpoint(d.value)} />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={register} disabled={busy || !name.trim()}>
                {busy ? 'Registering…' : 'Register'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Scans drawer */}
      <Drawer type="overlay" position="end" open={!!drawerSource} onOpenChange={(_, d) => { if (!d.open) setDrawerSource(null); }} size="medium">
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close scans drawer" onClick={() => setDrawerSource(null)} />}>
            Scans — {drawerSource?.name}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {scans === null && <Spinner label="Loading scans…" />}
          {scans !== null && scans.length === 0 && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No scans defined on this source.</Caption1>
          )}
          {scans?.map((sc) => (
            <div key={sc.id} style={{ marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Subtitle2>{sc.name}</Subtitle2>
                {sc.kind && <Badge appearance="outline" size="small">{sc.kind}</Badge>}
                <div style={{ flex: 1 }} />
                <Button size="small" icon={<Play20Regular />} onClick={() => triggerRun(sc.name)}>Run now</Button>
                <Button size="small" appearance="subtle" onClick={() => loadRuns(sc.name)}>History</Button>
              </div>
              {(runsByScan[sc.name] || []).map((run) => (
                <div key={run.runId} style={{ fontSize: 12, padding: '2px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Badge className={s.runStatus} appearance="tint" color={runColor(run.status)} size="small">{run.status || '—'}</Badge>
                  <span style={{ color: tokens.colorNeutralForeground3 }}>{run.startTime ? new Date(run.startTime).toLocaleString() : run.runId}</span>
                  {run.errorMessage && <span style={{ color: tokens.colorPaletteRedForeground1 }}>· {run.errorMessage}</span>}
                </div>
              ))}
            </div>
          ))}
        </DrawerBody>
      </Drawer>
    </GovernanceShell>
  );
}
