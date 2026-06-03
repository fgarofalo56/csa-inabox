'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimNamedValueSummary } from '@/lib/azure/apim-client';

export function ApimNamedValuesPane() {
  const [values, setValues] = useState<ApimNamedValueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/items/apim-named-values')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.namedValues)) {
          setValues(d.namedValues);
        } else {
          setError(d.error || 'Failed to load named values');
        }
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);

  const visibleValues = useMemo(() => {
    if (!q.trim()) return values;
    const f = q.toLowerCase();
    return values.filter((v) => v.displayName.toLowerCase().includes(f));
  }, [values, q]);

  const columns: LoomColumn<ApimNamedValueSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Name',
      width: 200,
      render: (v) => (
        <div>
          <strong>{v.displayName}</strong>
          <Caption1 style={{ display: 'block', marginTop: '2px', color: tokens.colorNeutralForeground3 }}>{v.name}</Caption1>
        </div>
      ),
    },
    {
      key: 'secret',
      label: 'Type',
      width: 100,
      render: (v) => (
        <Badge appearance="outline" color={v.secret ? 'warning' : 'success'}>
          {v.secret ? 'Secret' : 'Value'}
        </Badge>
      ),
    },
    {
      key: 'value',
      label: 'Value',
      width: 300,
      render: (v) => (
        <Caption1 style={{ wordBreak: 'break-all', maxWidth: '300px' }}>
          {v.secret ? '(encrypted)' : v.value || '—'}
        </Caption1>
      ),
    },
    {
      key: 'tags',
      label: 'Tags',
      width: 150,
      render: (v) => (
        <div>
          {(v.tags || []).map((t) => (
            <Badge key={t} appearance="outline" size="small" style={{ marginRight: '4px' }}>
              {t}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 100,
      sortable: false,
      render: (v) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button size="small" icon={<Edit24Regular />} />
          <Button size="small" icon={<Delete24Regular />} />
        </div>
      ),
    },
  ], []);

  if (loading) return <Section><Spinner label="Loading named values..." /></Section>;
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
      title="Named values"
      actions={<Button appearance="primary">Create named value</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleValues}
        getRowId={(v) => v.id}
        empty="No named values defined."
        ariaLabel="APIM named values"
      />
    </Section>
  );
}
