'use client';

/**
 * SparkTelemetryAuditPanel — Capacity & compute → "Spark telemetry".
 *
 * The runtime safety net for universal Spark telemetry: audits diagnostic-
 * settings coverage across every Spark engine (Synapse Spark, Databricks, Azure
 * ML) and enables the standardized Loom setting on any workspace whose telemetry
 * isn't routing to the Loom Log Analytics workspace. Default-ON — "Apply all"
 * is one click, no approval gate.
 *
 * All data is live from /api/admin/spark-telemetry/audit (ARM diagnostic-settings
 * probe). States per no-vaporware: 401 → SignInRequired; gate → MessageBar naming
 * the exact env var + RBAC to grant; data → summary + per-resource status table.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Badge, Button, Caption1, Text, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, CheckmarkCircle16Regular, Warning16Regular,
  Flash16Regular, ShieldTask16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

type SparkEngine = 'synapse-spark' | 'databricks' | 'aml';

interface SparkTelemetryResource {
  id: string; name: string; type: string; resourceGroup: string;
  engine: SparkEngine; engineLabel: string;
  routesToLoomLaw: boolean; settingNames: string[]; tables: string[];
  note: string; probeNote?: string;
}
interface Audit {
  generatedAt: string; lawResourceId: string; sessionEmitterConfigured: boolean;
  summary: { total: number; covered: number; missing: number };
  resources: SparkTelemetryResource[];
}
interface ApplyResult { id: string; name: string; engine: SparkEngine; ok: boolean; mode?: string; error?: string; }
interface ApplyReport { appliedAt: string; attempted: number; succeeded: number; failed: number; results: ApplyResult[]; }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 0 },
  stats: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  stat: {
    display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  statVal: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase600 },
  hint: { color: tokens.colorNeutralForeground3 },
  tableWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS },
  statusCell: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

function engineColor(e: SparkEngine): 'brand' | 'informative' | 'success' {
  return e === 'databricks' ? 'brand' : e === 'aml' ? 'success' : 'informative';
}

export function SparkTelemetryAuditPanel() {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [unauth, setUnauth] = useState(false);
  const [gate, setGate] = useState<{ missing: string[]; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [lastApply, setLastApply] = useState<ApplyReport | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(() => {
    setLoading(true); setError(null); setGate(null);
    clientFetch('/api/admin/spark-telemetry/audit')
      .then(async (r) => {
        if (r.status === 401) { setUnauth(true); return; }
        const j = await r.json();
        if (!j.ok) { if (j.gate) setGate(j.gate); else setError(j.error || j.reason || 'failed'); return; }
        setAudit(j.audit); setLastApply(j.lastApply || null); setLastRunAt(j.lastRunAt || null);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const apply = useCallback((ids?: string[]) => {
    setApplying(true); setError(null);
    clientFetch('/api/admin/spark-telemetry/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ids ? { ids } : {}),
    })
      .then(async (r) => {
        const j = await r.json();
        if (!j.ok) { if (j.gate) setGate(j.gate); else setError(j.error || j.reason || 'apply failed'); return; }
        setAudit(j.audit); setLastApply(j.lastApply || null);
        setLastRunAt(j.audit?.generatedAt || new Date().toISOString());
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setApplying(false));
  }, []);

  if (unauth) return <SignInRequired subject="Spark telemetry" />;

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Spark-telemetry reconciler not configured</MessageBarTitle>
          {gate.message}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const missing = audit?.summary.missing ?? 0;

  const columns: LoomColumn<SparkTelemetryResource>[] = [
    {
      key: 'engine', label: 'Engine', sortable: true, filterable: true, width: 150,
      render: (r) => <Badge appearance="tint" color={engineColor(r.engine)} icon={<Flash16Regular />}>{r.engineLabel}</Badge>,
      getValue: (r) => r.engineLabel,
    },
    {
      key: 'name', label: 'Workspace', sortable: true, filterable: true, width: 240,
      render: (r) => (
        <div className={s.tableWrap}>
          <Text weight="semibold">{r.name}</Text>
          <Caption1 className={s.hint}>{r.resourceGroup}</Caption1>
        </div>
      ),
      getValue: (r) => r.name,
    },
    {
      key: 'tables', label: 'Log Analytics tables', width: 260,
      render: (r) => <Caption1 className={s.hint}>{r.tables.join(', ')}</Caption1>,
      getValue: (r) => r.tables.join(' '),
    },
    {
      key: 'status', label: 'Telemetry', sortable: true, filterable: true, width: 150,
      render: (r) => (
        <span className={s.statusCell}>
          {r.routesToLoomLaw
            ? <><CheckmarkCircle16Regular color={tokens.colorPaletteGreenForeground1} /><Text>Routing</Text></>
            : <><Warning16Regular color={tokens.colorPaletteYellowForeground1} /><Text>Not routing</Text></>}
        </span>
      ),
      getValue: (r) => (r.routesToLoomLaw ? 'routing' : 'missing'),
    },
    {
      key: 'action', label: '', width: 110,
      render: (r) => r.routesToLoomLaw
        ? <span className={s.hint}>—</span>
        : (
          <Tooltip content={`Enable diagnostic settings on ${r.name} → Loom LAW`} relationship="label">
            <Button size="small" appearance="primary" disabled={applying} onClick={() => apply([r.id])}>Apply</Button>
          </Tooltip>
        ),
      getValue: () => '',
    },
  ];

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <div className={s.grow}>
          <Caption1 className={s.hint}>
            Every Spark engine (Synapse Spark, Databricks, Azure ML) routes its diagnostic logs + metrics to the
            Loom Log Analytics workspace. This reconciler enforces that on live resources and fixes any drift.
          </Caption1>
        </div>
        <Button appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={loading || applying}>Re-audit</Button>
        <Button
          appearance="primary" icon={<ShieldTask16Regular />}
          disabled={loading || applying || missing === 0}
          onClick={() => apply()}
        >
          {applying ? 'Applying…' : missing > 0 ? `Apply all (${missing})` : 'All covered'}
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Reconciler error</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {audit && !audit.sessionEmitterConfigured && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Fine-grained Synapse Spark metrics not wired</MessageBarTitle>
            Workspace diagnostics give app-completion records, but the per-session emitter
            (executor/task metrics: SparkListenerEvent / SparkMetrics) is off. Set LOOM_SPARK_LA_WORKSPACE_ID +
            LOOM_SPARK_LA_KEY (or the Key-Vault refs) so every Loom Spark session reports detailed metrics.
          </MessageBarBody>
        </MessageBar>
      )}

      {audit && (
        <div className={s.stats}>
          <div className={s.stat}><Caption1 className={s.hint}>Spark engines</Caption1><span className={s.statVal}>{audit.summary.total}</span></div>
          <div className={s.stat}><Caption1 className={s.hint}>Routing to Loom LAW</Caption1><span className={s.statVal} style={{ color: tokens.colorPaletteGreenForeground1 }}>{audit.summary.covered}</span></div>
          <div className={s.stat}><Caption1 className={s.hint}>Needs remediation</Caption1><span className={s.statVal} style={{ color: missing > 0 ? tokens.colorPaletteYellowForeground1 : undefined }}>{audit.summary.missing}</span></div>
        </div>
      )}

      {lastApply && lastApply.attempted > 0 && (
        <MessageBar intent={lastApply.failed > 0 ? 'warning' : 'success'}>
          <MessageBarBody>
            <MessageBarTitle>Last apply</MessageBarTitle>
            Enabled diagnostics on {lastApply.succeeded}/{lastApply.attempted} workspace(s)
            {lastApply.failed > 0 ? `; ${lastApply.failed} failed — see error above.` : '.'}
          </MessageBarBody>
        </MessageBar>
      )}

      <LoomDataTable
        columns={columns}
        rows={audit?.resources || []}
        getRowId={(r) => r.id}
        loading={loading}
        skeleton={4}
        ariaLabel="Spark telemetry coverage"
        empty={
          loading ? null : (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>No Spark engines found</MessageBarTitle>
                No Synapse, Databricks, or Azure ML workspaces are deployed in the Loom estate yet. Once one is
                provisioned it appears here and its telemetry is routed to the Loom LAW automatically.
              </MessageBarBody>
            </MessageBar>
          )
        }
      />

      {(lastRunAt || audit) && (
        <Caption1 className={s.hint}>
          {loading ? <Spinner size="tiny" label="Auditing…" /> : null}
          {lastRunAt ? `Last audit ${new Date(lastRunAt).toLocaleString()}.` : null}{' '}
          Routing to {audit?.lawResourceId?.split('/').pop() || 'the Loom Log Analytics workspace'}.
        </Caption1>
      )}
    </div>
  );
}
