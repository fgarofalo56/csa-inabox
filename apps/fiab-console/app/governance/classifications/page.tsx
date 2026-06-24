'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button, Input, Dropdown, Option, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ArrowSync24Regular, Open16Regular, Add24Regular, Delete16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Classification {
  name: string; count: number;
  samples: Array<{ id: string; displayName: string; itemType: string; workspaceId: string }>;
}
interface ClassType { id: string; name: string; sensitivity: string; color?: string; description?: string }

const SENSITIVITIES = ['Public', 'Internal', 'Confidential', 'Highly Confidential', 'Restricted'];

const useStyles = makeStyles({
  empty: { padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, textAlign: 'center' },
  taxRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  swatch: { width: '12px', height: '12px', borderRadius: tokens.borderRadiusSmall, flexShrink: 0 },
  addRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'end', flexWrap: 'wrap' },
});

export default function ClassificationsPage() {
  const s = useStyles();
  const [data, setData] = useState<Classification[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Label taxonomy admin.
  const [types, setTypes] = useState<ClassType[] | null>(null);
  const [taxErr, setTaxErr] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newSens, setNewSens] = useState('Internal');
  const [newColor, setNewColor] = useState('#1565c0');
  const [newDesc, setNewDesc] = useState('');
  const [taxBusy, setTaxBusy] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/governance/classifications');
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j.classifications);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  const loadTypes = async () => {
    try {
      const r = await clientFetch('/api/governance/classification-types');
      const j = await r.json();
      if (j.ok) setTypes(j.types); else setTaxErr(j.error);
    } catch (e: any) { setTaxErr(e?.message || String(e)); }
  };
  const addType = async () => {
    if (!newName.trim()) return;
    setTaxBusy(true); setTaxErr(null);
    try {
      const r = await clientFetch('/api/governance/classification-types', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), sensitivity: newSens, color: newColor, description: newDesc.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setTaxErr(j.error); return; }
      setTypes(j.types); setNewName(''); setNewDesc('');
    } catch (e: any) { setTaxErr(e?.message || String(e)); }
    finally { setTaxBusy(false); }
  };
  const removeType = async (id: string) => {
    setTaxBusy(true); setTaxErr(null);
    try {
      const r = await clientFetch(`/api/governance/classification-types?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) setTypes(j.types); else setTaxErr(j.error);
    } catch (e: any) { setTaxErr(e?.message || String(e)); }
    finally { setTaxBusy(false); }
  };
  useEffect(() => { load(); loadTypes(); }, []);

  const classColumns: LoomColumn<Classification>[] = [
    { key: 'name', label: 'Classification', sortable: true, filterable: true, getValue: (c) => c.name, render: (c) => <Badge appearance="tint" color="brand" size="small">{c.name}</Badge> },
    { key: 'count', label: 'Hits', sortable: true, filterable: false, width: 90, getValue: (c) => c.count, render: (c) => <strong>{c.count}</strong> },
    {
      key: 'samples', label: 'Sample items', sortable: false, filterable: false,
      getValue: (c) => c.samples.map((sm) => sm.displayName).join(' '),
      render: (c) => (
        <span>
          {c.samples.slice(0, 3).map((sm) => (
            <a key={sm.id} href={`/items/${sm.itemType}/${sm.id}`} onClick={(e) => e.stopPropagation()}
               style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginRight: tokens.spacingHorizontalM, fontSize: tokens.fontSizeBase200 }}>
              {sm.displayName} <Open16Regular />
            </a>
          ))}
          {c.samples.length > 3 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>+{c.samples.length - 3} more</Caption1>}
        </span>
      ),
    },
  ];

  return (
    <GovernanceShell sectionTitle="Classifications">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
        Distinct classifications applied across your tenant's data assets, derived live from each item's
        <code> state.classifications</code> array.
      </Body1>

      {/* ── Label taxonomy admin ── */}
      <Section title="Label taxonomy">
        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalM }}>
          The standard sensitivity labels for this tenant. Item editors apply these to assets; the rollup below reports usage.
        </Caption1>
        {taxErr && <MessageBar intent="error"><MessageBarBody>{taxErr}</MessageBarBody></MessageBar>}
        {types === null ? <Spinner size="tiny" label="Loading labels…" /> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
            {types.map((t) => (
              <div key={t.id} className={s.taxRow}>
                <span className={s.swatch} style={{ backgroundColor: t.color || tokens.colorNeutralStroke1 }} />
                <strong style={{ minWidth: 140, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{t.name}</strong>
                <Badge appearance="tint" size="small">{t.sensitivity}</Badge>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{t.description || ''}</Caption1>
                <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={taxBusy}
                  aria-label={`Remove ${t.name}`} onClick={() => removeType(t.id)} />
              </div>
            ))}
          </div>
        )}
        <div className={s.addRow} style={{ marginTop: tokens.spacingVerticalM }}>
          <Field label="New label"><Input value={newName} placeholder="e.g. PHI" onChange={(_, d) => setNewName(d.value)} /></Field>
          <Field label="Sensitivity">
            <Dropdown value={newSens} selectedOptions={[newSens]} onOptionSelect={(_, d) => d.optionValue && setNewSens(d.optionValue)} style={{ minWidth: 160 }}>
              {SENSITIVITIES.map((x) => <Option key={x} value={x}>{x}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Color"><input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} style={{ width: 40, height: 32, border: 'none', background: 'none' }} /></Field>
          <Field label="Description" style={{ flex: 1, minWidth: 180 }}><Input value={newDesc} placeholder="when to use this label" onChange={(_, d) => setNewDesc(d.value)} /></Field>
          <Button appearance="primary" icon={<Add24Regular />} disabled={taxBusy || !newName.trim()} onClick={addType}>Add label</Button>
        </div>
      </Section>

      <Section title="Applied classifications" actions={
        <Button icon={<ArrowSync24Regular />} onClick={() => { load(); loadTypes(); }} disabled={loading}>Refresh</Button>
      }>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Could not load classifications</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        )}
        {!error && (
          <LoomDataTable<Classification>
            columns={classColumns}
            rows={data || []}
            getRowId={(c) => c.name}
            loading={loading}
            empty="No classifications tagged yet. Apply classifications via item editors (Lakehouse, Data Product, Semantic Model)."
          />
        )}
      </Section>
    </GovernanceShell>
  );
}
