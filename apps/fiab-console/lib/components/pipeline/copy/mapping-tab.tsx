'use client';

/**
 * MappingTab — Copy activity "Mapping" tab at ADF Studio parity.
 *
 * Real ADF Mapping-tab capabilities (grounded in
 * https://learn.microsoft.com/azure/data-factory/copy-activity-schema-and-type-mapping
 * and the Copy-activity `translator` schema, api-version 2018-06-01):
 *
 *   - "Import schemas" derives source + sink columns from the bound datasets'
 *     `properties.schema` (or legacy `structure`) — no extra network call, the
 *     datasets are already loaded by useCopyResources.
 *   - "Auto map" — one row per source column, sink named after the source
 *     (the explicit equivalent of ADF's default by-name mapping, but editable).
 *   - A grid mapping each source column → sink column, with the source/sink
 *     logical type and an inline include/exclude toggle, plus add / delete /
 *     reorder (move up / move down) rows. Source column + type are pickers
 *     driven from the imported source schema (free-type fallback when no
 *     schema is available); sink column + type likewise from the sink schema.
 *   - Collection reference (hierarchical sources): the JSON path of the nested
 *     array to cross-apply, and "map complex values to string" — these flip the
 *     source field from `name` to `path` (JSON-path) per the hierarchical model.
 *   - Type conversion settings: a toggle (`typeConversion`) and, when on, the
 *     full `typeConversionSettings` group — allow data truncation, treat boolean
 *     as number, and date / datetime / datetimeoffset / time / timespan format
 *     strings + culture.
 *   - "Clear" → null translator = ADF's default by-name (case-sensitive) mapping.
 *   - "Use positional mapping" → ordinal source columns (for header-less text).
 *
 * Persists to `typeProperties.translator` as a TabularTranslator:
 *   {
 *     type:'TabularTranslator',
 *     mappings:[{ source:{name|path|ordinal, type?}, sink:{name, type?} }, …],
 *     collectionReference?, mapComplexValuesToString?,
 *     typeConversion?, typeConversionSettings?:{ … }
 *   }
 * which round-trips on the pipeline PUT (real ARM REST via adf-client /
 * synapse-artifacts-client). No mocks, no freeform JSON (per
 * no-vaporware.md / loom-no-freeform-config / ui-parity.md).
 */

import { useMemo, useState } from 'react';
import {
  Field, Input, Caption1, Button, Subtitle2, Switch, Combobox, Option, Tooltip,
  MessageBar, MessageBarBody, Checkbox, Divider,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowImport20Regular, FlowchartRegular,
  ArrowUp16Regular, ArrowDown16Regular, BroomRegular, ArrowAutofitWidth20Regular,
  NumberSymbol20Regular,
} from '@fluentui/react-icons';
import { ExpressionField } from '../dynamic-content';
import type { PipelineActivity, PipelineParameter, PipelineVariable } from '../types';
import type { AdfDataset } from '@/lib/azure/adf-client';

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalS,
    alignItems: 'center',
  },
  headerRow: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
  },
  cell: {
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    verticalAlign: 'middle',
  },
  rowActions: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalXXS,
    alignItems: 'center',
  },
  combo: { minWidth: '0', width: '100%' },
  typeConvGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(0, 220px))',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
  },
  subPanel: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    marginLeft: tokens.spacingHorizontalM,
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke2}`,
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

/**
 * ADF logical types accepted in a TabularTranslator mapping (source/sink.type).
 * Grounded in the copy-activity schema/type-mapping doc's "interim data type".
 */
const LOGICAL_TYPES = [
  'String', 'Boolean', 'Int16', 'Int32', 'Int64',
  'Single', 'Double', 'Decimal', 'Byte[]',
  'Date', 'DateTime', 'DateTimeOffset', 'TimeSpan', 'Guid',
];

export interface MappingTabProps {
  activity: PipelineActivity;
  datasets: AdfDataset[];
  /** Dynamic-content context for the collection-reference expression field. */
  parameters?: PipelineParameter[];
  variables?: PipelineVariable[];
  allActivities?: PipelineActivity[];
  onPatch: (patch: Partial<PipelineActivity>) => void;
}

interface MappingRow {
  /** Whether this column is included in the copy. */
  included: boolean;
  /** Tabular source column name. */
  sourceCol: string;
  /** Hierarchical source JSON path ($.foo.bar). Mutually exclusive with ordinal. */
  sourcePath: string;
  /** Positional source ordinal (0-based) for header-less text. '' = not positional. */
  sourceOrdinal: string;
  /** Source logical type. */
  sourceType: string;
  /** Sink column name. */
  sinkCol: string;
  /** Sink logical type. */
  sinkType: string;
}

interface TypeConvSettings {
  allowDataTruncation?: boolean;
  treatBooleanAsNumber?: boolean;
  dateFormat?: string;
  dateTimeFormat?: string;
  dateTimeOffsetFormat?: string;
  timeFormat?: string;
  timeSpanFormat?: string;
  culture?: string;
}

function emptyRow(): MappingRow {
  return {
    included: true, sourceCol: '', sourcePath: '', sourceOrdinal: '',
    sourceType: '', sinkCol: '', sinkType: '',
  };
}

/** Read a dataset's column list from `schema` (preferred) or legacy `structure`. */
function columnsOf(ds: AdfDataset | undefined): Array<{ name: string; type?: string }> {
  if (!ds) return [];
  const props = ds.properties as { schema?: unknown[]; structure?: unknown[] };
  const raw = (props.schema && props.schema.length ? props.schema : props.structure) as
    | Array<{ name?: string; type?: string }>
    | undefined;
  return (raw || [])
    .filter((c) => c && typeof c.name === 'string')
    .map((c) => ({ name: c.name as string, type: c.type }));
}

/** TabularTranslator.mappings[] → editor rows. */
function rowsFromTranslator(translator: unknown): MappingRow[] {
  const t = (translator || {}) as { mappings?: unknown };
  const maps = Array.isArray(t.mappings) ? t.mappings : [];
  return maps.map((raw): MappingRow => {
    const m = (raw || {}) as { source?: any; sink?: any };
    const src = m.source || {};
    const sink = m.sink || {};
    return {
      included: true,
      sourceCol: typeof src.name === 'string' ? src.name : '',
      sourcePath: typeof src.path === 'string' ? src.path : '',
      sourceOrdinal: src.ordinal != null ? String(src.ordinal) : '',
      sourceType: typeof src.type === 'string' ? src.type : '',
      sinkCol: typeof sink.name === 'string' ? sink.name : '',
      sinkType: typeof sink.type === 'string' ? sink.type : '',
    };
  });
}

export function MappingTab({
  activity, datasets, parameters = [], variables = [], allActivities = [], onPatch,
}: MappingTabProps) {
  const s = useStyles();
  const tp = (activity.typeProperties || {}) as Record<string, any>;
  const translator = (tp.translator || {}) as Record<string, any>;

  const [rows, setRows] = useState<MappingRow[]>(() => rowsFromTranslator(translator));
  const [note, setNote] = useState<string | null>(null);
  const [showTypeConv, setShowTypeConv] = useState<boolean>(!!translator.typeConversion);

  const inputName = ((activity.inputs as any[]) || [])[0]?.referenceName as string | undefined;
  const outputName = ((activity.outputs as any[]) || [])[0]?.referenceName as string | undefined;
  const sourceDs = datasets.find((d) => d.name === inputName);
  const sinkDs = datasets.find((d) => d.name === outputName);

  const srcCols = useMemo(() => columnsOf(sourceDs), [sourceDs]);
  const sinkCols = useMemo(() => columnsOf(sinkDs), [sinkDs]);

  const collectionReference = typeof translator.collectionReference === 'string'
    ? translator.collectionReference : '';
  const mapComplexToString = !!translator.mapComplexValuesToString;
  const isPositional = rows.some((r) => r.sourceOrdinal !== '');
  const isHierarchical = !!collectionReference || rows.some((r) => r.sourcePath !== '');
  const tcs = (translator.typeConversionSettings || {}) as TypeConvSettings;

  /**
   * Assemble the TabularTranslator from the current rows + side settings and
   * write it onto `typeProperties.translator` (undefined when nothing to write
   * = ADF default by-name mapping). Extra keys (collectionReference, type
   * conversion) are layered on so a re-render preserves them.
   */
  const commit = (
    nextRows: MappingRow[],
    extra?: {
      collectionReference?: string;
      mapComplexValuesToString?: boolean;
      typeConversion?: boolean;
      typeConversionSettings?: TypeConvSettings;
    },
  ) => {
    setRows(nextRows);

    const collRef = extra?.collectionReference ?? collectionReference;
    const mapComplex = extra?.mapComplexValuesToString ?? mapComplexToString;
    const typeConv = extra?.typeConversion ?? !!translator.typeConversion;
    const convSettings = extra?.typeConversionSettings ?? tcs;

    const usable = nextRows.filter(
      (r) => r.included && (r.sourceCol || r.sourcePath || r.sourceOrdinal !== '' || r.sinkCol),
    );

    const mappings = usable.map((r) => {
      const source: Record<string, unknown> = {};
      if (r.sourceOrdinal !== '') source.ordinal = Number(r.sourceOrdinal);
      else if (r.sourcePath) source.path = r.sourcePath;
      else if (r.sourceCol) source.name = r.sourceCol;
      if (r.sourceType) source.type = r.sourceType;

      const sink: Record<string, unknown> = {};
      if (r.sinkCol) sink.name = r.sinkCol;
      else if (r.sourceCol) sink.name = r.sourceCol; // by-name default
      if (r.sinkType) sink.type = r.sinkType;

      return { source, sink };
    });

    // Build typeConversionSettings without empty keys.
    const cleanedConv: Record<string, unknown> = {};
    if (convSettings.allowDataTruncation != null) cleanedConv.allowDataTruncation = convSettings.allowDataTruncation;
    if (convSettings.treatBooleanAsNumber != null) cleanedConv.treatBooleanAsNumber = convSettings.treatBooleanAsNumber;
    if (convSettings.dateFormat) cleanedConv.dateFormat = convSettings.dateFormat;
    if (convSettings.dateTimeFormat) cleanedConv.dateTimeFormat = convSettings.dateTimeFormat;
    if (convSettings.dateTimeOffsetFormat) cleanedConv.dateTimeOffsetFormat = convSettings.dateTimeOffsetFormat;
    if (convSettings.timeFormat) cleanedConv.timeFormat = convSettings.timeFormat;
    if (convSettings.timeSpanFormat) cleanedConv.timeSpanFormat = convSettings.timeSpanFormat;
    if (convSettings.culture) cleanedConv.culture = convSettings.culture;

    const hasAny =
      mappings.length > 0 || !!collRef || typeConv || Object.keys(cleanedConv).length > 0;

    const nextTranslator = hasAny
      ? {
          type: 'TabularTranslator',
          ...(mappings.length ? { mappings } : {}),
          ...(collRef ? { collectionReference: collRef } : {}),
          ...(mapComplex ? { mapComplexValuesToString: true } : {}),
          ...(typeConv ? { typeConversion: true } : {}),
          ...(typeConv && Object.keys(cleanedConv).length
            ? { typeConversionSettings: cleanedConv }
            : {}),
        }
      : undefined;

    onPatch({ typeProperties: { ...tp, translator: nextTranslator } });
  };

  const setRow = (i: number, patch: Partial<MappingRow>) =>
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };

  // ── Import schemas: one row per source column, paired positionally to sink. ─
  const importSchemas = () => {
    if (srcCols.length === 0 && sinkCols.length === 0) {
      setNote(
        'Schema not available on the bound datasets. Import requires datasets with a defined schema — add mappings manually below, or define the dataset schema in the Manage hub.',
      );
      return;
    }
    const base = srcCols.length ? srcCols : sinkCols;
    const next: MappingRow[] = base.map((c, i) => ({
      ...emptyRow(),
      sourceCol: srcCols[i]?.name ?? c.name,
      sourceType: srcCols[i]?.type ?? c.type ?? '',
      sinkCol: sinkCols[i]?.name ?? srcCols[i]?.name ?? c.name,
      sinkType: sinkCols[i]?.type ?? '',
    }));
    setNote(
      `Imported ${next.length} column${next.length === 1 ? '' : 's'} (${srcCols.length} source, ${sinkCols.length} sink).`,
    );
    commit(next);
  };

  // ── Auto map: source columns → same-named sink columns (editable). ──────────
  const autoMap = () => {
    const base = srcCols.length ? srcCols : sinkCols;
    if (base.length === 0) {
      setNote('Auto map needs at least one schema. Import schemas first, or define the dataset schema in the Manage hub.');
      return;
    }
    const next: MappingRow[] = base.map((c) => ({
      ...emptyRow(),
      sourceCol: c.name,
      sourceType: c.type ?? '',
      sinkCol: c.name,
    }));
    setNote(`Auto-mapped ${next.length} column${next.length === 1 ? '' : 's'} by name.`);
    commit(next);
  };

  // ── Positional: convert current rows to ordinal source columns. ─────────────
  const usePositional = () => {
    const base = rows.length ? rows : srcCols.map((c) => ({ ...emptyRow(), sinkCol: c.name }));
    const next: MappingRow[] = base.map((r, i) => ({
      ...r,
      sourceCol: '',
      sourcePath: '',
      sourceOrdinal: String(i + 1),
    }));
    setNote('Positional mapping — source columns referenced by ordinal (for header-less text sources).');
    commit(next, { collectionReference: '' });
  };

  const clearMapping = () => {
    setNote(null);
    setShowTypeConv(false);
    commit([], {
      collectionReference: '',
      mapComplexValuesToString: false,
      typeConversion: false,
      typeConversionSettings: {},
    });
  };

  const setConv = (patch: Partial<TypeConvSettings>) =>
    commit(rows, { typeConversion: true, typeConversionSettings: { ...tcs, ...patch } });

  const hasSchemas = srcCols.length > 0 || sinkCols.length > 0;

  return (
    <div className={s.section}>
      <div className={s.headerRow}>
        <Caption1 className={s.muted}>
          By default ADF maps source → sink by matching column names (case-sensitive).
          Define explicit mappings below when names differ, to copy a subset, to
          override types, or to flatten a hierarchical source.
        </Caption1>
      </div>

      <div className={s.toolbar}>
        <Tooltip content="Pull source and sink columns from the bound datasets' schemas." relationship="label">
          <Button icon={<ArrowImport20Regular />} onClick={importSchemas} disabled={!sourceDs && !sinkDs}>
            Import schemas
          </Button>
        </Tooltip>
        <Tooltip content="Map every source column to a same-named sink column." relationship="label">
          <Button icon={<ArrowAutofitWidth20Regular />} onClick={autoMap} disabled={!hasSchemas}>
            Auto map
          </Button>
        </Tooltip>
        <Tooltip content="Reference source columns by position (for header-less text files)." relationship="label">
          <Button appearance="subtle" icon={<NumberSymbol20Regular />} onClick={usePositional}
            disabled={rows.length === 0 && srcCols.length === 0}>
            Use positional
          </Button>
        </Tooltip>
        <Tooltip content="Remove all explicit mappings — fall back to ADF's default by-name mapping." relationship="label">
          <Button appearance="subtle" icon={<BroomRegular />} onClick={clearMapping}
            disabled={rows.length === 0 && !collectionReference && !translator.typeConversion}>
            Clear mapping
          </Button>
        </Tooltip>
      </div>

      {note && (
        <MessageBar intent={rows.length || note.startsWith('Imported') || note.startsWith('Auto') || note.startsWith('Positional') ? 'info' : 'warning'}>
          <MessageBarBody>{note}</MessageBarBody>
        </MessageBar>
      )}

      {!sourceDs && !sinkDs && (
        <Caption1 className={s.muted}>
          Bind a source and sink dataset on the Source / Sink tabs to import schemas.
        </Caption1>
      )}

      {/* ── Column mappings grid ── */}
      <Subtitle2>Column mappings</Subtitle2>
      <Table size="small" aria-label="Column mappings">
        <TableHeader>
          <TableRow>
            <TableHeaderCell style={{ width: '40px' }}>Include</TableHeaderCell>
            <TableHeaderCell>{isPositional ? 'Source ordinal' : isHierarchical ? 'Source path' : 'Source column'}</TableHeaderCell>
            <TableHeaderCell style={{ width: '130px' }}>Source type</TableHeaderCell>
            <TableHeaderCell>Sink column</TableHeaderCell>
            <TableHeaderCell style={{ width: '130px' }}>Sink type</TableHeaderCell>
            <TableHeaderCell style={{ width: '96px' }} aria-label="Row actions" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6}>
                <Caption1 className={s.muted}>
                  No explicit mappings — ADF maps by column name. Import schemas, Auto map, or add a row.
                </Caption1>
              </TableCell>
            </TableRow>
          )}
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className={s.cell}>
                <Checkbox checked={r.included}
                  onChange={(_, d) => setRow(i, { included: !!d.checked })}
                  aria-label="Include column" />
              </TableCell>

              {/* Source column / path / ordinal */}
              <TableCell className={s.cell}>
                {r.sourceOrdinal !== '' ? (
                  <Input type="number" value={r.sourceOrdinal} className={s.combo}
                    contentBefore={<Caption1 className={s.muted}>#</Caption1>}
                    onChange={(_, d) => setRow(i, { sourceOrdinal: d.value })} />
                ) : isHierarchical ? (
                  <Input value={r.sourcePath} placeholder="$.order.id" className={s.combo}
                    onChange={(_, d) => setRow(i, { sourcePath: d.value })} />
                ) : (
                  <Combobox
                    className={s.combo}
                    freeform
                    placeholder="OrderID"
                    value={r.sourceCol}
                    selectedOptions={r.sourceCol ? [r.sourceCol] : []}
                    onOptionSelect={(_, d) => {
                      const name = d.optionValue || '';
                      const col = srcCols.find((c) => c.name === name);
                      setRow(i, { sourceCol: name, sourceType: r.sourceType || col?.type || '' });
                    }}
                    onChange={(e) => setRow(i, { sourceCol: (e.target as HTMLInputElement).value })}
                  >
                    {srcCols.map((c) => (
                      <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>
                    ))}
                  </Combobox>
                )}
              </TableCell>

              {/* Source type */}
              <TableCell className={s.cell}>
                <Combobox className={s.combo} freeform placeholder="String"
                  value={r.sourceType}
                  selectedOptions={r.sourceType ? [r.sourceType] : []}
                  onOptionSelect={(_, d) => setRow(i, { sourceType: d.optionValue || '' })}
                  onChange={(e) => setRow(i, { sourceType: (e.target as HTMLInputElement).value })}>
                  {LOGICAL_TYPES.map((t) => (
                    <Option key={t} value={t} text={t}>{t}</Option>
                  ))}
                </Combobox>
              </TableCell>

              {/* Sink column */}
              <TableCell className={s.cell}>
                <Combobox className={s.combo} freeform placeholder="order_id"
                  value={r.sinkCol}
                  selectedOptions={r.sinkCol ? [r.sinkCol] : []}
                  onOptionSelect={(_, d) => {
                    const name = d.optionValue || '';
                    const col = sinkCols.find((c) => c.name === name);
                    setRow(i, { sinkCol: name, sinkType: r.sinkType || col?.type || '' });
                  }}
                  onChange={(e) => setRow(i, { sinkCol: (e.target as HTMLInputElement).value })}>
                  {sinkCols.map((c) => (
                    <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>
                  ))}
                </Combobox>
              </TableCell>

              {/* Sink type */}
              <TableCell className={s.cell}>
                <Combobox className={s.combo} freeform placeholder="String"
                  value={r.sinkType}
                  selectedOptions={r.sinkType ? [r.sinkType] : []}
                  onOptionSelect={(_, d) => setRow(i, { sinkType: d.optionValue || '' })}
                  onChange={(e) => setRow(i, { sinkType: (e.target as HTMLInputElement).value })}>
                  {LOGICAL_TYPES.map((t) => (
                    <Option key={t} value={t} text={t}>{t}</Option>
                  ))}
                </Combobox>
              </TableCell>

              {/* Row actions */}
              <TableCell className={s.cell}>
                <div className={s.rowActions}>
                  <Tooltip content="Move up" relationship="label">
                    <Button appearance="subtle" size="small" icon={<ArrowUp16Regular />}
                      disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" />
                  </Tooltip>
                  <Tooltip content="Move down" relationship="label">
                    <Button appearance="subtle" size="small" icon={<ArrowDown16Regular />}
                      disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down" />
                  </Tooltip>
                  <Tooltip content="Remove row" relationship="label">
                    <Button appearance="subtle" size="small" icon={<Delete20Regular />}
                      onClick={() => commit(rows.filter((_, j) => j !== i))} aria-label="Remove row" />
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div>
        <Button size="small" icon={<Add20Regular />} onClick={() => commit([...rows, emptyRow()])}>
          Add mapping
        </Button>
      </div>

      <Divider />

      {/* ── Hierarchical source: collection reference ── */}
      <Subtitle2>
        <FlowchartRegular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />
        Hierarchical source
      </Subtitle2>
      <Caption1 className={s.muted}>
        For hierarchical sources (JSON, MongoDB, Cosmos DB), set the JSON path of a
        nested array to cross-apply — each array element becomes its own row. When set,
        source fields are addressed by JSON path instead of column name.
      </Caption1>
      <ExpressionField
        label="Collection reference"
        hint="JSON path of the nested array to iterate, e.g. $['orders']. Leave blank for flat tabular sources."
        value={collectionReference}
        onChange={(v) => commit(rows, { collectionReference: v })}
        placeholder="$['orders']"
        parameters={parameters} variables={variables} activities={allActivities}
        selfName={activity.name}
      />
      <Field label="Map complex values to string"
        hint="Serialize array / object values to JSON strings instead of failing on them.">
        <Switch checked={mapComplexToString}
          onChange={(_, d) => commit(rows, { mapComplexValuesToString: d.checked })} />
      </Field>

      <Divider />

      {/* ── Type conversion settings ── */}
      <Subtitle2>Type conversion settings</Subtitle2>
      <Caption1 className={s.muted}>
        Enable advanced type conversion to control how values are parsed/formatted
        when source and sink logical types differ.
      </Caption1>
      <Field label="Enable type conversion">
        <Switch checked={showTypeConv}
          onChange={(_, d) => {
            setShowTypeConv(d.checked);
            commit(rows, {
              typeConversion: d.checked,
              typeConversionSettings: d.checked ? tcs : {},
            });
          }} />
      </Field>

      {showTypeConv && (
        <div className={s.subPanel}>
          <Field label="Allow data truncation"
            hint="Allow lossy conversions (e.g. decimal → integer, DateTimeOffset → DateTime).">
            <Switch checked={tcs.allowDataTruncation ?? false}
              onChange={(_, d) => setConv({ allowDataTruncation: d.checked })} />
          </Field>
          <Field label="Treat boolean as number" hint="Convert true/false to 1/0.">
            <Switch checked={tcs.treatBooleanAsNumber ?? false}
              onChange={(_, d) => setConv({ treatBooleanAsNumber: d.checked })} />
          </Field>

          <div className={s.typeConvGrid}>
            <Field label="Date format" hint='e.g. yyyy-MM-dd'>
              <Input value={tcs.dateFormat || ''} placeholder="yyyy-MM-dd"
                onChange={(_, d) => setConv({ dateFormat: d.value || undefined })} />
            </Field>
            <Field label="DateTime format" hint='e.g. yyyy-MM-dd HH:mm:ss.fff'>
              <Input value={tcs.dateTimeFormat || ''} placeholder="yyyy-MM-dd HH:mm:ss.fff"
                onChange={(_, d) => setConv({ dateTimeFormat: d.value || undefined })} />
            </Field>
            <Field label="DateTimeOffset format" hint='e.g. yyyy-MM-dd HH:mm:ss.fff zzz'>
              <Input value={tcs.dateTimeOffsetFormat || ''} placeholder="yyyy-MM-dd HH:mm:ss.fff zzz"
                onChange={(_, d) => setConv({ dateTimeOffsetFormat: d.value || undefined })} />
            </Field>
            <Field label="Time format" hint='e.g. HH:mm:ss'>
              <Input value={tcs.timeFormat || ''} placeholder="HH:mm:ss"
                onChange={(_, d) => setConv({ timeFormat: d.value || undefined })} />
            </Field>
            <Field label="TimeSpan format" hint='e.g. dd.hh:mm:ss'>
              <Input value={tcs.timeSpanFormat || ''} placeholder="dd.hh:mm:ss"
                onChange={(_, d) => setConv({ timeSpanFormat: d.value || undefined })} />
            </Field>
            <Field label="Culture" hint='e.g. en-us, fr-fr'>
              <Input value={tcs.culture || ''} placeholder="en-us"
                onChange={(_, d) => setConv({ culture: d.value || undefined })} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}
