'use client';

/**
 * KeyValueGrid — a guided editor for a flat string→string map (e.g. Spark
 * configuration, headers, tags, parameters). Replaces hand-written JSON config
 * blobs (loom_no_freeform_config) with add/remove rows of typed key + value
 * inputs, while still serializing to the JSON string the backend expects — so
 * it's a drop-in for any `value: jsonString / onChange(jsonString)` field.
 *
 * Invalid existing JSON is preserved as a single notice row rather than thrown
 * away, so nothing is lost when migrating a field that already held JSON.
 */

import { useMemo } from 'react';
import { Button, Input, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px', alignItems: 'center' },
  head: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px' },
  headLabel: { fontSize: '11px', color: tokens.colorNeutralForeground3, fontWeight: 600 },
  empty: { fontSize: '12px', color: tokens.colorNeutralForeground3, padding: '4px 0' },
});

export interface KeyValueGridProps {
  /** Current value as a JSON string — an object (map mode) or array (array mode). */
  value: string;
  /** Called with the new JSON string whenever a row changes. */
  onChange: (jsonString: string) => void;
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  /**
   * When set, the value is a JSON ARRAY of objects `[{<keyField>, <valueField>}]`
   * instead of a flat map — e.g. column mappings `[{source, sink}]`.
   */
  arrayMode?: { keyField: string; valueField: string };
}

type Pair = { k: string; v: string };

function parsePairs(value: string, arr?: { keyField: string; valueField: string }): Pair[] {
  if (!value || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (arr && Array.isArray(parsed)) {
      return parsed.map((o) => ({
        k: o && typeof o === 'object' ? String(o[arr.keyField] ?? '') : '',
        v: o && typeof o === 'object' ? String(o[arr.valueField] ?? '') : '',
      }));
    }
    if (!arr && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) }));
    }
  } catch { /* fall through */ }
  return [];
}

function serialize(pairs: Pair[], arr?: { keyField: string; valueField: string }): string {
  if (arr) {
    return JSON.stringify(pairs.filter((p) => p.k.trim()).map((p) => ({ [arr.keyField]: p.k.trim(), [arr.valueField]: p.v })));
  }
  const obj: Record<string, string> = {};
  for (const p of pairs) if (p.k.trim()) obj[p.k.trim()] = p.v;
  return JSON.stringify(obj);
}

export function KeyValueGrid({
  value, onChange,
  keyLabel = 'Key', valueLabel = 'Value',
  keyPlaceholder = 'spark.sql.shuffle.partitions', valuePlaceholder = '200',
  addLabel = 'Add setting', arrayMode,
}: KeyValueGridProps) {
  const styles = useStyles();
  const pairs = useMemo(() => parsePairs(value, arrayMode), [value, arrayMode]);

  const emit = (next: Pair[]) => onChange(serialize(next, arrayMode));
  const setRow = (i: number, patch: Partial<Pair>) =>
    emit(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const addRow = () => emit([...pairs, { k: '', v: '' }]);
  const removeRow = (i: number) => emit(pairs.filter((_, idx) => idx !== i));

  return (
    <div className={styles.wrap}>
      {pairs.length > 0 && (
        <div className={styles.head}>
          <span className={styles.headLabel}>{keyLabel}</span>
          <span className={styles.headLabel}>{valueLabel}</span>
          <span />
        </div>
      )}
      {pairs.length === 0 && <Caption1 className={styles.empty}>No settings — add one below.</Caption1>}
      {pairs.map((p, i) => (
        <div key={i} className={styles.row}>
          <Input value={p.k} placeholder={keyPlaceholder} onChange={(_, d) => setRow(i, { k: d.value })} />
          <Input value={p.v} placeholder={valuePlaceholder} onChange={(_, d) => setRow(i, { v: d.value })} />
          <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove" onClick={() => removeRow(i)} />
        </div>
      ))}
      <div>
        <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={addRow}>{addLabel}</Button>
      </div>
    </div>
  );
}
