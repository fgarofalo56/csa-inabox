'use client';

/**
 * SinkTab — Copy activity "Sink" tab at ADF Studio parity.
 *
 * Real ADF Sink-tab capabilities (grounded in
 * https://learn.microsoft.com/azure/data-factory/copy-activity-overview#configuration):
 *   - Sink dataset picker → binds `outputs[0]` DatasetReference and stamps the
 *     matching Copy `sink.type` from the dataset's connector.
 *   - Connector-agnostic: pre-copy script, max concurrent connections, table option.
 *   - SQL-based connectors: write behavior (Insert / Upsert / Stored proc),
 *     disable metrics collection, write batch size.
 *   - File-based connectors: copy behavior (Preserve / Flatten / Merge), overwrite.
 *   - Advanced accordion: raw `sink` JSON for exotic connectors (escape hatch).
 *
 * Every control writes the real `typeProperties.sink` (and `outputs`). No mocks.
 */

import {
  Field, Input, Caption1, Subtitle2, Badge,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
// Wave-1 select-existing-OR-create picker (self-fetching dropdown + the 4-step
// "New dataset" wizard). Reused here so the Sink tab offers create-new inline.
import { DatasetSelectOrCreate } from '../dataset-wizard';
import { ExpressionField } from '../dynamic-content';
import { resolveConnector } from './copy-connector-map';
import { CopyFieldList, connectorTypeOfDataset } from './copy-fields';
import { copySinkFor, copyFormatSettingsFor, connectorSupportsSink } from '@/lib/pipeline/copy-activity-catalog';
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
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
});

export interface SinkTabProps {
  activity: PipelineActivity;
  datasets: AdfDataset[];
  /** Linked services — used to resolve the bound dataset's connector type. */
  linkedServices: AdfLinkedService[];
  gateError?: string | null;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  onPatch: (patch: Partial<PipelineActivity>) => void;
  /** Re-fetch the shared dataset/linked-service lists after an inline create. */
  onDatasetsChanged?: () => void;
}

export function SinkTab({ activity, datasets, linkedServices, gateError, parameters, variables, allActivities, onPatch, onDatasetsChanged }: SinkTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as any;
  const sink = (tp.sink || {}) as any;
  const outputName = ((activity.outputs as any[]) || [])[0]?.referenceName as string | undefined;

  // Resolve the bound dataset → its connector type → the per-store SINK field
  // set from the copy-activity-catalog (family fallback so the tab is never blank).
  const boundDs = datasets.find((d) => d.name === outputName);
  const connectorType = connectorTypeOfDataset(boundDs, linkedServices);
  const sinkSpec = copySinkFor(connectorType);
  const fmt = copyFormatSettingsFor(boundDs?.properties.type);

  const patchSink = (patch: Record<string, unknown>) =>
    onPatch({ typeProperties: { ...tp, sink: { ...sink, ...patch } } });

  /** Patch a single key into sink (used by the catalog field renderer). */
  const patchKey = (key: string, value: unknown) => {
    const next = { ...sink, [key]: value };
    if (value === undefined) delete next[key];
    onPatch({ typeProperties: { ...tp, sink: next } });
  };

  /** Patch a key into sink.storeSettings / sink.formatSettings. */
  const patchNested = (parentKey: 'storeSettings' | 'formatSettings', parentType: string) =>
    (key: string, value: unknown) => {
      const parent = { type: parentType, ...(sink[parentKey] || {}), [key]: value };
      if (value === undefined) delete parent[key];
      onPatch({ typeProperties: { ...tp, sink: { ...sink, [parentKey]: parent } } });
    };

  // Whether the bound store can be a Copy SINK (source-only stores like Amazon
  // S3 / Redshift / read-only REST hide the sink-settings forms and show an
  // honest explanation instead of dead controls).
  const sinkSupported = !connectorType || connectorSupportsSink(connectorType);

  const onPickDataset = (name: string, picked?: { name: string; type?: string }) => {
    const outputs = name
      ? [{ referenceName: name, type: 'DatasetReference', parameters: {} }]
      : [];
    const datasetType = datasets.find((d) => d.name === name)?.properties.type ?? picked?.type;
    const conn = resolveConnector(datasetType);
    const nextSink = { ...sink, ...(conn.sink ? { type: conn.sink } : {}) };
    onPatch({ outputs, typeProperties: { ...tp, sink: nextSink } });
  };

  return (
    <div className={s.section}>
      {gateError && (
        <MessageBar intent="warning">
          <MessageBarBody>{gateError}</MessageBarBody>
        </MessageBar>
      )}
      <DatasetSelectOrCreate
        label="Sink dataset"
        value={outputName || ''}
        onChange={(name, picked) => {
          onPickDataset(name, picked);
          if (picked && !datasets.some((d) => d.name === name)) onDatasetsChanged?.();
        }}
        required
        hint="The dataset to write to. Select an existing one or create a new one inline — either binds outputs[0] and sets the sink connector type."
      />
      {sink.type && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Sink type: <Badge appearance="outline" size="small">{sink.type}</Badge>
        </Caption1>
      )}

      {/* ── Source-only store: no Copy sink. Honest explanation, not dead forms. ── */}
      {boundDs && !sinkSupported && (
        <MessageBar intent="info">
          <MessageBarBody>
            <strong>{connectorType}</strong> is a read-only Copy connector — it can be a
            source but not a sink. Bind a writable store (Azure SQL, ADLS Gen2, Blob,
            Cosmos DB, …) as the sink, or use this dataset on the Source tab.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── Connector-specific SINK settings (data-driven from the catalog) ── */}
      {sinkSupported && sinkSpec.fields.length > 0 && (
        <>
          <Subtitle2>Sink settings</Subtitle2>
          <CopyFieldList
            fields={sinkSpec.fields}
            values={sink}
            onPatch={patchKey}
            activity={activity} parameters={parameters} variables={variables} allActivities={allActivities}
          />
          {/* Upsert key columns — array field rendered as a comma list. */}
          {String(sink.writeBehavior || '').toLowerCase() === 'upsert' && (
            <Field label="Upsert key columns"
              hint="Comma-separated column names that uniquely identify a row (defaults to the primary key).">
              <Input
                value={Array.isArray(sink.upsertSettings?.keys) ? sink.upsertSettings.keys.join(', ') : ''}
                placeholder="OrderID, CustomerID"
                onChange={(_, d) => {
                  const keys = d.value.split(',').map((k) => k.trim()).filter(Boolean);
                  patchSink({ upsertSettings: keys.length ? { ...(sink.upsertSettings || {}), keys } : undefined });
                }} />
            </Field>
          )}
        </>
      )}

      {/* ── File-store write settings (storeSettings.*) ── */}
      {sinkSupported && sinkSpec.storeSettings && sinkSpec.storeSettings.length > 0 && (
        <>
          <Subtitle2>File settings</Subtitle2>
          <CopyFieldList
            fields={sinkSpec.storeSettings}
            values={(sink.storeSettings || {}) as Record<string, unknown>}
            onPatch={patchNested('storeSettings', `${(connectorType || 'AzureBlobFS')}WriteSettings`)}
            activity={activity} parameters={parameters} variables={variables} allActivities={allActivities}
          />
        </>
      )}

      {/* ── Format write settings (formatSettings.*) for the bound file format ── */}
      {sinkSupported && fmt && fmt.writeFields.length > 0 && (
        <>
          <Subtitle2>{boundDs?.properties.type} write settings</Subtitle2>
          <CopyFieldList
            fields={fmt.writeFields}
            values={(sink.formatSettings || {}) as Record<string, unknown>}
            onPatch={patchNested('formatSettings', fmt.writeType)}
            activity={activity} parameters={parameters} variables={variables} allActivities={allActivities}
          />
        </>
      )}

      {/* ── Pre-copy script (file sinks: not applicable; tabular spec already
              includes it — this stays for parity on connectors without a spec) ── */}
      {sinkSupported && sinkSpec.fields.length === 0 && (
        <ExpressionField
          label="Pre-copy script"
          hint="SQL run against the sink before the copy (e.g. TRUNCATE TABLE)."
          value={typeof sink.preCopyScript === 'string' ? sink.preCopyScript : ''}
          onChange={(v) => patchSink({ preCopyScript: v || undefined })}
          multiline
          placeholder="TRUNCATE TABLE dbo.Staging"
          parameters={parameters} variables={variables} activities={allActivities}
          selfName={activity.name}
        />
      )}

      {/* ── Advanced escape hatch ── */}
      <Accordion collapsible>
        <AccordionItem value="sink-advanced">
          <AccordionHeader>Advanced — raw sink JSON</AccordionHeader>
          <AccordionPanel>
            <Caption1>For exotic connectors / settings not surfaced above.</Caption1>
            <textarea
              className={s.jsonArea}
              value={JSON.stringify(sink, null, 2)}
              onChange={(e) => {
                try { onPatch({ typeProperties: { ...tp, sink: JSON.parse(e.target.value) } }); }
                catch { /* let the user keep typing */ }
              }}
            />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
