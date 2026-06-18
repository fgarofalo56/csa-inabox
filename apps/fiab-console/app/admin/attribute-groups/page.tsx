'use client';

/**
 * Custom attributes / attribute groups admin (F17).
 *
 * Per-domain attribute schemas that drive the Create wizard's "Custom
 * attributes" step, the data-product create wizard, and item Edit dialogs.
 * Azure-native: backed by a single per-tenant Cosmos document
 * (`attribute-groups:<tenantId>` in `tenant-settings`) via /api/attribute-groups.
 * No Microsoft Purview / Fabric account is required.
 *
 * Parity with Microsoft Purview Unified Catalog → Custom metadata:
 *   - groups scope to governance domains (empty scope = all domains)
 *   - attributes have a name, field type (Text / Single choice / Multiple
 *     choice / Date / Boolean / Integer / Double / Rich text), a required flag,
 *     and (for choice types) a list of allowed values
 *   - attributes are ordered with ↑/↓ reorder controls
 */

import { clientFetch } from '@/lib/client-fetch';
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
  ArrowUp20Regular, ArrowDown20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import {
  type AttributeGroup, type AttributeDef, type AttributeFieldType,
  ATTRIBUTE_FIELD_TYPES, CHOICE_FIELD_TYPES, kebab, validateAttributes,
} from '@/lib/types/attribute-groups';

interface DomainItem { id: string; name: string; }

const useStyles = makeStyles({
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
  attrHeadRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: tokens.spacingVerticalS,
  },
  reorderCol: { display: 'flex', flexDirection: 'column' },
});

function emptyAttr(): AttributeDef {
  return { id: `attr-${Math.random().toString(36).slice(2, 10)}`, name: '', fieldType: 'Text', required: false };
}

export default function AttributeGroupsPage() {
  const s = useStyles();
  const atab = useAdminTabStyles();
  const [groups, setGroups] = useState<AttributeGroup[] | null>(null);
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

  // Edit-group dialog (holds a working draft; Save persists the whole schema)
  const [editGroup, setEditGroup] = useState<AttributeGroup | null>(null);
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
      const r = await clientFetch('/api/attribute-groups');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setGroups(j.groups || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadDomains = useCallback(async () => {
    try {
      const r = await clientFetch('/api/admin/domains');
      const j = await r.json();
      if (j.ok) setDomains((j.domains || []).map((d: any) => ({ id: d.id, name: d.name })));
    } catch { /* domains are optional; scope can still be "all" */ }
  }, []);

  useEffect(() => { load(); loadDomains(); }, [load, loadDomains]);

  const domainName = useCallback((id: string) => domains.find((d) => d.id === id)?.name || id, [domains]);

  /** Persist the whole attribute-group schema (one per-tenant doc). */
  const persist = useCallback(async (next: AttributeGroup[]): Promise<boolean> => {
    setActionErr(null);
    const r = await clientFetch('/api/attribute-groups', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groups: next }),
    });
    const j = await r.json();
    if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return false; }
    setGroups(j.groups || next);
    return true;
  }, []);

  async function createGroup() {
    if (!newName.trim()) { setActionErr('Group name is required'); return; }
    setCreating(true); setActionErr(null);
    try {
      const id = `${kebab(newName)}-${Date.now().toString(36)}`;
      const group: AttributeGroup = {
        id, name: newName.trim(),
        description: newDesc.trim() || undefined,
        domainIds: newDomains, attributes: [],
      };
      const next = [...(groups || []), group];
      const ok = await persist(next);
      if (!ok) return;
      setCreateOpen(false);
      setNewName(''); setNewDesc(''); setNewDomains([]);
      // Open the newly created group so the admin can add attributes.
      openEdit(group);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  function openEdit(g: AttributeGroup) {
    setEditGroup(g);
    setDraftName(g.name);
    setDraftDesc(g.description || '');
    setDraftDomains(g.domainIds || []);
    setDraftAttrs((g.attributes || []).slice());
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
      const updated: AttributeGroup = {
        id: editGroup.id,
        name: draftName.trim(),
        description: draftDesc.trim() || undefined,
        domainIds: draftDomains,
        attributes: draftAttrs,
      };
      const next = (groups || []).map((g) => (g.id === editGroup.id ? updated : g));
      const ok = await persist(next);
      if (!ok) return;
      setEditGroup(null);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }

  async function deleteGroup(g: AttributeGroup) {
    if (!confirm(`Delete attribute group "${g.name}"? Its attributes will be removed from every domain's Create wizard and Edit dialogs.`)) return;
    const next = (groups || []).filter((x) => x.id !== g.id);
    await persist(next);
  }

  // --- attribute draft mutations (local; persisted on Save) ----------------
  function upsertAttr(a: AttributeDef) {
    setDraftAttrs((prev) => {
      const idx = prev.findIndex((x) => x.id === a.id);
      if (idx === -1) return [...prev, a];
      const next = prev.slice(); next[idx] = a; return next;
    });
    setEditingAttr(null);
  }
  function removeAttr(id: string) {
    setDraftAttrs((prev) => prev.filter((x) => x.id !== id));
  }
  function moveAttr(id: string, dir: -1 | 1) {
    setDraftAttrs((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const j = idx + dir;
      if (idx === -1 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  const filtered = useMemo(() => {
    let all = groups || [];
    if (domainFilter) all = all.filter((g) => !g.domainIds || g.domainIds.length === 0 || g.domainIds.includes(domainFilter));
    const f = q.toLowerCase().trim();
    if (!f) return all;
    return all.filter((g) =>
      g.name.toLowerCase().includes(f) ||
      (g.description || '').toLowerCase().includes(f) ||
      g.attributes.some((a) => a.name.toLowerCase().includes(f)));
  }, [groups, q, domainFilter]);

  const columns: LoomColumn<AttributeGroup>[] = useMemo(() => [
    { key: 'name', label: 'Group', width: 220, getValue: (g) => g.name, render: (g) => (
      <div><strong>{g.name}</strong>{g.description && <Caption1 className={atab.blockMuted}>{g.description}</Caption1>}</div>
    ) },
    { key: 'attributes', label: 'Attributes', width: 90, getValue: (g) => g.attributes.length, render: (g) => <Badge appearance="tint" color="brand" size="small">{g.attributes.length}</Badge> },
    { key: 'domains', label: 'Applies to', width: 280, sortable: false, render: (g) => (
      !g.domainIds || g.domainIds.length === 0
        ? <Badge appearance="outline" color="informative" size="small">All domains</Badge>
        : <span className={s.attrMeta}>{g.domainIds.map((d) => <Badge key={d} appearance="tint" size="small">{domainName(d)}</Badge>)}</span>
    ) },
    { key: 'actions', label: '', width: 150, sortable: false, filterable: false, render: (g) => (
      <span className={atab.rowGapXS}>
        <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={(e) => { e.stopPropagation(); openEdit(g); }} aria-label={`Edit ${g.name}`}>Edit</Button>
        <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); deleteGroup(g); }} aria-label={`Delete ${g.name}`} />
      </span>
    ) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [domainName, s.attrMeta, atab]);

  return (
    <AdminShell sectionTitle="Custom attributes">
      <Section title="About custom attributes">
        <SectionExplainer>
          Define <strong>attribute groups</strong> that attach extra, governed metadata to the items people create.
          Each attribute has a field type (<strong>Text</strong>, <strong>Single choice</strong>, <strong>Multiple choice</strong>,
          <strong> Date</strong>, <strong>Boolean</strong>, <strong>Integer</strong>, <strong>Double</strong>, or <strong>Rich text</strong>),
          an optional <strong>required</strong> flag, and (for choice types) a list of allowed values.
          Scope a group to one or more <strong>domains</strong> — leave the scope empty to apply it to every domain.
          Required attributes appear on the Create wizard&apos;s <strong>Custom attributes</strong> step for items in those domains and
          block completion until they have a value. This is Loom&apos;s Azure-native equivalent of Purview Unified Catalog custom metadata —
          no Purview account is required.
        </SectionExplainer>
      </Section>

      {error && <MessageBar intent="error" className={atab.messageBar}><MessageBarBody><MessageBarTitle>Could not load attribute groups</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent="error" className={atab.messageBar}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      <Section title="Attribute groups" actions={<>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => { setNewName(''); setNewDesc(''); setNewDomains([]); setActionErr(null); setCreateOpen(true); }}>Add group</Button>
      </>}>
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by group or attribute name…" actions={
          <Dropdown placeholder="Filter by domain" value={domainFilter ? domainName(domainFilter) : 'All domains'} selectedOptions={[domainFilter]} onOptionSelect={(_, d) => setDomainFilter(d.optionValue || '')} className={atab.filterControl}>
            <Option value="">All domains</Option>
            {domains.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
          </Dropdown>
        } />
        {loading && !error
          ? <Spinner label="Loading attribute groups…" />
          : <LoomDataTable columns={columns} rows={filtered} getRowId={(g) => g.id} onRowClick={(g) => openEdit(g)} empty={q || domainFilter ? 'No groups match your filter.' : 'No attribute groups yet. Click "Add group" to define your first schema.'} ariaLabel="Attribute groups" />}
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
        <DialogSurface className={atab.dialogWide}>
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
                  <div className={s.attrHeadRow}>
                    <Caption1 className={atab.captionStrong}>Attributes ({draftAttrs.length})</Caption1>
                    <Button size="small" appearance="secondary" icon={<Add24Regular />} onClick={() => setEditingAttr(emptyAttr())} disabled={!!editingAttr}>Add attribute</Button>
                  </div>

                  {draftAttrs.length === 0 && !editingAttr && (
                    <Body1 className={atab.muted}>No attributes yet. Click &quot;Add attribute&quot; to define one.</Body1>
                  )}

                  {draftAttrs.map((a, i) => (
                    <div key={a.id} className={s.attrRow}>
                      <div className={s.reorderCol}>
                        <Button size="small" appearance="subtle" icon={<ArrowUp20Regular />} disabled={i === 0} onClick={() => moveAttr(a.id, -1)} aria-label={`Move ${a.name} up`} />
                        <Button size="small" appearance="subtle" icon={<ArrowDown20Regular />} disabled={i === draftAttrs.length - 1} onClick={() => moveAttr(a.id, 1)} aria-label={`Move ${a.name} down`} />
                      </div>
                      <div className={s.attrMain}>
                        <span className={s.attrName}>{a.name || <em>(unnamed)</em>}</span>
                        <span className={s.attrMeta}>
                          <Badge appearance="outline" size="small">{a.fieldType}</Badge>
                          {a.required && <Badge appearance="tint" color="danger" size="small">Required</Badge>}
                          {CHOICE_FIELD_TYPES.includes(a.fieldType) && a.choices && <Caption1 className={atab.muted}>{a.choices.join(', ')}</Caption1>}
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
  const [fieldType, setFieldType] = useState<AttributeFieldType>(attr.fieldType);
  const [required, setRequired] = useState(!!attr.required);
  const [choicesText, setChoicesText] = useState((attr.choices || []).join('\n'));
  const [err, setErr] = useState<string | null>(null);
  const atab = useAdminTabStyles();

  const isChoice = CHOICE_FIELD_TYPES.includes(fieldType);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) { setErr('Attribute name is required'); return; }
    let choices: string[] | undefined;
    if (isChoice) {
      choices = Array.from(new Set(choicesText.split('\n').map((v) => v.trim()).filter(Boolean)));
      if (choices.length === 0) { setErr('Choice attributes need at least one value (one per line)'); return; }
    }
    onSave({ ...attr, name: trimmed, description: description.trim() || undefined, fieldType, required, choices });
  }

  return (
    <div className={styles.attrEditor}>
      <Caption1 className={atab.captionStrong}>{isNew ? 'New attribute' : 'Edit attribute'}</Caption1>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      <Field label="Name" required>
        <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Data steward" />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(_, d) => setDescription(d.value)} />
      </Field>
      <Field label="Field type">
        <Dropdown value={fieldType} selectedOptions={[fieldType]} onOptionSelect={(_, d) => setFieldType((d.optionValue as AttributeFieldType) || 'Text')}>
          {ATTRIBUTE_FIELD_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
        </Dropdown>
      </Field>
      {isChoice && (
        <Field label="Allowed values" hint="One value per line.">
          <Textarea value={choicesText} onChange={(_, d) => setChoicesText(d.value)} resize="vertical" placeholder={'Bronze\nSilver\nGold'} />
        </Field>
      )}
      <Checkbox checked={required} onChange={(_, d) => setRequired(!!d.checked)} label="Required — must have a value before an item can be created" />
      <div className={atab.dialogFooter}>
        <Button size="small" appearance="secondary" onClick={onCancel}>Cancel</Button>
        <Button size="small" appearance="primary" onClick={save}>{isNew ? 'Add' : 'Update'}</Button>
      </div>
    </div>
  );
}
