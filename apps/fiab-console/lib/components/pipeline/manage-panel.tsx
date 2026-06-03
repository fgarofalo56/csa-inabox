'use client';

/**
 * ManagePanel — the ADF "Manage" hub surfaced as a dialog from the data
 * pipeline editor ribbon (ADF only).
 *
 * Three tabs mirroring the Azure Data Factory Manage hub:
 *   - Linked services      — connection definitions (AzureBlobStorage,
 *                            AzureSqlDatabase, or an advanced JSON typeProperties)
 *   - Datasets             — typed views over a linked service
 *   - Integration runtimes — the compute (Managed | SelfHosted) with start/stop
 *
 * Every list/create/delete/lifecycle call hits the real factory-level BFF
 * routes (/api/adf/linked-services | /datasets | /integration-runtimes) which
 * call ARM REST. When the factory env isn't configured those routes 503 with
 * `code:'not_configured'` + `missing` and we render an honest infra-gate
 * MessageBar naming the exact env var. No mocks.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tab, TabList, Button, Input, Field, Dropdown, Option, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Badge, Caption1, Subtitle2, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular, Play20Regular, Stop20Regular,
} from '@fluentui/react-icons';

type ManageTab = 'linked-services' | 'datasets' | 'integration-runtimes';

// ADF GET returns nested `properties.type`; Synapse GET returns a flat `type`.
// Rows tolerate both so the Type column renders on either backend.
interface LinkedServiceRow { name: string; type?: string; properties?: { type?: string; description?: string } }
interface DatasetRow { name: string; type?: string; properties?: { type?: string; linkedServiceName?: { referenceName?: string } } }
interface RuntimeRow { name: string; type?: string; description?: string; state?: string }

interface GateState { missing: string }

// Backend-aware routes. ADF exposes linked services + datasets + integration
// runtimes; Synapse exposes linked services + datasets (Synapse IRs are managed
// at the workspace level — the scaled self-hosted IR is provisioned separately,
// so the IR tab is hidden for the Synapse backend).
const ROUTES = {
  adf: {
    ls: '/api/adf/linked-services',
    ds: '/api/adf/datasets',
    ir: '/api/adf/integration-runtimes',
  },
  synapse: {
    ls: '/api/synapse/linkedservices',
    ds: '/api/synapse/datasets',
    ir: '',
  },
} as const;

export type ManageBackend = 'adf' | 'synapse';

// Common linked-service templates. The connectionString-only ones (Blob, SQL)
// get a simple form; everything else falls back to the advanced JSON editor.
const LS_TYPES = [
  { value: 'AzureBlobStorage', label: 'Azure Blob Storage (connection string)' },
  { value: 'AzureSqlDatabase', label: 'Azure SQL Database (connection string)' },
  { value: '__advanced__', label: 'Advanced (raw typeProperties JSON)' },
];

const DS_TYPES = [
  'DelimitedText', 'Json', 'Parquet', 'Binary', 'AzureSqlTable', 'AzureBlobStorageLocation',
];

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export function ManagePanel({ open, onOpenChange, backend = 'adf' }: { open: boolean; onOpenChange: (open: boolean) => void; backend?: ManageBackend }) {
  const LS_ROUTE = ROUTES[backend].ls;
  const DS_ROUTE = ROUTES[backend].ds;
  const IR_ROUTE = ROUTES[backend].ir;
  const showIr = backend === 'adf';
  const backendLabel = backend === 'adf' ? 'Data Factory' : 'Synapse workspace';
  const [tab, setTab] = useState<ManageTab>('linked-services');

  // Shared infra-gate (set whenever any route returns 503 not_configured).
  const [gate, setGate] = useState<GateState | null>(null);

  // ---- Linked services ----
  const [lsList, setLsList] = useState<LinkedServiceRow[]>([]);
  const [lsLoading, setLsLoading] = useState(false);
  const [lsError, setLsError] = useState<string | null>(null);
  const [lsName, setLsName] = useState('');
  const [lsType, setLsType] = useState('AzureBlobStorage');
  const [lsConn, setLsConn] = useState('');
  const [lsAdvanced, setLsAdvanced] = useState('{\n  "type": "AzureBlobStorage",\n  "typeProperties": {}\n}');
  const [lsBusy, setLsBusy] = useState(false);

  // ---- Datasets ----
  const [dsList, setDsList] = useState<DatasetRow[]>([]);
  const [dsLoading, setDsLoading] = useState(false);
  const [dsError, setDsError] = useState<string | null>(null);
  const [dsName, setDsName] = useState('');
  const [dsType, setDsType] = useState('DelimitedText');
  const [dsLinkedService, setDsLinkedService] = useState('');
  const [dsTypeProps, setDsTypeProps] = useState('{}');
  const [dsBusy, setDsBusy] = useState(false);

  // ---- Integration runtimes ----
  const [irList, setIrList] = useState<RuntimeRow[]>([]);
  const [irLoading, setIrLoading] = useState(false);
  const [irError, setIrError] = useState<string | null>(null);
  const [irName, setIrName] = useState('');
  const [irType, setIrType] = useState<'Managed' | 'SelfHosted'>('SelfHosted');
  const [irBusy, setIrBusy] = useState(false);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) {
      setGate({ missing: body.missing });
      return true;
    }
    return false;
  }

  // -------------------- loaders --------------------
  const loadLs = useCallback(async () => {
    setLsLoading(true); setLsError(null);
    try {
      const res = await fetch(LS_ROUTE);
      const body = await readJson(res);
      if (applyGate(body)) { setLsList([]); return; }
      if (!body.ok) { setLsError(body.error || 'failed to list linked services'); setLsList([]); return; }
      setGate(null);
      setLsList(Array.isArray(body.linkedServices) ? body.linkedServices : []);
    } catch (e: any) { setLsError(e?.message || String(e)); }
    finally { setLsLoading(false); }
  }, []);

  const loadDs = useCallback(async () => {
    setDsLoading(true); setDsError(null);
    try {
      const res = await fetch(DS_ROUTE);
      const body = await readJson(res);
      if (applyGate(body)) { setDsList([]); return; }
      if (!body.ok) { setDsError(body.error || 'failed to list datasets'); setDsList([]); return; }
      setGate(null);
      setDsList(Array.isArray(body.datasets) ? body.datasets : []);
    } catch (e: any) { setDsError(e?.message || String(e)); }
    finally { setDsLoading(false); }
  }, []);

  const loadIr = useCallback(async () => {
    setIrLoading(true); setIrError(null);
    try {
      const res = await fetch(IR_ROUTE);
      const body = await readJson(res);
      if (applyGate(body)) { setIrList([]); return; }
      if (!body.ok) { setIrError(body.error || 'failed to list integration runtimes'); setIrList([]); return; }
      setGate(null);
      setIrList(Array.isArray(body.runtimes) ? body.runtimes : []);
    } catch (e: any) { setIrError(e?.message || String(e)); }
    finally { setIrLoading(false); }
  }, []);

  // Load the active tab's data when opened / tab switched.
  useEffect(() => {
    if (!open) return;
    if (tab === 'linked-services') loadLs();
    else if (tab === 'datasets') { loadDs(); if (!lsList.length) loadLs(); }
    else if (showIr) loadIr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  // -------------------- linked service create / delete --------------------
  const createLs = useCallback(async () => {
    if (!lsName.trim()) return;
    setLsBusy(true); setLsError(null);
    try {
      let properties: any;
      if (lsType === '__advanced__') {
        try { properties = JSON.parse(lsAdvanced); }
        catch (e: any) { setLsError(`Advanced JSON invalid: ${e?.message || e}`); setLsBusy(false); return; }
        if (!properties.type) { setLsError('Advanced JSON must include a top-level "type".'); setLsBusy(false); return; }
      } else {
        if (!lsConn.trim()) { setLsError('Connection string is required.'); setLsBusy(false); return; }
        properties = { type: lsType, typeProperties: { connectionString: lsConn.trim() } };
      }
      const res = await fetch(LS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: lsName.trim(), properties }),
      });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setLsError(body.error || 'create failed'); return; }
      setLsName(''); setLsConn('');
      await loadLs();
    } catch (e: any) { setLsError(e?.message || String(e)); }
    finally { setLsBusy(false); }
  }, [lsName, lsType, lsConn, lsAdvanced, loadLs]);

  const deleteLs = useCallback(async (name: string) => {
    setLsBusy(true); setLsError(null);
    try {
      const res = await fetch(`${LS_ROUTE}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setLsError(body.error || 'delete failed'); return; }
      await loadLs();
    } catch (e: any) { setLsError(e?.message || String(e)); }
    finally { setLsBusy(false); }
  }, [loadLs]);

  // -------------------- dataset create / delete --------------------
  const createDs = useCallback(async () => {
    if (!dsName.trim() || !dsLinkedService) { setDsError('Name and a linked service are required.'); return; }
    setDsBusy(true); setDsError(null);
    try {
      let typeProperties: any = {};
      if (dsTypeProps.trim()) {
        try { typeProperties = JSON.parse(dsTypeProps); }
        catch (e: any) { setDsError(`typeProperties JSON invalid: ${e?.message || e}`); setDsBusy(false); return; }
      }
      const properties = {
        type: dsType,
        linkedServiceName: { referenceName: dsLinkedService, type: 'LinkedServiceReference' as const },
        typeProperties,
      };
      const res = await fetch(DS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: dsName.trim(), properties }),
      });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setDsError(body.error || 'create failed'); return; }
      setDsName(''); setDsTypeProps('{}');
      await loadDs();
    } catch (e: any) { setDsError(e?.message || String(e)); }
    finally { setDsBusy(false); }
  }, [dsName, dsType, dsLinkedService, dsTypeProps, loadDs]);

  const deleteDs = useCallback(async (name: string) => {
    setDsBusy(true); setDsError(null);
    try {
      const res = await fetch(`${DS_ROUTE}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setDsError(body.error || 'delete failed'); return; }
      await loadDs();
    } catch (e: any) { setDsError(e?.message || String(e)); }
    finally { setDsBusy(false); }
  }, [loadDs]);

  // -------------------- IR create / delete / lifecycle --------------------
  const createIr = useCallback(async () => {
    if (!irName.trim()) return;
    setIrBusy(true); setIrError(null);
    try {
      const properties = irType === 'Managed'
        ? { type: 'Managed' as const, typeProperties: { computeProperties: { location: 'AutoResolve' } } }
        : { type: 'SelfHosted' as const, typeProperties: {} };
      const res = await fetch(IR_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: irName.trim(), properties }),
      });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setIrError(body.error || 'create failed'); return; }
      setIrName('');
      await loadIr();
    } catch (e: any) { setIrError(e?.message || String(e)); }
    finally { setIrBusy(false); }
  }, [irName, irType, loadIr]);

  const irLifecycle = useCallback(async (name: string, action: 'start' | 'stop') => {
    setIrBusy(true); setIrError(null);
    try {
      const res = await fetch(IR_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, action }),
      });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setIrError(body.error || `${action} failed`); return; }
      await loadIr();
    } catch (e: any) { setIrError(e?.message || String(e)); }
    finally { setIrBusy(false); }
  }, [loadIr]);

  const deleteIr = useCallback(async (name: string) => {
    setIrBusy(true); setIrError(null);
    try {
      const res = await fetch(`${IR_ROUTE}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) return;
      if (!body.ok) { setIrError(body.error || 'delete failed'); return; }
      await loadIr();
    } catch (e: any) { setIrError(e?.message || String(e)); }
    finally { setIrBusy(false); }
  }, [loadIr]);

  const gateBar = gate && (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>{backendLabel} not configured</MessageBarTitle>
        Set <code>{gate.missing}</code> so the Loom console can reach a real {backendLabel}. The Manage
        surface stays here; resources appear once the {backend === 'adf' ? 'factory' : 'workspace'} is reachable.
      </MessageBarBody>
    </MessageBar>
  );

  const stateColor = (st?: string): 'success' | 'warning' | 'informative' | 'danger' => {
    if (!st) return 'informative';
    if (['Started', 'Online'].includes(st)) return 'success';
    if (['Starting', 'Stopping', 'Limited', 'NeedRegistration'].includes(st)) return 'warning';
    if (['Offline', 'AccessDenied'].includes(st)) return 'danger';
    return 'informative';
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '920px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>Manage — {backendLabel} resources</DialogTitle>
          <DialogContent>
            <Caption1 style={{ display: 'block', marginBottom: 8, color: tokens.colorNeutralForeground3 }}>
              {backend === 'adf' ? 'Factory-level' : 'Workspace-level'} resources your pipeline activities
              reference. Every action below hits real{' '}
              {backend === 'adf' ? 'Azure Data Factory REST (api-version 2018-06-01).' : 'Synapse workspace dev REST.'}
            </Caption1>

            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as ManageTab)}
              style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginBottom: 12 }}>
              <Tab value="linked-services">Linked services</Tab>
              <Tab value="datasets">Datasets</Tab>
              {showIr && <Tab value="integration-runtimes">Integration runtimes</Tab>}
            </TabList>

            {gateBar}

            {/* ---------------- Linked services ---------------- */}
            {tab === 'linked-services' && !gate && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Subtitle2>Linked services ({lsList.length})</Subtitle2>
                  <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadLs} disabled={lsLoading}>Refresh</Button>
                  {lsLoading && <Spinner size="tiny" />}
                </div>
                <div style={{ overflow: 'auto', maxHeight: 200, marginBottom: 12 }}>
                  <Table size="small" aria-label="Linked services">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {lsList.length === 0 && <TableRow><TableCell colSpan={3}><Caption1>{lsLoading ? 'Loading…' : 'No linked services.'}</Caption1></TableCell></TableRow>}
                      {lsList.map((l) => (
                        <TableRow key={l.name}>
                          <TableCell><strong>{l.name}</strong></TableCell>
                          <TableCell><code>{l.properties?.type || l.type || '—'}</code></TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={lsBusy} onClick={() => deleteLs(l.name)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>New linked service</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                  <Field label="Name"><Input value={lsName} onChange={(_, d) => setLsName(d.value)} placeholder="blob_landing" /></Field>
                  <Field label="Type">
                    <Dropdown value={LS_TYPES.find((t) => t.value === lsType)?.label} selectedOptions={[lsType]}
                      onOptionSelect={(_, d) => setLsType(d.optionValue || 'AzureBlobStorage')}>
                      {LS_TYPES.map((t) => <Option key={t.value} value={t.value} text={t.label}>{t.label}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                {lsType === '__advanced__' ? (
                  <Field label="typeProperties JSON (full properties object incl. type)" style={{ marginTop: 8 }}>
                    <Textarea value={lsAdvanced} onChange={(_, d) => setLsAdvanced(d.value)} rows={6}
                      style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }} />
                  </Field>
                ) : (
                  <Field label="Connection string" style={{ marginTop: 8 }}
                    hint={lsType === 'AzureSqlDatabase' ? 'Server=tcp:...;Database=...;' : 'DefaultEndpointsProtocol=https;AccountName=...;'}>
                    <Input value={lsConn} onChange={(_, d) => setLsConn(d.value)} placeholder="connection string" />
                  </Field>
                )}
                <div style={{ marginTop: 8 }}>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={lsBusy || !lsName.trim()} onClick={createLs}>
                    {lsBusy ? 'Saving…' : 'Create linked service'}
                  </Button>
                </div>
                {lsError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Linked service error</MessageBarTitle>{lsError}</MessageBarBody></MessageBar>}
              </>
            )}

            {/* ---------------- Datasets ---------------- */}
            {tab === 'datasets' && !gate && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Subtitle2>Datasets ({dsList.length})</Subtitle2>
                  <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadDs} disabled={dsLoading}>Refresh</Button>
                  {dsLoading && <Spinner size="tiny" />}
                </div>
                <div style={{ overflow: 'auto', maxHeight: 200, marginBottom: 12 }}>
                  <Table size="small" aria-label="Datasets">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Linked service</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {dsList.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>{dsLoading ? 'Loading…' : 'No datasets.'}</Caption1></TableCell></TableRow>}
                      {dsList.map((d) => (
                        <TableRow key={d.name}>
                          <TableCell><strong>{d.name}</strong></TableCell>
                          <TableCell><code>{d.properties?.type || d.type || '—'}</code></TableCell>
                          <TableCell>{d.properties?.linkedServiceName?.referenceName || '—'}</TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={dsBusy} onClick={() => deleteDs(d.name)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>New dataset</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 8 }}>
                  <Field label="Name"><Input value={dsName} onChange={(_, d) => setDsName(d.value)} placeholder="orders_csv" /></Field>
                  <Field label="Type">
                    <Dropdown value={dsType} selectedOptions={[dsType]} onOptionSelect={(_, d) => setDsType(d.optionValue || 'DelimitedText')}>
                      {DS_TYPES.map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Linked service">
                    <Dropdown placeholder={lsList.length ? 'Select' : 'No linked services'} value={dsLinkedService}
                      selectedOptions={dsLinkedService ? [dsLinkedService] : []}
                      onOptionSelect={(_, d) => setDsLinkedService(d.optionValue || '')} disabled={!lsList.length}>
                      {lsList.map((l) => <Option key={l.name} value={l.name} text={l.name}>{l.name}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Field label="typeProperties JSON (location/format, optional)" style={{ marginTop: 8 }}>
                  <Textarea value={dsTypeProps} onChange={(_, d) => setDsTypeProps(d.value)} rows={4}
                    style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
                    placeholder='{ "location": { "type": "AzureBlobStorageLocation", "container": "raw" } }' />
                </Field>
                <div style={{ marginTop: 8 }}>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={dsBusy || !dsName.trim() || !dsLinkedService} onClick={createDs}>
                    {dsBusy ? 'Saving…' : 'Create dataset'}
                  </Button>
                </div>
                {dsError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Dataset error</MessageBarTitle>{dsError}</MessageBarBody></MessageBar>}
              </>
            )}

            {/* ---------------- Integration runtimes ---------------- */}
            {tab === 'integration-runtimes' && !gate && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Subtitle2>Integration runtimes ({irList.length})</Subtitle2>
                  <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadIr} disabled={irLoading}>Refresh</Button>
                  {irLoading && <Spinner size="tiny" />}
                </div>
                <div style={{ overflow: 'auto', maxHeight: 220, marginBottom: 12 }}>
                  <Table size="small" aria-label="Integration runtimes">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {irList.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>{irLoading ? 'Loading…' : 'No integration runtimes.'}</Caption1></TableCell></TableRow>}
                      {irList.map((r) => {
                        const isSelfHosted = r.type === 'SelfHosted';
                        return (
                          <TableRow key={r.name}>
                            <TableCell><strong>{r.name}</strong></TableCell>
                            <TableCell><code>{r.type || '—'}</code></TableCell>
                            <TableCell><Badge appearance="filled" color={stateColor(r.state)}>{r.state || '—'}</Badge></TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <Button size="small" icon={<Play20Regular />} disabled={irBusy || !isSelfHosted} title={isSelfHosted ? 'Start node set' : 'Start only applies to Self-Hosted IRs'} onClick={() => irLifecycle(r.name, 'start')}>Start</Button>
                                <Button size="small" icon={<Stop20Regular />} disabled={irBusy || !isSelfHosted} title={isSelfHosted ? 'Stop node set' : 'Stop only applies to Self-Hosted IRs'} onClick={() => irLifecycle(r.name, 'stop')}>Stop</Button>
                                <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={irBusy || r.name === 'AutoResolveIntegrationRuntime'} title={r.name === 'AutoResolveIntegrationRuntime' ? 'The default Azure IR cannot be deleted' : undefined} onClick={() => deleteIr(r.name)}>Delete</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <Subtitle2>New integration runtime</Subtitle2>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginTop: 8 }}>
                  <Field label="Name"><Input value={irName} onChange={(_, d) => setIrName(d.value)} placeholder="selfhosted-onprem" /></Field>
                  <Field label="Type">
                    <Dropdown value={irType} selectedOptions={[irType]} onOptionSelect={(_, d) => setIrType((d.optionValue as 'Managed' | 'SelfHosted') || 'SelfHosted')}>
                      <Option value="SelfHosted" text="SelfHosted">SelfHosted (on-prem / VM gateway)</Option>
                      <Option value="Managed" text="Managed">Managed (Azure-hosted)</Option>
                    </Dropdown>
                  </Field>
                </div>
                <Caption1 style={{ display: 'block', marginTop: 4, color: tokens.colorNeutralForeground3 }}>
                  Self-Hosted IRs are created in a NeedRegistration state — install the gateway on a node and
                  register it with the auth key. Start/Stop control the node set once registered.
                </Caption1>
                <div style={{ marginTop: 8 }}>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={irBusy || !irName.trim()} onClick={createIr}>
                    {irBusy ? 'Saving…' : 'Create integration runtime'}
                  </Button>
                </div>
                {irError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Integration runtime error</MessageBarTitle>{irError}</MessageBarBody></MessageBar>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
