/**
 * dataflow-expression-functions — the data-driven catalog of the ADF / Synapse
 * MAPPING DATA FLOW expression language (Spark-backed), grouped by the exact
 * categories the real ADF "Expression Builder" lists.
 *
 * WHY A SEPARATE CATALOG (NOT the pipeline `expression-functions.ts`)
 * ------------------------------------------------------------------
 * The pipeline (control-flow) expression language and the data-flow (data-plane,
 * per-row Spark) expression language are DISTINCT dialects:
 *   - Pipeline:   `@concat(pipeline().parameters.x, '/', utcnow())` — `@`-prefixed
 *                 interpolation, system variables `pipeline()`/`activity()`, a
 *                 small function set. Lives in `../expression-functions.ts`.
 *   - Data flow:  `iif(isNull(CustomerName), 'n/a', upper(trim(CustomerName)))` —
 *                 NO `@` prefix, references input-schema COLUMNS by bare name,
 *                 data-flow PARAMETERS by `$paramName`, locals by `:localName`,
 *                 and a large Spark-backed function library across Aggregate /
 *                 Array / Conversion / Date-time / Map / Metafunction / Window /
 *                 plus the general Expression functions (string/math/logical).
 *
 * This catalog mirrors the ADF "Data transformation expression usage" reference,
 * grounded in Microsoft Learn:
 *   - Usage (alphabetical, every function w/ signature + examples):
 *       https://learn.microsoft.com/azure/data-factory/data-flow-expressions-usage
 *   - Per-category lists:
 *       data-flow-aggregate-functions, data-flow-array-functions,
 *       data-flow-conversion-functions, data-flow-date-time-functions,
 *       data-flow-expression-functions, data-flow-map-functions,
 *       data-flow-metafunctions, data-flow-window-functions,
 *       data-flow-cached-lookup-functions
 *
 * The builder (`dataflow-expression-builder.tsx`) renders STRUCTURED, searchable,
 * click-to-insert forms from this catalog — never a freeform JSON blob (per
 * loom-no-freeform-config). Each entry's `signature` is inserted at the cursor,
 * and Monaco IntelliSense is fed from this same list so Ctrl-Space offers every
 * function with its doc. The expression string the builder produces is the exact
 * `script` text ADF compiles to Spark, so it round-trips verbatim on the real
 * data-flow PUT (adf-client / synapse-artifacts-client) — no mocks.
 */

/** The category groupings the ADF Expression Builder uses for data flows. */
export type DataflowFnCategory =
  | 'aggregate'
  | 'array'
  | 'cached-lookup'
  | 'conversion'
  | 'date-time'
  | 'expression'
  | 'map'
  | 'metafunction'
  | 'window';

export interface DataflowFnCategoryMeta {
  id: DataflowFnCategory;
  label: string;
  /** Short note shown under the category header in the catalog pane. */
  blurb: string;
}

/** Category metadata, in the order the ADF builder presents them. */
export const DATAFLOW_FN_CATEGORIES: DataflowFnCategoryMeta[] = [
  { id: 'aggregate', label: 'Aggregate functions', blurb: 'Roll up rows — use inside an Aggregate transformation.' },
  { id: 'array', label: 'Array functions', blurb: 'Build, slice, sort, fold and combine arrays.' },
  { id: 'cached-lookup', label: 'Cached lookup functions', blurb: 'Look up rows from a cached sink by key.' },
  { id: 'conversion', label: 'Conversion functions', blurb: 'Cast / test types (toInteger, toDate, isNull…).' },
  { id: 'date-time', label: 'Date and time functions', blurb: 'Build, add to, and extract parts of dates / timestamps.' },
  { id: 'expression', label: 'Expression functions', blurb: 'String, math, logical and bitwise functions.' },
  { id: 'map', label: 'Map functions', blurb: 'Build and read complex map (key→value) columns.' },
  { id: 'metafunction', label: 'Metafunctions', blurb: 'Reason over the stream: columns, names, byName, hierarchy.' },
  { id: 'window', label: 'Window functions', blurb: 'rank/lead/lag/etc. — use inside a Window transformation.' },
];

export interface DataflowFn {
  /** The function name as called, e.g. `iif`, `toDate`, `regexReplace`. */
  name: string;
  category: DataflowFnCategory;
  /** Full signature shown in the catalog + the IntelliSense detail. */
  signature: string;
  /** One-line description of what it does. */
  description: string;
  /**
   * Snippet inserted at the cursor when the user clicks "Insert". Defaults to
   * `name()` with the caret left between the parens (caller positions it). When
   * a function takes no args (e.g. `rowNumber()`, `true()`) this is just `name()`.
   */
  insert: string;
  /** A worked example from the ADF reference (shown in the tooltip / detail). */
  example?: string;
  /** Number of required positional args (drives the simple validity hint). */
  arity?: number;
}

// =============================================================================
// AGGREGATE  (data-flow-aggregate-functions)
// =============================================================================
const AGGREGATE: DataflowFn[] = [
  { name: 'avg', category: 'aggregate', signature: 'avg(<value> : number) => number', description: 'Average of all values in a column.', insert: 'avg()', example: 'avg(sales)' },
  { name: 'avgIf', category: 'aggregate', signature: 'avgIf(<condition> : boolean, <value> : number) => number', description: 'Average of values that meet a condition.', insert: 'avgIf()', example: "avgIf(region == 'West', sales)" },
  { name: 'count', category: 'aggregate', signature: 'count([<value> : any]) => long', description: 'Count of non-null values; count() counts all rows.', insert: 'count()', example: 'count(custId)' },
  { name: 'countDistinct', category: 'aggregate', signature: 'countDistinct(<value> : any, ...) => long', description: 'Count of distinct (non-null) values.', insert: 'countDistinct()', example: 'countDistinct(custId, region)' },
  { name: 'countIf', category: 'aggregate', signature: 'countIf(<condition> : boolean, [<value> : any]) => long', description: 'Count of values that meet a condition.', insert: 'countIf()', example: 'countIf(sales > 100)' },
  { name: 'covariancePopulation', category: 'aggregate', signature: 'covariancePopulation(<value1> : number, <value2> : number) => double', description: 'Population covariance of two columns.', insert: 'covariancePopulation()' },
  { name: 'covarianceSample', category: 'aggregate', signature: 'covarianceSample(<value1> : number, <value2> : number) => double', description: 'Sample covariance of two columns.', insert: 'covarianceSample()' },
  { name: 'first', category: 'aggregate', signature: 'first(<value> : any, [<ignoreNulls> : boolean]) => any', description: 'First value in the group.', insert: 'first()', example: 'first(sales)' },
  { name: 'last', category: 'aggregate', signature: 'last(<value> : any, [<ignoreNulls> : boolean]) => any', description: 'Last value in the group.', insert: 'last()', example: 'last(sales)' },
  { name: 'collect', category: 'aggregate', signature: 'collect(<value> : any) => array', description: 'Collects all values within the group into an array.', insert: 'collect()', example: 'collect(sales)' },
  { name: 'kurtosis', category: 'aggregate', signature: 'kurtosis(<value> : number) => double', description: 'Kurtosis of a column.', insert: 'kurtosis()' },
  { name: 'max', category: 'aggregate', signature: 'max(<value> : any) => any', description: 'Maximum value in a column.', insert: 'max()', example: 'max(sales)' },
  { name: 'mean', category: 'aggregate', signature: 'mean(<value> : number) => number', description: 'Mean (average) of values in a column.', insert: 'mean()' },
  { name: 'meanIf', category: 'aggregate', signature: 'meanIf(<condition> : boolean, <value> : number) => number', description: 'Mean of values that meet a condition.', insert: 'meanIf()' },
  { name: 'min', category: 'aggregate', signature: 'min(<value> : any) => any', description: 'Minimum value in a column.', insert: 'min()', example: 'min(sales)' },
  { name: 'skewness', category: 'aggregate', signature: 'skewness(<value> : number) => double', description: 'Skewness of a column.', insert: 'skewness()' },
  { name: 'stddev', category: 'aggregate', signature: 'stddev(<value> : number) => double', description: 'Sample standard deviation of a column.', insert: 'stddev()' },
  { name: 'stddevPopulation', category: 'aggregate', signature: 'stddevPopulation(<value> : number) => double', description: 'Population standard deviation of a column.', insert: 'stddevPopulation()' },
  { name: 'stddevSample', category: 'aggregate', signature: 'stddevSample(<value> : number) => double', description: 'Sample standard deviation of a column.', insert: 'stddevSample()' },
  { name: 'sum', category: 'aggregate', signature: 'sum(<value> : number) => number', description: 'Sum of all values in a column.', insert: 'sum()', example: 'sum(sales)' },
  { name: 'sumDistinct', category: 'aggregate', signature: 'sumDistinct(<value> : number) => number', description: 'Sum of distinct values in a column.', insert: 'sumDistinct()' },
  { name: 'sumIf', category: 'aggregate', signature: 'sumIf(<condition> : boolean, <value> : number) => number', description: 'Sum of values that meet a condition.', insert: 'sumIf()', example: "sumIf(region == 'West', sales)" },
  { name: 'variance', category: 'aggregate', signature: 'variance(<value> : number) => double', description: 'Sample variance of a column.', insert: 'variance()' },
  { name: 'variancePopulation', category: 'aggregate', signature: 'variancePopulation(<value> : number) => double', description: 'Population variance of a column.', insert: 'variancePopulation()' },
  { name: 'varianceSample', category: 'aggregate', signature: 'varianceSample(<value> : number) => double', description: 'Sample variance of a column.', insert: 'varianceSample()' },
  { name: 'approxDistinctCount', category: 'aggregate', signature: 'approxDistinctCount(<value> : any, [<error> : double]) => long', description: 'Approximate distinct count (HyperLogLog).', insert: 'approxDistinctCount()', example: 'approxDistinctCount(ProductID, .05)' },
];

// =============================================================================
// ARRAY  (data-flow-array-functions)
// =============================================================================
const ARRAY: DataflowFn[] = [
  { name: 'array', category: 'array', signature: 'array([<value> : any], ...) => array', description: 'Creates an array of items (all same type).', insert: 'array()', example: "array('Seattle', 'Washington')" },
  { name: 'at', category: 'array', signature: 'at(<array/map> : any, <index/key> : any) => any', description: 'Indexes into an array (1-based) or map by key.', insert: 'at()', example: "at(['a','b','c'], 2) -> 'b'" },
  { name: 'contains', category: 'array', signature: 'contains(<array> : array, <predicate> : unaryfunction) => boolean', description: 'True if any element matches the predicate (#item).', insert: 'contains()', example: 'contains([1,2,3], #item > 2) -> true' },
  { name: 'distinct', category: 'array', signature: 'distinct(<array> : array) => array', description: 'Distinct set of items from an array.', insert: 'distinct()', example: 'distinct([1,1,2,3]) -> [1,2,3]' },
  { name: 'except', category: 'array', signature: 'except(<array1> : array, <array2> : array) => array', description: 'Difference of two arrays (distinct).', insert: 'except()', example: 'except([10,20,30],[20]) -> [10,30]' },
  { name: 'filter', category: 'array', signature: 'filter(<array> : array, <predicate> : unaryfunction) => array', description: 'Keeps elements matching the predicate (#item).', insert: 'filter()', example: 'filter([1,2,3,4], #item > 2) -> [3,4]' },
  { name: 'find', category: 'array', signature: 'find(<array> : array, <predicate> : unaryfunction) => any', description: 'First element matching the predicate (#item).', insert: 'find()', example: 'find([1,2,3], #item > 1) -> 2' },
  { name: 'flatten', category: 'array', signature: 'flatten(<array of arrays> : array, ...) => array', description: 'Flattens array(s)-of-arrays into one array.', insert: 'flatten()', example: 'flatten([[1,2],[3,4]]) -> [1,2,3,4]' },
  { name: 'in', category: 'array', signature: 'in(<array> : array, <item> : any) => boolean', description: 'True if the item is in the array.', insert: 'in()', example: 'in([10,20,30], 10) -> true' },
  { name: 'intersect', category: 'array', signature: 'intersect(<array1> : array, <array2> : array) => array', description: 'Intersection of two arrays (distinct).', insert: 'intersect()' },
  { name: 'map', category: 'array', signature: 'map(<array> : array, <mapper> : unaryfunction) => array', description: 'Maps each element through a function (#item).', insert: 'map()', example: 'map([1,2,3], #item + 1) -> [2,3,4]' },
  { name: 'mapIndex', category: 'array', signature: 'mapIndex(<array> : array, <mapper> : binaryfunction) => array', description: 'Maps each element with its index (#item, #index).', insert: 'mapIndex()' },
  { name: 'reduce', category: 'array', signature: 'reduce(<array> : array, <init> : any, <acc> : binaryfunction, <final> : unaryfunction) => any', description: 'Accumulates an array to a single value (#acc, #item).', insert: 'reduce()', example: 'reduce([1,2,3], 0, #acc + #item, #result) -> 6' },
  { name: 'size', category: 'array', signature: 'size(<value> : any) => integer', description: 'Size of an array or map.', insert: 'size()', example: 'size([1,2,3]) -> 3' },
  { name: 'slice', category: 'array', signature: 'slice(<array> : array, <position> : integer, [<length> : integer]) => array', description: 'Subset of an array from a 1-based position.', insert: 'slice()', example: 'slice([1,2,3,4], 2) -> [2,3,4]' },
  { name: 'sort', category: 'array', signature: 'sort(<array> : array, <compare> : binaryfunction) => array', description: 'Sorts the array using a compare on #item1/#item2.', insert: 'sort()', example: 'sort([4,8,2,3], compare(#item1, #item2)) -> [2,3,4,8]' },
  { name: 'unfold', category: 'array', signature: 'unfold(<array> : array) => any', description: 'Unfolds an array into rows, repeating other columns.', insert: 'unfold()' },
  { name: 'union', category: 'array', signature: 'union(<array1> : array, <array2> : array) => array', description: 'Union of distinct items from two arrays.', insert: 'union()' },
];

// =============================================================================
// CACHED LOOKUP  (data-flow-cached-lookup-functions)
// =============================================================================
const CACHED_LOOKUP: DataflowFn[] = [
  { name: 'lookup', category: 'cached-lookup', signature: 'lookup(<key> : any, ...) => complex', description: 'Looks up the first matching row in a cached sink by key.', insert: 'lookup()', example: "cacheSink#lookup(custId)" },
  { name: 'mlookup', category: 'cached-lookup', signature: 'mlookup(<key> : any, ...) => array', description: 'Looks up ALL matching rows in a cached sink by key.', insert: 'mlookup()', example: "cacheSink#mlookup(custId)" },
  { name: 'output', category: 'cached-lookup', signature: 'output() => complex', description: 'Returns the first row of a cached sink (no key).', insert: 'output()', example: 'cacheSink#output()' },
  { name: 'outputs', category: 'cached-lookup', signature: 'outputs() => array', description: 'Returns all rows of a cached sink as an array.', insert: 'outputs()', example: 'cacheSink#outputs()' },
];

// =============================================================================
// CONVERSION  (data-flow-conversion-functions)
// =============================================================================
const CONVERSION: DataflowFn[] = [
  { name: 'toBoolean', category: 'conversion', signature: 'toBoolean(<value> : string) => boolean', description: 'Converts "true"/"false"/"1"/"0" to a boolean.', insert: 'toBoolean()' },
  { name: 'toByte', category: 'conversion', signature: 'toByte(<value> : any, [<format> : string]) => byte', description: 'Converts numeric/string to a byte.', insert: 'toByte()' },
  { name: 'toDate', category: 'conversion', signature: 'toDate(<value> : any, [<format> : string]) => date', description: 'Converts a string to a date (default yyyy-[M]M-[d]d).', insert: 'toDate()', example: "toDate('2012-12-15')" },
  { name: 'toDecimal', category: 'conversion', signature: 'toDecimal(<value> : any, [<precision> : int], [<scale> : int], [<format> : string], [<locale> : string]) => decimal', description: 'Converts numeric/string to a decimal (default (10,2)).', insert: 'toDecimal()' },
  { name: 'toDouble', category: 'conversion', signature: 'toDouble(<value> : any, [<format> : string], [<locale> : string]) => double', description: 'Converts numeric/string to a double.', insert: 'toDouble()' },
  { name: 'toFloat', category: 'conversion', signature: 'toFloat(<value> : any, [<format> : string]) => float', description: 'Converts numeric/string to a float (truncates double).', insert: 'toFloat()' },
  { name: 'toInteger', category: 'conversion', signature: 'toInteger(<value> : any, [<format> : string]) => integer', description: 'Converts numeric/string to an integer (truncates).', insert: 'toInteger()', example: "toInteger('123') -> 123" },
  { name: 'toLong', category: 'conversion', signature: 'toLong(<value> : any, [<format> : string]) => long', description: 'Converts numeric/string to a long.', insert: 'toLong()' },
  { name: 'toShort', category: 'conversion', signature: 'toShort(<value> : any, [<format> : string]) => short', description: 'Converts numeric/string to a short.', insert: 'toShort()' },
  { name: 'toString', category: 'conversion', signature: 'toString(<value> : any, [<format> : string], [<locale> : string]) => string', description: 'Converts a value to a string with optional format.', insert: 'toString()', example: "toString(123456.789, '##,###.##')" },
  { name: 'toTimestamp', category: 'conversion', signature: 'toTimestamp(<value> : any, [<format> : string], [<timezone> : string]) => timestamp', description: 'Converts a string to a timestamp.', insert: 'toTimestamp()', example: "toTimestamp('2016-12-31 00:12:00')" },
  { name: 'toUTF8', category: 'conversion', signature: 'toUTF8(<value> : string) => binary', description: 'Encodes a string as UTF-8 binary.', insert: 'toUTF8()' },
  { name: 'isBoolean', category: 'conversion', signature: 'isBoolean(<value> : string) => boolean', description: 'Checks if the string is a boolean value.', insert: 'isBoolean()' },
  { name: 'isByte', category: 'conversion', signature: 'isByte(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a byte value.', insert: 'isByte()' },
  { name: 'isDate', category: 'conversion', signature: 'isDate(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a date.', insert: 'isDate()' },
  { name: 'isDecimal', category: 'conversion', signature: 'isDecimal(<value> : string) => boolean', description: 'Checks if the string is a decimal.', insert: 'isDecimal()' },
  { name: 'isDouble', category: 'conversion', signature: 'isDouble(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a double.', insert: 'isDouble()' },
  { name: 'isFloat', category: 'conversion', signature: 'isFloat(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a float.', insert: 'isFloat()' },
  { name: 'isInteger', category: 'conversion', signature: 'isInteger(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is an integer.', insert: 'isInteger()' },
  { name: 'isLong', category: 'conversion', signature: 'isLong(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a long.', insert: 'isLong()' },
  { name: 'isNan', category: 'conversion', signature: 'isNan(<value> : any) => boolean', description: 'Checks if a value is not a number.', insert: 'isNan()' },
  { name: 'isShort', category: 'conversion', signature: 'isShort(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a short.', insert: 'isShort()' },
  { name: 'isTimestamp', category: 'conversion', signature: 'isTimestamp(<value> : string, [<format> : string]) => boolean', description: 'Checks if the string is a timestamp.', insert: 'isTimestamp()' },
];

// =============================================================================
// DATE & TIME  (data-flow-date-time-functions)
// =============================================================================
const DATE_TIME: DataflowFn[] = [
  { name: 'add', category: 'date-time', signature: 'add(<value1> : any, <value2> : any) => any', description: 'Adds numbers/strings/days/durations. Same as +.', insert: 'add()', example: 'add(toDate(\'2012-12-12\'), 3)' },
  { name: 'addDays', category: 'date-time', signature: 'addDays(<date> : datetime, <days> : integral) => datetime', description: 'Adds days to a date or timestamp.', insert: 'addDays()', example: "addDays(toDate('2016-08-08'), 1)" },
  { name: 'addMonths', category: 'date-time', signature: 'addMonths(<date> : datetime, <months> : integral, [<timezone> : string]) => datetime', description: 'Adds months to a date or timestamp.', insert: 'addMonths()' },
  { name: 'currentDate', category: 'date-time', signature: 'currentDate([<timezone> : string]) => date', description: 'Current date when the job starts running.', insert: 'currentDate()', example: 'currentDate()' },
  { name: 'currentTimestamp', category: 'date-time', signature: 'currentTimestamp() => timestamp', description: 'Current timestamp when the job starts running.', insert: 'currentTimestamp()' },
  { name: 'currentUTC', category: 'date-time', signature: 'currentUTC([<format> : string]) => timestamp', description: 'Current UTC timestamp.', insert: 'currentUTC()' },
  { name: 'dayOfMonth', category: 'date-time', signature: 'dayOfMonth(<date> : datetime) => integer', description: 'Day of the month for a date.', insert: 'dayOfMonth()', example: "dayOfMonth(toDate('2018-06-08')) -> 8" },
  { name: 'dayOfWeek', category: 'date-time', signature: 'dayOfWeek(<date> : datetime) => integer', description: 'Day of week (1=Sunday … 7=Saturday).', insert: 'dayOfWeek()' },
  { name: 'dayOfYear', category: 'date-time', signature: 'dayOfYear(<date> : datetime) => integer', description: 'Day of the year for a date.', insert: 'dayOfYear()' },
  { name: 'days', category: 'date-time', signature: 'days(<value> : integer) => long', description: 'Duration in milliseconds for a number of days.', insert: 'days()' },
  { name: 'fromUTC', category: 'date-time', signature: 'fromUTC(<timestamp> : timestamp, [<timezone> : string]) => timestamp', description: 'Converts from UTC to the given timezone.', insert: 'fromUTC()' },
  { name: 'hour', category: 'date-time', signature: 'hour(<timestamp> : timestamp, [<timezone> : string]) => integer', description: 'Hour value of a timestamp.', insert: 'hour()' },
  { name: 'hours', category: 'date-time', signature: 'hours(<value> : integer) => long', description: 'Duration in milliseconds for a number of hours.', insert: 'hours()' },
  { name: 'lastDayOfMonth', category: 'date-time', signature: 'lastDayOfMonth(<date> : datetime) => date', description: 'Last day of the month for a date.', insert: 'lastDayOfMonth()' },
  { name: 'millisecond', category: 'date-time', signature: 'millisecond(<timestamp> : timestamp, [<timezone> : string]) => integer', description: 'Millisecond of a timestamp.', insert: 'millisecond()' },
  { name: 'milliseconds', category: 'date-time', signature: 'milliseconds(<value> : integer) => long', description: 'Duration in milliseconds.', insert: 'milliseconds()' },
  { name: 'minute', category: 'date-time', signature: 'minute(<timestamp> : timestamp, [<timezone> : string]) => integer', description: 'Minute of a timestamp.', insert: 'minute()' },
  { name: 'minutes', category: 'date-time', signature: 'minutes(<value> : integer) => long', description: 'Duration in milliseconds for a number of minutes.', insert: 'minutes()' },
  { name: 'month', category: 'date-time', signature: 'month(<date> : datetime) => integer', description: 'Month value of a date.', insert: 'month()' },
  { name: 'monthsBetween', category: 'date-time', signature: 'monthsBetween(<from> : datetime, <to> : datetime, [<roundoff> : boolean], [<timezone> : string]) => double', description: 'Months between two dates.', insert: 'monthsBetween()' },
  { name: 'second', category: 'date-time', signature: 'second(<timestamp> : timestamp, [<timezone> : string]) => integer', description: 'Second of a timestamp.', insert: 'second()' },
  { name: 'seconds', category: 'date-time', signature: 'seconds(<value> : integer) => long', description: 'Duration in milliseconds for a number of seconds.', insert: 'seconds()' },
  { name: 'subDays', category: 'date-time', signature: 'subDays(<date> : datetime, <days> : integral) => datetime', description: 'Subtracts days from a date or timestamp.', insert: 'subDays()' },
  { name: 'subMonths', category: 'date-time', signature: 'subMonths(<date> : datetime, <months> : integral) => datetime', description: 'Subtracts months from a date or timestamp.', insert: 'subMonths()' },
  { name: 'toUTC', category: 'date-time', signature: 'toUTC(<timestamp> : timestamp, [<timezone> : string]) => timestamp', description: 'Converts a timestamp to UTC.', insert: 'toUTC()' },
  { name: 'weekOfYear', category: 'date-time', signature: 'weekOfYear(<date> : datetime) => integer', description: 'Week of the year for a date.', insert: 'weekOfYear()' },
  { name: 'weeks', category: 'date-time', signature: 'weeks(<value> : integer) => long', description: 'Duration in milliseconds for a number of weeks.', insert: 'weeks()' },
  { name: 'year', category: 'date-time', signature: 'year(<date> : datetime) => integer', description: 'Year value of a date.', insert: 'year()' },
];

// =============================================================================
// EXPRESSION  (data-flow-expression-functions) — string / math / logical / bit
// =============================================================================
const EXPRESSION: DataflowFn[] = [
  // --- logical / null ---
  { name: 'iif', category: 'expression', signature: 'iif(<condition> : boolean, <true> : any, [<false> : any]) => any', description: 'Returns one value or the other based on a condition.', insert: 'iif()', example: "iif(10 > 30, 'dumbo', 'gumbo') -> 'gumbo'", arity: 2 },
  { name: 'iifNull', category: 'expression', signature: 'iifNull(<value1> : any, [<value2> : any], ...) => any', description: 'First non-null value (same as coalesce).', insert: 'iifNull()', example: "iifNull(null, 20, 40) -> 20" },
  { name: 'case', category: 'expression', signature: 'case(<cond1> : boolean, <val1> : any, <cond2> : boolean, <val2> : any, ...) => any', description: 'Alternating conditions/values; default is NULL.', insert: 'case()', example: "case(x==1,'a', x==2,'b', 'other')" },
  { name: 'coalesce', category: 'expression', signature: 'coalesce(<value1> : any, ...) => any', description: 'First non-null value from a set of inputs.', insert: 'coalesce()', example: "coalesce(a, b, 'default')" },
  { name: 'isNull', category: 'expression', signature: 'isNull(<value> : any) => boolean', description: 'Checks if the value is NULL.', insert: 'isNull()', example: 'isNull(name)', arity: 1 },
  { name: 'isNotNull', category: 'expression', signature: 'isNotNull(<value> : any) => boolean', description: 'Checks if the value is not NULL.', insert: 'isNotNull()' },
  { name: 'and', category: 'expression', signature: 'and(<value1> : boolean, <value2> : boolean) => boolean', description: 'Logical AND. Same as &&.', insert: 'and()' },
  { name: 'or', category: 'expression', signature: 'or(<value1> : boolean, <value2> : boolean) => boolean', description: 'Logical OR. Same as ||.', insert: 'or()' },
  { name: 'not', category: 'expression', signature: 'not(<value> : boolean) => boolean', description: 'Logical negation. Same as !.', insert: 'not()' },
  { name: 'equals', category: 'expression', signature: 'equals(<value1> : any, <value2> : any) => boolean', description: 'Equality comparison. Same as ==.', insert: 'equals()' },
  { name: 'true', category: 'expression', signature: 'true() => boolean', description: 'Always true. Use true() if a column is named true.', insert: 'true()' },
  { name: 'false', category: 'expression', signature: 'false() => boolean', description: 'Always false.', insert: 'false()' },
  { name: 'null', category: 'expression', signature: 'null() => null', description: 'A NULL value.', insert: 'null()' },
  { name: 'greater', category: 'expression', signature: 'greater(<value1> : any, <value2> : any) => boolean', description: 'Greater-than comparison. Same as >.', insert: 'greater()' },
  { name: 'greaterOrEqual', category: 'expression', signature: 'greaterOrEqual(<value1> : any, <value2> : any) => boolean', description: 'Greater-than-or-equal. Same as >=.', insert: 'greaterOrEqual()' },
  { name: 'lesser', category: 'expression', signature: 'lesser(<value1> : any, <value2> : any) => boolean', description: 'Less-than comparison. Same as <.', insert: 'lesser()' },
  { name: 'lesserOrEqual', category: 'expression', signature: 'lesserOrEqual(<value1> : any, <value2> : any) => boolean', description: 'Less-than-or-equal. Same as <=.', insert: 'lesserOrEqual()' },
  { name: 'notEquals', category: 'expression', signature: 'notEquals(<value1> : any, <value2> : any) => boolean', description: 'Inequality. Same as !=.', insert: 'notEquals()' },
  { name: 'between', category: 'expression', signature: 'between(<value> : any, <low> : any, <high> : any) => boolean', description: 'True if value is between low and high (inclusive).', insert: 'between()' },
  // --- string ---
  { name: 'concat', category: 'expression', signature: 'concat(<string> : string, ...) => string', description: 'Concatenates a variable number of strings.', insert: 'concat()', example: "concat('a','b','c') -> 'abc'" },
  { name: 'concatWS', category: 'expression', signature: 'concatWS(<separator> : string, <string> : string, ...) => string', description: 'Concatenates strings with a separator.', insert: 'concatWS()', example: "concatWS('-','a','b') -> 'a-b'" },
  { name: 'upper', category: 'expression', signature: 'upper(<value> : string) => string', description: 'Uppercases a string.', insert: 'upper()', example: "upper('gunchus') -> 'GUNCHUS'", arity: 1 },
  { name: 'lower', category: 'expression', signature: 'lower(<value> : string) => string', description: 'Lowercases a string.', insert: 'lower()', arity: 1 },
  { name: 'initCap', category: 'expression', signature: 'initCap(<value> : string) => string', description: 'Title-cases each whitespace-separated word.', insert: 'initCap()', example: "initCap('cool iceCREAM') -> 'Cool Icecream'" },
  { name: 'trim', category: 'expression', signature: 'trim(<value> : string, [<chars> : string]) => string', description: 'Trims leading/trailing whitespace (or chars).', insert: 'trim()' },
  { name: 'ltrim', category: 'expression', signature: 'ltrim(<value> : string, [<chars> : string]) => string', description: 'Left-trims a string.', insert: 'ltrim()' },
  { name: 'rtrim', category: 'expression', signature: 'rtrim(<value> : string, [<chars> : string]) => string', description: 'Right-trims a string.', insert: 'rtrim()' },
  { name: 'length', category: 'expression', signature: 'length(<value> : string) => integer', description: 'Length of a string.', insert: 'length()', arity: 1 },
  { name: 'substring', category: 'expression', signature: 'substring(<string> : string, <position> : integral, [<length> : integral]) => string', description: 'Substring from a 1-based position.', insert: 'substring()', example: "substring('Cat in the hat', 5, 2)" },
  { name: 'substringIndex', category: 'expression', signature: 'substringIndex(<string> : string, <delimiter> : string, <count> : integral) => string', description: 'Substring before count occurrences of a delimiter.', insert: 'substringIndex()' },
  { name: 'left', category: 'expression', signature: 'left(<string> : string, <count> : integral) => string', description: 'Leftmost N characters.', insert: 'left()', example: "left('bojjus', 2) -> 'bo'" },
  { name: 'right', category: 'expression', signature: 'right(<string> : string, <count> : integral) => string', description: 'Rightmost N characters.', insert: 'right()', example: "right('bojjus', 2) -> 'us'" },
  { name: 'replace', category: 'expression', signature: 'replace(<string> : string, <find> : string, [<replace> : string]) => string', description: 'Replaces all occurrences of a substring.', insert: 'replace()', example: "replace('doggie dog','dog','cat')" },
  { name: 'regexReplace', category: 'expression', signature: 'regexReplace(<string> : string, <pattern> : string, <replacement> : string) => string', description: 'Replaces all regex matches.', insert: 'regexReplace()', example: "regexReplace('100 and 200', `(\\d+)`, 'num')" },
  { name: 'regexExtract', category: 'expression', signature: 'regexExtract(<string> : string, <pattern> : string, [<group> : integral]) => string', description: 'Extracts a matching substring for a regex group.', insert: 'regexExtract()' },
  { name: 'regexMatch', category: 'expression', signature: 'regexMatch(<string> : string, <pattern> : string) => boolean', description: 'True if the string matches the regex.', insert: 'regexMatch()' },
  { name: 'regexSplit', category: 'expression', signature: 'regexSplit(<string> : string, <pattern> : string) => array', description: 'Splits a string on a regex delimiter.', insert: 'regexSplit()' },
  { name: 'rlike', category: 'expression', signature: 'rlike(<string> : string, <pattern> : string) => boolean', description: 'True if the string matches the regex pattern.', insert: 'rlike()' },
  { name: 'split', category: 'expression', signature: 'split(<string> : string, <delimiter> : string) => array', description: 'Splits a string on a delimiter into an array.', insert: 'split()', example: "split('a,b,c', ',') -> ['a','b','c']" },
  { name: 'instr', category: 'expression', signature: 'instr(<string> : string, <substring> : string) => integer', description: '1-based position of substring (0 if not found).', insert: 'instr()', example: "instr('dumbo','mbo') -> 3" },
  { name: 'locate', category: 'expression', signature: 'locate(<substring> : string, <string> : string, [<position> : integral]) => integer', description: '1-based position of substring from a position.', insert: 'locate()' },
  { name: 'startsWith', category: 'expression', signature: 'startsWith(<string> : string, <prefix> : string) => boolean', description: 'True if string starts with the prefix.', insert: 'startsWith()' },
  { name: 'endsWith', category: 'expression', signature: 'endsWith(<string> : string, <suffix> : string) => boolean', description: 'True if string ends with the suffix.', insert: 'endsWith()' },
  { name: 'lpad', category: 'expression', signature: 'lpad(<string> : string, <length> : integral, <pad> : string) => string', description: 'Left-pads a string to a length.', insert: 'lpad()' },
  { name: 'rpad', category: 'expression', signature: 'rpad(<string> : string, <length> : integral, <pad> : string) => string', description: 'Right-pads a string to a length.', insert: 'rpad()' },
  { name: 'reverse', category: 'expression', signature: 'reverse(<value> : string) => string', description: 'Reverses a string.', insert: 'reverse()' },
  { name: 'translate', category: 'expression', signature: 'translate(<string> : string, <from> : string, <to> : string) => string', description: 'One-to-one character replacement.', insert: 'translate()' },
  { name: 'soundex', category: 'expression', signature: 'soundex(<value> : string) => string', description: 'Soundex phonetic code of a string.', insert: 'soundex()' },
  { name: 'levenshtein', category: 'expression', signature: 'levenshtein(<value1> : string, <value2> : string) => integer', description: 'Levenshtein edit distance between two strings.', insert: 'levenshtein()' },
  { name: 'ascii', category: 'expression', signature: 'ascii(<value> : string) => integer', description: 'Numeric value of the first character.', insert: 'ascii()', example: "ascii('A') -> 65" },
  { name: 'char', category: 'expression', signature: 'char(<value> : integer) => string', description: 'ASCII character for a number.', insert: 'char()', example: "char(65) -> 'A'" },
  // --- math ---
  { name: 'abs', category: 'expression', signature: 'abs(<value> : number) => number', description: 'Absolute value of a number.', insert: 'abs()', example: 'abs(-20) -> 20', arity: 1 },
  { name: 'round', category: 'expression', signature: 'round(<number> : number, [<scale> : number], [<mode> : integral]) => double', description: 'Rounds a number to an optional scale/mode.', insert: 'round()', example: 'round(3.14159, 2) -> 3.14' },
  { name: 'floor', category: 'expression', signature: 'floor(<value> : number) => number', description: 'Largest integer not greater than the number.', insert: 'floor()' },
  { name: 'ceil', category: 'expression', signature: 'ceil(<value> : number) => number', description: 'Smallest integer not less than the number.', insert: 'ceil()' },
  { name: 'power', category: 'expression', signature: 'power(<value1> : number, <value2> : number) => double', description: 'Raises one number to the power of another.', insert: 'power()' },
  { name: 'sqrt', category: 'expression', signature: 'sqrt(<value> : number) => double', description: 'Square root of a number.', insert: 'sqrt()' },
  { name: 'cbrt', category: 'expression', signature: 'cbrt(<value> : number) => double', description: 'Cube root of a number.', insert: 'cbrt()' },
  { name: 'exp', category: 'expression', signature: 'exp(<value> : number) => double', description: 'e raised to the power of the number.', insert: 'exp()' },
  { name: 'log', category: 'expression', signature: 'log(<value> : number, [<base> : number]) => double', description: 'Logarithm (default base e).', insert: 'log()' },
  { name: 'log10', category: 'expression', signature: 'log10(<value> : number) => double', description: 'Base-10 logarithm.', insert: 'log10()' },
  { name: 'mod', category: 'expression', signature: 'mod(<value1> : number, <value2> : number) => number', description: 'Modulus (remainder). Same as %.', insert: 'mod()' },
  { name: 'pmod', category: 'expression', signature: 'pmod(<value1> : number, <value2> : number) => number', description: 'Positive modulus.', insert: 'pmod()' },
  { name: 'negate', category: 'expression', signature: 'negate(<value> : number) => number', description: 'Negates a number (sign flip).', insert: 'negate()' },
  { name: 'random', category: 'expression', signature: 'random([<seed> : integral]) => long', description: 'Random number within the partition (optional seed).', insert: 'random()' },
  { name: 'sign', category: 'expression', signature: 'sign(<value> : number) => number', description: 'Sign of a number (-1, 0, 1).', insert: 'sign()' },
  { name: 'factorial', category: 'expression', signature: 'factorial(<value> : number) => long', description: 'Factorial of a number.', insert: 'factorial()' },
  { name: 'greatest', category: 'expression', signature: 'greatest(<value1> : any, ...) => any', description: 'Greatest of the listed values (skips null).', insert: 'greatest()' },
  { name: 'least', category: 'expression', signature: 'least(<value1> : any, ...) => any', description: 'Least of the listed values (skips null).', insert: 'least()' },
  // --- bitwise / hash ---
  { name: 'bitwiseAnd', category: 'expression', signature: 'bitwiseAnd(<value1> : integral, <value2> : integral) => integral', description: 'Bitwise AND. Same as &.', insert: 'bitwiseAnd()' },
  { name: 'bitwiseOr', category: 'expression', signature: 'bitwiseOr(<value1> : integral, <value2> : integral) => integral', description: 'Bitwise OR. Same as |.', insert: 'bitwiseOr()' },
  { name: 'bitwiseXor', category: 'expression', signature: 'bitwiseXor(<value1> : integral, <value2> : integral) => integral', description: 'Bitwise XOR. Same as ^.', insert: 'bitwiseXor()' },
  { name: 'md5', category: 'expression', signature: 'md5(<value> : any, ...) => string', description: 'MD5 digest of a set of columns (32-char hex).', insert: 'md5()' },
  { name: 'sha1', category: 'expression', signature: 'sha1(<value> : any, ...) => string', description: 'SHA-1 digest of a set of columns (40-char hex).', insert: 'sha1()' },
  { name: 'sha2', category: 'expression', signature: 'sha2(<bits> : integer, <value> : any, ...) => string', description: 'SHA-2 digest (224/256/384/512) of columns.', insert: 'sha2()' },
  { name: 'crc32', category: 'expression', signature: 'crc32([<bits> : integer], <value> : any, ...) => long', description: 'CRC32 hash of a set of columns.', insert: 'crc32()' },
  { name: 'xxHash64', category: 'expression', signature: 'xxHash64(<value> : any, ...) => long', description: 'xxHash64 hash of a set of columns.', insert: 'xxHash64()' },
  { name: 'hex', category: 'expression', signature: 'hex(<value> : any) => string', description: 'Hex string of a number/binary value.', insert: 'hex()' },
  { name: 'unhex', category: 'expression', signature: 'unhex(<value> : string) => binary', description: 'Converts a hex string to binary.', insert: 'unhex()' },
  { name: 'compare', category: 'expression', signature: 'compare(<value1> : any, <value2> : any) => integer', description: 'Compares two values (-1, 0, 1) — used in sort().', insert: 'compare()' },
  { name: 'hasColumn', category: 'expression', signature: 'hasColumn(<columnName> : string, [<stream> : string]) => boolean', description: 'Checks for a column by name in the stream.', insert: 'hasColumn()', example: "hasColumn('Email')" },
];

// =============================================================================
// MAP  (data-flow-map-functions)
// =============================================================================
const MAP: DataflowFn[] = [
  { name: 'keyValues', category: 'map', signature: 'keyValues(<keys> : array, <values> : array) => map', description: 'Builds a map from parallel key/value arrays.', insert: 'keyValues()', example: "keyValues(['a','b'], [1,2])" },
  { name: 'mapAssociation', category: 'map', signature: 'mapAssociation(<map> : map, <transform> : binaryfunction) => array', description: 'Transforms a map into an array of #key/#value pairs.', insert: 'mapAssociation()' },
  { name: 'reassociate', category: 'map', signature: 'reassociate(<map> : map, <transform> : unaryfunction) => map', description: 'Transforms each value of a map (#key, #value).', insert: 'reassociate()' },
  { name: 'associate', category: 'map', signature: 'associate(<key1> : any, <value1> : any, ...) => map', description: 'Builds a map from alternating key/value pairs.', insert: 'associate()' },
];

// =============================================================================
// METAFUNCTION  (data-flow-metafunctions)
// =============================================================================
const METAFUNCTION: DataflowFn[] = [
  { name: 'byName', category: 'metafunction', signature: 'byName(<columnName> : string, [<stream> : string]) => any', description: 'References a column value by its name (pattern/rule-based).', insert: 'byName()', example: "toString(byName('Email'))" },
  { name: 'byNames', category: 'metafunction', signature: 'byNames(<columnNames> : array, [<stream> : string]) => array', description: 'References multiple columns by name as an array.', insert: 'byNames()' },
  { name: 'byPath', category: 'metafunction', signature: 'byPath(<path> : string, [<stream> : string]) => any', description: 'References a nested column by hierarchical path.', insert: 'byPath()' },
  { name: 'byPosition', category: 'metafunction', signature: 'byPosition(<position> : integer) => any', description: 'References a column by its ordinal position.', insert: 'byPosition()' },
  { name: 'byItem', category: 'metafunction', signature: 'byItem(<parent> : any, <columnName> : string) => any', description: 'References a sub-column of a hierarchical/struct column.', insert: 'byItem()' },
  { name: 'hasPath', category: 'metafunction', signature: 'hasPath(<path> : string, [<stream> : string]) => boolean', description: 'Checks if a hierarchical path exists in the stream.', insert: 'hasPath()' },
  { name: 'columns', category: 'metafunction', signature: 'columns([<stream> : string]) => array', description: 'Array of all column values in the row.', insert: 'columns()' },
  { name: 'columnNames', category: 'metafunction', signature: 'columnNames([<stream> : string]) => array', description: 'Array of all column names in the stream.', insert: 'columnNames()' },
  { name: 'name', category: 'metafunction', signature: 'name() => string', description: 'Name of the column being matched (in column patterns).', insert: 'name()' },
  { name: 'type', category: 'metafunction', signature: 'type() => string', description: 'Type of the column being matched (in column patterns).', insert: 'type()' },
  { name: 'position', category: 'metafunction', signature: 'position() => integer', description: 'Ordinal position of the column being matched.', insert: 'position()' },
  { name: 'originColumns', category: 'metafunction', signature: 'originColumns(<originStream> : string) => array', description: 'Columns originating from a specific source/stream.', insert: 'originColumns()' },
  { name: 'hierarchy', category: 'metafunction', signature: 'hierarchy() => any', description: 'References the hierarchy of a structured column.', insert: 'hierarchy()' },
  { name: 'isMatch', category: 'metafunction', signature: 'isMatch([<index> : integer]) => boolean', description: 'Whether the row matched on a given stream (joins).', insert: 'isMatch()' },
  { name: 'isError', category: 'metafunction', signature: 'isError([<assertId> : string]) => boolean', description: 'Whether an assert is marked as an error.', insert: 'isError()' },
  { name: 'isInsert', category: 'metafunction', signature: 'isInsert([<index> : integer]) => boolean', description: 'Whether the row is marked for insert (alter-row).', insert: 'isInsert()' },
  { name: 'isUpdate', category: 'metafunction', signature: 'isUpdate([<index> : integer]) => boolean', description: 'Whether the row is marked for update.', insert: 'isUpdate()' },
  { name: 'isUpsert', category: 'metafunction', signature: 'isUpsert([<index> : integer]) => boolean', description: 'Whether the row is marked for upsert.', insert: 'isUpsert()' },
  { name: 'isDelete', category: 'metafunction', signature: 'isDelete([<index> : integer]) => boolean', description: 'Whether the row is marked for delete.', insert: 'isDelete()' },
  { name: 'partitionId', category: 'metafunction', signature: 'partitionId() => integer', description: 'Current Spark partition ID.', insert: 'partitionId()' },
];

// =============================================================================
// WINDOW  (data-flow-window-functions) — Window transformation only
// =============================================================================
const WINDOW: DataflowFn[] = [
  { name: 'rank', category: 'window', signature: 'rank() => integer', description: 'Rank within the window partition (gaps on ties).', insert: 'rank()' },
  { name: 'denseRank', category: 'window', signature: 'denseRank() => integer', description: 'Rank within the partition (no gaps on ties).', insert: 'denseRank()' },
  { name: 'rowNumber', category: 'window', signature: 'rowNumber() => integer', description: 'Sequential row number within the window, starting at 1.', insert: 'rowNumber()' },
  { name: 'cumeDist', category: 'window', signature: 'cumeDist() => integer', description: 'Cumulative distribution of a value in the partition.', insert: 'cumeDist()' },
  { name: 'nTile', category: 'window', signature: 'nTile([<buckets> : integer]) => integer', description: 'Divides the partition rows into N buckets.', insert: 'nTile()' },
  { name: 'lead', category: 'window', signature: 'lead(<value> : any, [<offset> : number], [<default> : any]) => any', description: 'Value N rows AFTER the current row in the partition.', insert: 'lead()', example: 'lead(sales, 1)' },
  { name: 'lag', category: 'window', signature: 'lag(<value> : any, [<offset> : number], [<default> : any]) => any', description: 'Value N rows BEFORE the current row in the partition.', insert: 'lag()', example: 'lag(sales, 1)' },
];

// =============================================================================
// THE FULL CATALOG
// =============================================================================

/** Every data-flow expression function, across all categories. */
export const DATAFLOW_FUNCTIONS: DataflowFn[] = [
  ...AGGREGATE,
  ...ARRAY,
  ...CACHED_LOOKUP,
  ...CONVERSION,
  ...DATE_TIME,
  ...EXPRESSION,
  ...MAP,
  ...METAFUNCTION,
  ...WINDOW,
];

/** Functions grouped by category (in display order), for the catalog pane. */
export function functionsByCategory(): { meta: DataflowFnCategoryMeta; fns: DataflowFn[] }[] {
  return DATAFLOW_FN_CATEGORIES.map((meta) => ({
    meta,
    fns: DATAFLOW_FUNCTIONS.filter((f) => f.category === meta.id).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Case-insensitive search over function name + description. */
export function searchFunctions(query: string): DataflowFn[] {
  const q = query.trim().toLowerCase();
  if (!q) return DATAFLOW_FUNCTIONS;
  return DATAFLOW_FUNCTIONS.filter(
    (f) => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q),
  );
}

// =============================================================================
// COLUMN / PARAMETER / LOCAL references
// =============================================================================

/** A data-flow input-schema column the builder offers in the left pane. */
export interface DataflowColumn {
  name: string;
  /** Optional declared data-flow type (string/integer/timestamp/…). */
  type?: string;
  /** Source/stream the column originates from (for multi-input transforms). */
  stream?: string;
}

/** A data-flow parameter — referenced in the expression as `$name`. */
export interface DataflowParameter {
  name: string;
  type?: string;
  defaultValue?: string;
}

/** A locals (derived-column "Locals" / cache) reference — referenced as `:name`. */
export interface DataflowLocal {
  name: string;
  /** The expression the local resolves to (shown as a hint). */
  expression?: string;
}

/**
 * How a token should be written into the expression. Columns that are valid
 * bare identifiers are inserted as-is; columns with spaces/special chars are
 * wrapped in `{ }` (data-flow column-name escaping). Parameters use `$`, locals
 * use `:`.
 */
export function columnToken(col: DataflowColumn): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(col.name) ? col.name : `{${col.name}}`;
}
export function parameterToken(p: DataflowParameter): string {
  return `$${p.name}`;
}
export function localToken(l: DataflowLocal): string {
  return `:${l.name}`;
}

// =============================================================================
// VALIDITY HINT  (lightweight, design-time — NOT a Spark eval)
// =============================================================================

export interface DataflowExprValidity {
  ok: boolean;
  /** Human message — empty when ok. */
  message: string;
  /** 'ok' | 'warning' | 'error' for the hint badge intent. */
  level: 'ok' | 'warning' | 'error';
}

/**
 * A fast, purely-syntactic validity check the builder shows under the editor.
 * This is the SAME kind of bracket/quote balance check the ADF builder gives
 * as you type — it is NOT a data preview (that needs a live Spark debug
 * session and is honest-gated in the UI). It catches the common authoring
 * mistakes: unbalanced parens/brackets/braces, unterminated quotes, a trailing
 * binary operator, and an empty expression.
 */
export function checkDataflowExpression(expr: string): DataflowExprValidity {
  const text = (expr ?? '').trim();
  if (!text) {
    return { ok: false, message: 'Expression is empty.', level: 'warning' };
  }

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];
    // Quote state (backslash-escaped quotes don't toggle).
    if (ch === "'" && !inDouble && !inBacktick && prev !== '\\') { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && !inBacktick && prev !== '\\') { inDouble = !inDouble; continue; }
    if (ch === '`' && !inSingle && !inDouble) { inBacktick = !inBacktick; continue; }
    if (inSingle || inDouble || inBacktick) continue;

    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) {
        return { ok: false, message: `Unbalanced ${ch} — check your brackets.`, level: 'error' };
      }
    }
  }

  if (inSingle || inDouble || inBacktick) {
    return { ok: false, message: 'Unterminated string literal — close the quote.', level: 'error' };
  }
  if (stack.length > 0) {
    return { ok: false, message: `Unclosed ${stack[stack.length - 1]} — add the matching close bracket.`, level: 'error' };
  }
  if (/[+\-*/%<>=&|.,]$/.test(text)) {
    return { ok: false, message: 'Expression ends with an operator — complete the expression.', level: 'warning' };
  }

  return { ok: true, message: 'Looks syntactically valid. Use Debug to preview real Spark output.', level: 'ok' };
}

/** Convenience: total function count (used by tests / the catalog header). */
export const DATAFLOW_FUNCTION_COUNT = DATAFLOW_FUNCTIONS.length;
