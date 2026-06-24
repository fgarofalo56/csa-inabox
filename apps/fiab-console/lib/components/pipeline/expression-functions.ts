/**
 * ADF / Synapse / Fabric pipeline expression-language catalog.
 *
 * Single source of truth for the "Add dynamic content" experience (see
 * dynamic-content.tsx): the function reference, system variables, and the
 * Monaco IntelliSense completion list all derive from this. Grounded in the
 * documented Data Factory expression language — the SAME functions the Azure
 * portal's expression builder exposes:
 *   https://learn.microsoft.com/azure/data-factory/control-flow-expression-language-functions
 *   https://learn.microsoft.com/azure/data-factory/control-flow-system-variables
 *
 * Per .claude/rules/ui-parity.md this is a one-for-one of the portal's
 * function picker — every category and function the Azure UI lists is here so
 * users select + insert instead of hand-writing the @{...} JSON.
 *
 * Expressions are stored verbatim as ADF interpolated strings (`@…` / `@{…}`)
 * in the pipeline / dataset / linked-service JSON and round-trip on the real
 * PUT via adf-client / synapse-artifacts-client. This catalog only drives the
 * authoring UX — the strings it inserts are exactly what the portal would
 * write, so they execute identically on the real ADF / Synapse runtime.
 *
 * Coverage (every category in the Learn reference):
 *   String · Collection · Logical comparison · Conversion · Math · Date ·
 *   Binary & encoding · URI / Data-URI · XML · Workflow (pipeline()/activity()/
 *   item()/trigger()/variables()). Type-checking note: ADF has no `is*`
 *   functions — type checks are done with `equals(type(x), …)`-style idioms in
 *   data flows, NOT the pipeline expression language; the pipeline-language
 *   conversion functions (`bool`/`int`/`float`/`string`/`json`/`array`) cover
 *   coercion, and they're all enumerated below.
 */

// ============================================================
// Function catalog
// ============================================================

/** Stable category identifiers — used for grouping + the picker accordion. */
export type ExprCategoryId =
  | 'string'
  | 'collection'
  | 'logical'
  | 'conversion'
  | 'math'
  | 'date'
  | 'binary'
  | 'uri'
  | 'workflow';

export interface ExprFunction {
  /** Function name as written in an expression, e.g. `concat`. */
  name: string;
  /** Category this function belongs to (back-reference for the flat list). */
  category: ExprCategoryId;
  /** Argument signature for the hover/intellisense detail. */
  signature: string;
  /** One-line description. */
  description: string;
  /**
   * Snippet inserted at the cursor. The leading `@` is added by the field when
   * needed (see dynamic-content.tsx), so templates here are bare function
   * calls, e.g. `concat(<text1>, <text2>)`.
   */
  insert: string;
}

export interface ExprCategory {
  id: ExprCategoryId;
  label: string;
  /** Short description of the category (shown as a caption in the picker). */
  hint: string;
  functions: ExprFunction[];
}

// Per-category factory binds the category id onto every function so the flat
// list / search can report it without a second lookup.
const cat = (category: ExprCategoryId) =>
  (name: string, signature: string, description: string, insert?: string): ExprFunction => ({
    name,
    category,
    signature,
    description,
    insert: insert ?? `${name}()`,
  });

const sFn = cat('string');
const cFn = cat('collection');
const lFn = cat('logical');
const vFn = cat('conversion');
const mFn = cat('math');
const dFn = cat('date');
const bFn = cat('binary');
const uFn = cat('uri');
const wFn = cat('workflow');

export const EXPRESSION_CATEGORIES: ExprCategory[] = [
  {
    id: 'string',
    label: 'String functions',
    hint: 'Work with text. String functions operate only on strings.',
    functions: [
      sFn('concat', 'concat(<text1>, <text2>, ...)', 'Combine two or more strings and return the combined string.', 'concat(, )'),
      sFn('endsWith', 'endsWith(<text>, <searchText>)', 'Check whether a string ends with the specified substring.', 'endsWith(, )'),
      sFn('guid', "guid(<format>?)", 'Generate a globally unique identifier (GUID) as a string.', 'guid()'),
      sFn('indexOf', 'indexOf(<text>, <searchText>)', 'Return the starting position (0-based) for a substring, or -1.', 'indexOf(, )'),
      sFn('lastIndexOf', 'lastIndexOf(<text>, <searchText>)', 'Return the starting position for the last occurrence of a substring, or -1.', 'lastIndexOf(, )'),
      sFn('replace', 'replace(<text>, <oldText>, <newText>)', 'Replace a substring with the specified string and return the updated string.', 'replace(, , )'),
      sFn('split', 'split(<text>, <delimiter>)', 'Split a string at each delimiter and return the substrings as an array.', 'split(, )'),
      sFn('startsWith', 'startsWith(<text>, <searchText>)', 'Check whether a string starts with a specific substring.', 'startsWith(, )'),
      sFn('substring', 'substring(<text>, <startIndex>, <length>)', 'Return characters from a string, starting at the specified position.', 'substring(, , )'),
      sFn('toLower', 'toLower(<text>)', 'Return a string in lowercase format.', 'toLower()'),
      sFn('toUpper', 'toUpper(<text>)', 'Return a string in uppercase format.', 'toUpper()'),
      sFn('trim', 'trim(<text>)', 'Remove leading and trailing whitespace and return the updated string.', 'trim()'),
    ],
  },
  {
    id: 'collection',
    label: 'Collection functions',
    hint: 'Work with collections — generally arrays, strings, and dictionaries.',
    functions: [
      cFn('contains', 'contains(<collection>, <value>)', 'Check whether a collection has a specific item.', 'contains(, )'),
      cFn('empty', 'empty(<collection>)', 'Check whether a collection is empty.', 'empty()'),
      cFn('first', 'first(<collection>)', 'Return the first item from a collection.', 'first()'),
      cFn('intersection', 'intersection(<collection1>, <collection2>, ...)', 'Return a collection of items common to ALL the specified collections.', 'intersection(, )'),
      cFn('join', 'join(<collection>, <delimiter>)', 'Return a string with all items from an array joined by the delimiter.', 'join(, )'),
      cFn('last', 'last(<collection>)', 'Return the last item from a collection.', 'last()'),
      cFn('length', 'length(<collection>)', 'Return the number of items in a string or array.', 'length()'),
      cFn('skip', 'skip(<collection>, <count>)', 'Remove items from the front of a collection and return the rest.', 'skip(, )'),
      cFn('take', 'take(<collection>, <count>)', 'Return the first <count> items from the front of a collection.', 'take(, )'),
      cFn('union', 'union(<collection1>, <collection2>, ...)', 'Return a collection with ALL items from the specified collections (deduplicated).', 'union(, )'),
    ],
  },
  {
    id: 'logical',
    label: 'Logical comparison functions',
    hint: 'Evaluate conditions — useful inside If / Until / Switch activities.',
    functions: [
      lFn('and', 'and(<expression1>, <expression2>)', 'Check whether both expressions are true.', 'and(, )'),
      lFn('equals', 'equals(<object1>, <object2>)', 'Check whether both values are equivalent.', 'equals(, )'),
      lFn('greater', 'greater(<value>, <compareTo>)', 'Check whether the first value is greater than the second.', 'greater(, )'),
      lFn('greaterOrEquals', 'greaterOrEquals(<value>, <compareTo>)', 'Check whether the first value is greater than or equal to the second.', 'greaterOrEquals(, )'),
      lFn('if', 'if(<expression>, <valueIfTrue>, <valueIfFalse>)', 'Return one of two values based on whether an expression is true.', 'if(, , )'),
      lFn('less', 'less(<value>, <compareTo>)', 'Check whether the first value is less than the second.', 'less(, )'),
      lFn('lessOrEquals', 'lessOrEquals(<value>, <compareTo>)', 'Check whether the first value is less than or equal to the second.', 'lessOrEquals(, )'),
      lFn('not', 'not(<expression>)', 'Check whether an expression is false.', 'not()'),
      lFn('or', 'or(<expression1>, <expression2>)', 'Check whether at least one expression is true.', 'or(, )'),
    ],
  },
  {
    id: 'conversion',
    label: 'Conversion functions',
    hint: 'Convert between native types — string, integer, float, boolean, array, dictionary.',
    functions: [
      vFn('array', "array(<value>)", 'Return an array from a single specified input. For multiple inputs use createArray.', 'array()'),
      vFn('bool', 'bool(<value>)', 'Return the Boolean version for an input value.', 'bool()'),
      vFn('coalesce', 'coalesce(<object1>, <object2>, ...)', 'Return the first non-null value from one or more parameters.', 'coalesce(, )'),
      vFn('createArray', 'createArray(<object1>, <object2>, ...)', 'Return an array from multiple inputs.', 'createArray(, )'),
      vFn('float', "float(<value>)", 'Return a floating-point number for an input value.', 'float()'),
      vFn('int', "int(<value>)", 'Return the integer version for a string.', 'int()'),
      vFn('json', "json(<value>)", 'Return the JSON type value or object for a string or XML.', 'json()'),
      vFn('string', 'string(<value>)', 'Return the string version for an input value.', 'string()'),
      vFn('xml', "xml(<value>)", 'Return the XML version for a string.', 'xml()'),
      vFn('xpath', "xpath(<xml>, <xpath>)", 'Match nodes or values in XML against an XPath expression, and return the matches.', 'xpath(, )'),
    ],
  },
  {
    id: 'math',
    label: 'Math functions',
    hint: 'Operate on integers and floats.',
    functions: [
      mFn('add', 'add(<summand1>, <summand2>)', 'Return the result of adding two numbers.', 'add(, )'),
      mFn('div', 'div(<dividend>, <divisor>)', 'Return the result of dividing one number by another.', 'div(, )'),
      mFn('max', 'max(<number1>, <number2>, ...)', 'Return the highest value from a set of numbers or an array.', 'max(, )'),
      mFn('min', 'min(<number1>, <number2>, ...)', 'Return the lowest value from a set of numbers or an array.', 'min(, )'),
      mFn('mod', 'mod(<dividend>, <divisor>)', 'Return the remainder from dividing one number by another.', 'mod(, )'),
      mFn('mul', 'mul(<multiplicand1>, <multiplicand2>)', 'Return the product from multiplying two numbers.', 'mul(, )'),
      mFn('rand', 'rand(<minValue>, <maxValue>)', 'Return a random integer from a range (min inclusive, max exclusive).', 'rand(, )'),
      mFn('range', 'range(<startIndex>, <count>)', 'Return an integer array starting from a specified integer.', 'range(, )'),
      mFn('sub', 'sub(<minuend>, <subtrahend>)', 'Return the result of subtracting one number from another.', 'sub(, )'),
    ],
  },
  {
    id: 'date',
    label: 'Date functions',
    hint: 'Work with timestamps. All trigger date/time values are UTC ISO 8601.',
    functions: [
      dFn('addDays', "addDays(<timestamp>, <days>, <format>?)", 'Add a number of days to a timestamp.', 'addDays(, )'),
      dFn('addHours', "addHours(<timestamp>, <hours>, <format>?)", 'Add a number of hours to a timestamp.', 'addHours(, )'),
      dFn('addMinutes', "addMinutes(<timestamp>, <minutes>, <format>?)", 'Add a number of minutes to a timestamp.', 'addMinutes(, )'),
      dFn('addSeconds', "addSeconds(<timestamp>, <seconds>, <format>?)", 'Add a number of seconds to a timestamp.', 'addSeconds(, )'),
      dFn('addToTime', "addToTime(<timestamp>, <interval>, <timeUnit>, <format>?)", 'Add a number of time units to a timestamp. See also getFutureTime.', "addToTime(, , 'Day')"),
      dFn('convertFromUtc', "convertFromUtc(<timestamp>, <destinationTimeZone>, <format>?)", 'Convert a timestamp from UTC to the target time zone.', "convertFromUtc(, 'Pacific Standard Time')"),
      dFn('convertTimeZone', "convertTimeZone(<timestamp>, <sourceTimeZone>, <destinationTimeZone>, <format>?)", 'Convert a timestamp from the source time zone to the target time zone.', "convertTimeZone(, 'UTC', 'Pacific Standard Time')"),
      dFn('convertToUtc', "convertToUtc(<timestamp>, <sourceTimeZone>, <format>?)", 'Convert a timestamp from the source time zone to UTC.', "convertToUtc(, 'Pacific Standard Time')"),
      dFn('dayOfMonth', "dayOfMonth(<timestamp>)", 'Return the day-of-month component from a timestamp.', 'dayOfMonth()'),
      dFn('dayOfWeek', "dayOfWeek(<timestamp>)", 'Return the day-of-week component (0 = Sunday) from a timestamp.', 'dayOfWeek()'),
      dFn('dayOfYear', "dayOfYear(<timestamp>)", 'Return the day-of-year component from a timestamp.', 'dayOfYear()'),
      dFn('formatDateTime', "formatDateTime(<timestamp>, <format>?)", 'Return the timestamp as a string in an optional .NET format.', "formatDateTime(, 'yyyy-MM-dd')"),
      dFn('getFutureTime', "getFutureTime(<interval>, <timeUnit>, <format>?)", 'Return the current timestamp plus the specified time units. See also addToTime.', "getFutureTime(5, 'Day')"),
      dFn('getPastTime', "getPastTime(<interval>, <timeUnit>, <format>?)", 'Return the current timestamp minus the specified time units. See also subtractFromTime.', "getPastTime(5, 'Day')"),
      dFn('startOfDay', "startOfDay(<timestamp>, <format>?)", 'Return the start of the day for a timestamp.', 'startOfDay()'),
      dFn('startOfHour', "startOfHour(<timestamp>, <format>?)", 'Return the start of the hour for a timestamp.', 'startOfHour()'),
      dFn('startOfMonth', "startOfMonth(<timestamp>, <format>?)", 'Return the start of the month for a timestamp.', 'startOfMonth()'),
      dFn('subtractFromTime', "subtractFromTime(<timestamp>, <interval>, <timeUnit>, <format>?)", 'Subtract a number of time units from a timestamp. See also getPastTime.', "subtractFromTime(, 1, 'Day')"),
      dFn('ticks', "ticks(<timestamp>)", "Return the ticks property (100-ns intervals since 0001-01-01) for a timestamp.", 'ticks()'),
      dFn('utcNow', "utcNow(<format>?)", 'Return the current timestamp as a string (UTC).', 'utcNow()'),
    ],
  },
  {
    id: 'binary',
    label: 'Binary & encoding functions',
    hint: 'Convert to/from binary, Base64, and string encodings.',
    functions: [
      bFn('base64', "base64(<value>)", 'Return the Base64-encoded version of a string.', 'base64()'),
      bFn('base64ToBinary', "base64ToBinary(<value>)", 'Return the binary version of a Base64-encoded string.', 'base64ToBinary()'),
      bFn('base64ToString', "base64ToString(<value>)", 'Return the string version of a Base64-encoded string.', 'base64ToString()'),
      bFn('binary', "binary(<value>)", 'Return the binary version of an input value.', 'binary()'),
      bFn('decodeBase64', "decodeBase64(<value>)", 'Return the string version of a Base64-encoded string.', 'decodeBase64()'),
    ],
  },
  {
    id: 'uri',
    label: 'URI & data-URI functions',
    hint: 'Encode/decode URI components and data URIs.',
    functions: [
      uFn('dataUri', "dataUri(<value>)", 'Return the data URI for an input value.', 'dataUri()'),
      uFn('dataUriToBinary', "dataUriToBinary(<value>)", 'Return the binary version of a data URI.', 'dataUriToBinary()'),
      uFn('dataUriToString', "dataUriToString(<value>)", 'Return the string version of a data URI.', 'dataUriToString()'),
      uFn('decodeDataUri', "decodeDataUri(<value>)", 'Return the binary version of a data URI.', 'decodeDataUri()'),
      uFn('decodeUriComponent', "decodeUriComponent(<value>)", 'Replace escape characters in a string with decoded versions.', 'decodeUriComponent()'),
      uFn('encodeUriComponent', "encodeUriComponent(<value>)", 'Replace URL-unsafe characters in a string with escape characters.', 'encodeUriComponent()'),
      uFn('uriComponent', "uriComponent(<value>)", 'Return the URI-encoded version of an input value.', 'uriComponent()'),
      uFn('uriComponentToBinary', "uriComponentToBinary(<value>)", 'Return the binary version of a URI-encoded string.', 'uriComponentToBinary()'),
      uFn('uriComponentToString', "uriComponentToString(<value>)", 'Return the string version of a URI-encoded string.', 'uriComponentToString()'),
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow / runtime functions',
    hint: 'Reference the pipeline run, activity outputs, the iteration item, and the trigger.',
    functions: [
      wFn('pipeline', 'pipeline()', 'Reference the current pipeline run — then a system variable, e.g. pipeline().RunId or pipeline().parameters.X.', 'pipeline().'),
      wFn('activity', "activity(<activityName>)", "Reference another activity's run output, e.g. activity('Copy data').output.", "activity('').output"),
      wFn('variables', "variables(<variableName>)", 'Reference a pipeline variable by name.', "variables('')"),
      wFn('item', 'item()', 'Reference the current item inside a ForEach loop.', 'item()'),
      wFn('iterationItem', 'iterationItem()', 'Reference the current item of an inner ForEach when nested loops both use item().', 'iterationItem()'),
      wFn('trigger', 'trigger()', 'Reference the trigger that started the run, e.g. trigger().startTime or trigger().outputs.windowStartTime.', 'trigger().'),
    ],
  },
];

// ============================================================
// Flat searchable list + helpers
// ============================================================

/** Every function across all categories, flattened (with its category id). */
export const ALL_FUNCTIONS: ExprFunction[] = EXPRESSION_CATEGORIES.flatMap((c) => c.functions);

/** Map of category id -> category for O(1) lookup. */
const CATEGORY_BY_ID: Record<string, ExprCategory> = Object.fromEntries(
  EXPRESSION_CATEGORIES.map((c) => [c.id, c]),
);

/**
 * Return the categorized catalog (optionally a single category by id).
 * `functionsByCategory()` -> all categories; `functionsByCategory('date')` ->
 * just the Date functions array (or [] for an unknown id).
 */
export function functionsByCategory(): ExprCategory[];
export function functionsByCategory(id: ExprCategoryId): ExprFunction[];
export function functionsByCategory(id?: ExprCategoryId): ExprCategory[] | ExprFunction[] {
  if (id === undefined) return EXPRESSION_CATEGORIES;
  return CATEGORY_BY_ID[id]?.functions ?? [];
}

/**
 * Case-insensitive search over the flat function list by name, signature, or
 * description. An empty / whitespace query returns the whole catalog so the
 * picker can show everything by default.
 */
export function searchFunctions(query: string): ExprFunction[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return ALL_FUNCTIONS;
  return ALL_FUNCTIONS.filter(
    (fn) =>
      fn.name.toLowerCase().includes(q) ||
      fn.signature.toLowerCase().includes(q) ||
      fn.description.toLowerCase().includes(q),
  );
}

// ============================================================
// System-variable catalog
// ============================================================

/** Scope a system variable applies to — drives where the picker offers it. */
export type SystemVariableScope =
  | 'pipeline'
  | 'scheduleTrigger'
  | 'tumblingWindowTrigger'
  | 'storageEventTrigger'
  | 'iteration';

/** System variable — the `@pipeline().*` / `@trigger().*` / `@item()` set the portal lists. */
export interface SystemVariable {
  /** Full token as written, e.g. `@pipeline().RunId`. */
  name: string;
  /** Scope this variable belongs to. */
  scope: SystemVariableScope;
  description: string;
  /** Snippet inserted at the cursor (leading `@` added by the field). */
  insert: string;
}

/**
 * Full system-variable catalog grounded in
 * https://learn.microsoft.com/azure/data-factory/control-flow-system-variables
 *
 * Pipeline scope (referenceable anywhere in the pipeline JSON); Schedule- and
 * Tumbling-window-trigger scope (referenceable in the trigger JSON); Storage-
 * event-trigger scope; plus the ForEach iteration accessor `@item()`.
 */
export const SYSTEM_VARIABLES: SystemVariable[] = [
  // ---- Pipeline scope ----
  { name: '@pipeline().DataFactory', scope: 'pipeline', description: 'Name of the data factory / Synapse workspace the run is in.', insert: 'pipeline().DataFactory' },
  { name: '@pipeline().Pipeline', scope: 'pipeline', description: 'Name of the pipeline.', insert: 'pipeline().Pipeline' },
  { name: '@pipeline().RunId', scope: 'pipeline', description: 'ID (GUID) of the specific pipeline run.', insert: 'pipeline().RunId' },
  { name: '@pipeline().TriggerType', scope: 'pipeline', description: 'Type of the trigger that invoked the pipeline (Manual, ScheduleTrigger, BlobEventsTrigger, …).', insert: 'pipeline().TriggerType' },
  { name: '@pipeline().TriggerId', scope: 'pipeline', description: 'ID of the trigger that invoked the pipeline.', insert: 'pipeline().TriggerId' },
  { name: '@pipeline().TriggerName', scope: 'pipeline', description: 'Name of the trigger that invoked the pipeline.', insert: 'pipeline().TriggerName' },
  { name: '@pipeline().TriggerTime', scope: 'pipeline', description: 'Time the trigger actually fired the run (UTC ISO 8601).', insert: 'pipeline().TriggerTime' },
  { name: '@pipeline().GroupId', scope: 'pipeline', description: 'ID of the group the pipeline run belongs to.', insert: 'pipeline().GroupId' },
  { name: '@pipeline().parameters', scope: 'pipeline', description: "Access a pipeline parameter by name, e.g. pipeline().parameters.myParam.", insert: 'pipeline().parameters.' },
  { name: '@pipeline()?.TriggeredByPipelineName', scope: 'pipeline', description: 'Name of the parent pipeline (Execute Pipeline activity); null otherwise. Note the null-safe `?.`.', insert: 'pipeline()?.TriggeredByPipelineName' },
  { name: '@pipeline()?.TriggeredByPipelineRunId', scope: 'pipeline', description: 'Run ID of the parent pipeline (Execute Pipeline activity); null otherwise. Note the null-safe `?.`.', insert: 'pipeline()?.TriggeredByPipelineRunId' },

  // ---- Schedule trigger scope ----
  { name: '@trigger().scheduledTime', scope: 'scheduleTrigger', description: 'Time at which the trigger was scheduled to invoke the run.', insert: 'trigger().scheduledTime' },
  { name: '@trigger().startTime', scope: 'scheduleTrigger', description: 'Time at which the trigger actually fired (may differ slightly from scheduledTime).', insert: 'trigger().startTime' },

  // ---- Tumbling-window trigger scope ----
  { name: '@trigger().outputs.windowStartTime', scope: 'tumblingWindowTrigger', description: 'Start of the window associated with the tumbling-window trigger run.', insert: 'trigger().outputs.windowStartTime' },
  { name: '@trigger().outputs.windowEndTime', scope: 'tumblingWindowTrigger', description: 'End of the window associated with the tumbling-window trigger run.', insert: 'trigger().outputs.windowEndTime' },

  // ---- Storage-event trigger scope ----
  { name: '@triggerBody().fileName', scope: 'storageEventTrigger', description: 'Name of the file whose creation/deletion fired the event trigger. (Synapse: use @trigger().outputs.body.fileName.)', insert: 'triggerBody().fileName' },
  { name: '@triggerBody().folderPath', scope: 'storageEventTrigger', description: 'Folder path containing the file; first segment is the blob container. (Synapse: use @trigger().outputs.body.folderPath.)', insert: 'triggerBody().folderPath' },

  // ---- ForEach iteration scope ----
  { name: '@item()', scope: 'iteration', description: 'Current item of the enclosing ForEach loop.', insert: 'item()' },
  { name: '@iterationItem()', scope: 'iteration', description: 'Current item of an inner ForEach when nested loops would otherwise both use item().', insert: 'iterationItem()' },
];

/** System variables grouped by scope, for a scope-aware picker. */
export interface SystemVariableScopeGroup {
  scope: SystemVariableScope;
  label: string;
  variables: SystemVariable[];
}

const SCOPE_LABELS: Record<SystemVariableScope, string> = {
  pipeline: 'Pipeline scope',
  scheduleTrigger: 'Schedule trigger scope',
  tumblingWindowTrigger: 'Tumbling-window trigger scope',
  storageEventTrigger: 'Storage-event trigger scope',
  iteration: 'ForEach iteration',
};

/** Return the system variables grouped by scope (only non-empty groups). */
export function systemVariablesByScope(): SystemVariableScopeGroup[] {
  return (Object.keys(SCOPE_LABELS) as SystemVariableScope[])
    .map((scope) => ({
      scope,
      label: SCOPE_LABELS[scope],
      variables: SYSTEM_VARIABLES.filter((v) => v.scope === scope),
    }))
    .filter((g) => g.variables.length > 0);
}

/** Case-insensitive search over system variables by name or description. */
export function searchSystemVariables(query: string): SystemVariable[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return SYSTEM_VARIABLES;
  return SYSTEM_VARIABLES.filter(
    (v) => v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q),
  );
}

// ============================================================
// IntelliSense seeds
// ============================================================

/** All function names — used to seed Monaco IntelliSense keywords. */
export function allFunctionNames(): string[] {
  return ALL_FUNCTIONS.map((fn) => fn.name);
}

/** All system-variable insert tokens — used to seed Monaco IntelliSense. */
export function allSystemVariableInserts(): string[] {
  return SYSTEM_VARIABLES.map((v) => v.insert);
}
