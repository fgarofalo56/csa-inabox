/**
 * dataflow-transform-catalog — the data-driven inventory of Azure Data Factory /
 * Synapse SPARK-based MAPPING DATA FLOW transformations and their full config
 * metadata.
 *
 * WHY THIS EXISTS
 * ---------------
 * A mapping data flow is a visually-designed, Spark-executed transformation
 * graph published as a `Microsoft.DataFactory/factories/dataflows` resource
 * (api 2018-06-01) whose `properties.type === 'MappingDataFlow'` and whose
 * `properties.typeProperties` carries:
 *
 *   - `sources`     : { name, dataset? | linkedService?, … }[]   (Source transforms)
 *   - `sinks`       : { name, dataset? | linkedService?, … }[]   (Sink transforms)
 *   - `transformations`: { name }[]                              (every other node)
 *   - `script`      : the Data Flow Script (DFS) — the line-per-transform DSL
 *                     (`source(...) ~> source1`, `source1 derive(...) ~> d1`, …)
 *                     that is the real source of truth Spark executes.
 *
 * This round-trips via the real ARM REST in `lib/azure/adf-client.ts`
 * (`getDataFlow` / `upsertDataFlow` / `listDataFlows` / `deleteDataFlow`) and the
 * Synapse-dev equivalent in `lib/azure/synapse-dev-client.ts` (dataflows live on
 * the workspace dev plane). No mocks (per no-vaporware.md).
 *
 * The Loom mapping-data-flow editor renders STRUCTURED FORMS from this catalog —
 * never a freeform JSON textarea (per loom-no-freeform-config). Each transform's
 * `settings` describe exactly which fields to collect; the editor assembles the
 * transform node + emits the DFS line and POSTs the assembled data-flow
 * `properties` to the BFF route, which calls the real `upsertDataFlow`.
 *
 * The React Flow canvas + node + edge primitives already built for the pipeline
 * (`lib/components/pipeline/canvas.tsx`, `flow-activity-node.tsx`,
 * `loom-bezier-edge.tsx`) render the transform graph; `DatasetPicker`
 * (`lib/components/pipeline/dataset-wizard.tsx`) supplies the source/sink dataset
 * for `needsDataset` transforms; `ExpressionField`
 * (`lib/components/pipeline/expression-field.tsx`) edits any
 * `supportsDynamic` (ADF pipeline `@{…}`) field. Data-flow-expression fields
 * (`dataFlowExpression: true`) use the DATA FLOW expression language (the Spark
 * column-level DSL — `upper(col)`, `iif(...)`, `sum(...)`), a different language
 * from pipeline `@{…}` expressions; the editor opens the data-flow expression
 * builder for those.
 *
 * DEBUG / DATA PREVIEW — HONEST GATE
 * ----------------------------------
 * Per-transform "Data preview" and "Import schema" require a LIVE Spark debug
 * cluster (an interactive data-flow debug session, started via the data-plane
 * debug API on an Azure Integration Runtime). The management ARM REST cannot
 * fabricate row previews. So the editor renders Data preview as an honest Fluent
 * MessageBar gate (start a debug session / no debug cluster running) — never a
 * faked preview (per no-vaporware.md). `DATAFLOW_SETTINGS.debug` captures the
 * compute size / TTL the debug session needs.
 *
 * GROUNDING (Microsoft Learn — mapping data flow)
 * -----------------------------------------------
 *   - transformation overview (full list + categories):
 *       https://learn.microsoft.com/azure/data-factory/data-flow-transformation-overview
 *   - per-transform pages (data-flow-source, -sink, -select, -filter,
 *       -derived-column, -aggregate, -join, -lookup, -conditional-split, -union,
 *       -exists, -pivot, -unpivot, -window, -sort, -surrogate-key, -rank,
 *       -flatten, -parse, -stringify, -alter-row, -cast, -external-call,
 *       -new-branch, -assert)
 *   - data flow script (DFS) reference:
 *       https://learn.microsoft.com/azure/data-factory/data-flow-script
 *   - data-flow expression language:
 *       https://learn.microsoft.com/azure/data-factory/data-transformation-functions
 *
 * Every `key` / `scriptToken` here is the EXACT data-flow-script property name
 * from those pages so the assembled DFS validates against the real Spark engine.
 */

import type { ConfigField } from './connector-catalog';

// =============================================================================
// Shared contract (imported by the mapping-data-flow editor).
// =============================================================================

/**
 * A transform setting. Extends the connector-catalog `ConfigField` (same form
 * renderer) with one mapping-data-flow-specific marker:
 *
 *   - `dataFlowExpression` — the value is a DATA FLOW expression (the Spark
 *     column-level DSL, e.g. `upper(title)`, `toInteger(Rating)`, `year < 1960`),
 *     NOT a pipeline `@{…}` expression. The editor opens the data-flow
 *     expression builder for these. This is distinct from `ConfigField.
 *     supportsDynamic`, which marks a pipeline-expression field.
 */
export type TransformField = ConfigField & {
  /** Value is a data-flow (Spark column) expression — open the DF expression builder. */
  dataFlowExpression?: boolean;
};

/**
 * The transform categories exactly as Microsoft Learn groups them in the
 * "transformation overview" table. `Source & sink` is the doc's "-" (source/sink)
 * grouping surfaced as a named category for the palette.
 */
export type TransformCategory =
  | 'Source & sink'
  | 'Schema modifier'
  | 'Row modifier'
  | 'Multiple inputs/outputs'
  | 'Formatters';

/** Input/output cardinality of a transform node on the canvas. */
export interface TransformPorts {
  /** Number of input streams. `'n'` = variable (Union takes 2+, New branch reads 1). */
  inputs: number | 'n';
  /** Number of output streams. `'n'` = variable (Conditional split fans out to N+default). */
  outputs: number | 'n';
}

export interface TransformDef {
  /**
   * The data-flow-script transform token — the function name in the DFS line
   * (e.g. 'source','sink','select','filter','derive','aggregate','join',
   * 'lookup','split','union','exists','pivot','unpivot','window','sort',
   * 'keyGenerate','rank','foldDown','parse','stringify','alterRow','cast',
   * 'call','newBranch','assert'). This is what the editor emits into `script`.
   */
  type: string;
  /** Palette / node display name, e.g. 'Derived column', 'Conditional split'. */
  displayName: string;
  category: TransformCategory;
  /** A Fluent icon name (best-effort; the editor maps it to a `@fluentui/react-icons` glyph). */
  icon?: string;
  description: string;
  /** Structured settings the editor collects to assemble the transform + DFS line. */
  settings: TransformField[];
  /** Canvas input/output stream cardinality. */
  ports: TransformPorts;
  /**
   * Whether the transform binds a dataset / linked service (Source & Sink — and
   * External call's inline source). The editor shows `<DatasetPicker/>` for these.
   */
  needsDataset?: boolean;
  /** Requires a live Spark debug cluster for its preview/import-schema affordance. */
  needsDebugCluster?: boolean;
  /** Marked Preview in the real Studio palette. */
  preview?: boolean;
}

// =============================================================================
// Reusable field fragments (kept DRY; every key/option is verbatim from the
// per-transform "Data flow script" sections on Microsoft Learn).
// =============================================================================

/** Output (stream) name — every transform names its output stream in the DFS (`~> name`). */
const OUTPUT_STREAM_NAME: TransformField = {
  key: 'outputStreamName',
  label: 'Output stream name',
  kind: 'text',
  required: true,
  placeholder: 'e.g. source1, derive1, JoinMatchedData',
  hint: 'The name of this transformation’s output stream (the `~> name` in the data flow script).',
};

/** Schema-drift toggles shared by Source & Sink. */
const ALLOW_SCHEMA_DRIFT: TransformField = {
  key: 'allowSchemaDrift',
  label: 'Allow schema drift',
  kind: 'boolean',
  hint: 'Let columns not in the defined projection flow through (DFS: allowSchemaDrift).',
};
const VALIDATE_SCHEMA: TransformField = {
  key: 'validateSchema',
  label: 'Validate schema',
  kind: 'boolean',
  hint: 'Fail the run if incoming data does not match the projection (DFS: validateSchema).',
};
const INFER_DRIFTED_TYPES: TransformField = {
  key: 'inferDriftedColumnTypes',
  label: 'Infer drifted column types',
  kind: 'boolean',
  showIf: { key: 'allowSchemaDrift', equals: 'true' },
  hint: 'Auto-type newly drifted columns instead of treating them all as string.',
};

/** Source/Sink "type" selector — an existing dataset object, or an inline (Spark) dataset. */
const STORE_KIND: TransformField = {
  key: 'storeKind',
  label: 'Source type',
  kind: 'select',
  required: true,
  options: [
    { value: 'dataset', label: 'Dataset object (reusable)' },
    { value: 'inline', label: 'Inline dataset (Spark-native)' },
    { value: 'workspaceDb', label: 'Workspace DB (Synapse workspaces only)' },
  ],
  hint: 'Dataset = reusable entity; Inline = format + linked service defined in the data flow.',
};

/** The dataset reference (shown when storeKind === dataset). Picked via <DatasetPicker/>. */
const DATASET_REF: TransformField = {
  key: 'dataset',
  label: 'Dataset',
  kind: 'text',
  showIf: { key: 'storeKind', equals: 'dataset' },
  hint: 'Pick or create the dataset object (DatasetReference). Uses the dataset wizard.',
};

/** Inline-dataset format + linked service (shown when storeKind === inline). */
const INLINE_FORMAT: TransformField = {
  key: 'format',
  label: 'Inline format',
  kind: 'select',
  showIf: { key: 'storeKind', equals: 'inline' },
  options: [
    { value: 'delimited', label: 'Delimited text (CSV)' },
    { value: 'parquet', label: 'Parquet' },
    { value: 'delta', label: 'Delta' },
    { value: 'json', label: 'JSON' },
    { value: 'avro', label: 'Avro' },
    { value: 'orc', label: 'ORC' },
    { value: 'excel', label: 'Excel' },
    { value: 'xml', label: 'XML' },
    { value: 'cosmos', label: 'Azure Cosmos DB' },
    { value: 'azuresql', label: 'Azure SQL' },
    { value: 'synapse', label: 'Azure Synapse Analytics' },
    { value: 'adx', label: 'Azure Data Explorer' },
    { value: 'rest', label: 'REST' },
    { value: 'cache', label: 'Cache (Spark cache sink)' },
  ],
  hint: 'Inline dataset format (DFS: format). The store comes from the linked service below.',
};
const INLINE_LINKED_SERVICE: TransformField = {
  key: 'linkedService',
  label: 'Linked service',
  kind: 'text',
  showIf: { key: 'storeKind', equals: 'inline' },
  hint: 'The connection the inline dataset reads/writes through (LinkedServiceReference).',
};

/** Join/Lookup/Exists broadcast optimization. */
const BROADCAST: TransformField = {
  key: 'broadcast',
  label: 'Broadcast',
  kind: 'select',
  options: [
    { value: 'auto', label: 'Auto (Spark decides)' },
    { value: 'left', label: 'Fixed — left' },
    { value: 'right', label: 'Fixed — right' },
    { value: 'both', label: 'Fixed — both' },
    { value: 'off', label: 'Off' },
  ],
  hint: 'Map-side broadcast hint (DFS: broadcast). Required Fixed for non-equi conditions.',
};

// =============================================================================
// TRANSFORMS — every mapping-data-flow transformation, full config metadata.
// Ordered roughly by the palette / overview table.
// =============================================================================

export const TRANSFORMS: TransformDef[] = [
  // ---------------------------------------------------------------------------
  // Source & sink
  // ---------------------------------------------------------------------------
  {
    type: 'source',
    displayName: 'Source',
    category: 'Source & sink',
    icon: 'DatabaseArrowDown',
    description:
      'A data source for the data flow. Every data flow needs at least one source. Bind a dataset object or an inline (Spark) dataset, set schema/sampling options, and define the projection.',
    needsDataset: true,
    needsDebugCluster: true,
    ports: { inputs: 0, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      STORE_KIND,
      DATASET_REF,
      INLINE_FORMAT,
      INLINE_LINKED_SERVICE,
      ALLOW_SCHEMA_DRIFT,
      INFER_DRIFTED_TYPES,
      VALIDATE_SCHEMA,
      {
        key: 'ignoreNoFilesFound',
        label: 'Ignore no files found',
        kind: 'boolean',
        hint: 'Do not fail when the source path matches no files (DFS: ignoreNoFilesFound).',
      },
      {
        key: 'skipLineCount',
        label: 'Skip line count',
        kind: 'number',
        hint: 'Number of lines to ignore at the start of the dataset (DFS: skipLines).',
      },
      // Sampling (Source settings tab)
      {
        key: 'enableSampling',
        label: 'Enable sampling',
        kind: 'boolean',
        hint: 'Limit rows read from the source (debugging). Overridden by debug-settings row limit in preview.',
      },
      {
        key: 'sampleRowLimit',
        label: 'Sample row limit',
        kind: 'number',
        showIf: { key: 'enableSampling', equals: 'true' },
        placeholder: '1000',
      },
      // Schema options (inline / Projection tab)
      {
        key: 'useProjectedSchema',
        label: 'Use projected schema',
        kind: 'boolean',
        showIf: { key: 'storeKind', equals: 'inline' },
        hint: 'Skip per-file schema auto-discovery and apply the stored projection (faster).',
      },
      // Source partitioning (Optimize tab)
      {
        key: 'partitionType',
        label: 'Source partitioning',
        kind: 'select',
        options: [
          { value: 'current', label: 'Use current partitioning' },
          { value: 'single', label: 'Single partition' },
          { value: 'roundRobin', label: 'Round robin' },
          { value: 'hash', label: 'Hash' },
          { value: 'dynamicRange', label: 'Dynamic range' },
          { value: 'fixedRange', label: 'Fixed range' },
          { value: 'key', label: 'Key' },
        ],
        hint: 'Optimize tab. SQL sources read fastest with custom Source partitioning.',
      },
      {
        key: 'isolationLevel',
        label: 'Isolation level',
        kind: 'select',
        options: [
          { value: 'READ_COMMITTED', label: 'Read committed' },
          { value: 'READ_UNCOMMITTED', label: 'Read uncommitted' },
          { value: 'REPEATABLE_READ', label: 'Repeatable read' },
          { value: 'SERIALIZABLE', label: 'Serializable' },
          { value: 'NONE', label: 'None' },
        ],
        hint: 'Source options — for SQL stores that support it.',
      },
    ],
  },
  {
    type: 'sink',
    displayName: 'Sink',
    category: 'Source & sink',
    icon: 'DatabaseArrowUp',
    description:
      'A final destination for your data. Bind a dataset/inline store (or a Spark cache sink), set update method, field mapping, sink ordering and error-row handling.',
    needsDataset: true,
    needsDebugCluster: true,
    ports: { inputs: 1, outputs: 0 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'sinkKind',
        label: 'Sink type',
        kind: 'select',
        required: true,
        options: [
          { value: 'dataset', label: 'Dataset object (reusable)' },
          { value: 'inline', label: 'Inline dataset (Spark-native)' },
          { value: 'cache', label: 'Cache (Spark cache sink)' },
          { value: 'workspaceDb', label: 'Workspace DB (Synapse workspaces only)' },
        ],
      },
      { ...DATASET_REF, showIf: { key: 'sinkKind', equals: 'dataset' } },
      { ...INLINE_FORMAT, showIf: { key: 'sinkKind', equals: 'inline' } },
      { ...INLINE_LINKED_SERVICE, showIf: { key: 'sinkKind', equals: 'inline' } },
      ALLOW_SCHEMA_DRIFT,
      VALIDATE_SCHEMA,
      // Update method (database sinks). DFS booleans: insertable/updateable/upsertable/deletable.
      {
        key: 'insertable',
        label: 'Allow insert',
        kind: 'boolean',
        hint: 'Update method — insert (default). DFS: insertable.',
      },
      {
        key: 'updateable',
        label: 'Allow update',
        kind: 'boolean',
        hint: 'Requires an upstream Alter row + key columns. DFS: updateable.',
      },
      {
        key: 'upsertable',
        label: 'Allow upsert',
        kind: 'boolean',
        hint: 'Requires an upstream Alter row + key columns. DFS: upsertable.',
      },
      {
        key: 'deletable',
        label: 'Allow delete',
        kind: 'boolean',
        hint: 'Requires an upstream Alter row + key columns. DFS: deletable.',
      },
      {
        key: 'keys',
        label: 'Key columns',
        kind: 'text',
        showIf: { key: 'updateable', equals: 'true' },
        hint: 'Comma-separated key columns to match on for update/upsert/delete (DFS: keys:[...]).',
      },
      {
        key: 'skipKeyColumnWrites',
        label: 'Skip writing key columns',
        kind: 'boolean',
        hint: 'For identity/distribution columns on upsert (DFS: skipKeyColumnsOnUpdate).',
      },
      // Mapping (auto vs manual / rule-based) — same model as Select.
      {
        key: 'autoMapping',
        label: 'Auto mapping',
        kind: 'boolean',
        hint: 'Map all input (incl. drifted) columns by name. Turn off for fixed / rule-based mapping.',
      },
      // Cache-sink specifics.
      {
        key: 'cacheKeyColumns',
        label: 'Cache key columns',
        kind: 'text',
        showIf: { key: 'sinkKind', equals: 'cache' },
        hint: 'Match columns for cacheName#lookup(). Comma-separated. DFS: keys on a cache sink.',
      },
      {
        key: 'writeToActivityOutput',
        label: 'Write to activity output',
        kind: 'boolean',
        showIf: { key: 'sinkKind', equals: 'cache' },
        hint: 'Emit the cache as the Data Flow activity output (<=2MB). DFS: output:true.',
      },
      // Sink ordering (General tab) + pre/post SQL.
      {
        key: 'saveOrder',
        label: 'Sink ordering',
        kind: 'number',
        hint: 'Sequential write order when Custom sink ordering is on (DFS: saveOrder).',
      },
      {
        key: 'preSql',
        label: 'Pre-processing SQL scripts',
        kind: 'multiline',
        hint: 'Runs before the sink writes (e.g. SET IDENTITY_INSERT tbl ON).',
      },
      {
        key: 'postSql',
        label: 'Post-processing SQL scripts',
        kind: 'multiline',
        hint: 'Runs after the sink writes (e.g. SET IDENTITY_INSERT tbl OFF).',
      },
      // Errors tab (Azure SQL / Synapse).
      {
        key: 'errorHandlingOption',
        label: 'On error',
        kind: 'select',
        options: [
          { value: 'stopOnFirstError', label: 'Stop on first error' },
          { value: 'continueOnError', label: 'Continue on error' },
        ],
        hint: 'Database error-row handling (DFS: errorHandlingOption). Azure SQL / Synapse only.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Schema modifier
  // ---------------------------------------------------------------------------
  {
    type: 'select',
    displayName: 'Select',
    category: 'Schema modifier',
    icon: 'Column',
    description:
      'Alias columns and stream names; drop or reorder columns. Supports fixed column mapping and rule-based (pattern) mapping.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'mappingMode',
        label: 'Mapping mode',
        kind: 'select',
        options: [
          { value: 'fixed', label: 'Fixed mapping (per-column)' },
          { value: 'rule', label: 'Rule-based mapping (pattern)' },
          { value: 'auto', label: 'Auto map (each(match(true())))' },
        ],
        hint: 'DFS: mapColumn(...) for fixed, mapColumn(each(match(...))) for rule-based.',
      },
      {
        key: 'columnMappings',
        label: 'Column mappings (name = source)',
        kind: 'multiline',
        showIf: { key: 'mappingMode', equals: 'fixed' },
        dataFlowExpression: true,
        hint: 'One mapping per line: outputName = sourceColumn. Source side is a DF expression.',
      },
      {
        key: 'matchCondition',
        label: 'Matching condition',
        kind: 'text',
        showIf: { key: 'mappingMode', equals: 'rule' },
        dataFlowExpression: true,
        placeholder: 'type == \'string\'  /  name != \'movie\'  /  true()',
        hint: 'DF expression selecting which columns the rule applies to (match(...)).',
      },
      {
        key: 'nameAs',
        label: 'Name as (rule output)',
        kind: 'text',
        showIf: { key: 'mappingMode', equals: 'rule' },
        dataFlowExpression: true,
        placeholder: "$$  /  '_clean' + $$  /  upper($$)",
        hint: 'DF expression for the output name/value per matched column ($$ = column name).',
      },
      {
        key: 'skipDuplicateMapInputs',
        label: 'Skip duplicate input columns',
        kind: 'boolean',
        hint: 'DFS: skipDuplicateMapInputs.',
      },
      {
        key: 'skipDuplicateMapOutputs',
        label: 'Skip duplicate output columns',
        kind: 'boolean',
        hint: 'DFS: skipDuplicateMapOutputs.',
      },
    ],
  },
  {
    type: 'derive',
    displayName: 'Derived column',
    category: 'Schema modifier',
    icon: 'CalculatorMultiple',
    description:
      'Generate new columns or modify existing fields using the data flow expression language. Supports per-column and rule-based (column pattern) derivations.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'columns',
        label: 'Columns (name = expression)',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'upperCaseTitle = upper(title)\nDWhash = sha1(columns())',
        hint: 'One derivation per line: column = DF-expression. DFS: derive(col = expr, ...).',
      },
      {
        key: 'usePattern',
        label: 'Use column pattern (rule-based)',
        kind: 'boolean',
        hint: 'Apply the same expression across columns matching a pattern (each(match(...))).',
      },
      {
        key: 'matchCondition',
        label: 'Matching condition',
        kind: 'text',
        showIf: { key: 'usePattern', equals: 'true' },
        dataFlowExpression: true,
        placeholder: "type == 'string'",
        hint: 'DF expression selecting the columns the pattern derivation applies to.',
      },
    ],
  },
  {
    type: 'aggregate',
    displayName: 'Aggregate',
    category: 'Schema modifier',
    icon: 'MathSymbols',
    description:
      'Define aggregations such as SUM, MIN, MAX, COUNT grouped by existing or computed columns. Group-by is optional; each aggregate expression must contain at least one aggregate function.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'groupBy',
        label: 'Group by (name = expression)',
        kind: 'multiline',
        dataFlowExpression: true,
        placeholder: 'year\nProductID',
        hint: 'Group-by columns or computed columns (optional). DFS: groupBy(col, name = expr).',
      },
      {
        key: 'aggregates',
        label: 'Aggregates (name = expression)',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'avgrating = avg(toInteger(Rating))\ntotal = sum(Sales)',
        hint: 'One aggregate per line: column = aggregate-expression. DFS: name = aggExpr.',
      },
      {
        key: 'usePattern',
        label: 'Add column pattern',
        kind: 'boolean',
        hint: 'Apply an aggregate across matched columns (each(match(...))). E.g. keep first($$).',
      },
      {
        key: 'matchCondition',
        label: 'Pattern matching condition',
        kind: 'text',
        showIf: { key: 'usePattern', equals: 'true' },
        dataFlowExpression: true,
        placeholder: "type == 'double' || type == 'integer'",
      },
    ],
  },
  {
    type: 'pivot',
    displayName: 'Pivot',
    category: 'Schema modifier',
    icon: 'Table',
    description:
      'An aggregation where one or more group-by columns have a pivot key column’s distinct row values transformed into individual columns.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'groupBy',
        label: 'Group by columns',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: 'Tm',
        hint: 'Columns to aggregate the pivoted values over (optional). DFS: groupBy(...).',
      },
      {
        key: 'pivotKey',
        label: 'Pivot key column',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'Pos',
        hint: 'Column whose distinct row values become new columns. DFS: pivotBy(col, [values]).',
      },
      {
        key: 'pivotKeyValues',
        label: 'Specific pivot values (optional)',
        kind: 'text',
        hint: 'Comma-separated values to pivot (rest dropped). Leave empty to pivot all values.',
      },
      {
        key: 'enableNullValue',
        label: 'Pivot null values',
        kind: 'boolean',
        hint: 'Create a pivoted column for null values in the pivot key column.',
      },
      {
        key: 'pivotedColumns',
        label: 'Pivoted columns (prefix = aggregate)',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: '{} = count()\ntotal = sum(Amount)',
        hint: 'Aggregate expression(s) per pivot value. Each must contain an aggregate function.',
      },
      {
        key: 'columnNaming',
        label: 'Column name pattern',
        kind: 'text',
        placeholder: '$V$N count',
        hint: 'DFS: columnNaming — combine $V (value) / $N (name) with prefix/middle/suffix.',
      },
      {
        key: 'lateral',
        label: 'Lateral column arrangement',
        kind: 'boolean',
        hint: 'DFS: lateral — group new columns generated from the same source column.',
      },
    ],
  },
  {
    type: 'unpivot',
    displayName: 'Unpivot',
    category: 'Schema modifier',
    icon: 'TableSwitch',
    description:
      'Pivot columns into row values — turn an unnormalized dataset into a normalized one by expanding values from multiple columns into multiple rows.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'ungroupBy',
        label: 'Ungroup by columns',
        kind: 'text',
        required: true,
        placeholder: 'PO, Vendor',
        hint: 'Columns to keep (the unpivot aggregation groups by these). Comma-separated.',
      },
      {
        key: 'unpivotKey',
        label: 'Unpivot key column',
        kind: 'text',
        required: true,
        placeholder: 'Fruit',
        hint: 'The new column that holds the former column names (one row per value).',
      },
      {
        key: 'unpivotKeyValues',
        label: 'Specific values (optional)',
        kind: 'text',
        hint: 'Comma-separated subset of column names/values to unpivot. Empty = all.',
      },
      {
        key: 'unpivotedColumnName',
        label: 'Unpivoted column (value) name',
        kind: 'text',
        required: true,
        placeholder: 'SumCost',
        hint: 'The new column that stores the unpivoted values.',
      },
      {
        key: 'columnArrangement',
        label: 'Column arrangement',
        kind: 'select',
        options: [
          { value: 'normal', label: 'Normal (group by value)' },
          { value: 'lateral', label: 'Lateral (group by source column)' },
        ],
      },
      {
        key: 'dropNullRows',
        label: 'Drop rows with null values',
        kind: 'boolean',
      },
    ],
  },
  {
    type: 'window',
    displayName: 'Window',
    category: 'Schema modifier',
    icon: 'PanelLeftHeader',
    description:
      'Define window-based aggregations over data streams (SQL OVER clause) — LEAD, LAG, NTILE, CUMEDIST, RANK, moving averages — with optional partition (over), sort, and a row/range frame.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'over',
        label: 'Over (partition by)',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: 'stocksymbol',
        hint: 'Partitioning column(s)/expression — the SQL PARTITION BY. DFS: over(...).',
      },
      {
        key: 'sort',
        label: 'Sort (order by)',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'asc(Date, true)',
        hint: 'Ordering for the window. DFS: asc(col,true) / desc(col,true).',
      },
      {
        key: 'rangeBy',
        label: 'Window frame',
        kind: 'select',
        options: [
          { value: 'unbounded', label: 'Unbounded (both ends)' },
          { value: 'bounded', label: 'Bounded (offset start/end)' },
        ],
        hint: 'Unbounded, or a bounded frame. DFS: startRowOffset / endRowOffset.',
      },
      {
        key: 'startRowOffset',
        label: 'Offset start',
        kind: 'number',
        showIf: { key: 'rangeBy', equals: 'bounded' },
        placeholder: '-7',
        hint: 'Rows before the current row (DFS: startRowOffset, e.g. -7L).',
      },
      {
        key: 'endRowOffset',
        label: 'Offset end',
        kind: 'number',
        showIf: { key: 'rangeBy', equals: 'bounded' },
        placeholder: '7',
        hint: 'Rows after the current row (DFS: endRowOffset, e.g. 7L).',
      },
      {
        key: 'windowColumns',
        label: 'Window columns (name = expression)',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'FifteenDayMovingAvg = round(avg(Close),2)\nprevTitle = lag(title,1)',
        hint: 'One windowed column per line: column = window/analytical-function expression.',
      },
    ],
  },
  {
    type: 'keyGenerate',
    displayName: 'Surrogate key',
    category: 'Schema modifier',
    icon: 'KeyMultiple',
    description:
      'Add an incrementing, non-business arbitrary key value to each row — useful for star-schema dimension keys.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'keyColumn',
        label: 'Key column',
        kind: 'text',
        required: true,
        placeholder: 'sk',
        hint: 'Name of the generated surrogate-key column (type long). DFS: output(<col> as long).',
      },
      {
        key: 'startValue',
        label: 'Start value',
        kind: 'number',
        required: true,
        placeholder: '1',
        hint: 'Lowest key value generated. DFS: startAt: 1L.',
      },
    ],
  },
  {
    type: 'rank',
    displayName: 'Rank',
    category: 'Schema modifier',
    icon: 'NumberSymbol',
    description:
      'Generate an ordered ranking based on sort conditions, into a new long column. Supports dense ranking and case-insensitive string sorting.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'rankColumn',
        label: 'Rank column',
        kind: 'text',
        required: true,
        placeholder: 'pointsRanking',
        hint: 'Name of the generated rank column (type long). DFS: output(<col> as long).',
      },
      {
        key: 'sortConditions',
        label: 'Sort conditions',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'desc(PTS, true)\nasc(Name, true)',
        hint: 'One condition per line, priority by order. DFS: desc(col,true)/asc(col,true).',
      },
      {
        key: 'caseInsensitive',
        label: 'Case insensitive',
        kind: 'boolean',
        hint: 'Ignore case for string sort columns. DFS: caseInsensitive.',
      },
      {
        key: 'dense',
        label: 'Dense rank',
        kind: 'boolean',
        hint: 'Consecutive ranks with no gaps after ties. DFS: dense.',
      },
    ],
  },
  {
    type: 'cast',
    displayName: 'Cast',
    category: 'Schema modifier',
    icon: 'ArrowSwap',
    description:
      'Change column data types with type checking (an easier, guard-railed alternative to casting inside a derived column).',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'casts',
        label: 'Casts (column -> type)',
        kind: 'multiline',
        required: true,
        placeholder: 'amount -> decimal\norderDate -> date',
        hint: 'One cast per line: column -> data-flow type (string, integer, decimal, date, ...).',
      },
      {
        key: 'format',
        label: 'Format string',
        kind: 'text',
        placeholder: 'yyyy-MM-dd',
        hint: 'Optional format for date/timestamp casts.',
      },
      {
        key: 'errorHandling',
        label: 'On type error',
        kind: 'select',
        options: [
          { value: 'fail', label: 'Fail the data flow' },
          { value: 'null', label: 'Set to NULL' },
        ],
      },
    ],
  },
  {
    type: 'call',
    displayName: 'External call',
    category: 'Schema modifier',
    icon: 'PlugConnected',
    description:
      'Call external REST endpoints row-by-row and add custom results into the stream. Map input columns, then define the output body/headers/status structure.',
    needsDataset: true,
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'store',
        label: 'Endpoint type',
        kind: 'select',
        required: true,
        options: [{ value: 'restservice', label: 'REST' }],
        hint: 'Inline dataset type for the call. Today only REST is supported. DFS: store.',
      },
      INLINE_LINKED_SERVICE,
      {
        key: 'httpMethod',
        label: 'HTTP method',
        kind: 'select',
        options: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' },
          { value: 'DELETE', label: 'DELETE' },
        ],
        hint: 'DFS: httpMethod.',
      },
      {
        key: 'entity',
        label: 'Relative URL / entity',
        kind: 'text',
        placeholder: 'api/Todo/',
        hint: 'Relative path appended to the linked service base URL. DFS: entity.',
      },
      {
        key: 'timeout',
        label: 'Timeout (seconds)',
        kind: 'number',
        placeholder: '30',
        hint: 'DFS: timeout.',
      },
      {
        key: 'inputMapping',
        label: 'Input column mapping',
        kind: 'multiline',
        dataFlowExpression: true,
        hint: 'Columns sent to the endpoint (auto-map or rename). DFS: mapColumn(...).',
      },
      {
        key: 'outputBody',
        label: 'Output body structure',
        kind: 'multiline',
        dataFlowExpression: true,
        placeholder: 'body as (name as string)',
        hint: 'Output projection for the response body. Import projection detects it from a debug call.',
      },
      {
        key: 'storeHeaders',
        label: 'Headers column',
        kind: 'text',
        placeholder: 'headers',
        hint: 'Optional column to store response headers ([string,string]).',
      },
      {
        key: 'storeStatus',
        label: 'Status column',
        kind: 'text',
        hint: 'Optional column to store the response status.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Row modifier
  // ---------------------------------------------------------------------------
  {
    type: 'filter',
    displayName: 'Filter',
    category: 'Row modifier',
    icon: 'Filter',
    description: 'Filter rows based on a condition (a data flow boolean expression).',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'condition',
        label: 'Filter condition',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'toInteger(id) == 1   /   year > 1980',
        hint: 'DF boolean expression — rows where it is true pass. DFS: filter(<expr>).',
      },
    ],
  },
  {
    type: 'sort',
    displayName: 'Sort',
    category: 'Row modifier',
    icon: 'ArrowSortDown',
    description: 'Sort incoming rows on the current data stream by one or more sort conditions.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'sortConditions',
        label: 'Sort conditions',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'desc(year, true)\nasc(title, true)',
        hint: 'One condition per line, priority by order. DFS: sort(desc(col,true), asc(col,true)).',
      },
      {
        key: 'caseInsensitive',
        label: 'Case insensitive',
        kind: 'boolean',
      },
    ],
  },
  {
    type: 'alterRow',
    displayName: 'Alter row',
    category: 'Row modifier',
    icon: 'TableEdit',
    description:
      'Set insert / update / delete / upsert policies on rows. Conditions are evaluated in priority order; the first match wins. Operates only on database / REST / Cosmos DB sinks.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'insertIf',
        label: 'Insert if',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: "alterRowCondition == 'insert'   /   true()",
        hint: 'DF condition that marks a row for insert. DFS: insertIf(<expr>).',
      },
      {
        key: 'updateIf',
        label: 'Update if',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: "alterRowCondition == 'update'",
        hint: 'DF condition that marks a row for update. DFS: updateIf(<expr>).',
      },
      {
        key: 'upsertIf',
        label: 'Upsert if',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: "alterRowCondition == 'upsert'",
        hint: 'DF condition that marks a row for upsert. DFS: upsertIf(<expr>).',
      },
      {
        key: 'deleteIf',
        label: 'Delete if',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: "alterRowCondition == 'delete'",
        hint: 'DF condition that marks a row for delete. DFS: deleteIf(<expr>).',
      },
    ],
  },
  {
    type: 'assert',
    displayName: 'Assert',
    category: 'Row modifier',
    icon: 'CheckmarkCircle',
    description:
      'Set assert rules for each row (expect true, unique, or exists). Failed assertions can be tagged and redirected to a sink error output.',
    preview: false,
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'assertType',
        label: 'Assert type',
        kind: 'select',
        required: true,
        options: [
          { value: 'expectTrue', label: 'Expect true' },
          { value: 'expectUnique', label: 'Expect unique' },
          { value: 'expectExists', label: 'Expect exists' },
        ],
        hint: 'DFS: expectTrue(...) / expectUnique(...) / expectExists(...).',
      },
      {
        key: 'assertId',
        label: 'Assert ID',
        kind: 'text',
        placeholder: 'assert1',
        hint: 'Identifier for the assertion (surfaced on failed rows).',
      },
      {
        key: 'description',
        label: 'Description',
        kind: 'text',
        dataFlowExpression: true,
        hint: 'Optional DF expression for a per-row failure description.',
      },
      {
        key: 'expression',
        label: 'Assert expression',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'toInteger(rating) <= 10',
        hint: 'DF boolean expression that should hold for every row.',
      },
      {
        key: 'ignoreNullsOnAssert',
        label: 'Ignore null values',
        kind: 'boolean',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Multiple inputs/outputs
  // ---------------------------------------------------------------------------
  {
    type: 'join',
    displayName: 'Join',
    category: 'Multiple inputs/outputs',
    icon: 'Merge',
    description:
      'Combine data from two sources or streams. Supports inner, left/right/full outer, and custom cross joins, plus fuzzy matching.',
    ports: { inputs: 2, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'rightStream',
        label: 'Right stream',
        kind: 'text',
        required: true,
        hint: 'The stream joined to the incoming (left) stream. DFS: <left>, <right> join(...).',
      },
      {
        key: 'joinType',
        label: 'Join type',
        kind: 'select',
        required: true,
        options: [
          { value: 'inner', label: 'Inner' },
          { value: 'left_outer', label: 'Left outer' },
          { value: 'right_outer', label: 'Right outer' },
          { value: 'outer', label: 'Full outer' },
          { value: 'cross', label: 'Custom (cross)' },
        ],
        hint: 'DFS: joinType.',
      },
      {
        key: 'condition',
        label: 'Join condition',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'ProductID == ProductKey   /   leftcol > rightcol',
        hint: 'DF equality (or, for cross, any) condition. Use stream@col to disambiguate.',
      },
      BROADCAST,
      {
        key: 'useFuzzy',
        label: 'Use fuzzy matching',
        kind: 'boolean',
        hint: 'String-only fuzzy join (inner/left/full only; broadcast must be Off).',
      },
      {
        key: 'combineTextParts',
        label: 'Combine text parts',
        kind: 'boolean',
        showIf: { key: 'useFuzzy', equals: 'true' },
        hint: 'Match by removing spaces between words (Data Factory ~ DataFactory).',
      },
      {
        key: 'similarityScoreColumn',
        label: 'Similarity score column',
        kind: 'text',
        showIf: { key: 'useFuzzy', equals: 'true' },
        hint: 'Optional new column to store the per-row match score.',
      },
      {
        key: 'similarityThreshold',
        label: 'Similarity threshold (60-100)',
        kind: 'number',
        showIf: { key: 'useFuzzy', equals: 'true' },
        placeholder: '80',
      },
    ],
  },
  {
    type: 'lookup',
    displayName: 'Lookup',
    category: 'Multiple inputs/outputs',
    icon: 'SearchInfo',
    description:
      'Reference data from another stream (like a left outer join). Appends the lookup stream’s columns to the primary stream’s rows.',
    ports: { inputs: 2, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'lookupStream',
        label: 'Lookup stream',
        kind: 'text',
        required: true,
        hint: 'The stream whose columns are appended (right side). Primary stream is the incoming.',
      },
      {
        key: 'condition',
        label: 'Lookup conditions',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'ProductID == ProductKey',
        hint: 'DF match condition(s). Non-equi operators require Fixed broadcast.',
      },
      {
        key: 'matchMultiple',
        label: 'Match multiple rows',
        kind: 'boolean',
        hint: 'Return a row per match instead of one. DFS: multiple: true|false.',
      },
      {
        key: 'matchOn',
        label: 'Match on',
        kind: 'select',
        showIf: { key: 'matchMultiple', equals: 'false' },
        options: [
          { value: 'any', label: 'Any row (fastest)' },
          { value: 'first', label: 'First match' },
          { value: 'last', label: 'Last match' },
        ],
        hint: 'DFS: pickup. First/last require a sort condition below.',
      },
      {
        key: 'sortCondition',
        label: 'Sort condition (first/last)',
        kind: 'text',
        dataFlowExpression: true,
        showIf: { key: 'matchOn', equals: 'first' },
        placeholder: 'asc(ProductKey, true)',
        hint: 'Required when Match on is first or last. DFS: asc(col,true)/desc(col,true).',
      },
      BROADCAST,
    ],
  },
  {
    type: 'exists',
    displayName: 'Exists',
    category: 'Multiple inputs/outputs',
    icon: 'CheckboxChecked',
    description:
      'Check whether your data exists in another source or stream (SQL EXISTS / NOT EXISTS). Routes rows by presence/absence of a match.',
    ports: { inputs: 2, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'rightStream',
        label: 'Right (exists) stream',
        kind: 'text',
        required: true,
        hint: 'The stream checked for existence of matching rows.',
      },
      {
        key: 'existsType',
        label: 'Exists type',
        kind: 'select',
        required: true,
        options: [
          { value: 'exists', label: 'Exists' },
          { value: 'notExists', label: "Doesn't exist" },
        ],
        hint: 'DFS: existsType: exists | notExists.',
      },
      {
        key: 'condition',
        label: 'Exists conditions',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'id == id',
        hint: 'DF match condition(s) between the two streams.',
      },
      BROADCAST,
    ],
  },
  {
    type: 'union',
    displayName: 'Union',
    category: 'Multiple inputs/outputs',
    icon: 'ArrowJoin',
    description:
      'Combine multiple data streams vertically (UNION). Map by column name or by ordinal position; takes two or more inputs.',
    ports: { inputs: 'n', outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'unionStreams',
        label: 'Streams to union',
        kind: 'text',
        required: true,
        hint: 'Comma-separated stream names to combine with the incoming stream. DFS: union(...).',
      },
      {
        key: 'unionBy',
        label: 'Union by',
        kind: 'select',
        options: [
          { value: 'name', label: 'Name' },
          { value: 'position', label: 'Position (ordinal)' },
        ],
        hint: 'Combine by column name or by ordinal position.',
      },
    ],
  },
  {
    type: 'newBranch',
    displayName: 'New branch',
    category: 'Multiple inputs/outputs',
    icon: 'BranchFork',
    description:
      'Apply multiple sets of operations and transformations against the same data stream (replicates the incoming rows down a new branch).',
    ports: { inputs: 1, outputs: 2 },
    settings: [
      // New branch has no settings of its own in the DFS — it simply reuses the
      // upstream stream name as the input of a second downstream chain. The
      // editor adds the branch on the canvas; no fields to collect.
    ],
  },
  {
    type: 'split',
    displayName: 'Conditional split',
    category: 'Multiple inputs/outputs',
    icon: 'Branch',
    description:
      'Route rows to different streams based on matching conditions (like a CASE structure), with an optional default stream for unmatched rows.',
    ports: { inputs: 1, outputs: 'n' },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'splitOn',
        label: 'Split on',
        kind: 'select',
        options: [
          { value: 'first', label: 'First matching condition' },
          { value: 'all', label: 'All matching conditions' },
        ],
        hint: 'DFS: disjoint:false = first match; disjoint:true = every match.',
      },
      {
        key: 'conditions',
        label: 'Conditions (streamName : expression)',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'moviesBefore1960 : year < 1960\nmoviesAfter1980 : year > 1980',
        hint: 'One output stream per line. DF boolean expression per condition.',
      },
      {
        key: 'defaultStream',
        label: 'Default stream name',
        kind: 'text',
        placeholder: 'AllOtherMovies',
        hint: 'Optional stream for rows matching no condition.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------
  {
    type: 'foldDown',
    displayName: 'Flatten',
    category: 'Formatters',
    icon: 'Flowchart',
    description:
      'Take array values inside hierarchical structures (such as JSON) and unroll them into individual rows (denormalize). Supports unroll root, multiple arrays, and rule-based mapping.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'unrollBy',
        label: 'Unroll by',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'goods.orders.shipped.orderItems',
        hint: 'Array column(s) to unroll — one output row per item. DFS: unroll(...).',
      },
      {
        key: 'unrollRoot',
        label: 'Unroll root (optional)',
        kind: 'text',
        dataFlowExpression: true,
        placeholder: 'goods.orders',
        hint: 'Complex array that contains the unroll-by array. Empty = top of hierarchy.',
      },
      {
        key: 'mapping',
        label: 'Flatten mapping (name = source)',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: 'orderId = goods.orders.orderId\nitemName = goods.orders.shipped.orderItems.itemName',
        hint: 'Projection of the new flat structure. DFS: mapColumn(...).',
      },
      {
        key: 'usePattern',
        label: 'Rule-based mapping',
        kind: 'boolean',
        hint: 'Flatten columns matching a pattern (each(match(...))).',
      },
      {
        key: 'matchCondition',
        label: 'Matching condition',
        kind: 'text',
        showIf: { key: 'usePattern', equals: 'true' },
        dataFlowExpression: true,
        placeholder: "like(name,'cust%')",
      },
      {
        key: 'deepTraversal',
        label: 'Deep column traversal',
        kind: 'boolean',
        showIf: { key: 'usePattern', equals: 'true' },
        hint: 'Handle subcolumns of a complex object individually.',
      },
    ],
  },
  {
    type: 'parse',
    displayName: 'Parse',
    category: 'Formatters',
    icon: 'DocumentBulletList',
    description:
      'Parse text columns that are strings of JSON, delimited text, or XML into a typed (complex) column, using a declared output schema.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'column',
        label: 'Column (output)',
        kind: 'text',
        required: true,
        placeholder: 'json',
        hint: 'New (or existing) column to store the parsed result.',
      },
      {
        key: 'expression',
        label: 'Source / expression',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'jsonString',
        hint: 'The string column (or expression) to parse. DFS: <col> = <src> ? (schema).',
      },
      {
        key: 'outputColumnType',
        label: 'Output schema',
        kind: 'multiline',
        required: true,
        dataFlowExpression: true,
        placeholder: '(trade as boolean, customers as string[])',
        hint: 'Declared output schema. “Detect type” imports it from a debug sample.',
      },
      {
        key: 'format',
        label: 'Format',
        kind: 'select',
        required: true,
        options: [
          { value: 'json', label: 'JSON' },
          { value: 'delimited', label: 'Delimited text' },
          { value: 'xml', label: 'XML' },
        ],
        hint: 'DFS: format.',
      },
      {
        key: 'documentForm',
        label: 'Document form',
        kind: 'select',
        options: [
          { value: 'singleDocument', label: 'Single document' },
          { value: 'documentPerLine', label: 'Document per line' },
          { value: 'arrayOfDocuments', label: 'Array of documents' },
        ],
        showIf: { key: 'format', equals: 'json' },
        hint: 'DFS: documentForm (JSON).',
      },
      {
        key: 'columnDelimiter',
        label: 'Column delimiter',
        kind: 'text',
        showIf: { key: 'format', equals: 'delimited' },
        placeholder: '|',
        hint: 'DFS: columnDelimiter (delimited).',
      },
      {
        key: 'columnNamesAsHeader',
        label: 'First row as header',
        kind: 'boolean',
        showIf: { key: 'format', equals: 'delimited' },
        hint: 'DFS: columnNamesAsHeader.',
      },
      {
        key: 'nullValue',
        label: 'Null value',
        kind: 'text',
        showIf: { key: 'format', equals: 'delimited' },
        hint: 'DFS: nullValue.',
      },
    ],
  },
  {
    type: 'stringify',
    displayName: 'Stringify',
    category: 'Formatters',
    icon: 'TextQuote',
    description:
      'Turn complex types (structure, map, array) into plain strings — e.g. to store or send a sub-structure as a single string column.',
    ports: { inputs: 1, outputs: 1 },
    settings: [
      OUTPUT_STREAM_NAME,
      {
        key: 'column',
        label: 'Column (output)',
        kind: 'text',
        required: true,
        placeholder: 'mydata',
        hint: 'New (or existing) column to store the stringified result.',
      },
      {
        key: 'expression',
        label: 'Source complex field',
        kind: 'text',
        required: true,
        dataFlowExpression: true,
        placeholder: 'body.properties.periods',
        hint: 'The complex field/expression to stringify. DFS: <col> = <src> ? string.',
      },
      {
        key: 'format',
        label: 'Format',
        kind: 'select',
        options: [
          { value: 'json', label: 'JSON' },
          { value: 'plain', label: 'Plain' },
        ],
        hint: 'DFS: format.',
      },
    ],
  },
];

// =============================================================================
// DATAFLOW_SETTINGS — data-flow-level (graph-level) settings: the Execute Data
// Flow activity’s run-as compute (Azure IR), logging, partitioning, and the
// interactive debug session compute. These are NOT per-transform; they apply to
// the whole data flow when it runs in a pipeline (or in a debug session).
//
// Grounded in:
//   - control-flow-execute-data-flow-activity (compute type/core count, logging)
//   - concepts-data-flow-debug-mode (debug compute size + TTL)
//   - concepts-integration-runtime / Azure IR data-flow properties
// =============================================================================

export interface DataFlowSettingGroup {
  group: string;
  description: string;
  fields: TransformField[];
}

export const DATAFLOW_SETTINGS: DataFlowSettingGroup[] = [
  {
    group: 'Run on (compute)',
    description:
      'The Azure Integration Runtime’s data-flow compute that the Execute Data Flow activity provisions for this run. Larger = faster + costlier.',
    fields: [
      {
        key: 'computeType',
        label: 'Compute type',
        kind: 'select',
        required: true,
        options: [
          { value: 'General', label: 'General purpose' },
          { value: 'MemoryOptimized', label: 'Memory optimized' },
          { value: 'ComputeOptimized', label: 'Compute optimized' },
        ],
        hint: 'Spark cluster family (DataFlow activity: computeType).',
      },
      {
        key: 'coreCount',
        label: 'Core count',
        kind: 'select',
        required: true,
        options: [
          { value: '8', label: '8 (4+4) — small' },
          { value: '16', label: '16 (8+8)' },
          { value: '32', label: '32 (16+16)' },
          { value: '48', label: '48 (24+24)' },
          { value: '80', label: '80 (40+40)' },
          { value: '144', label: '144 (72+72)' },
          { value: '272', label: '272 (136+136)' },
        ],
        hint: 'Total cores (driver + workers). DataFlow activity: coreCount.',
      },
      {
        key: 'integrationRuntime',
        label: 'Integration runtime',
        kind: 'text',
        hint: 'Azure IR whose data-flow properties (TTL, cluster size) back the run. Empty = AutoResolve.',
      },
      {
        key: 'timeToLive',
        label: 'Quick re-use (TTL minutes)',
        kind: 'number',
        placeholder: '0',
        hint: 'Keep the cluster warm between activities to skip ~5 min startup. Azure IR TTL.',
      },
    ],
  },
  {
    group: 'Logging',
    description:
      'Run-level diagnostic logging for the data flow. Verbose captures per-transform row counts and partition timings; None is fastest.',
    fields: [
      {
        key: 'loggingLevel',
        label: 'Logging level',
        kind: 'select',
        options: [
          { value: 'None', label: 'None' },
          { value: 'Basic', label: 'Basic' },
          { value: 'Verbose', label: 'Verbose' },
        ],
        hint: 'DataFlow activity: traceLevel.',
      },
    ],
  },
  {
    group: 'Partitioning',
    description:
      'Optional run-level partitioning hint (set per source/transform on the Optimize tab). Use current partitioning unless you have a hot-spot to spread.',
    fields: [
      {
        key: 'defaultPartitioning',
        label: 'Default partitioning',
        kind: 'select',
        options: [
          { value: 'current', label: 'Use current partitioning' },
          { value: 'single', label: 'Single partition' },
          { value: 'roundRobin', label: 'Round robin' },
          { value: 'hash', label: 'Hash' },
          { value: 'dynamicRange', label: 'Dynamic range' },
          { value: 'fixedRange', label: 'Fixed range' },
          { value: 'key', label: 'Key' },
        ],
        hint: 'Optimize tab partition strategy applied where Use current partitioning is overridden.',
      },
      {
        key: 'partitionColumns',
        label: 'Partition columns / count',
        kind: 'text',
        hint: 'Columns (hash/key) or number of partitions (round robin), per the chosen strategy.',
      },
    ],
  },
  {
    group: 'Debug session (data preview)',
    description:
      'Interactive Spark debug cluster used for per-transform data preview and Import schema. Data preview requires a LIVE debug session — the editor honest-gates preview when none is running (no faked rows, per no-vaporware).',
    fields: [
      {
        key: 'debugComputeType',
        label: 'Debug compute type',
        kind: 'select',
        options: [
          { value: 'General', label: 'General purpose' },
          { value: 'MemoryOptimized', label: 'Memory optimized' },
          { value: 'ComputeOptimized', label: 'Compute optimized' },
        ],
        hint: 'Debug-mode cluster family (concepts-data-flow-debug-mode).',
      },
      {
        key: 'debugCoreCount',
        label: 'Debug core count',
        kind: 'select',
        options: [
          { value: '8', label: '8 (4+4)' },
          { value: '16', label: '16 (8+8)' },
          { value: '32', label: '32 (16+16)' },
        ],
        hint: 'Debug clusters default to the smallest size to control cost.',
      },
      {
        key: 'debugTimeToLive',
        label: 'Debug session TTL (minutes)',
        kind: 'number',
        placeholder: '60',
        hint: 'Auto-terminate the debug cluster after this idle time.',
      },
      {
        key: 'dataPreviewRowLimit',
        label: 'Data preview row limit',
        kind: 'number',
        placeholder: '1000',
        hint: 'Rows pulled per preview. Overrides per-source Sampling during preview.',
      },
    ],
  },
];

// =============================================================================
// Lookups (imported by the palette / editor).
// =============================================================================

/** Look up a transform definition by its data-flow-script `type` token. */
export function transformByType(type: string): TransformDef | undefined {
  return TRANSFORMS.find((t) => t.type === type);
}

/** All transforms in a category, in catalog order (for the palette’s groupings). */
export function transformsByCategory(category: TransformCategory): TransformDef[] {
  return TRANSFORMS.filter((t) => t.category === category);
}

/** Ordered list of categories as the palette should render them. */
export const TRANSFORM_CATEGORIES: TransformCategory[] = [
  'Source & sink',
  'Schema modifier',
  'Row modifier',
  'Multiple inputs/outputs',
  'Formatters',
];

/** Total number of transforms implemented with full config metadata. */
export const TRANSFORM_COUNT = TRANSFORMS.length;
