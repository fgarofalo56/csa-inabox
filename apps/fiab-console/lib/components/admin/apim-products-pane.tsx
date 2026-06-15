'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimProductSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

export function ApimProductsPane() {
  const [products, setProducts] = useState<ApimProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    // apimFetchJson surfaces a non-JSON body / honest 503 gate as a readable
    // error instead of crashing the pane with "Unexpected token '<'".
    apimFetchJson('/api/items/apim-product')
      .then((d) => {
        if (d.ok && Array.isArray(d.products)) {
          setProducts(d.products as ApimProductSummary[]);
        } else {
          setError(d.error || 'Failed to load products');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  const visibleProducts = useMemo(() => {
    if (!q.trim()) return products;
    const f = q.toLowerCase();
    return products.filter((p) =>
      p.displayName.toLowerCase().includes(f) ||
      (p.description || '').toLowerCase().includes(f)
    );
  }, [products, q]);

  const columns: LoomColumn<ApimProductSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Product',
      width: 240,
      render: (p) => (
        <div>
          <strong>{p.displayName}</strong>
          {p.description && <Caption1 style={{ display: 'block', marginTop: '4px' }}>{p.description}</Caption1>}
        </div>
      ),
    },
    {
      key: 'state',
      label: 'State',
      width: 120,
      render: (p) => (
        <Badge appearance="outline" color={p.state === 'published' ? 'success' : 'warning'}>
          {p.state}
        </Badge>
      ),
    },
    {
      key: 'subscriptionRequired',
      label: 'Subscription',
      width: 120,
      render: (p) => (
        <Badge appearance="outline" color={p.subscriptionRequired ? 'success' : 'subtle'}>
          {p.subscriptionRequired ? 'Required' : 'Optional'}
        </Badge>
      ),
    },
    {
      key: 'approvalRequired',
      label: 'Approval',
      width: 120,
      render: (p) => (
        <Badge appearance="outline" color={p.approvalRequired ? 'warning' : 'success'}>
          {p.approvalRequired ? 'Manual' : 'Auto'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 120,
      sortable: false,
      render: (p) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button size="small" icon={<Edit24Regular />} />
          <Button size="small" icon={<Delete24Regular />} />
        </div>
      ),
    },
  ], []);

  if (loading) return <Section><Spinner label="Loading products..." /></Section>;
  if (error) {
    return (
      <Section>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </Section>
    );
  }

  return (
    <Section
      title="Products"
      actions={<Button appearance="primary">Create product</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, description..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleProducts}
        getRowId={(p) => p.id}
        empty="No products defined."
        ariaLabel="APIM Products"
      />
    </Section>
  );
}
