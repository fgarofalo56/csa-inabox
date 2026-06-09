'use client';

/**
 * SparkComputePane — Spark / compute configuration for a Loom workspace (F13).
 * One-for-one with Fabric's workspace "Spark settings" object (Pool /
 * Environment / Jobs), themed with Fluent v9 + Loom tokens, but backed by Azure
 * Databricks (instance pools + cluster spec + libraries) — no Microsoft Fabric
 * capacity or workspace required (.claude/rules/no-fabric-dependency.md).
 *
 * Four tabs, every control a typed Fluent input (no JSON, no freeform —
 * .claude/rules/loom-no-freeform-config.md):
 *   - Pool         starter vs custom pool; create a real instance pool (node
 *                  family/size, idle/max capacity, autoterminate, spot/on-demand)
 *   - Runtime      Databricks runtime version + node family/size + driver +
 *                  autoscale (min/max workers) vs fixed worker count
 *   - Environment  PyPI / Maven library set; install/uninstall against a live
 *                  cluster; session-level packages toggle
 *   - Jobs         session timeout, optimistic admission, reserved cores,
 *                  dynamic executors (→ autoscale) with the unsupported-conf note
 *
 * Every control calls the real BFF (/api/admin/workspaces/[id]/spark/*). The
 * only non-functional state is an honest MessageBar gate (Databricks host unset
 * or a sovereign cloud without Databricks).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner,
  Dropdown, Option, Field, Input, Switch, SpinButton,
  Radio, RadioGroup,
  TabList, Tab,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tag, TagGroup,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Server20Regular, Rocket20Regular, BoxMultiple20Regular, Timer20Regular,
  Add16Regular, Delete16Regular, ArrowClockwise16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px', minHeight: 0 },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '8px', padding: '16px',
    display: 'flex', flexDirection: 'column', gap: '12px', backgroundColor: tokens.colorNeutralBackground1,
  },
  row: { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  sectionTitle: { display: 'flex', gap: '8px', alignItems: 'center' },
  tableWrap: {
    overflow: 'auto', maxHeight: '280px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px',
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

// ---- response shapes (mirror the BFF) ----
interface NodeTypeRow { id: string; memoryMb?: number; cores?: number; category?: string; description?: string }
interface SparkVersionRow { key: string; name: string }
interface PoolRow {
  instance_pool_id: string;
  instance_pool_name: string;
  node_type_id: string;
  state?: string;
  min_idle_instances?: number;
  max_capacity?: number;
  stats?: { used_count?: number; idle_count?: number };
}
interface PoolConfig {
  mode: 'starter' | 'custom';
  instance_pool_id?: string;
  instance_pool_name?: string;
}
interface RuntimeConfig {
  spark_version?: string;
  node_type_id?: string;
  driver_node_type_id?: string;
  autoscale?: { min_workers: number; max_workers: number };
  num_workers?: number;
}
interface EnvConfig { pypi?: string[]; maven?: string[]; sessionLevelPackages?: boolean }
interface JobsConfig {
  session_timeout_minutes: number;
  optimistic_admission: boolean;
  reserve_cores: number;
  dynamic_executors?: boolean;
  min_executors?: number;
  max_executors?: number;
}
interface LibraryStatusRow {
  status?: string;
  library?: { pypi?: { package?: string }; maven?: { coordinates?: string }; whl?: string; jar?: string };
}

type SparkTab = 'pool' | 'runtime' | 'environment' | 'jobs';

export interface SparkComputePaneProps {
  /** Loom internal workspace id (Cosmos doc id), NOT the Databricks workspace id. */
  workspaceId: string;
}

interface GateState { code: string; message: string; missing?: string }

export function SparkComputePane({ workspaceId }: SparkComputePaneProps) {
  const s = useStyles();
  const base = `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/spark`;

  const [tab, setTab] = useState<SparkTab>('pool');
  const [gate, setGate] = useState<GateState | null>(null);

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<Server20Regular />}>Spark compute</Badge>
        <Badge appearance="outline" color="success">Azure Databricks</Badge>
        <Caption1 className={s.hint}>Workspace pool, runtime, environment libraries, and job defaults.</Caption1>
      </div>

      {gate ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Databricks workspace not configured</MessageBarTitle>
            {gate.message}
          </MessageBarBody>
        </MessageBar>
      ) : (
        <>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as SparkTab)}>
            <Tab value="pool" icon={<Server20Regular />}>Pool</Tab>
            <Tab value="runtime" icon={<Rocket20Regular />}>Runtime</Tab>
            <Tab value="environment" icon={<BoxMultiple20Regular />}>Environment</Tab>
            <Tab value="jobs" icon={<Timer20Regular />}>Jobs</Tab>
          </TabList>

          {tab === 'pool' && <PoolTab base={base} onGate={setGate} />}
          {tab === 'runtime' && <RuntimeTab base={base} onGate={setGate} />}
          {tab === 'environment' && <EnvironmentTab base={base} onGate={setGate} />}
          {tab === 'jobs' && <JobsTab base={base} onGate={setGate} />}
        </>
      )}
    </div>
  );
}

// helper: detect an honest gate from a 503 body
function readGate(j: any): GateState | null {
  if (j?.gated) return { code: j.code, message: j.error, missing: j.missing };
  return null;
}

// ==========================================================
// Pool tab
// ==========================================================
function PoolTab({ base, onGate }: { base: string; onGate: (g: GateState | null) => void }) {
  const s = useStyles();
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [config, setConfig] = useState<PoolConfig>({ mode: 'starter' });
  const [nodeTypes, setNodeTypes] = useState<NodeTypeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // create-pool form state
  const [name, setName] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [minIdle, setMinIdle] = useState(1);
  const [maxCap, setMaxCap] = useState(10);
  const [idleTerm, setIdleTerm] = useState(60);
  const [availability, setAvailability] = useState<'ON_DEMAND_AZURE' | 'SPOT_AZURE'>('ON_DEMAND_AZURE');

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pr, rr] = await Promise.all([
        fetch(`${base}/pools`),
        fetch(`${base}/runtime`),
      ]);
      const pj = await pr.json();
      const g = readGate(pj);
      if (g) { onGate(g); return; }
      onGate(null);
      if (!pj.ok) { setError(pj.error || 'failed to load pools'); return; }
      setPools(pj.pools || []);
      setConfig(pj.config || { mode: 'starter' });
      const rj = await rr.json().catch(() => ({}));
      if (rj.ok) setNodeTypes(rj.nodeTypes || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base, onGate]);

  useEffect(() => { reload(); }, [reload]);

  const post = useCallback(async (body: any) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${base}/pools`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'request failed'); return false; }
      await reload();
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setBusy(false); }
  }, [base, reload]);

  const createPool = useCallback(async () => {
    const ok = await post({
      action: 'create',
      spec: {
        instance_pool_name: name.trim(),
        node_type_id: nodeType,
        min_idle_instances: minIdle,
        max_capacity: maxCap,
        idle_instance_autotermination_minutes: idleTerm,
        azure_attributes: { availability },
      },
    });
    if (ok) { setShowCreate(false); setName(''); }
  }, [post, name, nodeType, minIdle, maxCap, idleTerm, availability]);

  const deletePool = useCallback(async (poolId: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${base}/pools?poolId=${encodeURIComponent(poolId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'delete failed'); return; }
      await reload();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, reload]);

  return (
    <div className={s.card}>
      <div className={s.sectionTitle}>
        <Subtitle2>Pool mode</Subtitle2>
        {loading && <Spinner size="tiny" />}
        <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={reload} disabled={loading || busy}>Refresh</Button>
      </div>
      <Body1 className={s.hint}>
        Starter uses a pre-warmed on-demand pool with no configuration. Custom pins this workspace to a specific instance pool for predictable cluster start times.
      </Body1>

      <RadioGroup
        value={config.mode}
        onChange={(_, d) => {
          if (d.value === 'starter') post({ action: 'starter' });
        }}
      >
        <Radio value="starter" label="Starter — pre-warmed on-demand instances, no configuration required" />
        <Radio value="custom" label="Custom — pin to a specific instance pool" />
      </RadioGroup>

      {config.mode === 'custom' && (
        <Field label="Instance pool" hint="The Databricks instance pool this workspace's clusters attach to">
          <Dropdown
            value={config.instance_pool_name || config.instance_pool_id || ''}
            selectedOptions={config.instance_pool_id ? [config.instance_pool_id] : []}
            placeholder="Select a pool"
            onOptionSelect={(_, d) => {
              const p = pools.find((x) => x.instance_pool_id === d.optionValue);
              post({ action: 'select', instance_pool_id: d.optionValue, instance_pool_name: p?.instance_pool_name });
            }}
          >
            {pools.map((p) => (
              <Option key={p.instance_pool_id} value={p.instance_pool_id} text={p.instance_pool_name}>
                {p.instance_pool_name} · {p.node_type_id}
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}

      <div className={s.sectionTitle}>
        <Subtitle2>Instance pools</Subtitle2>
        <Button size="small" appearance="primary" icon={<Add16Regular />} onClick={() => setShowCreate((v) => !v)} disabled={busy}>
          {showCreate ? 'Cancel' : 'Create pool'}
        </Button>
      </div>

      {showCreate && (
        <div className={s.card}>
          <div className={s.grid2}>
            <Field label="Pool name" required>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="loom-shared-pool" />
            </Field>
            <Field label="Node type" required hint="VM family / size for instances in the pool">
              <Dropdown
                value={nodeType}
                selectedOptions={nodeType ? [nodeType] : []}
                placeholder="Select a node type"
                onOptionSelect={(_, d) => setNodeType(d.optionValue || '')}
              >
                {nodeTypes.map((n) => (
                  <Option key={n.id} value={n.id} text={n.id}>
                    {n.id}{n.cores ? ` · ${n.cores} cores` : ''}{n.memoryMb ? ` · ${Math.round(n.memoryMb / 1024)} GB` : ''}{n.category ? ` · ${n.category}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Minimum idle instances" hint="Kept pre-warmed for instant attach">
              <SpinButton value={minIdle} min={0} max={100} onChange={(_, d) => setMinIdle(d.value ?? minIdle)} />
            </Field>
            <Field label="Maximum capacity" hint="Hard cap on total instances (idle + in-use)">
              <SpinButton value={maxCap} min={1} max={1000} onChange={(_, d) => setMaxCap(d.value ?? maxCap)} />
            </Field>
            <Field label="Idle auto-termination (minutes)">
              <SpinButton value={idleTerm} min={0} max={10000} onChange={(_, d) => setIdleTerm(d.value ?? idleTerm)} />
            </Field>
            <Field label="Availability">
              <RadioGroup layout="horizontal" value={availability} onChange={(_, d) => setAvailability(d.value as any)}>
                <Radio value="ON_DEMAND_AZURE" label="On-demand" />
                <Radio value="SPOT_AZURE" label="Spot" />
              </RadioGroup>
            </Field>
          </div>
          <div className={s.actions}>
            <Button appearance="primary" onClick={createPool} disabled={busy || !name.trim() || !nodeType}>
              Create instance pool
            </Button>
            {busy && <Spinner size="tiny" label="Creating…" labelPosition="after" />}
          </div>
        </div>
      )}

      <div className={s.tableWrap}>
        <Table size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Node type</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Idle / Used</TableHeaderCell>
              <TableHeaderCell>Capacity</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pools.length === 0 && (
              <TableRow><TableCell colSpan={6}><Caption1 className={s.hint}>No instance pools yet. Create one above.</Caption1></TableCell></TableRow>
            )}
            {pools.map((p) => (
              <TableRow key={p.instance_pool_id}>
                <TableCell>{p.instance_pool_name}</TableCell>
                <TableCell>{p.node_type_id}</TableCell>
                <TableCell><Badge appearance="outline" color={p.state === 'ACTIVE' ? 'success' : 'subtle'}>{p.state || '—'}</Badge></TableCell>
                <TableCell>{(p.stats?.idle_count ?? 0)} / {(p.stats?.used_count ?? 0)}</TableCell>
                <TableCell>{p.min_idle_instances ?? 0} – {p.max_capacity ?? '∞'}</TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => deletePool(p.instance_pool_id)} disabled={busy}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Pool operation failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}
    </div>
  );
}

// ==========================================================
// Runtime tab
// ==========================================================
function RuntimeTab({ base, onGate }: { base: string; onGate: (g: GateState | null) => void }) {
  const s = useStyles();
  const [versions, setVersions] = useState<SparkVersionRow[]>([]);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeRow[]>([]);
  const [config, setConfig] = useState<RuntimeConfig>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [sparkVersion, setSparkVersion] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [driverType, setDriverType] = useState('');
  const [useAutoscale, setUseAutoscale] = useState(true);
  const [minWorkers, setMinWorkers] = useState(2);
  const [maxWorkers, setMaxWorkers] = useState(8);
  const [numWorkers, setNumWorkers] = useState(4);

  const categories = useMemo(() => {
    const set = new Set<string>();
    nodeTypes.forEach((n) => { if (n.category) set.add(n.category); });
    return [...set].sort();
  }, [nodeTypes]);
  const [family, setFamily] = useState('');
  const familyNodes = useMemo(
    () => nodeTypes.filter((n) => !family || n.category === family),
    [nodeTypes, family],
  );

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${base}/runtime`);
      const j = await r.json();
      const g = readGate(j);
      if (g) { onGate(g); return; }
      onGate(null);
      if (!j.ok) { setError(j.error || 'failed to load runtime catalog'); return; }
      setVersions(j.versions || []);
      setNodeTypes(j.nodeTypes || []);
      const c: RuntimeConfig = j.config || {};
      setConfig(c);
      if (c.spark_version) setSparkVersion(c.spark_version);
      if (c.node_type_id) setNodeType(c.node_type_id);
      if (c.driver_node_type_id) setDriverType(c.driver_node_type_id);
      if (c.autoscale) {
        setUseAutoscale(true);
        setMinWorkers(c.autoscale.min_workers);
        setMaxWorkers(c.autoscale.max_workers);
      } else if (typeof c.num_workers === 'number') {
        setUseAutoscale(false);
        setNumWorkers(c.num_workers);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, onGate]);

  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const body: any = {
        spark_version: sparkVersion,
        node_type_id: nodeType,
        driver_node_type_id: driverType || undefined,
      };
      if (useAutoscale) body.autoscale = { min_workers: minWorkers, max_workers: maxWorkers };
      else body.num_workers = numWorkers;
      const r = await fetch(`${base}/runtime`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'save failed'); return; }
      setConfig(j.config || {});
      setSaved(true);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [base, sparkVersion, nodeType, driverType, useAutoscale, minWorkers, maxWorkers, numWorkers]);

  const nodeLabel = (n: NodeTypeRow) =>
    `${n.id}${n.cores ? ` · ${n.cores} cores` : ''}${n.memoryMb ? ` · ${Math.round(n.memoryMb / 1024)} GB` : ''}`;

  return (
    <div className={s.card}>
      <div className={s.sectionTitle}>
        <Subtitle2>Cluster runtime</Subtitle2>
        {loading && <Spinner size="tiny" />}
      </div>
      <div className={s.grid2}>
        <Field label="Databricks runtime version" required>
          <Dropdown
            value={versions.find((v) => v.key === sparkVersion)?.name || sparkVersion}
            selectedOptions={sparkVersion ? [sparkVersion] : []}
            placeholder="Select a runtime"
            onOptionSelect={(_, d) => setSparkVersion(d.optionValue || '')}
          >
            {versions.map((v) => (
              <Option key={v.key} value={v.key} text={v.name}>{v.name}</Option>
            ))}
          </Dropdown>
        </Field>
        <Field label="Node family" hint="Filter node types by Azure VM category">
          <Dropdown
            value={family || 'All families'}
            selectedOptions={family ? [family] : []}
            placeholder="All families"
            onOptionSelect={(_, d) => setFamily(d.optionValue === '__all' ? '' : (d.optionValue || ''))}
          >
            <Option value="__all" text="All families">All families</Option>
            {categories.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Worker node type" required>
          <Dropdown
            value={nodeType}
            selectedOptions={nodeType ? [nodeType] : []}
            placeholder="Select a node type"
            onOptionSelect={(_, d) => setNodeType(d.optionValue || '')}
          >
            {familyNodes.map((n) => <Option key={n.id} value={n.id} text={n.id}>{nodeLabel(n)}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Driver node type" hint="Leave blank to match the worker node type">
          <Dropdown
            value={driverType || 'Same as worker'}
            selectedOptions={driverType ? [driverType] : []}
            placeholder="Same as worker"
            onOptionSelect={(_, d) => setDriverType(d.optionValue === '__same' ? '' : (d.optionValue || ''))}
          >
            <Option value="__same" text="Same as worker">Same as worker</Option>
            {familyNodes.map((n) => <Option key={n.id} value={n.id} text={n.id}>{nodeLabel(n)}</Option>)}
          </Dropdown>
        </Field>
      </div>

      <Switch
        checked={useAutoscale}
        onChange={(_, d) => setUseAutoscale(!!d.checked)}
        label="Enable autoscaling (Databricks manages executor count between min and max workers)"
      />
      {useAutoscale ? (
        <div className={s.row}>
          <Field label="Min workers"><SpinButton value={minWorkers} min={1} max={1000} onChange={(_, d) => setMinWorkers(d.value ?? minWorkers)} /></Field>
          <Field label="Max workers"><SpinButton value={maxWorkers} min={1} max={1000} onChange={(_, d) => setMaxWorkers(d.value ?? maxWorkers)} /></Field>
        </div>
      ) : (
        <div className={s.row}>
          <Field label="Worker count (fixed)"><SpinButton value={numWorkers} min={0} max={1000} onChange={(_, d) => setNumWorkers(d.value ?? numWorkers)} /></Field>
        </div>
      )}

      <div className={s.actions}>
        <Button appearance="primary" onClick={save} disabled={saving || !sparkVersion || !nodeType}>Save runtime</Button>
        {saving && <Spinner size="tiny" label="Saving…" labelPosition="after" />}
        {saved && <Badge appearance="tint" color="success">Saved — applies to new clusters</Badge>}
      </div>

      {error && (<MessageBar intent="error"><MessageBarBody><MessageBarTitle>Runtime save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>)}
    </div>
  );
}

// ==========================================================
// Environment tab
// ==========================================================
function EnvironmentTab({ base, onGate }: { base: string; onGate: (g: GateState | null) => void }) {
  const s = useStyles();
  const [clusters, setClusters] = useState<{ id: string; name?: string; state?: string }[]>([]);
  const [clusterId, setClusterId] = useState('');
  const [libraries, setLibraries] = useState<LibraryStatusRow[]>([]);
  const [config, setConfig] = useState<EnvConfig>({ pypi: [], maven: [], sessionLevelPackages: false });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pkgSource, setPkgSource] = useState<'pypi' | 'maven'>('pypi');
  const [pkgSpec, setPkgSpec] = useState('');

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const q = cid ? `?clusterId=${encodeURIComponent(cid)}` : '';
      const r = await fetch(`${base}/environment${q}`);
      const j = await r.json();
      const g = readGate(j);
      if (g) { onGate(g); return; }
      onGate(null);
      if (!j.ok) { setError(j.error || 'failed to load environment'); return; }
      setClusters(j.clusters || []);
      setLibraries(j.libraries || []);
      setConfig(j.config || { pypi: [], maven: [], sessionLevelPackages: false });
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, onGate]);

  useEffect(() => { load(clusterId); }, [load, clusterId]);

  const post = useCallback(async (body: any) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${base}/environment`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'request failed'); return false; }
      if (j.config) setConfig(j.config);
      if (j.libraries) setLibraries(j.libraries);
      return true;
    } catch (e: any) { setError(e?.message || String(e)); return false; }
    finally { setBusy(false); }
  }, [base]);

  const addToSet = useCallback(() => {
    const v = pkgSpec.trim();
    if (!v) return;
    const next: EnvConfig = {
      ...config,
      pypi: pkgSource === 'pypi' ? [...new Set([...(config.pypi || []), v])] : (config.pypi || []),
      maven: pkgSource === 'maven' ? [...new Set([...(config.maven || []), v])] : (config.maven || []),
    };
    setConfig(next);
    setPkgSpec('');
  }, [pkgSpec, pkgSource, config]);

  const removeFromSet = useCallback((kind: 'pypi' | 'maven', val: string) => {
    setConfig((c) => ({
      ...c,
      [kind]: (c[kind] || []).filter((x) => x !== val),
    }));
  }, []);

  const saveSet = useCallback(() => post({
    action: 'save', pypi: config.pypi, maven: config.maven, sessionLevelPackages: config.sessionLevelPackages,
  }), [post, config]);

  const installAll = useCallback(() => {
    if (!clusterId) { setError('Pick a cluster first'); return; }
    return post({ action: 'install', clusterId, pypi: config.pypi, maven: config.maven });
  }, [post, clusterId, config]);

  return (
    <div className={s.card}>
      <div className={s.sectionTitle}>
        <Subtitle2>Environment libraries</Subtitle2>
        {loading && <Spinner size="tiny" />}
      </div>
      <Body1 className={s.hint}>
        Define the PyPI / Maven packages for this workspace. Save persists the set; Install applies it to a live cluster.
      </Body1>

      <div className={s.row}>
        <Field label="Source">
          <RadioGroup layout="horizontal" value={pkgSource} onChange={(_, d) => setPkgSource(d.value as any)}>
            <Radio value="pypi" label="PyPI" />
            <Radio value="maven" label="Maven" />
          </RadioGroup>
        </Field>
        <Field label={pkgSource === 'pypi' ? 'Package (e.g. pandas==2.2.2)' : 'Coordinates (e.g. com.example:lib:1.0)'} style={{ minWidth: 320 }}>
          <Input value={pkgSpec} onChange={(_, d) => setPkgSpec(d.value)} placeholder={pkgSource === 'pypi' ? 'scikit-learn==1.4.2' : 'org.apache.spark:spark-avro_2.12:3.5.0'} />
        </Field>
        <Button appearance="primary" icon={<Add16Regular />} onClick={addToSet} disabled={!pkgSpec.trim()}>Add</Button>
      </div>

      {(config.pypi?.length || 0) > 0 && (
        <Field label="PyPI packages">
          <TagGroup onDismiss={(_, d) => removeFromSet('pypi', d.value)}>
            {(config.pypi || []).map((p) => <Tag key={p} value={p} dismissible>{p}</Tag>)}
          </TagGroup>
        </Field>
      )}
      {(config.maven?.length || 0) > 0 && (
        <Field label="Maven coordinates">
          <TagGroup onDismiss={(_, d) => removeFromSet('maven', d.value)}>
            {(config.maven || []).map((m) => <Tag key={m} value={m} dismissible>{m}</Tag>)}
          </TagGroup>
        </Field>
      )}

      <Switch
        checked={!!config.sessionLevelPackages}
        onChange={(_, d) => setConfig((c) => ({ ...c, sessionLevelPackages: !!d.checked }))}
        label="Allow notebook-scoped (session-level) package installs"
      />

      <Field label="Target cluster" hint="Pick a running cluster to view / install live libraries">
        <Dropdown
          value={clusters.find((c) => c.id === clusterId)?.name || clusterId || 'No cluster selected'}
          selectedOptions={clusterId ? [clusterId] : []}
          placeholder="No cluster selected"
          onOptionSelect={(_, d) => setClusterId(d.optionValue || '')}
        >
          {clusters.map((c) => (
            <Option key={c.id} value={c.id} text={c.name || c.id}>{c.name || c.id} · {c.state}</Option>
          ))}
        </Dropdown>
      </Field>

      {!clusterId && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Pick a cluster to install</MessageBarTitle>
            Live library install/uninstall requires a target cluster. The package set above is still saved to the workspace and applied to new clusters.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.actions}>
        <Button appearance="primary" onClick={saveSet} disabled={busy}>Save package set</Button>
        <Button appearance="outline" onClick={installAll} disabled={busy || !clusterId}>Install on cluster</Button>
        {busy && <Spinner size="tiny" label="Working…" labelPosition="after" />}
      </div>

      {clusterId && (
        <div className={s.tableWrap}>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Library</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {libraries.length === 0 && (
                <TableRow><TableCell colSpan={4}><Caption1 className={s.hint}>No libraries installed on this cluster.</Caption1></TableCell></TableRow>
              )}
              {libraries.map((l, i) => {
                const name = l.library?.pypi?.package || l.library?.maven?.coordinates || l.library?.whl || l.library?.jar || '—';
                const type = l.library?.pypi ? 'PyPI' : l.library?.maven ? 'Maven' : l.library?.whl ? 'Wheel' : l.library?.jar ? 'Jar' : '—';
                return (
                  <TableRow key={`${name}-${i}`}>
                    <TableCell>{name}</TableCell>
                    <TableCell>{type}</TableCell>
                    <TableCell><Badge appearance="outline">{l.status || '—'}</Badge></TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy}
                        onClick={() => post({ action: 'uninstall', clusterId, pypi: l.library?.pypi ? [name] : [], maven: l.library?.maven ? [name] : [] })}>
                        Uninstall
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {error && (<MessageBar intent="error"><MessageBarBody><MessageBarTitle>Environment operation failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>)}
    </div>
  );
}

// ==========================================================
// Jobs tab
// ==========================================================
function JobsTab({ base, onGate }: { base: string; onGate: (g: GateState | null) => void }) {
  const s = useStyles();
  const [config, setConfig] = useState<JobsConfig>({ session_timeout_minutes: 60, optimistic_admission: false, reserve_cores: 0, dynamic_executors: false });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${base}/jobs`);
      const j = await r.json();
      const g = readGate(j);
      if (g) { onGate(g); return; }
      onGate(null);
      if (!j.ok) { setError(j.error || 'failed to load job defaults'); return; }
      setConfig(j.config);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, onGate]);

  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const r = await fetch(`${base}/jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'save failed'); return; }
      setConfig(j.config);
      setSaved(true);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [base, config]);

  return (
    <div className={s.card}>
      <div className={s.sectionTitle}>
        <Subtitle2>Job & session defaults</Subtitle2>
        {loading && <Spinner size="tiny" />}
      </div>
      <Body1 className={s.hint}>
        These defaults are merged into the cluster spec when a cluster is created from this workspace, applying to real Databricks sessions.
      </Body1>

      <div className={s.grid2}>
        <Field label="Session idle termination (minutes)" hint="autotermination_minutes — stop the cluster after this idle period">
          <SpinButton value={config.session_timeout_minutes} min={0} max={10000}
            onChange={(_, d) => setConfig((c) => ({ ...c, session_timeout_minutes: d.value ?? c.session_timeout_minutes }))} />
        </Field>
        <Field label="Reserved driver cores" hint="spark.databricks.driver.reservedCores — cores held back on the driver">
          <SpinButton value={config.reserve_cores} min={0} max={64}
            onChange={(_, d) => setConfig((c) => ({ ...c, reserve_cores: d.value ?? c.reserve_cores }))} />
        </Field>
      </div>

      <Switch
        checked={config.optimistic_admission}
        onChange={(_, d) => setConfig((c) => ({ ...c, optimistic_admission: !!d.checked }))}
        label="Optimistic cluster admission — start sessions while the cluster is still initializing"
      />

      <Switch
        checked={!!config.dynamic_executors}
        onChange={(_, d) => setConfig((c) => ({ ...c, dynamic_executors: !!d.checked }))}
        label="Dynamic executor allocation (via Databricks autoscale)"
      />
      {config.dynamic_executors && (
        <>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Use the Runtime tab&apos;s autoscale</MessageBarTitle>
              The Spark <code>spark.dynamicAllocation.*</code> properties are not supported on Databricks classic clusters. Databricks manages executor lifecycle natively via autoscaling — set min/max workers on the Runtime tab.
            </MessageBarBody>
          </MessageBar>
          <div className={s.row}>
            <Field label="Min executors"><SpinButton value={config.min_executors ?? 1} min={0} max={1000}
              onChange={(_, d) => setConfig((c) => ({ ...c, min_executors: d.value ?? c.min_executors }))} /></Field>
            <Field label="Max executors"><SpinButton value={config.max_executors ?? 8} min={1} max={1000}
              onChange={(_, d) => setConfig((c) => ({ ...c, max_executors: d.value ?? c.max_executors }))} /></Field>
          </div>
        </>
      )}

      <div className={s.actions}>
        <Button appearance="primary" onClick={save} disabled={saving}>Save job defaults</Button>
        {saving && <Spinner size="tiny" label="Saving…" labelPosition="after" />}
        {saved && <Badge appearance="tint" color="success">Saved</Badge>}
      </div>

      {error && (<MessageBar intent="error"><MessageBarBody><MessageBarTitle>Job defaults save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>)}
    </div>
  );
}
