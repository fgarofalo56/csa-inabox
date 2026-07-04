'use client';

/**
 * AdxClusterEditor — Azure Data Explorer cluster lifecycle + scale surface.
 *
 * One-for-one parity with the ADX portal cluster "Overview" + "Configuration"
 * blades, themed Fluent v9 + Loom tokens. Two tabs:
 *   - Overview  — SKU + capacity scale, optimized autoscale toggle (min/max),
 *                 streaming-ingestion toggle. PATCH via /api/admin/scaling/adx.
 *   - Manage    — Stop / Start lifecycle (async 202 receipts) + a Danger zone
 *                 Delete (14-day soft-delete) gated behind a type-the-name
 *                 confirmation. PUT via /api/admin/scaling/adx.
 *
 * Every control hits the real ARM-backed BFF route; no mocks. When the cluster
 * env vars are unset the route 503s and we render an honest infra-gate
 * MessageBar. Autoscale is disabled on Basic/Dev SKUs (ARM rejects it) and we
 * surface that honestly rather than letting the call 400.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  TabList, Tab, Field, Dropdown, Option, Switch, SpinButton, Button, Spinner,
  Badge, Caption1, Input,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Stop20Regular, ArrowSync20Regular, Delete20Regular,
  Warning20Regular,
} from '@fluentui/react-icons';

// The @allowed SKU list from platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep.
const SKUS: { name: string; tier: 'Basic' | 'Standard'; label: string }[] = [
  { name: 'Dev(No SLA)_Standard_E2a_v4', tier: 'Basic', label: 'Dev (No SLA) · Standard_E2a_v4 — single node, no SLA' },
  { name: 'Dev(No SLA)_Standard_D11_v2', tier: 'Basic', label: 'Dev (No SLA) · Standard_D11_v2 — single node, no SLA' },
  { name: 'Standard_E2a_v4', tier: 'Standard', label: 'Standard_E2a_v4 — small prod' },
  { name: 'Standard_E4a_v4', tier: 'Standard', label: 'Standard_E4a_v4 — medium' },
  { name: 'Standard_E8a_v4', tier: 'Standard', label: 'Standard_E8a_v4 — large' },
  { name: 'Standard_E16a_v4', tier: 'Standard', label: 'Standard_E16a_v4 — xlarge' },
];

interface OptimizedAutoscale { isEnabled: boolean; minimum: number; maximum: number; version: number }
interface ClusterArm {
  id: string; name: string; location: string;
  sku: { name: string; tier: string; capacity?: number };
  state?: string; provisioningState?: string;
  optimizedAutoscale?: OptimizedAutoscale;
  enableStreamingIngest?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px', minWidth: '560px' },
  header: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  section: {
    display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px',
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  row: { display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' },
  danger: {
    display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorPaletteRedBorder2}`, background: tokens.colorNeutralBackground2,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

async function readJson(res: Response): Promise<any> {
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { ok: false, error: t || `HTTP ${res.status}` }; }
}

const SCALE_URL = '/api/admin/scaling/adx';

export interface AdxClusterEditorProps {
  /** Optional callback after a lifecycle/scale op completes (e.g. parent refresh). */
  onChanged?: () => void;
}

export function AdxClusterEditor({ onChanged }: AdxClusterEditorProps) {
  const s = useStyles();
  const [tab, setTab] = useState<'overview' | 'manage'>('overview');
  const [cluster, setCluster] = useState<ClusterArm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // Editable form state (seeded from the loaded cluster).
  const [sku, setSku] = useState('');
  const [capacity, setCapacity] = useState<number>(1);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoMin, setAutoMin] = useState<number>(2);
  const [autoMax, setAutoMax] = useState<number>(4);
  const [streaming, setStreaming] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  const skuTier = SKUS.find((x) => x.name === sku)?.tier ?? 'Standard';
  const isBasic = skuTier === 'Basic';

  const seed = useCallback((c: ClusterArm) => {
    setSku(c.sku?.name || '');
    setCapacity(c.sku?.capacity ?? 1);
    setAutoEnabled(!!c.optimizedAutoscale?.isEnabled);
    setAutoMin(c.optimizedAutoscale?.minimum ?? 2);
    setAutoMax(c.optimizedAutoscale?.maximum ?? 4);
    setStreaming(!!c.enableStreamingIngest);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const body = await fetch(SCALE_URL).then(readJson);
      if (!body.ok) {
        if (body?.hint || /not configured|Missing env/i.test(body?.error || '')) {
          setGate(body.error || 'ADX cluster not configured'); setLoading(false); return;
        }
        setError(body.error || 'failed to load cluster'); setLoading(false); return;
      }
      setGate(null);
      setCluster(body.cluster);
      seed(body.cluster);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [seed]);

  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (payload: any, successMsg: string) => {
    setBusy(true); setError(null); setReceipt(null);
    try {
      const body = await fetch(SCALE_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }).then(readJson);
      if (!body.ok) { setError(body.error || 'operation failed'); return; }
      if (body.cluster) { setCluster(body.cluster); seed(body.cluster); }
      setReceipt(`${successMsg} (provisioningState: ${body.cluster?.provisioningState || 'Updating'})`);
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [seed, onChanged]);

  const put = useCallback(async (payload: any, successMsg: string) => {
    setBusy(true); setError(null); setReceipt(null);
    try {
      const body = await fetch(SCALE_URL, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }).then(readJson);
      if (!body.ok) { setError(body.error || 'operation failed'); return; }
      setReceipt(`${successMsg} (provisioningState: ${body.provisioningState || 'Accepted'}). This is an async ARM operation — refresh in 2–5 minutes to see the new state.`);
      onChanged?.();
      // Soft-refresh the cluster shape after a moment-of-truth lifecycle op.
      setTimeout(() => { load(); }, 1500);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [onChanged, load]);

  if (loading) return <Spinner size="small" label="Loading ADX cluster…" />;

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>ADX cluster not configured</MessageBarTitle>
          {gate}. Set <code>LOOM_KUSTO_CLUSTER_NAME</code>, <code>LOOM_KUSTO_RG</code> and{' '}
          <code>LOOM_KUSTO_SUB</code> on loom-console. The Console UAMI needs{' '}
          <strong>Azure Kusto Contributor</strong> at the cluster scope (granted by{' '}
          <code>platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep</code>) to scale, stop,
          start, or delete the cluster.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Badge appearance="filled" color="brand">{cluster?.name || 'ADX cluster'}</Badge>
        <Badge appearance="outline">{cluster?.location || '—'}</Badge>
        <Badge appearance="tint" color={cluster?.state === 'Running' ? 'success' : cluster?.state === 'Stopped' ? 'warning' : 'informative'}>
          {cluster?.state || 'unknown'}
        </Badge>
        <Caption1 className={s.hint}>SKU: <strong>{cluster?.sku?.name}</strong> · capacity {cluster?.sku?.capacity ?? 1} · provisioning {cluster?.provisioningState || '—'}</Caption1>
        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={load} disabled={busy}>Refresh</Button>
      </div>

      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Cluster error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {receipt && <MessageBar intent="success"><MessageBarBody><MessageBarTitle>Accepted</MessageBarTitle>{receipt}</MessageBarBody></MessageBar>}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'overview' | 'manage')}>
        <Tab value="overview">Overview &amp; scale</Tab>
        <Tab value="manage">Manage</Tab>
      </TabList>

      {tab === 'overview' && (
        <>
          <div className={s.section}>
            <strong>Compute size (SKU)</strong>
            <div className={s.row}>
              <Field label="SKU" style={{ minWidth: 360 }}>
                <Dropdown
                  value={SKUS.find((x) => x.name === sku)?.label || sku}
                  selectedOptions={sku ? [sku] : []}
                  onOptionSelect={(_, d) => setSku(d.optionValue || sku)}
                >
                  {SKUS.map((x) => <Option key={x.name} value={x.name} text={x.label}>{x.label}</Option>)}
                </Dropdown>
              </Field>
              <Field label="Instance count">
                <SpinButton min={1} max={1000} value={capacity} onChange={(_, d) => setCapacity(d.value ?? capacity ?? 1)} disabled={autoEnabled} />
              </Field>
              <Button appearance="primary" disabled={busy || !sku} onClick={() => post({ sku, capacity }, 'Scale request submitted')}>
                {busy ? 'Applying…' : 'Apply size'}
              </Button>
            </div>
            <Caption1 className={s.hint}>PATCHes the cluster SKU + capacity (tier derives from the SKU name).</Caption1>
          </div>

          <div className={s.section}>
            <strong>Optimized autoscale</strong>
            {isBasic && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  Autoscale is not available on Basic / Dev(No SLA) SKUs — ARM rejects it. Switch to a Standard SKU first.
                </MessageBarBody>
              </MessageBar>
            )}
            <Switch
              checked={autoEnabled} disabled={isBasic}
              label="Enable optimized autoscale (instance count auto-scales between min and max)"
              onChange={(_, d) => setAutoEnabled(!!d.checked)}
            />
            <div className={s.row}>
              <Field label="Min instances">
                <SpinButton min={2} max={1000} value={autoMin} disabled={!autoEnabled || isBasic} onChange={(_, d) => setAutoMin(d.value ?? autoMin ?? 2)} />
              </Field>
              <Field label="Max instances">
                <SpinButton min={2} max={1000} value={autoMax} disabled={!autoEnabled || isBasic} onChange={(_, d) => setAutoMax(d.value ?? autoMax ?? 4)} />
              </Field>
              <Button
                appearance="primary" disabled={busy || isBasic}
                onClick={() => post({ action: 'autoscale', isEnabled: autoEnabled, min: autoMin, max: autoMax }, 'Autoscale request submitted')}
              >
                Apply autoscale
              </Button>
            </div>
          </div>

          <div className={s.section}>
            <strong>Streaming ingestion</strong>
            <Switch
              checked={streaming}
              label="Enable streaming ingestion (required for Event Hubs data connections + low-latency ingest)"
              onChange={(_, d) => setStreaming(!!d.checked)}
            />
            <div className={s.row}>
              <Button appearance="primary" disabled={busy} onClick={() => post({ action: 'streaming-ingest', isEnabled: streaming }, 'Streaming-ingestion request submitted')}>
                Apply streaming setting
              </Button>
            </div>
          </div>
        </>
      )}

      {tab === 'manage' && (
        <>
          <div className={s.section}>
            <strong>Cluster lifecycle</strong>
            <Caption1 className={s.hint}>
              Stopping releases compute (data survives; the cluster is unqueryable until restarted).
              Starting takes ~10 minutes to warm up. Both are async ARM operations.
            </Caption1>
            <div className={s.row}>
              <Button
                appearance="secondary" icon={<Stop20Regular />} disabled={busy || cluster?.state === 'Stopped'}
                onClick={() => put({ action: 'stop' }, 'Stop request submitted')}
              >
                Stop cluster
              </Button>
              <Button
                appearance="primary" icon={<Play20Regular />} disabled={busy || cluster?.state === 'Running'}
                onClick={() => put({ action: 'start' }, 'Start request submitted')}
              >
                Start cluster
              </Button>
            </div>
          </div>

          <div className={s.danger}>
            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalSNudge }}>
              <Warning20Regular style={{ color: tokens.colorPaletteRedForeground1 }} />
              <strong>Danger zone — delete cluster</strong>
            </span>
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Irreversible (14-day soft-delete)</MessageBarTitle>
                Deletes the entire ADX cluster and every database on it. Azure keeps a 14-day
                soft-delete window. Type the cluster name <code>{cluster?.name}</code> to confirm.
              </MessageBarBody>
            </MessageBar>
            <div className={s.row}>
              <Field label="Confirm cluster name" style={{ minWidth: 320 }}>
                <Input value={confirmName} onChange={(_, d) => setConfirmName(d.value)} placeholder={cluster?.name} />
              </Field>
              <Button
                appearance="primary" icon={<Delete20Regular />}
                disabled={busy || !cluster?.name || confirmName.trim() !== cluster?.name}
                onClick={() => put({ action: 'delete', confirm: confirmName.trim() }, 'Delete request submitted')}
              >
                Delete cluster
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
