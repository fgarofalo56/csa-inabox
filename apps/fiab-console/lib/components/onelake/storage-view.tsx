'use client';

/**
 * OneLake catalog — Storage tab (item-size report).
 *
 * Azure-native parity with the Fabric "OneLake — Workspace storage" usage
 * report (https://learn.microsoft.com/fabric/onelake/onelake-consumption).
 * It answers "how much storage does each item consume?" entirely from the DLZ
 * ADLS Gen2 backend — INCLUDING system files (Delta `_delta_log/`, `_SUCCESS`)
 * and retained soft-deleted blobs, which Fabric also bills.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ Workspace [▼]   Refreshed <ts>   [Refresh]                        │
 *   ├──────────────┬──────────────┬──────────────┬─────────────────────┤
 *   │ Total used   │ System files │ Soft-deleted │ Items (ADLS-backed) │
 *   ├──────────────┴──────────────┴──────────────┴─────────────────────┤
 *   │ Per-item table  (item | type | live | system | deleted | total)   │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Container breakdown  (live / soft-deleted per medallion zone)      │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * REAL data: GET /api/onelake/storage[?workspaceId=]. ON-DEMAND refresh — each
 * load (and the Refresh button) re-walks the lake live; there's no cached
 * aggregate. Honest gate: a 503 renders a MessageBar naming LOOM_BRONZE_URL.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner,
  Badge,
  Button,
  Text,
  Title3,
  Caption1,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  Database20Regular,
  DocumentSettings20Regular,
  BinRecycle20Regular,
  Storage20Regular,
} from '@fluentui/react-icons';

import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface Workspace {
  id: string;
  name: string;
}

interface ItemUsage {
  id: string;
  displayName: string;
  itemType: string;
  workspaceId: string;
  backend: 'adls' | 'synapse' | 'adx' | 'unknown';
  container?: string;
  prefix?: string;
  liveBytes: number;
  liveFiles: number;
  systemBytes: number;
  systemFiles: number;
  deletedBytes: number;
  deletedFiles: number;
  totalBytes: number;
  capped: boolean;
  resolved: 'provisioning' | 'convention' | 'none';
}

interface PrefixUsage {
  container: string;
  prefix: string;
  liveBytes: number;
  liveFiles: number;
  systemBytes: number;
  systemFiles: number;
  deletedBytes: number;
  deletedFiles: number;
}
interface ContainerUsage {
  container: string;
  liveBytes: number;
  liveFiles: number;
  deletedBytes: number;
  deletedFiles: number;
  capped: boolean;
  prefixes: PrefixUsage[];
}

interface StorageReport {
  ok: boolean;
  account?: string;
  cloud?: string;
  refreshedAt?: string;
  totals?: {
    liveBytes: number;
    liveFiles: number;
    systemBytes: number;
    deletedBytes: number;
    deletedFiles: number;
    items: number;
    adlsItems: number;
  };
  items?: ItemUsage[];
  unattributed?: ContainerUsage[];
  truncated?: boolean;
  error?: string;
  code?: string;
  envVar?: string;
  bicepModule?: string;
}

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtNum(n: number): string {
  return n.toLocaleString();
}
function backendLabel(b: ItemUsage['backend']): string {
  switch (b) {
    case 'adls': return 'ADLS Gen2 (OneLake)';
    case 'synapse': return 'Synapse (compute-billed)';
    case 'adx': return 'Azure Data Explorer';
    default: return 'Not ADLS-backed';
  }
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    marginBottom: tokens.spacingVerticalL,
  },
  toolbarSpacer: { flex: 1 },
  refreshedAt: { color: tokens.colorNeutralForeground3 },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  cardValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  cardSub: { color: tokens.colorNeutralForeground3 },
  nameCell: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  nameIcon: {
    width: '24px', height: '24px', borderRadius: tokens.borderRadiusSmall,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  nameText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
  num: { fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.colorNeutralForeground3 },
});

function StatCard({
  icon, label, value, sub,
}: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  const styles = useStyles();
  return (
    <div className={styles.card}>
      <span className={styles.cardHead}>{icon}<Caption1>{label}</Caption1></span>
      <span className={styles.cardValue}>{value}</span>
      {sub && <Caption1 className={styles.cardSub}>{sub}</Caption1>}
    </div>
  );
}

export function StorageView({ workspaces }: { workspaces: Workspace[] }) {
  const styles = useStyles();
  const [wsFilter, setWsFilter] = useState<string>('all');
  const [report, setReport] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = wsFilter !== 'all' ? `?workspaceId=${encodeURIComponent(wsFilter)}` : '';
      const r = await fetch(`/api/onelake/storage${qs}`);
      const j: StorageReport = await r.json();
      if (!r.ok || j.ok === false) {
        // 503 honest gate carries code/envVar — keep the body so we can render it.
        setReport(j);
        if (j.code !== 'adls_not_configured' && j.code !== 'forbidden') {
          setError(j.error || `Failed to load storage report (HTTP ${r.status}).`);
        }
        return;
      }
      setReport(j);
    } catch (e: any) {
      setError(e?.message || 'Failed to load storage report.');
    } finally {
      setLoading(false);
    }
  }, [wsFilter]);

  useEffect(() => { void load(); }, [load]);

  const wsNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspaces) m.set(w.id, w.name);
    return m;
  }, [workspaces]);

  // ── honest infra gate (503 / 403) ──
  const gateCode = report && report.ok === false ? report.code : undefined;
  if (gateCode === 'adls_not_configured' || gateCode === 'forbidden') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>
            {gateCode === 'forbidden' ? 'Storage access not granted' : 'Data Landing Zone not configured'}
          </MessageBarTitle>
          {report?.error}
          {report?.bicepModule && (
            <Caption1 style={{ display: 'block', marginTop: 8 }}>
              Bicep: <code>{report.bicepModule}</code>
            </Caption1>
          )}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const itemColumns: LoomColumn<ItemUsage>[] = [
    {
      key: 'displayName',
      label: 'Item',
      width: 240,
      getValue: (r) => r.displayName,
      render: (r) => {
        const v = itemVisual(r.itemType);
        const Icon = v.icon;
        return (
          <span className={styles.nameCell}>
            <span className={styles.nameIcon} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              <Icon style={{ width: 16, height: 16, color: v.color }} />
            </span>
            <span className={styles.nameText} title={r.prefix ? `${r.container}/${r.prefix}` : r.displayName}>
              {r.displayName}
            </span>
          </span>
        );
      },
    },
    {
      key: 'workspace',
      label: 'Workspace',
      width: 160,
      getValue: (r) => wsNameMap.get(r.workspaceId) ?? '',
      render: (r) => <span className={styles.muted}>{wsNameMap.get(r.workspaceId) ?? '—'}</span>,
    },
    {
      key: 'backend',
      label: 'Backend',
      width: 160,
      getValue: (r) => backendLabel(r.backend),
      render: (r) =>
        r.backend === 'adls'
          ? <Badge appearance="tint" color="brand" size="small">OneLake (ADLS)</Badge>
          : <Tooltip content={backendLabel(r.backend)} relationship="label"><Badge appearance="outline" size="small">{r.backend === 'unknown' ? 'n/a' : r.backend.toUpperCase()}</Badge></Tooltip>,
    },
    {
      key: 'liveBytes',
      label: 'Live',
      width: 110,
      getValue: (r) => r.liveBytes,
      render: (r) => (r.backend === 'adls' ? <span className={styles.num}>{fmtBytes(r.liveBytes)}</span> : <span className={styles.muted}>—</span>),
    },
    {
      key: 'systemBytes',
      label: 'System',
      width: 110,
      getValue: (r) => r.systemBytes,
      render: (r) =>
        r.backend === 'adls'
          ? <Tooltip content={`${fmtNum(r.systemFiles)} system file(s) (Delta log, _SUCCESS, …)`} relationship="label"><span className={styles.num}>{fmtBytes(r.systemBytes)}</span></Tooltip>
          : <span className={styles.muted}>—</span>,
    },
    {
      key: 'deletedBytes',
      label: 'Soft-deleted',
      width: 120,
      getValue: (r) => r.deletedBytes,
      render: (r) =>
        r.backend === 'adls'
          ? (r.deletedBytes > 0
              ? <Tooltip content={`${fmtNum(r.deletedFiles)} retained soft-deleted file(s)`} relationship="label"><span className={styles.num}>{fmtBytes(r.deletedBytes)}</span></Tooltip>
              : <span className={styles.muted}>0 B</span>)
          : <span className={styles.muted}>—</span>,
    },
    {
      key: 'totalBytes',
      label: 'Total',
      width: 120,
      getValue: (r) => r.totalBytes,
      render: (r) =>
        r.backend === 'adls'
          ? <span className={styles.num} style={{ fontWeight: tokens.fontWeightSemibold }}>{fmtBytes(r.totalBytes)}{r.capped ? '+' : ''}</span>
          : <span className={styles.muted}>—</span>,
    },
    {
      key: 'files',
      label: 'Files',
      width: 90,
      getValue: (r) => r.liveFiles,
      render: (r) => (r.backend === 'adls' ? <span className={styles.num}>{fmtNum(r.liveFiles)}</span> : <span className={styles.muted}>—</span>),
    },
  ];

  const containerColumns: LoomColumn<ContainerUsage>[] = [
    { key: 'container', label: 'Container (zone)', width: 180, getValue: (r) => r.container, render: (r) => <strong>{r.container}</strong> },
    { key: 'liveBytes', label: 'Live', width: 120, getValue: (r) => r.liveBytes, render: (r) => <span className={styles.num}>{fmtBytes(r.liveBytes)}{r.capped ? '+' : ''}</span> },
    { key: 'liveFiles', label: 'Live files', width: 110, getValue: (r) => r.liveFiles, render: (r) => <span className={styles.num}>{fmtNum(r.liveFiles)}</span> },
    { key: 'deletedBytes', label: 'Soft-deleted', width: 120, getValue: (r) => r.deletedBytes, render: (r) => <span className={styles.num}>{fmtBytes(r.deletedBytes)}</span> },
    { key: 'deletedFiles', label: 'Deleted files', width: 120, getValue: (r) => r.deletedFiles, render: (r) => <span className={styles.num}>{fmtNum(r.deletedFiles)}</span> },
  ];

  const totals = report?.totals;
  const grandTotal = totals ? totals.liveBytes + totals.deletedBytes : 0;

  return (
    <div>
      {/* Toolbar: workspace scope + refresh */}
      <div className={styles.toolbar}>
        <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>Workspace</Caption1>
        <Dropdown
          aria-label="Filter storage report by workspace"
          value={wsFilter === 'all' ? 'All workspaces' : (wsNameMap.get(wsFilter) ?? wsFilter)}
          selectedOptions={[wsFilter]}
          onOptionSelect={(_e, d) => setWsFilter(String(d.optionValue))}
          style={{ minWidth: 220 }}
        >
          <Option value="all" text="All workspaces">All workspaces</Option>
          {workspaces.map((w) => (
            <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
          ))}
        </Dropdown>
        <div className={styles.toolbarSpacer} />
        {report?.refreshedAt && (
          <Tooltip content={new Date(report.refreshedAt).toLocaleString()} relationship="label">
            <Caption1 className={styles.refreshedAt}>
              Refreshed {new Date(report.refreshedAt).toLocaleTimeString()}
              {report.account ? ` · ${report.account}` : ''}
            </Caption1>
          </Tooltip>
        )}
        <Button
          appearance="primary"
          icon={<ArrowClockwise20Regular />}
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalL }}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !report?.totals && <Spinner label="Walking the lake — aggregating blob sizes…" />}

      {totals && (
        <>
          {/* Stat cards */}
          <div className={styles.cards}>
            <StatCard
              icon={<Storage20Regular />}
              label="Total OneLake storage"
              value={fmtBytes(grandTotal)}
              sub={`${fmtNum(totals.liveFiles)} live file(s)`}
            />
            <StatCard
              icon={<DocumentSettings20Regular />}
              label="System files (Delta log, …)"
              value={fmtBytes(totals.systemBytes)}
              sub="Included in the total — Fabric bills these too"
            />
            <StatCard
              icon={<BinRecycle20Regular />}
              label="Soft-deleted (retained)"
              value={fmtBytes(totals.deletedBytes)}
              sub={`${fmtNum(totals.deletedFiles)} file(s) recoverable until purge`}
            />
            <StatCard
              icon={<Database20Regular />}
              label="Items reported"
              value={fmtNum(totals.items)}
              sub={`${fmtNum(totals.adlsItems)} ADLS-backed (OneLake)`}
            />
          </div>

          {report?.truncated && (
            <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalL }}>
              <MessageBarBody>
                This tenant has more items than the per-request limit; the report covers the first batch.
                Filter to a single workspace for a complete per-item breakdown.
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Per-item report (the acceptance deliverable) */}
          <Section title="Per-item storage usage">
            <LoomDataTable
              columns={itemColumns}
              rows={report?.items ?? []}
              getRowId={(r) => r.id}
              ariaLabel="Per-item storage usage"
              empty="No OneLake-type items in scope. Create a lakehouse or mirrored database to consume storage."
            />
          </Section>

          {/* Account-level container breakdown (all-workspaces view only) */}
          {wsFilter === 'all' && (report?.unattributed?.length ?? 0) > 0 && (
            <Section title="Container breakdown">
              <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalS }}>
                Total bytes per medallion zone across the whole DLZ account — includes data not attributed to a
                catalog item (orphaned / out-of-band).
              </Caption1>
              <LoomDataTable
                columns={containerColumns}
                rows={report?.unattributed ?? []}
                getRowId={(r) => r.container}
                ariaLabel="Container storage breakdown"
                empty="No containers configured."
              />
            </Section>
          )}

          <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalL }}>
            Live walk over ADLS Gen2 (no cached aggregate). Sizes include Delta system files and retained
            soft-deleted blobs. Warehouse (Synapse) and KQL / Eventhouse (Azure Data Explorer) items store their
            data in the compute service, so their bytes are billed there — not shown as OneLake storage.
          </Caption1>
        </>
      )}
    </div>
  );
}
