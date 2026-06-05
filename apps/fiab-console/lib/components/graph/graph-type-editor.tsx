'use client';

/**
 * GraphTypeEditor — guided editor for a graph model's node / edge TYPE list
 * (replaces the raw nodes/edges JSON textareas per loom_no_freeform_config).
 * Each type is a card with an editable name + a properties grid (property name
 * + Kusto scalar type dropdown), with add/remove for both types and properties.
 * Mirrors how Fabric's graph / ADX entity schema is authored — typed, not JSON.
 *
 * Shape (unchanged, so the backend + schema viz keep working):
 *   GraphType  = { name: string; properties: GraphProp[] }
 *   GraphProp  = { name: string; type: string }
 */

import { Button, Input, Dropdown, Option, Field, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';

export interface GraphProp { name: string; type: string }
export interface GraphType { name: string; properties: GraphProp[] }

/** Kusto/ADX scalar types a graph property can take. */
const KUSTO_TYPES = ['string', 'long', 'int', 'real', 'decimal', 'datetime', 'timespan', 'bool', 'guid', 'dynamic'];

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: '10px' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '10px', padding: '12px',
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: '8px',
  },
  cardHead: { display: 'flex', gap: '8px', alignItems: 'end' },
  propRow: { display: 'grid', gridTemplateColumns: '1fr 160px auto', gap: '8px', alignItems: 'center' },
  propHead: { display: 'grid', gridTemplateColumns: '1fr 160px auto', gap: '8px' },
  propHeadLabel: { fontSize: '11px', color: tokens.colorNeutralForeground3, fontWeight: 600 },
  empty: { fontSize: '12px', color: tokens.colorNeutralForeground3, padding: '8px 0' },
});

export function GraphTypeEditor({
  kind, types, onChange,
}: {
  kind: 'node' | 'edge';
  types: GraphType[];
  onChange: (next: GraphType[]) => void;
}) {
  const styles = useStyles();
  const nameLabel = kind === 'node' ? 'Entity (node) type' : 'Relationship (edge) type';

  const setType = (i: number, patch: Partial<GraphType>) =>
    onChange(types.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const removeType = (i: number) => onChange(types.filter((_, idx) => idx !== i));
  const setProp = (ti: number, pi: number, patch: Partial<GraphProp>) =>
    setType(ti, { properties: (types[ti].properties || []).map((p, idx) => (idx === pi ? { ...p, ...patch } : p)) });
  const addProp = (ti: number) =>
    setType(ti, { properties: [...(types[ti].properties || []), { name: '', type: 'string' }] });
  const removeProp = (ti: number, pi: number) =>
    setType(ti, { properties: (types[ti].properties || []).filter((_, idx) => idx !== pi) });

  if (types.length === 0) {
    return <Caption1 className={styles.empty}>No {kind} types yet — use “Add {kind === 'node' ? 'entity' : 'relationship'}” above.</Caption1>;
  }

  return (
    <div className={styles.list}>
      {types.map((t, ti) => {
        const props = t.properties || [];
        return (
          <div key={ti} className={styles.card}>
            <div className={styles.cardHead}>
              <Field label={nameLabel} style={{ flex: 1 }}>
                <Input value={t.name} placeholder={kind === 'node' ? 'Customer' : 'PLACED'}
                  onChange={(_, d) => setType(ti, { name: d.value })} />
              </Field>
              <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeType(ti)}>Remove</Button>
            </div>
            {props.length > 0 && (
              <div className={styles.propHead}>
                <span className={styles.propHeadLabel}>Property</span>
                <span className={styles.propHeadLabel}>Type</span>
                <span />
              </div>
            )}
            {props.map((p, pi) => (
              <div key={pi} className={styles.propRow}>
                <Input value={p.name} placeholder="name" onChange={(_, d) => setProp(ti, pi, { name: d.value })} />
                <Dropdown value={p.type} selectedOptions={[p.type]}
                  onOptionSelect={(_, d) => d.optionValue && setProp(ti, pi, { type: d.optionValue })}>
                  {KUSTO_TYPES.map((kt) => <Option key={kt} value={kt}>{kt}</Option>)}
                </Dropdown>
                <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove property" onClick={() => removeProp(ti, pi)} />
              </div>
            ))}
            <div>
              <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={() => addProp(ti)}>Add property</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
