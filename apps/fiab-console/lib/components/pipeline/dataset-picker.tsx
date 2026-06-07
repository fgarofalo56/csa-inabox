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
  tokens,
} from '@fluentui/react-components';
import type { AdfDataset } from '@/lib/azure/adf-client';

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
  const selected = datasets.find((d) => d.name === value);
  const hasData = datasets.length > 0;

  return (
    <Field label={label} required={required} hint={hint}>
      {gateError && (
        <MessageBar intent="warning" style={{ marginBottom: 6 }}>
          <MessageBarBody>{gateError}</MessageBarBody>
        </MessageBar>
      )}
      <Dropdown
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
          <Option key={d.name} value={d.name} text={d.name}>{d.name}</Option>
        ))}
      </Dropdown>
      {selected && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
          <Badge appearance="tint" color="brand" size="small">{selected.properties.type}</Badge>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            → {selected.properties.linkedServiceName?.referenceName || '(no linked service)'}
          </Caption1>
        </div>
      )}
      {!hasData && !gateError && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 4 }}>
          No datasets found — create one in the ribbon&apos;s <strong>Manage</strong> hub.
        </Caption1>
      )}
    </Field>
  );
}
