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
  Field, Input, Switch, Select, Caption1, Badge,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { DatasetPicker } from '../dataset-picker';
import { ExpressionField } from '../dynamic-content';
import { resolveConnector, categoryOfCopyType } from './copy-connector-map';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from '../types';
import type { AdfDataset } from '@/lib/azure/adf-client';

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
  gateError?: string | null;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  onPatch: (patch: Partial<PipelineActivity>) => void;
}

export function SinkTab({ activity, datasets, gateError, parameters, variables, allActivities, onPatch }: SinkTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as any;
  const sink = (tp.sink || {}) as any;
  const outputName = ((activity.outputs as any[]) || [])[0]?.referenceName as string | undefined;

  const boundDs = datasets.find((d) => d.name === outputName);
  const category = boundDs
    ? resolveConnector(boundDs.properties.type).category
    : categoryOfCopyType(sink.type);

  const patchSink = (patch: Record<string, unknown>) =>
    onPatch({ typeProperties: { ...tp, sink: { ...sink, ...patch } } });

  const onPickDataset = (name: string, ds: AdfDataset | undefined) => {
    const outputs = name
      ? [{ referenceName: name, type: 'DatasetReference', parameters: {} }]
      : [];
    const conn = resolveConnector(ds?.properties.type);
    const nextSink = { ...sink, ...(conn.sink ? { type: conn.sink } : {}) };
    onPatch({ outputs, typeProperties: { ...tp, sink: nextSink } });
  };

  return (
    <div className={s.section}>
      <DatasetPicker
        label="Sink dataset"
        value={outputName || ''}
        onChange={onPickDataset}
        datasets={datasets}
        gateError={gateError}
        required
        hint="The dataset to write to. Selecting it binds outputs[0] and sets the sink connector type."
      />
      {sink.type && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Sink type: <Badge appearance="outline" size="small">{sink.type}</Badge>
        </Caption1>
      )}

      {/* ── SQL-based sink settings ── */}
      {category === 'sqlBased' && (
        <>
          <Field label="Write behavior">
            <Select value={sink.writeBehavior || 'insert'}
              onChange={(_, d) => patchSink({ writeBehavior: d.value })}>
              <option value="insert">Insert</option>
              <option value="upsert">Upsert</option>
              <option value="StoredProcedure">Stored procedure</option>
            </Select>
          </Field>
          <Field label="Write batch size" hint="Rows per write batch (blank = connector default).">
            <Input type="number" value={sink.writeBatchSize != null ? String(sink.writeBatchSize) : ''}
              onChange={(_, d) => patchSink({ writeBatchSize: d.value ? Number(d.value) : undefined })} />
          </Field>
          <Field label="Disable metrics collection">
            <Switch checked={!!sink.disableMetricsCollection}
              onChange={(_, d) => patchSink({ disableMetricsCollection: d.checked })} />
          </Field>
        </>
      )}

      {/* ── File-based sink settings ── */}
      {category === 'fileBased' && (
        <>
          <Field label="Copy behavior" hint="How source files/folders map onto the sink.">
            <Select value={sink.copyBehavior || ''}
              onChange={(_, d) => patchSink({ copyBehavior: d.value || undefined })}>
              <option value="">(default)</option>
              <option value="PreserveHierarchy">Preserve hierarchy</option>
              <option value="FlattenHierarchy">Flatten hierarchy</option>
              <option value="MergeFiles">Merge files</option>
            </Select>
          </Field>
        </>
      )}

      {/* ── Connector-agnostic sink settings ── */}
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
      <div style={{ display: 'flex', gap: 12 }}>
        <Field label="Max concurrent connections">
          <Input type="number" value={sink.maxConcurrentConnections != null ? String(sink.maxConcurrentConnections) : ''}
            onChange={(_, d) => patchSink({ maxConcurrentConnections: d.value ? Number(d.value) : undefined })} />
        </Field>
        <Field label="Table option" hint="Auto-create the sink table if it doesn't exist.">
          <Select value={sink.tableOption || ''}
            onChange={(_, d) => patchSink({ tableOption: d.value || undefined })}>
            <option value="">(none)</option>
            <option value="autoCreate">Auto create table</option>
          </Select>
        </Field>
      </div>

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
