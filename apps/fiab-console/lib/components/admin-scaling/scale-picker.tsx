'use client';

import { Dropdown, Option, Label, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  row: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600 },
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
        style={{ minWidth: 220 }}
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
