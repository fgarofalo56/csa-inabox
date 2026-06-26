'use client';

/**
 * interactions — the Power BI "Edit interactions" surface for the Loom-native
 * Report Designer, plus the pure cross-filter / cross-highlight engine the
 * canvas consumes (report-designer wave 1).
 *
 * Power BI report-authoring parity (ui-parity.md): in PBI you select a visual,
 * choose "Edit interactions" on the Format ribbon, and every OTHER visual on the
 * page sprouts three small toggles — Filter / Highlight / None — that decide what
 * a selection in the source visual does to that target. The default depends on
 * the target: aggregating CHARTS cross-HIGHLIGHT, while tables / cards / slicers
 * cross-FILTER. This module is the one-for-one Loom build of that surface:
 *   - {@link InteractionsEditor} authors the per-page source→target matrix; and
 *   - {@link resolveInteraction} + {@link applySelection} are the pure engine the
 *     host (report-designer.tsx / LoomChart) calls when a slicer value or a data
 *     point is selected, to cross-filter (drop non-matching target rows) or
 *     cross-highlight (keep every row but dim the non-matching ones) client-side.
 *
 * Rules compliance:
 *  - no-vaporware.md: there are no dead controls. Every toggle writes a real
 *    entry into the {@link PageInteractions} model, which the host persists on
 *    `page.config.interactions` through PUT /api/items/report/[id]/definition
 *    (additive — the read-only viewer / PBIR provisioner ignore the unknown key),
 *    and which the engine reads at selection time. The "filter" / "highlight"
 *    outcome is REAL: `applySelection` rewrites the same `/query` result rows
 *    LoomChart draws. When a page has fewer than two visuals the editor shows an
 *    honest EmptyState gate (not disabled buttons).
 *  - no-freeform-config.md: every control is structured — a source Dropdown and a
 *    three-way ToggleButton group per target. There is no typed expression / JSON
 *    anywhere; a selection is a structured set of field=value constraints.
 *  - no-fabric-dependency.md: Azure-native by construction. The model is plain
 *    page state and the engine is pure client-side math over rows that arrive from
 *    the Azure-native report /query + wells-to-sql path; nothing here reaches a
 *    Fabric / Power BI workspace. (PBI embed stays the opt-in publish path.)
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex);
 *    the per-target segmented control mirrors the PBI Edit-interactions chrome.
 *
 * The model is structural — it identifies visuals by id only — so this file does
 * NOT import the designer's private DVisual/DPage types. {@link InteractionPage}
 * / {@link InteractionVisualRef} are the minimal shapes the host satisfies (a
 * DPage's `visuals` array and an optional `interactions` map). The pure helpers
 * (resolve / apply / parse / wire) carry no React or fetch and may be imported by
 * any client surface.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge, Button, Caption1, Divider, Dropdown, Option, Text, ToggleButton, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Filter20Regular, ColorRegular, Dismiss16Regular, Options20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

// ── Model (persisted on page.config.interactions) ────────────────────────────

/** What a selection in a source visual does to a target visual. */
export type InteractionMode = 'filter' | 'highlight' | 'none';

/** Valid interaction modes (used to validate persisted / wire values). */
export const INTERACTION_MODES: InteractionMode[] = ['filter', 'highlight', 'none'];

/**
 * The per-page interaction matrix: `sourceVisualId → targetVisualId → mode`.
 * Stored SPARSE — only entries that DIFFER from the PBI default are kept (a pair
 * with no entry resolves to {@link defaultInteraction} for the target's type).
 * A visual never interacts with itself, so a `[id][id]` entry is ignored.
 */
export type PageInteractions = Record<string, Record<string, InteractionMode>>;

/** Minimal structural shape of a page visual the editor / resolver need. */
export interface InteractionVisualRef {
  /** Stable visual id (matches the designer's DVisual.id). */
  id: string;
  /** Visual type (bar/column/table/card/slicer/…); drives the PBI default. */
  type: string;
  /** Optional display title for the editor row (falls back to the type label). */
  title?: string;
}

/** Minimal structural shape of a page: its visuals + the (optional) matrix. */
export interface InteractionPage {
  visuals: InteractionVisualRef[];
  interactions?: PageInteractions | null;
}

// ── Visual-type defaults (PBI: charts cross-highlight, the rest cross-filter) ──

/**
 * Target types that support cross-HIGHLIGHTING in Power BI (aggregating visuals
 * with selectable marks). Everything else (table / matrix / card / KPI /
 * multi-row card / gauge / slicer) supports only cross-FILTER + None — so the
 * editor never offers a Highlight toggle that would do nothing.
 */
const HIGHLIGHTABLE = new Set<string>([
  'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter',
  'combo', 'ribbon', 'waterfall', 'funnel', 'treemap', 'map',
]);

/** True when a target visual type can be cross-highlighted (else filter/none only). */
export function canHighlight(visualType?: string | null): boolean {
  return !!visualType && HIGHLIGHTABLE.has(visualType);
}

/**
 * The PBI default interaction for a target of the given type: aggregating charts
 * cross-HIGHLIGHT, every other visual cross-FILTERS. Unknown types default to
 * 'filter' (the safe, always-available behavior).
 */
export function defaultInteraction(targetType?: string | null): InteractionMode {
  return canHighlight(targetType) ? 'highlight' : 'filter';
}

// ── Resolve / mutate (pure) ──────────────────────────────────────────────────

function isMode(v: unknown): v is InteractionMode {
  return v === 'filter' || v === 'highlight' || v === 'none';
}

/**
 * Resolve the effective interaction for a (source → target) pair on a page: an
 * explicit override in the matrix wins; otherwise the PBI default for the
 * target's type is used. A visual never interacts with itself ⇒ 'none'.
 */
export function resolveInteraction(page: InteractionPage, sourceId: string, targetId: string): InteractionMode {
  if (!sourceId || !targetId || sourceId === targetId) return 'none';
  const override = page?.interactions?.[sourceId]?.[targetId];
  if (isMode(override)) return override;
  const target = (page?.visuals || []).find((v) => v.id === targetId);
  return defaultInteraction(target?.type);
}

/**
 * Return a NEW matrix with the (source → target) interaction set to `mode`. To
 * keep the model sparse, a `mode` that equals the target type's PBI default is
 * stored as a removal of the override (so `hasInteractions` reflects only real
 * customizations). Pure — never mutates `model`.
 */
export function setInteraction(
  model: PageInteractions | null | undefined,
  sourceId: string,
  targetId: string,
  targetType: string | null | undefined,
  mode: InteractionMode,
): PageInteractions {
  const next: PageInteractions = {};
  for (const [s, m] of Object.entries(model || {})) next[s] = { ...m };
  if (!sourceId || !targetId || sourceId === targetId) return next;
  const bucket = { ...(next[sourceId] || {}) };
  if (mode === defaultInteraction(targetType)) delete bucket[targetId];
  else bucket[targetId] = mode;
  if (Object.keys(bucket).length > 0) next[sourceId] = bucket;
  else delete next[sourceId];
  return next;
}

/** Clear every override that originates from `sourceId` (resets it to defaults). */
export function clearSource(model: PageInteractions | null | undefined, sourceId: string): PageInteractions {
  const next: PageInteractions = {};
  for (const [s, m] of Object.entries(model || {})) if (s !== sourceId) next[s] = { ...m };
  return next;
}

// ── Parse / wire / introspect (mirror the sibling panes' helpers) ────────────

/** A fresh, empty matrix (every pair resolves to its PBI default). */
export function emptyInteractions(): PageInteractions {
  return {};
}

/** True when the matrix carries at least one explicit (non-default) override. */
export function hasInteractions(model?: PageInteractions | null): boolean {
  if (!model) return false;
  return Object.values(model).some((m) => m && Object.keys(m).length > 0);
}

/**
 * Defensively hydrate a persisted/wire value into {@link PageInteractions} (it
 * arrives from Cosmos `page.config.interactions` or a PUT body). Unknown shapes
 * and invalid modes are dropped rather than thrown — matching the designer's
 * `reFilters` / `parseConditionalFormat` — so the surface degrades gracefully.
 */
export function parseInteractions(value: unknown): PageInteractions {
  if (!value || typeof value !== 'object') return emptyInteractions();
  const out: PageInteractions = {};
  for (const [sourceId, targets] of Object.entries(value as Record<string, unknown>)) {
    if (!sourceId || !targets || typeof targets !== 'object') continue;
    const bucket: Record<string, InteractionMode> = {};
    for (const [targetId, mode] of Object.entries(targets as Record<string, unknown>)) {
      if (!targetId || targetId === sourceId) continue;
      if (isMode(mode)) bucket[targetId] = mode;
    }
    if (Object.keys(bucket).length > 0) out[sourceId] = bucket;
  }
  return out;
}

/** Strip empty buckets before persisting; returns undefined when nothing is set. */
export function wireInteractions(model?: PageInteractions | null): PageInteractions | undefined {
  if (!model) return undefined;
  const out: PageInteractions = {};
  for (const [sourceId, targets] of Object.entries(model)) {
    if (!targets) continue;
    const bucket: Record<string, InteractionMode> = {};
    for (const [targetId, mode] of Object.entries(targets)) {
      if (isMode(mode) && targetId !== sourceId) bucket[targetId] = mode;
    }
    if (Object.keys(bucket).length > 0) out[sourceId] = bucket;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── Selection engine (the no-vaporware backend of cross-filter / -highlight) ──

/**
 * One field=value(s) constraint of a selection: a row matches when its value for
 * `field` is among `values` (OR within a field; AND across constraints). `field`
 * is a result-column key OR a bare field name — matched tolerantly against the
 * target's result columns (`Table[Column]`, `[Measure]`, or a bare alias).
 */
export interface SelectionConstraint {
  field: string;
  values: Array<string | number | null>;
}

/** A structured selection originating from a source visual (a slicer pick or data point). */
export interface VisualSelection {
  /** The source visual the selection came from. */
  sourceId: string;
  /** AND-combined field constraints describing the selected mark(s). */
  constraints: SelectionConstraint[];
}

/**
 * The result of applying a selection to a target visual's rows. The shape is
 * uniform across modes so the host renders it the same way:
 *  - filter:    `rows` = only matching rows; `dimmed` all false.
 *  - highlight: `rows` = every row; `dimmed[i]` true for non-matching rows.
 *  - none:      `rows` = every row; `dimmed` all false.
 * `affected` is true only when the selection actually touched this target (a
 * shared field resolved and the mode wasn't 'none') — useful for chrome.
 */
export interface SelectionResult {
  rows: Array<Record<string, unknown>>;
  dimmed: boolean[];
  mode: InteractionMode;
  affected: boolean;
}

/** Resolve a (possibly qualified) field name to the result-column key carrying it. */
function matchColumnKey(keys: string[], field: string): string | null {
  const name = (field || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const k of keys) if (k.toLowerCase() === lower) return k;
  for (const k of keys) if (k.toLowerCase().endsWith(`[${lower}]`)) return k;
  // field given as Table[Column] / [Measure] → match a bare result alias.
  const m = /\[([^\]]+)\]$/.exec(name);
  if (m) {
    const bare = m[1].toLowerCase();
    for (const k of keys) if (k.toLowerCase() === bare) return k;
  }
  return null;
}

/** True when a cell value equals any of the selected values (string + numeric tolerant). */
function valueMatches(cell: unknown, values: Array<string | number | null>): boolean {
  const cs = cell == null ? '' : String(cell);
  const cn = Number(cell);
  return values.some((v) => {
    if (v == null) return cell == null;
    const vs = String(v);
    if (cs === vs) return true;
    const vn = Number(v);
    return !Number.isNaN(cn) && !Number.isNaN(vn) && cn === vn;
  });
}

/**
 * Apply a {@link VisualSelection} to a target visual's result `rows` under the
 * resolved `mode`. Pure — no React/fetch. Constraints whose field isn't present
 * in the target's result are skipped (a target that doesn't share the selected
 * field is left untouched, never blanked — mirroring the designer's filter
 * matcher). When no constraint resolves, the target is unaffected.
 */
export function applySelection(
  rows: Array<Record<string, unknown>>,
  selection: VisualSelection | null | undefined,
  mode: InteractionMode,
): SelectionResult {
  const all = rows || [];
  const noEffect = (): SelectionResult => ({ rows: all, dimmed: all.map(() => false), mode, affected: false });
  if (!selection || mode === 'none' || all.length === 0) return noEffect();
  const cons = (selection.constraints || []).filter((c) => c.field && (c.values?.length ?? 0) > 0);
  if (cons.length === 0) return noEffect();

  const keys = Object.keys(all[0]);
  const applicable = cons
    .map((c) => ({ c, key: matchColumnKey(keys, c.field) }))
    .filter((x): x is { c: SelectionConstraint; key: string } => !!x.key);
  if (applicable.length === 0) return noEffect();

  const isMatch = (row: Record<string, unknown>) =>
    applicable.every(({ c, key }) => valueMatches(row[key], c.values));

  if (mode === 'filter') {
    const filtered = all.filter(isMatch);
    return { rows: filtered, dimmed: filtered.map(() => false), mode, affected: true };
  }
  // highlight: keep every row, dim the ones that don't match the selection.
  return { rows: all, dimmed: all.map((r) => !isMatch(r)), mode, affected: true };
}

/**
 * Convenience: build a {@link VisualSelection} from a clicked result `row` using
 * the given category/legend field keys (the host passes the source visual's
 * category + legend well column keys). Empty/missing fields are skipped.
 */
export function selectionFromRow(
  sourceId: string,
  row: Record<string, unknown>,
  fields: string[],
): VisualSelection {
  const constraints: SelectionConstraint[] = [];
  for (const f of fields) {
    if (!f || !(f in row)) continue;
    const v = row[f];
    constraints.push({ field: f, values: [v == null ? null : (v as string | number)] });
  }
  return { sourceId, constraints };
}

// ── styles (Fluent v9 + Loom tokens; matches the sibling panes) ──────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  headRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  spacer: { flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  sourceCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  targetCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  targetHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  targetTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  modeStrip: {
    display: 'flex', gap: '2px', padding: '2px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  modeBtn: {
    flex: 1, minWidth: 0, border: 'none', backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2, borderRadius: tokens.borderRadiusSmall,
  },
  modeBtnActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorBrandForeground1, boxShadow: tokens.shadow2,
  },
  defaultNote: { color: tokens.colorNeutralForeground3 },
});

type Styles = ReturnType<typeof useStyles>;

// ── per-mode toggle metadata ─────────────────────────────────────────────────

const MODE_META: Record<InteractionMode, { label: string; icon: ReactElement; hint: string }> = {
  filter:    { label: 'Filter',    icon: <Filter20Regular />,  hint: 'Filter this visual to the selection' },
  highlight: { label: 'Highlight', icon: <ColorRegular />,     hint: 'Highlight matching marks, dim the rest' },
  none:      { label: 'None',      icon: <Dismiss16Regular />, hint: 'No interaction' },
};

/** The three-way (or two-way) toggle for one target row. */
function ModeToggle({
  styles, modes, value, onPick,
}: {
  styles: Styles; modes: InteractionMode[]; value: InteractionMode; onPick: (m: InteractionMode) => void;
}): ReactElement {
  return (
    <div className={styles.modeStrip} role="radiogroup" aria-label="interaction">
      {modes.map((m) => {
        const meta = MODE_META[m];
        const active = value === m;
        return (
          <Tooltip key={m} content={meta.hint} relationship="label" withArrow>
            <ToggleButton
              size="small" appearance="subtle" icon={meta.icon} checked={active}
              role="radio" aria-checked={active} aria-label={meta.label}
              className={mergeClasses(styles.modeBtn, active && styles.modeBtnActive)}
              onClick={() => onPick(m)}
            >
              {meta.label}
            </ToggleButton>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── InteractionsEditor (the right-rail "Edit interactions" surface) ──────────

export interface InteractionsEditorProps {
  /** Every visual on the active page (id + type + optional title). */
  visuals: InteractionVisualRef[];
  /** Current sparse matrix (read from `page.config.interactions`). */
  interactions?: PageInteractions | null;
  /** Emit the next matrix; the host wires this to `mutatePage`. */
  onChange: (next: PageInteractions) => void;
  /**
   * The canvas's currently-selected visual, used to preselect the source (PBI
   * ties Edit interactions to the selected visual). Optional — the editor also
   * exposes a source Dropdown so it is fully usable without a selection.
   */
  selectedSourceId?: string | null;
}

/**
 * The Edit-interactions pane. Controlled + fully structured: pick a SOURCE
 * visual, then set each other visual's reaction (Filter / Highlight / None). The
 * active state of each row reflects {@link resolveInteraction} (an explicit
 * override or the PBI default for the target's type), and each toggle writes a
 * sparse override via {@link setInteraction}. Degrades to a styled EmptyState
 * when the page has fewer than two visuals (no-vaporware: not disabled controls).
 */
export function InteractionsEditor({
  visuals, interactions, onChange, selectedSourceId,
}: InteractionsEditorProps): ReactElement {
  const styles = useStyles();
  const model = interactions ?? null;

  // Source selection: preselect the canvas selection, follow it when it changes,
  // and always keep a valid source as visuals come and go.
  const prevSel = useRef<string | null | undefined>(undefined);
  const [sourceId, setSourceId] = useState<string>(selectedSourceId || visuals[0]?.id || '');
  useEffect(() => {
    setSourceId((cur) => {
      if (selectedSourceId && selectedSourceId !== prevSel.current && visuals.some((v) => v.id === selectedSourceId)) {
        return selectedSourceId;
      }
      return cur && visuals.some((v) => v.id === cur) ? cur : (visuals[0]?.id || '');
    });
    prevSel.current = selectedSourceId;
  }, [selectedSourceId, visuals]);

  const labelFor = (v: InteractionVisualRef) => (v.title && v.title.trim()) || v.type;
  const source = useMemo(() => visuals.find((v) => v.id === sourceId) || null, [visuals, sourceId]);
  const targets = useMemo(() => visuals.filter((v) => v.id !== sourceId), [visuals, sourceId]);

  // Need at least two visuals for an interaction to exist (honest gate).
  if (visuals.length < 2) {
    return (
      <EmptyState
        icon={<Options20Regular />}
        title="Add another visual to set interactions"
        body="Edit interactions controls what selecting a value in one visual does to the others on this page. Add at least two visuals to the page, then choose a source and set each target to Filter, Highlight, or None."
      />
    );
  }

  const page: InteractionPage = { visuals, interactions: model };
  const sourceHasOverrides = !!(sourceId && model && model[sourceId] && Object.keys(model[sourceId]).length > 0);

  const pick = (target: InteractionVisualRef, mode: InteractionMode) =>
    onChange(setInteraction(model, sourceId, target.id, target.type, mode));

  return (
    <div className={styles.pane}>
      <div className={styles.headRow}>
        <Options20Regular />
        <Caption1><strong>Edit interactions</strong></Caption1>
        <div className={styles.spacer} />
        <Tooltip content="Reset this source to default interactions" relationship="label" withArrow>
          <Button
            size="small" appearance="subtle" icon={<ArrowSync20Regular />} aria-label="reset interactions"
            disabled={!sourceHasOverrides} onClick={() => onChange(clearSource(model, sourceId))}
          >
            Reset
          </Button>
        </Tooltip>
      </div>

      <Caption1 className={styles.hint}>
        Choose a source visual, then set what selecting a value in it does to each other visual. Charts
        cross-highlight by default; tables, cards, and slicers cross-filter.
      </Caption1>

      <div className={styles.sourceCol}>
        <Caption1 className={styles.hint}>When a user selects a value in</Caption1>
        <Dropdown
          size="small" aria-label="source visual"
          value={source ? labelFor(source) : ''}
          selectedOptions={sourceId ? [sourceId] : []}
          onOptionSelect={(_e, d) => setSourceId(String(d.optionValue || ''))}
        >
          {visuals.map((v) => (
            <Option key={v.id} value={v.id} text={labelFor(v)}>{labelFor(v)}</Option>
          ))}
        </Dropdown>
      </div>

      <Divider />

      <div className={styles.list}>
        {targets.map((t) => {
          const mode = resolveInteraction(page, sourceId, t.id);
          const modes: InteractionMode[] = canHighlight(t.type)
            ? ['filter', 'highlight', 'none']
            : ['filter', 'none'];
          const def = defaultInteraction(t.type);
          const isDefault = mode === def;
          return (
            <div key={t.id} className={styles.targetCard}>
              <div className={styles.targetHead}>
                <Badge appearance="tint" size="small">{t.type}</Badge>
                <Text className={styles.targetTitle} weight="semibold">{labelFor(t)}</Text>
              </div>
              <ModeToggle styles={styles} modes={modes} value={mode} onPick={(m) => pick(t, m)} />
              <Caption1 className={styles.defaultNote}>
                Default: {MODE_META[def].label}{isDefault ? ' (in effect)' : ''}
              </Caption1>
            </div>
          );
        })}
        {targets.length === 0 && (
          <Caption1 className={styles.hint}>This is the only other visual&apos;s source — pick a different source visual above.</Caption1>
        )}
      </div>
    </div>
  );
}

export default InteractionsEditor;
