'use client';

/**
 * DomainGovernanceSync — the /admin/domains "Governance sync" panel.
 *
 * Reconciles the full Loom domain hierarchy to Microsoft Purview (Data Map
 * collections) + Databricks Unity Catalog (catalogs/schemas) via
 * /api/admin/domains/sync. Shows a per-target status badge (active / honest
 * gate), a Preview (dry-run) and a Sync-now (apply) action, a per-domain
 * status matrix, and any drift (remote objects with no Loom owner — reported,
 * never deleted). Both targets are Azure-native and independently optional; an
 * unconfigured target renders an honest MessageBar naming the exact remediation
 * (no-vaporware.md), never an error, and the sweep still reconciles the other.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Card, Badge, Button, Spinner, Body1, Subtitle2, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, CloudSync20Regular, DatabaseLink20Regular,
  CheckmarkCircle16Filled, Warning16Filled, ErrorCircle16Filled,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

// Mirror of the server DomainSyncResult (lib/azure/domain-sync) — kept local so
// the client bundle doesn't pull the server module.
type TargetState = 'mirrored' | 'created' | 'missing' | 'error' | 'skipped';
interface TargetResult { state: TargetState; target?: string; detail?: string; error?: string; }
interface SyncRow { id: string; name: string; parentId?: string; purview: TargetResult; unity: TargetResult; }
interface TargetSummary {
  configured: boolean; gated?: boolean; hint?: string;
  mirrored: number; created: number; missing: number; errors: number;
}
interface DriftEntry { target: 'purview' | 'unity'; kind: string; name: string; note: string; }
interface SyncResult {
  applied: boolean; ranAt: string; ranBy: string; domainCount: number;
  purview: TargetSummary; unity: TargetSummary; rows: SyncRow[]; drift: DriftEntry[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  targetGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  targetCard: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalL },
  targetHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  targetIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  countsRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  ran: { color: tokens.colorNeutralForeground3 },
  matrix: {
    display: 'flex', flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden',
  },
  matrixHead: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1.4fr)', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    fontWeight: tokens.fontWeightSemibold, backgroundColor: tokens.colorNeutralBackground2, fontSize: tokens.fontSizeBase200,
  },
  matrixRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1.4fr)', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`, fontSize: tokens.fontSizeBase200,
  },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, overflowWrap: 'anywhere' },
  subBadge: { flexShrink: 0 },
  driftList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalXS },
  driftItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
  mono: { fontFamily: tokens.fontFamilyMonospace },
});

/** State → Fluent Badge color + icon + label. */
function stateBadge(r: TargetResult): { color: 'success' | 'warning' | 'danger' | 'informative' | 'subtle'; icon: React.ReactElement; label: string } {
  switch (r.state) {
    case 'mirrored': return { color: 'success', icon: <CheckmarkCircle16Filled />, label: 'Mirrored' };
    case 'created': return { color: 'success', icon: <CheckmarkCircle16Filled />, label: 'Synced' };
    case 'missing': return { color: 'warning', icon: <Warning16Filled />, label: 'Not mirrored' };
    case 'error': return { color: 'danger', icon: <ErrorCircle16Filled />, label: 'Error' };
    default: return { color: 'subtle', icon: <Warning16Filled />, label: 'Inactive' };
  }
}

function TargetSummaryCard({
  title, icon, summary,
}: { title: string; icon: React.ReactElement; summary: TargetSummary }) {
  const s = useStyles();
  return (
    <Card className={s.targetCard}>
      <div className={s.targetHead}>
        <span className={s.targetIcon}>{icon}</span>
        <Subtitle2>{title}</Subtitle2>
        {summary.configured ? (
          <Badge color="success" appearance="tint" icon={<CheckmarkCircle16Filled />}>Active</Badge>
        ) : summary.gated ? (
          <Badge color="warning" appearance="tint" icon={<Warning16Filled />}>Needs role grant</Badge>
        ) : (
          <Badge color="subtle" appearance="tint">Not configured</Badge>
        )}
      </div>
      {summary.configured ? (
        <div className={s.countsRow}>
          <Badge color="success" appearance="outline">{summary.mirrored + summary.created} in sync</Badge>
          {summary.missing > 0 && <Badge color="warning" appearance="outline">{summary.missing} to create</Badge>}
          {summary.errors > 0 && <Badge color="danger" appearance="outline">{summary.errors} error{summary.errors === 1 ? '' : 's'}</Badge>}
        </div>
      ) : (
        <Caption1>{summary.hint}</Caption1>
      )}
    </Card>
  );
}

export function DomainGovernanceSync() {
  const s = useStyles();
  const [result, setResult] = useState<SyncResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<false | 'preview' | 'apply'>(false);
  const [err, setErr] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await clientFetch('/api/admin/domains/sync', undefined, 30000);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setResult(j.result || null);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const run = useCallback(async (apply: boolean) => {
    setBusy(apply ? 'apply' : 'preview'); setErr(null);
    try {
      const r = await clientFetch('/api/admin/domains/sync', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apply }),
      }, 60000);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setResult(j.result || null);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, []);

  if (loading) return <Spinner label="Loading governance sync status…" />;

  const neither = !!result && !result.purview.configured && !result.unity.configured;

  return (
    <div className={s.root}>
      <Body1>
        Reconcile the full domain hierarchy to Microsoft Purview (Data Map collections) and Databricks
        Unity Catalog (catalogs &amp; schemas). Loom is authoritative; sync is additive and never deletes
        remote governance objects. Both targets are Azure-native and optional.
      </Body1>

      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}

      {result && (
        <>
          <div className={s.targetGrid}>
            <TargetSummaryCard title="Microsoft Purview" icon={<CloudSync20Regular />} summary={result.purview} />
            <TargetSummaryCard title="Unity Catalog" icon={<DatabaseLink20Regular />} summary={result.unity} />
          </div>

          {neither && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No governance target configured</MessageBarTitle>
                Domains live in Loom&apos;s Cosmos store and fully work. To mirror them, set
                {' '}<code>LOOM_PURVIEW_ACCOUNT</code> (Purview Data Map) and/or
                {' '}<code>LOOM_DATABRICKS_HOSTNAME</code> (Unity Catalog) in the admin-plane app env, then re-run.
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={s.actions}>
            <Button
              appearance="primary"
              icon={busy === 'apply' ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
              disabled={!!busy || neither}
              onClick={() => run(true)}
            >
              Sync now
            </Button>
            <Button
              appearance="secondary"
              icon={busy === 'preview' ? <Spinner size="tiny" /> : undefined}
              disabled={!!busy || neither}
              onClick={() => run(false)}
            >
              Preview changes
            </Button>
            <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={!!busy} onClick={loadStatus}>
              Refresh
            </Button>
            <Caption1 className={s.ran}>
              {result.applied ? 'Last synced' : 'Last previewed'} {new Date(result.ranAt).toLocaleString()} · {result.domainCount} domain{result.domainCount === 1 ? '' : 's'}
            </Caption1>
          </div>

          {/* Per-domain status matrix (per-target badges). */}
          {result.rows.length > 0 && (result.purview.configured || result.unity.configured) && (
            <div className={s.matrix}>
              <div className={s.matrixHead}>
                <span>Domain</span>
                <span>Purview</span>
                <span>Unity Catalog</span>
              </div>
              {result.rows.map((row) => {
                const pb = stateBadge(row.purview);
                const ub = stateBadge(row.unity);
                return (
                  <div key={row.id} className={s.matrixRow}>
                    <span className={s.nameCell}>
                      <strong>{row.name}</strong>
                      {row.parentId && <Badge className={s.subBadge} appearance="outline" size="small">subdomain</Badge>}
                    </span>
                    <span>
                      <Badge color={pb.color} appearance="tint" size="small" icon={pb.icon}
                        title={row.purview.error || row.purview.detail || row.purview.target}>
                        {pb.label}
                      </Badge>
                    </span>
                    <span>
                      <Badge color={ub.color} appearance="tint" size="small" icon={ub.icon}
                        title={row.unity.error || row.unity.detail || row.unity.target}>
                        {ub.label}
                      </Badge>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Drift — remote objects with no Loom owner. Reported, never deleted. */}
          {result.drift.length > 0 && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>
                  {result.drift.length} unmanaged governance object{result.drift.length === 1 ? '' : 's'} (left untouched)
                </MessageBarTitle>
                <div className={s.driftList}>
                  {result.drift.map((d) => (
                    <div key={`${d.target}:${d.name}`} className={s.driftItem}>
                      <span>
                        <Badge appearance="outline" size="small">{d.target === 'purview' ? 'Purview' : 'Unity'} {d.kind}</Badge>
                        {' '}<span className={s.mono}>{d.name}</span>
                      </span>
                      <Caption1>{d.note}</Caption1>
                    </div>
                  ))}
                </div>
              </MessageBarBody>
            </MessageBar>
          )}
        </>
      )}
    </div>
  );
}

export default DomainGovernanceSync;
