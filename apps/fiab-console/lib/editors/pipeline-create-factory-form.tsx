'use client';
/**
 * CREATE-NEW-FACTORY WIZARD — the "I don't have a Data Factory yet" branch of
 * the pipeline editor's factory picker.
 *
 * Extracted from `pipeline-editor-core.tsx` as its own bounded context (the core
 * had crossed the 1500-LOC monolith-creep guard). Presentational + controlled:
 * the parent owns the state and the ARM call, this owns the form.
 *
 * Note on where this sits after auto-bind. The ADF auto-bind provider resolves a
 * factory WITHOUT asking (item-pinned coords → env → Azure Resource Graph
 * discovery), so this wizard is no longer on the path a normal user walks. It is
 * the in-product Fix-it for the one genuine gate — no factory exists anywhere
 * the Loom identity can read — plus the explicit "re-map to a different factory"
 * flow. Real ARM PUT via `/api/adf/factories/create`; no JSON textarea, per
 * `loom_no_freeform_config`.
 */
import {
  Button, Dropdown, Field, Input, MessageBar, MessageBarBody, MessageBarTitle,
  Option, tokens,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { AzureResourcePicker } from '@/lib/components/azure/azure-resource-picker';

/**
 * Common Azure regions for the location picker (Commercial + US Government).
 * The default is the chosen resource group's location.
 */
export const ADF_FACTORY_REGIONS = [
  'eastus', 'eastus2', 'centralus', 'southcentralus', 'westus', 'westus2', 'westus3',
  'northcentralus', 'westcentralus', 'canadacentral', 'northeurope', 'westeurope',
  'uksouth', 'francecentral', 'germanywestcentral', 'switzerlandnorth',
  'norwayeast', 'swedencentral', 'eastasia', 'southeastasia', 'japaneast',
  'australiaeast', 'centralindia', 'koreacentral', 'brazilsouth', 'uaenorth',
  // US Government
  'usgovvirginia', 'usgovarizona', 'usgovtexas',
];

/** The resource group shape `AzureResourcePicker` hands back. */
export interface FactoryTargetRg {
  id: string;
  name: string;
  subscriptionId: string;
  resourceGroup: string;
  location: string;
}

export function CreateFactoryForm({
  name, onNameChange,
  rg, onRgChange,
  location, onLocationChange,
  busy, error, onCreate,
  rowClassName,
}: {
  name: string;
  onNameChange: (v: string) => void;
  rg: FactoryTargetRg | null;
  onRgChange: (r: FactoryTargetRg | null) => void;
  location: string;
  onLocationChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onCreate: () => void;
  rowClassName?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '560px' }}>
      <Field label="New factory name" required hint="Globally unique within Azure; 3-63 chars, letters/digits/hyphens.">
        <Input value={name} onChange={(_, d) => onNameChange(d.value)} placeholder="adf-loom-myteam" />
      </Field>
      <AzureResourcePicker
        type="Microsoft.Resources/subscriptions/resourceGroups"
        label="Target resource group"
        placeholder="Select a resource group (across all subscriptions)"
        value={rg?.id}
        onChange={onRgChange}
      />
      <Field label="Location" required hint="Azure region for the new Data Factory.">
        <Dropdown
          placeholder="Select a region"
          value={location}
          selectedOptions={location ? [location] : []}
          onOptionSelect={(_, d) => onLocationChange(d.optionValue || '')}
        >
          {ADF_FACTORY_REGIONS.map((r) => (<Option key={r} value={r} text={r}>{r}</Option>))}
        </Dropdown>
      </Field>
      <div className={rowClassName}>
        <Button
          appearance="primary"
          icon={<Add20Regular />}
          disabled={busy || !name.trim() || !rg || !(location || rg?.location)}
          onClick={onCreate}
        >
          {busy ? 'Creating…' : 'Create factory'}
        </Button>
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not create the factory</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}
