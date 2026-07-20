'use client';

/**
 * Model Serving endpoint editor (WS-1.2) — a first-class serving surface over
 * Azure ML managed online endpoints (Azure-native DEFAULT) or Databricks Mosaic
 * AI Model Serving (opt-in via LOOM_MODEL_SERVING_BACKEND=databricks). One-for-
 * one with the Azure ML "Endpoints" / Databricks "Serving" experience, Loom-
 * themed:
 *   - Overview      — backend badge, live endpoint list, bind/select, state.
 *   - Deployments   — create endpoint (model + version + compute + autoscale +
 *                     scale-to-zero), deployments table, blue/green TRAFFIC SPLIT.
 *   - Invoke        — scoring console: real POST to the endpoint, response +
 *                     measured round-trip latency.
 *   - Monitoring    — live latency / requests / error tiles from real Azure
 *                     Monitor metrics (AML) — honest note on the Databricks path.
 *
 * Every control calls the real BFF (no mocks). When no serving backend is
 * configured the surface still renders and shows the shared HonestGate with an
 * inline "Fix it" wizard (gate svc-model-serving) — no dead buttons, no red
 * banner on a freshly created item (ux-baseline G1/G2).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Switch,
  Tab, TabList, Field, Dropdown, Option, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular, Rocket20Regular, Play20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { MetricChart } from '@/lib/components/monitor/metric-chart';
import { DetailsPanel, type DetailsSection } from '@/lib/components/shared/details-panel';
import { useSharedEditorStyles } from './shared-styles';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useLocalStyles = makeStyles({
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  tileRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  tile: {
    flex: '1 1 160px', minWidth: 0, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
  tileVal: { fontSize: '26px', fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.1 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0, rowGap: tokens.spacingVerticalXXS },
  form: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  mono: {
    width: '100%', minHeight: '140px', maxWidth: '100%', boxSizing: 'border-box',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300,
  },
  result: {
    whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: '320px', padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
  },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

// ── shapes mirroring model-serving-client views ──
interface Deployment { name: string; model?: string; instanceType?: string; instanceCount?: number; scaleType?: string; state?: string }
interface Endpoint { name: string; backend: string; state?: string; ready?: boolean; scoringUri?: string; authMode?: string; traffic?: Record<string, number>; deployments?: Deployment[] }
interface ModelLite { name: string; latestVersion?: string }
interface Gate { backend: string; missing: string; hint: string; fixEnvVar: string; gateId: string }
interface MetricSeries { name: string; unit: string; points: Array<{ timeStamp: string; value: number | null }> }
interface Metrics { available: boolean; reason?: string; latency?: MetricSeries; requests?: MetricSeries; errors?: MetricSeries; latencyMsP90?: number | null; requestsPerMin?: number | null; errorsPerMin?: number | null }

function stateColor(s?: string): 'success' | 'warning' | 'danger' | 'informative' {
  if (!s) return 'informative';
  if (/succeed|ready/i.test(s)) return 'success';
  if (/fail/i.test(s)) return 'danger';
  return 'warning';
}

export function ModelServingEndpointEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  if (isNew) {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create model-serving endpoint item"
        intro="Creates a model-serving-endpoint item in your Loom workspace, then opens the editor where you create a real serving endpoint (Azure ML managed online endpoint by default, or Databricks Mosaic serving), split traffic across deployments, invoke it from the console, and watch live latency / error tiles."
      />
    );
  }
  return <ServingBody item={item} id={id} />;
}

function ServingBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const apiBase = `/api/items/model-serving-endpoint/${encodeURIComponent(id)}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('aml');
  const [gate, setGate] = useState<Gate | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelLite[]>([]);
  const [bound, setBound] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'deployments' | 'invoke' | 'monitor'>('overview');

  // Create form
  const [cName, setCName] = useState('');
  const [cModel, setCModel] = useState('');
  const [cVersion, setCVersion] = useState('');
  const [cInstance, setCInstance] = useState('');
  const [cScale, setCScale] = useState<'manual' | 'auto'>('manual');
  const [cCount, setCCount] = useState('1');
  const [cMin, setCMin] = useState('1');
  const [cMax, setCMax] = useState('3');
  const [cScaleZero, setCScaleZero] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Traffic dialog
  const [trafficEp, setTrafficEp] = useState<string | null>(null);
  const [trafficMap, setTrafficMap] = useState<Record<string, number>>({});
  const [trafficBusy, setTrafficBusy] = useState(false);
  const [trafficMsg, setTrafficMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Invoke
  const [invPayload, setInvPayload] = useState('{\n  "input_data": {\n    "columns": [],\n    "data": []\n  }\n}');
  const [invBusy, setInvBusy] = useState(false);
  const [invResult, setInvResult] = useState<{ status: number; latencyMs: number; body: unknown } | null>(null);
  const [invError, setInvError] = useState<string | null>(null);

  // Monitoring
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsBusy, setMetricsBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiBase);
      const j = await res.json();
      if (!j.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setBackend(j.backend || 'aml');
      setGate(j.gate || null);
      setEndpoints(j.endpoints || []);
      setModels(j.models || []);
      setBound(j.binding?.endpointName || null);
      setSelected((prev) => prev || j.binding?.endpointName || j.endpoints?.[0]?.name || null);
      if (!cModel && j.binding?.modelName) setCModel(j.binding.modelName);
      if (!cVersion && j.binding?.modelVersion) setCVersion(j.binding.modelVersion);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [apiBase, cModel, cVersion]);

  useEffect(() => { load(); }, [load]);

  const current = useMemo(() => endpoints.find((e) => e.name === selected) || null, [endpoints, selected]);

  const loadMetrics = useCallback(async (name: string) => {
    setMetricsBusy(true);
    try {
      const res = await fetch(`${apiBase}/metrics?endpoint=${encodeURIComponent(name)}`);
      const j = await res.json();
      setMetrics(j.ok ? j.metrics : { available: false, reason: j.error });
    } catch (e: any) { setMetrics({ available: false, reason: e?.message || String(e) }); }
    finally { setMetricsBusy(false); }
  }, [apiBase]);

  useEffect(() => { if (tab === 'monitor' && selected) loadMetrics(selected); }, [tab, selected, loadMetrics]);

  const createEndpoint = useCallback(async () => {
    setCreating(true); setCreateMsg(null);
    try {
      const res = await fetch(apiBase, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: cName.trim(), modelName: cModel.trim(), modelVersion: cVersion.trim(),
          instanceType: cInstance.trim() || undefined,
          scaleType: cScale, instanceCount: Number(cCount) || 1,
          minInstances: Number(cMin) || 1, maxInstances: Number(cMax) || 3,
          scaleToZero: cScaleZero,
        }),
      });
      const j = await res.json();
      if (!j.ok) { setCreateMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setCreateMsg({ intent: 'success', text: j.message || `Endpoint ${cName} provisioning.` });
      setBound(cName.trim()); setSelected(cName.trim());
      load();
    } catch (e: any) { setCreateMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setCreating(false); }
  }, [apiBase, cName, cModel, cVersion, cInstance, cScale, cCount, cMin, cMax, cScaleZero, load]);

  const openTraffic = useCallback((ep: Endpoint) => {
    const deps = ep.deployments || [];
    const initial: Record<string, number> = {};
    for (const d of deps) initial[d.name] = ep.traffic?.[d.name] ?? 0;
    // Seed an even split when nothing is set yet so the dialog is never empty.
    if (deps.length && Object.values(initial).every((v) => v === 0)) {
      const each = Math.floor(100 / deps.length);
      deps.forEach((d, i) => { initial[d.name] = i === 0 ? 100 - each * (deps.length - 1) : each; });
    }
    setTrafficMap(initial); setTrafficMsg(null); setTrafficEp(ep.name);
  }, []);

  const trafficTotal = useMemo(() => Object.values(trafficMap).reduce((a, b) => a + (Number(b) || 0), 0), [trafficMap]);

  const applyTraffic = useCallback(async () => {
    if (!trafficEp) return;
    setTrafficBusy(true); setTrafficMsg(null);
    try {
      const res = await fetch(`${apiBase}/traffic`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: trafficEp, traffic: trafficMap }),
      });
      const j = await res.json();
      if (!j.ok) { setTrafficMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setTrafficMsg({ intent: 'success', text: 'Traffic split applied.' });
      setTrafficEp(null); load();
    } catch (e: any) { setTrafficMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setTrafficBusy(false); }
  }, [apiBase, trafficEp, trafficMap, load]);

  const invoke = useCallback(async () => {
    if (!selected) return;
    setInvBusy(true); setInvError(null); setInvResult(null);
    try {
      const res = await fetch(`${apiBase}/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: selected, payload: invPayload }),
      });
      const j = await res.json();
      if (!j.ok && j.error) { setInvError(j.error); return; }
      setInvResult({ status: j.status, latencyMs: j.latencyMs, body: j.result });
    } catch (e: any) { setInvError(e?.message || String(e)); }
    finally { setInvBusy(false); }
  }, [apiBase, selected, invPayload]);

  const deleteEndpoint = useCallback(async (name: string) => {
    try {
      const res = await fetch(`${apiBase}?endpoint=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await res.json();
      if (j.ok) { if (bound === name) setBound(null); load(); }
    } catch { /* surfaced on reload */ }
  }, [apiBase, bound, load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Endpoint', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
        { label: 'New endpoint', onClick: gate ? undefined : () => setTab('deployments'), disabled: !!gate },
      ]},
      { label: 'Operate', actions: [
        { label: 'Split traffic', onClick: current ? () => openTraffic(current) : undefined, disabled: !current },
        { label: 'Invoke', onClick: selected ? () => setTab('invoke') : undefined, disabled: !selected },
        { label: 'Monitor', onClick: selected ? () => setTab('monitor') : undefined, disabled: !selected },
      ]},
    ]},
  ], [loading, load, gate, current, selected, openTraffic]);

  const detailsPanel = useMemo(() => {
    if (!current) return undefined;
    const sections: DetailsSection[] = [{
      key: 'ep', title: 'Endpoint',
      stats: [
        { key: 'name', label: 'Name', value: current.name },
        { key: 'backend', label: 'Backend', value: backend === 'databricks' ? 'Databricks Mosaic' : 'Azure ML online endpoint' },
        { key: 'state', label: 'State', value: current.state || '—' },
        { key: 'auth', label: 'Auth', value: current.authMode || '—' },
      ],
      uris: current.scoringUri ? [{ key: 'uri', label: 'Scoring URI', value: current.scoringUri }] : undefined,
    }];
    return <DetailsPanel title="Serving details" subtitle={current.name} sections={sections} />;
  }, [current, backend]);

  return (
    <ItemEditorChrome
      splitKeyPrefix={item.slug}
      item={item}
      id={id}
      ribbon={ribbon}
      rightPanel={detailsPanel}
      rightPanelLabel="Details"
      leftPanel={
        <div style={{ padding: tokens.spacingVerticalS }}>
          <Caption1 style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, color: tokens.colorNeutralForeground3 }}>
            Endpoints ({endpoints.length})
          </Caption1>
          {endpoints.length === 0 && !loading && (
            <Body1 style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
              {gate ? 'Backend not configured.' : 'No serving endpoints yet — create one on the Deployments tab.'}
            </Body1>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
            {endpoints.map((ep) => (
              <button
                key={ep.name}
                onClick={() => setSelected(ep.name)}
                style={{
                  textAlign: 'left', cursor: 'pointer', border: 'none', borderRadius: tokens.borderRadiusMedium,
                  padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
                  background: ep.name === selected ? tokens.colorNeutralBackground2 : 'transparent',
                }}
              >
                <div className={s.badges}>
                  <Body1 style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{ep.name}</Body1>
                  {ep.name === bound && <Badge appearance="tint" color="brand" size="small">bound</Badge>}
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{ep.state || '—'}</Caption1>
              </button>
            ))}
          </div>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading serving endpoints…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>
          )}

          {/* Honest gate (G2) — full surface still renders; inline Fix-it wizard. */}
          {gate && (
            <HonestGate
              gateId={gate.gateId}
              surface="Model serving"
              missing={gate.missing}
              detail={gate.hint}
              onResolved={load}
            />
          )}

          {!loading && (
            <>
              <div className={s.badges}>
                <Badge appearance="filled" color="brand">{backend === 'databricks' ? 'Databricks Mosaic serving' : 'Azure ML online endpoints'}</Badge>
                <Badge appearance="outline">{backend === 'databricks' ? 'opt-in backend' : 'Azure-native default'}</Badge>
                {current && <Badge appearance="tint" color={stateColor(current.state)}>{current.state || 'unknown'}</Badge>}
              </div>

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
                <Tab value="overview">Overview</Tab>
                <Tab value="deployments">Deployments &amp; traffic</Tab>
                <Tab value="invoke">Invoke</Tab>
                <Tab value="monitor">Monitoring</Tab>
              </TabList>

              {/* ── Overview ── */}
              {tab === 'overview' && (
                <div className={s.card}>
                  <Subtitle2>Serving endpoints</Subtitle2>
                  {endpoints.length === 0 ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                      {gate ? 'Configure a serving backend to list endpoints.' : 'No endpoints yet. Create one on the Deployments & traffic tab.'}
                    </Body1>
                  ) : (
                    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                      <Table aria-label="Serving endpoints" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Name</TableHeaderCell>
                          <TableHeaderCell>State</TableHeaderCell>
                          <TableHeaderCell>Deployments</TableHeaderCell>
                          <TableHeaderCell>Traffic</TableHeaderCell>
                          <TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {endpoints.map((ep) => {
                            const traffic = ep.traffic && Object.keys(ep.traffic).length
                              ? Object.entries(ep.traffic).map(([d, p]) => `${d}:${p}%`).join(' / ') : '—';
                            return (
                              <TableRow key={ep.name} onClick={() => setSelected(ep.name)} style={{ cursor: 'pointer', background: ep.name === selected ? tokens.colorNeutralBackground2 : undefined }}>
                                <TableCell><strong>{ep.name}</strong></TableCell>
                                <TableCell><Badge appearance="tint" color={stateColor(ep.state)}>{ep.state || '—'}</Badge></TableCell>
                                <TableCell>{ep.deployments?.length ?? 0}</TableCell>
                                <TableCell>{traffic}</TableCell>
                                <TableCell>
                                  <div className={s.badges}>
                                    <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); openTraffic(ep); }}>Traffic</Button>
                                    <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); deleteEndpoint(ep.name); }}>Delete</Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}

              {/* ── Deployments & traffic ── */}
              {tab === 'deployments' && (
                <>
                  <div className={s.card}>
                    <Subtitle2>Create a serving endpoint</Subtitle2>
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Deploys a registered model version behind an HTTPS endpoint on {backend === 'databricks' ? 'Databricks Mosaic serving' : 'Azure ML managed online compute'}, routing 100% traffic to the first (&quot;blue&quot;) deployment. Add a second deployment later and split traffic to canary a new version.
                    </Body1>
                    <div className={s.form}>
                      <Field label="Endpoint name" required>
                        <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="e.g. fraud-scorer" disabled={!!gate} />
                      </Field>
                      <Field label="Registered model" required>
                        {models.length ? (
                          <Dropdown placeholder="Select a model" value={cModel} selectedOptions={cModel ? [cModel] : []}
                            onOptionSelect={(_, d) => { setCModel(d.optionValue || ''); const m = models.find((x) => x.name === d.optionValue); if (m?.latestVersion) setCVersion(m.latestVersion); }}
                            disabled={!!gate}>
                            {models.map((m) => <Option key={m.name} value={m.name}>{`${m.name}${m.latestVersion ? ` (v${m.latestVersion})` : ''}`}</Option>)}
                          </Dropdown>
                        ) : (
                          <Input value={cModel} onChange={(_, d) => setCModel(d.value)} placeholder="registered model name" disabled={!!gate} />
                        )}
                      </Field>
                      <Field label="Version" required>
                        <Input value={cVersion} onChange={(_, d) => setCVersion(d.value)} placeholder="1" style={{ width: 96 }} disabled={!!gate} />
                      </Field>
                      <Field label={backend === 'databricks' ? 'Workload size' : 'Instance type'}>
                        <Input value={cInstance} onChange={(_, d) => setCInstance(d.value)} placeholder={backend === 'databricks' ? 'Small' : 'Standard_DS3_v2'} disabled={!!gate} />
                      </Field>
                      <Field label="Scaling">
                        <Dropdown value={cScale === 'auto' ? 'Autoscale' : 'Manual'} selectedOptions={[cScale]}
                          onOptionSelect={(_, d) => setCScale((d.optionValue as any) || 'manual')} disabled={!!gate}>
                          <Option value="manual">Manual</Option>
                          <Option value="auto">Autoscale</Option>
                        </Dropdown>
                      </Field>
                      {cScale === 'manual' ? (
                        <Field label="Instances">
                          <Input type="number" value={cCount} onChange={(_, d) => setCCount(d.value)} style={{ width: 88 }} disabled={!!gate} />
                        </Field>
                      ) : (
                        <>
                          <Field label="Min instances">
                            <Input type="number" value={cMin} onChange={(_, d) => setCMin(d.value)} style={{ width: 88 }} disabled={!!gate} />
                          </Field>
                          <Field label="Max instances">
                            <Input type="number" value={cMax} onChange={(_, d) => setCMax(d.value)} style={{ width: 88 }} disabled={!!gate} />
                          </Field>
                        </>
                      )}
                      {backend === 'databricks' && (
                        <Switch label="Scale to zero when idle" checked={cScaleZero} onChange={(_, d) => setCScaleZero(!!d.checked)} disabled={!!gate} />
                      )}
                      <Button appearance="primary" icon={<Rocket20Regular />} disabled={creating || !!gate || !cName.trim() || !cModel.trim() || !cVersion.trim()} onClick={createEndpoint}>
                        {creating ? 'Deploying…' : 'Create endpoint'}
                      </Button>
                    </div>
                    {createMsg && <MessageBar intent={createMsg.intent}><MessageBarBody>{createMsg.text}</MessageBarBody></MessageBar>}
                  </div>

                  {current && (
                    <div className={s.card}>
                      <div className={s.badges}>
                        <Subtitle2>Deployments — {current.name}</Subtitle2>
                        <Button size="small" appearance="primary" onClick={() => openTraffic(current)} disabled={!current.deployments?.length}>Split traffic</Button>
                      </div>
                      {(current.deployments?.length ?? 0) === 0 ? (
                        <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No deployments yet — the endpoint may still be provisioning.</Body1>
                      ) : (
                        <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                          <Table aria-label="Deployments" size="small">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Deployment</TableHeaderCell>
                              <TableHeaderCell>Model</TableHeaderCell>
                              <TableHeaderCell>Compute</TableHeaderCell>
                              <TableHeaderCell>Scale</TableHeaderCell>
                              <TableHeaderCell>Traffic</TableHeaderCell>
                              <TableHeaderCell>State</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {current.deployments!.map((d) => (
                                <TableRow key={d.name}>
                                  <TableCell><strong>{d.name}</strong></TableCell>
                                  <TableCell style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{d.model || '—'}</TableCell>
                                  <TableCell>{d.instanceType || '—'}{d.instanceCount != null ? ` ×${d.instanceCount}` : ''}</TableCell>
                                  <TableCell>{d.scaleType || '—'}</TableCell>
                                  <TableCell>{current.traffic?.[d.name] != null ? `${current.traffic[d.name]}%` : '—'}</TableCell>
                                  <TableCell><Badge appearance="tint" color={stateColor(d.state)}>{d.state || '—'}</Badge></TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── Invoke console ── */}
              {tab === 'invoke' && (
                <div className={s.card}>
                  <Subtitle2>Invoke {selected ? `— ${selected}` : ''}</Subtitle2>
                  {!selected ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>Select an endpoint to invoke.</Body1>
                  ) : (
                    <>
                      <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Sends a real scoring request to <code>{selected}</code> and measures the round-trip latency. Edit the JSON body to match your model&apos;s signature.
                      </Body1>
                      <Textarea className={s.mono} value={invPayload} onChange={(_, d) => setInvPayload(d.value)} resize="vertical" />
                      <div className={s.badges}>
                        <Button appearance="primary" icon={<Play20Regular />} disabled={invBusy} onClick={invoke}>{invBusy ? 'Scoring…' : 'Invoke'}</Button>
                        {invResult && <Badge appearance="tint" color={invResult.status < 400 ? 'success' : 'danger'}>HTTP {invResult.status}</Badge>}
                        {invResult && <Badge appearance="tint" color="brand">{invResult.latencyMs} ms</Badge>}
                      </div>
                      {invError && <MessageBar intent="error"><MessageBarBody>{invError}</MessageBarBody></MessageBar>}
                      {invResult && (
                        <div className={s.result}>{typeof invResult.body === 'string' ? invResult.body : JSON.stringify(invResult.body, null, 2)}</div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ── Monitoring ── */}
              {tab === 'monitor' && (
                <div className={s.card}>
                  <div className={s.badges}>
                    <Subtitle2>Monitoring {selected ? `— ${selected}` : ''}</Subtitle2>
                    <Button size="small" appearance="subtle" icon={<ArrowClockwise20Regular />} disabled={!selected || metricsBusy} onClick={() => selected && loadMetrics(selected)}>Refresh</Button>
                  </div>
                  {!selected ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>Select an endpoint to see live metrics.</Body1>
                  ) : metricsBusy && !metrics ? (
                    <Spinner size="small" label="Reading Azure Monitor metrics…" labelPosition="after" />
                  ) : metrics && !metrics.available ? (
                    <MessageBar intent="info" layout="multiline"><MessageBarBody><MessageBarTitle>Endpoint-level charts unavailable on this backend</MessageBarTitle>{metrics.reason}</MessageBarBody></MessageBar>
                  ) : metrics ? (
                    <>
                      <div className={s.tileRow}>
                        <div className={s.tile}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Request latency (avg)</Caption1>
                          <span className={s.tileVal}>{metrics.latencyMsP90 != null ? `${Math.round(metrics.latencyMsP90)} ms` : '—'}</span>
                        </div>
                        <div className={s.tile}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Requests / min</Caption1>
                          <span className={s.tileVal}>{metrics.requestsPerMin != null ? Math.round(metrics.requestsPerMin) : '—'}</span>
                        </div>
                        <div className={s.tile}>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>5xx errors / min</Caption1>
                          <span className={s.tileVal} style={{ color: (metrics.errorsPerMin ?? 0) > 0 ? tokens.colorPaletteRedForeground1 : undefined }}>
                            {metrics.errorsPerMin != null ? Math.round(metrics.errorsPerMin) : '0'}
                          </span>
                        </div>
                      </div>
                      <div className={s.tileRow}>
                        {metrics.latency && <MetricChart title="Request latency" unit="ms" points={metrics.latency.points} />}
                        {metrics.requests && <MetricChart title="Requests per minute" unit="count" points={metrics.requests.points} />}
                        {metrics.errors && <MetricChart title="5xx errors per minute" unit="count" points={metrics.errors.points} />}
                      </div>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Live from Azure Monitor — Microsoft.MachineLearningServices/workspaces/onlineEndpoints (RequestLatency, RequestsPerMinute).
                      </Caption1>
                    </>
                  ) : (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No metrics yet.</Body1>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Traffic split dialog ── */}
          <Dialog open={!!trafficEp} onOpenChange={(_, d) => { if (!d.open) setTrafficEp(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Split traffic — {trafficEp}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Caption1>Set the percentage of scoring traffic each deployment receives. Percentages must total 100%. Applied via a real backend update (blue/green canary).</Caption1>
                    {Object.keys(trafficMap).length === 0 && <Body1 style={{ color: tokens.colorNeutralForeground3 }}>This endpoint has no deployments to route.</Body1>}
                    {Object.keys(trafficMap).map((dep) => (
                      <Field key={dep} label={`${dep} — ${trafficMap[dep]}%`}>
                        <input type="range" min={0} max={100} step={5} value={trafficMap[dep]}
                          onChange={(e) => setTrafficMap((m) => ({ ...m, [dep]: Number(e.target.value) }))} />
                      </Field>
                    ))}
                    <Badge appearance="tint" color={trafficTotal === 100 ? 'success' : 'warning'}>Total: {trafficTotal}%</Badge>
                    {trafficMsg && <MessageBar intent={trafficMsg.intent}><MessageBarBody>{trafficMsg.text}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setTrafficEp(null)}>Cancel</Button>
                  <Button appearance="primary" disabled={trafficBusy || trafficTotal !== 100 || !Object.keys(trafficMap).length} onClick={applyTraffic}>
                    {trafficBusy ? 'Applying…' : 'Apply split'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
