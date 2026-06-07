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
  Field, Input, Switch, Select, Caption1, Button, Subtitle2, Badge,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular } from '@fluentui/react-icons';
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
  addlRow: { display: 'flex', gap: '6px', alignItems: 'flex-end' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
});

export interface SourceTabProps {
  activity: PipelineActivity;
  datasets: AdfDataset[];
  gateError?: string | null;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  allActivities: PipelineActivity[];
  onPatch: (patch: Partial<PipelineActivity>) => void;
}

interface AdditionalColumn { name: string; value: string }

export function SourceTab({ activity, datasets, gateError, parameters, variables, allActivities, onPatch }: SourceTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as any;
  const src = (tp.source || {}) as any;
  const inputName = ((activity.inputs as any[]) || [])[0]?.referenceName as string | undefined;

  // Connector family drives which extra controls render. Prefer the bound
  // dataset's type; fall back to the current source.type when no dataset.
  const boundDs = datasets.find((d) => d.name === inputName);
  const category = boundDs
    ? resolveConnector(boundDs.properties.type).category
    : categoryOfCopyType(src.type);

  const patchSource = (patch: Record<string, unknown>) =>
    onPatch({ typeProperties: { ...tp, source: { ...src, ...patch } } });

  const onPickDataset = (name: string, ds: AdfDataset | undefined) => {
    const inputs = name
      ? [{ referenceName: name, type: 'DatasetReference', parameters: {} }]
      : [];
    const conn = resolveConnector(ds?.properties.type);
    const nextSource = { ...src, ...(conn.source ? { type: conn.source } : {}) };
    onPatch({ inputs, typeProperties: { ...tp, source: nextSource } });
  };

  // ── Additional columns ──────────────────────────────────────────────────
  const addl: AdditionalColumn[] = Array.isArray(src.additionalColumns) ? src.additionalColumns : [];
  const setAddl = (next: AdditionalColumn[]) =>
    patchSource({ additionalColumns: next.length ? next : undefined });

  return (
    <div className={s.section}>
      <DatasetPicker
        label="Source dataset"
        value={inputName || ''}
        onChange={onPickDataset}
        datasets={datasets}
        gateError={gateError}
        required
        hint="The dataset to read from. Selecting it binds inputs[0] and sets the source connector type."
      />
      {src.type && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Source type: <Badge appearance="outline" size="small">{src.type}</Badge>
        </Caption1>
      )}

      {/* ── File-based source settings ── */}
      {category === 'fileBased' && (
        <>
          <Field label="Recursive" hint="Read all sub-folders under the dataset path.">
            <Switch checked={!!src.recursive} onChange={(_, d) => patchSource({ recursive: d.checked })} />
          </Field>
          <Field label="Wildcard folder path" hint="Optional. e.g. data/2026/*">
            <Input value={src.wildcardFolderPath || ''}
              onChange={(_, d) => patchSource({ wildcardFolderPath: d.value || undefined })} />
          </Field>
          <Field label="Wildcard file name" hint="Optional. e.g. *.csv">
            <Input value={src.wildcardFileName || ''}
              onChange={(_, d) => patchSource({ wildcardFileName: d.value || undefined })} />
          </Field>
          <div style={{ display: 'flex', gap: 12 }}>
            <Field label="Modified after (UTC)" hint="Filter by last-modified start.">
              <Input value={src.modifiedDatetimeStart || ''} placeholder="2026-01-01T00:00:00Z"
                onChange={(_, d) => patchSource({ modifiedDatetimeStart: d.value || undefined })} />
            </Field>
            <Field label="Modified before (UTC)" hint="Filter by last-modified end.">
              <Input value={src.modifiedDatetimeEnd || ''} placeholder="2026-12-31T00:00:00Z"
                onChange={(_, d) => patchSource({ modifiedDatetimeEnd: d.value || undefined })} />
            </Field>
          </div>
        </>
      )}

      {/* ── SQL-based source settings ── */}
      {category === 'sqlBased' && (
        <>
          <Field label="Use query" hint="Read the whole table, or restrict with a SQL query / stored procedure.">
            <Select
              value={src.sqlReaderStoredProcedureName ? 'proc' : (src.sqlReaderQuery != null ? 'query' : 'table')}
              onChange={(_, d) => {
                if (d.value === 'table') patchSource({ sqlReaderQuery: undefined, sqlReaderStoredProcedureName: undefined });
                else if (d.value === 'query') patchSource({ sqlReaderQuery: src.sqlReaderQuery || '', sqlReaderStoredProcedureName: undefined });
                else patchSource({ sqlReaderStoredProcedureName: src.sqlReaderStoredProcedureName || '', sqlReaderQuery: undefined });
              }}>
              <option value="table">Table</option>
              <option value="query">Query</option>
              <option value="proc">Stored procedure</option>
            </Select>
          </Field>
          {src.sqlReaderQuery != null && (
            <ExpressionField
              label="Query"
              value={typeof src.sqlReaderQuery === 'string' ? src.sqlReaderQuery : ''}
              onChange={(v) => patchSource({ sqlReaderQuery: v })}
              multiline
              placeholder="SELECT * FROM dbo.Orders WHERE Modified > '@{pipeline().parameters.since}'"
              parameters={parameters} variables={variables} activities={allActivities}
              selfName={activity.name}
            />
          )}
          {src.sqlReaderStoredProcedureName != null && (
            <Field label="Stored procedure name">
              <Input value={src.sqlReaderStoredProcedureName || ''}
                onChange={(_, d) => patchSource({ sqlReaderStoredProcedureName: d.value })} />
            </Field>
          )}
          <div style={{ display: 'flex', gap: 12 }}>
            <Field label="Query timeout (HH:MM:SS)">
              <Input value={src.queryTimeout || ''} placeholder="02:00:00"
                onChange={(_, d) => patchSource({ queryTimeout: d.value || undefined })} />
            </Field>
            <Field label="Isolation level">
              <Select value={src.isolationLevel || ''}
                onChange={(_, d) => patchSource({ isolationLevel: d.value || undefined })}>
                <option value="">(default)</option>
                <option value="ReadCommitted">ReadCommitted</option>
                <option value="ReadUncommitted">ReadUncommitted</option>
                <option value="RepeatableRead">RepeatableRead</option>
                <option value="Serializable">Serializable</option>
                <option value="Snapshot">Snapshot</option>
              </Select>
            </Field>
          </div>
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
