'use client';

/**
 * KeyValueRows — edit a flat JSON object of scalar values as guided key/value
 * rows instead of a raw JSON textarea (per .claude/rules/loom_no_freeform_config).
 * Emits the object back as a JSON string so it drops into existing string-based
 * contracts (e.g. a `runParams[...]` map) with no backend change. Holds local
 * row state so typing a key/value is stable (empty keys are dropped on emit).
 */
import { useState } from 'react';
import { Input, Button, tokens } from '@fluentui/react-components';
import { Add16Regular, Dismiss16Regular } from '@fluentui/react-icons';

interface Row { k: string; v: string }

function parse(s: string): Row[] {
  try {
    const o = s ? JSON.parse(s) : {};
    const e = Object.entries(o).map(([k, v]) => ({ k, v: typeof v === 'string' ? v : JSON.stringify(v) }));
    return e.length ? e : [{ k: '', v: '' }];
  } catch { return [{ k: '', v: '' }]; }
}

export function KeyValueRows({
  value,
  onChange,
  addLabel = 'Add property',
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
}: {
  value: string;
  onChange: (json: string) => void;
  addLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => parse(value));

  const apply = (next: Row[]) => {
    setRows(next.length ? next : [{ k: '', v: '' }]);
    const o: Record<string, string> = {};
    for (const r of next) if (r.k.trim()) o[r.k.trim()] = r.v;
    onChange(Object.keys(o).length ? JSON.stringify(o) : '');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
          <Input style={{ flex: 1 }} placeholder={keyPlaceholder} value={r.k}
            onChange={(_, d) => apply(rows.map((row, j) => j === i ? { ...row, k: d.value } : row))} />
          <Input style={{ flex: 1 }} placeholder={valuePlaceholder} value={r.v}
            onChange={(_, d) => apply(rows.map((row, j) => j === i ? { ...row, v: d.value } : row))} />
          <Button appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove row"
            onClick={() => apply(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button size="small" appearance="subtle" icon={<Add16Regular />}
          onClick={() => apply([...rows, { k: '', v: '' }])}>{addLabel}</Button>
      </div>
    </div>
  );
}
