'use client';

/**
 * ComputePicker — shared dropdown + lifecycle controls for any editor that
 * executes against an Azure compute target.
 *
 * Backed by /api/loom/compute-targets (returns the unified Synapse Spark /
 * Databricks cluster / Synapse Dedicated SQL / Synapse Serverless list) and
 * /api/loom/compute-targets/[id]/[verb] (start / stop / restart routed to
 * the right Azure REST per kind).
 *
 * Used by:
 *   - notebook-editor (already inlined the same pattern — left intact)
 *   - DbtJobEditor                (Databricks cluster)
 *   - MlModelEditor / MlExperimentEditor (Spark + Databricks)
 *   - WarehouseEditor             (Synapse Dedicated SQL pool — needs Resume)
 *   - SynapseSparkPoolEditor      (Synapse Spark)
 *   - SynapseDedicatedSqlPoolEditor (Synapse Dedicated SQL pool selector)
 *
 * Failures (list fetch, lifecycle POST) surface verbatim via MessageBar —
 * no mock data, per no-vaporware.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Select, Caption1, Button, Badge, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Switch, Divider, Tooltip, tokens, makeStyles,
} from '@fluentui/react-components';
import {
  Play16Regular, Pause16Regular, ArrowSync16Regular, Add16Regular, Delete16Regular,
} from '@fluentui/react-icons';
import { SPARK_PRESETS, findPreset, databricksConfFor, COMMON_SPARK_CONF_KEYS } from '@/lib/spark/config-presets';

export type ComputeKind = 'synapse-spark' | 'databricks-cluster' | 'synapse-dedicated-sql' | 'synapse-serverless-sql';

export interface ComputeTarget {
  id: string;
  name: string;
  kind: ComputeKind;
  state?: string;
  sku?: string;
  nodeSize?: string;
  runEndpoint: string;
}

interface UseComputes {
  computes: ComputeTarget[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

// Module-level shared fetch for /api/loom/compute-targets: dedupe concurrent
// callers + a short TTL so the many ComputePickers a heavy editor mounts at once
// share ONE request instead of storming the BFF (~74 calls were observed on the
// lakehouse editor open). Explicit reload() forces past the cache. rel-T09e.
let _computesCache: { at: number; data: ComputeTarget[] } | null = null;
let _computesInFlight: Promise<ComputeTarget[]> | null = null;
const COMPUTES_TTL_MS = 15_000;

function fetchComputesShared(force = false): Promise<ComputeTarget[]> {
  if (!force && _computesCache && Date.now() - _computesCache.at < COMPUTES_TTL_MS) {
    return Promise.resolve(_computesCache.data);
  }
  if (_computesInFlight) return _computesInFlight;
  _computesInFlight = fetch('/api/loom/compute-targets')
    .then(r => r.json())
    .then(j => {
      if (!j.ok) throw new Error(j.error || 'failed');
      const all = (j.computes || []) as ComputeTarget[];
      _computesCache = { at: Date.now(), data: all };
      return all;
    })
    .finally(() => { _computesInFlight = null; });
  return _computesInFlight;
}

/**
 * Subscribe to /api/loom/compute-targets. Optional `filter` narrows the
 * returned list to specific kinds (e.g. only Databricks clusters).
 */
export function useComputes(filter?: ComputeKind[]): UseComputes {
  const [computes, setComputes] = useState<ComputeTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Depend on the filter CONTENTS (a stable string), not the array identity —
  // callers pass a fresh `[...]` literal each render, which otherwise churned
  // `reload`'s identity and re-fired the effect on every render (rel-T09e).
  const filterKey = filter ? filter.join(',') : '';

  const reload = useCallback((force = false) => {
    setLoading(true); setError(null);
    fetchComputesShared(force)
      .then(all => {
        const kinds = filterKey ? filterKey.split(',') : null;
        setComputes(kinds ? all.filter(c => kinds.includes(c.kind)) : all);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [filterKey]);

  const forceReload = useCallback(() => reload(true), [reload]);
  useEffect(() => { reload(); }, [reload]);
  return { computes, loading, error, reload: forceReload };
}

function isPaused(state?: string): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === 'paused' || s === 'stopped' || s === 'terminated';
}

function isRunning(state?: string): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === 'running' || s === 'online' || s === 'available';
}

interface NodeTypeOption { node_type_id: string; label: string; category?: string }
interface SparkVersionOption { key: string; name: string }

interface DbxConfRow { id: number; key: string; value: string; }
let dbxRowSeq = 1;
const dbxRecordToRows = (rec: Record<string, string> | undefined): DbxConfRow[] =>
  Object.entries(rec || {}).map(([key, value]) => ({ id: dbxRowSeq++, key, value }));
const dbxRowsToRecord = (rows: DbxConfRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) { const k = r.key.trim(); if (k) out[k] = r.value; }
  return out;
};

const useDialogStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalS, maxHeight: '70vh', overflowY: 'auto', minWidth: '460px' },
  twoCol: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  col: { flex: '1 1 200px', minWidth: 0 },
  toggles: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', alignItems: 'center' },
  presetDesc: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  confHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  confRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  confKey: { flex: '1 1 55%', minWidth: 0 },
  confVal: { flex: '1 1 45%', minWidth: 0 },
  confList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontStyle: 'italic' },
});

const DBX_PRESETS = SPARK_PRESETS.filter((p) => p.targets.includes('databricks'));

/**
 * NewClusterDialog — guided (no-JSON) creation of a Databricks interactive
 * cluster. A best-practice PRESET picker (different cluster shapes per work
 * type) applies autoscale bounds + Photon + Spot + auto-terminate + curated
 * spark_conf in one click; every field below is a dropdown/toggle sourced from
 * real Databricks metadata (spark-versions, list-node-types), and a structured
 * key/value spark_conf builder fine-tunes the confs (no JSON). Only the cluster
 * name is free text (the one field the global no-freeform rule allows). POSTs to
 * /api/loom/compute-targets and hands the new id back so the picker selects it.
 */
function NewClusterDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (newId: string) => void;
}) {
  const s = useDialogStyles();
  const [loadingOpts, setLoadingOpts] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeOption[]>([]);
  const [versions, setVersions] = useState<SparkVersionOption[]>([]);
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('balanced');
  const [sparkVersion, setSparkVersion] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [minWorkers, setMinWorkers] = useState('2');
  const [maxWorkers, setMaxWorkers] = useState('4');
  const [photon, setPhoton] = useState(true);
  const [spot, setSpot] = useState(false);
  const [autoterm, setAutoterm] = useState('30');
  const [confRows, setConfRows] = useState<DbxConfRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Apply a preset's cluster shape + curated spark_conf to the form.
  const applyPreset = useCallback((id: string) => {
    setPresetId(id);
    const p = findPreset(id);
    if (!p) { setConfRows([]); return; }
    const sh = p.databricks;
    setMinWorkers(String(sh.minWorkers));
    setMaxWorkers(String(sh.maxWorkers));
    setPhoton(sh.photon);
    setSpot(!!sh.spot);
    setAutoterm(String(sh.autoterminationMinutes));
    setConfRows(dbxRecordToRows(databricksConfFor(p)));
    // Try to honor the preset's runtime channel (lts/ml/latest) against the
    // discovered versions; fall back to whatever is selected.
    setVersions((vs) => {
      const want = sh.runtimeChannel;
      if (want && vs.length) {
        const re = want === 'ml' ? /ml/i : want === 'latest' ? /./ : /lts/i;
        const hit = vs.find((v) => re.test(v.name));
        if (hit) setSparkVersion(hit.key);
      }
      return vs;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoadingOpts(true); setOptError(null);
    fetch('/api/loom/compute-targets/databricks-options')
      .then(r => r.json())
      .then(j => {
        if (!j.ok) { setOptError(j.error || 'Databricks not configured'); return; }
        const nt = (j.nodeTypes || []) as NodeTypeOption[];
        const vs = (j.sparkVersions || []) as SparkVersionOption[];
        setNodeTypes(nt); setVersions(vs);
        if (vs.length) setSparkVersion(prev => prev || vs[0].key);
        if (nt.length) setNodeType(prev => prev || nt[0].node_type_id);
        // Seed the form from the default preset on first open.
        applyPreset(presetId);
      })
      .catch(e => setOptError(e?.message || String(e)))
      .finally(() => setLoadingOpts(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useCallback(async () => {
    setCreating(true); setCreateError(null);
    try {
      const minW = Number(minWorkers), maxW = Number(maxWorkers);
      const r = await fetch('/api/loom/compute-targets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'databricks-cluster',
          cluster_name: name.trim(),
          spark_version: sparkVersion,
          node_type_id: nodeType,
          presetId: presetId || undefined,
          spark_conf: dbxRowsToRecord(confRows),
          photon,
          spot,
          min_workers: minW,
          max_workers: maxW,
          autotermination_minutes: Number(autoterm),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateError(j.error || 'create failed'); return; }
      onCreated(j.created?.id || '');
      onOpenChange(false);
    } catch (e: any) { setCreateError(e?.message || String(e)); }
    finally { setCreating(false); }
  }, [name, sparkVersion, nodeType, presetId, confRows, photon, spot, minWorkers, maxWorkers, autoterm, onCreated, onOpenChange]);

  const activePreset = findPreset(presetId);
  const ready = name.trim() && sparkVersion && nodeType && !creating;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New Databricks cluster</DialogTitle>
          <DialogContent>
            {loadingOpts && <Spinner size="tiny" label="Loading cluster options from Databricks…" />}
            {optError && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Databricks not available</MessageBarTitle>
                  {optError}
                </MessageBarBody>
              </MessageBar>
            )}
            {!loadingOpts && !optError && (
              <div className={s.body}>
                {/* Best-practice preset — different cluster shapes per work type */}
                <Field label="Configuration preset" hint={activePreset ? activePreset.whenToUse : 'Pick a best-practice cluster profile, then fine-tune below.'}>
                  <Select value={presetId} onChange={(_, d) => applyPreset(d.value)}>
                    <option value="">Custom (no preset)</option>
                    {DBX_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </Select>
                </Field>
                {activePreset && <Caption1 className={s.presetDesc}>{activePreset.summary}</Caption1>}

                <Divider />

                <Field label="Cluster name" required>
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. loom-interactive-01" />
                </Field>
                <div className={s.twoCol}>
                  <Field label="Databricks runtime" required className={s.col}>
                    <Select value={sparkVersion} onChange={(_, d) => setSparkVersion(d.value)}>
                      {versions.map(v => <option key={v.key} value={v.key}>{v.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Node type" required className={s.col}>
                    <Select value={nodeType} onChange={(_, d) => setNodeType(d.value)}>
                      {nodeTypes.map(n => <option key={n.node_type_id} value={n.node_type_id}>{n.label}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className={s.twoCol}>
                  <Field label="Min workers (autoscale)" className={s.col}>
                    <Select value={minWorkers} onChange={(_, d) => setMinWorkers(d.value)}>
                      {['0', '1', '2', '4', '8'].map(w => <option key={w} value={w}>{w}</option>)}
                    </Select>
                  </Field>
                  <Field label="Max workers (autoscale)" className={s.col}>
                    <Select value={maxWorkers} onChange={(_, d) => setMaxWorkers(d.value)}>
                      {['1', '2', '4', '8', '12', '16'].map(w => <option key={w} value={w}>{w}</option>)}
                    </Select>
                  </Field>
                </div>
                <Field label="Auto-terminate after">
                  <Select value={autoterm} onChange={(_, d) => setAutoterm(d.value)}>
                    {['10', '30', '60', '120', '0'].map(m => (
                      <option key={m} value={m}>{m === '0' ? 'Never (not recommended)' : `${m} minutes idle`}</option>
                    ))}
                  </Select>
                </Field>
                <div className={s.toggles}>
                  <Switch checked={photon} onChange={(_, d) => setPhoton(d.checked)} label="Photon (vectorized engine)" />
                  <Switch checked={spot} onChange={(_, d) => setSpot(d.checked)} label="Spot workers (cost-optimized)" />
                </div>

                <Divider />

                {/* Structured spark_conf builder (key/value rows — no JSON) */}
                <div className={s.confHeader}>
                  <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Spark configuration</Caption1>
                  <Button size="small" appearance="outline" icon={<Add16Regular />}
                    onClick={() => setConfRows((r) => [...r, { id: dbxRowSeq++, key: '', value: '' }])}>
                    Add property
                  </Button>
                </div>
                {confRows.length === 0 ? (
                  <Caption1 className={s.empty}>No custom Spark properties. Pick a preset above or add a property.</Caption1>
                ) : (
                  <div className={s.confList}>
                    <datalist id="loom-dbx-conf-keys">
                      {COMMON_SPARK_CONF_KEYS.filter((k) => k.key !== 'spark.dynamicAllocation.enabled').map((k) => (
                        <option key={k.key} value={k.key}>{k.hint}</option>
                      ))}
                    </datalist>
                    {confRows.map((row, i) => {
                      const known = COMMON_SPARK_CONF_KEYS.find((k) => k.key === row.key.trim());
                      return (
                        <div key={row.id} className={s.confRow}>
                          <Tooltip content={known ? known.hint : 'spark.* property key'} relationship="label">
                            <Input className={s.confKey} aria-label={`Spark property key ${i + 1}`} placeholder="spark.sql.shuffle.partitions"
                              list="loom-dbx-conf-keys" value={row.key}
                              onChange={(_, d) => setConfRows(confRows.map((r) => r.id === row.id ? { ...r, key: d.value } : r))} />
                          </Tooltip>
                          <Input className={s.confVal} aria-label={`Spark property value ${i + 1}`} placeholder="value"
                            value={row.value}
                            onChange={(_, d) => setConfRows(confRows.map((r) => r.id === row.id ? { ...r, value: d.value } : r))} />
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Remove property"
                            onClick={() => setConfRows(confRows.filter((r) => r.id !== row.id))} />
                        </div>
                      );
                    })}
                  </div>
                )}

                {createError && (
                  <MessageBar intent="error"><MessageBarBody>{createError}</MessageBarBody></MessageBar>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button appearance="primary" onClick={create} disabled={!ready || !!optError}>
              {creating ? 'Creating…' : 'Create cluster'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export interface ComputePickerProps {
  /** Currently selected compute id. */
  value: string;
  onChange: (id: string) => void;
  /** Restrict to a subset of kinds. */
  filter?: ComputeKind[];
  /** Label shown above the dropdown. */
  label?: string;
  /** Show start/stop/resume actions when compute exposes that lifecycle. */
  showLifecycle?: boolean;
  /** Show the "New cluster" button (Databricks cluster creation). Default true. */
  allowCreate?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '280px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
});

export function ComputePicker({ value, onChange, filter, label, showLifecycle = true, allowCreate = true }: ComputePickerProps) {
  const s = useStyles();
  const { computes, loading, error, reload } = useComputes(filter);
  const selected = computes.find(c => c.id === value);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  // "New cluster" only makes sense when Databricks clusters are in scope.
  const canCreate = allowCreate && (!filter || filter.includes('databricks-cluster'));

  const lifecycleAction = useCallback(async (verb: 'start' | 'stop' | 'restart') => {
    if (!selected) return;
    setActionBusy(verb); setActionMsg(null);
    try {
      const r = await fetch(`/api/loom/compute-targets/${encodeURIComponent(selected.id)}/${verb}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setActionMsg(j.error || `${verb} failed`);
      else { setActionMsg(`${verb} requested — state will update shortly`); reload(); }
    } catch (e: any) { setActionMsg(e?.message || String(e)); }
    finally { setActionBusy(null); }
  }, [selected, reload]);

  const stateBadge = (state?: string) => {
    const color: 'success' | 'warning' | 'informative' = isRunning(state) ? 'success' : isPaused(state) ? 'warning' : 'informative';
    return <Badge color={color} size="small">{state || 'unknown'}</Badge>;
  };

  return (
    <div className={s.root}>
      <Caption1>{label || 'Compute target'}</Caption1>
      <div className={s.row}>
        <Select
          value={value}
          onChange={(_, d) => onChange(d.value)}
          disabled={loading || computes.length === 0}
          style={{ flex: 1, minWidth: 220 }}
        >
          {!value && <option value="">{loading ? 'Loading…' : computes.length ? 'Select compute' : 'No compute configured'}</option>}
          {computes.map(c => (
            <option key={c.id} value={c.id}>{c.name}{c.state ? ` · ${c.state}` : ''}</option>
          ))}
        </Select>
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={reload} disabled={loading} title="Refresh compute list" />
        {canCreate && (
          <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => setNewOpen(true)} title="Create a new Databricks cluster">
            New cluster
          </Button>
        )}
      </div>
      {canCreate && (
        <NewClusterDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          onCreated={(newId) => { reload(); if (newId) onChange(newId); }}
        />
      )}
      {selected && (
        <div className={s.row}>
          {stateBadge(selected.state)}
          {selected.sku && <Caption1>SKU: {selected.sku}</Caption1>}
          {selected.nodeSize && <Caption1>· {selected.nodeSize}</Caption1>}
        </div>
      )}
      {selected && showLifecycle && (
        <div className={s.row}>
          {isPaused(selected.state) && (
            <Button size="small" appearance="primary" icon={<Play16Regular />}
              onClick={() => lifecycleAction('start')} disabled={actionBusy !== null}>
              {actionBusy === 'start' ? 'Starting…' : 'Resume'}
            </Button>
          )}
          {isRunning(selected.state) && selected.kind !== 'synapse-serverless-sql' && (
            <Button size="small" appearance="secondary" icon={<Pause16Regular />}
              onClick={() => lifecycleAction('stop')} disabled={actionBusy !== null}>
              {actionBusy === 'stop' ? 'Stopping…' : 'Pause'}
            </Button>
          )}
          {(selected.kind === 'databricks-cluster') && (
            <Button size="small" appearance="subtle"
              onClick={() => lifecycleAction('restart')} disabled={actionBusy !== null}>
              {actionBusy === 'restart' ? 'Restarting…' : 'Restart'}
            </Button>
          )}
        </div>
      )}
      {actionMsg && (
        <MessageBar intent="info" style={{ marginTop: 4 }}>
          <MessageBarBody>{actionMsg}</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Compute not reachable</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {loading && <Spinner size="tiny" label="Loading compute…" />}
    </div>
  );
}
