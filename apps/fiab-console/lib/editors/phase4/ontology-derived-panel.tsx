'use client';

/**
 * OntologyDerivedPanel (WS-4.2) — author DERIVED PROPERTIES on an object type:
 * live rollups (count/sum/avg/min/max) over linked objects, and function-kind
 * derived properties backed by a registered function-on-objects. Persisted to
 * Cosmos `state.derivedProperties[<objectType>]`; computed live on object read
 * by the object-view route (Palantir Foundry derived-property parity).
 *
 * Wizard-driven (loom-no-freeform-config): every field is a typed Dropdown /
 * picker — link type, direction, aggregation, target type/property, or a
 * registered function — no freeform config. Fluent v9 + Loom tokens; guided
 * EmptyState; clean first-open (no error banner until Save is attempted).
 */
import { useMemo, useState } from 'react';
import {
  Button, Badge, Body1, Caption1, Subtitle2, Field, Input, Dropdown, Option, Divider,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, Card, makeStyles, tokens,
} from '@fluentui/react-components';
import { Add16Regular, Calculator20Regular, Delete16Regular, Edit16Regular, BranchFork20Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { loomDocUrl } from '@/lib/learn/content';
import type { OntoObjectType, OntoLinkType } from '@/lib/editors/ontology-model';
import {
  type OntoDerivedProperty, type DerivedAggregation, type DerivedDirection,
  DERIVED_AGGREGATIONS, DERIVED_AGGREGATION_LABELS, DERIVED_DIRECTIONS,
  describeDerived, validateDerivedProperty, normalizeDerivedProperty,
} from '@/lib/foundry/derived-properties';

const useLocal = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  typeCard: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  icon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  dpRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0, paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS },
  spacer: { flex: '1 1 auto' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM, minWidth: 0 },
});

type DerivedMap = Record<string, OntoDerivedProperty[]>;

interface Draft {
  objectType: string;
  index: number | null;
  apiName: string;
  displayName: string;
  kind: 'rollup' | 'function';
  aggregation: DerivedAggregation;
  linkType: string;
  direction: DerivedDirection;
  targetType: string;
  targetProperty: string;
  functionName: string;
  functionVersion: string;
}

function blank(objectType: string): Draft {
  return {
    objectType, index: null, apiName: '', displayName: '', kind: 'rollup',
    aggregation: 'count', linkType: '', direction: 'any', targetType: '', targetProperty: '',
    functionName: '', functionVersion: '',
  };
}

export function OntologyDerivedPanel({
  objectTypes, linkTypes, derivedMap, functionNames, onChange, saving,
}: {
  objectTypes: OntoObjectType[];
  linkTypes: OntoLinkType[];
  derivedMap: DerivedMap;
  functionNames: string[];
  onChange: (next: DerivedMap) => void;
  saving: boolean;
}) {
  const s = useLocal();
  const objNames = useMemo(() => objectTypes.map((o) => o.apiName), [objectTypes]);
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Draft>(blank(objNames[0] || ''));
  const [err, setErr] = useState<string | null>(null);
  const patch = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  const openNew = (objectType: string) => { setD(blank(objectType)); setErr(null); setOpen(true); };
  const openEdit = (objectType: string, i: number) => {
    const dp = (derivedMap[objectType] || [])[i];
    if (!dp) return;
    setD({
      objectType, index: i, apiName: dp.apiName, displayName: dp.displayName || '', kind: dp.kind,
      aggregation: dp.aggregation || 'count', linkType: dp.linkType || '', direction: dp.direction || 'any',
      targetType: dp.targetType || '', targetProperty: dp.targetProperty || '',
      functionName: dp.functionName || '', functionVersion: dp.functionVersion || '',
    });
    setErr(null); setOpen(true);
  };

  // Link types touching the selected object type — a rollup only makes sense
  // over links the object participates in (either direction).
  const relevantLinks = useMemo(
    () => linkTypes.filter((l) => l.fromType === d.objectType || l.toType === d.objectType),
    [linkTypes, d.objectType],
  );
  const targetProps = useMemo(() => {
    const ot = objectTypes.find((o) => o.apiName === d.targetType);
    return ot?.properties.map((p) => p.apiName) || [];
  }, [objectTypes, d.targetType]);

  const save = () => {
    const dp: OntoDerivedProperty = normalizeDerivedProperty({
      apiName: d.apiName.trim(),
      displayName: d.displayName.trim() || undefined,
      kind: d.kind,
      aggregation: d.aggregation,
      linkType: d.linkType || undefined,
      direction: d.direction,
      targetType: d.targetType || undefined,
      targetProperty: d.targetProperty || undefined,
      functionName: d.functionName || undefined,
      functionVersion: d.functionVersion || undefined,
    }) || { apiName: d.apiName.trim(), kind: d.kind } as OntoDerivedProperty;

    const ot = objectTypes.find((o) => o.apiName === d.objectType);
    const check = validateDerivedProperty(dp, {
      ownProperties: ot?.properties || [],
      linkTypeNames: new Set(linkTypes.map((l) => l.apiName)),
      objectTypeNames: new Set(objNames),
      functionNames: new Set(functionNames),
    });
    if (!check.ok) { setErr(check.error); return; }
    // Uniqueness within the object type (excluding the row being edited).
    const existing = derivedMap[d.objectType] || [];
    if (existing.some((x, i) => x.apiName === dp.apiName && i !== d.index)) {
      setErr(`"${dp.apiName}" is already a derived property on ${d.objectType}.`); return;
    }
    const nextList = [...existing];
    if (d.index === null) nextList.push(dp); else nextList[d.index] = dp;
    onChange({ ...derivedMap, [d.objectType]: nextList });
    setOpen(false);
  };

  const remove = (objectType: string, i: number) => {
    const nextList = (derivedMap[objectType] || []).filter((_, idx) => idx !== i);
    const next = { ...derivedMap };
    if (nextList.length) next[objectType] = nextList; else delete next[objectType];
    onChange(next);
  };

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span className={s.icon}><Calculator20Regular /></span>
        <Subtitle2>Derived properties</Subtitle2>
        <LearnPopover
          title="Derived properties"
          content="A derived property is computed live from an object's linked objects — a rollup (count/sum/avg/min/max) over a linked property, or a value produced by a registered function-on-objects. Nothing is stored on the vertex; it is recomputed on every read from the real graph."
          tips={['Rollups aggregate over a link type you pick', 'Function derived props run on the Loom UDF runtime', 'Computed from security-masked linked data']}
          learnMoreHref={loomDocUrl('fiab/parity/ontology-derived-properties')}
        />
      </div>

      {objectTypes.length === 0 ? (
        <EmptyState icon={<Calculator20Regular />} title="Add an object type first"
          body="Derived properties roll up over an object type's linked objects. Declare an object type and a link type, then add a derived property here." />
      ) : (
        objectTypes.map((ot) => {
          const list = derivedMap[ot.apiName] || [];
          return (
            <Card key={ot.apiName} className={s.typeCard}>
              <div className={s.head}>
                <span className={s.icon}><BranchFork20Regular /></span>
                <Body1><strong>{ot.displayName || ot.apiName}</strong></Body1>
                <Badge appearance="tint" color="brand">{list.length} derived</Badge>
                <span className={s.spacer} />
                <Button size="small" appearance="primary" icon={<Add16Regular />} disabled={saving}
                  onClick={() => openNew(ot.apiName)}>Add derived property</Button>
              </div>
              {list.length === 0 ? (
                <Caption1>No derived properties yet — add a rollup over this object&apos;s links, or a function-backed value.</Caption1>
              ) : (
                list.map((dp, i) => (
                  <div key={dp.apiName} className={s.dpRow}>
                    <Badge appearance="outline" color={dp.kind === 'function' ? 'important' : 'informative'}>{dp.kind}</Badge>
                    <Body1><strong>{dp.displayName || dp.apiName}</strong></Body1>
                    <Caption1>{describeDerived(dp)}</Caption1>
                    <span className={s.spacer} />
                    <Button size="small" appearance="subtle" icon={<Edit16Regular />} disabled={saving} onClick={() => openEdit(ot.apiName, i)}>Edit</Button>
                    <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={saving} onClick={() => remove(ot.apiName, i)}>Remove</Button>
                  </div>
                ))
              )}
            </Card>
          );
        })
      )}

      <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{d.index === null ? 'Add' : 'Edit'} derived property — {d.objectType}</DialogTitle>
            <DialogContent>
              <div className={s.form}>
                {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
                <div className={s.grid}>
                  <Field label="API name" required>
                    <Input value={d.apiName} onChange={(_, v) => patch({ apiName: v.value })} placeholder="e.g. openOrderCount" />
                  </Field>
                  <Field label="Display name">
                    <Input value={d.displayName} onChange={(_, v) => patch({ displayName: v.value })} placeholder="Open orders" />
                  </Field>
                  <Field label="Kind" required>
                    <Dropdown value={d.kind === 'function' ? 'Function (registered)' : 'Rollup (aggregate over links)'} selectedOptions={[d.kind]}
                      onOptionSelect={(_, o) => patch({ kind: o.optionValue as 'rollup' | 'function' })}>
                      <Option value="rollup">Rollup (aggregate over links)</Option>
                      <Option value="function">Function (registered)</Option>
                    </Dropdown>
                  </Field>
                </div>

                {d.kind === 'rollup' ? (
                  <>
                    <Divider />
                    <div className={s.grid}>
                      <Field label="Aggregation" required>
                        <Dropdown value={DERIVED_AGGREGATION_LABELS[d.aggregation]} selectedOptions={[d.aggregation]}
                          onOptionSelect={(_, o) => patch({ aggregation: o.optionValue as DerivedAggregation })}>
                          {DERIVED_AGGREGATIONS.map((a) => <Option key={a} value={a}>{DERIVED_AGGREGATION_LABELS[a]}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Over link type" hint="Which link to traverse (blank = any link).">
                        <Dropdown value={d.linkType || 'Any link'} selectedOptions={[d.linkType]}
                          onOptionSelect={(_, o) => patch({ linkType: o.optionValue || '' })}>
                          <Option value="">Any link</Option>
                          {relevantLinks.map((l) => <Option key={l.apiName} value={l.apiName}>{l.displayName || l.apiName}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Direction">
                        <Dropdown value={d.direction} selectedOptions={[d.direction]}
                          onOptionSelect={(_, o) => patch({ direction: o.optionValue as DerivedDirection })}>
                          {DERIVED_DIRECTIONS.map((dir) => <Option key={dir} value={dir}>{dir}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Linked object type" hint="Only aggregate neighbours of this type (blank = any).">
                        <Dropdown value={d.targetType || 'Any type'} selectedOptions={[d.targetType]}
                          onOptionSelect={(_, o) => patch({ targetType: o.optionValue || '', targetProperty: '' })}>
                          <Option value="">Any type</Option>
                          {objNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                        </Dropdown>
                      </Field>
                      {d.aggregation !== 'count' && (
                        <Field label="Linked property to aggregate" required>
                          <Dropdown value={d.targetProperty || 'Pick a property'} selectedOptions={[d.targetProperty]}
                            onOptionSelect={(_, o) => patch({ targetProperty: o.optionValue || '' })}
                            disabled={!d.targetType}>
                            {targetProps.map((p) => <Option key={p} value={p}>{p}</Option>)}
                          </Dropdown>
                        </Field>
                      )}
                    </div>
                    {d.aggregation !== 'count' && !d.targetType && (
                      <Caption1>Pick a linked object type to choose which numeric property to aggregate.</Caption1>
                    )}
                  </>
                ) : (
                  <>
                    <Divider />
                    <div className={s.grid}>
                      <Field label="Registered function" required
                        hint={functionNames.length ? undefined : 'No functions registered yet — add one in the Functions tab.'}>
                        <Dropdown value={d.functionName || 'Pick a function'} selectedOptions={[d.functionName]}
                          onOptionSelect={(_, o) => patch({ functionName: o.optionValue || '' })}>
                          {functionNames.map((n) => <Option key={n} value={n}>{n}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Version" hint="Blank = latest registered.">
                        <Input value={d.functionVersion} onChange={(_, v) => patch({ functionVersion: v.value })} placeholder="latest" />
                      </Field>
                    </div>
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={save} disabled={saving}>{d.index === null ? 'Add' : 'Save'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
