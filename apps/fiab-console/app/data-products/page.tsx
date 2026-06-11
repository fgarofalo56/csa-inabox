'use client';

/**
 * /data-products — list of the tenant's data-product drafts (real Cosmos data
 * via /api/data-products) + entry point to the creation wizard. Microsoft
 * Purview Unified Catalog "Data products" landing parity.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Button, Caption1, Spinner, Subtitle2, Text,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { dataProductTypeLabel } from '@/lib/catalog/data-product-enums';

const useStyles = makeStyles({
  bar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  wrap: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, overflow: 'auto' },
  link: { cursor: 'pointer', color: tokens.colorBrandForegroundLink },
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

export default function DataProductsPage() {
  const s = useStyles();
  const router = useRouter();
  const [rows, setRows] = useState<DataProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

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

  return (
    <PageShell title="Data products" subtitle="Curated, governed data products — Microsoft Purview Unified Catalog parity">
      <div className={s.bar}>
        <Subtitle2>{rows.length} data product{rows.length === 1 ? '' : 's'}</Subtitle2>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => router.push('/data-products/new')}>
          New data product
        </Button>
      </div>

      {loading && <Spinner size="small" label="Loading…" />}
      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}

      {!loading && rows.length === 0 && !error && (
        <MessageBar intent="info"><MessageBarBody>No data products yet. Select <strong>New data product</strong> to create one.</MessageBarBody></MessageBar>
      )}

      {rows.length > 0 && (
        <div className={s.wrap}>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Governance domain</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Purview</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Text className={s.link} onClick={() => router.push(`/data-products/${encodeURIComponent(r.id)}`)}>
                      {r.displayName}
                    </Text>
                    {r.endorsed && <Badge appearance="tint" color="success" style={{ marginLeft: 6 }}>Endorsed</Badge>}
                  </TableCell>
                  <TableCell>{dataProductTypeLabel(r.type)}</TableCell>
                  <TableCell>{r.governanceDomainName || '—'}</TableCell>
                  <TableCell><Badge appearance="outline" color={r.status === 'PUBLISHED' ? 'success' : 'informative'}>{r.status || 'DRAFT'}</Badge></TableCell>
                  <TableCell>{r.purviewRegistered ? <Badge appearance="tint" color="success">Registered</Badge> : <Caption1>Loom only</Caption1>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
