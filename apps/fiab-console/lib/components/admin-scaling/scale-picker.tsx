'use client';

import { Dropdown, Option, Label, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  row: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  label: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  // Fill the table cell (numeric/picker cells share one grid column) but keep a
  // sane floor so the SKU labels are never clipped.
  dropdown: { minWidth: '180px', width: '100%' },
});

export interface ScaleOption {
  value: string;
  label: string;
  description?: string;
}

export function ScalePicker({
  label, options, value, onChange, disabled,
}: {
  label: string;
  options: ScaleOption[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const styles = useStyles();
  const current = options.find(o => o.value === value);
  return (
    <div className={styles.row}>
      <Label className={styles.label}>{label}</Label>
      <Dropdown
        value={current?.label ?? value ?? ''}
        selectedOptions={[value]}
        disabled={disabled}
        onOptionSelect={(_, data) => data.optionValue && onChange(data.optionValue)}
        className={styles.dropdown}
      >
        {options.map(o => (
          <Option key={o.value} value={o.value} text={o.label}>
            {o.label}
            {o.description ? ` — ${o.description}` : ''}
          </Option>
        ))}
      </Dropdown>
    </div>
  );
}
