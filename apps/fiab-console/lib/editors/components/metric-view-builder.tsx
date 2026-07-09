'use client';

/**
 * MetricViewBuilder — typed builder for a governed Metric View (DBX-6).
 *
 * No freeform JSON config (per loom_no_freeform_config): dimensions + measures
 * are authored through typed rows + an aggregation dropdown; the only free-text
 * surfaces are SQL EXPRESSION fields (1:1 with the Databricks "Custom
 * expression" mode and the Synapse expression builder) and a READ-ONLY compiled
 * SQL/DDL preview.
 *
 * Two backends, both real (per no-vaporware):
 *   - Loom semantic layer (DEFAULT, Azure-native): compiles to a runnable
 *     GROUP BY SELECT executed against Synapse Dedicated (real rows) + DAX
 *     measures for the Loom tabular model. Zero Databricks dependency.
 *   - Databricks UC metric view (OPT-IN): creates a real `CREATE … WITH METRICS
 *     LANGUAGE YAML` view + queries it with the `MEASURE()` form on a bound
 *     warehouse.
 */

import { useCallback, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Body1, Caption1, Subtitle2, Button, Input, Field, Dropdown, Option, Radio, RadioGroup,
  Switch, Spinner, Badge, Divider, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Play20Regular, Eye20Regular, Save20Regular, DatabaseArrowUp20Regular } from '@fluentui/react-icons';
import { METRIC_AGGREGATIONS, type MetricAggregation } from '@/lib/sql/metric-view-builders';

const useStyles = makeStyles({
  col: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  row: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  memberRow: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  flex1: { flexGrow: 1, flexBasis: 0, minWidth: '120px' },
  flex2: { flexGrow: 2, flexBasis: 0, minWidth: '160px' },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre',
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  grid: { overflowX: 'auto' },
});

const AGG_LABELS: Record<MetricAggregation, string> = {
  SUM: 'Sum', AVG: 'Average', COUNT: 'Count', COUNT_DISTINCT: 'Count distinct',
  MIN: 'Min', MAX: 'Max', CUSTOM: 'Custom expression',
};

interface DimRow { name: string; expr: string }
interface MeasureRow { name: string; aggregation: MetricAggregation; expr: string }

export interface MetricViewBuilderProps {
  /** Optional seed source (e.g. a model table name). */
  defaultSource?: string;
  /** Optional DAX table reference for the Loom semantic-layer measures. */
  tableRef?: string;
}

export function MetricViewBuilder({ defaultSource, tableRef }: MetricViewBuilderProps) {
  const s = useStyles();
  const [backend, setBackend] = useState<'loom' | 'databricks'>('loom');
  const [source, setSource] = useState(defaultSource || '');
  const [filter, setFilter] = useState('');
  const [dims, setDims] = useState<DimRow[]>([{ name: '', expr: '' }]);
  const [measures, setMeasures] = useState<MeasureRow[]>([{ name: '', aggregation: 'SUM', expr: '' }]);
  // Databricks destination (opt-in path).
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const [viewName, setViewName] = useState('');
  const [orReplace, setOrReplace] = useState(true);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [sql, setSql] = useState<string | null>(null);
  const [dax, setDax] = useState<{ name: string; expr: string }[] | null>(null);
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const buildSpec = useCallback(() => ({
    source: source.trim(),
    dimensions: dims.filter((d) => d.name.trim() || d.expr.trim()).map((d) => ({ name: d.name.trim(), expr: d.expr.trim() })),
    measures: measures.filter((m) => m.name.trim()).map((m) => ({ name: m.name.trim(), aggregation: m.aggregation, expr: m.expr.trim() || undefined })),
    filter: filter.trim() || undefined,
  }), [source, dims, measures, filter]);

  const reset = () => { setErr(null); setGate(null); setOkMsg(null); };

  // ---- Loom (Azure-native default) actions ----
  const compileLoom = useCallback(async () => {
    reset(); setBusy('compile');
    try {
      const r = await clientFetch('/api/semantic-model/metric-view', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'compile', spec: buildSpec(), tableRef }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setSql(j.select); setDax(j.dax || null);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [buildSpec, tableRef]);

  const runLoom = useCallback(async () => {
    reset(); setBusy('run'); setResult(null);
    try {
      const r = await clientFetch('/api/semantic-model/metric-view', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run', spec: buildSpec() }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); setSql(j.sql || null); return; }
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setSql(j.sql); setResult({ columns: j.columns || [], rows: j.rows || [] });
      setOkMsg(`Executed against Synapse — ${j.rowCount} row(s) in ${j.executionMs} ms.`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [buildSpec]);

  // ---- Databricks (opt-in) actions ----
  const previewDbxDdl = useCallback(async () => {
    reset(); setBusy('preview');
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/metric-views', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', preview: true, params: { catalog: catalog.trim(), schema: schema.trim(), name: viewName.trim(), orReplace, spec: buildSpec() } }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setSql(j.sql);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [catalog, schema, viewName, orReplace, buildSpec]);

  const createDbx = useCallback(async () => {
    reset(); setBusy('create');
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/metric-views', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', params: { catalog: catalog.trim(), schema: schema.trim(), name: viewName.trim(), orReplace, spec: buildSpec() } }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setSql(j.sql);
      setOkMsg(`Metric view ${catalog}.${schema}.${viewName} created (${j.executionMs} ms).`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [catalog, schema, viewName, orReplace, buildSpec]);

  const queryDbx = useCallback(async () => {
    reset(); setBusy('query'); setResult(null);
    try {
      const r = await clientFetch('/api/databricks/unity-catalog/metric-views', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'query', catalog: catalog.trim(), schema: schema.trim(), name: viewName.trim(),
          dimensions: dims.filter((d) => d.name.trim()).map((d) => d.name.trim()),
          measures: measures.filter((m) => m.name.trim()).map((m) => m.name.trim()),
        }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setSql(j.sql); setResult({ columns: j.columns || [], rows: j.rows || [] });
      setOkMsg(`Queried metric view — ${j.rowCount} row(s) in ${j.executionMs} ms.`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  }, [catalog, schema, viewName, dims, measures]);

  const patchDim = (i: number, p: Partial<DimRow>) => setDims((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const patchMeasure = (i: number, p: Partial<MeasureRow>) => setMeasures((m) => m.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className={s.col}>
      <div>
        <Subtitle2>Metric view</Subtitle2>
        <Caption1 as="p" style={{ color: tokens.colorNeutralForeground3 }}>
          Define governed dimensions + measures once, over a fact table. Loom's Azure-native semantic
          layer is the default (runs on Synapse, saved as DAX measures); Databricks UC metric views are
          an opt-in backend when a workspace is bound.
        </Caption1>
      </div>

      <Field label="Backend">
        <RadioGroup layout="horizontal" value={backend} onChange={(_, d) => { setSql(null); setResult(null); setDax(null); reset(); setBackend(d.value as 'loom' | 'databricks'); }}>
          <Radio value="loom" label="Loom semantic layer (default · Azure-native)" />
          <Radio value="databricks" label="Databricks UC metric view (opt-in)" />
        </RadioGroup>
      </Field>

      <div className={s.row}>
        <Field label="Source table" required className={s.flex2} hint="table, schema.table, or catalog.schema.table">
          <Input value={source} onChange={(_, d) => setSource(d.value)} placeholder="sales.public.orders" />
        </Field>
        <Field label="Base filter (optional)" className={s.flex2} hint="a boolean SQL predicate applied before aggregation">
          <Input value={filter} onChange={(_, d) => setFilter(d.value)} placeholder="o_orderstatus <> 'X'" />
        </Field>
      </div>

      {backend === 'databricks' && (
        <div className={s.row}>
          <Field label="Catalog" required className={s.flex1}><Input value={catalog} onChange={(_, d) => setCatalog(d.value)} placeholder="main" /></Field>
          <Field label="Schema" required className={s.flex1}><Input value={schema} onChange={(_, d) => setSchema(d.value)} placeholder="sales" /></Field>
          <Field label="Metric view name" required className={s.flex1}><Input value={viewName} onChange={(_, d) => setViewName(d.value)} placeholder="orders_mv" /></Field>
          <Field label="Replace if exists" className={s.flex1}><Switch checked={orReplace} onChange={(_, d) => setOrReplace(!!d.checked)} /></Field>
        </div>
      )}

      <Divider>Dimensions</Divider>
      {dims.map((d, i) => (
        <div key={i} className={s.memberRow}>
          <Input className={s.flex1} value={d.name} onChange={(_, e) => patchDim(i, { name: e.value })} placeholder="name (e.g. order_month)" aria-label={`Dimension ${i + 1} name`} />
          <Input className={s.flex2} value={d.expr} onChange={(_, e) => patchDim(i, { expr: e.value })} placeholder="expression (e.g. DATE_TRUNC('MONTH', o_orderdate))" aria-label={`Dimension ${i + 1} expression`} />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove dimension ${i + 1}`} disabled={dims.length <= 1} onClick={() => setDims((x) => x.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setDims((x) => [...x, { name: '', expr: '' }])}>Add dimension</Button>

      <Divider>Measures</Divider>
      {measures.map((m, i) => (
        <div key={i} className={s.memberRow}>
          <Input className={s.flex1} value={m.name} onChange={(_, e) => patchMeasure(i, { name: e.value })} placeholder="name (e.g. total_revenue)" aria-label={`Measure ${i + 1} name`} />
          <Dropdown
            className={s.flex1}
            value={AGG_LABELS[m.aggregation]}
            selectedOptions={[m.aggregation]}
            onOptionSelect={(_, e) => e.optionValue && patchMeasure(i, { aggregation: e.optionValue as MetricAggregation })}
            aria-label={`Measure ${i + 1} aggregation`}
          >
            {METRIC_AGGREGATIONS.map((a) => <Option key={a} value={a} text={AGG_LABELS[a]}>{AGG_LABELS[a]}</Option>)}
          </Dropdown>
          <Input
            className={s.flex2}
            value={m.expr}
            onChange={(_, e) => patchMeasure(i, { expr: e.value })}
            placeholder={m.aggregation === 'CUSTOM' ? 'full expression (e.g. SUM(a)/COUNT(DISTINCT b))' : m.aggregation === 'COUNT' ? 'column (blank = COUNT(1))' : 'column (e.g. o_totalprice)'}
            aria-label={`Measure ${i + 1} expression`}
          />
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove measure ${i + 1}`} disabled={measures.length <= 1} onClick={() => setMeasures((x) => x.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setMeasures((x) => [...x, { name: '', aggregation: 'SUM', expr: '' }])}>Add measure</Button>

      <Divider />
      <div className={s.actions}>
        {backend === 'loom' ? (
          <>
            <Button appearance="secondary" icon={<Eye20Regular />} disabled={!!busy} onClick={compileLoom}>{busy === 'compile' ? <Spinner size="tiny" /> : 'Preview SQL + DAX'}</Button>
            <Tooltip relationship="description" content="Run the compiled GROUP BY SELECT against the Synapse Dedicated pool (real rows).">
              <Button appearance="primary" icon={<Play20Regular />} disabled={!!busy || !source.trim()} onClick={runLoom}>{busy === 'run' ? <Spinner size="tiny" /> : 'Run (Synapse)'}</Button>
            </Tooltip>
          </>
        ) : (
          <>
            <Button appearance="secondary" icon={<Eye20Regular />} disabled={!!busy} onClick={previewDbxDdl}>{busy === 'preview' ? <Spinner size="tiny" /> : 'Preview DDL'}</Button>
            <Button appearance="primary" icon={<Save20Regular />} disabled={!!busy || !catalog.trim() || !schema.trim() || !viewName.trim()} onClick={createDbx}>{busy === 'create' ? <Spinner size="tiny" /> : 'Create metric view'}</Button>
            <Button appearance="outline" icon={<DatabaseArrowUp20Regular />} disabled={!!busy || !catalog.trim() || !schema.trim() || !viewName.trim()} onClick={queryDbx}>{busy === 'query' ? <Spinner size="tiny" /> : 'Query'}</Button>
          </>
        )}
      </div>

      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Backend not configured</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
      {okMsg && <MessageBar intent="success"><MessageBarBody>{okMsg}</MessageBarBody></MessageBar>}

      {sql && (
        <div>
          <Caption1>Compiled SQL{backend === 'databricks' ? ' / DDL' : ''}</Caption1>
          <div className={s.code}>{sql}</div>
        </div>
      )}

      {dax && dax.length > 0 && (
        <div>
          <Caption1>DAX measures (Loom semantic layer)</Caption1>
          <div className={s.col}>
            {dax.map((d) => (
              <div key={d.name} className={s.code}><Badge appearance="tint" color="brand">{d.name}</Badge> {d.expr}</div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className={s.grid}>
          <Caption1>Results ({result.rows.length} row{result.rows.length === 1 ? '' : 's'})</Caption1>
          <Table size="small" aria-label="Metric view results">
            <TableHeader>
              <TableRow>{result.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((row, i) => (
                <TableRow key={i}>
                  {(Array.isArray(row) ? row : [row]).map((cell, j) => <TableCell key={j}>{cell == null ? '' : String(cell)}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {result.rows.length === 0 && <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No rows returned.</Body1>}
        </div>
      )}
    </div>
  );
}
