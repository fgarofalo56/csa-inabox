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
  Field, Input, makeStyles,
} from '@fluentui/react-components';
import { Play16Regular, Pause16Regular, ArrowSync16Regular, Add16Regular } from '@fluentui/react-icons';

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

/**
 * Subscribe to /api/loom/compute-targets. Optional `filter` narrows the
 * returned list to specific kinds (e.g. only Databricks clusters).
 */
export function useComputes(filter?: ComputeKind[]): UseComputes {
  const [computes, setComputes] = useState<ComputeTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true); setError(null);
    fetch('/api/loom/compute-targets')
      .then(r => r.json())
      .then(j => {
        if (!j.ok) { setError(j.error || 'failed'); return; }
        const all = (j.computes || []) as ComputeTarget[];
        setComputes(filter ? all.filter(c => filter.includes(c.kind)) : all);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { reload(); }, [reload]);
  return { computes, loading, error, reload };
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

/**
 * NewClusterDialog — guided (no-JSON) creation of a Databricks interactive
 * cluster. Every field is a dropdown sourced from real Databricks metadata
 * (spark-versions, list-node-types); only the cluster name is free text (the
 * one field the global no-freeform rule allows). POSTs to
 * /api/loom/compute-targets and hands the new id back so the picker selects it.
 */
function NewClusterDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (newId: string) => void;
}) {
  const [loadingOpts, setLoadingOpts] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeOption[]>([]);
  const [versions, setVersions] = useState<SparkVersionOption[]>([]);
  const [name, setName] = useState('');
  const [sparkVersion, setSparkVersion] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [workers, setWorkers] = useState('2');
  const [autoterm, setAutoterm] = useState('30');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
        // Sensible defaults: first LTS-ish runtime + smallest node.
        if (vs.length) setSparkVersion(prev => prev || vs[0].key);
        if (nt.length) setNodeType(prev => prev || nt[0].node_type_id);
      })
      .catch(e => setOptError(e?.message || String(e)))
      .finally(() => setLoadingOpts(false));
  }, [open]);

  const create = useCallback(async () => {
    setCreating(true); setCreateError(null);
    try {
      const r = await fetch('/api/loom/compute-targets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'databricks-cluster',
          cluster_name: name.trim(),
          spark_version: sparkVersion,
          node_type_id: nodeType,
          num_workers: Number(workers),
          autotermination_minutes: Number(autoterm),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateError(j.error || 'create failed'); return; }
      onCreated(j.created?.id || '');
      onOpenChange(false);
    } catch (e: any) { setCreateError(e?.message || String(e)); }
    finally { setCreating(false); }
  }, [name, sparkVersion, nodeType, workers, autoterm, onCreated, onOpenChange]);

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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
                <Field label="Cluster name" required>
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. loom-interactive-01" />
                </Field>
                <Field label="Databricks runtime" required>
                  <Select value={sparkVersion} onChange={(_, d) => setSparkVersion(d.value)}>
                    {versions.map(v => <option key={v.key} value={v.key}>{v.name}</option>)}
                  </Select>
                </Field>
                <Field label="Node type" required>
                  <Select value={nodeType} onChange={(_, d) => setNodeType(d.value)}>
                    {nodeTypes.map(n => <option key={n.node_type_id} value={n.node_type_id}>{n.label}</option>)}
                  </Select>
                </Field>
                <Field label="Workers">
                  <Select value={workers} onChange={(_, d) => setWorkers(d.value)}>
                    {['0', '1', '2', '4', '8', '16'].map(w => (
                      <option key={w} value={w}>{w === '0' ? 'Single node (0 workers)' : `${w} workers`}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Auto-terminate after">
                  <Select value={autoterm} onChange={(_, d) => setAutoterm(d.value)}>
                    {['10', '30', '60', '120', '0'].map(m => (
                      <option key={m} value={m}>{m === '0' ? 'Never (not recommended)' : `${m} minutes idle`}</option>
                    ))}
                  </Select>
                </Field>
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
