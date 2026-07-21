'use client';

// page-format-panel.tsx — CANVAS_TYPE_OPTS constant + PageFormatPanel component.

import {
  Button, Caption1, Checkbox, Divider, Dropdown, Input, Option, tokens, mergeClasses,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
} from '@fluentui/react-components';
import { Add20Regular, Dismiss16Regular, ColorRegular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { LOOM_DATA_PALETTE } from '../report/format-pane';
import type { FieldOpt } from '../report/filters-pane';
import type { CanvasType, DPage, WellFieldRef } from './types';
import type { Styles } from './styles';

export const CANVAS_TYPE_OPTS: { id: CanvasType; label: string }[] = [
  { id: '16:9', label: '16:9 (widescreen)' },
  { id: '4:3', label: '4:3 (standard)' },
  { id: 'letter', label: 'Letter' },
  { id: 'tooltip', label: 'Tooltip' },
  { id: 'custom', label: 'Custom' },
];

export function PageFormatPanel({ styles, page, fieldOpts, onChange }: {
  styles: Styles; page?: DPage; fieldOpts: FieldOpt[]; onChange: (patch: Partial<DPage>) => void;
}) {
  if (!page) {
    return <EmptyState icon={<ColorRegular />} title="No page" body="Add a page to format its canvas type and background." />;
  }
  const bg = page.background || {};
  const setBg = (p: Partial<NonNullable<DPage['background']>>) => onChange({ background: { ...(page.background || {}), ...p } });
  const ct = page.canvasType || '16:9';
  const dtFields = page.drillthrough?.fields || [];
  const optKey = (o: WellFieldRef) => o.measure ? `m:${o.measure}` : `c:${o.table}.${o.column}`;
  const addDrillField = (key: string) => {
    const o = fieldOpts.find((f) => f.key === key);
    if (!o) return;
    const ref: WellFieldRef = { table: o.table, column: o.column, measure: o.measure };
    if (dtFields.some((f) => optKey(f) === optKey(ref))) return;
    onChange({ drillthrough: { fields: [...dtFields, ref] } });
  };
  const removeDrillField = (key: string) => {
    onChange({ drillthrough: { fields: dtFields.filter((f) => optKey(f) !== key) } });
  };
  return (
    <div className={styles.pane} style={{ padding: tokens.spacingVerticalNone }}>
      <Caption1 className={styles.muted}>
        No visual selected — format the report <strong>page</strong> (Power BI parity). Select a visual on the canvas to format it instead.
      </Caption1>
      <div className={styles.section}>
        <Caption1><strong>Canvas type</strong></Caption1>
        <Dropdown size="small" aria-label="canvas type"
          value={CANVAS_TYPE_OPTS.find((c) => c.id === ct)?.label || '16:9 (widescreen)'}
          selectedOptions={[ct]}
          onOptionSelect={(_e, d) => onChange({ canvasType: (d.optionValue as CanvasType) || '16:9' })}>
          {CANVAS_TYPE_OPTS.map((c) => <Option key={c.id} value={c.id} text={c.label}>{c.label}</Option>)}
        </Dropdown>
      </div>
      <div className={styles.section}>
        <Caption1><strong>Page background</strong></Caption1>
        <div className={styles.pageSwatchRow} role="radiogroup" aria-label="page background color">
          <button type="button" role="radio" aria-checked={!bg.color} aria-label="None" title="None"
            className={mergeClasses(styles.pageSwatchDot, !bg.color && styles.pageSwatchActive)}
            style={{ backgroundColor: tokens.colorNeutralBackground1 }} onClick={() => setBg({ color: undefined })} />
          {LOOM_DATA_PALETTE.map((sw) => (
            <button key={sw.token} type="button" role="radio" aria-checked={bg.color === sw.token} aria-label={sw.label} title={sw.label}
              className={mergeClasses(styles.pageSwatchDot, bg.color === sw.token && styles.pageSwatchActive)}
              style={{ backgroundColor: sw.token }} onClick={() => setBg({ color: sw.token })} />
          ))}
        </div>
        {bg.color && (
          <>
            <Caption1 className={styles.muted}>Transparency (%)</Caption1>
            <Input size="small" type="number" min={0} max={100} aria-label="page background transparency"
              value={bg.transparency != null ? String(bg.transparency) : '0'}
              onChange={(_e, d) => setBg({ transparency: Math.min(100, Math.max(0, Math.round(Number(d.value) || 0))) })} />
          </>
        )}
      </div>

      <Divider />

      <div className={styles.section}>
        <Caption1><strong>Drillthrough fields</strong></Caption1>
        <Caption1 className={styles.muted}>
          Make this page a drillthrough target. A source visual containing one of these fields gets a
          right-click <strong>Drill through</strong> to this page, opening it filtered to the value.
        </Caption1>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="outline" icon={<Add20Regular />}>Add drillthrough field</Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {fieldOpts.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
              {fieldOpts.map((o) => (
                <MenuItem key={o.key} onClick={() => addDrillField(o.key)}>{o.label}</MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
        {dtFields.map((f) => (
          <div key={optKey(f)} className={styles.token}>
            <span className={styles.tokenName}>{f.measure || `${f.table ? `${f.table}.` : ''}${f.column}`}</span>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
              aria-label="remove drillthrough field" onClick={() => removeDrillField(optKey(f))} />
          </div>
        ))}
        {dtFields.length === 0 && <Caption1 className={styles.muted}>Not a drillthrough target.</Caption1>}
      </div>

      <Divider />

      <div className={styles.section}>
        <Caption1><strong>Tooltip page</strong></Caption1>
        <Caption1 className={styles.muted}>
          Use this page as a hover tooltip. Set <strong>Canvas type</strong> to <strong>Tooltip</strong>, turn this on,
          and bind the field whose mark shows it.
        </Caption1>
        <Checkbox label="Use as a report-page tooltip"
          checked={!!page.tooltipPage?.enabled}
          onChange={(_e, d) => onChange({ tooltipPage: { enabled: !!d.checked, boundField: page.tooltipPage?.boundField } })} />
        {page.tooltipPage?.enabled && (
          <>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button size="small" appearance="outline" icon={<Add20Regular />}>
                  {page.tooltipPage?.boundField ? 'Change bound field' : 'Bind a field'}
                </Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {fieldOpts.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
                  {fieldOpts.map((o) => (
                    <MenuItem key={o.key}
                      onClick={() => onChange({ tooltipPage: { enabled: true, boundField: { table: o.table, column: o.column, measure: o.measure } } })}>
                      {o.label}
                    </MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
            {page.tooltipPage?.boundField && (
              <div className={styles.token}>
                <span className={styles.tokenName}>
                  {page.tooltipPage.boundField.measure || `${page.tooltipPage.boundField.table ? `${page.tooltipPage.boundField.table}.` : ''}${page.tooltipPage.boundField.column}`}
                </span>
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
                  aria-label="clear bound field"
                  onClick={() => onChange({ tooltipPage: { enabled: true, boundField: undefined } })} />
              </div>
            )}
            <Caption1 className={styles.muted}>
              The binding saves with the page. The hover popover that mini-renders this page over a matching mark
              ships in a follow-on wave (see the parity doc).
            </Caption1>
          </>
        )}
      </div>

      <Caption1 className={styles.muted}>Canvas type + background persist with the page. Use the page menu to duplicate or hide a page.</Caption1>
    </div>
  );
}
