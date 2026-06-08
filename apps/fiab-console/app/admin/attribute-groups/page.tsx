'use client';

/**
 * Custom attributes / attribute groups admin (F17).
 *
 * Per-domain attribute schemas that drive the Create wizard's "Custom
 * attributes" step and item Edit dialogs. Azure-native: backed by the Cosmos
 * `attribute-groups` container via /api/attribute-groups. No Microsoft Purview
 * / Fabric account is required.
 *
 * Parity with Microsoft Purview Unified Catalog → Custom metadata:
 *   - groups scope to governance domains (empty scope = all domains)
 *   - attributes have a name, type (Text/Number/Date/Single-select), required
 *     flag, and (for enum) a value list
 *   - attributes are ordered with ↑/↓ reorder controls
 *   - type is immutable after creation; everything else is editable
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Textarea, Button, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, Delete20Regular, Edit20Regular, ArrowSync24Regular,
  ArrowUp20Regular, ArrowDown20Regular, Info20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import {
  type AttributeGroupDoc, type AttributeDef, type AttributeType,
  ATTRIBUTE_TYPE_LABELS, validateAttributes,
} from '@/lib/types/attribute-groups';

interface DomainItem { id: string; name: string; }

const TYPE_OPTIONS: AttributeType[] = ['string', 'number', 'date', 'enum'];

const useStyles = makeStyles({
  explainer: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  formCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  attrRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  attrMain: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0, gap: '2px' },
  attrName: { fontWeight: tokens.fontWeightSemibold },
  attrMeta: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  attrEditor: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground2,
  },
});

function emptyAttr(order: number): AttributeDef {
  return { id: `attr-${Math.random().toString(36).slice(2, 10)}`, name: '', type: 'string', required: false, order };
}

export default function AttributeGroupsPage() {
  const s = useStyles();
  const [groups, setGroups] = useState<AttributeGroupDoc[] | null>(null);
  const [domains, setDomains] = useState<DomainItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [domainFilter, setDomainFilter] = useState<string>('');

  // Create-group dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDomains, setNewDomains] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Edit-group dialog (holds a working draft; Save persists via PATCH)
  const [editGroup, setEditGroup] = useState<AttributeGroupDoc | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftDomains, setDraftDomains] = useState<string[]>([]);
  const [draftAttrs, setDraftAttrs] = useState<AttributeDef[]>([]);
  const [editingAttr, setEditingAttr] = useState<AttributeDef | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/attribute-groups');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setGroups(j.groups || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadDomains = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/domains');
      const j = await r.json();
      if (j.ok) setDomains((j.domains || []).map((d: any) => ({ id: d.id, name: d.name })));
    } catch { /* domains are optional; scope can still be "all" */ }
  }, []);

  useEffect(() => { load(); loadDomains(); }, [load, loadDomains]);

  const domainName = useCallback((id: string) => domains.find((d) => d.id === id)?.name || id, [domains]);

  async function createGroup() {
    if (!newName.trim()) { setActionErr('Group name is required'); return; }
    setCreating(true); setActionErr(null);
    try {
      const r = await fetch('/api/attribute-groups', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined, domainIds: newDomains }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setCreateOpen(false);
      setNewName(''); setNewDesc(''); setNewDomains([]);
      await load();
      // Open the newly created group so the admin can add attributes.
      if (j.group) openEdit(j.group);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  function openEdit(g: AttributeGroupDoc) {
    setEditGroup(g);
    setDraftName(g.name);
    setDraftDesc(g.description || '');
    setDraftDomains(g.domainIds || []);
    setDraftAttrs((g.attributes || []).slice().sort((a, b) => a.order - b.order));
    setEditingAttr(null);
    setActionErr(null);
  }

  async function saveGroup() {
    if (!editGroup) return;
    if (!draftName.trim()) { setActionErr('Group name is required'); return; }
    const verr = validateAttributes(draftAttrs);
    if (verr) { setActionErr(verr); return; }
    setSaving(true); setActionErr(null);
    try {
      const r = await fetch(`/api/attribute-groups?groupId=${encodeURIComponent(editGroup.groupId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: draftName.trim(), description: draftDesc.trim() || undefined,
          domainIds: draftDomains,
          attributes: draftAttrs.map((a, i) => ({ ...a, order: i })),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setEditGroup(null);
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }

  async function deleteGroup(g: AttributeGroupDoc) {
    if (!confirm(`Delete attribute group "${g.name}"? Its attributes will be removed from every domain's Create wizard and Edit dialogs.`)) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/attribute-groups?groupId=${encodeURIComponent(g.groupId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  // --- attribute draft mutations (local; persisted on Save) ----------------
  function upsertAttr(a: AttributeDef) {
    setDraftAttrs((prev) => {
      const idx = prev.findIndex((x) => x.id === a.id);
      if (idx === -1) return [...prev, { ...a, order: prev.length }];
      const next = prev.slice(); next[idx] = a; return next;
    });
    setEditingAttr(null);
  }
  function removeAttr(id: string) {
    setDraftAttrs((prev) => prev.filter((x) => x.id !== id).map((x, i) => ({ ...x, order: i })));
  }
  function moveAttr(id: string, dir: -1 | 1) {
    setDraftAttrs((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const j = idx + dir;
      if (idx === -1 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[j]] = [next[j], next[idx]];
      return next.map((x, i) => ({ ...x, order: i }));
    });
  }

  const filtered = useMemo(() => {
    let all = groups || [];
    if (domainFilter) all = all.filter((g) => g.domainIds.length === 0 || g.domainIds.includes(domainFilter));
    const f = q.toLowerCase().trim();
    if (!f) return all;
    return all.filter((g) =>
      g.name.toLowerCase().includes(f) ||
      (g.description || '').toLowerCase().includes(f) ||
      g.attributes.some((a) => a.name.toLowerCase().includes(f)));
  }, [groups, q, domainFilter]);

  const columns: LoomColumn<AttributeGroupDoc>[] = useMemo(() => [
    { key: 'name', label: 'Group', width: 200, getValue: (g) => g.name, render: (g) => (
      <div><strong>{g.name}</strong>{g.description && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{g.description}</Caption1>}</div>
    ) },
    { key: 'attributes', label: 'Attributes', width: 90, getValue: (g) => g.attributes.length, render: (g) => <Badge appearance="tint" color="brand" size="small">{g.attributes.length}</Badge> },
    { key: 'domains', label: 'Applies to', width: 240, sortable: false, render: (g) => (
      g.domainIds.length === 0
        ? <Badge appearance="outline" color="informative" size="small">All domains</Badge>
        : <span className={s.attrMeta}>{g.domainIds.map((d) => <Badge key={d} appearance="tint" size="small">{domainName(d)}</Badge>)}</span>
    ) },
    { key: 'createdBy', label: 'Created by', width: 160, render: (g) => <Caption1>{g.createdBy}</Caption1> },
    { key: 'actions', label: '', width: 150, sortable: false, filterable: false, render: (g) => (
      <span style={{ display: 'flex', gap: 4 }}>
        <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={(e) => { e.stopPropagation(); openEdit(g); }} aria-label={`Edit ${g.name}`}>Edit</Button>
        <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); deleteGroup(g); }} aria-label={`Delete ${g.name}`} />
      </span>
    ) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [domainName, s.attrMeta]);

  return (
    <AdminShell sectionTitle="Custom attributes">
      <Section title="About custom attributes">
        <div className={s.explainer}>
          <Info20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' }} />
          <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5 }}>
            Define <strong>attribute groups</strong> that attach extra, governed metadata to the items people create.
            Each attribute has a type (<strong>Text</strong>, <strong>Number</strong>, <strong>Date</strong>, or <strong>Single select</strong>),
            an optional <strong>required</strong> flag, and (for single-select) a list of allowed values.
            Scope a group to one or more <strong>domains</strong> — leave the scope empty to apply it to every domain.
            Required attributes appear on the Create wizard&apos;s <strong>Custom attributes</strong> step for items in those domains and
            block completion until they have a value. This is Loom&apos;s Azure-native equivalent of Purview Unified Catalog custom metadata —
            no Purview account is required.
          </Body1>
        </div>
      </Section>

      {error && <MessageBar intent="error" style={{ marginBottom: 16 }}><MessageBarBody><MessageBarTitle>Could not load attribute groups</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent="error" style={{ marginBottom: 16 }}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      <Section title="Attribute groups" actions={<>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => { setNewName(''); setNewDesc(''); setNewDomains([]); setActionErr(null); setCreateOpen(true); }}>Add group</Button>
      </>}>
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by group or attribute name…" actions={
          <Dropdown placeholder="Filter by domain" value={domainFilter ? domainName(domainFilter) : 'All domains'} selectedOptions={[domainFilter]} onOptionSelect={(_, d) => setDomainFilter(d.optionValue || '')} style={{ minWidth: 180 }}>
            <Option value="">All domains</Option>
            {domains.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
          </Dropdown>
        } />
        {loading && !error
          ? <Spinner label="Loading attribute groups…" />
          : <LoomDataTable columns={columns} rows={filtered} getRowId={(g) => g.groupId} onRowClick={(g) => openEdit(g)} empty={q || domainFilter ? 'No groups match your filter.' : 'No attribute groups yet. Click "Add group" to define your first schema.'} ariaLabel="Attribute groups" />}
      </Section>

      {/* Create-group dialog */}
      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add attribute group</DialogTitle>
            <DialogContent>
              <div className={s.formCol}>
                <Field label="Group name" required>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="e.g. Data governance" />
                </Field>
                <Field label="Description">
                  <Textarea value={newDesc} onChange={(_, d) => setNewDesc(d.value)} resize="vertical" placeholder="What these attributes capture" />
                </Field>
                <Field label="Domain scope" hint="Leave empty to apply to all domains.">
                  <Dropdown multiselect placeholder="All domains" selectedOptions={newDomains} value={newDomains.map(domainName).join(', ')} onOptionSelect={(_, d) => setNewDomains(d.selectedOptions)}>
                    {domains.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
                  </Dropdown>
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={createGroup} disabled={creating || !newName.trim()}>{creating ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Edit-group dialog with attribute editor */}
      <Dialog open={!!editGroup} onOpenChange={(_, d) => { if (!d.open) setEditGroup(null); }}>
        <DialogSurface style={{ maxWidth: 720, width: '92vw' }}>
          <DialogBody>
            <DialogTitle>Edit attribute group</DialogTitle>
            <DialogContent>
              <div className={s.formCol}>
                <Field label="Group name" required>
                  <Input value={draftName} onChange={(_, d) => setDraftName(d.value)} />
                </Field>
                <Field label="Description">
                  <Textarea value={draftDesc} onChange={(_, d) => setDraftDesc(d.value)} resize="vertical" />
                </Field>
                <Field label="Domain scope" hint="Leave empty to apply to all domains.">
                  <Dropdown multiselect placeholder="All domains" selectedOptions={draftDomains} value={draftDomains.map(domainName).join(', ')} onOptionSelect={(_, d) => setDraftDomains(d.selectedOptions)}>
                    {domains.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
                  </Dropdown>
                </Field>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Attributes ({draftAttrs.length})</Caption1>
                    <Button size="small" appearance="secondary" icon={<Add24Regular />} onClick={() => setEditingAttr(emptyAttr(draftAttrs.length))} disabled={!!editingAttr}>Add attribute</Button>
                  </div>

                  {draftAttrs.length === 0 && !editingAttr && (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No attributes yet. Click &quot;Add attribute&quot; to define one.</Body1>
                  )}

                  {draftAttrs.map((a, i) => (
                    <div key={a.id} className={s.attrRow}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <Button size="small" appearance="subtle" icon={<ArrowUp20Regular />} disabled={i === 0} onClick={() => moveAttr(a.id, -1)} aria-label={`Move ${a.name} up`} />
                        <Button size="small" appearance="subtle" icon={<ArrowDown20Regular />} disabled={i === draftAttrs.length - 1} onClick={() => moveAttr(a.id, 1)} aria-label={`Move ${a.name} down`} />
                      </div>
                      <div className={s.attrMain}>
                        <span className={s.attrName}>{a.name || <em>(unnamed)</em>}</span>
                        <span className={s.attrMeta}>
                          <Badge appearance="outline" size="small">{ATTRIBUTE_TYPE_LABELS[a.type]}</Badge>
                          {a.required && <Badge appearance="tint" color="danger" size="small">Required</Badge>}
                          {a.type === 'enum' && a.enumValues && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{a.enumValues.join(', ')}</Caption1>}
                        </span>
                      </div>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setEditingAttr(a)} aria-label={`Edit ${a.name}`} />
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => removeAttr(a.id)} aria-label={`Remove ${a.name}`} />
                    </div>
                  ))}

                  {editingAttr && (
                    <AttributeEditor
                      key={editingAttr.id}
                      attr={editingAttr}
                      isNew={!draftAttrs.some((x) => x.id === editingAttr.id)}
                      onCancel={() => setEditingAttr(null)}
                      onSave={upsertAttr}
                      styles={s}
                    />
                  )}
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setEditGroup(null)}>Cancel</Button>
              <Button appearance="primary" onClick={saveGroup} disabled={saving || !draftName.trim() || !!editingAttr}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </AdminShell>
  );
}

function AttributeEditor({ attr, isNew, onCancel, onSave, styles }: {
  attr: AttributeDef;
  isNew: boolean;
  onCancel: () => void;
  onSave: (a: AttributeDef) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const [name, setName] = useState(attr.name);
  const [description, setDescription] = useState(attr.description || '');
  const [type, setType] = useState<AttributeType>(attr.type);
  const [required, setRequired] = useState(attr.required);
  const [enumText, setEnumText] = useState((attr.enumValues || []).join('\n'));
  const [err, setErr] = useState<string | null>(null);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Attribute name is required'); return; }
    let enumValues: string[] | undefined;
    if (type === 'enum') {
      enumValues = Array.from(new Set(enumText.split('\n').map((v) => v.trim()).filter(Boolean)));
      if (enumValues.length === 0) { setErr('Single-select attributes need at least one value (one per line)'); return; }
    }
    onSave({ ...attr, name: trimmed, description: description.trim() || undefined, type, required, enumValues });
  }

  return (
    <div className={styles.attrEditor}>
      <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{isNew ? 'New attribute' : 'Edit attribute'}</Caption1>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      <Field label="Name" required>
        <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Data steward" />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(_, d) => setDescription(d.value)} />
      </Field>
      <Field label="Type" hint={isNew ? undefined : 'Type cannot change after an attribute is created.'}>
        <Dropdown disabled={!isNew} value={ATTRIBUTE_TYPE_LABELS[type]} selectedOptions={[type]} onOptionSelect={(_, d) => setType((d.optionValue as AttributeType) || 'string')}>
          {TYPE_OPTIONS.map((t) => <Option key={t} value={t}>{ATTRIBUTE_TYPE_LABELS[t]}</Option>)}
        </Dropdown>
      </Field>
      {type === 'enum' && (
        <Field label="Allowed values" hint="One value per line.">
          <Textarea value={enumText} onChange={(_, d) => setEnumText(d.value)} resize="vertical" placeholder={'Bronze\nSilver\nGold'} />
        </Field>
      )}
      <Checkbox checked={required} onChange={(_, d) => setRequired(!!d.checked)} label="Required — must have a value before an item can be created" />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button size="small" appearance="secondary" onClick={onCancel}>Cancel</Button>
        <Button size="small" appearance="primary" onClick={save}>{isNew ? 'Add' : 'Update'}</Button>
      </div>
    </div>
  );
}
