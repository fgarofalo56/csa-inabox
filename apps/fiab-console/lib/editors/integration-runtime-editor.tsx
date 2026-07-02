'use client';

/**
 * IntegrationRuntimeEditor — standalone editor for the first-class
 * `integration-runtime` catalog item (Azure / Self-Hosted / Azure-SSIS compute
 * that powers pipeline activity dispatch, data movement, and data-flow runs).
 *
 * THIN wrapper: it reuses the shared, sibling-owned
 * `IntegrationRuntimeManager` (lib/components/pipeline/integration-runtime-manager.tsx)
 * in FACTORY-SCOPED mode — IRs are factory-scoped, so the manager lists / creates
 * / manages the IRs of the deployment-default Data Factory directly via
 * /api/adf/integration-runtimes (real ARM, no mocks per no-vaporware.md).
 *
 * Azure-native per no-fabric-dependency.md — no Microsoft Fabric dependency. The
 * manager surfaces an honest infra-gate MessageBar when the factory env
 * (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME) isn't set, while still
 * rendering the full surface (the Synapse engine excludes Azure-SSIS, matching
 * the real Synapse Manage hub).
 *
 * Imports the shared manager READ-ONLY — no pipeline component is modified here.
 * Fluent v9 + Loom tokens only (web3-ui.md).
 */

import { useMemo, useState } from 'react';
import {
  Badge, Caption1, Field, Dropdown, Option, makeStyles, tokens,
} from '@fluentui/react-components';
import { Cloud20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { IntegrationRuntimeManager } from '@/lib/components/pipeline/integration-runtime-manager';
import type { PipelineEngine } from '@/lib/pipeline/integration-runtime-catalog';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: {
    padding: tokens.spacingVerticalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minWidth: 0, flex: 1,
  },
  bar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  backend: { minWidth: '260px' },
});

const ENGINES: Array<{ value: PipelineEngine; label: string; hint: string }> = [
  { value: 'adf', label: 'Azure Data Factory', hint: 'Azure-native default — Azure / Self-Hosted / Azure-SSIS runtimes.' },
  { value: 'synapse', label: 'Synapse workspace', hint: 'Azure / Self-Hosted runtimes (Synapse excludes Azure-SSIS).' },
];

export function IntegrationRuntimeEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [engine, setEngine] = useState<PipelineEngine>('adf');

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Engine', actions: [
        { label: 'Azure Data Factory', onClick: () => setEngine('adf'), title: 'Manage the deployment-default factory IRs (Azure / Self-Hosted / Azure-SSIS).' },
        { label: 'Synapse workspace', onClick: () => setEngine('synapse'), title: 'Manage Synapse IRs (Azure / Self-Hosted).' },
      ]},
    ]},
  ], []);

  const cur = ENGINES.find((e) => e.value === engine)!;

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          <div className={s.bar}>
            <Badge appearance="filled" color="brand" icon={<Cloud20Regular />}>Integration runtimes</Badge>
            <Field label="Engine" className={s.backend}>
              <Dropdown
                value={cur.label}
                selectedOptions={[engine]}
                onOptionSelect={(_, d) => { if (d.optionValue) setEngine(d.optionValue as PipelineEngine); }}
              >
                {ENGINES.map((e) => <Option key={e.value} value={e.value} text={e.label}>{e.label}</Option>)}
              </Dropdown>
            </Field>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{cur.hint}</Caption1>
          </div>

          {/* Reuse the shared manager, factory-scoped (deployment-default ADF).
              `key` forces a fresh load + re-scopes the offered IR types when the
              engine toggles (Synapse hides Azure-SSIS). */}
          <IntegrationRuntimeManager key={engine} factoryScoped engine={engine} />
        </div>
      }
    />
  );
}

export default IntegrationRuntimeEditor;
