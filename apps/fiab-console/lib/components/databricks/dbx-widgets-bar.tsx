'use client';

/**
 * DbxWidgetsBar (R4-DBX-2) — the Databricks notebook input-widgets strip.
 *
 * Renders an interactive control per `dbutils.widgets.*` declaration parsed from
 * the notebook's cells (text → Input, dropdown → Dropdown, combobox → editable
 * Combobox, multiselect → multi Dropdown), exactly like the first-party widgets
 * bar. Changing a widget updates the value; the "on change" selector mirrors
 * Databricks' widget behaviour setting (do nothing vs. run all), and "Run all"
 * re-runs with the current widget values injected into the REPL.
 *
 * Grounded in https://learn.microsoft.com/azure/databricks/notebooks/widgets.
 * No mocks — values flow into real interactive runs (a REPL preamble) and real
 * job runs (`notebook_params`).
 */

import { useMemo } from 'react';
import {
  makeStyles, tokens, Caption1, Input, Dropdown, Option, Combobox,
  Button, Tooltip, Divider,
} from '@fluentui/react-components';
import { Play16Regular, Options16Regular } from '@fluentui/react-icons';
import type { WidgetSpec } from '@/lib/editors/databricks/dbx-widgets';

export type WidgetChangeBehavior = 'nothing' | 'run-all';

const useStyles = makeStyles({
  bar: {
    display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    marginBottom: tokens.spacingVerticalS,
  },
  widget: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '160px' },
  label: { color: tokens.colorNeutralForeground2 },
  spacer: { flex: 1 },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  behavior: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

export interface DbxWidgetsBarProps {
  widgets: WidgetSpec[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  behavior: WidgetChangeBehavior;
  onBehaviorChange: (b: WidgetChangeBehavior) => void;
  onRunAll: () => void;
  runDisabled?: boolean;
}

export function DbxWidgetsBar({
  widgets, values, onChange, behavior, onBehaviorChange, onRunAll, runDisabled,
}: DbxWidgetsBarProps) {
  const s = useStyles();
  const hasWidgets = widgets.length > 0;
  const sortedByName = useMemo(() => widgets, [widgets]);
  if (!hasWidgets) return null;

  return (
    <div className={s.bar} role="group" aria-label="Notebook widgets">
      {sortedByName.map((w) => {
        const val = values[w.name] ?? w.defaultValue;
        const label = w.label || w.name;
        return (
          <div key={w.name} className={s.widget}>
            <Caption1 className={s.label}>{label}</Caption1>
            {w.type === 'text' && (
              <Input
                size="small"
                value={val}
                aria-label={label}
                onChange={(_, d) => onChange(w.name, d.value)}
              />
            )}
            {w.type === 'dropdown' && (
              <Dropdown
                size="small"
                aria-label={label}
                value={val}
                selectedOptions={[val]}
                onOptionSelect={(_, d) => d.optionValue != null && onChange(w.name, d.optionValue)}
              >
                {(w.choices || []).map((c) => (
                  <Option key={c} value={c}>{c}</Option>
                ))}
              </Dropdown>
            )}
            {w.type === 'combobox' && (
              <Combobox
                size="small"
                freeform
                aria-label={label}
                value={val}
                selectedOptions={[val]}
                onInput={(e) => onChange(w.name, (e.target as HTMLInputElement).value)}
                onOptionSelect={(_, d) => d.optionValue != null && onChange(w.name, d.optionValue)}
              >
                {(w.choices || []).map((c) => (
                  <Option key={c} value={c}>{c}</Option>
                ))}
              </Combobox>
            )}
            {w.type === 'multiselect' && (
              <Dropdown
                size="small"
                multiselect
                aria-label={label}
                value={val}
                selectedOptions={val ? val.split(',').filter(Boolean) : []}
                onOptionSelect={(_, d) => onChange(w.name, (d.selectedOptions || []).join(','))}
              >
                {(w.choices || []).map((c) => (
                  <Option key={c} value={c}>{c}</Option>
                ))}
              </Dropdown>
            )}
          </div>
        );
      })}
      <div className={s.spacer} />
      <div className={s.actions}>
        <div className={s.behavior}>
          <Tooltip content="What happens when a widget value changes" relationship="label">
            <Options16Regular aria-hidden />
          </Tooltip>
          <Dropdown
            size="small"
            aria-label="On widget change"
            value={behavior === 'run-all' ? 'Run all' : 'Do nothing'}
            selectedOptions={[behavior]}
            onOptionSelect={(_, d) => d.optionValue && onBehaviorChange(d.optionValue as WidgetChangeBehavior)}
            style={{ minWidth: '128px' }}
          >
            <Option value="nothing">Do nothing</Option>
            <Option value="run-all">Run all</Option>
          </Dropdown>
        </div>
        <Divider vertical style={{ height: '24px' }} />
        <Button size="small" appearance="primary" icon={<Play16Regular />} onClick={onRunAll} disabled={runDisabled}>
          Run with values
        </Button>
      </div>
    </div>
  );
}
