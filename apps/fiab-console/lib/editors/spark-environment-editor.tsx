'use client';

/**
 * Spark environment editor (F18) — full lifecycle parity with the Synapse
 * Studio "Packages + configuration" surface and Fabric's Environment item,
 * built 1:1 on Azure-native backends (no Microsoft Fabric dependency).
 *
 * Tabs:
 *   Runtime          → Spark version + node family
 *   Compute          → node size, autoscale / fixed count, auto-pause,
 *                       session-level packages
 *   Public libraries → pip (requirements.txt) or conda (environment.yml) +
 *                       import-check modules
 *   Custom libraries → upload .whl / .jar (staged to ADLS), list + delete
 *   Spark properties → spark-defaults.conf key/value grid
 *
 * Persistent footer: target-pool picker + Publish (bakes the spec into the
 * Synapse Spark pool via ARM) with live status, Validate import (live Livy
 * session that pip-installs + imports the packages — the importability
 * receipt), and Attach (wires the env onto notebooks + Spark job definitions).
 *
 * Every control hits a real BFF route. Honest Fluent MessageBar gates surface
 * missing infra (ADLS / Spark pool / Synapse workspace) with the exact env var
 * or bicep module to fix it. No mocks, no dead buttons.
 */

import {
  Subtitle2, Caption1, Body1, Input, Dropdown, Option, Button, Badge, Textarea,
  Switch, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowUpload20Regular, Delete20Regular, Rocket20Regular, Beaker20Regular, Link20Regular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { KeyValueGrid } from '@/lib/components/ui/key-value-grid';

const useStyles = makeStyles({
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  tabBody: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '880px' },
  row: { display: 'flex', gap: tokens.spacingVerticalL, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  footer: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    background: tokens.colorNeutralBackground2,
  },
  toolbar: { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  pre: {
    width: '100%', maxHeight: '220px', overflow: 'auto', padding: tokens.spacingVerticalS, margin: 0,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap',
  },
});

const NODE_SIZES = ['Small', 'Medium', 'Large', 'XLarge', 'XXLarge'] as const;
const SPARK_VERSIONS = [
  { v: '3.5', label: '3.5 (GA — recommended)' },
  { v: '3.4', label: '3.4 (deprecated — EOS 2026-03)' },
];

interface CustomLib { name: string; path: string; containerName?: string; type?: string; size?: number; uploadedAt?: string }
interface PoolDTO { name: string; properties?: { sparkVersion?: string } }
interface AttachCandidate { id: string; itemType: string; displayName: string; attached: boolean }

function ErrBar({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{error}</MessageBarBody>
    </MessageBar>
  );
}

export function SparkEnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();

  // --- loaded server state (source of truth for server-managed fields) ---
  const loadedRef = useRef<Record<string, any>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // --- editable fields ---
  const [tab, setTab] = useState('runtime');
  const [sparkVersion, setSparkVersion] = useState('3.5');
  const [nodeSizeFamily, setNodeSizeFamily] = useState('MemoryOptimized');
  const [nodeSize, setNodeSize] = useState('Small');
  const [autoscaleEnabled, setAutoscaleEnabled] = useState(true);
  const [nodeCount, setNodeCount] = useState(3);
  const [minNodeCount, setMinNodeCount] = useState(3);
  const [maxNodeCount, setMaxNodeCount] = useState(10);
  const [autoPauseEnabled, setAutoPauseEnabled] = useState(true);
  const [autoPauseDelay, setAutoPauseDelay] = useState(15);
  const [sessionLevelPackages, setSessionLevelPackages] = useState(true);
  const [requirementsType, setRequirementsType] = useState<'pip' | 'conda'>('pip');
  const [requirementsContent, setRequirementsContent] = useState('');
  const [importChecksText, setImportChecksText] = useState('');
  const [sparkPropsJson, setSparkPropsJson] = useState('{}');

  // --- server-managed display state ---
  const [customLibraries, setCustomLibraries] = useState<CustomLib[]>([]);
  const [publishedToPool, setPublishedToPool] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [publishStatus, setPublishStatus] = useState<string | null>(null);

  // --- pools / footer ---
  const [pools, setPools] = useState<PoolDTO[]>([]);
  const [targetPool, setTargetPool] = useState('');
  const [applyCompute, setApplyCompute] = useState(true);

  // --- ui flags ---
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // --- validate run ---
  const [validateBusy, setValidateBusy] = useState(false);
  const [validateStatus, setValidateStatus] = useState<string | null>(null);
  const [validateOutput, setValidateOutput] = useState<string | null>(null);
  const [validateImportable, setValidateImportable] = useState<boolean | undefined>(undefined);

  // --- attach ---
  const [candidates, setCandidates] = useState<AttachCandidate[] | null>(null);

  const markDirty = () => setDirty(true);

  const applyState = useCallback((s: Record<string, any>) => {
    loadedRef.current = s || {};
    setSparkVersion(s.sparkVersion || '3.5');
    setNodeSizeFamily(s.nodeSizeFamily || 'MemoryOptimized');
    setNodeSize(s.nodeSize || 'Small');
    setAutoscaleEnabled(s.autoscaleEnabled !== false);
    setNodeCount(Number(s.nodeCount) || 3);
    setMinNodeCount(Number(s.minNodeCount) || 3);
    setMaxNodeCount(Number(s.maxNodeCount) || 10);
    setAutoPauseEnabled(s.autoPauseEnabled !== false);
    setAutoPauseDelay(Number(s.autoPauseDelay) || 15);
    setSessionLevelPackages(s.sessionLevelPackagesEnabled !== false);
    setRequirementsType(s.requirementsType === 'conda' ? 'conda' : 'pip');
    setRequirementsContent(s.requirementsContent || '');
    setImportChecksText(Array.isArray(s.importChecks) ? s.importChecks.join('\n') : '');
    setSparkPropsJson(JSON.stringify(s.sparkProperties || {}, null, 0));
    setCustomLibraries(Array.isArray(s.customLibraries) ? s.customLibraries : []);
    setPublishedToPool(s.publishedToPool || null);
    setPublishedAt(s.publishedAt || null);
    setPublishStatus(s.publishStatus || null);
    if (s.publishedToPool && !targetPool) setTargetPool(s.publishedToPool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setLoadErr(null);
    try {
      const r = await fetch(`/api/items/spark-environment/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      if (!dirty) applyState(j.item?.state || {});
      else { loadedRef.current = j.item?.state || {}; setCustomLibraries(Array.isArray(j.item?.state?.customLibraries) ? j.item.state.customLibraries : []); }
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id, dirty, applyState]);

  useEffect(() => { reload(); }, [reload]);

  // load pools
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/items/synapse-spark-pool/list');
        const j = await r.json();
        if (j.ok) setPools(j.pools || []);
      } catch { /* surfaced via publish action */ }
    })();
  }, []);

  const buildState = useCallback(() => {
    let sparkProperties: Record<string, string> = {};
    try { sparkProperties = JSON.parse(sparkPropsJson || '{}'); } catch { sparkProperties = {}; }
    const importChecks = importChecksText.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      ...loadedRef.current, // preserve server-managed fields (customLibraries, publish*, attach*, validateRuns)
      sparkVersion, nodeSizeFamily, nodeSize,
      autoscaleEnabled, nodeCount, minNodeCount, maxNodeCount,
      autoPauseEnabled, autoPauseDelay,
      sessionLevelPackagesEnabled: sessionLevelPackages,
      requirementsType, requirementsContent,
      importChecks,
      sparkProperties,
    };
  }, [sparkPropsJson, importChecksText, sparkVersion, nodeSizeFamily, nodeSize, autoscaleEnabled,
      nodeCount, minNodeCount, maxNodeCount, autoPauseEnabled, autoPauseDelay, sessionLevelPackages,
      requirementsType, requirementsContent]);

  const save = useCallback(async (): Promise<boolean> => {
    setBusy(true); setErr(null); setMsg('Saving…');
    try {
      const r = await fetch(`/api/items/spark-environment/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: buildState() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      loadedRef.current = j.item?.state || loadedRef.current;
      setDirty(false);
      setMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      return true;
    } catch (e: any) { setErr(e?.message || String(e)); setMsg(null); return false; }
    finally { setBusy(false); }
  }, [id, buildState]);

  // Ctrl+S → Save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (id !== 'new' && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, dirty, busy, save]);

  // --- custom library upload / delete ---
  const onPickFile = () => fileRef.current?.click();
  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true); setErr(null); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', file.name.toLowerCase().endsWith('.jar') ? 'jar' : 'whl');
      const r = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/libraries`, { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'upload failed')); return; }
      setCustomLibraries(j.customLibraries || []);
      setMsg(`Uploaded ${j.library?.name}`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setUploading(false); }
  };
  const deleteLib = async (name: string) => {
    setUploading(true); setErr(null);
    try {
      const r = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/libraries?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'delete failed'); return; }
      setCustomLibraries(j.customLibraries || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setUploading(false); }
  };

  // --- publish ---
  const publish = useCallback(async () => {
    if (!targetPool) { setErr('Select a target Spark pool first.'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (dirty) { const ok = await save(); if (!ok) return; }
      const r = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poolName: targetPool, applyCompute }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'publish failed')); return; }
      setPublishedToPool(j.poolName);
      setPublishedAt(j.publishedAt);
      setPublishStatus(j.publishStatus);
      setMsg(j.hint || `Published to "${j.poolName}" (${j.provisioningState}).`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [targetPool, applyCompute, dirty, id, save]);

  // --- validate import (live Livy session, polled) ---
  const validate = useCallback(async () => {
    if (!targetPool) { setErr('Select a target Spark pool first.'); return; }
    setValidateBusy(true); setErr(null); setValidateOutput(null); setValidateImportable(undefined);
    setValidateStatus('starting session…');
    try {
      if (dirty) { const ok = await save(); if (!ok) { setValidateBusy(false); return; } }
      const r = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poolName: targetPool }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'validate failed'); setValidateBusy(false); setValidateStatus(null); return; }
      let runId: string = j.runId;
      const deadline = Date.now() + 5 * 60_000; // 5 min cap (Spark cold start)
      // poll
      // eslint-disable-next-line no-constant-condition
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 4000));
        const pr = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/validate?runId=${encodeURIComponent(runId)}`);
        const pj = await pr.json();
        if (!pj.ok) { setErr(pj.error || 'poll failed'); break; }
        if (pj.runId) runId = pj.runId;
        setValidateStatus(pj.status || pj.phase || 'running');
        if (pj.status === 'available' || pj.output) {
          if (pj.output?.status === 'ok') {
            setValidateOutput(pj.output.textPlain || '(no output)');
            setValidateImportable(pj.importable);
          } else if (pj.output?.status === 'error') {
            setValidateOutput(`${pj.output.ename || 'error'}: ${pj.output.evalue || ''}\n${(pj.output.traceback || []).join('')}`);
            setValidateImportable(false);
          }
          break;
        }
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setValidateBusy(false); setValidateStatus(null); }
  }, [targetPool, dirty, id, save]);

  // --- attach ---
  const loadCandidates = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/attach`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'load candidates failed'); return; }
      setCandidates(j.candidates || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  const toggleAttach = async (c: AttachCandidate) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/spark-environment/${encodeURIComponent(id)}/attach`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetType: c.itemType, targetId: c.id, attach: !c.attached }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'attach failed'); return; }
      await loadCandidates();
      setMsg(`${!c.attached ? 'Attached to' : 'Detached from'} ${c.displayName}`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Environment', actions: [
        { label: dirty ? 'Save' : 'Saved', onClick: (dirty && !busy) ? save : undefined, disabled: !dirty || busy },
      ]},
      { label: 'Publish', actions: [
        { label: busy ? 'Publishing…' : 'Publish', onClick: (!busy && targetPool) ? publish : undefined, disabled: busy || !targetPool, title: !targetPool ? 'Select a target pool' : 'Bake config into the Spark pool' },
        { label: 'Validate import', onClick: (!validateBusy && targetPool) ? validate : undefined, disabled: validateBusy || !targetPool },
      ]},
    ]},
  ], [dirty, busy, targetPool, validateBusy, save, publish, validate]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create Spark environment"
        intro="A Spark environment bundles the runtime version, compute config, public libraries (pip/conda), custom libraries (.whl/.jar), and Spark properties. Create it, then configure and Publish to bake the spec into a Synapse Spark pool — no Microsoft Fabric capacity required." />
    );
  }

  const num = (v: number) => (Number.isFinite(v) ? String(v) : '');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="runtime">Runtime</Tab>
            <Tab value="compute">Compute</Tab>
            <Tab value="public-libs">Public libraries</Tab>
            <Tab value="custom-libs">Custom libraries</Tab>
            <Tab value="spark-props">Spark properties</Tab>
          </TabList>
        </div>

        <div className={styles.tabBody}>
          <ErrBar error={err || loadErr} />
          {loading && <Spinner size="small" label="Loading environment…" labelPosition="after" />}

          {tab === 'runtime' && (
            <>
              <Subtitle2>Runtime</Subtitle2>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Spark runtime version</Caption1>
                  <Dropdown value={SPARK_VERSIONS.find((x) => x.v === sparkVersion)?.label || sparkVersion}
                    selectedOptions={[sparkVersion]}
                    onOptionSelect={(_, d) => { setSparkVersion(d.optionValue || '3.5'); markDirty(); }}>
                    {SPARK_VERSIONS.map((x) => <Option key={x.v} value={x.v}>{x.label}</Option>)}
                  </Dropdown>
                </div>
                <div className={styles.field}>
                  <Caption1>Node family</Caption1>
                  <Dropdown value={nodeSizeFamily} selectedOptions={[nodeSizeFamily]}
                    onOptionSelect={(_, d) => { setNodeSizeFamily(d.optionValue || 'MemoryOptimized'); markDirty(); }}>
                    <Option value="MemoryOptimized">MemoryOptimized</Option>
                    <Option value="HardwareAcceleratedGPU">HardwareAcceleratedGPU</Option>
                  </Dropdown>
                </div>
              </div>
              {sparkVersion === '3.4' && (
                <MessageBar intent="warning">
                  <MessageBarBody><MessageBarTitle>Deprecated runtime</MessageBarTitle>
                    Spark 3.4 reaches end of support 2026-03. Upgrade to 3.5 (GA) for new environments.
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}

          {tab === 'compute' && (
            <>
              <Subtitle2>Compute</Subtitle2>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Node size</Caption1>
                  <Dropdown value={nodeSize} selectedOptions={[nodeSize]}
                    onOptionSelect={(_, d) => { setNodeSize(d.optionValue || 'Small'); markDirty(); }}>
                    {NODE_SIZES.map((n) => <Option key={n} value={n}>{n}</Option>)}
                  </Dropdown>
                </div>
              </div>
              <Switch checked={autoscaleEnabled} label="Autoscale"
                onChange={(_, d) => { setAutoscaleEnabled(!!d.checked); markDirty(); }} />
              {autoscaleEnabled ? (
                <div className={styles.row}>
                  <div className={styles.field}>
                    <Caption1>Min nodes (≥ 3)</Caption1>
                    <Input type="number" value={num(minNodeCount)}
                      onChange={(_, d) => { setMinNodeCount(Math.max(3, Number(d.value) || 3)); markDirty(); }} />
                  </div>
                  <div className={styles.field}>
                    <Caption1>Max nodes</Caption1>
                    <Input type="number" value={num(maxNodeCount)}
                      onChange={(_, d) => { setMaxNodeCount(Number(d.value) || 10); markDirty(); }} />
                  </div>
                </div>
              ) : (
                <div className={styles.row}>
                  <div className={styles.field}>
                    <Caption1>Node count (≥ 3)</Caption1>
                    <Input type="number" value={num(nodeCount)}
                      onChange={(_, d) => { setNodeCount(Math.max(3, Number(d.value) || 3)); markDirty(); }} />
                  </div>
                </div>
              )}
              <Switch checked={autoPauseEnabled} label="Auto-pause when idle"
                onChange={(_, d) => { setAutoPauseEnabled(!!d.checked); markDirty(); }} />
              {autoPauseEnabled && (
                <div className={styles.row}>
                  <div className={styles.field}>
                    <Caption1>Idle minutes before pause (≥ 5)</Caption1>
                    <Input type="number" value={num(autoPauseDelay)}
                      onChange={(_, d) => { setAutoPauseDelay(Math.max(5, Number(d.value) || 5)); markDirty(); }} />
                  </div>
                </div>
              )}
              <Switch checked={sessionLevelPackages} label="Session-level packages (allow %pip / %conda in sessions)"
                onChange={(_, d) => { setSessionLevelPackages(!!d.checked); markDirty(); }} />
            </>
          )}

          {tab === 'public-libs' && (
            <>
              <Subtitle2>Public libraries</Subtitle2>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Format</Caption1>
                  <Dropdown value={requirementsType === 'conda' ? 'conda (environment.yml)' : 'pip (requirements.txt)'}
                    selectedOptions={[requirementsType]}
                    onOptionSelect={(_, d) => { setRequirementsType((d.optionValue as 'pip' | 'conda') || 'pip'); markDirty(); }}>
                    <Option value="pip">pip (requirements.txt)</Option>
                    <Option value="conda">conda (environment.yml)</Option>
                  </Dropdown>
                </div>
              </div>
              <Caption1>{requirementsType === 'conda'
                ? 'Conda environment.yml — packages resolved from conda-forge at session start.'
                : 'requirements.txt — one PyPI spec per line (e.g. pandas==2.2.2).'}</Caption1>
              <Textarea value={requirementsContent} rows={9}
                onChange={(_, d) => { setRequirementsContent(d.value); markDirty(); }}
                placeholder={requirementsType === 'conda'
                  ? 'name: loom-env\nchannels:\n  - conda-forge\ndependencies:\n  - scikit-learn=1.4.2'
                  : 'pandas==2.2.2\nscikit-learn==1.4.2\nmlflow==2.13.0'} />
              <Caption1>Import-check modules (optional, one per line) — used by Validate import.
                Defaults to the package names above.</Caption1>
              <Textarea value={importChecksText} rows={3}
                onChange={(_, d) => { setImportChecksText(d.value); markDirty(); }}
                placeholder={'pandas\nsklearn\nmlflow'} />
              <MessageBar intent="info">
                <MessageBarBody>
                  In Managed-VNet / IL5 workspaces with data-exfiltration prevention, public PyPI / conda
                  feeds are blocked. Upload pre-pinned <code>.whl</code> files on the Custom libraries tab
                  instead, or provision Managed Private Endpoints to an approved mirror.
                </MessageBarBody>
              </MessageBar>
            </>
          )}

          {tab === 'custom-libs' && (
            <>
              <Subtitle2>Custom libraries</Subtitle2>
              <Caption1>Upload <code>.whl</code> or <code>.jar</code> files. They are staged to the
                ADLS <code>landing</code> container and referenced as pool custom libraries on publish.</Caption1>
              <input ref={fileRef} type="file" accept=".whl,.jar" style={{ display: 'none' }} onChange={onFileChange} />
              <div className={styles.toolbar}>
                <Button appearance="primary" icon={<ArrowUpload20Regular />} onClick={onPickFile} disabled={uploading}>
                  Upload .whl / .jar
                </Button>
                {uploading && <Spinner size="tiny" />}
              </div>
              {customLibraries.length === 0 ? (
                <Caption1>No custom libraries uploaded yet.</Caption1>
              ) : (
                <Table size="small" aria-label="Custom libraries">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Path</TableHeaderCell>
                      <TableHeaderCell>Size</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customLibraries.map((l) => (
                      <TableRow key={l.name}>
                        <TableCell>{l.name}</TableCell>
                        <TableCell><Badge appearance="outline">{l.type || 'whl'}</Badge></TableCell>
                        <TableCell className={styles.mono}>{l.containerName || 'landing'}/{l.path}</TableCell>
                        <TableCell>{typeof l.size === 'number' ? `${(l.size / 1024).toFixed(0)} KB` : '—'}</TableCell>
                        <TableCell>
                          <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete ${l.name}`}
                            disabled={uploading} onClick={() => deleteLib(l.name)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}

          {tab === 'spark-props' && (
            <>
              <Subtitle2>Spark properties</Subtitle2>
              <Caption1>Key/value pairs written to <code>spark-defaults.conf</code> and baked onto the pool.</Caption1>
              <KeyValueGrid value={sparkPropsJson} onChange={(v) => { setSparkPropsJson(v); markDirty(); }}
                keyLabel="Property" valueLabel="Value"
                keyPlaceholder="spark.sql.shuffle.partitions" valuePlaceholder="200" addLabel="Add property" />
            </>
          )}

          {msg && <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}
        </div>

        {/* ---- Publish / Validate / Attach footer ---- */}
        <div className={styles.footer}>
          <Subtitle2>Publish</Subtitle2>
          <div className={styles.toolbar}>
            <div className={styles.field} style={{ maxWidth: 320 }}>
              <Caption1>Target Spark pool</Caption1>
              <Dropdown value={targetPool} selectedOptions={targetPool ? [targetPool] : []}
                onOptionSelect={(_, d) => setTargetPool(d.optionValue || '')}>
                {pools.length === 0 && <Option value="">(no pools — check LOOM_SYNAPSE_WORKSPACE)</Option>}
                {pools.map((p) => (
                  <Option key={p.name} value={p.name}>
                    {p.properties?.sparkVersion ? `${p.name} (Spark ${p.properties.sparkVersion})` : p.name}
                  </Option>
                ))}
              </Dropdown>
            </div>
            <Checkbox checked={applyCompute} label="Apply compute settings to pool"
              onChange={(_, d) => setApplyCompute(!!d.checked)} />
          </div>
          <div className={styles.toolbar}>
            <Button appearance="primary" icon={<Rocket20Regular />} onClick={publish} disabled={busy || !targetPool}>
              {busy ? 'Publishing…' : 'Publish'}
            </Button>
            <Button icon={<Beaker20Regular />} onClick={validate} disabled={validateBusy || !targetPool}>
              {validateBusy ? 'Validating…' : 'Validate import'}
            </Button>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            {(busy || validateBusy) && <Spinner size="tiny" />}
          </div>

          {publishedToPool && (
            <MessageBar intent={publishStatus === 'succeeded' ? 'success' : 'warning'}>
              <MessageBarBody>
                <MessageBarTitle>
                  {publishStatus === 'succeeded' ? 'Published' : 'Publishing (async)'}
                </MessageBarTitle>
                Pool <strong>{publishedToPool}</strong>
                {publishedAt && ` · ${new Date(publishedAt).toLocaleString()}`}
                {publishStatus !== 'succeeded' && ' · pool is installing libraries — this can take several minutes.'}
              </MessageBarBody>
            </MessageBar>
          )}

          {(validateStatus || validateOutput) && (
            <>
              {validateImportable !== undefined && (
                <MessageBar intent={validateImportable ? 'success' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>{validateImportable ? 'Packages importable' : 'Import failed'}</MessageBarTitle>
                    {validateImportable
                      ? 'Live Spark session installed and imported the libraries.'
                      : 'One or more modules failed to install/import — see output below.'}
                  </MessageBarBody>
                </MessageBar>
              )}
              {validateStatus && validateBusy && <Caption1>Live session: {validateStatus}…</Caption1>}
              {validateOutput && <pre className={styles.pre}>{validateOutput}</pre>}
            </>
          )}

          <Subtitle2>Attach to notebooks &amp; Spark job definitions</Subtitle2>
          <div className={styles.toolbar}>
            <Button icon={<Link20Regular />} onClick={loadCandidates} disabled={busy}>
              {candidates === null ? 'Load items' : 'Refresh items'}
            </Button>
            {!publishedToPool && candidates !== null && (
              <Caption1>Publish first so attached items default to the published pool.</Caption1>
            )}
          </div>
          {candidates && candidates.length === 0 && <Caption1>No notebooks or Spark job definitions in your workspaces yet.</Caption1>}
          {candidates && candidates.length > 0 && (
            <Table size="small" aria-label="Attach candidates">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Item</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Attached</TableHeaderCell>
                  <TableHeaderCell></TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={`${c.itemType}:${c.id}`}>
                    <TableCell>{c.displayName}</TableCell>
                    <TableCell><Badge appearance="outline">{c.itemType}</Badge></TableCell>
                    <TableCell>
                      <Badge appearance="outline" color={c.attached ? 'success' : 'informative'}>
                        {c.attached ? 'attached' : 'no'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button size="small" appearance={c.attached ? 'subtle' : 'secondary'}
                        disabled={busy} onClick={() => toggleAttach(c)}>
                        {c.attached ? 'Detach' : 'Attach'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </>
    } />
  );
}
