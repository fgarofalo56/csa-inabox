'use client';

// well-editor.tsx — WellEditor field-well component.

import { useState } from 'react';
import {
  Button, Caption1, Dropdown, Option, tokens, mergeClasses,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader, MenuDivider,
  Tooltip,
} from '@fluentui/react-components';
import { Add20Regular, Dismiss16Regular, ReOrderDotsVertical16Regular, MathFormula16Regular } from '@fluentui/react-icons';
import { AGGS } from './types';
import { uid, fieldLabel, dataTypeGlyph, wellFieldDataType, wellFieldGlyph } from './helpers';
import type { DVisual, WellName, WellField, FieldTable, Agg } from './types';
import type { Styles } from './styles';

export function WellEditor({
  visual, well, label, tables, styles, onAdd, onRemove, onAgg, onDrop,
}: {
  visual: DVisual; well: WellName; label: string; tables: FieldTable[]; styles: Styles;
  onAdd: (well: WellName, f: WellField) => void;
  onRemove: (well: WellName, uid: string) => void;
  onAgg: (well: WellName, uid: string, agg: Agg) => void;
  onDrop: (well: WellName, payload: WellField) => void;
}) {
  const [over, setOver] = useState(false);
  const items = visual.wells[well] || [];
  return (
    <div className={styles.section}>
      <div className={styles.wellHead}>
        <Caption1><strong>{label}</strong></Caption1>
        <div className={styles.spacer} />
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label={`add field to ${label}`} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {tables.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
              {tables.map((t) => (
                <MenuGroup key={t.name}>
                  <MenuGroupHeader>{t.name}</MenuGroupHeader>
                  {t.measures.map((m) => (
                    <MenuItem key={`m:${m.name}`} icon={<MathFormula16Regular />}
                      onClick={() => onAdd(well, { uid: uid('f'), measure: m.name })}>{m.name}</MenuItem>
                  ))}
                  {t.columns.map((c) => (
                    <MenuItem key={`c:${c.name}`} icon={dataTypeGlyph(c.dataType)}
                      onClick={() => onAdd(well, { uid: uid('f'), table: t.name, column: c.name, aggregation: well === 'values' ? 'Sum' : undefined })}>{c.name}</MenuItem>
                  ))}
                  <MenuDivider />
                </MenuGroup>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      <div
        className={mergeClasses(styles.well, over && styles.wellOver)}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false);
          try {
            const p = JSON.parse(e.dataTransfer.getData('application/json')) as WellField & { __fromWell?: WellName; __fromUid?: string };
            if (!p || (!p.column && !p.measure)) return;
            const { __fromWell, __fromUid, ...field } = p;
            if (__fromWell && __fromUid && __fromWell === well) return;
            onDrop(well, { ...field, uid: uid('f'), aggregation: well === 'values' && field.column ? (field.aggregation || 'Sum') : field.aggregation });
            if (__fromWell && __fromUid) onRemove(__fromWell, __fromUid);
          } catch { /* ignore non-field drops */ }
        }}
      >
        {items.length === 0 && <Caption1 className={styles.muted}>Drop a field here</Caption1>}
        {items.map((f) => (
          <div key={f.uid} className={styles.token} draggable
            onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ ...f, __fromWell: well, __fromUid: f.uid }))}>
            <span className={styles.tokenGrip} aria-hidden><ReOrderDotsVertical16Regular /></span>
            <Tooltip content={f.measure ? 'Measure' : (wellFieldDataType(tables, f) || 'Text')} relationship="label">
              <span className={mergeClasses(styles.tokenType, f.measure && styles.tokenTypeMeasure)}>{wellFieldGlyph(tables, f)}</span>
            </Tooltip>
            <span className={styles.tokenName}>{fieldLabel(f)}</span>
            {well === 'values' && f.column && (
              <Dropdown size="small" value={f.aggregation || 'Sum'} selectedOptions={[f.aggregation || 'Sum']}
                aria-label="aggregation" style={{ minWidth: '92px' }}
                onOptionSelect={(_e, d) => onAgg(well, f.uid, (d.optionValue as Agg) || 'Sum')}>
                {AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
              </Dropdown>
            )}
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} className="well-token-remove"
              aria-label={`remove ${fieldLabel(f)}`} onClick={() => onRemove(well, f.uid)} />
          </div>
        ))}
      </div>
    </div>
  );
}
