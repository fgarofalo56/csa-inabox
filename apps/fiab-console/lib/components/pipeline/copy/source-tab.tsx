'use client';

/**
 * SourceTab — Copy activity "Source" tab at ADF Studio parity.
 *
 * Real ADF Source-tab capabilities (grounded in
 * https://learn.microsoft.com/azure/data-factory/copy-activity-overview#configuration):
 *   - Source dataset picker → binds `inputs[0]` DatasetReference and stamps the
 *     matching Copy `source.type` from the dataset's connector.
 *   - Connector-agnostic "Additional columns" ($$FILEPATH / static / expression).
 *   - File-based connectors: recursive, wildcard folder/file, modified-date range.
 *   - SQL-based connectors: read mode (table / query / stored proc), query text,
 *     query timeout, isolation level.
 *   - Advanced accordion: raw `source` JSON for exotic connectors (escape hatch,
 *     never required for the happy path).
 *
 * Every control writes the real `typeProperties.source` (and `inputs`) — these
 * round-trip on the pipeline PUT. No mock data, no dead controls.
 */

import {
  Field, Input, Caption1, Button, Subtitle2, Badge,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
// Wave-1 select-existing-OR-create picker (self-fetching dropdown + the 4-step
// "New dataset" wizard). Reused here so the Source tab offers create-new inline,
// exactly like ADF Studio's source-dataset picker.
import { DatasetSelectOrCreate } from '../dataset-wizard';
import { resolveConnector } from './copy-connector-map';
import { CopyFieldList, connectorTypeOfDataset } from './copy-fields';
import { copySourceFor, copyFormatSettingsFor } from '@/lib/pipeline/copy-activity-catalog';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from '../types';
import type { AdfDataset, AdfLinkedService } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  jsonArea: {
    width: '100%', minHeight: '140px',
    fontFamily: 'Consolas, monospace', fontSize: '12px', padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1, resize: 'vertical',
  },
  addlRow: { display: 'flex', gap: '6px', alignItems: 'flex-end' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
});

export interface SourceTabProps {
  activity: PipelineActivity;
  datasets: AdfDataset[];
  /** Linked services — used to resolve the bound dataset's connector type. */
  linkedServices: AdfLinkedService[];
  gateError?: string | null;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  onPatch: (patch: Partial<PipelineActivity>) => void;
  /**
   * Called after the inline "＋ New dataset" wizard upserts a dataset, so the
   * parent re-fetches the shared dataset/linked-service lists (useCopyResources)
   * and the freshly-created dataset's full `properties` (type / schema / linked
   * service) flow back into this tab for the per-store + format settings.
   */
  onDatasetsChanged?: () => void;
}

interface AdditionalColumn { name: string; value: string }

export function SourceTab({ activity, datasets, linkedServices, gateError, parameters, variables, allActivities, onPatch, onDatasetsChanged }: SourceTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as any;
  const src = (tp.source || {}) as any;
  const inputName = ((activity.inputs as any[]) || [])[0]?.referenceName as string | undefined;

  // Resolve the bound dataset → its backing connector type → the per-store
  // SOURCE field set from the copy-activity-catalog (with a family fallback so
  // the tab is never blank). Prefer the current source.type's connector when no
  // dataset is bound yet.
  const boundDs = datasets.find((d) => d.name === inputName);
  const connectorType = connectorTypeOfDataset(boundDs, linkedServices);
  const sourceSpec = copySourceFor(connectorType);
  const fmt = copyFormatSettingsFor(boundDs?.properties.type);

  const patchSource = (patch: Record<string, unknown>) =>
    onPatch({ typeProperties: { ...tp, source: { ...src, ...patch } } });

  /** Patch a single key into source (used by the catalog field renderer). */
  const patchKey = (key: string, value: unknown) => {
    const next = { ...src, [key]: value };
    if (value === undefined) delete next[key];
    onPatch({ typeProperties: { ...tp, source: next } });
  };

  /** Patch a key into source.storeSettings / source.formatSettings. */
  const patchNested = (parentKey: 'storeSettings' | 'formatSettings', parentType: string) =>
    (key: string, value: unknown) => {
      const parent = { type: parentType, ...(src[parentKey] || {}), [key]: value };
      if (value === undefined) delete parent[key];
      onPatch({ typeProperties: { ...tp, source: { ...src, [parentKey]: parent } } });
    };

  // The Wave-1 picker hands back the dataset name plus a lightweight
  // { name, type, linkedService } summary; we resolve the full AdfDataset from
  // the already-loaded list when present (so we get the exact dataset
  // `properties.type` for the connector map), else fall back to the summary type.
  const onPickDataset = (name: string, picked?: { name: string; type?: string }) => {
    const inputs = name
      ? [{ referenceName: name, type: 'DatasetReference', parameters: {} }]
      : [];
    const datasetType = datasets.find((d) => d.name === name)?.properties.type ?? picked?.type;
    const conn = resolveConnector(datasetType);
    const nextSource = { ...src, ...(conn.source ? { type: conn.source } : {}) };
    onPatch({ inputs, typeProperties: { ...tp, source: nextSource } });
  };

  // ── Additional columns ──────────────────────────────────────────────────
  const addl: AdditionalColumn[] = Array.isArray(src.additionalColumns) ? src.additionalColumns : [];
  const setAddl = (next: AdditionalColumn[]) =>
    patchSource({ additionalColumns: next.length ? next : undefined });

  return (
    <div className={s.section}>
      {gateError && (
        <MessageBar intent="warning">
          <MessageBarBody>{gateError}</MessageBarBody>
        </MessageBar>
      )}
      <DatasetSelectOrCreate
        label="Source dataset"
        value={inputName || ''}
        onChange={(name, picked) => {
          onPickDataset(name, picked);
          // A freshly-created dataset isn't in the parent's pre-loaded list yet —
          // ask the parent to re-fetch so its full props reach Mapping / formats.
          if (picked && !datasets.some((d) => d.name === name)) onDatasetsChanged?.();
        }}
        required
        hint="The dataset to read from. Select an existing one or create a new one inline — either binds inputs[0] and sets the source connector type."
      />
      {src.type && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Source type: <Badge appearance="outline" size="small">{src.type}</Badge>
        </Caption1>
      )}

      {/* ── Connector-specific SOURCE settings (data-driven from the catalog) ── */}
      {sourceSpec.fields.length > 0 && (
        <>
          <Subtitle2>Source settings</Subtitle2>
          <CopyFieldList
            fields={sourceSpec.fields}
            values={src}
            onPatch={patchKey}
            activity={activity} parameters={parameters} variables={variables} allActivities={allActivities}
          />
        </>
      )}

      {/* ── File-store read settings (storeSettings.*) ── */}
      {sourceSpec.storeSettings && sourceSpec.storeSettings.length > 0 && (
        <>
          <Subtitle2>File settings</Subtitle2>
          <CopyFieldList
            fields={sourceSpec.storeSettings}
            values={(src.storeSettings || {}) as Record<string, unknown>}
            onPatch={patchNested('storeSettings', `${(connectorType || 'AzureBlobFS')}ReadSettings`)}
            activity={activity} parameters={parameters} variables={variables} allActivities={allActivities}
          />
        </>
      )}

      {/* ── Format read settings (formatSettings.*) for the bound file format ── */}
      {fmt && fmt.readFields.length > 0 && (
        <>
          <Subtitle2>{boundDs?.properties.type} read settings</Subtitle2>
          <CopyFieldList
            fields={fmt.readFields}
            values={(src.formatSettings || {}) as Record<string, unknown>}
            onPatch={patchNested('formatSettings', fmt.readType)}
            activity={activity} parameters={parameters} variables={variables} allActivities={allActivities}
          />
        </>
      )}

      {/* ── Additional columns (all connectors) ── */}
      <Subtitle2>Additional columns</Subtitle2>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Append computed columns to each row — a static value, <code>$$FILEPATH</code>,
        <code> $$COLUMN:&lt;name&gt;</code>, or an expression.
      </Caption1>
      {addl.map((col, i) => (
        <div key={i} className={s.addlRow}>
          <Field label={i === 0 ? 'Name' : undefined} style={{ flex: 1 }}>
            <Input value={col.name} placeholder="newColumn"
              onChange={(_, d) => setAddl(addl.map((c, j) => j === i ? { ...c, name: d.value } : c))} />
          </Field>
          <Field label={i === 0 ? 'Value' : undefined} style={{ flex: 1 }}>
            <Input value={col.value} placeholder="$$FILEPATH"
              onChange={(_, d) => setAddl(addl.map((c, j) => j === i ? { ...c, value: d.value } : c))} />
          </Field>
          <Button appearance="subtle" icon={<Delete20Regular />}
            aria-label={col.name ? `Remove additional column ${col.name}` : 'Remove additional column'}
            onClick={() => setAddl(addl.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="small" icon={<Add20Regular />}
        onClick={() => setAddl([...addl, { name: '', value: '' }])}>
        Add column
      </Button>

      {/* ── Advanced escape hatch ── */}
      <Accordion collapsible>
        <AccordionItem value="src-advanced">
          <AccordionHeader>Advanced — raw source JSON</AccordionHeader>
          <AccordionPanel>
            <Caption1>For exotic connectors / settings not surfaced above.</Caption1>
            <textarea
              className={s.jsonArea}
              value={JSON.stringify(src, null, 2)}
              onChange={(e) => {
                try { onPatch({ typeProperties: { ...tp, source: JSON.parse(e.target.value) } }); }
                catch { /* let the user keep typing */ }
              }}
            />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
