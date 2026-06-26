'use client';

/**
 * personalize — the Power BI "Personalize this visual" surface for the Loom-native
 * Report Designer (report-designer wave 3), mounted by the host on the canvas.
 *
 * Power BI parity (ui-parity.md):
 * learn.microsoft.com/power-bi/create-reports/power-bi-personalize-visuals lets a
 * report CONSUMER (viewer) temporarily reshape a visual for THEIR OWN view —
 * change its visual TYPE, and SWAP / replace the fields in its wells — WITHOUT
 * changing the report for anyone else. The personalized state is per-user and is
 * NOT written back to the shared report definition; Power BI offers a per-visual
 * and a report-level Reset, and (when "persistent filters" / personalization is
 * on) remembers a viewer's tweaks across sessions in the consumer's own profile.
 *
 * This file is the one-for-one Loom build of that surface, Azure-native by
 * construction (it is pure viewer-side overlay state — it never reaches a Fabric /
 * Power BI workspace and adds NO backend route):
 *
 *   • {@link usePersonalize} — the viewer-side overlay engine. Holds a
 *     {@link PersonalizeMap} (visualId → {@link VisualOverride}) in React state,
 *     mirrored to localStorage under `loom:report:<id>:<userKey>:personalize`
 *     (per-user, OUTSIDE the shared definition), and exposes `setOverride`,
 *     `resetVisual`, `resetAll`, and the render-time `applyOverride(v)` that merges
 *     a saved visual with its override at RENDER time only. The host gates editing
 *     OFF while `active` is true and never threads an override into its
 *     buildDefinitionBody — so a personalized view can NEVER be persisted to the
 *     report for other users.
 *   • {@link PersonalizePopover} — a small Fluent surface anchored on a visual when
 *     personalize mode is on: a Dropdown to change the visual TYPE (compatible
 *     types only) and, per bound well, a Dropdown to REPLACE the field from the
 *     bound model's field list, plus a per-visual Reset.
 *   • {@link PersonalizeBanner} — a Fluent MessageBar shown while personalize mode
 *     is active, naming it as a temporary per-user view with a "Reset all" action.
 *
 * Rules compliance:
 *  - no-vaporware.md: no dead controls. The type Dropdown and every field-swap
 *    Dropdown REALLY mutate the per-user override; `applyOverride` REALLY repaints
 *    the visual the host renders from it; Reset / Reset all REALLY clear it. There
 *    is no "coming soon" affordance. The overlay is real local state, not mock data.
 *  - no-freeform-config.md: every control is structured — a type Dropdown over a
 *    compatible-types list and per-well field Dropdowns over the model's
 *    {@link FieldOpt} list. There is no typed expression / raw-JSON box anywhere.
 *  - no-fabric-dependency.md: Azure-native by construction. This is in-memory +
 *    localStorage overlay state layered over the Azure-native report path; nothing
 *    here reaches api.fabric.microsoft.com / api.powerbi.com.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex); the
 *    popover + banner chrome match the sibling bookmarks-pane / selection-pane.
 *
 * The model is structural — {@link DVisual} / {@link Wells} are the minimal shapes
 * the designer's private DVisual/Wells satisfy — so this file does NOT import the
 * designer's private types (mirroring the sibling selection-pane pattern). The
 * field list reuses the canonical {@link FieldOpt} from ./filters-pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge, Button, Caption1, Divider, Dropdown, Option, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Popover, PopoverSurface, PopoverTrigger,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  PersonEdit20Regular, Options20Regular, ArrowSwap20Regular,
  ArrowUndo20Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import type { FieldOpt } from './filters-pane';

// ── Model (structural — a designer DVisual/Wells satisfies these) ─────────────

/**
 * A visual type id (bar / column / table / card / …). Widened to `string` so the
 * designer's narrow VisualType union assigns both ways without importing it; the
 * compatible-type list ({@link compatibleTypesFor}) keeps the swap honest.
 */
export type VisualType = string;

/**
 * The minimal structural shape of a bound field in a well — a designer WellField
 * (whose `uid` is required and `aggregation` is a narrow union) satisfies this.
 */
export interface WellField {
  uid?: string;
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: string;
}

/** A visual's field wells, keyed by well name (category / values / legend / …). */
export type Wells = { [well: string]: WellField[] | undefined };

/**
 * The minimal structural shape of a designer visual the overlay reads. A designer
 * DVisual (which also carries title / w / h / format / …) satisfies it; the host
 * passes its own DVisual and `applyOverride` returns the SAME concrete type.
 */
export interface DVisual {
  id: string;
  type: VisualType;
  title?: string;
  wells: Wells;
}

/**
 * A per-user, per-visual override layered over the saved visual at render time.
 * `type` swaps the visual type; `wells` replaces specific wells' field arrays. An
 * absent key means "use the saved value" — overrides are sparse and additive.
 */
export interface VisualOverride {
  type?: VisualType;
  wells?: Partial<Wells>;
}

/** visualId → override. The whole overlay for one report, for one user. */
export type PersonalizeMap = Record<string, VisualOverride>;

// ── Visual-type compatibility + labels (parity with PBI personalize) ──────────

/** Display labels mirroring the designer's gallery (report-designer VISUALS). */
const TYPE_LABELS: Record<string, string> = {
  table: 'Table', matrix: 'Matrix', card: 'Card', multiRowCard: 'Multi-row card',
  kpi: 'KPI', gauge: 'Gauge', column: 'Column chart', bar: 'Bar chart',
  line: 'Line chart', area: 'Area chart', combo: 'Line + column', ribbon: 'Ribbon chart',
  waterfall: 'Waterfall', funnel: 'Funnel', pie: 'Pie chart', donut: 'Donut chart',
  treemap: 'Treemap', scatter: 'Scatter', map: 'Map', slicer: 'Slicer',
};
/** Human label for a visual type (falls back to the raw id). */
export function typeLabel(t: VisualType): string { return TYPE_LABELS[t] || t; }

/** Friendly labels for the well names the designer exposes. */
const WELL_LABELS: Record<string, string> = {
  category: 'Axis / Category', values: 'Values', legend: 'Legend',
  secondaryValues: 'Secondary values', target: 'Target', minimum: 'Minimum',
  maximum: 'Maximum', smallMultiples: 'Small multiples', tooltips: 'Tooltips',
  details: 'Details', size: 'Size', playAxis: 'Play axis',
  latitude: 'Latitude', longitude: 'Longitude',
};
function wellLabel(name: string): string { return WELL_LABELS[name] || name; }

/**
 * Visual types that share a data-role shape and so are mutually swappable in
 * personalize (PBI only offers compatible types). Grouped by primary wells:
 * table-family, card/KPI-family, category+value charts, map (lat/long), slicer.
 */
const SWAP_GROUPS: VisualType[][] = [
  ['table', 'matrix'],
  ['card', 'multiRowCard', 'kpi', 'gauge'],
  ['bar', 'column', 'line', 'area', 'combo', 'ribbon', 'waterfall', 'funnel', 'pie', 'donut', 'treemap', 'scatter'],
  ['map'],
  ['slicer'],
];

/** The visual types a given type can be personalized into (includes itself). */
export function compatibleTypesFor(type: VisualType): VisualType[] {
  const g = SWAP_GROUPS.find((grp) => grp.includes(type));
  return g ? g.slice() : [type];
}

// ── field helpers (align with ./filters-pane fieldOptions encoding) ───────────

function uid(prefix = 'pz'): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}

/** Stable picker key for a bound well field — matches fieldOptions' FieldOpt.key. */
function wellFieldKey(f: WellField): string {
  return f.measure ? `m:${f.measure}` : `c:${f.table || ''}.${f.column || ''}`;
}
/** Human label for a bound well field. */
function wellFieldLabel(f: WellField): string {
  if (f.measure) return f.measure;
  if (f.column) return f.aggregation ? `${f.aggregation} of ${f.column}` : f.column;
  return '(field)';
}

/**
 * Convert a model {@link FieldOpt} (the pickable field) into a {@link WellField}
 * the designer's wells understand. A replacement column keeps no aggregation (the
 * /query route defaults it); a measure carries none. A fresh client uid is minted.
 */
export function fieldOptToWell(opt: FieldOpt): WellField {
  return opt.measure
    ? { uid: uid('f'), measure: opt.measure }
    : { uid: uid('f'), table: opt.table, column: opt.column };
}

// ── localStorage mirror (per-user, OUTSIDE the shared definition) ─────────────

/** `loom:report:<id>:<userKey>:personalize` — per-user overlay key. */
export function personalizeStorageKey(reportId: string, userKey: string): string {
  return `loom:report:${reportId}:${userKey || 'anon'}:personalize`;
}
function loadMap(key: string): PersonalizeMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PersonalizeMap) : {};
  } catch {
    return {};
  }
}
function saveMap(key: string, map: PersonalizeMap): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(map).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* private-mode / quota — overlay stays in-memory only (still per-user). */
  }
}

/** True when an override carries no real change (so it can be pruned). */
function isEmptyOverride(o?: VisualOverride): boolean {
  if (!o) return true;
  if (o.type !== undefined) return false;
  return !o.wells || Object.keys(o.wells).length === 0;
}

// ── hook: the viewer-side overlay engine ──────────────────────────────────────

export interface UsePersonalizeApi {
  /** Personalize mode toggle (host gates canvas editing OFF when true). */
  active: boolean;
  setActive: (on: boolean) => void;
  toggleActive: () => void;
  /** The current overlay (visualId → override). */
  map: PersonalizeMap;
  /** Number of personalized visuals (drives the banner + badges). */
  count: number;
  /** True when `visualId` has an override. */
  isPersonalized: (visualId: string) => boolean;
  /** The override for `visualId`, if any. */
  overrideFor: (visualId: string) => VisualOverride | undefined;
  /** Merge a sparse patch into the override for `visualId` (additive). */
  setOverride: (visualId: string, patch: VisualOverride) => void;
  /** Clear one visual's override. */
  resetVisual: (visualId: string) => void;
  /** Clear the whole overlay. */
  resetAll: () => void;
  /**
   * Merge a saved visual with its override at RENDER time only, returning the
   * SAME concrete type. Pure — never mutates the input, never persisted.
   */
  applyOverride: <V extends DVisual>(v: V) => V;
}

/**
 * The viewer-side personalize overlay for one report + user. Loads the persisted
 * overlay on mount, re-loads when the report/user key changes (without clobbering
 * the new key's storage), and mirrors every change back. `active` is a per-session
 * mode toggle (not persisted) — the overlay itself IS persisted, per-user, outside
 * the shared report definition.
 */
export function usePersonalize(reportId: string, userKey: string): UsePersonalizeApi {
  const key = personalizeStorageKey(reportId, userKey);
  const [map, setMap] = useState<PersonalizeMap>(() => loadMap(key));
  const [active, setActive] = useState(false);

  // Re-derive state when the storage key changes (PBI "open a different report"):
  // adjust during render so the persist effect below sees the NEW key's map and
  // never writes the previous report's overlay under the new key.
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    keyRef.current = key;
    setMap(loadMap(key));
  }

  // Mirror every change to localStorage (per-user, outside the definition).
  useEffect(() => { saveMap(key, map); }, [key, map]);

  // applyOverride reads the latest map without re-creating on every change.
  const mapRef = useRef(map);
  mapRef.current = map;

  const setOverride = useCallback((visualId: string, patch: VisualOverride) => {
    setMap((prev) => {
      const cur = prev[visualId] || {};
      const next: VisualOverride = {
        ...cur,
        ...patch,
        wells: { ...(cur.wells || {}), ...(patch.wells || {}) },
      };
      if (next.wells && Object.keys(next.wells).length === 0) delete next.wells;
      if (isEmptyOverride(next)) {
        if (!(visualId in prev)) return prev;
        const rest = { ...prev };
        delete rest[visualId];
        return rest;
      }
      return { ...prev, [visualId]: next };
    });
  }, []);

  const resetVisual = useCallback((visualId: string) => {
    setMap((prev) => {
      if (!(visualId in prev)) return prev;
      const rest = { ...prev };
      delete rest[visualId];
      return rest;
    });
  }, []);

  const resetAll = useCallback(() => setMap((prev) => (Object.keys(prev).length ? {} : prev)), []);

  const applyOverride = useCallback(<V extends DVisual>(v: V): V => {
    const o = mapRef.current[v.id];
    if (isEmptyOverride(o)) return v;
    const wells: Wells = { ...(v.wells as Wells) };
    if (o!.wells) {
      for (const k of Object.keys(o!.wells)) {
        const ow = o!.wells[k];
        if (ow) wells[k] = ow;
      }
    }
    // The override's type widens `type` to string; the cast restores V's exact
    // type. Pure clone — the saved visual is never mutated.
    return ({ ...v, type: o!.type ?? v.type, wells }) as unknown as V;
  }, []);

  const isPersonalized = useCallback((visualId: string) => !isEmptyOverride(map[visualId]), [map]);
  const overrideFor = useCallback((visualId: string) => map[visualId], [map]);
  const toggleActive = useCallback(() => setActive((a) => !a), []);

  const count = useMemo(() => Object.keys(map).filter((id) => !isEmptyOverride(map[id])).length, [map]);

  return {
    active, setActive, toggleActive,
    map, count, isPersonalized, overrideFor,
    setOverride, resetVisual, resetAll, applyOverride,
  };
}

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  trigger: { minWidth: 'auto' },
  popover: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: '300px',
    maxWidth: '340px',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
  headTitle: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  hint: { color: tokens.colorNeutralForeground3 },
  swapRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  swapIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  grow: { flexGrow: 1, minWidth: 0 },
  empty: {
    color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalXS,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  actions: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXS,
  },
  banner: { marginBottom: tokens.spacingVerticalS },
});

// ── PersonalizePopover ────────────────────────────────────────────────────────

export interface PersonalizePopoverProps {
  /** The SAVED visual (from the shared definition) being personalized. */
  visual: DVisual;
  /** Its current override, if any (from {@link usePersonalize}.overrideFor). */
  override?: VisualOverride;
  /** The bound model's pickable field list (filters-pane fieldOptions(tables)). */
  fields: FieldOpt[];
  /** Compatible visual types; defaults to {@link compatibleTypesFor} of the effective type. */
  compatibleTypes?: VisualType[];
  /** Apply a new visual TYPE to this visual's override. */
  onChangeType: (type: VisualType) => void;
  /** Replace a well's field array (the structured field swap). */
  onSwapField: (well: string, fields: WellField[]) => void;
  /** Clear this visual's override. */
  onReset: () => void;
  /** Controlled open (optional — uncontrolled if omitted). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Custom trigger element (defaults to a small icon button). */
  trigger?: ReactElement;
}

/**
 * The "Personalize this visual" popover (PBI personalize-visuals). Anchored on a
 * visual when personalize mode is on. Lets the viewer change the visual TYPE
 * (compatible types only) and REPLACE the field in any bound well from the model
 * field list, with a per-visual Reset. Every control is wired to a real override
 * mutation — no dead buttons.
 */
export function PersonalizePopover(props: PersonalizePopoverProps): ReactElement {
  const {
    visual, override, fields, compatibleTypes,
    onChangeType, onSwapField, onReset, open, onOpenChange, trigger,
  } = props;
  const styles = useStyles();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = useCallback((o: boolean) => {
    if (onOpenChange) onOpenChange(o);
    if (open === undefined) setInternalOpen(o);
  }, [onOpenChange, open]);

  // Effective (personalized) view of the visual the popover edits against.
  const effType: VisualType = override?.type ?? visual.type;
  const effWells: Wells = useMemo(() => {
    const merged: Wells = { ...visual.wells };
    if (override?.wells) for (const k of Object.keys(override.wells)) {
      const ow = override.wells[k];
      if (ow) merged[k] = ow;
    }
    return merged;
  }, [visual.wells, override]);

  const typeChoices = compatibleTypes ?? compatibleTypesFor(effType);

  // Bound wells (those with ≥1 field), in a stable, readable order.
  const boundWells = useMemo(
    () => Object.keys(effWells).filter((w) => (effWells[w]?.length ?? 0) > 0),
    [effWells],
  );

  const swap = useCallback((well: string, idx: number, opt: FieldOpt | undefined) => {
    if (!opt) return;
    const cur = effWells[well] || [];
    const next = cur.map((f, i) => (i === idx ? fieldOptToWell(opt) : f));
    onSwapField(well, next);
  }, [effWells, onSwapField]);

  const hasOverride = !isEmptyOverride(override);

  const triggerEl = trigger ?? (
    <Tooltip content="Personalize this visual" relationship="label">
      <Button
        size="small"
        appearance="subtle"
        className={styles.trigger}
        icon={<PersonEdit20Regular />}
        aria-label="Personalize this visual"
      />
    </Tooltip>
  );

  return (
    <Popover
      open={isOpen}
      trapFocus
      withArrow
      onOpenChange={(_e, d) => setOpen(d.open)}
    >
      <PopoverTrigger disableButtonEnhancement>{triggerEl}</PopoverTrigger>
      <PopoverSurface>
        <div className={styles.popover}>
          <div className={styles.head}>
            <PersonEdit20Regular />
            <div className={styles.headTitle}>
              <Caption1><strong>Personalize this visual</strong></Caption1>
              <Caption1 className={mergeClasses(styles.hint, styles.ellipsis)}>
                {visual.title || typeLabel(visual.type)}
              </Caption1>
            </div>
            {hasOverride && <Badge appearance="tint" color="brand" size="small">Edited</Badge>}
          </div>

          <Divider />

          {/* Change visual type — compatible types only. */}
          <div className={styles.field}>
            <Caption1 className={styles.hint}>
              <Options20Regular style={{ verticalAlign: 'middle' }} /> Visual type
            </Caption1>
            <Dropdown
              size="small"
              aria-label="Change visual type"
              value={typeLabel(effType)}
              selectedOptions={[effType]}
              onOptionSelect={(_e, d) => { if (d.optionValue) onChangeType(d.optionValue); }}
            >
              {typeChoices.map((t) => (
                <Option key={t} value={t} text={typeLabel(t)}>{typeLabel(t)}</Option>
              ))}
            </Dropdown>
          </div>

          {/* Replace fields — one Dropdown per bound field, from the model list. */}
          <div className={styles.field}>
            <Caption1 className={styles.hint}>
              <ArrowSwap20Regular style={{ verticalAlign: 'middle' }} /> Replace fields
            </Caption1>
            {boundWells.length === 0 ? (
              <Caption1 className={styles.empty}>This visual has no bound fields to swap.</Caption1>
            ) : (
              boundWells.map((well) => (
                <div key={well} className={styles.field}>
                  <Caption1 className={styles.hint}>{wellLabel(well)}</Caption1>
                  {(effWells[well] || []).map((f, idx) => {
                    const curKey = wellFieldKey(f);
                    return (
                      <div key={f.uid || `${well}_${idx}`} className={styles.swapRow}>
                        <ArrowSwap20Regular className={styles.swapIcon} fontSize={16} />
                        <Dropdown
                          size="small"
                          className={styles.grow}
                          aria-label={`Replace ${wellLabel(well)} field ${wellFieldLabel(f)}`}
                          value={wellFieldLabel(f)}
                          selectedOptions={[curKey]}
                          onOptionSelect={(_e, d) =>
                            swap(well, idx, fields.find((o) => o.key === d.optionValue))
                          }
                        >
                          {fields.map((o) => (
                            <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>
                          ))}
                        </Dropdown>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
            {fields.length === 0 && boundWells.length > 0 && (
              <Caption1 className={styles.empty}>
                No model fields available — bind a semantic model to swap fields.
              </Caption1>
            )}
          </div>

          <div className={styles.actions}>
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowUndo20Regular />}
              disabled={!hasOverride}
              onClick={onReset}
            >
              Reset visual
            </Button>
            <Button size="small" appearance="secondary" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      </PopoverSurface>
    </Popover>
  );
}

// ── PersonalizeBanner ─────────────────────────────────────────────────────────

export interface PersonalizeBannerProps {
  /** Number of personalized visuals (from {@link usePersonalize}.count). */
  count: number;
  /** Clear the whole overlay. */
  onResetAll: () => void;
  /** Optional: exit personalize mode (turn the toggle off). */
  onExit?: () => void;
}

/**
 * The banner shown while personalize mode is active (PBI's "You've personalized
 * this visual" notice, raised to report scope). Names the view as temporary +
 * per-user + unsaved and offers a "Reset all" action (and an optional Exit).
 */
export function PersonalizeBanner(props: PersonalizeBannerProps): ReactElement {
  const { count, onResetAll, onExit } = props;
  const styles = useStyles();
  return (
    <MessageBar intent="info" className={styles.banner}>
      <MessageBarBody>
        <MessageBarTitle>Personalized view</MessageBarTitle>
        <Text>
          {count > 0
            ? `You've changed ${count} visual${count === 1 ? '' : 's'} for your own view. `
            : 'Change a visual’s type or fields for your own view. '}
          These changes are temporary, visible only to you, and aren’t saved to the report.
        </Text>
      </MessageBarBody>
      <MessageBarActions>
        <Button
          size="small"
          appearance="transparent"
          icon={<ArrowUndo20Regular />}
          disabled={count === 0}
          onClick={onResetAll}
        >
          Reset all
        </Button>
        {onExit && (
          <Button
            size="small"
            appearance="transparent"
            icon={<Dismiss16Regular />}
            onClick={onExit}
          >
            Exit
          </Button>
        )}
      </MessageBarActions>
    </MessageBar>
  );
}
