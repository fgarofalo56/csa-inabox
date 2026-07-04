'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * OneLake catalog — Storage tab (item-size reporting).
 *
 * Azure-native parity for the Fabric "OneLake — item storage" surface: per-item
 * workspace storage usage, broken out into live data, system / metadata files
 * (Delta `_delta_log/`, checkpoints, `_SUCCESS`…) and soft-deleted bytes still
 * billed during the retention window — refreshed ON DEMAND (matching Fabric's
 * Refresh affordance), themed Fluent v9 + Loom tokens:
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ [Refresh]   Last refreshed <relative>                           │
 *   ├──────────────┬──────────────┬──────────────┬───────────────────┤
 *   │ Total billed │ Live data    │ System files │ Soft-deleted       │
 *   ├──────────────┴──────────────┴──────────────┴───────────────────┤
 *   │ Composition bar (live / system / soft-deleted)                  │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ Per-item table: Item | Type | Location | Total | Live | System | │
 *   │                 Soft-deleted | Files   (largest-first, sortable)  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * REAL data: GET /api/onelake/storage walks each item's ADLS Gen2 prefix (live
 * recursive listPaths + soft-deleted blob enumeration). No mock arrays.
 *
 * Honest gate: when the DLZ storage account isn't wired in (LOOM_BRONZE_URL
 * unset) the route 503s and this surface renders a MessageBar naming the env var
 * + the data-landing-zone bicep module — never a fabricated number.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Spinner,
  Badge,
  Button,
  Text,
  Title3,
  Caption1,
  Tooltip,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  Database20Regular,
  DocumentData20Regular,
  Wrench20Regular,
  BinRecycle20Regular,
} from '@fluentui/react-icons';

import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { findItemType } from '@/lib/catalog/fabric-item-types';

interface PrefixUsage {
  liveBytes: number;
  liveFiles: number;
  systemBytes: number;
  deletedBytes: number;
  deletedFiles: number;
  totalBytes: number;
  capped: boolean;
}

interface ItemUsage {
  id: string;
  itemType: string;
  workspaceId: string;
  displayName: string;
  location: string | null;
  usage: PrefixUsage | null;
  reason?: string;
}

interface Totals {
  liveBytes: number;
  systemBytes: number;
  deletedBytes: number;
  totalBytes: number;
  liveFiles: number;
  deletedFiles: number;
  reportedItems: number;
  capped: boolean;
}

interface StorageResponse {
  ok: boolean;
  account?: string;
  refreshedAt?: string;
  items?: ItemUsage[];
  totals?: Totals;
  // gate
  code?: string;
  error?: string;
  hint?: { missingEnvVar?: string; bicepModule?: string };
}

function fmtBytes(n: number | undefined): string {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : v < 100 && i > 0 ? 1 : 0)} ${u[i]}`;
}

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relative(iso?: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return RTF.format(Math.round(diffSec), 'second');
  if (abs < 3600) return RTF.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), 'hour');
  return RTF.format(Math.round(diffSec / 86400), 'day');
}

function typeLabel(itemType: string): string {
  return findItemType(itemType)?.displayName ?? itemVisual(itemType).label;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXL },

  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  toolbarSpacer: { flex: 1 },

  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  cardIcon: {
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardValue: {
    fontSize: '30px',
    lineHeight: '34px',
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground1,
  },
  cardSub: { color: tokens.colorNeutralForeground3 },

  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
  },
  compositionBar: {
    display: 'flex',
    width: '100%',
    height: '16px',
    borderRadius: tokens.borderRadiusCircular,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground4,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  compositionSeg: {
    height: '100%',
    minWidth: 0,
    transition: 'filter 120ms ease',
    ':hover': { filter: 'brightness(1.08)' },
  },
  legend: { display: 'flex', gap: tokens.spacingHorizontalXL, flexWrap: 'wrap' },
  legendRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  legendDot: { width: '12px', height: '12px', borderRadius: tokens.borderRadiusSmall, flexShrink: 0 },
  legendValue: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },

  nameCell: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  nameIcon: {
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusSmall,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  nameText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold },
  num: { fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.colorNeutralForeground3 },

  emptyBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
  },
  loadingBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingVerticalXXL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  emptyIcon: {
    width: '48px',
    height: '48px',
    borderRadius: tokens.borderRadiusCircular,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    marginBottom: tokens.spacingVerticalXS,
  },
});

// Composition-bar segment colours (Loom palette via Fluent semantic tokens).
const LIVE_COLOR = tokens.colorBrandBackground;
const SYSTEM_COLOR = tokens.colorPaletteYellowBackground3;
const DELETED_COLOR = tokens.colorPaletteRedBackground3;

function ScoreCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  sub?: string;
}) {
  const styles = useStyles();
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon} style={{ backgroundColor: iconBg, color: iconColor }} aria-hidden>
          {icon}
        </span>
        <Text weight="semibold">{label}</Text>
      </div>
      <span className={styles.cardValue}>{value}</span>
      {sub && <Caption1 className={styles.cardSub}>{sub}</Caption1>}
    </div>
  );
}

export function StorageView({ workspaceId }: { workspaceId?: string | null }) {
  const styles = useStyles();
  const [data, setData] = useState<StorageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      const r = await clientFetch(`/api/onelake/storage${qs}`, { cache: 'no-store' });
      const j: StorageResponse = await r.json().catch(() => ({ ok: false }));
      setData(j);
      if (!j.ok && !j.code) setError(j.error || `Failed to load storage usage (HTTP ${r.status}).`);
    } catch (e: any) {
      setError(e?.message || 'Failed to load storage usage.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Initial load + reload when the workspace filter changes.
  useEffect(() => { void load(); }, [load]);

  const columns: LoomColumn<ItemUsage>[] = [
    {
      key: 'displayName',
      label: 'Item',
      width: 240,
      sortable: true,
      getValue: (r) => r.displayName,
      render: (r) => {
        const v = itemVisual(r.itemType);
        const Icon = v.icon;
        return (
          <span className={styles.nameCell}>
            <span className={styles.nameIcon} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              <Icon style={{ width: 16, height: 16, color: v.color }} />
            </span>
            <span className={styles.nameText} title={r.displayName}>{r.displayName}</span>
          </span>
        );
      },
    },
    { key: 'type', label: 'Type', width: 150, sortable: true, getValue: (r) => typeLabel(r.itemType), render: (r) => typeLabel(r.itemType) },
    {
      key: 'location',
      label: 'Location',
      width: 220,
      sortable: true,
      getValue: (r) => r.location ?? '',
      render: (r) =>
        r.location
          ? <Tooltip content={r.location} relationship="label"><span className={styles.muted} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 200 }}>{r.location}</span></Tooltip>
          : <span className={styles.muted}>—</span>,
    },
    {
      key: 'total',
      label: 'Total billed',
      width: 120,
      sortable: true,
      getValue: (r) => r.usage?.totalBytes ?? -1,
      render: (r) => (r.usage ? <span className={styles.num}>{fmtBytes(r.usage.totalBytes)}</span> : <Tooltip content={r.reason || 'No data'} relationship="label"><span className={styles.muted}>—</span></Tooltip>),
    },
    {
      key: 'live',
      label: 'Live',
      width: 110,
      sortable: true,
      getValue: (r) => r.usage?.liveBytes ?? -1,
      render: (r) => (r.usage ? <span className={styles.num}>{fmtBytes(r.usage.liveBytes)}</span> : <span className={styles.muted}>—</span>),
    },
    {
      key: 'system',
      label: 'System',
      width: 110,
      sortable: true,
      getValue: (r) => r.usage?.systemBytes ?? -1,
      render: (r) => (r.usage ? <span className={styles.num}>{fmtBytes(r.usage.systemBytes)}</span> : <span className={styles.muted}>—</span>),
    },
    {
      key: 'deleted',
      label: 'Soft-deleted',
      width: 120,
      sortable: true,
      getValue: (r) => r.usage?.deletedBytes ?? -1,
      render: (r) =>
        r.usage
          ? (r.usage.deletedBytes > 0
              ? <Badge appearance="tint" color="danger" size="small">{fmtBytes(r.usage.deletedBytes)}</Badge>
              : <span className={styles.num}>0 B</span>)
          : <span className={styles.muted}>—</span>,
    },
    {
      key: 'files',
      label: 'Files',
      width: 90,
      sortable: true,
      getValue: (r) => r.usage?.liveFiles ?? -1,
      render: (r) =>
        r.usage
          ? <span className={styles.num}>{(r.usage.liveFiles + r.usage.deletedFiles).toLocaleString()}</span>
          : <span className={styles.muted}>—</span>,
    },
  ];

  // ── honest infra gate (DLZ storage account not wired in) ──
  if (data && !data.ok && data.code === 'adls_not_configured') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Data Landing Zone storage not configured</MessageBarTitle>
          {data.error}{' '}
          {data.hint?.bicepModule && <>Deploy <code>{data.hint.bicepModule}</code> and set <code>{data.hint.missingEnvVar}</code>.</>}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const totals = data?.totals;
  const items = data?.items ?? [];
  const denom = Math.max(1, totals?.totalBytes ?? 0);
  const livePct = totals ? (totals.liveBytes - totals.systemBytes) / denom * 100 : 0;
  const systemPct = totals ? totals.systemBytes / denom * 100 : 0;
  const deletedPct = totals ? totals.deletedBytes / denom * 100 : 0;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Title3>Item storage</Title3>
        <Badge appearance="outline" color="informative">Azure-native</Badge>
        <span className={styles.toolbarSpacer} />
        {data?.refreshedAt && (
          <Tooltip content={new Date(data.refreshedAt).toLocaleString()} relationship="label">
            <Caption1 className={styles.cardSub}>Refreshed {relative(data.refreshedAt)}</Caption1>
          </Tooltip>
        )}
        <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <Caption1 className={styles.cardSub}>
        Aggregates the ADLS Gen2 storage each OneLake item consumes — live data, system / metadata files
        (Delta transaction log, checkpoints) and soft-deleted bytes still billed during the retention window.
        Computed on demand by walking each item&rsquo;s storage prefix; no Microsoft Fabric required.
      </Caption1>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !data && (
        <div className={styles.loadingBox}>
          <Spinner label="Walking storage…" />
        </div>
      )}

      {totals && (
        <>
          <div className={styles.cards}>
            <ScoreCard
              icon={<Database20Regular />}
              iconBg={tokens.colorBrandBackground2}
              iconColor={tokens.colorBrandForeground2}
              label="Total billed"
              value={fmtBytes(totals.totalBytes)}
              sub={`${totals.reportedItems} item${totals.reportedItems === 1 ? '' : 's'} reported`}
            />
            <ScoreCard
              icon={<DocumentData20Regular />}
              iconBg={tokens.colorBrandBackground2}
              iconColor={tokens.colorBrandForeground2}
              label="Live data"
              value={fmtBytes(totals.liveBytes)}
              sub={`${totals.liveFiles.toLocaleString()} files (system included)`}
            />
            <ScoreCard
              icon={<Wrench20Regular />}
              iconBg={tokens.colorPaletteYellowBackground2}
              iconColor={tokens.colorPaletteYellowForeground2}
              label="System / metadata"
              value={fmtBytes(totals.systemBytes)}
              sub="Delta log, checkpoints, markers"
            />
            <ScoreCard
              icon={<BinRecycle20Regular />}
              iconBg={tokens.colorPaletteRedBackground2}
              iconColor={tokens.colorPaletteRedForeground2}
              label="Soft-deleted"
              value={fmtBytes(totals.deletedBytes)}
              sub={`${totals.deletedFiles.toLocaleString()} blobs in retention`}
            />
          </div>

          <div className={styles.panel}>
            <Text weight="semibold">Storage composition</Text>
            <div
              className={styles.compositionBar}
              role="img"
              aria-label={`Storage composition: ${livePct.toFixed(0)}% live data, ${systemPct.toFixed(0)}% system/metadata, ${deletedPct.toFixed(0)}% soft-deleted`}
            >
              {livePct > 0 && (
                <Tooltip content={`Live data — ${fmtBytes(totals.liveBytes - totals.systemBytes)} (${livePct.toFixed(0)}%)`} relationship="label">
                  <span className={styles.compositionSeg} style={{ width: `${livePct}%`, backgroundColor: LIVE_COLOR }} />
                </Tooltip>
              )}
              {systemPct > 0 && (
                <Tooltip content={`System / metadata — ${fmtBytes(totals.systemBytes)} (${systemPct.toFixed(0)}%)`} relationship="label">
                  <span className={styles.compositionSeg} style={{ width: `${systemPct}%`, backgroundColor: SYSTEM_COLOR }} />
                </Tooltip>
              )}
              {deletedPct > 0 && (
                <Tooltip content={`Soft-deleted — ${fmtBytes(totals.deletedBytes)} (${deletedPct.toFixed(0)}%)`} relationship="label">
                  <span className={styles.compositionSeg} style={{ width: `${deletedPct}%`, backgroundColor: DELETED_COLOR }} />
                </Tooltip>
              )}
            </div>
            <div className={styles.legend}>
              <span className={styles.legendRow}>
                <span className={styles.legendDot} style={{ backgroundColor: LIVE_COLOR }} aria-hidden />
                <Caption1>Live data</Caption1>
                <Caption1 className={styles.legendValue}>{fmtBytes(totals.liveBytes - totals.systemBytes)}</Caption1>
              </span>
              <span className={styles.legendRow}>
                <span className={styles.legendDot} style={{ backgroundColor: SYSTEM_COLOR }} aria-hidden />
                <Caption1>System / metadata</Caption1>
                <Caption1 className={styles.legendValue}>{fmtBytes(totals.systemBytes)}</Caption1>
              </span>
              <span className={styles.legendRow}>
                <span className={styles.legendDot} style={{ backgroundColor: DELETED_COLOR }} aria-hidden />
                <Caption1>Soft-deleted</Caption1>
                <Caption1 className={styles.legendValue}>{fmtBytes(totals.deletedBytes)}</Caption1>
              </span>
            </div>
            {totals.capped && (
              <MessageBar intent="info">
                <MessageBarBody>
                  Some items have very large file counts; the walk stopped at its per-item cap, so totals are a lower bound.
                </MessageBarBody>
              </MessageBar>
            )}
          </div>

          {items.length === 0 ? (
            <div className={styles.emptyBox}>
              <span className={styles.emptyIcon} aria-hidden>
                <Database20Regular style={{ width: 24, height: 24 }} />
              </span>
              <Text weight="semibold">No OneLake items in scope.</Text>
              <Caption1>Create a lakehouse, warehouse, or mirrored database to see its storage usage here.</Caption1>
            </div>
          ) : (
            <div className={styles.panel}>
              <Text weight="semibold">Storage by item</Text>
              <LoomDataTable
                columns={columns}
                rows={items}
                getRowId={(r) => r.id}
                ariaLabel="Storage usage by OneLake item"
                empty="No items with resolvable storage."
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
