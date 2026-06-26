'use client';

/**
 * BookmarksPane — the "Bookmarks" right-rail tab of the Loom-native Report
 * Designer (Power BI report-authoring parity, wave 2).
 *
 * Power BI parity (ui-parity.md): PBI's Bookmarks pane captures the report's
 * current STATE — the active page, the report/page/visual filters, the slicer /
 * selection state, and (sourced from the Selection pane) each visual's
 * visibility + z-order — into a named bookmark. The author can Apply, Update
 * (re-capture), Rename, Delete, and reorder bookmarks; per-bookmark "Data" /
 * "Display" / "Current page" toggles control which slice of state an Apply
 * restores, and a bookmark's scope is either "All pages" or "Selected visuals".
 * This pane reproduces that surface one-for-one with the Loom theme.
 *
 * Rules compliance:
 *  - no-vaporware.md: there are no dead controls. Apply REALLY restores state —
 *    {@link applyBookmark} turns a bookmark into a structured patch (set active
 *    page, set report/page/visual filters, set selection, set per-visual
 *    visibility + z) that the host applies to its live in-memory model, so the
 *    canvas visibly changes (filters/selection/visibility round-trip). Update
 *    re-captures the current state via {@link captureBookmark}; Rename / Delete /
 *    reorder mutate the persisted list. Nothing is "coming soon". When the list
 *    is empty the pane shows a styled EmptyState gate (not disabled buttons).
 *  - no-freeform-config.md: every control is structured — buttons, Switches, a
 *    scope ToggleButton group, and an inline-rename Input. There is no typed
 *    DAX / JSON anywhere; a bookmark is a structured {@link BookmarkState}.
 *  - no-fabric-dependency.md: Azure-native by construction. A bookmark is plain
 *    report state captured from the Azure-native report /query + /definition
 *    path; nothing here reaches a Fabric / Power BI workspace. No backend call
 *    originates in this component — the host round-trips the bookmark list
 *    through PUT /api/items/report/[id]/definition (state.content.bookmarks,
 *    additive — the read-only viewer / PBIR provisioner ignore the unknown key).
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded
 *    spacing/colors/radii/shadows); per-bookmark cards lift shadow2 → shadow4 on
 *    hover with borderRadiusLarge, and the pane layout mirrors the PBI Bookmarks
 *    pane and matches the sibling interactions.tsx / analytics-pane.tsx panes.
 *
 * The pure helpers (parse / wire / capture / apply) carry no React or fetch and
 * may be imported by any client surface (the host wires them to its model). The
 * persisted shape identifies pages / visuals by id only, so a bookmark survives
 * a round-trip even as the page model evolves; ids that no longer resolve are
 * simply skipped at apply time by the host.
 *
 * Host: report-designer.tsx mounts {@link BookmarksPane} as the right-rail
 * "Bookmarks" tab — it builds a {@link BookmarkCaptureSource} from its live
 * pages/filters/selection, calls {@link captureBookmark} / {@link applyBookmark}
 * / {@link newBookmark}, and round-trips the list through PUT /definition
 * (state.content.bookmarks), the same shape that route's sanitizeBookmark mirrors.
 */

import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Badge, Button, Caption1, Divider, Input, Popover, PopoverSurface, PopoverTrigger,
  Switch, Text, ToggleButton, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowDown20Regular, ArrowSync20Regular, ArrowUp20Regular,
  Bookmark20Regular, BookmarkMultiple20Regular, Checkmark20Regular, Delete20Regular,
  Dismiss20Regular, Edit20Regular, Play20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { reFilters, type ReportFilter } from './filters-pane';
import type { VisualSelection, SelectionConstraint } from './interactions';

// ── Model (persisted on state.content.bookmarks) ─────────────────────────────

/** Which slice of the report a bookmark spans. */
export type BookmarkScope = 'allPages' | 'selectedVisuals';

/**
 * Per-bookmark Apply toggles (PBI "Data" / "Display" / "Current page"):
 *  - data:        restore report/page/visual filters + the slicer/selection.
 *  - display:     restore per-visual visibility + z-order (from the Selection pane).
 *  - currentPage: navigate to the captured active page.
 * Each defaults to true.
 */
export interface BookmarkApply {
  data: boolean;
  display: boolean;
  currentPage: boolean;
}

/**
 * The captured report state a bookmark restores. Pages / visuals are identified
 * by id only — `visibility[id]` is TRUE when the visual is shown (the host sets
 * `hidden = !visibility[id]`), and `zOrder[id]` is its stacking order.
 */
export interface BookmarkState {
  /** Active page id at capture time. */
  activePageId: string;
  /** Report-scope filters (every page). */
  reportFilters: ReportFilter[];
  /** Page-scope filters, keyed by page id. */
  pageFilters: Record<string, ReportFilter[]>;
  /** Visual-scope filters, keyed by visual id. */
  visualFilters: Record<string, ReportFilter[]>;
  /** Slicer / data-point selection at capture time (or null). */
  selection: VisualSelection | null;
  /** Per-visual visibility (true = visible), keyed by visual id. */
  visibility: Record<string, boolean>;
  /** Per-visual z-order, keyed by visual id. */
  zOrder: Record<string, number>;
}

/** A named, restorable report bookmark. */
export interface ReportBookmark {
  /** Stable client id. */
  id: string;
  /** Display name (clamped to {@link MAX_NAME} chars). */
  name: string;
  /** ISO timestamp of capture / last update. */
  createdAt: string;
  /** All pages vs the selected visuals only. */
  scope: BookmarkScope;
  /** Which state an Apply restores. */
  apply: BookmarkApply;
  /** The captured state. */
  state: BookmarkState;
}

/** Max bookmark name length (defensive clamp on hydrate / rename). */
export const MAX_NAME = 200;
/** Max bookmarks kept per report (defensive cap on hydrate). */
export const MAX_BOOKMARKS = 64;

// ── ids / clamps ──────────────────────────────────────────────────────────────

function uid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? `bm_${crypto.randomUUID().slice(0, 8)}`
    : `bm_${Math.random().toString(16).slice(2, 10)}`;
}

function clampName(s: string): string {
  return (s || '').slice(0, MAX_NAME);
}

// ── pure clones (immutability — never mutate caller state) ───────────────────

function cloneFilters(list: ReportFilter[] | null | undefined): ReportFilter[] {
  return (list || []).map((f) => ({ ...f, values: f.values ? [...f.values] : undefined }));
}

function cloneFilterMap(map: Record<string, ReportFilter[]> | null | undefined): Record<string, ReportFilter[]> {
  const out: Record<string, ReportFilter[]> = {};
  for (const [k, v] of Object.entries(map || {})) out[k] = cloneFilters(v);
  return out;
}

function cloneSelection(sel: VisualSelection | null | undefined): VisualSelection | null {
  if (!sel || !sel.sourceId) return null;
  const constraints: SelectionConstraint[] = (sel.constraints || []).map((c) => ({
    field: c.field,
    values: [...(c.values || [])],
  }));
  return { sourceId: sel.sourceId, constraints };
}

// ── defensive hydrate (mirror reFilters / parseInteractions) ─────────────────

function parseApply(value: unknown): BookmarkApply {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  // Match the /definition route's sanitizeBookmark defaults exactly so a hydrated
  // bookmark and a route-sanitized one agree: Data + Display default ON (only an
  // explicit `false` turns them off); Current-page defaults OFF (only an explicit
  // `true` turns it on) — the route always persists an explicit boolean, so this
  // default only governs foreign/legacy entries.
  return {
    data: o.data !== false,
    display: o.display !== false,
    currentPage: o.currentPage === true,
  };
}

function parseSelection(value: unknown): VisualSelection | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const sourceId = typeof o.sourceId === 'string' ? o.sourceId : '';
  if (!sourceId) return null;
  const rawCons = Array.isArray(o.constraints) ? o.constraints : [];
  const constraints: SelectionConstraint[] = [];
  for (const c of rawCons) {
    const co = (c || {}) as Record<string, unknown>;
    const field = typeof co.field === 'string' ? co.field : '';
    if (!field) continue;
    const values = Array.isArray(co.values)
      ? co.values.map((v) => (v == null ? null : (typeof v === 'number' ? v : String(v))))
      : [];
    constraints.push({ field, values });
  }
  return { sourceId, constraints };
}

function parseFilterMap(value: unknown): Record<string, ReportFilter[]> {
  const out: Record<string, ReportFilter[]> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!k) continue;
    const filters = reFilters(v); // canonical filter sanitizer (drops unknown keys, fresh ids)
    if (filters.length) out[k] = filters;
  }
  return out;
}

function parseBoolMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k) out[k] = !!v;
  }
  return out;
}

function parseNumMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function parseBookmarkState(value: unknown): BookmarkState {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    activePageId: typeof o.activePageId === 'string' ? o.activePageId : '',
    reportFilters: reFilters(o.reportFilters),
    pageFilters: parseFilterMap(o.pageFilters),
    visualFilters: parseFilterMap(o.visualFilters),
    selection: parseSelection(o.selection),
    visibility: parseBoolMap(o.visibility),
    zOrder: parseNumMap(o.zOrder),
  };
}

/**
 * Defensively hydrate a persisted/wire value into a {@link ReportBookmark} list
 * (it arrives from Cosmos `state.content.bookmarks` or a PUT body). Unknown
 * shapes and stray keys are dropped rather than thrown — mirroring the
 * designer's `reFilters` / `parseInteractions` — names are clamped to
 * {@link MAX_NAME}, and the list is capped at {@link MAX_BOOKMARKS}.
 */
function sanitizeBookmarks(value: unknown): ReportBookmark[] {
  if (!Array.isArray(value)) return [];
  const out: ReportBookmark[] = [];
  for (const r of value) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      name: clampName(typeof o.name === 'string' && o.name.trim() ? o.name : 'Bookmark'),
      createdAt: typeof o.createdAt === 'string' && o.createdAt ? o.createdAt : new Date().toISOString(),
      scope: o.scope === 'selectedVisuals' ? 'selectedVisuals' : 'allPages',
      apply: parseApply(o.apply),
      state: parseBookmarkState(o.state),
    });
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

/** Hydrate a persisted value (Cosmos / PUT body) into a clean bookmark list. */
export function parseBookmarks(value: unknown): ReportBookmark[] {
  return sanitizeBookmarks(value);
}

/**
 * Strip a bookmark list to its clean persistable form (drop unknown keys, clamp
 * names, cap the count); returns undefined when there is nothing to persist so
 * the host can omit the key entirely. The host writes this to
 * `state.content.bookmarks` through PUT /definition.
 */
export function wireBookmarks(list: ReportBookmark[] | null | undefined): ReportBookmark[] | undefined {
  const out = sanitizeBookmarks(list);
  return out.length > 0 ? out : undefined;
}

// ── capture (host passes its current state in) ───────────────────────────────

/** Minimal structural shape of a visual the capture walks. */
export interface BookmarkCaptureVisual {
  id: string;
  /** Hidden (Selection-pane eye toggle). */
  hidden?: boolean;
  /** Z-order (Selection-pane reorder). */
  z?: number;
  /** Filters scoped to this visual. */
  filters?: ReportFilter[] | null;
}

/** Minimal structural shape of a page the capture walks. */
export interface BookmarkCapturePage {
  id: string;
  /** Filters scoped to this page. */
  filters?: ReportFilter[] | null;
  visuals: BookmarkCaptureVisual[];
}

/** The host's current report state, passed into {@link captureBookmark}. */
export interface BookmarkCaptureSource {
  /** Active page id. */
  activePageId: string;
  /** Report-scope filters. */
  reportFilters?: ReportFilter[] | null;
  /** Every page (with its page/visual filters + per-visual hidden/z). */
  pages: BookmarkCapturePage[];
  /** Current slicer / data-point selection (or null). */
  selection?: VisualSelection | null;
  /** Scope being captured; defaults to 'allPages'. */
  scope?: BookmarkScope;
  /**
   * For scope 'selectedVisuals': the ids whose per-visual state to capture. When
   * provided, report/page filters and page navigation are NOT captured (a
   * selected-visuals bookmark only carries the chosen visuals' state — PBI
   * semantics).
   */
  selectedVisualIds?: string[];
}

/**
 * Build a {@link BookmarkState} snapshot from the host's CURRENT state. Pure —
 * deep-clones every captured array so a later host mutation never bleeds into a
 * stored bookmark. For a 'selectedVisuals' capture only the chosen visuals'
 * visibility / z-order / visual-filters are captured (no report/page filters,
 * no active-page), matching the PBI selected-visuals bookmark.
 */
export function captureBookmark(src: BookmarkCaptureSource): BookmarkState {
  const scope = src.scope ?? 'allPages';
  const selectedSet = scope === 'selectedVisuals' && src.selectedVisualIds && src.selectedVisualIds.length
    ? new Set(src.selectedVisualIds)
    : null;

  const pageFilters: Record<string, ReportFilter[]> = {};
  const visualFilters: Record<string, ReportFilter[]> = {};
  const visibility: Record<string, boolean> = {};
  const zOrder: Record<string, number> = {};

  for (const p of src.pages || []) {
    if (!p || !p.id) continue;
    if (!selectedSet && p.filters && p.filters.length) pageFilters[p.id] = cloneFilters(p.filters);
    for (const v of p.visuals || []) {
      if (!v || !v.id) continue;
      if (selectedSet && !selectedSet.has(v.id)) continue;
      visibility[v.id] = !v.hidden;
      if (typeof v.z === 'number' && Number.isFinite(v.z)) zOrder[v.id] = v.z;
      if (v.filters && v.filters.length) visualFilters[v.id] = cloneFilters(v.filters);
    }
  }

  return {
    activePageId: selectedSet ? '' : (src.activePageId || ''),
    reportFilters: selectedSet ? [] : cloneFilters(src.reportFilters || []),
    pageFilters,
    visualFilters,
    selection: cloneSelection(src.selection),
    visibility,
    zOrder,
  };
}

/** Compose a {@link captureBookmark} snapshot into a brand-new {@link ReportBookmark}. */
export function newBookmark(
  opts: { name: string; scope: BookmarkScope; apply: BookmarkApply },
  state: BookmarkState,
): ReportBookmark {
  return {
    id: uid(),
    name: clampName(opts.name || 'Bookmark'),
    createdAt: new Date().toISOString(),
    scope: opts.scope,
    apply: opts.apply,
    state,
  };
}

// ── apply (host applies the returned patch) ──────────────────────────────────

/**
 * The structured patch an Apply produces. Only the keys enabled by the
 * bookmark's {@link BookmarkApply} toggles (and allowed by its scope) are
 * present; the host applies exactly the keys it finds:
 *   - activePageId → setActivePage(id)
 *   - reportFilters → setReportFilters(...)
 *   - pageFilters / visualFilters → per-id setFilters
 *   - selection → setSelection(...)
 *   - visibility → per-id hidden = !visible
 *   - zOrder → per-id z
 */
export interface BookmarkApplyPatch {
  activePageId?: string;
  reportFilters?: ReportFilter[];
  pageFilters?: Record<string, ReportFilter[]>;
  visualFilters?: Record<string, ReportFilter[]>;
  selection?: VisualSelection | null;
  visibility?: Record<string, boolean>;
  zOrder?: Record<string, number>;
}

/**
 * Turn a bookmark into the structured patch the host applies, honoring the
 * bookmark's Data / Display / Current-page toggles and its scope. Pure —
 * deep-clones so applying a bookmark twice yields independent objects. A
 * 'selectedVisuals' bookmark never sets the active page or report/page filters
 * (only the chosen visuals' filters / selection / visibility / z).
 */
export function applyBookmark(bookmark: ReportBookmark): BookmarkApplyPatch {
  const { state, apply } = bookmark;
  const selectedScope = bookmark.scope === 'selectedVisuals';
  const patch: BookmarkApplyPatch = {};

  if (apply.currentPage && !selectedScope && state.activePageId) {
    patch.activePageId = state.activePageId;
  }
  if (apply.data) {
    if (!selectedScope) {
      patch.reportFilters = cloneFilters(state.reportFilters);
      patch.pageFilters = cloneFilterMap(state.pageFilters);
    }
    patch.visualFilters = cloneFilterMap(state.visualFilters);
    patch.selection = cloneSelection(state.selection);
  }
  if (apply.display) {
    patch.visibility = { ...state.visibility };
    patch.zOrder = { ...state.zOrder };
  }
  return patch;
}

// ── presentation helpers ──────────────────────────────────────────────────────

const SCOPE_META: Record<BookmarkScope, { label: string; hint: string }> = {
  allPages: { label: 'All pages', hint: 'Captures the active page, every filter scope, the selection, and visual visibility.' },
  selectedVisuals: { label: 'Selected visuals', hint: 'Captures only the selected visuals’ filters, selection, visibility, and order.' },
};

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  try {
    return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Short "what this restores" summary from the apply toggles. */
function applySummary(apply: BookmarkApply): string {
  const on: string[] = [];
  if (apply.data) on.push('Data');
  if (apply.display) on.push('Display');
  if (apply.currentPage) on.push('Current page');
  return on.length ? on.join(' · ') : 'Nothing (all toggles off)';
}

// ── styles (Fluent v9 + Loom tokens; matches interactions/analytics panes) ────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  headRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  spacer: { flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow4, border: `1px solid ${tokens.colorNeutralStroke1}` },
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  cardIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex' },
  cardName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  renameRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flex: 1, minWidth: 0 },
  renameInput: { flex: 1, minWidth: 0 },
  metaRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, flexWrap: 'wrap' },
  actionSpacer: { flex: 1 },
  // add popover
  popover: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '264px', maxWidth: '320px' },
  popHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  scopeStrip: {
    display: 'flex', gap: '2px', padding: '2px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  scopeBtn: {
    flex: 1, minWidth: 0, border: 'none', backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2, borderRadius: tokens.borderRadiusSmall,
  },
  scopeBtnActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorBrandForeground1, boxShadow: tokens.shadow2,
  },
  toggles: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  popActions: { display: 'flex', justifyContent: 'flex-end', gap: tokens.spacingHorizontalS },
});

type Styles = ReturnType<typeof useStyles>;

// ── the Add-bookmark popover ──────────────────────────────────────────────────

function AddBookmarkPopover({
  styles, open, onOpenChange, defaultName, onSubmit,
}: {
  styles: Styles;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onSubmit: (opts: { name: string; scope: BookmarkScope; apply: BookmarkApply }) => void;
}): ReactElement {
  const [name, setName] = useState<string>(defaultName);
  const [scope, setScope] = useState<BookmarkScope>('allPages');
  const [apply, setApply] = useState<BookmarkApply>({ data: true, display: true, currentPage: true });

  // Reset the form to fresh defaults each time the popover opens.
  const reset = () => {
    setName(defaultName);
    setScope('allPages');
    setApply({ data: true, display: true, currentPage: true });
  };

  const submit = () => {
    onSubmit({ name: clampName(name.trim() || defaultName), scope, apply });
    onOpenChange(false);
  };

  return (
    <Popover
      open={open}
      trapFocus
      withArrow
      onOpenChange={(_e, d) => { if (d.open) reset(); onOpenChange(d.open); }}
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="primary" size="small" icon={<Add20Regular />}>Add bookmark</Button>
      </PopoverTrigger>
      <PopoverSurface>
        <div className={styles.popover}>
          <div className={styles.popHead}>
            <BookmarkMultiple20Regular />
            <Caption1><strong>New bookmark</strong></Caption1>
          </div>

          <div className={styles.field}>
            <Caption1 className={styles.hint}>Name</Caption1>
            <Input
              size="small"
              aria-label="Bookmark name"
              value={name}
              maxLength={MAX_NAME}
              onChange={(_e, d) => setName(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
          </div>

          <div className={styles.field}>
            <Caption1 className={styles.hint}>Scope</Caption1>
            <div className={styles.scopeStrip} role="radiogroup" aria-label="Bookmark scope">
              {(['allPages', 'selectedVisuals'] as BookmarkScope[]).map((s) => {
                const active = scope === s;
                return (
                  <ToggleButton
                    key={s}
                    size="small"
                    appearance="subtle"
                    checked={active}
                    role="radio"
                    aria-checked={active}
                    className={mergeClasses(styles.scopeBtn, active && styles.scopeBtnActive)}
                    onClick={() => setScope(s)}
                  >
                    {SCOPE_META[s].label}
                  </ToggleButton>
                );
              })}
            </div>
            <Caption1 className={styles.hint}>{SCOPE_META[scope].hint}</Caption1>
          </div>

          <div className={styles.field}>
            <Caption1 className={styles.hint}>Apply restores</Caption1>
            <div className={styles.toggles}>
              <Switch
                label="Data (filters & selection)"
                checked={apply.data}
                onChange={(_e, d) => setApply((a) => ({ ...a, data: d.checked }))}
              />
              <Switch
                label="Display (visibility & order)"
                checked={apply.display}
                onChange={(_e, d) => setApply((a) => ({ ...a, display: d.checked }))}
              />
              <Switch
                label="Current page"
                disabled={scope === 'selectedVisuals'}
                checked={apply.currentPage && scope !== 'selectedVisuals'}
                onChange={(_e, d) => setApply((a) => ({ ...a, currentPage: d.checked }))}
              />
            </div>
          </div>

          <div className={styles.popActions}>
            <Button size="small" appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="small" appearance="primary" icon={<Checkmark20Regular />} onClick={submit}>Add</Button>
          </div>
        </div>
      </PopoverSurface>
    </Popover>
  );
}

// ── a single bookmark card ────────────────────────────────────────────────────

function BookmarkCard({
  styles, bookmark, index, count, renaming, onStartRename, onCommitRename, onCancelRename,
  onApply, onUpdate, onDelete, onMove,
}: {
  styles: Styles;
  bookmark: ReportBookmark;
  index: number;
  count: number;
  renaming: boolean;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onApply: () => void;
  onUpdate: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
}): ReactElement {
  const baseId = useId();
  const [draft, setDraft] = useState<string>(bookmark.name);
  const when = fmtWhen(bookmark.createdAt);
  // Reset the inline-rename draft to the current name each time rename opens, so
  // a stale draft from a previous edit can never be committed.
  useEffect(() => { if (renaming) setDraft(bookmark.name); }, [renaming, bookmark.name]);
  const commitRename = () => onCommitRename(clampName((draft || bookmark.name).trim() || 'Bookmark'));

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden><Bookmark20Regular /></span>
        {renaming ? (
          <div className={styles.renameRow}>
            <Input
              size="small"
              className={styles.renameInput}
              aria-label="Rename bookmark"
              value={draft}
              maxLength={MAX_NAME}
              autoFocus
              onChange={(_e, d) => setDraft(d.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') onCancelRename();
              }}
            />
            <Tooltip content="Save name" relationship="label" withArrow>
              <Button
                size="small" appearance="subtle" icon={<Checkmark20Regular />} aria-label="Save name"
                onClick={commitRename}
              />
            </Tooltip>
            <Tooltip content="Cancel" relationship="label" withArrow>
              <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} aria-label="Cancel rename" onClick={onCancelRename} />
            </Tooltip>
          </div>
        ) : (
          <Text id={`${baseId}-name`} className={styles.cardName} weight="semibold" title={bookmark.name}>
            {bookmark.name}
          </Text>
        )}
      </div>

      {!renaming && (
        <div className={styles.metaRow}>
          <Badge appearance="tint" size="small">{SCOPE_META[bookmark.scope].label}</Badge>
          <Tooltip content={`Restores: ${applySummary(bookmark.apply)}`} relationship="label" withArrow>
            <Badge appearance="outline" size="small">{applySummary(bookmark.apply)}</Badge>
          </Tooltip>
          {when && <Caption1 className={styles.hint}>{when}</Caption1>}
        </div>
      )}

      <div className={styles.actions}>
        <Tooltip content="Apply this bookmark" relationship="label" withArrow>
          <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={onApply}>Apply</Button>
        </Tooltip>
        <Tooltip content="Update to the current state" relationship="label" withArrow>
          <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} aria-label="Update bookmark" onClick={onUpdate}>Update</Button>
        </Tooltip>
        <Tooltip content="Rename" relationship="label" withArrow>
          <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label="Rename bookmark" onClick={onStartRename} disabled={renaming} />
        </Tooltip>
        <div className={styles.actionSpacer} />
        <Tooltip content="Move up" relationship="label" withArrow>
          <Button size="small" appearance="subtle" icon={<ArrowUp20Regular />} aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        </Tooltip>
        <Tooltip content="Move down" relationship="label" withArrow>
          <Button size="small" appearance="subtle" icon={<ArrowDown20Regular />} aria-label="Move down" disabled={index >= count - 1} onClick={() => onMove(1)} />
        </Tooltip>
        <Tooltip content="Delete" relationship="label" withArrow>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Delete bookmark" onClick={onDelete} />
        </Tooltip>
      </div>
    </div>
  );
}

// ── BookmarksPane ─────────────────────────────────────────────────────────────

export interface BookmarksPaneProps {
  /** The persisted bookmark list (read from `state.content.bookmarks`). */
  bookmarks: ReportBookmark[];
  /**
   * Emit the next bookmark list for list-only mutations (reorder / rename /
   * delete). The host persists this through PUT /definition.
   */
  onChange: (next: ReportBookmark[]) => void;
  /**
   * Capture the host's CURRENT report state into a bookmark. For Add, `replaceId`
   * is omitted (host appends a new bookmark via {@link newBookmark}); for Update,
   * `replaceId` is set (host re-captures into that bookmark, preserving its
   * id / name / createdAt). The host owns the capture because only it holds the
   * live pages / filters / selection / visibility (it calls {@link captureBookmark}).
   */
  onCapture: (opts: { name?: string; scope: BookmarkScope; apply: BookmarkApply; replaceId?: string }) => void;
  /**
   * Apply a bookmark — the host calls {@link applyBookmark} to get the patch and
   * restores its live model from it (active page / filters / selection /
   * visibility / z).
   */
  onApply: (bookmark: ReportBookmark) => void;
  /** Suggested default name for a new bookmark (e.g. the active page name). */
  currentName?: string;
}

/**
 * The Bookmarks right-rail tab. Controlled + fully structured: an Add-bookmark
 * popover (name + scope + Data/Display/Current-page Switches) captures the host's
 * current state, and each bookmark card exposes Apply / Update / Rename / Delete
 * and Up/Down reorder. Degrades to a styled EmptyState when there are no
 * bookmarks (no-vaporware: not disabled controls). No backend call originates
 * here — the host round-trips the list through PUT /definition.
 */
export function BookmarksPane({
  bookmarks, onChange, onCapture, onApply, currentName,
}: BookmarksPaneProps): ReactElement {
  const styles = useStyles();
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const list = Array.isArray(bookmarks) ? bookmarks : [];
  const defaultName = (currentName && currentName.trim()) || `Bookmark ${list.length + 1}`;

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...list];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    const [item] = next.splice(idx, 1);
    next.splice(j, 0, item);
    onChange(next);
  };
  const rename = (id: string, name: string) => {
    onChange(list.map((b) => (b.id === id ? { ...b, name: clampName(name) } : b)));
    setRenamingId(null);
  };
  const remove = (id: string) => {
    if (renamingId === id) setRenamingId(null);
    onChange(list.filter((b) => b.id !== id));
  };
  const addBookmark = (opts: { name: string; scope: BookmarkScope; apply: BookmarkApply }) =>
    onCapture({ name: opts.name, scope: opts.scope, apply: opts.apply });
  const updateBookmark = (b: ReportBookmark) =>
    onCapture({ scope: b.scope, apply: b.apply, replaceId: b.id });

  return (
    <div className={styles.pane}>
      <div className={styles.headRow}>
        <BookmarkMultiple20Regular />
        <Caption1><strong>Bookmarks</strong></Caption1>
        <div className={styles.spacer} />
        <AddBookmarkPopover
          styles={styles}
          open={addOpen}
          onOpenChange={setAddOpen}
          defaultName={defaultName}
          onSubmit={addBookmark}
        />
      </div>

      <Caption1 className={styles.hint}>
        A bookmark captures the current page, filters, selection, and visual visibility. Apply it to jump
        back to that view; Update re-captures the current state.
      </Caption1>

      <Divider />

      {list.length === 0 ? (
        <EmptyState
          icon={<BookmarkMultiple20Regular />}
          title="No bookmarks yet"
          body="Set up the page, filters, selection, and visual visibility the way you want, then add a bookmark to capture that view. Apply a bookmark any time to restore it."
          primaryAction={{ label: 'Add a bookmark', onClick: () => setAddOpen(true) }}
        />
      ) : (
        <div className={styles.list}>
          {list.map((b, i) => (
            <BookmarkCard
              key={b.id}
              styles={styles}
              bookmark={b}
              index={i}
              count={list.length}
              renaming={renamingId === b.id}
              onStartRename={() => setRenamingId(b.id)}
              onCommitRename={(name) => rename(b.id, name)}
              onCancelRename={() => setRenamingId(null)}
              onApply={() => onApply(b)}
              onUpdate={() => updateBookmark(b)}
              onDelete={() => remove(b.id)}
              onMove={(dir) => move(i, dir)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default BookmarksPane;
