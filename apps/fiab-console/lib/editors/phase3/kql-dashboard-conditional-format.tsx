'use client';

/**
 * Conditional-formatting editor for KQL dashboard tiles — extracted from
 * kql-dashboard-editor.tsx (U8 decomposition; byte-equivalent move of
 * CF_*_LABELS + CfColumnField + ConditionalFormattingEditor).
 *
 * Fabric Real-Time Dashboard parity
 * (https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-conditional-formatting):
 * "Color by condition" (threshold → color/icon/tag, AND-ed conditions,
 * cells-or-row) and table-only "Color by value" (gradient theme). Every field
 * is a dropdown / typed Input — no freeform JSON (operator no-freeform-config
 * mandate). Rules evaluate client-side at render time over the tile's REAL
 * ADX result (`evalConditionalRules` in lib/azure/kql-dashboard-model).
 */

import {
  Badge, Button, Caption1, Input, Label, Select, Switch, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import {
  CF_OPERATORS, CF_COLORS, CF_ICONS, CF_THEMES,
  type ConditionalRule, type CfCondition,
  type CfColor, type CfIcon, type CfOperator, type CfTheme,
} from '@/lib/azure/kql-dashboard-model';

const CF_COLOR_LABELS: Record<CfColor, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
const CF_ICON_LABELS: Record<CfIcon, string> = { warning: 'Warning', error: 'Error', success: 'Success', info: 'Info' };
const CF_THEME_LABELS: Record<CfTheme, string> = {
  'traffic-lights': 'Traffic lights', cold: 'Cold', warm: 'Warm', blue: 'Blue', red: 'Red', yellow: 'Yellow',
};

/** A column field — Select when the live result has columns, else a free Input. */
export function CfColumnField({ value, columns, onChange, label }: { value: string; columns: string[]; onChange: (v: string) => void; label: string }) {
  if (columns.length > 0) {
    return (
      <Select size="small" value={value} aria-label={label} onChange={(_: unknown, d: any) => onChange(d.value)}>
        {!columns.includes(value) && <option value={value}>{value || '(pick column)'}</option>}
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    );
  }
  return <Input size="small" value={value} aria-label={label} placeholder="column name" onChange={(_: unknown, d: any) => onChange(d.value)} />;
}

/**
 * Per-tile conditional-formatting rule editor (Fabric Real-Time Dashboard
 * parity). Supports "Color by condition" (threshold → color/icon/tag, AND-ed
 * conditions, cells-or-row) and table-only "Color by value" (gradient theme).
 * Every field is a dropdown / typed Input — no freeform JSON (operator
 * no-freeform-config mandate). Rules apply client-side at render time.
 */
export function ConditionalFormattingEditor({ viz, rules, columns, onChange }: {
  viz: 'table' | 'stat';
  rules: ConditionalRule[];
  columns: string[];
  onChange: (rules: ConditionalRule[]) => void;
}) {
  const isTable = viz === 'table';
  const update = (idx: number, patch: Partial<ConditionalRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx));
  const addRule = (type: 'condition' | 'value') => {
    const col = columns[0] || '';
    const base: ConditionalRule = type === 'condition'
      ? { type, color: 'red', colorStyle: 'bold', applyTo: 'cells', conditions: [{ column: col, operator: '>', value: '' }] }
      : { type, theme: 'traffic-lights', column: col, applyTo: 'cells' };
    onChange([...rules, base]);
  };
  const updateCond = (ri: number, ci: number, patch: Partial<CfCondition>) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : r)));
  const addCond = (ri: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: [...(r.conditions || []), { column: columns[0] || '', operator: '>', value: '' }] } : r)));
  const removeCond = (ri: number, ci: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).filter((_, j) => j !== ci) } : r)));

  const fieldRow: React.CSSProperties = { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' };
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
        <Caption1 style={{ fontWeight: 600 }}>Conditional formatting</Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
          <Button size="small" icon={<Add20Regular />} onClick={() => addRule('condition')}>Color by condition</Button>
          {isTable && <Button size="small" icon={<Add20Regular />} onClick={() => addRule('value')}>Color by value</Button>}
        </div>
      </div>
      {columns.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Run the tile first to pick columns from its real result. You can still type column names below.</Caption1>
      )}
      {rules.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rules — cells render unstyled. Add a rule to color cells by a data threshold.</Caption1>
      )}
      {rules.map((rule, ri) => (
        <div key={ri} style={{ border: `1px solid ${tokens.colorNeutralStroke3}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground1 }}>
          <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', justifyContent: 'space-between' }}>
            <Badge appearance="outline" color={rule.type === 'value' ? 'informative' : 'brand'}>{rule.type === 'value' ? 'Color by value' : 'Color by condition'}</Badge>
            <Input size="small" style={{ flex: 1 }} value={rule.name || ''} placeholder={`Rule ${ri + 1} name (optional)`} aria-label={`Rule ${ri + 1} name`} onChange={(_: unknown, d: any) => update(ri, { name: d.value || undefined })} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete rule ${ri + 1}`} onClick={() => removeRule(ri)} />
          </div>

          {rule.type === 'condition' ? (
            <>
              {(rule.conditions || []).map((cond, ci) => (
                <div key={ci} style={fieldRow}>
                  {ci > 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>AND</Caption1>}
                  <div style={{ minWidth: 130 }}>
                    <CfColumnField label={`Rule ${ri + 1} condition ${ci + 1} column`} value={cond.column} columns={columns} onChange={(v) => updateCond(ri, ci, { column: v })} />
                  </div>
                  <Select size="small" value={cond.operator} aria-label={`Rule ${ri + 1} condition ${ci + 1} operator`} onChange={(_: unknown, d: any) => updateCond(ri, ci, { operator: d.value as CfOperator })}>
                    {CF_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </Select>
                  <Input
                    size="small"
                    style={{ width: 110 }}
                    value={cond.value || ''}
                    aria-label={`Rule ${ri + 1} condition ${ci + 1} value`}
                    placeholder="value"
                    disabled={cond.operator === 'is empty' || cond.operator === 'is not empty'}
                    onChange={(_: unknown, d: any) => updateCond(ri, ci, { value: d.value })}
                  />
                  {(rule.conditions || []).length > 1 && (
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove condition ${ci + 1}`} onClick={() => removeCond(ri, ci)} />
                  )}
                </div>
              ))}
              <div>
                <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => addCond(ri)}>Add condition</Button>
              </div>
              <div style={fieldRow}>
                <Label size="small">Color</Label>
                <Select size="small" value={rule.color || 'red'} aria-label={`Rule ${ri + 1} color`} onChange={(_: unknown, d: any) => update(ri, { color: d.value as CfColor })}>
                  {CF_COLORS.map((c) => <option key={c} value={c}>{CF_COLOR_LABELS[c]}</option>)}
                </Select>
                <Label size="small">Style</Label>
                <Select size="small" value={rule.colorStyle || 'bold'} aria-label={`Rule ${ri + 1} style`} onChange={(_: unknown, d: any) => update(ri, { colorStyle: d.value as 'bold' | 'light' })}>
                  <option value="bold">Bold</option>
                  <option value="light">Light</option>
                </Select>
                <Label size="small">Icon</Label>
                <Select size="small" value={rule.icon || ''} aria-label={`Rule ${ri + 1} icon`} onChange={(_: unknown, d: any) => update(ri, { icon: (d.value || undefined) as CfIcon | undefined })}>
                  <option value="">None</option>
                  {CF_ICONS.map((ic) => <option key={ic} value={ic}>{CF_ICON_LABELS[ic]}</option>)}
                </Select>
                <Label size="small">Tag</Label>
                <Input size="small" style={{ width: 110 }} value={rule.tag || ''} placeholder="optional" aria-label={`Rule ${ri + 1} tag`} onChange={(_: unknown, d: any) => update(ri, { tag: d.value || undefined })} />
              </div>
            </>
          ) : (
            <div style={fieldRow}>
              <Label size="small">Column</Label>
              <div style={{ minWidth: 130 }}>
                <CfColumnField label={`Rule ${ri + 1} value column`} value={rule.column || ''} columns={columns} onChange={(v) => update(ri, { column: v })} />
              </div>
              <Label size="small">Theme</Label>
              <Select size="small" value={rule.theme || 'traffic-lights'} aria-label={`Rule ${ri + 1} theme`} onChange={(_: unknown, d: any) => update(ri, { theme: d.value as CfTheme })}>
                {CF_THEMES.map((th) => <option key={th} value={th}>{CF_THEME_LABELS[th]}</option>)}
              </Select>
              <Label size="small">Min</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.minValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} min`} onChange={(_: unknown, d: any) => update(ri, { minValue: d.value === '' ? undefined : Number(d.value) })} />
              <Label size="small">Max</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.maxValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} max`} onChange={(_: unknown, d: any) => update(ri, { maxValue: d.value === '' ? undefined : Number(d.value) })} />
              <Switch label="Reverse" checked={!!rule.reverseColors} aria-label={`Rule ${ri + 1} reverse colors`} onChange={(_: unknown, d: any) => update(ri, { reverseColors: d.checked || undefined })} />
            </div>
          )}

          {isTable && (
            <div style={fieldRow}>
              <Label size="small">Apply to</Label>
              <Select size="small" value={rule.applyTo || 'cells'} aria-label={`Rule ${ri + 1} apply to`} onChange={(_: unknown, d: any) => update(ri, { applyTo: d.value as 'cells' | 'row' })}>
                <option value="cells">Matched cells</option>
                <option value="row">Entire row</option>
              </Select>
              {(rule.applyTo || 'cells') === 'cells' && (
                <>
                  <Label size="small">Target column</Label>
                  <Select size="small" value={rule.targetColumn || ''} aria-label={`Rule ${ri + 1} target column`} onChange={(_: unknown, d: any) => update(ri, { targetColumn: d.value || undefined })}>
                    <option value="">{rule.type === 'value' ? '(graded column)' : '(all conditioned columns)'}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  <Switch label="Hide text" checked={!!rule.hideText} aria-label={`Rule ${ri + 1} hide text`} onChange={(_: unknown, d: any) => update(ri, { hideText: d.checked || undefined })} />
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
