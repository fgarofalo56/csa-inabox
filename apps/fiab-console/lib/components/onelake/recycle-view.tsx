'use client';

/**
 * OneLake Recycle bin — parity with the Microsoft Fabric workspace recycle bin
 * (recoverableItems / recover / delete), themed with Fluent v9 + Loom tokens.
 *
 * Shows this tenant's soft-deleted OneLake items with deleted-on, deleted-by,
 * and a days-remaining retention countdown, plus per-row Restore and
 * Purge-permanently actions (each behind a confirmation dialog).
 *
 * REAL data + backend:
 *   list    → GET    /api/onelake/recycle
 *   restore → POST   /api/onelake/recycle   { itemId }   (un-deletes ADLS blobs +
 *                                                         clears Cosmos _recycled)
 *   purge   → DELETE /api/onelake/recycle?itemId=         (hard Cosmos delete)
 *
 * No mock data, no dead controls. The retention window is sourced from each
 * item's purgeAfter (deletedAt + LOOM_RECYCLE_RETENTION_DAYS).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner,
  Badge,
  Button,
  Text,
  Caption1,
  Tooltip,
  MessageBar,
  MessageBarBody,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowUndo20Regular,
  Delete20Regular,
  BinRecycle20Regular,
  ArrowClockwise20Regular,
} from '@fluentui/react-icons';

import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { findItemType } from '@/lib/catalog/fabric-item-types';

export interface DeletedItem {
  id: string;
  itemType: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  deletedAt: string;
  deletedBy: string;
  purgeAfter: string;
  adlsCount: number;
}

export interface RecycleViewProps {
  /** Map of workspaceId → display name (so the Location column reads nicely). */
  workspaceNames?: Map<string, string>;
}

function typeLabel(itemType: string): string {
  return findItemType(itemType)?.displayName ?? itemVisual(itemType).label;
}

function absolute(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
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
  if (abs < 2592000) return RTF.format(Math.round(diffSec / 86400), 'day');
  return RTF.format(Math.round(diffSec / 2592000), 'month');
}

/** Whole days until purgeAfter (clamped ≥ 0). */
function daysRemaining(purgeAfter?: string): number {
  if (!purgeAfter) return 0;
  const t = new Date(purgeAfter).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 86_400_000));
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  headIcon: {
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusLarge,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    flexShrink: 0,
  },
  headText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
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
  rowActions: { display: 'inline-flex', gap: tokens.spacingHorizontalXS },
  emptyBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXXL,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    textAlign: 'center',
  },
});

export function RecycleView({ workspaceNames }: RecycleViewProps) {
  const styles = useStyles();
  const [items, setItems] = useState<DeletedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // confirm dialog: which action on which item
  const [confirm, setConfirm] = useState<{ kind: 'restore' | 'purge'; item: DeletedItem } | null>(null);

  const load = useCallback(() => {
    setItems(null);
    setError(null);
    fetch('/api/onelake/recycle')
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j?.error || `HTTP ${r.status}`)))))
      .then((d) => setItems(Array.isArray(d?.items) ? d.items : []))
      .catch((e) => { setError(e?.message ?? 'Failed to load recycle bin'); setItems([]); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const wsName = useCallback(
    (id: string) => workspaceNames?.get(id) ?? id,
    [workspaceNames],
  );

  const runAction = useCallback(async (kind: 'restore' | 'purge', item: DeletedItem) => {
    setBusyId(item.id);
    setActionError(null);
    try {
      const res = kind === 'restore'
        ? await fetch('/api/onelake/recycle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ itemId: item.id }),
          })
        : await fetch(`/api/onelake/recycle?itemId=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${res.status}`);
      // Optimistic remove + reconcile with server.
      setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
      load();
    } catch (e: any) {
      setActionError(`${kind === 'restore' ? 'Restore' : 'Purge'} failed: ${e?.message ?? e}`);
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  }, [load]);

  const columns: LoomColumn<DeletedItem>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Name',
      width: 240,
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
    { key: 'type', label: 'Type', width: 160, getValue: (r) => typeLabel(r.itemType), render: (r) => typeLabel(r.itemType) },
    { key: 'location', label: 'Location', width: 160, getValue: (r) => wsName(r.workspaceId), render: (r) => wsName(r.workspaceId) },
    {
      key: 'deletedOn',
      label: 'Deleted on',
      width: 150,
      filterType: 'date',
      getValue: (r) => new Date(r.deletedAt).getTime() || 0,
      render: (r) => (
        <Tooltip content={absolute(r.deletedAt)} relationship="label">
          <span>{relative(r.deletedAt)}</span>
        </Tooltip>
      ),
    },
    { key: 'deletedBy', label: 'Deleted by', width: 180, getValue: (r) => r.deletedBy || '', render: (r) => r.deletedBy || '—' },
    {
      key: 'daysRemaining',
      label: 'Days remaining',
      width: 150,
      filterable: false,
      getValue: (r) => daysRemaining(r.purgeAfter),
      render: (r) => {
        const d = daysRemaining(r.purgeAfter);
        return (
          <Tooltip content={`Auto-purges ${absolute(r.purgeAfter)}`} relationship="label">
            <Badge appearance="tint" color={d <= 7 ? 'warning' : 'informative'}>
              {d === 0 ? 'Expired' : `${d} day${d === 1 ? '' : 's'}`}
            </Badge>
          </Tooltip>
        );
      },
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 210,
      sortable: false,
      filterable: false,
      render: (r) => (
        <span className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          <Button
            size="small"
            appearance="primary"
            icon={<ArrowUndo20Regular />}
            disabled={busyId === r.id}
            onClick={() => setConfirm({ kind: 'restore', item: r })}
          >
            Restore
          </Button>
          <Button
            size="small"
            appearance="subtle"
            icon={<Delete20Regular />}
            disabled={busyId === r.id}
            onClick={() => setConfirm({ kind: 'purge', item: r })}
          >
            Purge
          </Button>
        </span>
      ),
    },
  ], [styles.nameCell, styles.nameIcon, styles.nameText, styles.rowActions, wsName, busyId]);

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.headIcon} aria-hidden><BinRecycle20Regular /></span>
        <span className={styles.headText}>
          <Text weight="semibold" size={400}>Recycle bin</Text>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Deleted OneLake items are recoverable here until their retention window elapses, then they are
            permanently purged. Restoring un-deletes the item and its ADLS Gen2 data.
          </Caption1>
        </span>
        <div className={styles.toolbar}>
          <Button appearance="subtle" icon={<ArrowClockwise20Regular />} onClick={load}>Refresh</Button>
        </div>
      </div>

      {actionError && (
        <MessageBar intent="error">
          <MessageBarBody>{actionError}</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>Could not load the recycle bin: {error}</MessageBarBody>
        </MessageBar>
      )}

      {items === null && <Spinner label="Loading recycle bin…" />}

      {items !== null && items.length === 0 && !error && (
        <div className={styles.emptyBox}>
          <BinRecycle20Regular style={{ width: 28, height: 28 }} />
          <Text weight="semibold">The recycle bin is empty.</Text>
          <Caption1>Items deleted from the OneLake catalog appear here until their retention window elapses.</Caption1>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <Section title={`Deleted items · ${items.length}`}>
          <LoomDataTable
            columns={columns}
            rows={items}
            getRowId={(r) => r.id}
            ariaLabel="Deleted OneLake items"
            empty="No deleted items."
          />
        </Section>
      )}

      {/* Confirmation dialog (restore + purge share one surface) */}
      <Dialog open={!!confirm} onOpenChange={(_e, d) => { if (!d.open) setConfirm(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {confirm?.kind === 'restore' ? 'Restore item' : 'Permanently delete item'}
            </DialogTitle>
            <DialogContent>
              {confirm?.kind === 'restore' ? (
                <Text>
                  Restore <strong>{confirm?.item.displayName}</strong>? This returns the item to the OneLake
                  catalog and un-deletes its ADLS Gen2 data
                  {confirm && confirm.item.adlsCount > 0 ? ` (${confirm.item.adlsCount} folder${confirm.item.adlsCount === 1 ? '' : 's'})` : ''}.
                </Text>
              ) : (
                <Text>
                  Permanently delete <strong>{confirm?.item.displayName}</strong>? This removes the item from
                  Loom and cannot be undone through the recycle bin. Any ADLS Gen2 data remains under the
                  storage account&apos;s soft-delete retention but is no longer recoverable through Loom.
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirm(null)} disabled={busyId !== null}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                icon={confirm?.kind === 'restore' ? <ArrowUndo20Regular /> : <Delete20Regular />}
                disabled={busyId !== null}
                onClick={() => confirm && runAction(confirm.kind, confirm.item)}
              >
                {confirm?.kind === 'restore' ? 'Restore' : 'Permanently delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export default RecycleView;
