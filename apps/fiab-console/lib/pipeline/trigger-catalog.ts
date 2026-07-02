/**
 * trigger-catalog — the data-driven inventory of Azure Data Factory / Synapse
 * pipeline TRIGGER types and their full config metadata, plus the pipeline
 * PARAMETER and VARIABLE type models a pipeline (and a trigger's run-parameter
 * bindings) round-trip on.
 *
 * WHY THIS EXISTS
 * ---------------
 * ADF/Synapse expose four trigger types, each created as a
 * `Microsoft.DataFactory/factories/triggers` resource (api 2018-06-01) whose
 * `properties.type` is the trigger type (e.g. 'ScheduleTrigger',
 * 'TumblingWindowTrigger', 'BlobEventsTrigger', 'CustomEventsTrigger') and whose
 * `properties.typeProperties` carries the type-specific recurrence / window /
 * event-filter fields. A trigger references one or more pipelines (the
 * `pipelines[]` array — or, for tumbling-window, the singular `pipeline`) and
 * supplies each run a `parameters` map; those map values are typically trigger
 * SYSTEM VARIABLES (e.g. `@triggerBody().fileName`, `@trigger().outputs.windowStartTime`)
 * mapped onto the pipeline's declared parameters.
 *
 * The Loom trigger UI (the New-trigger wizard + the trigger Manage hub) renders
 * STRUCTURED FORMS from this catalog — never a freeform JSON textarea (per
 * loom-no-freeform-config). A trigger type's `settings` describe exactly which
 * `typeProperties` keys to collect; the editor assembles the trigger
 * `properties` and PUTs it to the real ADF/Synapse trigger BFF route, which
 * calls the real ARM REST `upsertTrigger` in `lib/azure/adf-client.ts`
 * (`listTriggers` / `getTrigger` / `upsertTrigger` / `startTrigger` /
 * `stopTrigger`) / `lib/azure/synapse-dev-client.ts`. No mocks (per
 * no-vaporware.md).
 *
 * Every `key` here is the EXACT trigger typeProperties key from the ADF trigger
 * docs + the ARM `factories/triggers` schema + the `@azure/arm-datafactory`
 * model, grounded in Microsoft Learn:
 *   - Schedule trigger:
 *       https://learn.microsoft.com/azure/data-factory/how-to-create-schedule-trigger
 *   - Tumbling-window trigger (+ dependency):
 *       https://learn.microsoft.com/azure/data-factory/how-to-create-tumbling-window-trigger
 *       https://learn.microsoft.com/azure/data-factory/tumbling-window-trigger-dependency
 *   - Storage-event (Blob events) trigger:
 *       https://learn.microsoft.com/azure/data-factory/how-to-create-event-trigger
 *   - Custom-event trigger:
 *       https://learn.microsoft.com/azure/data-factory/how-to-create-custom-event-trigger
 *   - Trigger-metadata → pipeline-parameter mapping + system variables:
 *       https://learn.microsoft.com/azure/data-factory/how-to-use-trigger-parameterization
 *       https://learn.microsoft.com/azure/data-factory/control-flow-system-variables
 *   - ARM template reference:
 *       https://learn.microsoft.com/azure/templates/microsoft.datafactory/factories/triggers
 *
 * REUSE
 * -----
 * The field shape is the connector-catalog `ConfigField` (re-exported here) so
 * the same structured renderer that builds linked-service forms builds trigger
 * forms — `kind`, `required`, `options`, `showIf`, `supportsDynamic`, `secret`
 * all carry the same meaning. A `supportsDynamic` field binds the shared
 * `ExpressionField` (lib/components/pipeline/expression-field) so a value that
 * ADF allows to be an `@{…}` expression (e.g. a path filter parameterised by a
 * variable) gets the portal's "Add dynamic content" affordance; the @-string
 * round-trips verbatim. A storage-event trigger references a real storage
 * account — surfaced via the `LinkedServicePicker`
 * (lib/components/pipeline/linked-service-gallery), which resolves an
 * `AzureBlobFS` / `AzureBlobStorage` linked service to the account's ARM
 * resource ID for the trigger `scope`.
 */

import type { ConfigField } from '@/lib/pipeline/connector-catalog';

// Re-export ConfigField so trigger-form callers can import the field contract
// from one place alongside the trigger types (no second import line needed).
export type { ConfigField } from '@/lib/pipeline/connector-catalog';

// =============================================================================
// Trigger type contract.
// =============================================================================

/** The four ADF/Synapse trigger `properties.type` discriminators. */
export type TriggerKind =
  | 'ScheduleTrigger'
  | 'TumblingWindowTrigger'
  | 'BlobEventsTrigger'
  | 'CustomEventsTrigger';

/**
 * How a trigger references its pipeline(s):
 *   - 'multiple' → schedule / event triggers use the `pipelines[]` array
 *     (many-to-many: one trigger can start many pipelines and one pipeline can
 *     be started by many triggers).
 *   - 'single'   → a tumbling-window trigger references exactly ONE pipeline via
 *     the singular `pipeline` object (one-to-one).
 */
export type PipelineReferenceCardinality = 'multiple' | 'single';

export interface TriggerTypeDef {
  /** ADF trigger type, e.g. 'ScheduleTrigger'. The `properties.type` value. */
  type: TriggerKind;
  /** Display name shown on the trigger-type card, e.g. 'Schedule'. */
  displayName: string;
  /** A Fluent icon name (best-effort; the wizard maps it to a glyph). */
  icon?: string;
  /** One-line description shown under the display name on the type card. */
  description: string;
  /**
   * The structured config fields collected for this trigger's
   * `typeProperties`. Rendered by the same `ConfigField` form renderer the
   * connector catalog uses.
   */
  settings: ConfigField[];
  /**
   * Whether this trigger references one pipeline (`pipeline`, tumbling-window)
   * or many (`pipelines[]`, schedule/event). Drives the pipeline-reference UI.
   */
  pipelineReference: PipelineReferenceCardinality;
  /**
   * The trigger SYSTEM VARIABLES this type exposes for mapping onto pipeline
   * parameters (the "Trigger run parameters" pane). Each carries the ADF
   * expression to emit and a human label. e.g. the storage-event trigger
   * offers `@triggerBody().fileName` / `@triggerBody().folderPath`.
   */
  outputs: TriggerOutputVar[];
  /**
   * Whether the trigger supports backfill / past windows (tumbling-window only)
   * — surfaced as a hint in the UI.
   */
  supportsBackfill: boolean;
  /** Whether a retry policy applies (tumbling-window only). */
  supportsRetry: boolean;
  /** Whether per-window concurrency applies (tumbling-window only). */
  supportsConcurrency: boolean;
}

/**
 * A trigger system variable a pipeline parameter can be bound to. The
 * `expression` is the ADF expression string written into the trigger's
 * `parameters` map (e.g. `@triggerBody().fileName`); `synapseExpression` is the
 * Synapse-flavoured equivalent (Synapse uses `@trigger().outputs.body.*` where
 * ADF uses `@triggerBody().*`).
 */
export interface TriggerOutputVar {
  /** Short stable id (e.g. 'fileName'). */
  id: string;
  /** Human label shown in the mapping dropdown. */
  label: string;
  /** The ADF expression to emit (e.g. '@triggerBody().fileName'). */
  expression: string;
  /** The Synapse-flavoured equivalent, when it differs from ADF. */
  synapseExpression?: string;
  /** What the value carries at run time. */
  description: string;
}

// =============================================================================
// Reusable field fragments + option lists (verbatim from ADF docs).
// =============================================================================

/**
 * The five schedule-trigger recurrence frequencies (ADF: minute/hour/day/week/
 * month). Stored capitalised as the ARM schema expects ('Minute'…'Month').
 */
export const SCHEDULE_FREQUENCIES = ['Minute', 'Hour', 'Day', 'Week', 'Month'] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

/**
 * Tumbling-window frequencies — a STRICT subset: ARM
 * `TumblingWindowTriggerTypeProperties.frequency` allows only 'Minute' | 'Hour'
 * | 'Month'. (No Day/Week — the minimum interval is 15 minutes.)
 */
export const TUMBLING_FREQUENCIES = ['Minute', 'Hour', 'Month'] as const;
export type TumblingFrequency = (typeof TUMBLING_FREQUENCIES)[number];

/** Day-of-week values for the schedule `schedule.weekDays` array (week freq). */
export const WEEK_DAYS = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/**
 * A representative set of supported schedule-trigger time zones (the ADF portal
 * dropdown lists the full Windows time-zone catalog; these cover the common
 * ones, UTC default). The chosen `timeZone` affects startTime/endTime/schedule.
 */
export const TRIGGER_TIME_ZONES: { value: string; label: string }[] = [
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
  { value: 'Dateline Standard Time', label: '(UTC-12:00) International Date Line West' },
  { value: 'Hawaiian Standard Time', label: '(UTC-10:00) Hawaii' },
  { value: 'Alaskan Standard Time', label: '(UTC-09:00) Alaska' },
  { value: 'Pacific Standard Time', label: '(UTC-08:00) Pacific Time (US & Canada)' },
  { value: 'Mountain Standard Time', label: '(UTC-07:00) Mountain Time (US & Canada)' },
  { value: 'Central Standard Time', label: '(UTC-06:00) Central Time (US & Canada)' },
  { value: 'Eastern Standard Time', label: '(UTC-05:00) Eastern Time (US & Canada)' },
  { value: 'Atlantic Standard Time', label: '(UTC-04:00) Atlantic Time (Canada)' },
  { value: 'GMT Standard Time', label: '(UTC+00:00) Dublin, Edinburgh, Lisbon, London' },
  { value: 'Central European Standard Time', label: '(UTC+01:00) Belgrade, Bratislava, Budapest, Prague' },
  { value: 'W. Europe Standard Time', label: '(UTC+01:00) Amsterdam, Berlin, Rome, Vienna' },
  { value: 'GTB Standard Time', label: '(UTC+02:00) Athens, Bucharest' },
  { value: 'India Standard Time', label: '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi' },
  { value: 'China Standard Time', label: '(UTC+08:00) Beijing, Chongqing, Hong Kong' },
  { value: 'Tokyo Standard Time', label: '(UTC+09:00) Osaka, Sapporo, Tokyo' },
  { value: 'AUS Eastern Standard Time', label: '(UTC+10:00) Canberra, Melbourne, Sydney' },
];

const FREQUENCY_OPTIONS = SCHEDULE_FREQUENCIES.map((f) => ({ value: f, label: `Every ${f.toLowerCase()}` }));
const TUMBLING_FREQUENCY_OPTIONS = TUMBLING_FREQUENCIES.map((f) => ({ value: f, label: `Every ${f.toLowerCase()}` }));

/**
 * `startTime` — shared by Schedule + Tumbling-window. ISO-8601 datetime. For
 * UTC the format is `yyyy-MM-ddTHH:mm:ssZ`; for other zones it omits the `Z`.
 */
const START_TIME: ConfigField = {
  key: 'startTime',
  label: 'Start',
  kind: 'text',
  required: true,
  placeholder: '2026-01-01T00:00:00Z',
  hint: 'First occurrence (ISO-8601). UTC uses the trailing Z; other zones omit it.',
};
const END_TIME: ConfigField = {
  key: 'endTime',
  label: 'End (optional)',
  kind: 'text',
  placeholder: '2026-12-31T00:00:00Z',
  hint: 'The trigger stops firing after this time. Must be in the future. Leave blank for no end.',
};

// =============================================================================
// The trigger inventory — all four ADF/Synapse trigger types.
// =============================================================================

export const TRIGGER_TYPES: TriggerTypeDef[] = [
  // ----------------------------------------------------------- Schedule -----
  {
    type: 'ScheduleTrigger',
    displayName: 'Schedule',
    icon: 'CalendarClock',
    description:
      'Run on a wall-clock recurrence — every N minutes, hours, days, weeks, or months — with optional advanced hour/minute/weekday/month-day scheduling.',
    pipelineReference: 'multiple',
    supportsBackfill: false,
    supportsRetry: false,
    supportsConcurrency: false,
    settings: [
      {
        key: 'frequency',
        label: 'Recurrence',
        kind: 'select',
        required: true,
        options: FREQUENCY_OPTIONS,
        hint: 'The unit at which the trigger recurs.',
      },
      {
        key: 'interval',
        label: 'Interval',
        kind: 'number',
        required: true,
        placeholder: '1',
        hint: 'Positive integer. e.g. interval 3 + frequency Week = every 3 weeks. (1–1000.)',
      },
      START_TIME,
      END_TIME,
      {
        key: 'timeZone',
        label: 'Time zone',
        kind: 'select',
        required: true,
        options: TRIGGER_TIME_ZONES,
        hint: 'Affects start, end, and the advanced schedule. UTC opts out of daylight-saving shifts.',
      },
      // Advanced recurrence schedule — only meaningful for Day/Week/Month
      // frequencies (the portal hides these for Minute/Hour). Stored under
      // typeProperties.recurrence.schedule.{hours|minutes|weekDays|monthDays|monthlyOccurrences}.
      {
        key: 'scheduleHours',
        label: 'At hours',
        kind: 'text',
        placeholder: '0, 12',
        hint: 'Comma-separated hours of the day (0–23) at which to run. Maps to schedule.hours.',
        showIf: { key: 'frequency', equals: 'Day' },
      },
      {
        key: 'scheduleMinutes',
        label: 'At minutes',
        kind: 'text',
        placeholder: '0, 30',
        hint: 'Comma-separated minutes of the hour (0–59) at which to run. Maps to schedule.minutes.',
        showIf: { key: 'frequency', equals: 'Day' },
      },
      {
        key: 'scheduleWeekDays',
        label: 'On week days',
        kind: 'text',
        placeholder: 'Monday, Wednesday, Friday',
        hint: 'Comma-separated weekdays (Monday…Sunday) — weekly frequency only. Maps to schedule.weekDays.',
        showIf: { key: 'frequency', equals: 'Week' },
      },
      {
        key: 'scheduleMonthDays',
        label: 'On month days',
        kind: 'text',
        placeholder: '1, 15, -1',
        hint: 'Comma-separated day-of-month values (1…31, or -1…-31 counting from the end; -1 = last day). Monthly frequency only. Maps to schedule.monthDays.',
        showIf: { key: 'frequency', equals: 'Month' },
      },
      {
        key: 'scheduleMonthlyOccurrences',
        label: 'On monthly occurrences',
        kind: 'text',
        placeholder: 'friday:1, friday:-1',
        hint: 'Comma-separated day:occurrence pairs (e.g. friday:1 = first Friday, friday:-1 = last Friday). Monthly frequency only. Maps to schedule.monthlyOccurrences.',
        showIf: { key: 'frequency', equals: 'Month' },
      },
    ],
    outputs: [
      {
        id: 'scheduledTime',
        label: 'Scheduled time',
        expression: '@trigger().scheduledTime',
        description: 'The time the trigger was scheduled to invoke the run.',
      },
      {
        id: 'startTime',
        label: 'Actual start time',
        expression: '@trigger().startTime',
        description: 'The time the trigger actually fired (may differ slightly from scheduled).',
      },
    ],
  },

  // --------------------------------------------------- Tumbling window -----
  {
    type: 'TumblingWindowTrigger',
    displayName: 'Tumbling window',
    icon: 'CalendarDataBar',
    description:
      'Fixed-size, non-overlapping, contiguous time windows that retain state — with backfill, per-window concurrency, retry, and inter-trigger / self dependencies. References exactly one pipeline.',
    pipelineReference: 'single',
    supportsBackfill: true,
    supportsRetry: true,
    supportsConcurrency: true,
    settings: [
      {
        key: 'frequency',
        label: 'Recurrence',
        kind: 'select',
        required: true,
        options: TUMBLING_FREQUENCY_OPTIONS,
        hint: 'Window unit. Tumbling windows support only Minute, Hour, or Month.',
      },
      {
        key: 'interval',
        label: 'Interval',
        kind: 'number',
        required: true,
        placeholder: '1',
        hint: 'Window size in the chosen unit. Minimum 15 minutes. (Cannot be edited after publish.)',
      },
      { ...START_TIME, hint: 'Window series start (UTC only). Set in the past to backfill historical windows.' },
      { ...END_TIME, hint: 'Window series end (UTC only). Leave blank for an open-ended series.' },
      {
        key: 'delay',
        label: 'Delay',
        kind: 'text',
        placeholder: '00:00:00',
        hint: 'How long past the window end to wait before firing (timespan d.hh:mm:ss). Does not shift window start/end. Default 0.',
      },
      {
        key: 'maxConcurrency',
        label: 'Max concurrency',
        kind: 'number',
        required: true,
        placeholder: '1',
        hint: 'Parallel ready windows for which a run is triggered. 1–50.',
      },
      {
        key: 'retryCount',
        label: 'Retry count',
        kind: 'number',
        placeholder: '0',
        hint: 'Retries before a failed run is marked Failed. Maps to retryPolicy.count. Default 0.',
      },
      {
        key: 'retryIntervalInSeconds',
        label: 'Retry interval (seconds)',
        kind: 'number',
        placeholder: '30',
        hint: 'Delay between retry attempts (minimum 30s). Maps to retryPolicy.intervalInSeconds. Default 30.',
      },
      // Dependency on another tumbling-window trigger (or self). Optional. Maps
      // to typeProperties.dependsOn[] of DependencyReference. The dependency's
      // type discriminates self vs. other-trigger.
      {
        key: 'dependencyKind',
        label: 'Dependency',
        kind: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'self', label: 'Self-dependency (wait for prior windows of THIS trigger)' },
          { value: 'trigger', label: 'On another tumbling-window trigger' },
        ],
        hint: 'A tumbling-window trigger can depend on up to 5 other tumbling-window triggers (or itself).',
      },
      {
        key: 'dependencyTrigger',
        label: 'Depends on trigger',
        kind: 'text',
        placeholder: 'upstream-load-trigger',
        hint: 'Name of the tumbling-window trigger to wait on. Maps to dependsOn[].referenceTrigger / TumblingWindowTriggerDependencyReference.',
        showIf: { key: 'dependencyKind', equals: 'trigger' },
      },
      {
        key: 'dependencyOffset',
        label: 'Dependency offset',
        kind: 'text',
        placeholder: '-01:00:00',
        hint: 'Timespan (hh:mm:ss) applied to the window start when evaluating the dependency. Required & negative for a self-dependency; optional otherwise.',
        showIf: { key: 'dependencyKind', equals: 'self' },
      },
      {
        key: 'dependencyOffsetTrigger',
        label: 'Dependency offset',
        kind: 'text',
        placeholder: '-01:00:00',
        hint: 'Timespan (hh:mm:ss) applied to the dependency window start. Both positive and negative allowed. Maps to dependsOn[].offset.',
        showIf: { key: 'dependencyKind', equals: 'trigger' },
      },
      {
        key: 'dependencySize',
        label: 'Dependency size',
        kind: 'text',
        placeholder: '02:00:00',
        hint: 'Size of the dependency window (positive timespan hh:mm:ss). Optional — defaults to this trigger’s window size. Maps to dependsOn[].size.',
        showIf: { key: 'dependencyKind', equals: 'self' },
      },
      {
        key: 'dependencySizeTrigger',
        label: 'Dependency size',
        kind: 'text',
        placeholder: '02:00:00',
        hint: 'Size of the dependency window (positive timespan hh:mm:ss). Optional — defaults to this trigger’s window size. Maps to dependsOn[].size.',
        showIf: { key: 'dependencyKind', equals: 'trigger' },
      },
    ],
    outputs: [
      {
        id: 'windowStartTime',
        label: 'Window start time',
        expression: '@trigger().outputs.windowStartTime',
        description: 'Start of the window associated with this trigger run.',
      },
      {
        id: 'windowEndTime',
        label: 'Window end time',
        expression: '@trigger().outputs.windowEndTime',
        description: 'End of the window associated with this trigger run.',
      },
      {
        id: 'scheduledTime',
        label: 'Scheduled time',
        expression: '@trigger().scheduledTime',
        description: 'The time the trigger was scheduled to invoke the run.',
      },
      {
        id: 'startTime',
        label: 'Actual start time',
        expression: '@trigger().startTime',
        description: 'The time the trigger actually fired.',
      },
    ],
  },

  // --------------------------------------------------- Storage events ------
  {
    type: 'BlobEventsTrigger',
    displayName: 'Storage events',
    icon: 'CloudArrowUp',
    description:
      'React to blob created / deleted events on an Azure Storage account, filtered by path prefix/suffix. Captures the file name + folder path for the run.',
    pipelineReference: 'multiple',
    supportsBackfill: false,
    supportsRetry: false,
    supportsConcurrency: false,
    settings: [
      {
        key: 'scope',
        label: 'Storage account (resource ID)',
        kind: 'text',
        required: true,
        placeholder: '/subscriptions/…/resourceGroups/…/providers/Microsoft.Storage/storageAccounts/myadls',
        hint: 'The ARM resource ID of the Storage account the events come from. Pick the storage account via the linked-service picker, which resolves the account resource ID.',
      },
      {
        key: 'blobPathBeginsWith',
        label: 'Blob path begins with',
        kind: 'text',
        placeholder: '/sample-data/event-testing/',
        hint: 'First segment is the container. e.g. /records/blobs/december/ fires only for blobs under that folder. Provide at least one of begins-with / ends-with.',
        supportsDynamic: true,
      },
      {
        key: 'blobPathEndsWith',
        label: 'Blob path ends with',
        kind: 'text',
        placeholder: '.csv',
        hint: 'e.g. .csv, or december/boxes.csv. Provide at least one of begins-with / ends-with.',
        supportsDynamic: true,
      },
      {
        key: 'eventBlobCreated',
        label: 'On blob created (Microsoft.Storage.BlobCreated)',
        kind: 'boolean',
        hint: 'Fire when a blob is created/overwritten.',
      },
      {
        key: 'eventBlobDeleted',
        label: 'On blob deleted (Microsoft.Storage.BlobDeleted)',
        kind: 'boolean',
        hint: 'Fire when a blob is deleted. Select at least one event.',
      },
      {
        key: 'ignoreEmptyBlobs',
        label: 'Ignore empty blobs',
        kind: 'boolean',
        hint: 'When on, zero-byte blobs do not fire the trigger. Default true.',
      },
    ],
    outputs: [
      {
        id: 'fileName',
        label: 'File name',
        expression: '@triggerBody().fileName',
        synapseExpression: '@trigger().outputs.body.fileName',
        description: 'Name of the file whose create/delete fired the trigger.',
      },
      {
        id: 'folderPath',
        label: 'Folder path',
        expression: '@triggerBody().folderPath',
        synapseExpression: '@trigger().outputs.body.folderPath',
        description: 'Folder containing the file (first segment is the container).',
      },
      {
        id: 'startTime',
        label: 'Trigger start time',
        expression: '@trigger().startTime',
        description: 'The time the trigger fired.',
      },
    ],
  },

  // ---------------------------------------------------- Custom events ------
  {
    type: 'CustomEventsTrigger',
    displayName: 'Custom events',
    icon: 'Flash',
    description:
      'React to custom Azure Event Grid topic events (Event Grid event schema), filtered by event type and subject prefix/suffix. Parses the event data payload into pipeline parameters.',
    pipelineReference: 'multiple',
    supportsBackfill: false,
    supportsRetry: false,
    supportsConcurrency: false,
    settings: [
      {
        key: 'scope',
        label: 'Event Grid topic (resource ID)',
        kind: 'text',
        required: true,
        placeholder: '/subscriptions/…/resourceGroups/…/providers/Microsoft.EventGrid/topics/myTopic',
        hint: 'The ARM resource ID of the custom Event Grid topic. The topic must already exist — Data Factory does not create it.',
      },
      {
        key: 'events',
        label: 'Event types',
        kind: 'text',
        required: true,
        placeholder: 'copyCompleted, copySucceeded',
        hint: 'Comma-separated event types (case-insensitive). OR relationship — any match fires the trigger. At least one is required.',
      },
      {
        key: 'subjectBeginsWith',
        label: 'Subject begins with',
        kind: 'text',
        placeholder: 'factories',
        hint: 'The event subject must begin with this pattern. Optional.',
        supportsDynamic: true,
      },
      {
        key: 'subjectEndsWith',
        label: 'Subject ends with',
        kind: 'text',
        placeholder: '.json',
        hint: 'The event subject must end with this pattern. Optional.',
        supportsDynamic: true,
      },
    ],
    outputs: [
      {
        id: 'eventType',
        label: 'Event type',
        expression: '@triggerBody().event.eventType',
        synapseExpression: '@trigger().outputs.body.event.eventType',
        description: 'The custom event type that fired the trigger.',
      },
      {
        id: 'subject',
        label: 'Subject',
        expression: '@triggerBody().event.subject',
        synapseExpression: '@trigger().outputs.body.event.subject',
        description: 'Subject of the custom event that fired the trigger.',
      },
      {
        id: 'data',
        label: 'Data field (data.<keyName>)',
        expression: '@triggerBody().event.data.keyName',
        synapseExpression: '@trigger().outputs.body.event.data.keyName',
        description:
          'A field from the event data payload (free-form JSON). Replace keyName with your field, e.g. @triggerBody().event.data.callback. A missing referenced key fails the trigger run.',
      },
      {
        id: 'startTime',
        label: 'Trigger start time',
        expression: '@trigger().startTime',
        description: 'The time the trigger fired.',
      },
    ],
  },
];

/** Look up a trigger type definition by its `properties.type` discriminator. */
export function triggerTypeByKey(type: string): TriggerTypeDef | undefined {
  return TRIGGER_TYPES.find((t) => t.type === type);
}

// =============================================================================
// Pipeline-reference + trigger-parameters model.
//
// A trigger references pipeline(s) and supplies each run a `parameters` map.
// The map VALUES are usually trigger SYSTEM VARIABLES (the `outputs` above)
// mapped onto the pipeline's declared parameters — e.g. for a storage-event
// trigger, mapping the pipeline parameter `sourceFile` to
// `@triggerBody().fileName`. These models are the structured shape the wizard
// builds and the BFF round-trips onto `properties.pipelines[]` / `pipeline`.
// =============================================================================

/** A single pipeline parameter binding: pipeline param name → ADF expression / literal. */
export interface TriggerParameterMapping {
  /** The pipeline parameter name (must be declared on the referenced pipeline). */
  parameterName: string;
  /**
   * The value supplied to that parameter each run. Typically a trigger system
   * variable expression (e.g. '@triggerBody().fileName') but may be a literal.
   */
  value: unknown;
}

/**
 * A pipeline reference on a trigger. For schedule/event triggers this is one
 * entry in `properties.pipelines[]`; for tumbling-window it is the singular
 * `properties.pipeline`. `parameters` maps the pipeline's declared parameters
 * to trigger system variables / literals.
 */
export interface TriggerPipelineReference {
  /** Name of the ADF/Synapse pipeline this trigger starts. */
  pipelineName: string;
  /** Pipeline parameter bindings (param name → trigger-output expression / literal). */
  parameters: TriggerParameterMapping[];
}

/**
 * Build the ARM `pipelines[]` / `pipeline` reference object(s) from a list of
 * `TriggerPipelineReference`. `cardinality` follows the trigger type:
 *   - 'multiple' → returns `{ pipelines: [ { pipelineReference, parameters } ] }`
 *   - 'single'   → returns `{ pipeline:  { pipelineReference, parameters } }`
 *     (first reference only; tumbling-window is one-to-one)
 *
 * `parameters` is ALWAYS emitted (an empty `{}` when there are no bindings) —
 * ADF requires the `parameters` property on a pipeline reference even when the
 * pipeline takes no parameters.
 */
export function buildPipelineReferences(
  refs: TriggerPipelineReference[],
  cardinality: PipelineReferenceCardinality,
): Record<string, unknown> {
  const toRef = (r: TriggerPipelineReference) => ({
    pipelineReference: { referenceName: r.pipelineName, type: 'PipelineReference' as const },
    parameters: Object.fromEntries((r.parameters || []).map((p) => [p.parameterName, p.value])),
  });
  if (cardinality === 'single') {
    const first = refs[0];
    return first ? { pipeline: toRef(first) } : {};
  }
  return { pipelines: refs.map(toRef) };
}

// =============================================================================
// PARAMETER type model — the ADF/Synapse pipeline-parameter types.
//
// Matches the existing `PipelineParameterType` /  `PipelineParameter` shape in
// lib/components/pipeline/types.ts so this catalog and the editor agree on the
// wire format. ADF parameter types: String, Int, Float, Bool, Array, Object,
// SecureString. (The pipeline JSON stores the type lower-cased for the simple
// types — 'string','int','float','bool','array','object' — and 'secureString'.)
// =============================================================================

export const PARAMETER_TYPES = [
  'String', 'Int', 'Float', 'Bool', 'Array', 'Object', 'SecureString',
] as const;
export type ParameterTypeName = (typeof PARAMETER_TYPES)[number];

/** Display-name → ADF wire value (the value written into pipeline JSON). */
export const PARAMETER_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'int', label: 'Int' },
  { value: 'float', label: 'Float' },
  { value: 'bool', label: 'Bool' },
  { value: 'array', label: 'Array' },
  { value: 'object', label: 'Object' },
  { value: 'secureString', label: 'SecureString' },
];

/**
 * A pipeline parameter. `defaultValue` may itself be an ADF `@{…}` expression
 * (e.g. `@pipeline().globalParameters.env`) — the `ExpressionField` wires the
 * "Add dynamic content" affordance for the default-value control.
 */
export interface PipelineParameterModel {
  name: string;
  /** ADF wire value: 'string'|'int'|'float'|'bool'|'array'|'object'|'secureString'. */
  type: string;
  /** Optional default. May be a literal OR an @{…} expression. */
  defaultValue?: unknown;
}

// =============================================================================
// VARIABLE type model — the ADF/Synapse pipeline-variable types.
//
// ADF pipeline VARIABLES are a strict subset of the parameter types: String,
// Boolean, Array (set/appended via SetVariable / AppendVariable). Matches the
// existing `PipelineVariable` shape in lib/components/pipeline/types.ts.
// =============================================================================

export const VARIABLE_TYPES = ['String', 'Boolean', 'Array'] as const;
export type VariableTypeName = (typeof VARIABLE_TYPES)[number];

export const VARIABLE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'String', label: 'String' },
  { value: 'Boolean', label: 'Boolean' },
  { value: 'Array', label: 'Array' },
];

/** A pipeline variable. */
export interface PipelineVariableModel {
  name: string;
  type: VariableTypeName;
  /** Optional initial value (a literal — variables are not expression-defaulted in ADF). */
  defaultValue?: unknown;
}
