'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button,
  Caption1,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimBackendSummary } from '@/lib/azure/apim-client';

export function ApimBackendsPane() {
  const [backends, setBackends] = useState<ApimBackendSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/items/apim-backends')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.backends)) {
          setBackends(d.backends);
        } else {
          setError(d.error || 'Failed to load backends');
        }
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  const visibleBackends = useMemo(() => {
    if (!q.trim()) return backends;
    const f = q.toLowerCase();
    return backends.filter((b) =>
      b.title?.toLowerCase().includes(f) || b.url.toLowerCase().includes(f)
    );
  }, [backends, q]);

  const columns: LoomColumn<ApimBackendSummary>[] = useMemo(() => [
    {
      key: 'title',
      label: 'Backend',
      width: 200,
      render: (b) => (
        <div>
          <strong>{b.title || b.name}</strong>
          {b.description && <Caption1 style={{ display: 'block', marginTop: '2px' }}>{b.description}</Caption1>}
        </div>
      ),
    },
    {
      key: 'url',
      label: 'URL',
      width: 300,
      render: (b) => (
        <Caption1 style={{ wordBreak: 'break-all', maxWidth: '300px' }}>
          {b.url}
        </Caption1>
      ),
    },
    {
      key: 'protocol',
      label: 'Protocol',
      width: 100,
      render: (b) => <Caption1>{b.protocol || 'http'}</Caption1>,
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 100,
      sortable: false,
      render: (b) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button size="small" icon={<Edit24Regular />} />
          <Button size="small" icon={<Delete24Regular />} />
        </div>
      ),
    },
  ], []);

  if (loading) return <Section><Spinner label="Loading backends..." /></Section>;
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
      title="Backends"
      actions={<Button appearance="primary">Create backend</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, URL..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleBackends}
        getRowId={(b) => b.id}
        empty="No backends defined."
        ariaLabel="APIM backends"
      />
    </Section>
  );
}
