'use client';

/**
 * LinkedServiceEditor — standalone editor for the first-class `linked-service`
 * catalog item (the bind target for pipelines / datasets / data flows).
 *
 * This is a THIN wrapper: it reuses the shared, sibling-owned
 * `LinkedServiceGallery` (lib/components/pipeline/linked-service-gallery.tsx)
 * in MANAGE mode — the full 31-connector gallery + per-connector structured
 * config form (auth selector, secrets as secureString) + Test connection +
 * Create / Edit / Delete of the linked services already on the backend.
 *
 * Backend is Azure-native per no-fabric-dependency.md:
 *   • Azure Data Factory (default) → /api/adf/linked-services (real ARM)
 *   • Synapse workspace (opt-in)   → /api/synapse/linkedservices (Synapse dev plane)
 * Both are real REST round-trips (no mocks, per no-vaporware.md); the gallery
 * surfaces an honest infra-gate MessageBar when the backend env isn't set.
 *
 * The component imports the shared gallery READ-ONLY — no pipeline component is
 * modified here. Fluent v9 + Loom tokens only (web3-ui.md).
 */

import { useMemo, useState } from 'react';
import {
  Badge, Caption1, Field, Dropdown, Option, makeStyles, tokens,
} from '@fluentui/react-components';
import { PlugConnected20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import {
  LinkedServiceGallery, type LinkedServiceEngine,
} from '@/lib/components/pipeline/linked-service-gallery';
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

const ENGINES: Array<{ value: LinkedServiceEngine; label: string; hint: string }> = [
  { value: 'adf', label: 'Azure Data Factory', hint: 'Azure-native default — the deployment-default factory.' },
  { value: 'synapse', label: 'Synapse workspace', hint: 'Opt-in — author linked services on the bound Synapse workspace.' },
];

export function LinkedServiceEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [engine, setEngine] = useState<LinkedServiceEngine>('adf');

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Backend', actions: [
        { label: 'Azure Data Factory', onClick: () => setEngine('adf'), title: 'Author on the deployment-default Data Factory (Azure-native default).' },
        { label: 'Synapse workspace', onClick: () => setEngine('synapse'), title: 'Author on the bound Synapse workspace.' },
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
            <Badge appearance="filled" color="brand" icon={<PlugConnected20Regular />}>Linked services</Badge>
            <Field label="Backend" className={s.backend}>
              <Dropdown
                value={cur.label}
                selectedOptions={[engine]}
                onOptionSelect={(_, d) => { if (d.optionValue) setEngine(d.optionValue as LinkedServiceEngine); }}
              >
                {ENGINES.map((e) => <Option key={e.value} value={e.value} text={e.label}>{e.label}</Option>)}
              </Dropdown>
            </Field>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{cur.hint}</Caption1>
          </div>

          {/* Reuse the shared gallery in manage mode (browse + create + edit +
              delete real linked services on the chosen backend). `key` forces a
              fresh load when the backend toggles. */}
          <LinkedServiceGallery key={engine} engine={engine} manage />
        </div>
      }
    />
  );
}

export default LinkedServiceEditor;
