'use client';

/**
 * SyntheticDataEditor — the `synthetic-data` generator item type (W12).
 *
 * Pick a source schema (a bound data contract, or define columns by hand),
 * choose a per-column generation strategy (faker-style names / dates /
 * categoricals / numeric distributions), preview real rows, then GENERATE and
 * WRITE them to a real Delta table via the Databricks createUcTableFromFile
 * path. Azure-native (Databricks SQL over Delta) — no Microsoft Fabric
 * dependency (no-fabric-dependency.md); every control hits a real backend
 * (no-vaporware.md). PII-classified source columns are mapped to SYNTHETIC
 * strategies (fake names/emails — never real data).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Field, Input, Dropdown, Option, Spinner, Divider, Text,
  Tab, TabList, Radio, RadioGroup, ProgressBar,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DatabaseRegular, SparkleRegular, PlayRegular, HistoryRegular, TableRegular,
  Add20Regular, Delete20Regular, ShieldKeyholeRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { useItemState } from './phase4/shared';
import {
  GEN_STRATEGIES, inferStrategy, type ColumnGenSpec, type GenStrategy,
} from '@/lib/azure/synthetic-data-gen';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

interface SyntheticRunLite {
  id: string; startedAt: string; target: string; requestedRows: number;
  rowsWritten: number | null; status: 'succeeded' | 'partial' | 'failed'; error?: string;
}
interface SyntheticState extends Record<string, unknown> {
  specs?: ColumnGenSpec[];
  rowCount?: number;
  seed?: number;
  warehouseId?: string;
  catalog?: string;
  schema?: string;
  volume?: string;
  table?: string;
  sourceContractId?: string;
  runs?: SyntheticRunLite[];
}
interface ContractSource { id: string; name: string; columns: { name: string; type?: string; classification?: string }[] }

const useStyles = makeStyles({
  tabBar: { paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1150px' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: tokens.spacingHorizontalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  optWrap: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' },
  numIn: { maxWidth: '110px' },
  scroll: { overflowX: 'auto', maxWidth: '100%' },
  tableWrap: { overflow: 'auto', maxHeight: '46vh' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  hint: { color: tokens.colorNeutralForeground3 },
});

const STRATEGY_NEEDS = new Map(GEN_STRATEGIES.map((s) => [s.value, s.needs]));
const CONTRACT_TYPES = ['string', 'integer', 'bigint', 'double', 'decimal', 'boolean', 'date', 'timestamp'];

export function SyntheticDataEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { state, setState, loading, saving, error, save, dirty } =
    useItemState<SyntheticState>('synthetic-data', id, { specs: [], rowCount: 100, seed: 1 });

  const [tab, setTab] = useState<'design' | 'runs'>('design');
  const [contracts, setContracts] = useState<ContractSource[]>([]);
  const [sourceMode, setSourceMode] = useState<'contract' | 'manual'>('manual');
  const [err, setErr] = useState<string | null>(null);

  // Write-target cascade.
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; state?: string }[]>([]);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [dbxGate, setDbxGate] = useState<string | null>(null);

  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; columns: string[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);

  const specs = useMemo(() => Array.isArray(state.specs) ? state.specs : [], [state.specs]);
  const runs = useMemo(() => Array.isArray(state.runs) ? state.runs : [], [state.runs]);

  const setSpecs = useCallback((next: ColumnGenSpec[]) => setState((p) => ({ ...p, specs: next })), [setState]);
  const patchSpec = useCallback((idx: number, patch: Partial<ColumnGenSpec>) =>
    setSpecs(specs.map((c, i) => (i === idx ? { ...c, ...patch } : c))), [specs, setSpecs]);
  const patchOpt = useCallback((idx: number, patch: Record<string, unknown>) =>
    setSpecs(specs.map((c, i) => (i === idx ? { ...c, options: { ...(c.options || {}), ...patch } } : c))), [specs, setSpecs]);

  // ── Load data-contract sources + the write-target warehouses on mount ──
  useEffect(() => {
    if (!id || id === 'new') return;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/synthetic-data/${encodeURIComponent(id)}/sources`);
        const j = await r.json();
        if (j.ok) setContracts(j.contracts || []);
      } catch { /* honest: no contracts listed */ }
      try {
        const r = await clientFetch(`/api/items/synthetic-data/${encodeURIComponent(id)}/catalog`);
        const j = await r.json();
        if (j.ok) { if (j.gate) setDbxGate(j.gate.missing); else setWarehouses(j.warehouses || []); }
      } catch { /* honest: gate shown */ }
    })();
  }, [id]);

  const browseCatalog = useCallback(async (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    const r = await clientFetch(`/api/items/synthetic-data/${encodeURIComponent(id)}/catalog?${qs}`);
    return r.json();
  }, [id]);

  const onCatalog = useCallback(async (c: string) => {
    setState((p) => ({ ...p, catalog: c, schema: '', volume: '' })); setSchemas([]); setVolumes([]);
    if (!c) return;
    const j = await browseCatalog({ level: 'schemas', catalog: c });
    if (j.ok) setSchemas(j.schemas || []);
  }, [browseCatalog, setState]);

  const onSchema = useCallback(async (sc: string) => {
    setState((p) => ({ ...p, schema: sc, volume: '' })); setVolumes([]);
    if (!sc || !state.catalog) return;
    const j = await browseCatalog({ level: 'volumes', catalog: state.catalog, schema: sc });
    if (j.ok) setVolumes(j.volumes || []);
  }, [browseCatalog, setState, state.catalog]);

  const onWarehouse = useCallback(async (wid: string) => {
    setState((p) => ({ ...p, warehouseId: wid }));
    if (!catalogs.length) { const j = await browseCatalog({ level: 'catalogs' }); if (j.ok) setCatalogs(j.catalogs || []); }
  }, [browseCatalog, setState, catalogs.length]);

  // ── Seed columns from a data contract (infer strategies; PII → synthetic) ──
  const seedFromContract = useCallback((contractId: string) => {
    const c = contracts.find((x) => x.id === contractId);
    if (!c) return;
    setState((p) => ({ ...p, sourceContractId: contractId, specs: c.columns.map((col) => inferStrategy(col)) }));
  }, [contracts, setState]);

  const addColumn = useCallback(() => setSpecs([...specs, { name: `col_${specs.length + 1}`, type: 'string', strategy: 'categorical', options: { values: ['alpha', 'beta', 'gamma'] } }]), [specs, setSpecs]);
  const removeColumn = useCallback((idx: number) => setSpecs(specs.filter((_, i) => i !== idx)), [specs, setSpecs]);

  const rowCount = Number(state.rowCount) || 100;
  const seed = Number(state.seed) || 1;
  const canGenerate = specs.length > 0 && !!state.catalog && !!state.schema && !!state.table && !!state.volume;

  const doPreview = useCallback(async () => {
    setErr(null); setPreview(null); setPreviewing(true);
    try {
      const r = await clientFetch(`/api/items/synthetic-data/${encodeURIComponent(id)}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ specs, rowCount: Math.min(10, rowCount), seed }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setPreview({ rows: j.rows || [], columns: j.columns || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setPreviewing(false); }
  }, [id, specs, rowCount, seed]);

  const doGenerate = useCallback(async () => {
    setErr(null); setGenerating(true);
    try {
      if (dirty) await save();
      const r = await clientFetch(`/api/items/synthetic-data/${encodeURIComponent(id)}/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ specs, rowCount, seed, warehouseId: state.warehouseId, catalog: state.catalog, schema: state.schema, table: state.table, volume: state.volume }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); if (j.run) setState((p) => ({ ...p, runs: [j.run, ...(runs)] })); return; }
      setState((p) => ({ ...p, runs: [j.run, ...(runs)] }));
      setTab('runs');
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setGenerating(false); }
  }, [id, specs, rowCount, seed, state.warehouseId, state.catalog, state.schema, state.table, state.volume, dirty, save, runs, setState]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Generate', actions: [
        { label: previewing ? 'Previewing…' : 'Preview', onClick: specs.length && !previewing ? doPreview : undefined, disabled: !specs.length || previewing },
        { label: generating ? 'Generating…' : 'Generate', onClick: canGenerate && !generating ? doGenerate : undefined, disabled: !canGenerate || generating },
      ]},
      { label: 'Item', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: dirty && !saving ? () => save() : undefined, disabled: !dirty || saving },
      ]},
    ]},
  ], [previewing, generating, specs.length, canGenerate, doPreview, doGenerate, saving, dirty, save]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create synthetic data generator"
        intro="A synthetic data generator produces real rows from per-column strategies (faker-style names, dates, categoricals, numeric distributions) and writes them to a real Delta table. Seed the columns from a data contract or define them by hand; PII-classified columns are synthesized (fake, never real). Azure-native (Databricks SQL) — no Microsoft Fabric required. Create it, then design columns and generate." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'design' | 'runs')}>
            <Tab value="design" icon={<SparkleRegular />}>Design</Tab>
            <Tab value="runs" icon={<HistoryRegular />}>Runs{runs.length ? ` (${runs.length})` : ''}</Tab>
          </TabList>
        </div>

        <div className={s.body}>
          <TeachingBanner
            surfaceKey="synthetic-data-editor"
            icon={SparkleRegular}
            title="Generate synthetic data"
            message="Seed columns from a data contract or define them by hand, pick a per-column generation strategy, preview real rows, then generate a full table written to Delta. PII-shaped columns are synthesized (fake names/emails — never real data). Azure-native (Databricks SQL) — no Microsoft Fabric required."
            learnMoreHref="https://learn.microsoft.com/azure/databricks/sql/"
          />
          {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
          {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

          {tab === 'design' && (loading ? <Spinner label="Loading…" /> : (
            <>
              {/* Source schema */}
              <div className={s.card}>
                <span className={s.sectionHeader}><DatabaseRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Source schema</Subtitle2></span>
                <RadioGroup layout="horizontal" value={sourceMode} onChange={(_, d) => setSourceMode(d.value as 'contract' | 'manual')}>
                  <Radio value="manual" label="Define columns" />
                  <Radio value="contract" label="From a data contract" disabled={!contracts.length} />
                </RadioGroup>
                {sourceMode === 'contract' && (
                  <Field label="Data contract" hint={contracts.length ? 'Seeds columns + infers strategies (PII → synthetic)' : 'No data contracts with a schema in this workspace'}>
                    <Dropdown value={contracts.find((c) => c.id === state.sourceContractId)?.name || ''} selectedOptions={state.sourceContractId ? [state.sourceContractId] : []} placeholder="Select a data contract"
                      disabled={!contracts.length} onOptionSelect={(_, d) => d.optionValue && seedFromContract(d.optionValue)}>
                      {contracts.map((c) => <Option key={c.id} value={c.id} text={c.name}>{c.name} · {c.columns.length} cols</Option>)}
                    </Dropdown>
                  </Field>
                )}
              </div>

              {/* Columns + strategies */}
              <div className={s.card}>
                <span className={s.sectionHeader}><TableRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Columns &amp; generation strategy</Subtitle2>
                  <div style={{ flex: 1 }} />
                  <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={addColumn}>Add column</Button>
                </span>
                {specs.length === 0 ? (
                  <Caption1 className={s.hint}>No columns yet. Add a column or seed from a data contract.</Caption1>
                ) : (
                  <div className={s.scroll}>
                    <Table size="small" aria-label="Column generation specs">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Strategy</TableHeaderCell><TableHeaderCell>Options</TableHeaderCell>
                        <TableHeaderCell>Null %</TableHeaderCell><TableHeaderCell />
                      </TableRow></TableHeader>
                      <TableBody>
                        {specs.map((c, i) => {
                          const needs = STRATEGY_NEEDS.get(c.strategy) || [];
                          const o = c.options || {};
                          return (
                            <TableRow key={i}>
                              <TableCell>
                                <div className={s.row}>
                                  <Input value={c.name} style={{ minWidth: 120 }} onChange={(_, d) => patchSpec(i, { name: d.value })} aria-label="Column name" />
                                  {c.pii && <Badge appearance="tint" color="danger" icon={<ShieldKeyholeRegular />}>PII→synthetic</Badge>}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Dropdown value={c.type || 'string'} selectedOptions={[c.type || 'string']} onOptionSelect={(_, d) => d.optionValue && patchSpec(i, { type: d.optionValue })} aria-label="Column type">
                                  {CONTRACT_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                                </Dropdown>
                              </TableCell>
                              <TableCell>
                                <Dropdown value={GEN_STRATEGIES.find((g) => g.value === c.strategy)?.label || c.strategy} selectedOptions={[c.strategy]}
                                  onOptionSelect={(_, d) => d.optionValue && patchSpec(i, { strategy: d.optionValue as GenStrategy })} aria-label="Generation strategy">
                                  {GEN_STRATEGIES.map((g) => <Option key={g.value} value={g.value} text={g.label}>{g.label}</Option>)}
                                </Dropdown>
                              </TableCell>
                              <TableCell>
                                <div className={s.optWrap}>
                                  {needs.includes('range') && <>
                                    <Input className={s.numIn} type="number" placeholder="min" value={o.min != null ? String(o.min) : ''} onChange={(_, d) => patchOpt(i, { min: Number(d.value) })} aria-label="min" />
                                    <Input className={s.numIn} type="number" placeholder="max" value={o.max != null ? String(o.max) : ''} onChange={(_, d) => patchOpt(i, { max: Number(d.value) })} aria-label="max" />
                                  </>}
                                  {needs.includes('precision') && <Input className={s.numIn} type="number" placeholder="decimals" value={o.precision != null ? String(o.precision) : ''} onChange={(_, d) => patchOpt(i, { precision: Number(d.value) })} aria-label="precision" />}
                                  {needs.includes('distribution') && <>
                                    <Input className={s.numIn} type="number" placeholder="mean" value={o.mean != null ? String(o.mean) : ''} onChange={(_, d) => patchOpt(i, { mean: Number(d.value) })} aria-label="mean" />
                                    <Input className={s.numIn} type="number" placeholder="stddev" value={o.stddev != null ? String(o.stddev) : ''} onChange={(_, d) => patchOpt(i, { stddev: Number(d.value) })} aria-label="stddev" />
                                  </>}
                                  {needs.includes('values') && <Input placeholder="a, b, c" value={(o.values || []).join(', ')} onChange={(_, d) => patchOpt(i, { values: d.value.split(',').map((x) => x.trim()).filter(Boolean) })} aria-label="values" />}
                                  {needs.includes('dateRange') && <>
                                    <Input className={s.numIn} placeholder="start" value={o.start || ''} onChange={(_, d) => patchOpt(i, { start: d.value })} aria-label="start" />
                                    <Input className={s.numIn} placeholder="end" value={o.end || ''} onChange={(_, d) => patchOpt(i, { end: d.value })} aria-label="end" />
                                  </>}
                                  {needs.includes('constant') && <Input placeholder="value" value={o.constant || ''} onChange={(_, d) => patchOpt(i, { constant: d.value })} aria-label="constant" />}
                                  {needs.includes('startAt') && <Input className={s.numIn} type="number" placeholder="start at" value={o.startAt != null ? String(o.startAt) : ''} onChange={(_, d) => patchOpt(i, { startAt: Number(d.value) })} aria-label="start at" />}
                                  {needs.length === 0 && <Caption1 className={s.hint}>—</Caption1>}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Input className={s.numIn} type="number" placeholder="0" value={o.nullRate != null ? String(Math.round(o.nullRate * 100)) : ''} onChange={(_, d) => patchOpt(i, { nullRate: Math.max(0, Math.min(100, Number(d.value) || 0)) / 100 })} aria-label="null percent" />
                              </TableCell>
                              <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove ${c.name}`} onClick={() => removeColumn(i)} /></TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <div className={s.grid}>
                  <Field label="Rows to generate" hint="Up to 200,000">
                    <Input type="number" value={String(rowCount)} onChange={(_, d) => setState((p) => ({ ...p, rowCount: Math.max(1, Math.min(200000, Number(d.value) || 100)) }))} />
                  </Field>
                  <Field label="Seed" hint="Same seed reproduces the same rows">
                    <Input type="number" value={String(seed)} onChange={(_, d) => setState((p) => ({ ...p, seed: Number(d.value) || 1 }))} />
                  </Field>
                </div>
              </div>

              {/* Write target (Databricks Unity Catalog cascade) */}
              <div className={s.card}>
                <span className={s.sectionHeader}><DatabaseRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Write target</Subtitle2></span>
                {dbxGate && (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>Databricks not configured</MessageBarTitle>
                    Generated rows are written to a real Delta table via Databricks SQL. Set <code>{dbxGate}</code> (+ a SQL warehouse) on the loom-console env. Preview still works with no backend.
                  </MessageBarBody></MessageBar>
                )}
                <div className={s.grid}>
                  <Field label="SQL warehouse">
                    <Dropdown value={warehouses.find((w) => w.id === state.warehouseId)?.name || ''} selectedOptions={state.warehouseId ? [state.warehouseId] : []} placeholder={warehouses.length ? 'Select warehouse' : 'None'} disabled={!warehouses.length}
                      onOptionSelect={(_, d) => d.optionValue && onWarehouse(d.optionValue)}>
                      {warehouses.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}{w.state ? ` · ${w.state}` : ''}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Catalog">
                    <Dropdown value={state.catalog || ''} selectedOptions={state.catalog ? [state.catalog] : []} placeholder="Catalog" disabled={!catalogs.length}
                      onOptionSelect={(_, d) => d.optionValue && onCatalog(d.optionValue)}>
                      {catalogs.map((c) => <Option key={c} value={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Schema">
                    <Dropdown value={state.schema || ''} selectedOptions={state.schema ? [state.schema] : []} placeholder="Schema" disabled={!schemas.length}
                      onOptionSelect={(_, d) => d.optionValue && onSchema(d.optionValue)}>
                      {schemas.map((c) => <Option key={c} value={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Staging volume" hint="UC volume (catalog.schema.volume) used to stage the rows">
                    <Dropdown value={state.volume || ''} selectedOptions={state.volume ? [state.volume] : []} placeholder="Volume" disabled={!volumes.length}
                      onOptionSelect={(_, d) => d.optionValue && setState((p) => ({ ...p, volume: d.optionValue || '' }))}>
                      {volumes.map((v) => <Option key={v} value={v}>{v}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Table name" hint="New Delta table (letters, digits, underscore)">
                    <Input value={state.table || ''} placeholder="synthetic_orders" onChange={(_, d) => setState((p) => ({ ...p, table: d.value.replace(/[^A-Za-z0-9_]/g, '_') }))} />
                  </Field>
                </div>
                <div className={s.row}>
                  <Button appearance="outline" icon={previewing ? <Spinner size="tiny" /> : <SparkleRegular />} disabled={!specs.length || previewing} onClick={doPreview}>{previewing ? 'Previewing…' : 'Preview sample'}</Button>
                  <Button appearance="primary" icon={generating ? <Spinner size="tiny" /> : <PlayRegular />} disabled={!canGenerate || generating} onClick={doGenerate}>{generating ? 'Generating…' : 'Generate table'}</Button>
                  {!canGenerate && <Caption1 className={s.hint}>Add columns and pick a warehouse, catalog, schema, volume and table to generate.</Caption1>}
                </div>
                {(previewing || generating) && <ProgressBar />}
              </div>

              {/* Preview */}
              {preview && (
                <div className={s.card}>
                  <span className={s.sectionHeader}><SparkleRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Preview ({preview.rows.length} rows)</Subtitle2></span>
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Synthetic preview">
                      <TableHeader><TableRow>{preview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                      <TableBody>
                        {preview.rows.map((r, i) => (
                          <TableRow key={i}>{preview.columns.map((c) => <TableCell key={c}><span className={s.mono}>{r[c] === null ? '∅' : String(r[c])}</span></TableCell>)}</TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          ))}

          {tab === 'runs' && (
            <div className={s.card}>
              <span className={s.sectionHeader}><HistoryRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Generation history</Subtitle2></span>
              {!runs.length ? (
                <Caption1 className={s.hint}>No generations yet. Design columns and click Generate.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Generation history">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Started</TableHeaderCell><TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell>Rows</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {runs.map((rn) => (
                        <TableRow key={rn.id}>
                          <TableCell>{new Date(rn.startedAt).toLocaleString()}</TableCell>
                          <TableCell><span className={s.mono}>{rn.target}</span></TableCell>
                          <TableCell>{rn.rowsWritten != null ? rn.rowsWritten : '—'} / {rn.requestedRows}</TableCell>
                          <TableCell><Badge appearance="tint" color={rn.status === 'failed' ? 'danger' : rn.status === 'partial' ? 'warning' : 'success'}>{rn.status}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Divider />
              <Caption1 className={s.hint}>Runs are persisted with the item. Newest first; up to 50 retained.</Caption1>
            </div>
          )}

          <Text className={s.hint} size={200}>
            <Body1 as="span"><ShieldKeyholeRegular /> </Body1>
            Every value is synthesized from scratch — no source row is copied — so no real PII is ever emitted. PII-classified source columns map to synthetic names/emails or a redacted mask.
          </Text>
        </div>
      </div>
    } />
  );
}
