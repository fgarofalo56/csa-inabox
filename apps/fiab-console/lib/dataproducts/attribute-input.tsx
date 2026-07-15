'use client';

/**
 * DP-17 — shared typed custom-attribute editor.
 *
 * Renders the control that matches each Purview attribute `fieldType` — Dropdown
 * (single/multiple choice), a date input (Date), a Checkbox (Boolean), a number
 * input (Integer/Double), a Textarea (Rich text), or a plain Input (Text). Both
 * the create wizard (step 3) and the edit dialog (Custom attributes step) render
 * through this ONE component, so a `Single choice` attribute is a Dropdown and a
 * `Boolean` is a Switch on BOTH surfaces — never a generic free-text `<Input>`
 * (a `loom_no_freeform_config` violation).
 */

import {
  Checkbox, Dropdown, Field, Input, Option, Textarea,
} from '@fluentui/react-components';

export type AttributeFieldType =
  | 'Text' | 'Single choice' | 'Multiple choice' | 'Date' | 'Boolean' | 'Integer' | 'Double' | 'Rich text';

export interface AttributeDef {
  id: string;
  name: string;
  description?: string;
  fieldType: AttributeFieldType;
  required?: boolean;
  choices?: string[];
}

export interface AttributeGroup {
  id: string;
  name: string;
  description?: string;
  attributes: AttributeDef[];
}

export type AttributeValue = string | string[] | boolean;

/** Render a single custom attribute by its Purview field type. */
export function AttributeInput({ attr, value, onChange }: {
  attr: AttributeDef;
  value: AttributeValue | undefined;
  onChange: (v: AttributeValue) => void;
}) {
  const common = { label: attr.name, required: attr.required, hint: attr.description } as const;
  switch (attr.fieldType) {
    case 'Boolean':
      return (
        <Field {...common}>
          <Checkbox checked={value === true} onChange={(_, d) => onChange(!!d.checked)} label="Yes" />
        </Field>
      );
    case 'Date':
      return (
        <Field {...common}>
          <Input type="date" value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
        </Field>
      );
    case 'Integer':
    case 'Double':
      return (
        <Field {...common}>
          <Input type="number" value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
        </Field>
      );
    case 'Rich text':
      return (
        <Field {...common}>
          <Textarea value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} resize="vertical" />
        </Field>
      );
    case 'Single choice':
      return (
        <Field {...common}>
          <Dropdown
            placeholder="Select a value"
            selectedOptions={typeof value === 'string' && value ? [value] : []}
            value={typeof value === 'string' ? value : ''}
            onOptionSelect={(_, d) => onChange(d.optionValue || '')}
          >
            {(attr.choices || []).map((c) => (<Option key={c} value={c}>{c}</Option>))}
          </Dropdown>
        </Field>
      );
    case 'Multiple choice':
      return (
        <Field {...common}>
          <Dropdown
            multiselect
            placeholder="Select values"
            selectedOptions={Array.isArray(value) ? value : []}
            value={Array.isArray(value) ? value.join(', ') : ''}
            onOptionSelect={(_, d) => onChange(d.selectedOptions)}
          >
            {(attr.choices || []).map((c) => (<Option key={c} value={c}>{c}</Option>))}
          </Dropdown>
        </Field>
      );
    case 'Text':
    default:
      return (
        <Field {...common}>
          <Input value={typeof value === 'string' ? value : ''} onChange={(_, d) => onChange(d.value)} />
        </Field>
      );
  }
}

export default AttributeInput;
