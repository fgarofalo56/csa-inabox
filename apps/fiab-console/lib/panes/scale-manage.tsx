'use client';

/**
 * ScaleManageDrawer — Admin → Capacity & compute per-resource detail pane.
 *
 * Opens from a row click in the Azure-resource inventory grid. Renders a
 * resource-appropriate scale/manage surface wired to the real ARM scaling
 * routes under /api/admin/scaling/* — the same engines the summary card-grid
 * (ScaleManagePanel) uses, but scoped to the clicked resource with the full
 * control set Azure's portal exposes:
 *
 *   Microsoft.Kusto/clusters              → SKU dropdown + capacity SpinButton
 *   Microsoft.Synapse/workspaces          → per-pool DWU dropdown + Pause / Resume
 *   Microsoft.Databricks/workspaces       → cluster resize + SQL warehouse resize
 *   Microsoft.Compute/virtualMachineScaleSets → Start (4) / Stop (0)
 *   Microsoft.App/containerApps           → min/max replica SpinButtons
 *   Microsoft.ContainerService/managedClusters → node-pool count SpinButton
 *   Microsoft.Search/searchServices       → replica + partition SpinButtons
 *   Microsoft.ApiManagement/service       → SKU dropdown + capacity SpinButton
 *   Microsoft.DocumentDB/databaseAccounts → per-container RU/s SpinButton
 *
 * Every control hits the real backend. A 403/503 from any route renders an
 * honest Fluent MessageBar (intent="warning") naming the missing role / env —
 * never a blank pane or fake data (per no-vaporware.md). Destructive actions go
 * through a confirm Dialog; after a successful POST the pane polls the GET route
 * every 2s and updates the live provisioning-state Badge.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Dialog, DialogSurface, DialogTitle, DialogContent, DialogBody, DialogActions, DialogTrigger,
  Button, Spinner, Badge, Select, SpinButton, Field, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  Caption1, Body1, Subtitle2,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, ArrowSync16Regular, ArrowUp16Regular,
  Play16Regular, Pause16Regular,
} from '@fluentui/react-icons';

export interface AzureRes {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  sku?: string;
  kind?: string;
  provisioningState?: string;
}

export interface ScaleManageDrawerProps {
  resource: AzureRes | null;
  onClose: () => void;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalS },
  meta: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  type: { fontFamily: 'Consolas, monospace', fontSize: '12px', color: tokens.colorNeutralForeground3 },
  controls: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  sub: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  grow: { flex: 1, minWidth: '180px' },
});

const ADX_SKUS = [
  'Dev(No SLA)_Standard_E2a_v4',
  'Standard_E2ads_v5', 'Standard_E4ads_v5', 'Standard_E8ads_v5', 'Standard_E16ads_v5',
  'Standard_L8as_v3', 'Standard_L16as_v3',
];
const DWU_OPTIONS = [
  'DW100c', 'DW200c', 'DW300c', 'DW400c', 'DW500c', 'DW1000c', 'DW1500c',
  'DW2000c', 'DW2500c', 'DW3000c', 'DW5000c', 'DW6000c', 'DW7500c',
  'DW10000c', 'DW15000c', 'DW30000c',
];
const APIM_SKUS = ['Developer', 'Basic', 'Standard', 'Premium', 'BasicV2', 'StandardV2', 'PremiumV2', 'Consumption'];
const DBX_SIZES = ['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large'];

function stateColor(s?: string): 'success' | 'warning' | 'danger' | 'informative' {
  const v = (s || '').toLowerCase();
  if (/running|online|available|succeeded|ready/.test(v)) return 'success';
  if (/start|resum|scal|updat|pend|provision|creating|deleting/.test(v)) return 'warning';
  if (/paus|stop|offline|fail|error/.test(v)) return 'danger';
  return 'informative';
}

/** Classify an ARM type into the scaling section it maps to. */
type Section =
  | 'adx' | 'synapse' | 'databricks' | 'vmss' | 'container-app'
  | 'aks' | 'ai-search' | 'apim' | 'cosmos' | 'unsupported';

function classify(type: string): Section {
  const t = (type || '').toLowerCase();
  if (t.includes('kusto/clusters')) return 'adx';
  if (t.includes('synapse/workspaces')) return 'synapse';
  if (t.includes('databricks/workspaces')) return 'databricks';
  if (t.includes('compute/virtualmachinescalesets')) return 'vmss';
  if (t.includes('app/containerapps')) return 'container-app';
  if (t.includes('containerservice/managedclusters')) return 'aks';
  if (t.includes('search/searchservices')) return 'ai-search';
  if (t.includes('apimanagement/service')) return 'apim';
  if (t.includes('documentdb/databaseaccounts')) return 'cosmos';
  return 'unsupported';
}

/** Confirm dialog gating every live mutation. */
function ConfirmScaleDialog({
  open, resourceName, action, onConfirm, onCancel,
}: {
  open: boolean; resourceName: string; action: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Confirm scale operation</DialogTitle>
          <DialogContent>
            <Body1>
              {action} on <strong>{resourceName}</strong>? This modifies live Azure
              infrastructure and may take several minutes to apply.
            </Body1>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={onCancel}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" onClick={onConfirm}>Confirm</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Result MessageBar shown after a POST. */
function ResultBar({ result }: { result: { ok: boolean; text: string; hint?: string } | null }) {
  if (!result) return null;
  return (
    <MessageBar intent={result.ok ? 'success' : 'warning'}>
      {!result.ok && <MessageBarTitle>Action could not complete</MessageBarTitle>}
      <MessageBarBody>{result.text}{result.hint ? ` — ${result.hint}` : ''}</MessageBarBody>
    </MessageBar>
  );
}

/**
 * Poll a GET route every 2s, surfacing the live provisioning state until it
 * settles (Succeeded / Online / Running) or 45 ticks (~90s) elapse.
 */
function usePoll() {
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => { if (ref.current) { clearInterval(ref.current); ref.current = null; } }, []);
  const start = useCallback((getState: () => Promise<string | undefined>, onTick: (s?: string) => void) => {
    stop();
    let ticks = 0;
    ref.current = setInterval(async () => {
      ticks++;
      let s: string | undefined;
      try { s = await getState(); } catch { /* transient — keep polling */ }
      onTick(s);
      if ((s && /^(succeeded|online|running)$/i.test(s)) || ticks > 45) stop();
    }, 2000);
  }, [stop]);
  useEffect(() => () => stop(), [stop]);
  return { start, stop };
}

/** Generic JSON helpers. */
async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { cache: 'no-store' });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function postJson(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ────────────────────────────────────────────────────────────────────────
// ADX cluster section
// ────────────────────────────────────────────────────────────────────────
function AdxSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [sku, setSku] = useState('');
  const [capacity, setCapacity] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/adx');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    setSku(json.cluster?.sku?.name || ADX_SKUS[0]);
    setCapacity(json.cluster?.sku?.capacity ?? 1);
    onState(json.cluster?.state || json.cluster?.provisioningState);
    setLoading(false);
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async () => {
    setConfirm(false); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/adx', { sku, capacity });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})`, hint: json.hint }); return; }
    setResult({ ok: true, text: `Scaling to ${sku}. Provisioning ${json.cluster?.provisioningState || 'Updating'}…` });
    onState(json.cluster?.provisioningState || 'Updating');
    poll.start(
      async () => (await getJson('/api/admin/scaling/adx')).json?.cluster?.state,
      onState,
    );
  }, [sku, capacity, onState, poll]);

  if (loading) return <Spinner size="tiny" label="Reading ADX cluster…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;

  return (
    <div className={s.sub}>
      <Subtitle2>Cluster SKU</Subtitle2>
      <div className={s.controls}>
        <Field label="SKU" className={s.grow}>
          <Select value={sku} onChange={(_, d) => setSku(d.value)} disabled={busy}>
            {ADX_SKUS.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
        <Field label="Capacity (instances)">
          <SpinButton value={capacity} min={1} max={1000} step={1} disabled={busy}
            onChange={(_, d) => setCapacity(Math.max(1, Math.min(1000, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : capacity)) || 1)))} />
        </Field>
        <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy} onClick={() => setConfirm(true)}>
          {busy ? 'Scaling…' : 'Apply SKU'}
        </Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={confirm} resourceName={resource.name} action={`Scale to ${sku} (capacity ${capacity})`} onConfirm={apply} onCancel={() => setConfirm(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Synapse dedicated SQL pool section
// ────────────────────────────────────────────────────────────────────────
interface SynPool { name: string; sku?: { name?: string }; status?: string; state?: string }
function SynapseSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [pools, setPools] = useState<SynPool[]>([]);
  const [pool, setPool] = useState('');
  const [dwu, setDwu] = useState('DW500c');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ action: string; run: () => void } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/synapse-dwu');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    const list: SynPool[] = json.pools || [];
    setPools(list);
    if (list.length) {
      setPool((p) => p || list[0].name);
      const cur = list.find((x) => x.name === (pool || list[0].name));
      if (cur?.sku?.name && /^DW\d+c$/i.test(cur.sku.name)) setDwu(cur.sku.name);
      onState(cur?.status || cur?.state);
    } else {
      onState('No dedicated SQL pools');
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const poolState = useCallback(async (): Promise<string | undefined> => {
    const { json } = await getJson('/api/admin/scaling/synapse-dwu');
    const cur = (json.pools || []).find((x: SynPool) => x.name === pool);
    return cur?.status || cur?.state;
  }, [pool]);

  const scaleDwu = useCallback(async () => {
    setConfirm(null); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/synapse-dwu', { pool, sku: dwu });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})` }); return; }
    setResult({ ok: true, text: `Scaling ${pool} → ${json.newSku || dwu} (${json.provisioningState || 'Scaling'}).` });
    onState(json.provisioningState || 'Scaling');
    poll.start(poolState, onState);
  }, [pool, dwu, onState, poll, poolState]);

  const lifecycle = useCallback(async (action: 'pause' | 'resume') => {
    setConfirm(null); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/compute', { kind: 'synapse-pool', action });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})` }); return; }
    setResult({ ok: true, text: json.message || `${action} requested.` });
    onState(action === 'pause' ? 'Pausing' : 'Resuming');
    poll.start(poolState, onState);
  }, [onState, poll, poolState]);

  if (loading) return <Spinner size="tiny" label="Reading Synapse pools…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;
  if (!pools.length) return <MessageBar intent="info"><MessageBarBody>No dedicated SQL pools in this Synapse workspace. Serverless SQL scales automatically; Spark pools auto-pause. Dedicated pools (DWxxxc) appear here once created.</MessageBarBody></MessageBar>;

  const cur = pools.find((x) => x.name === pool);
  const curState = (cur?.status || cur?.state || '').toLowerCase();

  return (
    <div className={s.sub}>
      <Subtitle2>Dedicated SQL pool</Subtitle2>
      <Field label="Pool">
        <Select value={pool} onChange={(_, d) => { setPool(d.value); const c = pools.find((x) => x.name === d.value); if (c?.sku?.name && /^DW\d+c$/i.test(c.sku.name)) setDwu(c.sku.name); onState(c?.status || c?.state); }} disabled={busy}>
          {pools.map((p) => <option key={p.name} value={p.name}>{p.name} — {p.sku?.name || '?'} ({p.status || p.state || 'unknown'})</option>)}
        </Select>
      </Field>
      <div className={s.controls}>
        <Field label="Performance level (DWU)" className={s.grow}>
          <Select value={dwu} onChange={(_, d) => setDwu(d.value)} disabled={busy}>
            {DWU_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
        <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy || !pool}
          onClick={() => setConfirm({ action: `Scale ${pool} to ${dwu}`, run: scaleDwu })}>
          {busy ? 'Working…' : 'Apply DWU'}
        </Button>
      </div>
      <Divider />
      <div className={s.row}>
        <Button appearance="primary" icon={<Play16Regular />} disabled={busy || /online|resum/.test(curState)}
          onClick={() => setConfirm({ action: `Resume ${pool}`, run: () => lifecycle('resume') })}>Resume</Button>
        <Button icon={<Pause16Regular />} disabled={busy || /paus/.test(curState)}
          onClick={() => setConfirm({ action: `Pause ${pool}`, run: () => lifecycle('pause') })}>Pause</Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={!!confirm} resourceName={resource.name} action={confirm?.action || ''} onConfirm={() => confirm?.run()} onCancel={() => setConfirm(null)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Databricks section (cluster resize + SQL warehouse resize)
// ────────────────────────────────────────────────────────────────────────
interface DbxCluster { cluster_id: string; cluster_name?: string; node_type_id?: string; num_workers?: number; state?: string }
interface DbxNodeType { id: string; cores?: number; memoryMb?: number; category?: string }
interface DbxWarehouse { id: string; name?: string; cluster_size?: string; state?: string }
function DatabricksSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [clusters, setClusters] = useState<DbxCluster[]>([]);
  const [nodeTypes, setNodeTypes] = useState<DbxNodeType[]>([]);
  const [warehouses, setWarehouses] = useState<DbxWarehouse[]>([]);
  const [clusterId, setClusterId] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [workers, setWorkers] = useState<number>(2);
  const [whId, setWhId] = useState('');
  const [whSize, setWhSize] = useState('Small');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ action: string; run: () => void } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const [c, w] = await Promise.all([
      getJson('/api/admin/scaling/databricks-cluster'),
      getJson('/api/admin/scaling/databricks-warehouse'),
    ]);
    if (!c.json.ok && !w.json.ok) {
      setGate({ error: c.json.error || w.json.error || 'Databricks not configured', hint: c.json.hint || w.json.hint });
      setLoading(false); return;
    }
    const cl: DbxCluster[] = c.json.clusters || [];
    setClusters(cl); setNodeTypes(c.json.nodeTypes || []);
    if (cl.length) { setClusterId(cl[0].cluster_id); setNodeType(cl[0].node_type_id || ''); setWorkers(cl[0].num_workers ?? 2); }
    const wh: DbxWarehouse[] = w.json.warehouses || [];
    setWarehouses(wh);
    if (wh.length) { setWhId(wh[0].id); setWhSize(wh[0].cluster_size || 'Small'); }
    onState(cl[0]?.state || wh[0]?.state || 'Workspace');
    setLoading(false);
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const resizeCluster = useCallback(async () => {
    setConfirm(null); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/databricks-cluster', { cluster_id: clusterId, node_type_id: nodeType, num_workers: workers });
    setBusy(false);
    setResult(json.ok ? { ok: true, text: `Resized cluster to ${nodeType} × ${workers} worker(s).` } : { ok: false, text: json.error || `failed (${status})` });
    if (json.ok) void load();
  }, [clusterId, nodeType, workers, load]);

  const resizeWarehouse = useCallback(async () => {
    setConfirm(null); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/databricks-warehouse', { id: whId, cluster_size: whSize });
    setBusy(false);
    setResult(json.ok ? { ok: true, text: `Resized SQL warehouse to ${whSize}.` } : { ok: false, text: json.error || `failed (${status})` });
    if (json.ok) void load();
  }, [whId, whSize, load]);

  if (loading) return <Spinner size="tiny" label="Reading Databricks compute…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ' — set LOOM_DATABRICKS_HOSTNAME on loom-console.'}</MessageBarBody></MessageBar>;

  return (
    <>
      {clusters.length > 0 && (
        <div className={s.sub}>
          <Subtitle2>All-purpose / job cluster</Subtitle2>
          <Field label="Cluster">
            <Select value={clusterId} onChange={(_, d) => { setClusterId(d.value); const c = clusters.find((x) => x.cluster_id === d.value); setNodeType(c?.node_type_id || ''); setWorkers(c?.num_workers ?? 2); onState(c?.state); }} disabled={busy}>
              {clusters.map((c) => <option key={c.cluster_id} value={c.cluster_id}>{c.cluster_name || c.cluster_id} ({c.state || '?'})</option>)}
            </Select>
          </Field>
          <div className={s.controls}>
            <Field label="Node type" className={s.grow}>
              <Select value={nodeType} onChange={(_, d) => setNodeType(d.value)} disabled={busy}>
                {(nodeTypes.length ? nodeTypes : [{ id: nodeType }]).map((n) => <option key={n.id} value={n.id}>{n.id}{n.cores ? ` — ${n.cores} cores` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Workers">
              <SpinButton value={workers} min={0} max={128} step={1} disabled={busy}
                onChange={(_, d) => setWorkers(Math.max(0, Math.min(128, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : workers)) || 0)))} />
            </Field>
            <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy || !clusterId}
              onClick={() => setConfirm({ action: `Resize cluster to ${nodeType} × ${workers}`, run: resizeCluster })}>Resize cluster</Button>
          </div>
        </div>
      )}
      {warehouses.length > 0 && (
        <div className={s.sub}>
          <Subtitle2>SQL warehouse</Subtitle2>
          <Field label="Warehouse">
            <Select value={whId} onChange={(_, d) => { setWhId(d.value); const wh = warehouses.find((x) => x.id === d.value); setWhSize(wh?.cluster_size || 'Small'); onState(wh?.state); }} disabled={busy}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name || w.id} — {w.cluster_size || '?'} ({w.state || '?'})</option>)}
            </Select>
          </Field>
          <div className={s.controls}>
            <Field label="Cluster size" className={s.grow}>
              <Select value={whSize} onChange={(_, d) => setWhSize(d.value)} disabled={busy}>
                {DBX_SIZES.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </Field>
            <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy || !whId}
              onClick={() => setConfirm({ action: `Resize warehouse to ${whSize}`, run: resizeWarehouse })}>Resize warehouse</Button>
          </div>
        </div>
      )}
      {clusters.length === 0 && warehouses.length === 0 && (
        <MessageBar intent="info"><MessageBarBody>No clusters or SQL warehouses found in this Databricks workspace yet.</MessageBarBody></MessageBar>
      )}
      <ResultBar result={result} />
      <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh">Refresh</Button>
      <ConfirmScaleDialog open={!!confirm} resourceName={resource.name} action={confirm?.action || ''} onConfirm={() => confirm?.run()} onCancel={() => setConfirm(null)} />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────
// VMSS (self-hosted IR) section
// ────────────────────────────────────────────────────────────────────────
function VmssSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<number>(0);
  const [state, setState] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ action: string; run: () => void } | null>(null);

  const readState = useCallback(async (): Promise<string | undefined> => {
    const { json } = await getJson('/api/admin/scaling/compute');
    const v = (json.resources || []).find((r: any) => r.kind === 'shir-vmss');
    if (v) { setCapacity(v.capacity ?? 0); setState(v.state); }
    return v?.state;
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { json } = await getJson('/api/admin/scaling/compute');
    if (!json.ok) { setGate(json.error || 'failed'); setLoading(false); return; }
    const v = (json.resources || []).find((r: any) => r.kind === 'shir-vmss');
    if (!v) { setGate('Self-hosted IR VMSS not present in this deployment (LOOM_SHIR_VMSS_NAME unset).'); setLoading(false); return; }
    setCapacity(v.capacity ?? 0); setState(v.state); onState(v.state); setLoading(false);
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const scale = useCallback(async (target: number) => {
    setConfirm(null); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/compute', { kind: 'shir-vmss', action: 'scale', capacity: target });
    setBusy(false);
    setResult(json.ok ? { ok: true, text: json.message || `Scaling to ${target} node(s).` } : { ok: false, text: json.error || `failed (${status})` });
    if (json.ok) { onState(target === 0 ? 'Stopping' : 'Starting'); poll.start(readState, onState); }
  }, [onState, poll, readState]);

  if (loading) return <Spinner size="tiny" label="Reading scale set…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarBody>{gate}</MessageBarBody></MessageBar>;

  return (
    <div className={s.sub}>
      <Subtitle2>Self-hosted integration runtime (VMSS)</Subtitle2>
      <Caption1>Current capacity: <strong>{capacity}</strong> node(s) — {state}</Caption1>
      <div className={s.row}>
        <Button appearance="primary" icon={<Play16Regular />} disabled={busy || capacity > 0}
          onClick={() => setConfirm({ action: 'Start (scale to 4 nodes)', run: () => scale(4) })}>Start (4)</Button>
        <Button icon={<Pause16Regular />} disabled={busy || capacity === 0}
          onClick={() => setConfirm({ action: 'Stop (scale to 0 nodes)', run: () => scale(0) })}>Stop (0)</Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={!!confirm} resourceName={resource.name} action={confirm?.action || ''} onConfirm={() => confirm?.run()} onCancel={() => setConfirm(null)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Container App section
// ────────────────────────────────────────────────────────────────────────
interface CaApp { name: string; minReplicas?: number; maxReplicas?: number; provisioningState?: string }
function ContainerAppSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [min, setMin] = useState<number>(1);
  const [max, setMax] = useState<number>(3);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const findApp = useCallback((apps: CaApp[]): CaApp | undefined =>
    apps.find((a) => a.name?.toLowerCase() === resource.name.toLowerCase()) || apps[0], [resource.name]);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/container-apps');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    const app = findApp(json.apps || []);
    if (app) { setMin(app.minReplicas ?? 1); setMax(app.maxReplicas ?? 3); onState(app.provisioningState); }
    setLoading(false);
  }, [findApp, onState]);
  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async () => {
    setConfirm(false); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/container-apps', { name: resource.name, minReplicas: min, maxReplicas: max });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})`, hint: json.hint }); return; }
    setResult({ ok: true, text: `Scale set to min ${min} / max ${max}.` });
    onState(json.app?.provisioningState || 'Updating');
    poll.start(async () => findApp((await getJson('/api/admin/scaling/container-apps')).json?.apps || [])?.provisioningState, onState);
  }, [resource.name, min, max, onState, poll, findApp]);

  if (loading) return <Spinner size="tiny" label="Reading container app…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;

  return (
    <div className={s.sub}>
      <Subtitle2>Replica scale</Subtitle2>
      <div className={s.controls}>
        <Field label="Min replicas">
          <SpinButton value={min} min={0} max={1000} step={1} disabled={busy}
            onChange={(_, d) => setMin(Math.max(0, Math.min(1000, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : min)) || 0)))} />
        </Field>
        <Field label="Max replicas">
          <SpinButton value={max} min={1} max={1000} step={1} disabled={busy}
            onChange={(_, d) => setMax(Math.max(1, Math.min(1000, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : max)) || 1)))} />
        </Field>
        <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy || max < min} onClick={() => setConfirm(true)}>
          {busy ? 'Applying…' : 'Apply scale'}
        </Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={confirm} resourceName={resource.name} action={`Set replicas to min ${min} / max ${max}`} onConfirm={apply} onCancel={() => setConfirm(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// AKS section
// ────────────────────────────────────────────────────────────────────────
interface AksPool { name: string; count: number; provisioningState?: string; vmSize?: string; mode?: string }
function AksSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [pools, setPools] = useState<AksPool[]>([]);
  const [pool, setPool] = useState('');
  const [count, setCount] = useState<number>(3);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/aks');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    const list: AksPool[] = json.pools || [];
    setPools(list);
    if (list.length) { setPool((p) => p || list[0].name); const cur = list.find((x) => x.name === (pool || list[0].name)) || list[0]; setCount(cur.count); onState(cur.provisioningState); }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async () => {
    setConfirm(false); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/aks', { pool, count });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})`, hint: json.hint }); return; }
    setResult({ ok: true, text: `Scaling pool ${pool} → ${count} node(s) (${json.provisioningState || 'Updating'}).` });
    onState(json.provisioningState || 'Updating');
    poll.start(async () => ((await getJson('/api/admin/scaling/aks')).json?.pools || []).find((x: AksPool) => x.name === pool)?.provisioningState, onState);
  }, [pool, count, onState, poll]);

  if (loading) return <Spinner size="tiny" label="Reading node pools…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;

  return (
    <div className={s.sub}>
      <Subtitle2>Node pool scale</Subtitle2>
      <Field label="Pool">
        <Select value={pool} onChange={(_, d) => { setPool(d.value); const c = pools.find((x) => x.name === d.value); setCount(c?.count ?? 3); onState(c?.provisioningState); }} disabled={busy}>
          {pools.map((p) => <option key={p.name} value={p.name}>{p.name} — {p.vmSize || '?'} ({p.mode || ''}, {p.count} node{p.count === 1 ? '' : 's'})</option>)}
        </Select>
      </Field>
      <div className={s.controls}>
        <Field label="Node count">
          <SpinButton value={count} min={0} max={1000} step={1} disabled={busy}
            onChange={(_, d) => setCount(Math.max(0, Math.min(1000, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : count)) || 0)))} />
        </Field>
        <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy || !pool} onClick={() => setConfirm(true)}>
          {busy ? 'Scaling…' : 'Apply count'}
        </Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Setting a fixed count disables the cluster autoscaler on this pool.</Caption1>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={confirm} resourceName={resource.name} action={`Scale pool ${pool} to ${count} node(s)`} onConfirm={apply} onCancel={() => setConfirm(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// AI Search section
// ────────────────────────────────────────────────────────────────────────
function AiSearchSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [replicas, setReplicas] = useState<number>(1);
  const [partitions, setPartitions] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/ai-search');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    setReplicas(json.service?.replicaCount ?? 1); setPartitions(json.service?.partitionCount ?? 1);
    onState(json.service?.provisioningState || json.service?.status); setLoading(false);
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async () => {
    setConfirm(false); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/ai-search', { replicaCount: replicas, partitionCount: partitions });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})`, hint: json.gate?.remediation }); return; }
    setResult({ ok: true, text: `Scaling to ${replicas} replica(s) × ${partitions} partition(s).` });
    onState(json.service?.provisioningState || 'provisioning');
    poll.start(async () => { const j = (await getJson('/api/admin/scaling/ai-search')).json; return j?.service?.provisioningState || j?.service?.status; }, onState);
  }, [replicas, partitions, onState, poll]);

  if (loading) return <Spinner size="tiny" label="Reading AI Search service…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;

  return (
    <div className={s.sub}>
      <Subtitle2>Replicas &amp; partitions</Subtitle2>
      <div className={s.controls}>
        <Field label="Replicas">
          <SpinButton value={replicas} min={1} max={12} step={1} disabled={busy}
            onChange={(_, d) => setReplicas(Math.max(1, Math.min(12, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : replicas)) || 1)))} />
        </Field>
        <Field label="Partitions">
          <SpinButton value={partitions} min={1} max={12} step={1} disabled={busy}
            onChange={(_, d) => setPartitions(Math.max(1, Math.min(12, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : partitions)) || 1)))} />
        </Field>
        <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy} onClick={() => setConfirm(true)}>
          {busy ? 'Scaling…' : 'Apply'}
        </Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>The SKU tier is immutable after creation — only replicas/partitions scale in place.</Caption1>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={confirm} resourceName={resource.name} action={`Scale to ${replicas} replica(s) × ${partitions} partition(s)`} onConfirm={apply} onCancel={() => setConfirm(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// APIM section
// ────────────────────────────────────────────────────────────────────────
function ApimSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const poll = usePoll();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [sku, setSku] = useState('Developer');
  const [capacity, setCapacity] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/apim');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    setSku(json.service?.sku?.name || json.service?.sku || 'Developer');
    setCapacity(json.service?.sku?.capacity ?? json.service?.capacity ?? 1);
    onState(json.service?.provisioningState); setLoading(false);
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async () => {
    setConfirm(false); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/apim', { sku, capacity });
    setBusy(false);
    if (!json.ok) { setResult({ ok: false, text: json.error || `failed (${status})`, hint: json.gate?.remediation }); return; }
    setResult({ ok: true, text: `Scaling to ${sku} × ${capacity}. APIM SKU changes can take 15-45 min.` });
    onState(json.service?.provisioningState || 'Updating');
    poll.start(async () => (await getJson('/api/admin/scaling/apim')).json?.service?.provisioningState, onState);
  }, [sku, capacity, onState, poll]);

  if (loading) return <Spinner size="tiny" label="Reading APIM service…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;

  return (
    <div className={s.sub}>
      <Subtitle2>Service tier &amp; units</Subtitle2>
      <div className={s.controls}>
        <Field label="SKU" className={s.grow}>
          <Select value={sku} onChange={(_, d) => setSku(d.value)} disabled={busy}>
            {APIM_SKUS.map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
        <Field label="Units (capacity)">
          <SpinButton value={capacity} min={1} max={12} step={1} disabled={busy}
            onChange={(_, d) => setCapacity(Math.max(1, Math.min(12, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : capacity)) || 1)))} />
        </Field>
        <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy} onClick={() => setConfirm(true)}>
          {busy ? 'Scaling…' : 'Apply'}
        </Button>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
      </div>
      <ResultBar result={result} />
      <ConfirmScaleDialog open={confirm} resourceName={resource.name} action={`Scale to ${sku} × ${capacity}`} onConfirm={apply} onCancel={() => setConfirm(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Cosmos DB section
// ────────────────────────────────────────────────────────────────────────
interface CosmosContainer { id: string; mode?: string; ru?: number; maxRu?: number; minRu?: number }
function CosmosSection({ resource, onState }: { resource: AzureRes; onState: (s?: string) => void }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [containers, setContainers] = useState<CosmosContainer[]>([]);
  const [container, setContainer] = useState('');
  const [ru, setRu] = useState<number>(400);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    const { status, json } = await getJson('/api/admin/scaling/cosmos');
    if (!json.ok) { setGate({ error: json.error || `failed (${status})`, hint: json.hint }); setLoading(false); return; }
    const list: CosmosContainer[] = json.containers || [];
    setContainers(list);
    if (list.length) { setContainer(list[0].id); setRu(list[0].ru ?? list[0].maxRu ?? 400); }
    onState('Succeeded'); setLoading(false);
  }, [onState]);
  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async () => {
    setConfirm(false); setBusy(true); setResult(null);
    const { status, json } = await postJson('/api/admin/scaling/cosmos', { container, ru });
    setBusy(false);
    setResult(json.ok ? { ok: true, text: `Set ${container} to ${ru} RU/s.` } : { ok: false, text: json.error || `failed (${status})` });
    if (json.ok) void load();
  }, [container, ru, load]);

  if (loading) return <Spinner size="tiny" label="Reading Cosmos containers…" />;
  if (gate) return <MessageBar intent="warning"><MessageBarTitle>Permission or configuration required</MessageBarTitle><MessageBarBody>{gate.error}{gate.hint ? ` — ${gate.hint}` : ''}</MessageBarBody></MessageBar>;
  if (!containers.length) return <MessageBar intent="info"><MessageBarBody>No containers with dedicated throughput found (serverless or shared-database accounts scale automatically).</MessageBarBody></MessageBar>;

  const cur = containers.find((c) => c.id === container);
  const serverless = /serverless/i.test(cur?.mode || '');

  return (
    <div className={s.sub}>
      <Subtitle2>Container throughput (RU/s)</Subtitle2>
      <Field label="Container">
        <Select value={container} onChange={(_, d) => { setContainer(d.value); const c = containers.find((x) => x.id === d.value); setRu(c?.ru ?? c?.maxRu ?? 400); }} disabled={busy}>
          {containers.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.mode === 'serverless' ? 'serverless' : `${c.ru ?? c.maxRu ?? '?'} RU/s`}</option>)}
        </Select>
      </Field>
      {serverless ? (
        <MessageBar intent="info"><MessageBarBody>This container is serverless — throughput is billed per-request and cannot be dialed.</MessageBarBody></MessageBar>
      ) : (
        <div className={s.controls}>
          <Field label="Manual RU/s">
            <SpinButton value={ru} min={400} max={1000000} step={100} disabled={busy}
              onChange={(_, d) => setRu(Math.max(400, Number(d.value ?? (d.displayValue ? parseInt(d.displayValue, 10) : ru)) || 400))} />
          </Field>
          <Button appearance="primary" icon={<ArrowUp16Regular />} disabled={busy || !container} onClick={() => setConfirm(true)}>
            {busy ? 'Applying…' : 'Apply RU/s'}
          </Button>
          <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={busy} onClick={load} title="Refresh" aria-label="Refresh" />
        </div>
      )}
      <ResultBar result={result} />
      <ConfirmScaleDialog open={confirm} resourceName={resource.name} action={`Set ${container} to ${ru} RU/s`} onConfirm={apply} onCancel={() => setConfirm(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Drawer shell
// ────────────────────────────────────────────────────────────────────────
export function ScaleManageDrawer({ resource, onClose }: ScaleManageDrawerProps) {
  const s = useStyles();
  const [liveState, setLiveState] = useState<string | undefined>(undefined);

  useEffect(() => { setLiveState(resource?.provisioningState); }, [resource]);

  const section = resource ? classify(resource.type) : 'unsupported';

  return (
    <OverlayDrawer open={!!resource} onOpenChange={(_, d) => { if (!d.open) onClose(); }} position="end" size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={onClose} aria-label="Close scale & manage drawer" />}
        >
          {resource?.name || 'Scale & manage'}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {resource && (
          <div className={s.body}>
            <div className={s.meta}>
              <span className={s.type}>{resource.type}</span>
              <Badge appearance="filled" color={stateColor(liveState)}>{liveState || 'unknown'}</Badge>
              {resource.sku && <Caption1>SKU: <code>{resource.sku}</code></Caption1>}
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{resource.resourceGroup} · {resource.location}</Caption1>
            </div>
            <Divider />
            {section === 'adx' && <AdxSection resource={resource} onState={setLiveState} />}
            {section === 'synapse' && <SynapseSection resource={resource} onState={setLiveState} />}
            {section === 'databricks' && <DatabricksSection resource={resource} onState={setLiveState} />}
            {section === 'vmss' && <VmssSection resource={resource} onState={setLiveState} />}
            {section === 'container-app' && <ContainerAppSection resource={resource} onState={setLiveState} />}
            {section === 'aks' && <AksSection resource={resource} onState={setLiveState} />}
            {section === 'ai-search' && <AiSearchSection resource={resource} onState={setLiveState} />}
            {section === 'apim' && <ApimSection resource={resource} onState={setLiveState} />}
            {section === 'cosmos' && <CosmosSection resource={resource} onState={setLiveState} />}
            {section === 'unsupported' && (
              <MessageBar intent="info">
                <MessageBarTitle>Scaling not available here</MessageBarTitle>
                <MessageBarBody>
                  {resource.type.replace('Microsoft.', '')} has no in-place scale operation in Loom.
                  Open it in the Azure portal from the inventory row to manage it directly.
                </MessageBarBody>
              </MessageBar>
            )}
          </div>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}
