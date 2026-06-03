'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Textarea, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete20Regular, ArrowSync24Regular, Info20Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface ClassificationRule {
  id: string;
  name: string;
  matchStrategy: 'column-name-regex' | 'data-regex' | 'dictionary';
  matchValue: string;
  classification: string;
  createdAt: string;
  createdBy: string;
}

const useStyles = makeStyles({
  explainer: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start',
  },
});

const CLASSIFICATION_OPTIONS = ['PII', 'PHI', 'PCI', 'Confidential', 'Internal', 'Public', 'Restricted', 'Other'];
const MATCH_STRATEGY_OPTIONS = [
  { label: 'Column name regex', value: 'column-name-regex' },
  { label: 'Data regex', value: 'data-regex' },
  { label: 'Dictionary', value: 'dictionary' },
];

export default function ClassificationsPage() {
  const s = useStyles();
  const [rules, setRules] = useState<ClassificationRule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMatchStrategy, setNewMatchStrategy] = useState('column-name-regex');
  const [newMatchValue, setNewMatchValue] = useState('');
  const [newClassification, setNewClassification] = useState('PII');
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/classifications');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setRules(j.rules || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!newName.trim() || !newMatchValue.trim()) { setActionErr('Name and match value required'); return; }
    setCreating(true);
    setActionErr(null);
    try {
      const r = await fetch('/api/admin/classifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          matchStrategy: newMatchStrategy,
          matchValue: newMatchValue.trim(),
          classification: newClassification,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setRules(j.rules || []);
      setCreateOpen(false);
      setNewName('');
      setNewMatchStrategy('column-name-regex');
      setNewMatchValue('');
      setNewClassification('PII');
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this classification rule? It will not apply to future scans.')) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/admin/classifications?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setRules(j.rules || []);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = rules || [];
    if (!f) return all;
    return all.filter((r) => r.name.toLowerCase().includes(f) || r.classification.toLowerCase().includes(f) || r.matchStrategy.toLowerCase().includes(f) || r.matchValue.toLowerCase().includes(f) || (r.createdBy || '').toLowerCase().includes(f));
  }, [rules, q]);

  const columns: LoomColumn<ClassificationRule>[] = useMemo(() => [
    { key: 'name', label: 'Rule name', width: 180, getValue: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: 'classification', label: 'Classification', width: 140, getValue: (r) => r.classification, render: (r) => <Badge appearance='tint' color='brand' size='small'>{r.classification}</Badge> },
    { key: 'matchStrategy', label: 'Match strategy', width: 160, getValue: (r) => r.matchStrategy, render: (r) => <Caption1>{MATCH_STRATEGY_OPTIONS.find((m) => m.value === r.matchStrategy)?.label || r.matchStrategy}</Caption1> },
    { key: 'matchValue', label: 'Pattern / value', width: 240, getValue: (r) => r.matchValue, render: (r) => <code style={{ fontSize: '11px' }}>{r.matchValue}</code> },
    { key: 'createdBy', label: 'Created by', width: 160, render: (r) => <Caption1>{r.createdBy}</Caption1> },
    { key: 'actions', label: '', width: 110, sortable: false, filterable: false, render: (r) => <Button size='small' appearance='subtle' icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); remove(r.id); }} aria-label={`Delete rule ${r.name}`}>Delete</Button> },
  ], []);

  return (
    <AdminShell sectionTitle='Classifications'>
      <Section title='About classification rules'>
        <div className={s.explainer}>
          <Info20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' }} />
          <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5 }}>
            Classification rules detect sensitive-info types and apply classifications (PII, PHI, PCI, Confidential, etc.) to catalog items on scan. Choose a <strong>match strategy</strong>:
            <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
              <li><strong>Column name regex:</strong> Match column names (e.g., <code>.*email.*</code>)</li>
              <li><strong>Data regex:</strong> Match data values (e.g., <code>{'\\d{3}-\\d{2}-\\d{4}'}</code> for SSN)</li>
              <li><strong>Dictionary:</strong> Match against a word list (comma-separated)</li>
            </ul>
          </Body1>
        </div>
      </Section>

      <MessageBar intent='warning' style={{ marginBottom: '16px' }}>
        <MessageBarBody>
          <MessageBarTitle>Applied on next scan</MessageBarTitle>
          Classification rules take effect the next time you run a scan. Existing classifications on assets do not change retroactively.
        </MessageBarBody>
      </MessageBar>

      {error && <MessageBar intent='error' style={{ marginBottom: '16px' }}><MessageBarBody><MessageBarTitle>Could not load rules</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent='error' style={{ marginBottom: '16px' }}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      <Section title='Classification rules' actions={<><Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button><Button appearance='primary' icon={<Add24Regular />} onClick={() => setCreateOpen(true)}>Add rule</Button></> }>
        <Toolbar search={q} onSearch={setQ} searchPlaceholder='Search by name, classification, pattern...' />
        {loading && !error ? <Spinner label='Loading rules...' /> : <LoomDataTable columns={columns} rows={filtered} getRowId={(r) => r.id} empty={q ? `No rules match "${q}".` : 'No classification rules defined yet. Click "Add rule" to create your first one.'} ariaLabel='Classification rules' />}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add classification rule</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Rule name</Caption1><Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder='e.g. Email columns' style={{ width: '100%' }} /></div>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Match strategy</Caption1><Dropdown value={newMatchStrategy} onOptionSelect={(_, d) => setNewMatchStrategy(d.optionValue || 'column-name-regex')} style={{ width: '100%' }}>{MATCH_STRATEGY_OPTIONS.map((opt) => <Option key={opt.value} value={opt.value}>{opt.label}</Option>)}</Dropdown></div>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Pattern or value{newMatchStrategy === 'column-name-regex' && ' (regex for column names)'}{newMatchStrategy === 'data-regex' && ' (regex for data)'}{newMatchStrategy === 'dictionary' && ' (comma-separated words)'}</Caption1><Textarea value={newMatchValue} onChange={(_, d) => setNewMatchValue(d.value)} placeholder={newMatchStrategy === 'column-name-regex' ? '.*email.*' : newMatchStrategy === 'data-regex' ? '\\d{3}-\\d{2}-\\d{4}' : 'word1, word2, word3'} resize='vertical' style={{ width: '100%' }} /></div>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Classification</Caption1><Dropdown value={newClassification} onOptionSelect={(_, d) => setNewClassification(d.optionValue || 'PII')} style={{ width: '100%' }}>{CLASSIFICATION_OPTIONS.map((opt) => <Option key={opt} value={opt}>{opt}</Option>)}</Dropdown></div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance='secondary' onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance='primary' onClick={create} disabled={creating || !newName.trim() || !newMatchValue.trim()}>{creating ? 'Creating...' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </AdminShell>
  );
}
