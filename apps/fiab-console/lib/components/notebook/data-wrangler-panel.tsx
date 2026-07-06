'use client';

/**
 * DataWranglerPanel — right-side OverlayDrawer that reproduces Microsoft
 * Fabric's **Data Wrangler** (the notebook-based, visual data-prep tool) 1:1 on
 * Azure, with the Loom theme applied. Microsoft Learn:
 *   https://learn.microsoft.com/fabric/data-science/data-wrangler
 *   https://learn.microsoft.com/fabric/data-science/data-wrangler-spark
 *
 * Parity surface (one-for-one, per ui-parity.md):
 *   • Operation gallery — a searchable, categorised list of cleaning steps
 *     (sort / filter / drop columns / rename / fill missing / one-hot / group by
 *     / type cast / split / …), each chosen from the gallery — NEVER freeform
 *     code (loom_no_freeform_config; Fabric's freeform "custom code" op is
 *     deliberately not reproduced).
 *   • Live preview grid — the sample DataFrame with every QUEUED step applied,
 *     plus per-column summary (dtype / missing / unique). A REAL backend (the
 *     loom-wrangler-host pandas Container App) executes the transforms on the
 *     sample — no mock preview.
 *   • Cleaning-steps recipe — the ordered queue, each removable.
 *   • Export-to-cell — generate the equivalent **pandas AND PySpark** code and
 *     insert it into a notebook cell (Fabric's "Add code to notebook").
 *
 * No Microsoft Fabric dependency: the backend is a plain pandas service reached
 * via /api/notebook/wrangler. When the host isn't deployed the route honest-gates
 * on LOOM_WRANGLER_ENDPOINT and this panel surfaces that verbatim in a warning
 * MessageBar — the full surface still renders (no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Badge, Button, Caption1, Subtitle2, Body1, Input, Textarea, Select, Switch, Checkbox,
  Field, Divider, Spinner, Tooltip, Tag, TagGroup,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Accordion, AccordionItem, AccordionHeader, AccordionPanel,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Sparkle20Regular, Add16Regular, Delete16Regular,
  Table16Regular, Code16Regular, DataArea20Regular, DocumentTable16Regular,
  BroomRegular, Search16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import {
  WRANGLER_OPERATIONS, type WranglerOp, type WranglerField, SAMPLE_CSV,
} from '@/lib/notebook/wrangler-operations';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, height: '100%', minHeight: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  toolbar: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  main: { display: 'flex', gap: tokens.spacingHorizontalL, flex: 1, minHeight: 0 },
  // Left rail — operation gallery + the selected-op parameter form.
  rail: {
    width: '300px', minWidth: '300px', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS, overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS,
  },
  content: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, overflow: 'hidden' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  opButton: { justifyContent: 'flex-start', width: '100%' },
  // Parameter form card for the selected operation — elevated so it reads as a
  // focused editing surface, matching sibling editors' card affordances.
  opCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorBrandStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  recipe: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  checkList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, maxHeight: '160px', overflowY: 'auto' },
  gridWrap: {
    flex: 1, minHeight: 0, overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
  },
  th: { whiteSpace: 'nowrap' },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  colMeta: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightRegular },
  codeRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

interface Sample { columns: string[]; rows: Record<string, unknown>[]; }
interface ColSummary { name: string; dtype: string; missing: number; unique: number; }
interface StepResult { index: number; op: string; ok: boolean; error?: string | null; }
export interface QueuedStep { op: string; [k: string]: unknown; }

export interface DataWranglerPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Insert a code cell with the given source into the notebook (export-to-cell). */
  onInsertCell: (source: string, lang: 'pyspark' | 'python') => void;
  /** DataFrame variable the generated code should operate on (Fabric uses `df`). */
  dfVar?: string;
}

/** Minimal, dependency-free CSV parse for the pasted / sample data. */
function parseCsv(text: string): Sample {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { columns: [], rows: [] };
  const split = (l: string) => l.split(',').map((c) => c.trim());
  const columns = split(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const vals = split(l);
    const rec: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      const v = vals[i];
      if (v === undefined || v === '') { rec[c] = null; return; }
      const n = Number(v);
      rec[c] = v !== '' && !Number.isNaN(n) && /^-?\d*\.?\d+$/.test(v) ? n : v;
    });
    return rec;
  });
  return { columns, rows };
}

export function DataWranglerPanel({ open, onOpenChange, onInsertCell, dfVar = 'df' }: DataWranglerPanelProps) {
  const s = useStyles();
  const [dataText, setDataText] = useState('');
  const [sample, setSample] = useState<Sample>({ columns: [], rows: [] });
  const [steps, setSteps] = useState<QueuedStep[]>([]);
  const [activeOp, setActiveOp] = useState<WranglerOp | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; summary: ColSummary[]; steps: StepResult[]; code: { pandas: string; pyspark: string } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null); // honest-gate message (503)
  const [error, setError] = useState<string | null>(null);

  const columns = preview?.columns.length ? preview.columns : sample.columns;

  // Categorise the gallery + honor the search box.
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, WranglerOp[]>();
    for (const op of WRANGLER_OPERATIONS) {
      if (q && !op.label.toLowerCase().includes(q) && !op.category.toLowerCase().includes(q)) continue;
      const list = map.get(op.category) ?? [];
      list.push(op);
      map.set(op.category, list);
    }
    return [...map.entries()];
  }, [search]);

  // Load the sample (real user data via CSV paste, or the labelled starter).
  const loadSample = useCallback((text: string) => {
    setDataText(text);
    setSample(parseCsv(text));
    setPreview(null);
  }, []);

  // Fetch a REAL preview from the pandas host whenever the sample or the queued
  // steps change. Debounced so rapid step edits collapse into one call.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runPreview = useCallback(async (nextSteps: QueuedStep[]) => {
    if (!sample.rows.length) { setPreview(null); return; }
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch('/api/notebook/wrangler', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ columns: sample.columns, rows: sample.rows, steps: nextSteps, dfVar }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (r.status === 503) setGate(j.error);
        else setError(j.error || `Preview failed (HTTP ${r.status}).`);
        return;
      }
      setPreview({
        columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount || 0,
        summary: j.summary || [], steps: j.steps || [], code: j.code || { pandas: '', pyspark: '' },
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, [sample, dfVar]);

  useEffect(() => {
    if (!open || !sample.rows.length) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runPreview(steps), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [open, steps, sample, runPreview]);

  // Selecting an operation opens its parameter form (seeded with defaults).
  const selectOp = useCallback((op: WranglerOp) => {
    setActiveOp(op);
    const seed: Record<string, unknown> = {};
    for (const f of op.fields) {
      if (f.type === 'bool') seed[f.name] = true;
      else if (f.type === 'select') seed[f.name] = f.options?.[0] ?? '';
      else if (f.type === 'columns') seed[f.name] = [];
      else if (f.type === 'column') seed[f.name] = columns[0] ?? '';
      else seed[f.name] = '';
    }
    setParams(seed);
  }, [columns]);

  const addStep = useCallback(() => {
    if (!activeOp) return;
    setSteps((prev) => [...prev, { op: activeOp.op, ...params }]);
    setActiveOp(null);
    setParams({});
  }, [activeOp, params]);

  const removeStep = useCallback((idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const clearAll = useCallback(() => { setSteps([]); }, []);

  const insert = useCallback((lang: 'pyspark' | 'python') => {
    const code = lang === 'pyspark' ? preview?.code.pyspark : preview?.code.pandas;
    if (code) onInsertCell(code, lang);
  }, [preview, onInsertCell]);

  // Render a single field control for the selected operation's form.
  const renderField = (f: WranglerField) => {
    const val = params[f.name];
    if (f.type === 'columns') {
      const selected = Array.isArray(val) ? (val as string[]) : [];
      const toggle = (c: string, on: boolean) =>
        setParams((p) => {
          const cur = Array.isArray(p[f.name]) ? (p[f.name] as string[]) : [];
          return { ...p, [f.name]: on ? [...cur, c] : cur.filter((x) => x !== c) };
        });
      return (
        <Field key={f.name} label={f.label}>
          <div className={s.checkList}>
            {columns.map((c) => (
              <Checkbox key={c} label={c} checked={selected.includes(c)}
                onChange={(_e, d) => toggle(c, !!d.checked)} />
            ))}
          </div>
        </Field>
      );
    }
    if (f.type === 'column') {
      return (
        <Field key={f.name} label={f.label}>
          <Select value={(val as string) ?? ''} onChange={(_e, d) => setParams((p) => ({ ...p, [f.name]: d.value }))}>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      );
    }
    if (f.type === 'select') {
      return (
        <Field key={f.name} label={f.label}>
          <Select value={(val as string) ?? ''} onChange={(_e, d) => setParams((p) => ({ ...p, [f.name]: d.value }))}>
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </Select>
        </Field>
      );
    }
    if (f.type === 'bool') {
      return (
        <Field key={f.name} label={f.label}>
          <Switch checked={!!val} onChange={(_e, d) => setParams((p) => ({ ...p, [f.name]: d.checked }))} />
        </Field>
      );
    }
    return (
      <Field key={f.name} label={f.label}>
        <Input value={(val as string) ?? ''} onChange={(_e, d) => setParams((p) => ({ ...p, [f.name]: d.value }))} />
      </Field>
    );
  };

  return (
    <OverlayDrawer open={open} onOpenChange={(_, d) => onOpenChange(d.open)} position="end" size="large">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => onOpenChange(false)} aria-label="Close Data Wrangler" />}
        >
          <span className={s.titleRow}>
            <Sparkle20Regular />
            Data Wrangler
            <Badge appearance="tint" color="brand" size="small">pandas + PySpark</Badge>
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={s.body}>
          {/* Honest infra-gate — the full panel still renders below it. */}
          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Data Wrangler host not deployed</MessageBarTitle>
                {gate}
              </MessageBarBody>
            </MessageBar>
          )}
          {error && (
            <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
          )}

          {/* Data-source + export toolbar */}
          <div className={s.toolbar}>
            <Field label="DataFrame variable"><Input value={dfVar} disabled contentBefore={<DataArea20Regular />} /></Field>
            <Button appearance="secondary" icon={<DocumentTable16Regular />} onClick={() => loadSample(SAMPLE_CSV)}>
              Load sample data
            </Button>
            <div className={s.spacer} />
            <Tooltip content="Insert the generated pandas code as a notebook cell" relationship="label">
              <Button appearance="primary" icon={<Code16Regular />} disabled={!preview} onClick={() => insert('python')}>
                Insert pandas cell
              </Button>
            </Tooltip>
            <Tooltip content="Insert the generated PySpark code as a notebook cell" relationship="label">
              <Button appearance="primary" icon={<Code16Regular />} disabled={!preview} onClick={() => insert('pyspark')}>
                Insert PySpark cell
              </Button>
            </Tooltip>
          </div>

          {/* Sample input (real user data or the labelled starter). */}
          <Field label="Sample data (CSV — paste your own, or Load sample data). The preview + generated code run on this sample; the exported code runs on your full DataFrame.">
            <Textarea value={dataText} onChange={(_e, d) => loadSample(d.value)} rows={3}
              placeholder="Name,Age,City&#10;Alice,29,France&#10;Bob,,Spain" resize="vertical" />
          </Field>

          {!sample.rows.length ? (
            <EmptyState
              icon={<BroomRegular />}
              title="Prep your data visually"
              body="Paste a CSV sample (or Load sample data), then pick cleaning operations from the gallery. Each step runs on a real pandas backend and generates pandas + PySpark code you can insert into the notebook — a 1:1 match for Microsoft Fabric's Data Wrangler."
              primaryAction={{ label: 'Load sample data', onClick: () => loadSample(SAMPLE_CSV) }}
            />
          ) : (
            <div className={s.main}>
              {/* Left rail: operation gallery + parameter form. */}
              <div className={s.rail}>
                <Subtitle2 className={s.sectionHeader}><Search16Regular /> Operations</Subtitle2>
                <Input contentBefore={<Search16Regular />} value={search} placeholder="Search operations"
                  onChange={(_e, d) => setSearch(d.value)} />
                <Accordion multiple collapsible defaultOpenItems={grouped.map(([c]) => c)}>
                  {grouped.map(([cat, ops]) => (
                    <AccordionItem key={cat} value={cat}>
                      <AccordionHeader>{cat}</AccordionHeader>
                      <AccordionPanel>
                        {ops.map((op) => (
                          <Button key={op.op} appearance="subtle" size="small" className={s.opButton}
                            icon={<Add16Regular />} onClick={() => selectOp(op)}>
                            {op.label}
                          </Button>
                        ))}
                      </AccordionPanel>
                    </AccordionItem>
                  ))}
                </Accordion>

                {activeOp && (
                  <div className={s.opCard}>
                    <Subtitle2>{activeOp.label}</Subtitle2>
                    <Caption1 className={s.colMeta}>{activeOp.category}</Caption1>
                    {activeOp.fields.map(renderField)}
                    <div className={s.codeRow}>
                      <Button appearance="primary" size="small" icon={<Add16Regular />} onClick={addStep}>Add step</Button>
                      <Button appearance="subtle" size="small" onClick={() => setActiveOp(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Content: recipe + live preview grid + summary. */}
              <div className={s.content}>
                <div>
                  <Subtitle2 className={s.sectionHeader}>
                    <BroomRegular /> Cleaning steps ({steps.length})
                    {steps.length > 0 && (
                      <Button appearance="subtle" size="small" icon={<Delete16Regular />} onClick={clearAll}>Clear all</Button>
                    )}
                    {loading && <Spinner size="tiny" />}
                  </Subtitle2>
                  {steps.length === 0 ? (
                    <Caption1 className={s.colMeta}>No steps yet — pick an operation from the gallery.</Caption1>
                  ) : (
                    <TagGroup onDismiss={(_e, d) => removeStep(Number(d.value))} className={s.recipe as any}>
                      {steps.map((st, i) => {
                        const meta = WRANGLER_OPERATIONS.find((o) => o.op === st.op);
                        const failed = preview?.steps.find((r) => r.index === i && !r.ok);
                        return (
                          <Tag key={i} value={String(i)} dismissible
                            appearance={failed ? 'outline' : 'filled'}
                            media={<Table16Regular />}
                            secondaryText={failed ? failed.error ?? 'error' : undefined}>
                            {`${i + 1}. ${meta?.label ?? st.op}`}
                          </Tag>
                        );
                      })}
                    </TagGroup>
                  )}
                </div>

                <Divider />

                <Subtitle2 className={s.sectionHeader}>
                  <Table16Regular /> Preview
                  {preview && <Badge appearance="tint" color="informative" size="small">{preview.rowCount} rows</Badge>}
                </Subtitle2>
                <div className={s.gridWrap}>
                  {preview && preview.columns.length > 0 ? (
                    <Table size="extra-small" aria-label="Data Wrangler preview">
                      <TableHeader>
                        <TableRow>
                          {preview.columns.map((c) => {
                            const cs = preview.summary.find((x) => x.name === c);
                            return (
                              <TableHeaderCell key={c} className={s.th}>
                                <div>{c}</div>
                                {cs && <Caption1 className={s.colMeta}>{cs.dtype} · {cs.missing} null · {cs.unique} uniq</Caption1>}
                              </TableHeaderCell>
                            );
                          })}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.rows.map((row, ri) => (
                          <TableRow key={ri}>
                            {preview.columns.map((c) => (
                              <TableCell key={c}>
                                <span className={s.cell}>{row[c] === null || row[c] === undefined ? '—' : String(row[c])}</span>
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <div style={{ padding: tokens.spacingVerticalXL }}>
                      <Body1 className={s.colMeta}>
                        {loading ? 'Running transforms on the pandas host…' : 'Preview will appear here once the sample loads.'}
                      </Body1>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
