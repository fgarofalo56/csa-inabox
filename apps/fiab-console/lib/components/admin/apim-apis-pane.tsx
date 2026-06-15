'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1,
} from '@fluentui/react-components';
import { Delete24Regular, Edit24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimApiSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

const useStyles = makeStyles({
  protocolBadge: { marginRight: tokens.spacingHorizontalS },
});

export function ApimApisPane() {
  const styles = useStyles();
  const [apis, setApis] = useState<ApimApiSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    // apimFetchJson reads the body as text first and surfaces a non-JSON body
    // (HTML 404/500 page) or an honest 503 config-gate as a readable error
    // instead of crashing the pane with "Unexpected token '<'".
    apimFetchJson('/api/items/apim-api')
      .then((d) => {
        if (d.ok && Array.isArray(d.apis)) {
          setApis(d.apis as ApimApiSummary[]);
        } else {
          setError(d.error || 'Failed to load APIs');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  const visibleApis = useMemo(() => {
    if (!q.trim()) return apis;
    const f = q.toLowerCase();
    return apis.filter((a) =>
      a.displayName.toLowerCase().includes(f) ||
      a.path.toLowerCase().includes(f) ||
      a.name.toLowerCase().includes(f)
    );
  }, [apis, q]);

  const columns: LoomColumn<ApimApiSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Name',
      width: 240,
      render: (a) => (
        <div>
          <strong>{a.displayName}</strong>
          <Caption1 style={{ display: 'block', marginTop: '4px', color: tokens.colorNeutralForeground3 }}>{a.path}</Caption1>
        </div>
      ),
    },
    {
      key: 'protocols',
      label: 'Protocols',
      width: 140,
      render: (a) => (
        <div>
          {(a.protocols || []).map((p) => (
            <Badge key={p} className={styles.protocolBadge} appearance="outline" size="small">
              {p.toUpperCase()}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'subscriptionRequired',
      label: 'Requires key',
      width: 120,
      render: (a) => (
        <Badge appearance="outline" color={a.subscriptionRequired ? 'success' : 'warning'}>
          {a.subscriptionRequired ? 'Yes' : 'No'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 120,
      sortable: false,
      render: (a) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button
            size="small"
            appearance="subtle"
            icon={<Edit24Regular />}
            aria-label={`Edit ${a.displayName}`}
            title={`Edit ${a.displayName}`}
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<Delete24Regular />}
            aria-label={`Delete ${a.displayName}`}
            title={`Delete ${a.displayName}`}
          />
        </div>
      ),
    },
  ], [styles]);

  if (loading) return <Section><Spinner label="Loading APIs..." /></Section>;

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
      title="APIs"
      actions={<Button appearance="primary">Create API</Button>}
    >
      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter by name, path..."
      />
      <LoomDataTable
        columns={columns}
        rows={visibleApis}
        getRowId={(a) => a.id}
        empty="No APIs defined."
        ariaLabel="APIM APIs"
      />
    </Section>
  );
}
