'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Input, Textarea, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete20Regular, ArrowSync24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';

interface SensitivityLabel {
  id: string;
  name: string;
  color: string;
  protectionNote?: string;
  createdAt: string;
  createdBy: string;
}

const useStyles = makeStyles({
  swatch: { width: '16px', height: '16px', borderRadius: '3px', display: 'inline-block', verticalAlign: 'middle', marginRight: '8px', flexShrink: 0 },
  swatchRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  colorRow: { display: 'flex', gap: tokens.spacingHorizontalXS },
  presetSwatch: { width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium, cursor: 'pointer' },
});

const PRESET_COLORS = ['#c50f1f', '#bc4b09', '#0f6cbd', '#107c10', '#8a8886', '#7719aa', '#dca900', '#3aaaaa'];

export default function SensitivityLabelsPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [labels, setLabels] = useState<SensitivityLabel[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [newProtectionNote, setNewProtectionNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/admin/sensitivity-labels');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setLabels(j.labels || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!newName.trim()) { setActionErr('Label name required'); return; }
    setCreating(true);
    setActionErr(null);
    try {
      const r = await clientFetch('/api/admin/sensitivity-labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), color: newColor, protectionNote: newProtectionNote.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setLabels(j.labels || []);
      setCreateOpen(false);
      setNewName('');
      setNewColor(PRESET_COLORS[0]);
      setNewProtectionNote('');
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this sensitivity label?')) return;
    setActionErr(null);
    try {
      const r = await clientFetch(`/api/admin/sensitivity-labels?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setLabels(j.labels || []);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = labels || [];
    if (!f) return all;
    return all.filter((l) => l.name.toLowerCase().includes(f) || (l.protectionNote || '').toLowerCase().includes(f) || (l.createdBy || '').toLowerCase().includes(f));
  }, [labels, q]);

  const columns: LoomColumn<SensitivityLabel>[] = useMemo(() => [
    { key: 'name', label: 'Label', width: 180, getValue: (l) => l.name, render: (l) => <span className={s.swatchRow}>{/* dynamic: swatch fill is the per-label color */}<span className={s.swatch} style={{ backgroundColor: l.color }} /><strong>{l.name}</strong></span> },
    { key: 'color', label: 'Color', width: 100, getValue: (l) => l.color, render: (l) => <code className={a.codeCell}>{l.color}</code> },
    { key: 'protectionNote', label: 'Protection note', width: 240, render: (l) => l.protectionNote ? <Caption1>{l.protectionNote}</Caption1> : <Caption1 className={a.muted}>—</Caption1> },
    { key: 'createdBy', label: 'Created by', width: 160, render: (l) => <Caption1>{l.createdBy}</Caption1> },
    { key: 'actions', label: '', width: 110, sortable: false, filterable: false, render: (l) => <Button size='small' appearance='subtle' icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); remove(l.id); }} aria-label={`Delete label ${l.name}`}>Delete</Button> },
  ], [s]);

  return (
    <AdminShell sectionTitle='Sensitivity labels'>
      <Section title='About sensitivity labels'>
        <SectionExplainer>
          Sensitivity labels are Loom-native tags (distinct from Microsoft Purview Information Protection labels). Each label carries a <strong>name</strong>, a <strong>color</strong> for visual distinction, and an optional <strong>protection note</strong> describing DLP rules or handling requirements. Use these to classify assets by sensitivity level: Restricted, Confidential, Internal, Public.
        </SectionExplainer>
      </Section>

      <MessageBar intent='warning' className={a.messageBar}>
        <MessageBarBody>
          <MessageBarTitle>Applied on next scan</MessageBarTitle>
          Sensitivity labels are applied during the next catalog scan. Create labels here, then apply them to assets via the item editors.
        </MessageBarBody>
      </MessageBar>

      {error && <MessageBar intent='error' className={a.messageBar}><MessageBarBody><MessageBarTitle>Could not load labels</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent='error' className={a.messageBar}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      <Section title='Sensitivity labels' actions={<><Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button><Button appearance='primary' icon={<Add24Regular />} onClick={() => setCreateOpen(true)}>Add label</Button></> }>
        <Toolbar search={q} onSearch={setQ} searchPlaceholder='Search by name, protection note...' />
        {loading && !error ? <Spinner label='Loading labels...' /> : <LoomDataTable columns={columns} rows={filtered} getRowId={(l) => l.id} empty={q ? `No labels match "${q}".` : 'No sensitivity labels defined yet. Click "Add label" to create your first one.'} ariaLabel='Sensitivity labels' />}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add sensitivity label</DialogTitle>
            <DialogContent>
              <div className={a.dialogGrid}>
                <div><Caption1 className={a.fieldLabel}>Label name</Caption1><Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder='e.g. Confidential' className={a.fullWidth} /></div>
                <div><Caption1 className={a.fieldLabel}>Color</Caption1><div className={s.colorRow}>{PRESET_COLORS.map((c) => <button key={c} type='button' onClick={() => setNewColor(c)} aria-label={`Pick color ${c}`} className={s.presetSwatch} /* dynamic: swatch fill is the preset color; border marks the selection */ style={{ backgroundColor: c, border: newColor === c ? `2px solid ${tokens.colorBrandStroke1}` : `1px solid ${tokens.colorNeutralStroke2}` }} />)}</div></div>
                <div><Caption1 className={a.fieldLabel}>Protection note (optional)</Caption1><Textarea value={newProtectionNote} onChange={(_, d) => setNewProtectionNote(d.value)} placeholder='e.g. DLP: Do not share outside the org. Encrypt email attachments.' resize='vertical' className={a.fullWidth} /></div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance='secondary' onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance='primary' onClick={create} disabled={creating || !newName.trim()}>{creating ? 'Creating...' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </AdminShell>
  );
}
