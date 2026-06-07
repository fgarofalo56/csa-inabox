/**
 * display-stats — server-side DataFrame profiling + chart recommendation for
 * the notebook `display(df)` rich visualization.
 *
 * Two entry points, both pure (no network, no Azure SDK) so the poll route can
 * call them synchronously and vitest can pin their behavior:
 *
 *   buildLoomDisplay(appJson, sampleLimit)
 *     Builds a LoomDisplayPayload from a Livy `application/json` split-orient
 *     DataFrame output ({schema:{fields:[…]}, data:[[…]]}). Used as the FALLBACK
 *     when a cell emits a raw Spark DataFrame (e.g. Spark SQL, or display()
 *     without the ai-display.py helper loaded). Computes real column stats.
 *
 *   enrichChartRecs(payload)
 *     When the ai-display.py helper already emitted the rich MIME (columns +
 *     rows + stats) but left chartRecs empty, fill in up to 5 recommendations
 *     from the column dtypes. Mutates a copy; returns it.
 *
 *   recommendCharts(columns)
 *     The shared recommendation heuristic (bar / scatter / line / heatmap).
 */
import type {
  LoomDisplayColumn,
  LoomDisplayChartRec,
  LoomDisplayPayload,
} from '@/lib/types/notebook-cell';

/** Numeric dtype prefixes across pandas + Spark + Arrow naming. */
const NUMERIC_DTYPE_PREFIXES = [
  'int', 'float', 'double', 'long', 'short', 'byte', 'decimal',
  'number', 'real', 'numeric', 'bigint', 'smallint', 'tinyint',
];

export function isNumericDtype(dtype: string | undefined): boolean {
  if (!dtype) return false;
  const d = dtype.toLowerCase();
  if (d.startsWith('bool')) return false;
  return NUMERIC_DTYPE_PREFIXES.some((p) => d.startsWith(p));
}

function looksTemporal(dtype: string | undefined, name: string): boolean {
  const d = (dtype || '').toLowerCase();
  if (d.startsWith('datetime') || d.startsWith('timestamp') || d.startsWith('date')) return true;
  const n = name.toLowerCase();
  return /(^|_|\b)(date|time|ts|timestamp|day|month|year)(_|\b|$)/.test(n);
}

/** Coerce a cell value to a finite number, or null. */
function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/**
 * Recommend up to 5 charts from a column profile. Mirrors what Synapse Studio /
 * Fabric's "+ New chart" auto-suggests: a categorical-vs-numeric bar, a
 * numeric-vs-numeric scatter, a temporal/numeric line, a two-category grouped
 * bar, and a two-category count heatmap. Only emits a rec when the columns to
 * satisfy it actually exist, so every returned chart renders real data.
 */
export function recommendCharts(cols: LoomDisplayColumn[]): LoomDisplayChartRec[] {
  const num = cols.filter((c) => isNumericDtype(c.dtype));
  const cat = cols.filter((c) => !isNumericDtype(c.dtype) && !c.dtype.toLowerCase().startsWith('bool'));
  const temporal = cols.filter((c) => looksTemporal(c.dtype, c.name));
  const recs: LoomDisplayChartRec[] = [];

  // 1. bar: first categorical × first numeric (mean)
  if (cat.length && num.length) {
    recs.push({ id: 'r0', type: 'bar', xField: cat[0].name, yField: num[0].name, agg: 'mean', title: `${num[0].name} by ${cat[0].name}` });
  }
  // 2. scatter: first two numerics
  if (num.length >= 2) {
    recs.push({ id: 'r1', type: 'scatter', xField: num[0].name, yField: num[1].name, agg: 'count', title: `${num[1].name} vs ${num[0].name}` });
  }
  // 3. line: temporal (or first numeric as ordinal axis) × a numeric measure
  if (num.length >= 1 && (temporal.length || num.length >= 2)) {
    const xField = temporal.length ? temporal[0].name : num[0].name;
    const yField = num.find((n) => n.name !== xField)?.name ?? num[0].name;
    recs.push({ id: 'r2', type: 'line', xField, yField, agg: 'mean', title: `${yField} trend` });
  }
  // 4. grouped bar: two categoricals + a numeric (sum)
  if (cat.length >= 2 && num.length) {
    recs.push({ id: 'r3', type: 'bar', xField: cat[0].name, yField: num[0].name, legend: cat[1].name, agg: 'sum', title: `${num[0].name} by ${cat[0].name} / ${cat[1].name}` });
  }
  // 5. heatmap: two categoricals + count
  if (cat.length >= 2) {
    recs.push({ id: 'r4', type: 'heatmap', xField: cat[0].name, yField: cat[1].name, agg: 'count', title: `Count of ${cat[0].name} × ${cat[1].name}` });
  }
  // Fallback when the frame is all-categorical with no second column: a count bar.
  if (recs.length === 0 && cat.length) {
    recs.push({ id: 'r0', type: 'bar', xField: cat[0].name, yField: cat[0].name, agg: 'count', title: `Count by ${cat[0].name}` });
  }
  return recs.slice(0, 5).map((r, i) => ({ ...r, id: `rec-${i}` }));
}

interface LivyAppJson {
  schema?: { fields?: { name: string; type: string }[] };
  data?: unknown[][];
}

/**
 * Build a LoomDisplayPayload from a Livy `application/json` DataFrame output.
 * Computes real per-column stats (min/max/mean/stddev for numeric, cardinality
 * + top-values for categorical) over the sampled rows.
 */
export function buildLoomDisplay(
  appJson: LivyAppJson | null | undefined,
  sampleLimit = 5000,
): LoomDisplayPayload | null {
  const fields = appJson?.schema?.fields;
  const allRows = appJson?.data;
  if (!Array.isArray(fields) || fields.length === 0 || !Array.isArray(allRows)) return null;

  const limit = Math.max(1, sampleLimit);
  const sample = allRows.slice(0, limit) as (string | number | boolean | null)[][];

  const columns: LoomDisplayColumn[] = fields.map((f, ci) => {
    const vals = sample.map((r) => (Array.isArray(r) ? r[ci] : null));
    const nonNull = vals.filter((v) => v != null && v !== '');
    const col: LoomDisplayColumn = {
      name: f.name,
      dtype: f.type ?? 'object',
      nullCount: vals.length - nonNull.length,
    };
    if (isNumericDtype(f.type)) {
      const nums = nonNull.map(toNum).filter((n): n is number => n != null);
      if (nums.length) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
        col.min = String(min);
        col.max = String(max);
        col.mean = mean.toFixed(4);
        col.stddev = Math.sqrt(variance).toFixed(4);
      }
    } else {
      const counts = new Map<string, number>();
      for (const v of nonNull) {
        const k = String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      col.cardinality = Math.min(counts.size, 1000);
      col.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count }));
    }
    return col;
  });

  return {
    version: 1,
    columns,
    rows: sample,
    totalCount: allRows.length,
    sampleSize: sample.length,
    chartRecs: recommendCharts(columns),
  };
}

/**
 * Fill chartRecs from the column profile when the kernel-emitted payload left
 * them empty (the ai-display.py helper computes stats but defers chart
 * recommendation to the server so the heuristic lives in one place).
 */
export function enrichChartRecs(payload: LoomDisplayPayload): LoomDisplayPayload {
  if (Array.isArray(payload.chartRecs) && payload.chartRecs.length > 0) return payload;
  return { ...payload, chartRecs: recommendCharts(payload.columns || []) };
}

/**
 * Build the PySpark statement that aggregates a chart over the FULL dataset.
 * Calls display() on the (small) grouped result so — with the ai-display.py
 * helper loaded — it round-trips back through the rich MIME. This fires a real
 * Spark shuffle/aggregation job; there is no client-side faking of full-data agg.
 */
export function buildAggCode(rec: LoomDisplayChartRec, varName: string): string {
  const v = sanitizeVar(varName);
  const x = pyStr(rec.xField);
  const y = pyStr(rec.yField);
  if (rec.agg === 'count') {
    if (rec.legend) {
      const g = pyStr(rec.legend);
      return `display(${v}.groupBy(${x}, ${g}).count().orderBy(${x}))`;
    }
    return `display(${v}.groupBy(${x}).count().orderBy(${x}))`;
  }
  const fn = rec.agg; // sum | mean | min | max — all valid pyspark agg dict ops
  if (rec.legend) {
    const g = pyStr(rec.legend);
    return `display(${v}.groupBy(${x}, ${g}).agg({${y}: ${pyStr(fn)}}).orderBy(${x}))`;
  }
  return `display(${v}.groupBy(${x}).agg({${y}: ${pyStr(fn)}}).orderBy(${x}))`;
}

function pyStr(s: string): string {
  return JSON.stringify(String(s));
}

/** Only allow a plain Python identifier through as a variable name. */
function sanitizeVar(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'df';
}
