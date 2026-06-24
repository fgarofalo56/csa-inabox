'use client';

import { useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { LineageGraph } from '@/lib/components/catalog/lineage-graph';
import {
  Dropdown, Option, Input, Field, Button, Body1, makeStyles, tokens,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  form: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr) auto', gap: tokens.spacingHorizontalM, alignItems: 'flex-end',
    maxWidth: '100%',
    marginBottom: tokens.spacingVerticalL, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
  },
});

export default function CatalogLineagePage() {
  const s = useStyles();
  const [source, setSource] = useState<'purview' | 'unity-catalog' | 'onelake'>('unity-catalog');
  const [id, setId] = useState('');
  const [host, setHost] = useState('');
  const [committed, setCommitted] = useState<{ source: any; id: string; host?: string } | null>(null);

  return (
    <CatalogShell sectionTitle="Lineage" sectionBadge="Federated">
      <Body1 style={{ marginBottom: tokens.spacingVerticalM }}>
        Enter a Purview asset GUID, a Unity Catalog table full name, or a Fabric workspace ID. Loom hits the right back-end and overlays the lineage subgraph below.
      </Body1>

      <div className={s.form}>
        <Field label="Source">
          <Dropdown value={source} selectedOptions={[source]} onOptionSelect={(_, d) => setSource(d.optionValue as any)}>
            <Option value="unity-catalog">Unity Catalog (table)</Option>
            <Option value="purview">Purview (entity GUID)</Option>
            <Option value="onelake">OneLake (workspace ID)</Option>
          </Dropdown>
        </Field>
        <Field label="Asset ID">
          <Input value={id} onChange={(_, d) => setId(d.value)} placeholder="main.bronze.customers / 0e1a-…-9f / 1234-…-abc" />
        </Field>
        {source === 'unity-catalog' && (
          <Field label="Workspace hostname">
            <Input value={host} onChange={(_, d) => setHost(d.value)} placeholder="adb-…azuredatabricks.net" />
          </Field>
        )}
        <Button appearance="primary" disabled={!id} onClick={() => setCommitted({ source, id, host })}>
          Resolve
        </Button>
      </div>

      {committed && (
        <LineageGraph source={committed.source} id={committed.id} host={committed.host} workspaceId={committed.source === 'onelake' ? committed.id : undefined} />
      )}
    </CatalogShell>
  );
}
