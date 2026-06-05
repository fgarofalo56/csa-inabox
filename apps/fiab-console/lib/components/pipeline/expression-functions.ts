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
 */

export interface ExprFunction {
  /** Function name as written in an expression, e.g. `concat`. */
  name: string;
  /** Argument signature for the hover/intellisense detail. */
  signature: string;
  /** One-line description. */
  description: string;
  /** Snippet inserted at the cursor (with ${} tab-stops stripped to plain). */
  insert: string;
}

export interface ExprCategory {
  id: string;
  label: string;
  functions: ExprFunction[];
}

const f = (name: string, signature: string, description: string, insert?: string): ExprFunction => ({
  name, signature, description, insert: insert ?? `${name}()`,
});

export const EXPRESSION_CATEGORIES: ExprCategory[] = [
  {
    id: 'string',
    label: 'String functions',
    functions: [
      f('concat', 'concat(text1, text2, ...)', 'Combine two or more strings.', "concat(, )"),
      f('substring', 'substring(text, startIndex, length)', 'Return characters from the middle of a string.', 'substring(, , )'),
      f('replace', 'replace(text, oldText, newText)', 'Replace a substring with another.', 'replace(, , )'),
      f('toLower', 'toLower(text)', 'Return a string in lowercase.', 'toLower()'),
      f('toUpper', 'toUpper(text)', 'Return a string in uppercase.', 'toUpper()'),
      f('trim', 'trim(text)', 'Remove leading and trailing whitespace.', 'trim()'),
      f('split', 'split(text, delimiter)', 'Split a string into an array.', 'split(, )'),
      f('indexOf', 'indexOf(text, search)', 'Index of the first occurrence (or -1).', 'indexOf(, )'),
      f('lastIndexOf', 'lastIndexOf(text, search)', 'Index of the last occurrence (or -1).', 'lastIndexOf(, )'),
      f('startsWith', 'startsWith(text, search)', 'True if the string starts with the value.', 'startsWith(, )'),
      f('endsWith', 'endsWith(text, search)', 'True if the string ends with the value.', 'endsWith(, )'),
      f('guid', 'guid()', 'Generate a globally unique identifier.', 'guid()'),
      f('length', 'length(value)', 'Number of items in a string or array.', 'length()'),
      f('replace', 'replace(text, old, new)', 'Replace occurrences of a substring.', 'replace(, , )'),
    ],
  },
  {
    id: 'collection',
    label: 'Collection functions',
    functions: [
      f('contains', 'contains(collection, value)', 'True if the collection has the item.', 'contains(, )'),
      f('empty', 'empty(value)', 'True if the collection/string is empty.', 'empty()'),
      f('first', 'first(collection)', 'Return the first item.', 'first()'),
      f('last', 'last(collection)', 'Return the last item.', 'last()'),
      f('intersection', 'intersection(coll1, coll2, ...)', 'Items common to all collections.', 'intersection(, )'),
      f('union', 'union(coll1, coll2, ...)', 'All items from all collections.', 'union(, )'),
      f('join', 'join(collection, delimiter)', 'Join array items into a string.', 'join(, )'),
      f('take', 'take(collection, count)', 'First N items.', 'take(, )'),
      f('skip', 'skip(collection, count)', 'All items after the first N.', 'skip(, )'),
    ],
  },
  {
    id: 'logical',
    label: 'Logical functions',
    functions: [
      f('and', 'and(expr1, expr2)', 'True if both are true.', 'and(, )'),
      f('or', 'or(expr1, expr2)', 'True if either is true.', 'or(, )'),
      f('not', 'not(expr)', 'Negate a boolean.', 'not()'),
      f('equals', 'equals(a, b)', 'True if both values are equal.', 'equals(, )'),
      f('greater', 'greater(a, b)', 'True if a > b.', 'greater(, )'),
      f('greaterOrEquals', 'greaterOrEquals(a, b)', 'True if a >= b.', 'greaterOrEquals(, )'),
      f('less', 'less(a, b)', 'True if a < b.', 'less(, )'),
      f('lessOrEquals', 'lessOrEquals(a, b)', 'True if a <= b.', 'lessOrEquals(, )'),
      f('if', 'if(condition, ifTrue, ifFalse)', 'Conditional value.', 'if(, , )'),
      f('coalesce', 'coalesce(obj1, obj2, ...)', 'First non-null value.', 'coalesce(, )'),
    ],
  },
  {
    id: 'conversion',
    label: 'Conversion functions',
    functions: [
      f('json', 'json(value)', 'Parse a string/XML into a JSON object.', 'json()'),
      f('string', 'string(value)', 'Return the string version of a value.', 'string()'),
      f('int', 'int(value)', 'Return the integer version of a string.', 'int()'),
      f('float', 'float(value)', 'Return the float version of a string.', 'float()'),
      f('bool', 'bool(value)', 'Return the boolean version of a value.', 'bool()'),
      f('array', 'array(value)', 'Return an array from a single input.', 'array()'),
      f('createArray', 'createArray(item1, item2, ...)', 'Build an array from inputs.', 'createArray(, )'),
      f('base64', 'base64(value)', 'Base64-encode a string.', 'base64()'),
      f('base64ToString', 'base64ToString(value)', 'Decode a base64 string.', 'base64ToString()'),
      f('encodeUriComponent', 'encodeUriComponent(value)', 'URI-encode a string.', 'encodeUriComponent()'),
      f('decimal', 'decimal(value)', 'Return the decimal version of a string.', 'decimal()'),
      f('xml', 'xml(value)', 'Return the XML version of a string.', 'xml()'),
    ],
  },
  {
    id: 'math',
    label: 'Math functions',
    functions: [
      f('add', 'add(a, b)', 'Sum of two numbers.', 'add(, )'),
      f('sub', 'sub(a, b)', 'Difference of two numbers.', 'sub(, )'),
      f('mul', 'mul(a, b)', 'Product of two numbers.', 'mul(, )'),
      f('div', 'div(a, b)', 'Quotient of two numbers.', 'div(, )'),
      f('mod', 'mod(a, b)', 'Remainder of a division.', 'mod(, )'),
      f('min', 'min(a, b, ...)', 'Lowest value in the set.', 'min(, )'),
      f('max', 'max(a, b, ...)', 'Highest value in the set.', 'max(, )'),
      f('range', 'range(startIndex, count)', 'Integer array starting at an index.', 'range(, )'),
      f('rand', 'rand(minValue, maxValue)', 'Random integer within a range.', 'rand(, )'),
    ],
  },
  {
    id: 'date',
    label: 'Date functions',
    functions: [
      f('utcnow', "utcnow('format')", 'Current timestamp in UTC.', 'utcnow()'),
      f('addDays', 'addDays(timestamp, days)', 'Add days to a timestamp.', 'addDays(, )'),
      f('addHours', 'addHours(timestamp, hours)', 'Add hours to a timestamp.', 'addHours(, )'),
      f('addMinutes', 'addMinutes(timestamp, minutes)', 'Add minutes to a timestamp.', 'addMinutes(, )'),
      f('addSeconds', 'addSeconds(timestamp, seconds)', 'Add seconds to a timestamp.', 'addSeconds(, )'),
      f('formatDateTime', "formatDateTime(timestamp, 'format')", 'Format a timestamp.', "formatDateTime(, 'yyyy-MM-dd')"),
      f('startOfDay', 'startOfDay(timestamp)', 'Start of the day for a timestamp.', 'startOfDay()'),
      f('startOfHour', 'startOfHour(timestamp)', 'Start of the hour for a timestamp.', 'startOfHour()'),
      f('startOfMonth', 'startOfMonth(timestamp)', 'Start of the month for a timestamp.', 'startOfMonth()'),
      f('dayOfWeek', 'dayOfWeek(timestamp)', 'Day of the week (0=Sunday).', 'dayOfWeek()'),
      f('ticks', 'ticks(timestamp)', '100-nanosecond ticks since 0001-01-01.', 'ticks()'),
      f('getPastTime', "getPastTime(interval, 'timeUnit')", 'Current minus an interval.', 'getPastTime(, )'),
      f('getFutureTime', "getFutureTime(interval, 'timeUnit')", 'Current plus an interval.', 'getFutureTime(, )'),
      f('convertTimeZone', 'convertTimeZone(timestamp, srcTz, dstTz)', 'Convert between time zones.', 'convertTimeZone(, , )'),
    ],
  },
];

/** System variables — the `@pipeline().*` / `@trigger().*` set the portal lists. */
export interface SystemVariable { name: string; description: string; insert: string; }

export const SYSTEM_VARIABLES: SystemVariable[] = [
  { name: '@pipeline().DataFactory', description: 'Name of the data factory / workspace the run is in.', insert: 'pipeline().DataFactory' },
  { name: '@pipeline().Pipeline', description: 'Name of the pipeline.', insert: 'pipeline().Pipeline' },
  { name: '@pipeline().RunId', description: 'ID of the specific pipeline run.', insert: 'pipeline().RunId' },
  { name: '@pipeline().GroupId', description: 'ID of the group the run belongs to.', insert: 'pipeline().GroupId' },
  { name: '@pipeline().TriggerId', description: 'ID of the trigger that invoked the pipeline.', insert: 'pipeline().TriggerId' },
  { name: '@pipeline().TriggerName', description: 'Name of the trigger that invoked the pipeline.', insert: 'pipeline().TriggerName' },
  { name: '@pipeline().TriggerType', description: 'Type of the trigger (Manual, ScheduleTrigger, …).', insert: 'pipeline().TriggerType' },
  { name: '@pipeline().TriggerTime', description: 'Time the trigger fired the run.', insert: 'pipeline().TriggerTime' },
  { name: '@pipeline()?.TriggerTime', description: 'Trigger time (null-safe).', insert: 'pipeline()?.TriggerTime' },
];

/** All function names — used to seed Monaco IntelliSense keywords. */
export function allFunctionNames(): string[] {
  return EXPRESSION_CATEGORIES.flatMap((c) => c.functions.map((fn) => fn.name));
}
