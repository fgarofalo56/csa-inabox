'use client';

/**
 * pq-transform-dialogs — the column-aware structured dialogs that plug into the
 * PowerQueryHost seam (`hasTransformDialog` / `renderTransformDialog`), shared by
 * BOTH the Dataflow Gen2 editor and the report builder's "Transform Data" host
 * (Wave 4).
 *
 * Power Query Online exposes a guided dialog for every richer transform (Split
 * column, Pivot, Group by, Conditional column, Replace values, …). This module
 * is the Loom-themed parity of those dialogs: each one reads the active query's
 * REAL column schema (`TransformDialogRequest.columns`) and emits a refined
 * `RibbonTransform` whose `expr(prevStep)` is built from the dialog's STRUCTURED
 * fields. The host then applies that spec through the EXACT same path the bare
 * ribbon button uses — `m-script.appendStep` — so the output is always a real,
 * validated M applied step.
 *
 * Rules compliance:
 *  - no-freeform-config: there is NO raw-M textbox anywhere. Every field is a
 *    typed control (column Dropdown, operator Dropdown, number Input, Switch).
 *    The only free text is literal *values* (the text to find/replace, a filter
 *    threshold, a new column name) — each bound into M as a quoted string / number
 *    literal by the pure helpers below, never as hand-typed M.
 *  - no-vaporware: the emitted M is the same shape the ribbon produces; the
 *    foldable subset folds to real SQL via `foldAppliedStepsToSql` (DirectQuery)
 *    and the non-foldable steps materialize via the Import / wrangling-dataflow
 *    Delta path. The `foldable` flag the dialog stamps reflects what the fold
 *    engine can actually translate, so the host's DirectQuery gate stays honest.
 *  - no-fabric-dependency: pure UI over M; no api.fabric / api.powerbi / onelake.
 *  - web3-ui: Fluent v9 + Loom tokens + the canvas-node-kit `transform` accent,
 *    matching the PowerQueryHost it opens from + the Manage Parameters dialog.
 *
 * ADDITIVE: the host already declares the seam (both props optional, default off),
 * so wiring this module changes nothing for a host that does not pass it. When a
 * host DOES pass `hasTransformDialog`/`renderTransformDialog` (the report Transform
 * host today, the dataflow editor whenever it opts in) every registered ribbon key
 * opens its structured dialog instead of appending a placeholder step.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Textarea, Dropdown, Option, Field, Caption1, Subtitle2,
  Badge, Divider, Tooltip,
  MessageBar, MessageBarBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, Delete16Regular, TableSettings20Regular,
} from '@fluentui/react-icons';
import { quoteStepName, type RibbonTransform } from './m-script';
import type { TransformColumn, TransformDialogRequest } from './power-query-host';
import { CATEGORY_ACCENT, accentTint, accentGradient } from '@/lib/components/canvas/canvas-node-kit';

// Power Query is a data-wrangling surface → the kit's `transform` accent (violet),
// the SAME accent the PowerQueryHost frame + data-profiling + Manage Parameters use.
const ACCENT = CATEGORY_ACCENT.transform;

// ════════════════════════════════════════════════════════════════════════════
// Pure M-literal helpers (no hand-typed M — structured fields → validated M)
// ════════════════════════════════════════════════════════════════════════════

/** An M text literal `"…"` (doubling embedded quotes). */
function mStr(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

/** An M list of string literals `{"a", "b"}`. */
function mList(names: readonly string[]): string {
  return `{${names.map(mStr).join(', ')}}`;
}

/** An M record field-access selector — `[Name]` / `[#"Name with space"]`. */
function mField(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? `[${name}]`
    : `[#"${name.replace(/"/g, '""')}"]`;
}

/** True for an integer token. */
function isInt(v: string): boolean {
  return /^-?\d+$/.test(v.trim());
}

/**
 * Infer the M literal for a free value the user typed (a filter threshold, a
 * replacement, a conditional result): a bare number stays numeric, `true`/`false`
 * become logical literals, everything else is a quoted text literal. This is the
 * ONLY place free text enters M, and it is always escaped — the user never types
 * M or SQL (no-freeform-config), and the folded comparison/scalar accepts all
 * three forms.
 */
function inferLit(v: string): string {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase();
  return mStr(v);
}

/** Split a comma/newline-separated free column list into trimmed, non-empty names. */
function splitList(text: string): string[] {
  return text.split(/[\n,]/).map((x) => x.trim()).filter((x) => x.length > 0);
}

// ── Option sets (typed selects — never free text where a fixed set exists) ────

const FILTER_OPS: Array<{ value: string; label: string; op?: string; nullary?: 'is' | 'isNot' }> = [
  { value: 'equals', label: 'equals', op: '=' },
  { value: 'notEquals', label: 'does not equal', op: '<>' },
  { value: 'gt', label: 'is greater than', op: '>' },
  { value: 'ge', label: 'is greater than or equal to', op: '>=' },
  { value: 'lt', label: 'is less than', op: '<' },
  { value: 'le', label: 'is less than or equal to', op: '<=' },
  { value: 'isNull', label: 'is null', nullary: 'is' },
  { value: 'isNotNull', label: 'is not null', nullary: 'isNot' },
];

const SORT_DIRS: Array<{ value: string; label: string }> = [
  { value: 'Ascending', label: 'Ascending' },
  { value: 'Descending', label: 'Descending' },
];

const TYPE_KINDS: Array<{ value: string; label: string; m: string }> = [
  { value: 'text', label: 'Text', m: 'type text' },
  { value: 'int', label: 'Whole number', m: 'Int64.Type' },
  { value: 'decimal', label: 'Decimal number', m: 'type number' },
  { value: 'date', label: 'Date', m: 'type date' },
  { value: 'datetime', label: 'Date/time', m: 'type datetime' },
  { value: 'logical', label: 'True/False', m: 'type logical' },
];

const AGG_FNS: Array<{ value: string; label: string }> = [
  { value: 'count', label: 'Count rows' },
  { value: 'sum', label: 'Sum' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'avg', label: 'Average' },
];

const SPLIT_KINDS: Array<{ value: string; label: string }> = [
  { value: 'delimiter', label: 'By delimiter' },
  { value: 'positions', label: 'By number of characters (positions)' },
];

const EXTRACT_KINDS: Array<{ value: string; label: string }> = [
  { value: 'first', label: 'First characters' },
  { value: 'last', label: 'Last characters' },
  { value: 'range', label: 'Range' },
  { value: 'before', label: 'Text before delimiter' },
  { value: 'after', label: 'Text after delimiter' },
];

const FORMAT_KINDS: Array<{ value: string; label: string; m: string; foldable: boolean; step: string }> = [
  { value: 'upper', label: 'UPPERCASE', m: 'Text.Upper', foldable: true, step: 'Uppercased Text' },
  { value: 'lower', label: 'lowercase', m: 'Text.Lower', foldable: true, step: 'Lowercased Text' },
  { value: 'trim', label: 'Trim', m: 'Text.Trim', foldable: true, step: 'Trimmed Text' },
  { value: 'clean', label: 'Clean', m: 'Text.Clean', foldable: false, step: 'Cleaned Text' },
  { value: 'proper', label: 'Capitalize Each Word', m: 'Text.Proper', foldable: false, step: 'Capitalized Each Word' },
];

const REPLACER: Array<{ value: string; label: string; m: string }> = [
  { value: 'text', label: 'Text occurrences within the cell', m: 'Replacer.ReplaceText' },
  { value: 'value', label: 'Entire cell contents', m: 'Replacer.ReplaceValue' },
];

const PIVOT_AGG: Array<{ value: string; label: string; m: string | null }> = [
  { value: 'sum', label: 'Sum', m: 'List.Sum' },
  { value: 'count', label: 'Count', m: 'List.Count' },
  { value: 'min', label: 'Minimum', m: 'List.Min' },
  { value: 'max', label: 'Maximum', m: 'List.Max' },
  { value: 'avg', label: 'Average', m: 'List.Average' },
  { value: 'none', label: "Don't aggregate", m: null },
];

// ════════════════════════════════════════════════════════════════════════════
// Registry — which ribbon keys get a structured dialog
// ════════════════════════════════════════════════════════════════════════════

/**
 * Ribbon transform keys with a structured dialog in this module. Keys NOT listed
 * (transpose, reverse rows, remove blank rows, use-first-row-as-headers, custom
 * column, column-from-examples, merge/append queries) carry no options or need a
 * second query / heuristic, so the host appends their default step directly — the
 * existing, unchanged behavior.
 */
const DIALOG_KEYS = new Set<string>([
  // Home
  'chooseColumns', 'removeColumns', 'keepRows', 'removeDuplicates',
  'removeBottomRows', 'keepBottomRows', 'removeAlternateRows',
  'groupBy', 'groupByMulti',
  // Transform
  'filterRows', 'sortRows', 'renameColumns', 'reorderColumns', 'changeType',
  'splitColumn', 'mergeColumns', 'replaceValues', 'replaceErrors',
  'pivotColumn', 'unpivotColumns', 'unpivotOtherColumns', 'unpivotSelectedColumns',
  'fillDown', 'fillUp', 'extractText', 'formatText',
  // Add column
  'conditionalColumn', 'duplicateColumn', 'indexColumn', 'parseJson', 'parseXml',
]);

/** Does this ribbon transform key open a structured dialog? (the host seam) */
export function hasTransformDialog(key: string): boolean {
  return DIALOG_KEYS.has(key);
}

/**
 * Render the structured, column-aware dialog for a ribbon transform — the value
 * the host plugs into `renderTransformDialog`. Returns the live `<TransformDialog>`
 * which emits a refined `RibbonTransform` via `request.onEmit` (applied by the host
 * through `appendStep`) or dismisses via `request.onCancel`.
 */
export function renderTransformDialog(request: TransformDialogRequest): ReactNode {
  return <TransformDialog request={request} />;
}

// ════════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════════

const useStyles = makeStyles({
  surface: { maxWidth: '720px', width: '720px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  titleIcon: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', borderRadius: tokens.borderRadiusMedium,
    background: accentGradient(ACCENT), color: ACCENT,
    border: `1px solid ${accentTint(ACCENT, 24)}`,
  },
  body: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minWidth: 0, maxHeight: '60vh', overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalXS,
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  grow: { flex: 1, minWidth: '200px' },
  rep: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  repRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  repField: { flex: 1, minWidth: '140px' },
  addBtn: { alignSelf: 'flex-start' },
  sectionLabel: { color: tokens.colorNeutralForeground2 },
  hint: { color: tokens.colorNeutralForeground3 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
});

// ════════════════════════════════════════════════════════════════════════════
// Small reusable field controls
// ════════════════════════════════════════════════════════════════════════════

/** Single column picker: a Dropdown over the real schema, or a free Input when the
 *  host supplied no schema (honest fallback — the dialog still works). */
function ColField({
  columns, value, onChange, label = 'Column', className,
}: {
  columns: TransformColumn[];
  value: string;
  onChange: (v: string) => void;
  label?: string;
  className?: string;
}) {
  if (columns.length === 0) {
    return (
      <Field className={className} label={label} hint="Source schema unavailable — type the column name.">
        <Input value={value} onChange={(_, d) => onChange(d.value)} placeholder="ColumnName" />
      </Field>
    );
  }
  return (
    <Field className={className} label={label}>
      <Dropdown
        value={value}
        selectedOptions={value ? [value] : []}
        onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}
      >
        {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
      </Dropdown>
    </Field>
  );
}

/** Multi column picker: a multiselect Dropdown (selection order preserved) over
 *  the real schema, or a Textarea when no schema is available. */
function MultiColField({
  columns, value, onChange, label = 'Columns', hint, className,
}: {
  columns: TransformColumn[];
  value: string[];
  onChange: (v: string[]) => void;
  label?: string;
  hint?: string;
  className?: string;
}) {
  if (columns.length === 0) {
    return (
      <Field className={className} label={label} hint={hint ?? 'One column per line (source schema unavailable).'}>
        <Textarea
          value={value.join('\n')} resize="vertical"
          onChange={(_, d) => onChange(splitList(d.value))}
          placeholder={'Column1\nColumn2'}
        />
      </Field>
    );
  }
  return (
    <Field className={className} label={label} hint={hint}>
      <Dropdown
        multiselect
        value={value.join(', ')}
        selectedOptions={value}
        placeholder="Select columns"
        onOptionSelect={(_, d) => {
          const v = d.optionValue;
          if (!v) return;
          // Toggle while preserving the click order (matters for Reorder columns).
          onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
        }}
      >
        {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
      </Dropdown>
    </Field>
  );
}

function SelectField({
  label, value, options, onChange, className,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  className?: string;
}) {
  const cur = options.find((o) => o.value === value);
  return (
    <Field className={className} label={label}>
      <Dropdown
        value={cur?.label ?? value}
        selectedOptions={[value]}
        onOptionSelect={(_, d) => onChange(d.optionValue ?? value)}
      >
        {options.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
      </Dropdown>
    </Field>
  );
}

function NumField({
  label, value, onChange, className, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  hint?: string;
}) {
  return (
    <Field className={className} label={label} hint={hint}>
      <Input type="number" value={value} onChange={(_, d) => onChange(d.value)} />
    </Field>
  );
}

function TextField({
  label, value, onChange, className, hint, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <Field className={className} label={label} hint={hint}>
      <Input value={value} onChange={(_, d) => onChange(d.value)} placeholder={placeholder} />
    </Field>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// The dialog
// ════════════════════════════════════════════════════════════════════════════

type Row = Record<string, string>;

/** Seed the repeater rows for the keys that use a per-row editor. */
function seedRows(key: string, firstCol: string): Row[] {
  switch (key) {
    case 'renameColumns': return [{ from: firstCol, to: '' }];
    case 'sortRows': return [{ col: firstCol, dir: 'Ascending' }];
    case 'changeType': return [{ col: firstCol, type: 'text' }];
    case 'conditionalColumn': return [{ col: firstCol, op: 'equals', value: '', result: '' }];
    case 'groupBy':
    case 'groupByMulti': return [{ out: 'Count', fn: 'count', col: '' }];
    default: return [];
  }
}

function TransformDialog({ request }: { request: TransformDialogRequest }) {
  const s = useStyles();
  const { transform, columns } = request;
  const key = transform.key;
  const firstCol = columns[0]?.name ?? '';

  // ── Field state (only the controls a given key renders are consulted) ───────
  const [col1, setCol1] = useState(firstCol);
  const [col2, setCol2] = useState(columns[1]?.name ?? firstCol);
  const [multi, setMulti] = useState<string[]>([]);
  const [num1, setNum1] = useState('100');
  const [num2, setNum2] = useState('0');
  const [num3, setNum3] = useState('1');
  const [text1, setText1] = useState('');
  const [text2, setText2] = useState('');
  const [text3, setText3] = useState('');
  const [sel1, setSel1] = useState(() => {
    if (key === 'splitColumn') return 'delimiter';
    if (key === 'extractText') return 'first';
    if (key === 'formatText') return 'upper';
    if (key === 'pivotColumn') return 'sum';
    if (key === 'replaceValues') return 'text';
    return '';
  });
  const [rows, setRows] = useState<Row[]>(() => seedRows(key, firstCol));

  // Defaults that depend on the chosen column.
  const [newName, setNewName] = useState(() => (firstCol ? `${firstCol} - Copy` : 'Copy'));

  const addRow = (r: Row) => setRows((p) => [...p, r]);
  const patchRow = (i: number, patch: Row) => setRows((p) => p.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const dropRow = (i: number) => setRows((p) => (p.length <= 1 ? p : p.filter((_, j) => j !== i)));

  // The selected multi columns, resolved for either schema or free-entry mode.
  const selectedMulti = useMemo(() => multi, [multi]);

  // ── Validation (gates Apply; honest hint instead of emitting broken M) ──────
  const problem = useMemo<string | null>(() => {
    const needCol1 = () => (!col1.trim() ? 'Choose a column.' : null);
    const needMulti = () => (selectedMulti.length === 0 ? 'Select at least one column.' : null);
    const needInt = (v: string, what: string) => (!isInt(v) ? `${what} must be a whole number.` : null);
    switch (key) {
      case 'chooseColumns':
      case 'removeColumns':
      case 'reorderColumns':
      case 'unpivotColumns':
      case 'unpivotSelectedColumns':
      case 'fillDown':
      case 'fillUp':
        return needMulti();
      case 'unpivotOtherColumns':
        return needMulti();
      case 'mergeColumns':
        return selectedMulti.length < 2 ? 'Select at least two columns to merge.' : (!text2.trim() ? 'Name the merged column.' : null);
      case 'keepRows':
      case 'removeBottomRows':
      case 'keepBottomRows':
        return needInt(num1, 'Row count');
      case 'removeAlternateRows':
        return needInt(num1, 'First row') || needInt(num2, 'Rows to remove') || needInt(num3, 'Rows to keep');
      case 'removeDuplicates':
        return null; // optional subset
      case 'filterRows': {
        const c = needCol1(); if (c) return c;
        const op = FILTER_OPS.find((o) => o.value === sel1 || (sel1 === '' && o.value === 'equals'));
        if (op && !op.nullary && !text1.trim()) return 'Enter a value to compare against.';
        return null;
      }
      case 'splitColumn': {
        const c = needCol1(); if (c) return c;
        if (sel1 === 'positions') return splitList(text1).every(isInt) && splitList(text1).length > 0 ? null : 'Enter comma-separated character positions (e.g. 0, 5).';
        return text1.length === 0 ? 'Enter a delimiter.' : null;
      }
      case 'replaceValues':
        return needCol1();
      case 'replaceErrors':
        return needCol1();
      case 'pivotColumn':
        return needCol1() || (!col2.trim() ? 'Choose a values column.' : null);
      case 'extractText': {
        const c = needCol1(); if (c) return c;
        if (sel1 === 'first' || sel1 === 'last') return needInt(num1, 'Character count');
        if (sel1 === 'range') return needInt(num1, 'Starting index') || needInt(num2, 'Length');
        return text1.length === 0 ? 'Enter a delimiter.' : null;
      }
      case 'formatText':
        return needCol1();
      case 'duplicateColumn':
        return needCol1() || (!newName.trim() ? 'Name the new column.' : null);
      case 'indexColumn':
        return (!text1.trim() ? 'Name the index column.' : null) || needInt(num1, 'Start') || needInt(num2, 'Step');
      case 'parseJson':
      case 'parseXml':
        return needCol1();
      case 'renameColumns':
        return rows.some((r) => !r.from?.trim()) ? 'Choose a column for every rename.' : (rows.some((r) => !r.to?.trim()) ? 'Enter the new name for every rename.' : null);
      case 'sortRows':
        return rows.some((r) => !r.col?.trim()) ? 'Choose a column for every sort level.' : null;
      case 'changeType':
        return rows.some((r) => !r.col?.trim()) ? 'Choose a column for every type change.' : null;
      case 'conditionalColumn': {
        if (!text1.trim()) return 'Name the new column.';
        if (rows.some((r) => !r.col?.trim())) return 'Choose a column for every condition.';
        const anyNeedsVal = rows.some((r) => {
          const op = FILTER_OPS.find((o) => o.value === r.op);
          return op && !op.nullary && !r.value?.trim();
        });
        if (anyNeedsVal) return 'Enter a value for every comparing condition.';
        if (rows.some((r) => !r.result?.trim())) return 'Enter an output for every condition.';
        return null;
      }
      case 'groupBy':
      case 'groupByMulti': {
        if (selectedMulti.length === 0) return 'Select at least one column to group by.';
        if (rows.length === 0) return 'Add at least one aggregation.';
        if (rows.some((r) => !r.out?.trim())) return 'Name every aggregation column.';
        if (rows.some((r) => r.fn !== 'count' && !r.col?.trim())) return 'Choose a column for every non-count aggregation.';
        return null;
      }
      default:
        return needCol1();
    }
  }, [key, col1, col2, selectedMulti, num1, num2, num3, text1, text2, sel1, newName, rows]);

  // ── Build the refined RibbonTransform (only called when `problem` is null) ──
  function buildSpec(): RibbonTransform {
    const inherit = { key: transform.key, label: transform.label, tab: transform.tab };
    const make = (stepName: string, expr: (prev: string) => string, foldable?: boolean): RibbonTransform => ({
      ...inherit,
      stepName,
      expr: (prev: string) => expr(prev),
      foldable: foldable ?? transform.foldable,
    });

    switch (key) {
      case 'chooseColumns':
        return make('Chosen Columns', (p) => `Table.SelectColumns(${quoteStepName(p)}, ${mList(selectedMulti)})`, true);
      case 'removeColumns':
        return make('Removed Columns', (p) => `Table.RemoveColumns(${quoteStepName(p)}, ${mList(selectedMulti)})`, true);
      case 'reorderColumns':
        return make('Reordered Columns', (p) => `Table.ReorderColumns(${quoteStepName(p)}, ${mList(selectedMulti)})`, true);
      case 'keepRows':
        return make('Kept First Rows', (p) => `Table.FirstN(${quoteStepName(p)}, ${num1.trim()})`, true);
      case 'removeBottomRows':
        return make('Removed Bottom Rows', (p) => `Table.RemoveLastN(${quoteStepName(p)}, ${num1.trim()})`, false);
      case 'keepBottomRows':
        return make('Kept Bottom Rows', (p) => `Table.LastN(${quoteStepName(p)}, ${num1.trim()})`, false);
      case 'removeAlternateRows':
        return make('Removed Alternate Rows', (p) => `Table.AlternateRows(${quoteStepName(p)}, ${num1.trim()}, ${num2.trim()}, ${num3.trim()})`, false);
      case 'removeDuplicates':
        return selectedMulti.length > 0
          ? make('Removed Duplicates', (p) => `Table.Distinct(${quoteStepName(p)}, ${mList(selectedMulti)})`, false)
          : make('Removed Duplicates', (p) => `Table.Distinct(${quoteStepName(p)})`, true);
      case 'filterRows': {
        const op = FILTER_OPS.find((o) => o.value === sel1) ?? FILTER_OPS[0];
        return make('Filtered Rows', (p) => {
          const f = mField(col1);
          const pred = op.nullary === 'is' ? `${f} = null`
            : op.nullary === 'isNot' ? `${f} <> null`
              : `${f} ${op.op} ${inferLit(text1)}`;
          return `Table.SelectRows(${quoteStepName(p)}, each ${pred})`;
        }, true);
      }
      case 'sortRows':
        return make('Sorted Rows', (p) => {
          const pairs = rows.map((r) => `{${mStr(r.col)}, Order.${r.dir === 'Descending' ? 'Descending' : 'Ascending'}}`).join(', ');
          return `Table.Sort(${quoteStepName(p)}, {${pairs}})`;
        }, true);
      case 'renameColumns':
        return make('Renamed Columns', (p) => {
          const pairs = rows.map((r) => `{${mStr(r.from)}, ${mStr(r.to)}}`).join(', ');
          return `Table.RenameColumns(${quoteStepName(p)}, {${pairs}})`;
        }, true);
      case 'changeType':
        return make('Changed Type', (p) => {
          const pairs = rows.map((r) => {
            const m = TYPE_KINDS.find((t) => t.value === r.type)?.m ?? 'type text';
            return `{${mStr(r.col)}, ${m}}`;
          }).join(', ');
          return `Table.TransformColumnTypes(${quoteStepName(p)}, {${pairs}})`;
        }, true);
      case 'splitColumn':
        return make(sel1 === 'positions' ? 'Split Column by Position' : 'Split Column by Delimiter', (p) => {
          const parts = sel1 === 'positions'
            ? splitList(text1).length
            : Math.max(2, isInt(num1) ? parseInt(num1, 10) : 2);
          const names = Array.from({ length: parts }, (_, i) => `${col1}.${i + 1}`);
          const splitter = sel1 === 'positions'
            ? `Splitter.SplitTextByPositions({${splitList(text1).join(', ')}})`
            : `Splitter.SplitTextByDelimiter(${mStr(text1)}, QuoteStyle.Csv)`;
          return `Table.SplitColumn(${quoteStepName(p)}, ${mStr(col1)}, ${splitter}, ${mList(names)})`;
        }, false);
      case 'mergeColumns':
        return make('Merged Columns', (p) =>
          `Table.CombineColumns(${quoteStepName(p)}, ${mList(selectedMulti)}, Combiner.CombineTextByDelimiter(${mStr(text1)}, QuoteStyle.None), ${mStr(text2)})`, false);
      case 'replaceValues': {
        const replacer = REPLACER.find((r) => r.value === sel1)?.m ?? 'Replacer.ReplaceText';
        return make('Replaced Value', (p) =>
          `Table.ReplaceValue(${quoteStepName(p)}, ${mStr(text1)}, ${mStr(text2)}, ${replacer}, ${mList([col1])})`, true);
      }
      case 'replaceErrors':
        return make('Replaced Errors', (p) => {
          const lit = text1.trim() === '' ? 'null' : inferLit(text1);
          return `Table.ReplaceErrorValues(${quoteStepName(p)}, {{${mStr(col1)}, ${lit}}})`;
        }, false);
      case 'pivotColumn': {
        const agg = PIVOT_AGG.find((a) => a.value === sel1);
        return make('Pivoted Column', (p) => {
          const Q = quoteStepName(p);
          const aggArg = agg && agg.m ? `, ${agg.m}` : '';
          return `Table.Pivot(${Q}, List.Distinct(${Q}${mField(col1)}), ${mStr(col1)}, ${mStr(col2)}${aggArg})`;
        }, false);
      }
      case 'unpivotColumns':
      case 'unpivotSelectedColumns':
        return make('Unpivoted Columns', (p) =>
          `Table.Unpivot(${quoteStepName(p)}, ${mList(selectedMulti)}, ${mStr(text2 || 'Attribute')}, ${mStr(text3 || 'Value')})`, false);
      case 'unpivotOtherColumns':
        return make('Unpivoted Other Columns', (p) =>
          `Table.UnpivotOtherColumns(${quoteStepName(p)}, ${mList(selectedMulti)}, ${mStr(text2 || 'Attribute')}, ${mStr(text3 || 'Value')})`, false);
      case 'fillDown':
        return make('Filled Down', (p) => `Table.FillDown(${quoteStepName(p)}, ${mList(selectedMulti)})`, false);
      case 'fillUp':
        return make('Filled Up', (p) => `Table.FillUp(${quoteStepName(p)}, ${mList(selectedMulti)})`, false);
      case 'extractText': {
        const kind = sel1;
        const k = EXTRACT_KINDS.find((e) => e.value === kind);
        const step = kind === 'last' ? 'Extracted Last Characters'
          : kind === 'range' ? 'Extracted Text Range'
            : kind === 'before' ? 'Extracted Text Before Delimiter'
              : kind === 'after' ? 'Extracted Text After Delimiter'
                : 'Extracted First Characters';
        return make(step, (p) => {
          const fn = kind === 'last' ? `Text.End(_, ${num1.trim()})`
            : kind === 'range' ? `Text.Range(_, ${num1.trim()}, ${num2.trim()})`
              : kind === 'before' ? `Text.BeforeDelimiter(_, ${mStr(text1)})`
                : kind === 'after' ? `Text.AfterDelimiter(_, ${mStr(text1)})`
                  : `Text.Start(_, ${num1.trim()})`;
          return `Table.TransformColumns(${quoteStepName(p)}, {{${mStr(col1)}, each ${fn}, type text}})`;
        }, true);
      }
      case 'formatText': {
        const f = FORMAT_KINDS.find((o) => o.value === sel1) ?? FORMAT_KINDS[0];
        return make(f.step, (p) =>
          `Table.TransformColumns(${quoteStepName(p)}, {{${mStr(col1)}, ${f.m}, type text}})`, f.foldable);
      }
      case 'conditionalColumn':
        return make('Added Conditional Column', (p) => {
          const chain = rows.reduceRight((acc, r) => {
            const op = FILTER_OPS.find((o) => o.value === r.op) ?? FILTER_OPS[0];
            const f = mField(r.col);
            const cond = op.nullary === 'is' ? `${f} = null`
              : op.nullary === 'isNot' ? `${f} <> null`
                : `${f} ${op.op} ${inferLit(r.value)}`;
            return `if ${cond} then ${inferLit(r.result)} else ${acc}`;
          }, inferLit(text2));
          return `Table.AddColumn(${quoteStepName(p)}, ${mStr(text1)}, each ${chain})`;
        }, true);
      case 'duplicateColumn':
        return make('Duplicated Column', (p) =>
          `Table.DuplicateColumn(${quoteStepName(p)}, ${mStr(col1)}, ${mStr(newName)})`, false);
      case 'indexColumn':
        return make('Added Index', (p) =>
          `Table.AddIndexColumn(${quoteStepName(p)}, ${mStr(text1 || 'Index')}, ${num1.trim()}, ${num2.trim()}, Int64.Type)`, false);
      case 'parseJson':
        return make('Parsed JSON', (p) =>
          `Table.TransformColumns(${quoteStepName(p)}, {{${mStr(col1)}, Json.Document}})`, false);
      case 'parseXml':
        return make('Parsed XML', (p) =>
          `Table.TransformColumns(${quoteStepName(p)}, {{${mStr(col1)}, Xml.Tables}})`, false);
      case 'groupBy':
      case 'groupByMulti':
        return make('Grouped Rows', (p) => {
          const aggParts = rows.map((r) => {
            if (r.fn === 'count') return `{${mStr(r.out)}, each Table.RowCount(_), Int64.Type}`;
            const fnMap: Record<string, string> = { sum: 'List.Sum', min: 'List.Min', max: 'List.Max', avg: 'List.Average' };
            const fn = fnMap[r.fn] ?? 'List.Sum';
            return `{${mStr(r.out)}, each ${fn}(${mField(r.col)}), type nullable number}`;
          }).join(', ');
          return `Table.Group(${quoteStepName(p)}, ${mList(selectedMulti)}, {${aggParts}})`;
        }, true);
      default:
        // Should be unreachable (every DIALOG_KEYS member is handled); fall back
        // to the host's default ribbon expr so we never emit broken M.
        return { ...transform };
    }
  }

  const onApply = () => {
    if (problem) return;
    request.onEmit(buildSpec());
  };

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) request.onCancel(); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span className={s.titleRow}>
              <span className={s.titleIcon} aria-hidden="true"><TableSettings20Regular /></span>
              {transform.label}
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.badges}>
                <Caption1 className={s.hint}>
                  Configure this step — Loom builds the Power Query M for you (no hand-typed M).
                </Caption1>
                <Badge appearance="tint" color={(buildSafeFoldable() ?? transform.foldable) === false ? 'warning' : 'brand'}>
                  {(buildSafeFoldable() ?? transform.foldable) === false ? 'Import only' : 'Folds to SQL'}
                </Badge>
              </div>

              {renderFields()}

              {problem && (
                <MessageBar intent="warning">
                  <MessageBarBody>{problem}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => request.onCancel()}>Cancel</Button>
            <Button appearance="primary" icon={<Add16Regular />} disabled={!!problem} onClick={onApply}>
              Add step
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );

  // Compute the foldability the emitted spec WOULD carry, for the header badge,
  // without side effects (mirrors buildSpec's per-option foldable choices).
  function buildSafeFoldable(): boolean | undefined {
    switch (key) {
      case 'removeDuplicates': return selectedMulti.length > 0 ? false : true;
      case 'formatText': return (FORMAT_KINDS.find((o) => o.value === sel1) ?? FORMAT_KINDS[0]).foldable;
      default: return undefined;
    }
  }

  // ── Per-key field layout ────────────────────────────────────────────────────
  function renderFields(): ReactNode {
    switch (key) {
      case 'chooseColumns':
      case 'removeColumns':
      case 'reorderColumns':
        return (
          <MultiColField
            columns={columns} value={selectedMulti} onChange={setMulti}
            hint={key === 'reorderColumns' ? 'Selection order becomes the new column order.' : undefined}
          />
        );
      case 'fillDown':
      case 'fillUp':
        return <MultiColField columns={columns} value={selectedMulti} onChange={setMulti} hint="Columns whose nulls are filled from the adjacent value." />;
      case 'unpivotColumns':
      case 'unpivotSelectedColumns':
        return (
          <>
            <MultiColField columns={columns} value={selectedMulti} onChange={setMulti} label="Columns to unpivot" />
            <div className={s.row}>
              <TextField className={s.grow} label="Attribute column name" value={text2} onChange={setText2} placeholder="Attribute" />
              <TextField className={s.grow} label="Value column name" value={text3} onChange={setText3} placeholder="Value" />
            </div>
          </>
        );
      case 'unpivotOtherColumns':
        return (
          <>
            <MultiColField columns={columns} value={selectedMulti} onChange={setMulti} label="Columns to keep (others are unpivoted)" />
            <div className={s.row}>
              <TextField className={s.grow} label="Attribute column name" value={text2} onChange={setText2} placeholder="Attribute" />
              <TextField className={s.grow} label="Value column name" value={text3} onChange={setText3} placeholder="Value" />
            </div>
          </>
        );
      case 'mergeColumns':
        return (
          <>
            <MultiColField columns={columns} value={selectedMulti} onChange={setMulti} label="Columns to merge (in order)" />
            <div className={s.row}>
              <TextField className={s.grow} label="Separator" value={text1} onChange={setText1} placeholder="," />
              <TextField className={s.grow} label="New column name" value={text2} onChange={setText2} placeholder="Merged" />
            </div>
          </>
        );
      case 'keepRows':
        return <NumField label="Number of rows" value={num1} onChange={setNum1} />;
      case 'removeBottomRows':
      case 'keepBottomRows':
        return <NumField label="Number of rows" value={num1} onChange={setNum1} />;
      case 'removeAlternateRows':
        return (
          <div className={s.row}>
            <NumField className={s.grow} label="First row to remove" value={num1} onChange={setNum1} />
            <NumField className={s.grow} label="Rows to remove" value={num2} onChange={setNum2} />
            <NumField className={s.grow} label="Rows to keep" value={num3} onChange={setNum3} />
          </div>
        );
      case 'removeDuplicates':
        return <MultiColField columns={columns} value={selectedMulti} onChange={setMulti} label="Columns (optional — leave empty for whole-row duplicates)" />;
      case 'filterRows':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} />
            <SelectField label="Condition" value={sel1 || 'equals'} options={FILTER_OPS} onChange={setSel1} />
            {!FILTER_OPS.find((o) => o.value === (sel1 || 'equals'))?.nullary && (
              <TextField label="Value" value={text1} onChange={setText1} hint="Numbers and true/false are detected automatically; everything else is text." />
            )}
          </>
        );
      case 'splitColumn':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} />
            <SelectField label="Split" value={sel1} options={SPLIT_KINDS} onChange={setSel1} />
            {sel1 === 'positions' ? (
              <TextField label="Character positions" value={text1} onChange={setText1} placeholder="0, 5, 10" hint="Comma-separated zero-based positions." />
            ) : (
              <div className={s.row}>
                <TextField className={s.grow} label="Delimiter" value={text1} onChange={setText1} placeholder="," />
                <NumField className={s.grow} label="Number of columns" value={num1} onChange={setNum1} />
              </div>
            )}
          </>
        );
      case 'replaceValues':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} />
            <div className={s.row}>
              <TextField className={s.grow} label="Value to find" value={text1} onChange={setText1} />
              <TextField className={s.grow} label="Replace with" value={text2} onChange={setText2} />
            </div>
            <SelectField label="Match" value={sel1 || 'text'} options={REPLACER} onChange={setSel1} />
          </>
        );
      case 'replaceErrors':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} />
            <TextField label="Replacement value" value={text1} onChange={setText1} hint="Leave empty to replace errors with null." />
          </>
        );
      case 'pivotColumn':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} label="Column to pivot (becomes new column headers)" />
            <ColField columns={columns} value={col2} onChange={setCol2} label="Values column" />
            <SelectField label="Aggregate values by" value={sel1 || 'sum'} options={PIVOT_AGG} onChange={setSel1} />
          </>
        );
      case 'extractText':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} />
            <SelectField label="Extract" value={sel1 || 'first'} options={EXTRACT_KINDS} onChange={setSel1} />
            {(sel1 === 'first' || sel1 === 'last' || sel1 === '') && (
              <NumField label="Number of characters" value={num1} onChange={setNum1} />
            )}
            {sel1 === 'range' && (
              <div className={s.row}>
                <NumField className={s.grow} label="Starting index (0-based)" value={num1} onChange={setNum1} />
                <NumField className={s.grow} label="Number of characters" value={num2} onChange={setNum2} />
              </div>
            )}
            {(sel1 === 'before' || sel1 === 'after') && (
              <TextField label="Delimiter" value={text1} onChange={setText1} placeholder="-" />
            )}
          </>
        );
      case 'formatText':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={setCol1} />
            <SelectField label="Format" value={sel1 || 'upper'} options={FORMAT_KINDS} onChange={setSel1} />
          </>
        );
      case 'duplicateColumn':
        return (
          <>
            <ColField columns={columns} value={col1} onChange={(v) => { setCol1(v); setNewName(`${v} - Copy`); }} />
            <TextField label="New column name" value={newName} onChange={setNewName} />
          </>
        );
      case 'indexColumn':
        return (
          <>
            <TextField label="Index column name" value={text1} onChange={setText1} placeholder="Index" />
            <div className={s.row}>
              <NumField className={s.grow} label="Starting index" value={num1} onChange={setNum1} />
              <NumField className={s.grow} label="Increment" value={num2} onChange={setNum2} />
            </div>
          </>
        );
      case 'parseJson':
      case 'parseXml':
        return <ColField columns={columns} value={col1} onChange={setCol1} label={`Column containing ${key === 'parseJson' ? 'JSON' : 'XML'} text`} />;
      case 'renameColumns':
        return (
          <div className={s.rep}>
            <Subtitle2 className={s.sectionLabel}>Renames</Subtitle2>
            {rows.map((r, i) => (
              <div className={s.repRow} key={i}>
                {columns.length > 0 ? (
                  <Field className={s.repField} label="Column">
                    <Dropdown value={r.from} selectedOptions={r.from ? [r.from] : []} onOptionSelect={(_, d) => patchRow(i, { from: d.optionValue ?? '' })}>
                      {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                    </Dropdown>
                  </Field>
                ) : (
                  <Field className={s.repField} label="Column"><Input value={r.from} onChange={(_, d) => patchRow(i, { from: d.value })} /></Field>
                )}
                <Field className={s.repField} label="New name"><Input value={r.to} onChange={(_, d) => patchRow(i, { to: d.value })} /></Field>
                <Tooltip content="Remove" relationship="label">
                  <Button appearance="subtle" icon={<Delete16Regular />} disabled={rows.length <= 1} onClick={() => dropRow(i)} aria-label="Remove rename" />
                </Tooltip>
              </div>
            ))}
            <Button className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => addRow({ from: firstCol, to: '' })}>Add rename</Button>
          </div>
        );
      case 'sortRows':
        return (
          <div className={s.rep}>
            <Subtitle2 className={s.sectionLabel}>Sort levels</Subtitle2>
            {rows.map((r, i) => (
              <div className={s.repRow} key={i}>
                {columns.length > 0 ? (
                  <Field className={s.repField} label="Column">
                    <Dropdown value={r.col} selectedOptions={r.col ? [r.col] : []} onOptionSelect={(_, d) => patchRow(i, { col: d.optionValue ?? '' })}>
                      {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                    </Dropdown>
                  </Field>
                ) : (
                  <Field className={s.repField} label="Column"><Input value={r.col} onChange={(_, d) => patchRow(i, { col: d.value })} /></Field>
                )}
                <Field className={s.repField} label="Direction">
                  <Dropdown value={SORT_DIRS.find((o) => o.value === r.dir)?.label ?? 'Ascending'} selectedOptions={[r.dir]} onOptionSelect={(_, d) => patchRow(i, { dir: d.optionValue ?? 'Ascending' })}>
                    {SORT_DIRS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                  </Dropdown>
                </Field>
                <Tooltip content="Remove" relationship="label">
                  <Button appearance="subtle" icon={<Delete16Regular />} disabled={rows.length <= 1} onClick={() => dropRow(i)} aria-label="Remove sort level" />
                </Tooltip>
              </div>
            ))}
            <Button className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => addRow({ col: firstCol, dir: 'Ascending' })}>Add level</Button>
          </div>
        );
      case 'changeType':
        return (
          <div className={s.rep}>
            <Subtitle2 className={s.sectionLabel}>Type changes</Subtitle2>
            {rows.map((r, i) => (
              <div className={s.repRow} key={i}>
                {columns.length > 0 ? (
                  <Field className={s.repField} label="Column">
                    <Dropdown value={r.col} selectedOptions={r.col ? [r.col] : []} onOptionSelect={(_, d) => patchRow(i, { col: d.optionValue ?? '' })}>
                      {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                    </Dropdown>
                  </Field>
                ) : (
                  <Field className={s.repField} label="Column"><Input value={r.col} onChange={(_, d) => patchRow(i, { col: d.value })} /></Field>
                )}
                <Field className={s.repField} label="Type">
                  <Dropdown value={TYPE_KINDS.find((o) => o.value === r.type)?.label ?? 'Text'} selectedOptions={[r.type]} onOptionSelect={(_, d) => patchRow(i, { type: d.optionValue ?? 'text' })}>
                    {TYPE_KINDS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                  </Dropdown>
                </Field>
                <Tooltip content="Remove" relationship="label">
                  <Button appearance="subtle" icon={<Delete16Regular />} disabled={rows.length <= 1} onClick={() => dropRow(i)} aria-label="Remove type change" />
                </Tooltip>
              </div>
            ))}
            <Button className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => addRow({ col: firstCol, type: 'text' })}>Add column</Button>
          </div>
        );
      case 'conditionalColumn':
        return (
          <>
            <TextField label="New column name" value={text1} onChange={setText1} placeholder="Custom" />
            <Divider />
            <div className={s.rep}>
              <Subtitle2 className={s.sectionLabel}>Conditions (first match wins)</Subtitle2>
              {rows.map((r, i) => {
                const op = FILTER_OPS.find((o) => o.value === r.op) ?? FILTER_OPS[0];
                return (
                  <div className={s.repRow} key={i}>
                    {columns.length > 0 ? (
                      <Field className={s.repField} label="Column">
                        <Dropdown value={r.col} selectedOptions={r.col ? [r.col] : []} onOptionSelect={(_, d) => patchRow(i, { col: d.optionValue ?? '' })}>
                          {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                        </Dropdown>
                      </Field>
                    ) : (
                      <Field className={s.repField} label="Column"><Input value={r.col} onChange={(_, d) => patchRow(i, { col: d.value })} /></Field>
                    )}
                    <Field className={s.repField} label="Operator">
                      <Dropdown value={op.label} selectedOptions={[r.op]} onOptionSelect={(_, d) => patchRow(i, { op: d.optionValue ?? 'equals' })}>
                        {FILTER_OPS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                      </Dropdown>
                    </Field>
                    {!op.nullary && (
                      <Field className={s.repField} label="Value"><Input value={r.value} onChange={(_, d) => patchRow(i, { value: d.value })} /></Field>
                    )}
                    <Field className={s.repField} label="Output"><Input value={r.result} onChange={(_, d) => patchRow(i, { result: d.value })} /></Field>
                    <Tooltip content="Remove" relationship="label">
                      <Button appearance="subtle" icon={<Delete16Regular />} disabled={rows.length <= 1} onClick={() => dropRow(i)} aria-label="Remove condition" />
                    </Tooltip>
                  </div>
                );
              })}
              <Button className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => addRow({ col: firstCol, op: 'equals', value: '', result: '' })}>Add condition</Button>
            </div>
            <TextField label="Otherwise (else value)" value={text2} onChange={setText2} placeholder="n/a" />
          </>
        );
      case 'groupBy':
      case 'groupByMulti':
        return (
          <>
            <MultiColField columns={columns} value={selectedMulti} onChange={setMulti} label="Group by columns" />
            <Divider />
            <div className={s.rep}>
              <Subtitle2 className={s.sectionLabel}>Aggregations</Subtitle2>
              {rows.map((r, i) => (
                <div className={s.repRow} key={i}>
                  <Field className={s.repField} label="New column name"><Input value={r.out} onChange={(_, d) => patchRow(i, { out: d.value })} /></Field>
                  <Field className={s.repField} label="Operation">
                    <Dropdown value={AGG_FNS.find((o) => o.value === r.fn)?.label ?? 'Count rows'} selectedOptions={[r.fn]} onOptionSelect={(_, d) => patchRow(i, { fn: d.optionValue ?? 'count' })}>
                      {AGG_FNS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                    </Dropdown>
                  </Field>
                  {r.fn !== 'count' && (
                    columns.length > 0 ? (
                      <Field className={s.repField} label="Column">
                        <Dropdown value={r.col} selectedOptions={r.col ? [r.col] : []} onOptionSelect={(_, d) => patchRow(i, { col: d.optionValue ?? '' })}>
                          {columns.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                        </Dropdown>
                      </Field>
                    ) : (
                      <Field className={s.repField} label="Column"><Input value={r.col} onChange={(_, d) => patchRow(i, { col: d.value })} /></Field>
                    )
                  )}
                  <Tooltip content="Remove" relationship="label">
                    <Button appearance="subtle" icon={<Delete16Regular />} disabled={rows.length <= 1} onClick={() => dropRow(i)} aria-label="Remove aggregation" />
                  </Tooltip>
                </div>
              ))}
              <Button className={s.addBtn} size="small" appearance="subtle" icon={<Add16Regular />} onClick={() => addRow({ out: 'Sum', fn: 'sum', col: firstCol })}>Add aggregation</Button>
            </div>
          </>
        );
      default:
        return <ColField columns={columns} value={col1} onChange={setCol1} />;
    }
  }
}

export default { hasTransformDialog, renderTransformDialog };
