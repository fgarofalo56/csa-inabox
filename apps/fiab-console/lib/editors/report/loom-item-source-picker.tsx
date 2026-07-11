'use client';

/**
 * LoomItemSourcePicker — pick a LOOM ITEM as a Power BI source (Weave → Power BI,
 * W2). The shared control behind the "Pick a Loom item" data-source flow in the
 * report designer's DataSourcePicker, the report create dialog, the
 * paginated-report DataSourceDialog, and the semantic-model ingest source step.
 *
 * The user works in Loom items (they may not know — or want to type — the
 * underlying Azure service). They pick a lakehouse / warehouse / eventhouse /
 * KQL database / mirrored database / dataset / semantic model / data product /
 * serverless- or dedicated-SQL-pool item; this control resolves its Azure-native
 * connection server-side via GET /api/items/[type]/[id]/pbi-source (the W1
 * `resolvePbiSource`), then hands the caller a ready-to-persist
 * `ReportDataSource` seed + the raw binding coordinates — the user never types a
 * server, database, or SQL query.
 *
 * It renders the resolved connector, a REAL column preview (Synapse introspect /
 * ADX schema), and surfaces every honest gate verbatim as a Fluent MessageBar
 * (no mocks — no-vaporware.md). Fluent v9 + Loom tokens only (web3-ui.md /
 * ux-baseline.md): no hard-coded px / hex, `EmptyState` / `MessageBar`
 * primitives, cards with elevation.
 *
 * The item set is `PBI_SOURCEABLE` (the single source of truth in
 * lib/thread/thread-actions.ts — a pure, client-safe module).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Field, Dropdown, Option, Subtitle2, Text, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, DatabaseSearch20Regular, Checkmark16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { PBI_SOURCEABLE } from '@/lib/thread/thread-actions';
import type { ReportDataSource } from './report-data-source';
import type { PbiConnectorLite, PbiBindingLite, PbiPreviewColumn } from './pbi-binding';

// Re-export the pure binding types so existing importers (paginated /
// semantic-model editors) can keep importing them from the picker module.
export type { PbiConnectorLite, PbiBindingLite, PbiPreviewColumn } from './pbi-binding';

/** The full resolution handed back to the host surface on a successful pick. */
export interface LoomItemResolution {
  itemId: string;
  itemType: string;
  label: string;
  binding: PbiBindingLite;
  /** Ready-to-persist report source seed; null when resolved but not report-bindable. */
  dataSource: ReportDataSource | null;
  /** Honest note when the source is real but not directly report-bindable. */
  reportGate?: string;
  /** Real columns (Synapse introspect / ADX schema) when a live read was possible. */
  preview?: { columns: PbiPreviewColumn[] };
}

/** One item as returned by /api/items/by-type. */
interface ByTypeItem { id: string; itemType: string; displayName?: string; description?: string }

/** Human labels for the connector badge. */
const CONNECTOR_LABEL: Record<PbiConnectorLite, string> = {
  'synapse-sql': 'Synapse SQL',
  'adx': 'Azure Data Explorer',
  'adls': 'ADLS Gen2 (serverless)',
  'azure-sql': 'Azure SQL',
};

/** Friendly type labels for the item dropdown option subtitles. */
const TYPE_LABEL: Record<string, string> = {
  'lakehouse': 'Lakehouse',
  'warehouse': 'Warehouse',
  'eventhouse': 'Eventhouse',
  'kql-database': 'KQL database',
  'mirrored-database': 'Mirrored database',
  'dataset': 'Dataset',
  'semantic-model': 'Semantic model',
  'data-product': 'Data product',
  'synapse-serverless-sql-pool': 'Serverless SQL pool',
  'synapse-dedicated-sql-pool': 'Dedicated SQL pool',
};
function typeLabel(t: string): string { return TYPE_LABEL[t] || t; }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  resolved: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  badges: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  previewWrap: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    maxHeight: '32vh', overflow: 'auto',
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: tokens.spacingVerticalS,
  },
  optionText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
});

export interface LoomItemSourcePickerProps {
  /** Pre-select this item id (e.g. the report's persisted source item). */
  selectedItemId?: string;
  /** Called with the full resolution whenever an item resolves (bindable or gated). */
  onResolved: (r: LoomItemResolution) => void;
  /** Called when the selection is cleared (dropdown emptied). */
  onCleared?: () => void;
  /** Restrict the item list; defaults to the PBI_SOURCEABLE set. */
  types?: string[];
  /** How the host uses the result — tunes the copy only. */
  purpose?: 'report' | 'paginated' | 'semantic-model';
}

export function LoomItemSourcePicker({
  selectedItemId, onResolved, onCleared, types, purpose = 'report',
}: LoomItemSourcePickerProps) {
  const styles = useStyles();
  const typeCsv = useMemo(() => (types && types.length ? types : PBI_SOURCEABLE).join(','), [types]);

  const [items, setItems] = useState<ByTypeItem[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const [pickedId, setPickedId] = useState<string>(selectedItemId || '');
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [resolution, setResolution] = useState<LoomItemResolution | null>(null);

  const loadItems = useCallback(async () => {
    setListLoading(true); setListErr(null);
    try {
      const r = await clientFetch(`/api/items/by-type?types=${encodeURIComponent(typeCsv)}`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setItems([]); setListErr(j?.error || `HTTP ${r.status}`); return; }
      const list: ByTypeItem[] = (j.items || []).map((it: any) => ({
        id: it.id, itemType: it.itemType, displayName: it.displayName, description: it.description,
      }));
      // Group by type for a scannable dropdown (stable within-type by name).
      list.sort((a, b) =>
        a.itemType === b.itemType
          ? (a.displayName || a.id).localeCompare(b.displayName || b.id)
          : typeLabel(a.itemType).localeCompare(typeLabel(b.itemType)));
      setItems(list);
    } catch (e: any) { setItems([]); setListErr(e?.message || String(e)); }
    finally { setListLoading(false); }
  }, [typeCsv]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const resolve = useCallback(async (item: ByTypeItem) => {
    setResolving(true); setResolveErr(null); setResolution(null);
    try {
      const r = await clientFetch(`/api/items/${encodeURIComponent(item.itemType)}/${encodeURIComponent(item.id)}/pbi-source`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) {
        // 422 honest gate (unresolvable coords) or any structured error — surface verbatim.
        setResolveErr(j?.error || `Could not resolve this item (HTTP ${r.status}).`);
        return;
      }
      const res: LoomItemResolution = {
        itemId: item.id,
        itemType: item.itemType,
        label: item.displayName || item.id,
        binding: j.binding as PbiBindingLite,
        dataSource: (j.dataSource ?? null) as ReportDataSource | null,
        reportGate: j.reportGate || j.previewGate,
        preview: j.preview,
      };
      setResolution(res);
      onResolved(res);
    } catch (e: any) {
      setResolveErr(e?.message || String(e));
    } finally { setResolving(false); }
  }, [onResolved]);

  const onSelect = useCallback((id: string) => {
    setPickedId(id);
    if (!id) { setResolution(null); setResolveErr(null); onCleared?.(); return; }
    const item = (items || []).find((it) => it.id === id);
    if (item) void resolve(item);
  }, [items, resolve, onCleared]);

  const purposeHint =
    purpose === 'semantic-model'
      ? 'The picked item’s real Azure connection is inserted as the Power Query source — no server / account to type.'
      : purpose === 'paginated'
        ? 'The picked item’s real Synapse server + database fill this data source — no coordinates to type.'
        : 'The picked item resolves to its Azure-native backend and seeds this report’s data source — no server, database, or SQL to type.';

  const picked = (items || []).find((it) => it.id === pickedId);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle2>Pick a Loom item</Subtitle2>
        <Badge appearance="tint" color="brand" size="small">Azure-native</Badge>
        <div className={styles.spacer} />
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadItems} disabled={listLoading}>
          {listLoading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      <Caption1 className={styles.muted}>{purposeHint}</Caption1>

      {listErr && (
        <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>
      )}
      {listLoading && items === null && <Spinner size="tiny" label="Loading Loom items…" />}

      {items && items.length === 0 && !listErr && (
        <EmptyState
          icon={<DatabaseSearch20Regular />}
          title="No Power BI-sourceable items yet"
          body="Create a lakehouse, warehouse, eventhouse, KQL database, mirrored database, dataset, semantic model, or data product, then pick it here as a source."
        />
      )}

      {items && items.length > 0 && (
        <Field label="Loom item" hint="Lakehouse, warehouse, eventhouse, KQL database, mirrored database, dataset, semantic model, or data product.">
          <Dropdown
            placeholder="Choose a Loom item"
            value={picked ? `${picked.displayName || picked.id}` : ''}
            selectedOptions={pickedId ? [pickedId] : []}
            onOptionSelect={(_e, d) => onSelect(String(d.optionValue || ''))}
          >
            {items.map((it) => (
              <Option key={it.id} value={it.id} text={it.displayName || it.id}>
                <div className={styles.optionText}>
                  <Text weight="semibold">{it.displayName || it.id}</Text>
                  <Caption1 className={styles.muted}>{typeLabel(it.itemType)}</Caption1>
                </div>
              </Option>
            ))}
          </Dropdown>
        </Field>
      )}

      {resolving && <Spinner size="tiny" label="Resolving the item’s Azure-native connection…" />}

      {resolveErr && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This item isn’t ready as a source</MessageBarTitle>
            {resolveErr}
          </MessageBarBody>
        </MessageBar>
      )}

      {resolution && !resolving && (
        <div className={styles.resolved}>
          <div className={styles.badges}>
            <Checkmark16Regular aria-hidden />
            <Text weight="semibold">{resolution.label}</Text>
            <Badge appearance="filled" color="brand" size="small">{CONNECTOR_LABEL[resolution.binding.connector]}</Badge>
            {resolution.binding.behindPrivateEndpoint && (
              <Badge appearance="tint" color="informative" size="small">Private endpoint</Badge>
            )}
          </div>
          <Caption1 className={styles.muted}>
            {resolution.binding.connector === 'adx'
              ? `${resolution.binding.clusterUri || 'ADX cluster'} · ${resolution.binding.database}`
              : `${resolution.binding.server || resolution.binding.database} · ${resolution.binding.database}`}
            {resolution.binding.defaultTable ? ` · ${resolution.binding.defaultTable}` : ''}
          </Caption1>

          {resolution.reportGate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Heads up</MessageBarTitle>
                {resolution.reportGate}
              </MessageBarBody>
            </MessageBar>
          )}

          {resolution.preview && resolution.preview.columns.length > 0 && (
            <div className={styles.previewWrap}>
              <Caption1 className={styles.muted}>{resolution.preview.columns.length} column(s) — live from the source</Caption1>
              <Table size="small" aria-label="Resolved columns">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Column</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resolution.preview.columns.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell>{c.name}</TableCell>
                      <TableCell>{c.dataType || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default LoomItemSourcePicker;
