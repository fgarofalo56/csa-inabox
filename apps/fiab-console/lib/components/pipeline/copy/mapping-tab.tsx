'use client';

/**
 * MappingTab — Copy activity "Mapping" tab at ADF Studio parity.
 *
 * Real ADF Mapping-tab capabilities (grounded in
 * https://learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping):
 *   - "Import schemas" derives source/sink columns from the bound datasets'
 *     `properties.schema` (or legacy `structure`) — no extra network call, the
 *     datasets are already loaded by useCopyResources.
 *   - A grid mapping source column → sink column (+ optional type) with add /
 *     delete rows.
 *   - "Clear" → null translator = ADF's default by-name (case-sensitive) mapping.
 *
 * Persists to `typeProperties.translator` as a TabularTranslator:
 *   { type:'TabularTranslator', mappings:[{ source:{name}, sink:{name} }, …] }
 */

import { useState } from 'react';
import {
  Field, Input, Caption1, Button, Subtitle2, MessageBar, MessageBarBody,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, ArrowImport20Regular } from '@fluentui/react-icons';
import type { PipelineActivity } from '../types';
import type { AdfDataset } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  cell: { padding: '2px 4px' },
});

export interface MappingTabProps {
  activity: PipelineActivity;
  datasets: AdfDataset[];
  onPatch: (patch: Partial<PipelineActivity>) => void;
}

interface MappingRow { sourceCol: string; sinkCol: string; type?: string }

/** Read a dataset's column list from `schema` (preferred) or legacy `structure`. */
function columnsOf(ds: AdfDataset | undefined): Array<{ name: string; type?: string }> {
  if (!ds) return [];
  const raw = (ds.properties.schema && ds.properties.schema.length ? ds.properties.schema
    : ds.properties.structure) as Array<{ name?: string; type?: string }> | undefined;
  return (raw || [])
    .filter((c) => c && typeof c.name === 'string')
    .map((c) => ({ name: c.name as string, type: c.type }));
}

/** TabularTranslator.mappings[] → editor rows. */
function rowsFromTranslator(translator: any): MappingRow[] {
  const maps = Array.isArray(translator?.mappings) ? translator.mappings : [];
  return maps.map((m: any) => ({
    sourceCol: m?.source?.name ?? '',
    sinkCol: m?.sink?.name ?? '',
    type: m?.source?.type ?? m?.sink?.type ?? undefined,
  }));
}

export function MappingTab({ activity, datasets, onPatch }: MappingTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as any;
  const [rows, setRows] = useState<MappingRow[]>(() => rowsFromTranslator(tp.translator));
  const [note, setNote] = useState<string | null>(null);

  const inputName = ((activity.inputs as any[]) || [])[0]?.referenceName as string | undefined;
  const outputName = ((activity.outputs as any[]) || [])[0]?.referenceName as string | undefined;
  const sourceDs = datasets.find((d) => d.name === inputName);
  const sinkDs = datasets.find((d) => d.name === outputName);

  /** Write rows → typeProperties.translator (null when empty = default mapping). */
  const commit = (next: MappingRow[]) => {
    setRows(next);
    const clean = next.filter((r) => r.sourceCol || r.sinkCol);
    const translator = clean.length
      ? {
          type: 'TabularTranslator',
          mappings: clean.map((r) => ({
            source: { name: r.sourceCol, ...(r.type ? { type: r.type } : {}) },
            sink: { name: r.sinkCol || r.sourceCol },
          })),
        }
      : undefined;
    onPatch({ typeProperties: { ...tp, translator } });
  };

  const importSchemas = () => {
    const srcCols = columnsOf(sourceDs);
    const sinkCols = columnsOf(sinkDs);
    if (srcCols.length === 0 && sinkCols.length === 0) {
      setNote('Schema not available on the bound datasets. Import is only possible for datasets with a defined schema — add mappings manually below, or define the dataset schema in the Manage hub.');
      return;
    }
    const base = srcCols.length ? srcCols : sinkCols;
    const next: MappingRow[] = base.map((c, i) => ({
      sourceCol: srcCols[i]?.name ?? c.name,
      sinkCol: sinkCols[i]?.name ?? c.name,
      type: c.type,
    }));
    setNote(`Imported ${next.length} column${next.length === 1 ? '' : 's'} from ${srcCols.length ? 'source' : 'sink'} schema.`);
    commit(next);
  };

  return (
    <div className={s.section}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        By default ADF maps source → sink by matching column names (case-sensitive).
        Use explicit mappings below only when names differ or types need overriding.
      </Caption1>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button icon={<ArrowImport20Regular />} onClick={importSchemas}
          disabled={!sourceDs && !sinkDs}>
          Import schemas
        </Button>
        <Button appearance="subtle" onClick={() => { setNote(null); commit([]); }}
          disabled={rows.length === 0}>
          Clear (use default mapping)
        </Button>
      </div>

      {note && (
        <MessageBar intent={rows.length || note.startsWith('Imported') ? 'info' : 'warning'}>
          <MessageBarBody>{note}</MessageBarBody>
        </MessageBar>
      )}

      {(!sourceDs && !sinkDs) && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Bind a source and sink dataset on the Source / Sink tabs to import schemas.
        </Caption1>
      )}

      <Subtitle2>Column mappings</Subtitle2>
      <Table size="small">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Source column</TableHeaderCell>
            <TableHeaderCell>Sink column</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell style={{ width: 44 }} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4}>
                <Caption1>No explicit mappings — ADF maps by column name. Add a row or import schemas.</Caption1>
              </TableCell>
            </TableRow>
          )}
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className={s.cell}>
                <Input value={r.sourceCol} placeholder="OrderID"
                  onChange={(_, d) => commit(rows.map((x, j) => j === i ? { ...x, sourceCol: d.value } : x))} />
              </TableCell>
              <TableCell className={s.cell}>
                <Input value={r.sinkCol} placeholder="order_id"
                  onChange={(_, d) => commit(rows.map((x, j) => j === i ? { ...x, sinkCol: d.value } : x))} />
              </TableCell>
              <TableCell className={s.cell}>
                <Input value={r.type || ''} placeholder="String"
                  onChange={(_, d) => commit(rows.map((x, j) => j === i ? { ...x, type: d.value || undefined } : x))} />
              </TableCell>
              <TableCell className={s.cell}>
                <Button appearance="subtle" icon={<Delete20Regular />}
                  onClick={() => commit(rows.filter((_, j) => j !== i))} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Button size="small" icon={<Add20Regular />}
        onClick={() => commit([...rows, { sourceCol: '', sinkCol: '' }])}>
        Add mapping
      </Button>
    </div>
  );
}
