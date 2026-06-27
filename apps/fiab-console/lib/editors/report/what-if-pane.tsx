'use client';

/**
 * What-if + Field-parameters pane (Power BI "New parameter ▸ Numeric range" /
 * "Fields"). Two report-level structured authoring surfaces, both Azure-native
 * (no Fabric / Power BI parameter table or DAX measure):
 *
 *  1. NUMERIC-RANGE WHAT-IF — name + min / max / increment + an on-canvas value
 *     slicer (a Slider here). The current value is bound INTO the visual SQL via
 *     the /query `whatIf` channel → `buildSqlFromVisual`'s scalar-param binding,
 *     so the picked value genuinely scales the targeted value aggregate (× or +)
 *     and the returned rows change. (When no `targetAlias` is set the host can
 *     also multiply client-side — but the SQL binding is the real default.)
 *
 *  2. FIELD PARAMETER — an author-defined ordered {label, field} list rendered as
 *     a switch slicer; selecting a label SWAPS the bound well field of the
 *     visuals wired to the parameter, re-querying real rows. Persisted on
 *     `state.content.fieldParameters`.
 *
 * Both persist ADDITIVELY via /definition (whitelisted like bookmarks / theme).
 * Rules: no-vaporware (the slider value really reaches the SELECT; the switch
 * really swaps the field), no-freeform-config (range spinners + a field picker —
 * no typed expressions), web3-ui (Fluent v9 + Loom tokens).
 */

import { useEffect, useRef, useState } from 'react';
import {
  makeStyles, tokens, Caption1, Subtitle2, Text, Input, Button, Slider, Badge,
  Dropdown, Option, Divider, Tooltip,
} from '@fluentui/react-components';
import { Add20Regular, Delete16Regular, NumberSymbol20Regular, Options20Regular } from '@fluentui/react-icons';
import type { FieldOpt } from './filters-pane';

// ── model ─────────────────────────────────────────────────────────────────────

/** How a what-if value is applied to the targeted value aggregate. */
export type WhatIfApply = 'multiply' | 'add';

/** A numeric-range what-if parameter (mirror of the /definition sanitizer). */
export interface WhatIfParam {
  id: string;
  name: string;
  min: number;
  max: number;
  increment: number;
  /** Current bound value (clamped to [min,max]); flows into the visual SQL. */
  value: number;
  /** multiply (× value) or add (+ value) the targeted aggregate. Default multiply. */
  apply?: WhatIfApply;
  /** Aggregate result-alias to bind into; empty ⇒ every value aggregate. */
  targetAlias?: string;
}

/** One label→field entry of a field parameter (the swap candidates). */
export interface FieldParamField { label: string; table?: string; column?: string; measure?: string }

/** An author-defined field parameter (switch-slicer field swap). */
export interface FieldParameter {
  id: string;
  name: string;
  fields: FieldParamField[];
  /** Index of the active field (the one the wired visuals bind). Default 0. */
  activeIndex?: number;
}

function uid(prefix: string): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}

// ── parse / wire (mirror the /definition sanitizer) ────────────────────────────

export function parseWhatIfParams(raw: unknown): WhatIfParam[] {
  if (!Array.isArray(raw)) return [];
  const out: WhatIfParam[] = [];
  for (const r of raw) {
    const o = (r || {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const name = typeof o.name === 'string' ? o.name : '';
    if (!id || !name) continue;
    const fin = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
    const min = fin(o.min, 0), max = fin(o.max, 100);
    const increment = Math.max(0, fin(o.increment, 1)) || 1;
    const value = Math.min(Math.max(fin(o.value, min), min), max);
    out.push({
      id, name, min, max, increment, value,
      apply: o.apply === 'add' ? 'add' : 'multiply',
      ...(typeof o.targetAlias === 'string' && o.targetAlias ? { targetAlias: o.targetAlias } : {}),
    });
  }
  return out;
}
export function wireWhatIfParams(list: WhatIfParam[]): WhatIfParam[] {
  return list.filter((w) => w.name.trim());
}

export function parseFieldParameters(raw: unknown): FieldParameter[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldParameter[] = [];
  for (const r of raw) {
    const o = (r || {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const name = typeof o.name === 'string' ? o.name : '';
    if (!id || !name) continue;
    const fields: FieldParamField[] = Array.isArray(o.fields)
      ? o.fields
          .map((f): FieldParamField | null => {
            const fo = (f || {}) as Record<string, unknown>;
            const label = typeof fo.label === 'string' ? fo.label : '';
            const column = typeof fo.column === 'string' ? fo.column : undefined;
            const measure = typeof fo.measure === 'string' ? fo.measure : undefined;
            if (!label || (!column && !measure)) return null;
            return { label, table: typeof fo.table === 'string' ? fo.table : undefined, column, measure };
          })
          .filter((x): x is FieldParamField => !!x)
      : [];
    if (!fields.length) continue;
    const ai = typeof o.activeIndex === 'number' ? Math.min(Math.max(0, Math.floor(o.activeIndex)), fields.length - 1) : 0;
    out.push({ id, name, fields, activeIndex: ai });
  }
  return out;
}
export function wireFieldParameters(list: FieldParameter[]): FieldParameter[] {
  return list.filter((p) => p.name.trim() && p.fields.length);
}

/**
 * Compile the active what-if params into the /query `whatIf` channel
 * (`ScalarParamBinding[]`-compatible). The host spreads the result into the
 * query body so the SLIDER value reaches `buildSqlFromVisual`. Pure.
 */
export function whatIfBindings(list: WhatIfParam[]): Array<{ value: number; apply?: WhatIfApply; targetAlias?: string }> {
  return list
    .filter((w) => Number.isFinite(w.value))
    .map((w) => ({ value: w.value, apply: w.apply, ...(w.targetAlias ? { targetAlias: w.targetAlias } : {}) }));
}

/** The active field of a field parameter (the one wired visuals bind). */
export function activeField(p: FieldParameter): FieldParamField | null {
  return p.fields[p.activeIndex ?? 0] ?? p.fields[0] ?? null;
}

// ── styles ─────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalM, minHeight: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  num: { width: '88px' },
  muted: { color: tokens.colorNeutralForeground3 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  grow: { flex: 1, minWidth: 0 },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalS },
});

// ── value slicer (debounced commit) ──────────────────────────────────────────

/**
 * The on-canvas value slicer for one what-if parameter. The in-flight slider
 * position is held in LOCAL state so dragging never mutates `whatIfs` on each
 * tick — that would re-fire the host's `runVisual` effect (dep
 * `JSON.stringify(whatIfs)`) and fan out a Synapse `/query` per increment (each
 * up to ~30s). The committed value (the re-query trigger) is pushed to the
 * parent only on RELEASE: pointer-up, key-up, or blur. The Badge tracks the
 * live local value so the drag still reads responsively.
 */
function WhatIfValueSlider({ param, onCommit }: { param: WhatIfParam; onCommit: (value: number) => void }) {
  const styles = useStyles();
  const [local, setLocal] = useState(param.value);
  const dragging = useRef(false);
  // Re-sync when the committed value changes from outside (and not mid-drag).
  useEffect(() => {
    if (!dragging.current) setLocal(param.value);
  }, [param.value]);
  const commit = () => {
    dragging.current = false;
    if (local !== param.value) onCommit(local);
  };
  return (
    <div className={styles.row}>
      <Slider
        min={param.min} max={param.max} step={param.increment} value={local}
        aria-label={`${param.name} value`} style={{ flex: 1 }}
        onChange={(_e, d) => { dragging.current = true; setLocal(d.value); }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit}
      />
      <Badge appearance="tint" color="brand">{local}</Badge>
    </div>
  );
}

// ── pane ────────────────────────────────────────────────────────────────────────

export function WhatIfPane({ whatIfs, fieldParams, fields, onChangeWhatIfs, onChangeFieldParams, aggregateAliases }: {
  whatIfs: WhatIfParam[];
  fieldParams: FieldParameter[];
  fields: FieldOpt[];
  /** Result-aliases of the bound value aggregates (the what-if target choices). */
  aggregateAliases: string[];
  onChangeWhatIfs: (list: WhatIfParam[]) => void;
  onChangeFieldParams: (list: FieldParameter[]) => void;
}) {
  const styles = useStyles();

  const patchWi = (id: string, patch: Partial<WhatIfParam>) =>
    onChangeWhatIfs(whatIfs.map((w) => (w.id === id ? clampWi({ ...w, ...patch }) : w)));
  const addWi = () =>
    onChangeWhatIfs([...whatIfs, { id: uid('wi'), name: `Parameter ${whatIfs.length + 1}`, min: 0, max: 100, increment: 1, value: 0, apply: 'multiply' }]);
  const removeWi = (id: string) => onChangeWhatIfs(whatIfs.filter((w) => w.id !== id));

  const patchFp = (id: string, patch: Partial<FieldParameter>) =>
    onChangeFieldParams(fieldParams.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const addFp = () =>
    onChangeFieldParams([...fieldParams, { id: uid('fp'), name: `Field parameter ${fieldParams.length + 1}`, fields: [], activeIndex: 0 }]);
  const removeFp = (id: string) => onChangeFieldParams(fieldParams.filter((p) => p.id !== id));
  const addFpField = (id: string, opt: FieldOpt) => {
    const p = fieldParams.find((x) => x.id === id);
    if (!p) return;
    patchFp(id, { fields: [...p.fields, { label: opt.label, table: opt.table, column: opt.column, measure: opt.measure }] });
  };
  const removeFpField = (id: string, idx: number) => {
    const p = fieldParams.find((x) => x.id === id);
    if (!p) return;
    patchFp(id, { fields: p.fields.filter((_f, i) => i !== idx), activeIndex: Math.min(p.activeIndex ?? 0, Math.max(0, p.fields.length - 2)) });
  };

  return (
    <div className={styles.pane}>
      <div className={styles.sectionTitle}>
        <NumberSymbol20Regular />
        <Subtitle2>What-if parameters</Subtitle2>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={addWi}>New</Button>
      </div>
      <Caption1 className={styles.muted}>
        A numeric range + a value slicer. The current value is bound into the visual SQL (× or +) so
        the chart recomputes against Synapse — Azure-native, no Power BI parameter table.
      </Caption1>
      {whatIfs.length === 0 && <Caption1 className={styles.muted}>No what-if parameters yet.</Caption1>}
      {whatIfs.map((w) => (
        <div key={w.id} className={styles.card}>
          <div className={styles.head}>
            <Input size="small" className={styles.grow} value={w.name} aria-label="parameter name"
              onChange={(_e, d) => patchWi(w.id, { name: d.value })} />
            <Tooltip content="Remove parameter" relationship="label">
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="remove parameter" onClick={() => removeWi(w.id)} />
            </Tooltip>
          </div>
          <div className={styles.row}>
            <Caption1 className={styles.muted}>min</Caption1>
            <Input size="small" type="number" className={styles.num} value={String(w.min)} aria-label="minimum"
              onChange={(_e, d) => patchWi(w.id, { min: numOr(d.value, w.min) })} />
            <Caption1 className={styles.muted}>max</Caption1>
            <Input size="small" type="number" className={styles.num} value={String(w.max)} aria-label="maximum"
              onChange={(_e, d) => patchWi(w.id, { max: numOr(d.value, w.max) })} />
            <Caption1 className={styles.muted}>step</Caption1>
            <Input size="small" type="number" className={styles.num} value={String(w.increment)} aria-label="increment"
              onChange={(_e, d) => patchWi(w.id, { increment: Math.max(0, numOr(d.value, w.increment)) || 1 })} />
          </div>
          <div className={styles.row}>
            <Caption1 className={styles.muted}>apply</Caption1>
            <Dropdown size="small" style={{ minWidth: '110px' }} value={w.apply === 'add' ? 'Add (+)' : 'Multiply (×)'}
              selectedOptions={[w.apply || 'multiply']} aria-label="apply mode"
              onOptionSelect={(_e, d) => patchWi(w.id, { apply: (d.optionValue as WhatIfApply) || 'multiply' })}>
              <Option value="multiply" text="Multiply (×)">Multiply (×)</Option>
              <Option value="add" text="Add (+)">Add (+)</Option>
            </Dropdown>
            <Caption1 className={styles.muted}>to</Caption1>
            <Dropdown size="small" style={{ minWidth: '150px', flex: 1 }} placeholder="every value"
              value={w.targetAlias || 'every value'} selectedOptions={w.targetAlias ? [w.targetAlias] : ['']}
              aria-label="target aggregate"
              onOptionSelect={(_e, d) => patchWi(w.id, { targetAlias: d.optionValue ? String(d.optionValue) : undefined })}>
              <Option value="" text="every value">every value</Option>
              {aggregateAliases.map((a) => <Option key={a} value={a} text={a}>{a}</Option>)}
            </Dropdown>
          </div>
          <Divider />
          <WhatIfValueSlider param={w} onCommit={(value) => patchWi(w.id, { value })} />
        </div>
      ))}

      <div className={styles.sectionTitle}>
        <Options20Regular />
        <Subtitle2>Field parameters</Subtitle2>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={addFp}>New</Button>
      </div>
      <Caption1 className={styles.muted}>
        An ordered list of fields shown as a switch slicer. Picking one swaps the bound well field of
        the wired visuals and re-queries real rows.
      </Caption1>
      {fieldParams.length === 0 && <Caption1 className={styles.muted}>No field parameters yet.</Caption1>}
      {fieldParams.map((p) => (
        <div key={p.id} className={styles.card}>
          <div className={styles.head}>
            <Input size="small" className={styles.grow} value={p.name} aria-label="field parameter name"
              onChange={(_e, d) => patchFp(p.id, { name: d.value })} />
            <Tooltip content="Remove field parameter" relationship="label">
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="remove field parameter" onClick={() => removeFp(p.id)} />
            </Tooltip>
          </div>
          {p.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className={styles.fieldRow}>
              <Button size="small" appearance={(p.activeIndex ?? 0) === i ? 'primary' : 'subtle'}
                onClick={() => patchFp(p.id, { activeIndex: i })} aria-pressed={(p.activeIndex ?? 0) === i}>
                {f.label}
              </Button>
              <span className={styles.grow} />
              <Tooltip content="Remove field" relationship="label">
                <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="remove field" onClick={() => removeFpField(p.id, i)} />
              </Tooltip>
            </div>
          ))}
          <Dropdown size="small" placeholder="Add a field…" value="" selectedOptions={[]} aria-label="add field to parameter"
            onOptionSelect={(_e, d) => {
              const opt = fields.find((o) => o.key === String(d.optionValue || ''));
              if (opt) addFpField(p.id, opt);
            }}>
            {fields.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>)}
          </Dropdown>
        </div>
      ))}
    </div>
  );
}

function numOr(raw: string, fb: number): number {
  const v = Number(raw);
  return Number.isFinite(v) ? v : fb;
}
function clampWi(w: WhatIfParam): WhatIfParam {
  const min = Number.isFinite(w.min) ? w.min : 0;
  const max = Number.isFinite(w.max) ? w.max : 100;
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return { ...w, min: lo, max: hi, value: Math.min(Math.max(w.value, lo), hi) };
}
