'use client';

/**
 * /data-products — list of the tenant's data-product drafts (real Cosmos data
 * via /api/data-products) + entry point to the creation wizard. Microsoft
 * Purview Unified Catalog "Data products" landing parity.
 *
 * The list is the shared LoomDataTable (sortable / filterable / resizable); a
 * Tile | List ViewToggle switches to an ItemTile grid (Purview renders
 * governance concepts as selectable cards — the tile view matches that). The
 * view choice persists per-page to localStorage. Type / Status / Governance
 * filters are enumerable dropdowns (no free-form config), with Type options
 * sourced from the real CatalogModelDataProductTypeEnum.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Button, Caption1, Spinner, Subtitle2, Text,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { dataProductTypeLabel, DATA_PRODUCT_TYPES } from '@/lib/catalog/data-product-enums';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

const LS_VIEW = 'loom.dataProducts.viewMode.v1';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  nameCell: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  nameChip: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', borderRadius: tokens.borderRadiusMedium, flexShrink: 0,
  },
  link: { fontWeight: tokens.fontWeightSemibold, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  tileFooter: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
});

interface DataProductRow {
  id: string;
  displayName: string;
  type?: string;
  status?: string;
  governanceDomainName?: string;
  endorsed?: boolean;
  purviewRegistered?: boolean;
  updatedAt?: string;
}

function statusColor(status?: string): 'success' | 'informative' {
  return status === 'PUBLISHED' ? 'success' : 'informative';
}

export default function DataProductsPage() {
  const s = useStyles();
  const router = useRouter();
  const [rows, setRows] = useState<DataProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<LoomView>('tile');

  // Hydrate + persist the view choice (SSR-safe; ignore quota / private mode).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_VIEW);
      if (raw === 'tile' || raw === 'list') setView(raw);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(LS_VIEW, view); } catch { /* ignore */ }
  }, [view]);

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const r = await clientFetch('/api/data-products');
      const j = await r.json();
      if (j.ok) setRows(j.dataProducts || []);
      else setError(j.error || `HTTP ${r.status}`);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visual = itemVisual('data-product');

  const columns = useMemo<LoomColumn<DataProductRow>[]>(() => [
    {
      key: 'name', label: 'Name', sortable: true, filterable: true, filterType: 'text', width: 320,
      getValue: (r) => r.displayName,
      render: (r) => (
        <span className={s.nameCell}>
          <span className={s.nameChip} style={{ backgroundColor: `${visual.color}1f`, color: visual.color }} aria-hidden>
            <visual.icon style={{ width: 16, height: 16, color: visual.color }} />
          </span>
          <Text className={s.link}>{r.displayName}</Text>
          {r.endorsed && <Badge appearance="tint" color="success" size="small">Endorsed</Badge>}
        </span>
      ),
    },
    {
      key: 'type', label: 'Type', sortable: true, filterable: true, filterType: 'select',
      filterOptions: DATA_PRODUCT_TYPES.map((t) => t.label),
      getValue: (r) => dataProductTypeLabel(r.type),
    },
    {
      key: 'governanceDomainName', label: 'Governance domain', sortable: true, filterable: true, filterType: 'select',
      getValue: (r) => r.governanceDomainName || '—',
    },
    {
      key: 'status', label: 'Status', sortable: true, filterable: true, filterType: 'select',
      getValue: (r) => r.status || 'DRAFT',
      render: (r) => <Badge appearance="outline" color={statusColor(r.status)}>{r.status || 'DRAFT'}</Badge>,
    },
    {
      key: 'purview', label: 'Purview', sortable: true, filterable: true, filterType: 'select',
      getValue: (r) => (r.purviewRegistered ? 'Registered' : 'Loom only'),
      render: (r) => r.purviewRegistered
        ? <Badge appearance="tint" color="success">Registered</Badge>
        : <Caption1>Loom only</Caption1>,
    },
  ], [s, visual]);

  const open = (id: string) => router.push(`/data-products/${encodeURIComponent(id)}`);
  const hasRows = rows.length > 0;

  return (
    <PageShell title="Data products" subtitle="Curated, governed data products — Microsoft Purview Unified Catalog parity">
      <div className={s.bar}>
        {loading
          ? <Subtitle2>Data products</Subtitle2>
          : <Subtitle2>{rows.length} data product{rows.length === 1 ? '' : 's'}</Subtitle2>}
        <div className={s.actions}>
          {hasRows && <ViewToggle value={view} onChange={setView} ariaLabel="Data product view" />}
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => router.push('/data-products/new')}>
            New data product
          </Button>
        </div>
      </div>

      {loading && <Spinner size="small" label="Loading…" />}
      {error && <MessageBar intent="error"><MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>{error}</MessageBarBody></MessageBar>}

      {!loading && rows.length === 0 && !error && (
        <EmptyState
          icon={<visual.icon />}
          title="No data products yet"
          body="Curated, governed data products bundle datasets, dashboards, and APIs into one shareable asset — Microsoft Purview Unified Catalog parity. Create your first to populate this page."
          primaryAction={{ label: 'New data product', onClick: () => router.push('/data-products/new') }}
        />
      )}

      {!loading && hasRows && (
        view === 'tile' ? (
          <TileGrid>
            {rows.map((r) => (
              <ItemTile
                key={r.id}
                type="data-product"
                title={r.displayName}
                subtitle={dataProductTypeLabel(r.type)}
                meta={r.governanceDomainName || '—'}
                badge={<Badge appearance="outline" color={statusColor(r.status)}>{r.status || 'DRAFT'}</Badge>}
                footer={
                  <span className={s.tileFooter}>
                    {r.endorsed && <Badge appearance="tint" color="success" size="small">Endorsed</Badge>}
                    {r.purviewRegistered
                      ? <Badge appearance="tint" color="success" size="small">Purview</Badge>
                      : <Badge appearance="outline" size="small">Loom only</Badge>}
                  </span>
                }
                onClick={() => open(r.id)}
              />
            ))}
          </TileGrid>
        ) : (
          <LoomDataTable<DataProductRow>
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            onRowClick={(r) => open(r.id)}
            ariaLabel="Data products"
            empty="No data products match this filter."
          />
        )
      )}
    </PageShell>
  );
}
