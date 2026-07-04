'use client';

/**
 * DatasetPicker — reusable dropdown that binds a factory dataset to a Copy
 * activity's source (`inputs[0]`) or sink (`outputs[0]`). Populated from the
 * already-loaded `datasets` list (real `GET /api/adf/datasets` via
 * useCopyResources) — no network call of its own, no mock list.
 *
 * Below the dropdown it shows the selected dataset's connector type and the
 * linked service it binds to, so the user has the same at-a-glance context ADF
 * Studio shows when you pick a dataset. When the factory isn't configured the
 * caller passes `gateError`; we render an honest warning MessageBar but keep the
 * (disabled) dropdown visible so the surface never goes blank.
 */

import {
  Field, Dropdown, Option, Caption1, Badge, MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import type { AdfDataset } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  // Trigger keeps a sensible floor so a short field doesn't crush long names.
  dropdown: { minWidth: '240px' },
  // Let the popup grow with its content (up to a readable cap) instead of
  // matching the narrow trigger width and clipping long dataset names like
  // `Retail_OLTP_Mirror_Azure_SQL__s_dbo_Customers`. Scrolls past the cap.
  listbox: {
    minWidth: '240px',
    maxWidth: 'min(560px, 90vw)',
    maxHeight: '40vh',
  },
  // Wrap long names onto multiple lines rather than truncating mid-token; the
  // full name is also exposed via the `title` tooltip below.
  option: {
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
});

export interface DatasetPickerProps {
  label: string;
  /** Currently-bound dataset name ('' when none). */
  value: string;
  onChange: (datasetName: string, dataset: AdfDataset | undefined) => void;
  datasets: AdfDataset[];
  gateError?: string | null;
  required?: boolean;
  hint?: string;
}

export function DatasetPicker({
  label, value, onChange, datasets, gateError, required, hint,
}: DatasetPickerProps) {
  const s = useStyles();
  const selected = datasets.find((d) => d.name === value);
  const hasData = datasets.length > 0;

  return (
    <Field label={label} required={required} hint={hint}>
      {gateError && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalSNudge }}>
          <MessageBarBody>{gateError}</MessageBarBody>
        </MessageBar>
      )}
      <Dropdown
        className={s.dropdown}
        listbox={{ className: s.listbox }}
        // Selected value truncates in the trigger button — expose the full name
        // on hover so it's always recoverable.
        title={value || undefined}
        placeholder={hasData ? 'Select a dataset' : 'No datasets available'}
        value={value || ''}
        selectedOptions={value ? [value] : []}
        disabled={!hasData}
        onOptionSelect={(_, d) => {
          const name = d.optionValue || '';
          onChange(name, datasets.find((x) => x.name === name));
        }}
      >
        <Option value="" text="(none)">(none)</Option>
        {datasets.map((d) => (
          <Option key={d.name} value={d.name} text={d.name} title={d.name} className={s.option}>
            {d.name}
          </Option>
        ))}
      </Dropdown>
      {selected && (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalSNudge, alignItems: 'center', marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
          <Badge appearance="tint" color="brand" size="small">{selected.properties.type}</Badge>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            → {selected.properties.linkedServiceName?.referenceName || '(no linked service)'}
          </Caption1>
        </div>
      )}
      {!hasData && !gateError && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS }}>
          No datasets found — create one in the ribbon&apos;s <strong>Manage</strong> hub.
        </Caption1>
      )}
    </Field>
  );
}
