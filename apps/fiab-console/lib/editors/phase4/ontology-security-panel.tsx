'use client';

/**
 * Ontology object-level security panel (WS-4.3) — the wizard/picker surface that
 * authors the Entra-group markings the BFF routes enforce. Per
 * loom-no-freeform-config there is NO JSON textarea: property/row/action markings
 * are built from Dropdowns + the shared Entra `GroupMultiPicker`, then persisted
 * to `state.objectSecurity` via the editor's normal save.
 *
 * Three marking kinds, mirroring the enforcement model (lib/foundry/object-security):
 *   - Property marking (CLS analogue): pick a property → clear it to security groups.
 *   - Row marking (RLS analogue): pick a marking property → per-value group clearances.
 *   - Action marking: clear a write-back action to security groups.
 *
 * Web3/UX-baseline: Fluent v9 + Loom tokens, elevated cards, section icons,
 * EmptyState guidance, honest picker gate. Azure-native (Entra + Cosmos), Gov-safe.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Dropdown, Option, Field, Input,
  Switch, Divider, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldLock20Regular, Add16Regular, Dismiss16Regular, Cube20Regular,
  Play20Regular, Table20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { GroupMultiPicker } from '@/lib/components/ui/group-multi-picker';
import type { IdentityHit } from '@/lib/components/ui/identity-picker';
import type { OntoObjectType, OntoActionType } from '@/lib/editors/ontology-model';
import {
  type ObjectSecurityConfig, type ObjectTypeSecurity, type ActionSecurity,
  type SecurityGroupRef, type PropertyMarking, type RowClearance,
} from '@/lib/foundry/object-security';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, paddingTop: tokens.spacingVerticalM },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  markingRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  spacer: { flex: 1 },
  addRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
});

// ── SecurityGroupRef ↔ IdentityHit (GroupMultiPicker) mapping ────────────────
function toHits(groups: SecurityGroupRef[] | undefined): IdentityHit[] {
  return (groups || []).map((g) => ({ id: g.id, type: 'group' as const, displayName: g.name || g.id }));
}
function toRefs(hits: IdentityHit[]): SecurityGroupRef[] {
  return hits.map((h) => (h.displayName && h.displayName !== h.id ? { id: h.id, name: h.displayName } : { id: h.id }));
}

export interface OntologySecurityPanelProps {
  objectTypes: OntoObjectType[];
  actionTypes: OntoActionType[];
  security: ObjectSecurityConfig;
  onChange: (next: ObjectSecurityConfig) => void;
  saving?: boolean;
}

export function OntologySecurityPanel({ objectTypes, actionTypes, security, onChange, saving }: OntologySecurityPanelProps) {
  const s = useStyles();

  const otSecByName = useMemo(() => {
    const m = new Map<string, ObjectTypeSecurity>();
    for (const o of security.objectTypes || []) m.set(o.objectType, o);
    return m;
  }, [security.objectTypes]);
  const actSecByName = useMemo(() => {
    const m = new Map<string, ActionSecurity>();
    for (const a of security.actions || []) m.set(a.action, a);
    return m;
  }, [security.actions]);

  /** Upsert (or clear) one object type's security, dropping empty entries. */
  const setObjectTypeSec = useCallback((objectType: string, next: ObjectTypeSecurity | null) => {
    const rest = (security.objectTypes || []).filter((o) => o.objectType !== objectType);
    const keep = next && ((next.propertyMarkings && next.propertyMarkings.length) || next.rowMarking);
    const objectTypes = keep ? [...rest, next as ObjectTypeSecurity] : rest;
    onChange({ ...security, ...(objectTypes.length ? { objectTypes } : { objectTypes: undefined }) });
  }, [security, onChange]);

  const setActionSec = useCallback((action: string, allowGroups: SecurityGroupRef[]) => {
    const rest = (security.actions || []).filter((a) => a.action !== action);
    const actions = allowGroups.length ? [...rest, { action, allowGroups }] : rest;
    onChange({ ...security, ...(actions.length ? { actions } : { actions: undefined }) });
  }, [security, onChange]);

  return (
    <div className={s.root}>
      <div className={s.head}>
        <ShieldLock20Regular />
        <div>
          <Subtitle2>Object-level security</Subtitle2>
          <Caption1 className={s.hint}>
            Gate this ontology&apos;s instance data by Entra security group. Markings are enforced
            server-side on the object list, the object viewer, and write-back actions — masked
            properties never leave the server; restricted rows and actions return 403.
          </Caption1>
        </div>
      </div>

      {/* ── Object-type markings ── */}
      <div className={s.sectionTitle}><Cube20Regular /><Subtitle2>Object types</Subtitle2></div>
      {objectTypes.length === 0 ? (
        <EmptyState icon={<ShieldLock20Regular />} title="No object types yet"
          body="Add object types in the Object types tab, then mark their properties and rows here." />
      ) : (
        <div className={s.grid}>
          {objectTypes.map((ot) => (
            <ObjectTypeSecurityCard
              key={ot.apiName}
              ot={ot}
              sec={otSecByName.get(ot.apiName) || null}
              onChange={(next) => setObjectTypeSec(ot.apiName, next)}
              saving={saving}
            />
          ))}
        </div>
      )}

      {/* ── Action markings ── */}
      <Divider />
      <div className={s.sectionTitle}><Play20Regular /><Subtitle2>Write-back actions</Subtitle2></div>
      {actionTypes.length === 0 ? (
        <EmptyState icon={<ShieldLock20Regular />} title="No actions yet"
          body="Declare write-back actions in the Actions tab, then restrict who can run them here." />
      ) : (
        <div className={s.grid}>
          {actionTypes.map((a) => {
            const groups = actSecByName.get(a.name)?.allowGroups || [];
            return (
              <div key={a.name} className={s.card}>
                <div className={s.cardHead}>
                  <Play20Regular />
                  <Body1><strong>{a.name}</strong></Body1>
                  <Badge appearance="outline">{a.kind}</Badge>
                  <Badge appearance="ghost">{a.objectType}</Badge>
                  <span className={s.spacer} />
                  {groups.length > 0
                    ? <Badge appearance="tint" color="danger" icon={<ShieldLock20Regular />}>Restricted</Badge>
                    : <Badge appearance="ghost">Anyone with access</Badge>}
                </div>
                <Caption1 className={s.hint}>Only members of these groups may run this action (empty = anyone who can open the ontology).</Caption1>
                <GroupMultiPicker
                  label="Allowed security groups"
                  selected={toHits(groups)}
                  onSelectionChange={(hits) => setActionSec(a.name, toRefs(hits))}
                  disabled={saving}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Per-object-type card: property markings + one row marking ────────────────
function ObjectTypeSecurityCard({ ot, sec, onChange, saving }: {
  ot: OntoObjectType;
  sec: ObjectTypeSecurity | null;
  onChange: (next: ObjectTypeSecurity | null) => void;
  saving?: boolean;
}) {
  const s = useStyles();
  const propNames = ot.properties.map((p) => p.apiName);
  const propMarkings = sec?.propertyMarkings || [];
  const rowMarking = sec?.rowMarking;
  const [newProp, setNewProp] = useState('');

  const emit = (patch: Partial<ObjectTypeSecurity>) => {
    const next: ObjectTypeSecurity = {
      objectType: ot.apiName,
      propertyMarkings: patch.propertyMarkings ?? propMarkings,
      ...(('rowMarking' in patch) ? (patch.rowMarking ? { rowMarking: patch.rowMarking } : {}) : (rowMarking ? { rowMarking } : {})),
    };
    if (next.propertyMarkings && next.propertyMarkings.length === 0) delete (next as { propertyMarkings?: unknown }).propertyMarkings;
    onChange(next);
  };

  const setPropGroups = (property: string, groups: SecurityGroupRef[]) => {
    const rest = propMarkings.filter((m) => m.property !== property);
    const next: PropertyMarking[] = groups.length ? [...rest, { property, allowGroups: groups }] : rest;
    emit({ propertyMarkings: next });
  };
  const addPropMarking = () => {
    if (!newProp || propMarkings.some((m) => m.property === newProp)) return;
    emit({ propertyMarkings: [...propMarkings, { property: newProp, allowGroups: [] }] });
    setNewProp('');
  };

  const setRowMarkingProperty = (markingProperty: string) => {
    if (!markingProperty) { emit({ rowMarking: undefined }); return; }
    emit({ rowMarking: { markingProperty, clearances: rowMarking?.clearances || [], ...(rowMarking?.hideUnclassified ? { hideUnclassified: true } : {}) } });
  };
  const setClearances = (clearances: RowClearance[]) => {
    if (!rowMarking) return;
    emit({ rowMarking: { ...rowMarking, clearances } });
  };
  const [newValue, setNewValue] = useState('');

  const availableForNew = propNames.filter((p) => !propMarkings.some((m) => m.property === p));
  const restricted = propMarkings.length > 0 || !!rowMarking;

  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <Cube20Regular />
        <Body1><strong>{ot.displayName || ot.apiName}</strong></Body1>
        <span className={s.spacer} />
        {restricted
          ? <Badge appearance="tint" color="danger" icon={<ShieldLock20Regular />}>Marked</Badge>
          : <Badge appearance="ghost">Unrestricted</Badge>}
      </div>

      {/* Property markings (CLS) */}
      <Caption1 className={s.hint}><Table20Regular /> Property markings — mask a property for callers not in the cleared groups.</Caption1>
      {propMarkings.map((m) => (
        <div key={m.property} className={s.markingRow}>
          <div className={s.rowHead}>
            <Badge appearance="outline" color="brand">{m.property}</Badge>
            <span className={s.spacer} />
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove marking on ${m.property}`}
              onClick={() => { const rest = propMarkings.filter((x) => x.property !== m.property); emit({ propertyMarkings: rest }); }} disabled={saving} />
          </div>
          <GroupMultiPicker label="Cleared security groups" selected={toHits(m.allowGroups)}
            onSelectionChange={(hits) => setPropGroups(m.property, toRefs(hits))} disabled={saving} />
        </div>
      ))}
      {availableForNew.length > 0 && (
        <div className={s.addRow}>
          <Field label="Property">
            <Dropdown placeholder="Pick a property" selectedOptions={newProp ? [newProp] : []} value={newProp}
              onOptionSelect={(_e, d) => setNewProp(String(d.optionValue))} disabled={saving} style={{ minWidth: 180 }}>
              {availableForNew.map((p) => <Option key={p} value={p}>{p}</Option>)}
            </Dropdown>
          </Field>
          <Button size="small" icon={<Add16Regular />} onClick={addPropMarking} disabled={!newProp || saving}>Add property marking</Button>
        </div>
      )}

      {/* Row marking (RLS) */}
      <Divider />
      <Caption1 className={s.hint}><ShieldLock20Regular /> Row marking — hide an instance from callers not cleared for its marking value.</Caption1>
      <Field label="Marking property">
        <Dropdown placeholder="None (rows unrestricted)" value={rowMarking?.markingProperty || ''}
          selectedOptions={rowMarking?.markingProperty ? [rowMarking.markingProperty] : ['']}
          onOptionSelect={(_e, d) => setRowMarkingProperty(String(d.optionValue))} disabled={saving} style={{ minWidth: 200 }}>
          <Option value="">None (rows unrestricted)</Option>
          {propNames.map((p) => <Option key={p} value={p}>{p}</Option>)}
        </Dropdown>
      </Field>
      {rowMarking && (
        <>
          {rowMarking.clearances.map((c) => (
            <div key={c.value} className={s.markingRow}>
              <div className={s.rowHead}>
                <Badge appearance="outline" color="warning">{c.value || '(empty)'}</Badge>
                <span className={s.spacer} />
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={`Remove clearance ${c.value}`}
                  onClick={() => setClearances(rowMarking.clearances.filter((x) => x.value !== c.value))} disabled={saving} />
              </div>
              <GroupMultiPicker label={`Groups cleared for "${c.value}"`} selected={toHits(c.allowGroups)}
                onSelectionChange={(hits) => setClearances(rowMarking.clearances.map((x) => x.value === c.value ? { ...x, allowGroups: toRefs(hits) } : x))}
                disabled={saving} />
            </div>
          ))}
          <div className={s.addRow}>
            <Field label="Marking value">
              <Input value={newValue} onChange={(_e, d) => setNewValue(d.value)} placeholder="e.g. secret" disabled={saving} />
            </Field>
            <Button size="small" icon={<Add16Regular />} disabled={!newValue.trim() || rowMarking.clearances.some((c) => c.value === newValue.trim()) || saving}
              onClick={() => { setClearances([...rowMarking.clearances, { value: newValue.trim(), allowGroups: [] }]); setNewValue(''); }}>
              Add clearance
            </Button>
          </div>
          <Switch label="Hide rows whose marking value has no clearance rule" checked={!!rowMarking.hideUnclassified}
            onChange={(_e, d) => emit({ rowMarking: { ...rowMarking, ...(d.checked ? { hideUnclassified: true } : {}) } })} disabled={saving} />
        </>
      )}
    </div>
  );
}

export default OntologySecurityPanel;
