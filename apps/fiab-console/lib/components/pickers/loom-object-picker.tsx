'use client';

/**
 * LoomObjectPicker — the shared "pick an object Loom already knows about"
 * control, for values that are a reference to a Loom item, workspace, or
 * catalog object rather than an address the user could ever be expected to
 * know (`loom_no_freeform_config`; `auto-bind-by-default.md` §5).
 *
 * WHY THIS EXISTS AS A NEW PRIMITIVE, and not a fourth copy of the same bug.
 *
 * Three discovery-backed pickers already exist in this tree, and each of them
 * carries at least one of the two defects below. Cloning any of them would have
 * shipped the defect a fourth time:
 *
 *   1. THE STORED VALUE IS COMPUTED BY FINDING IT IN THE FETCHED LIST.
 *      `azure-resource-picker.tsx` does
 *        `const selected = resources.find((r) => r.id === value) || null`
 *      and its `onSelect` even calls `onChange(null)` when the id is missing
 *      from the list. `connection-picker.tsx` does `byId.get(value)`.
 *      `report/loom-item-source-picker.tsx` does `items.find(...)` and hides
 *      the Dropdown entirely when the list comes back empty.
 *
 *      So a persisted id the caller cannot resolve RIGHT NOW — the item was
 *      deleted, it lives in another workspace, the discovery call 403s, the
 *      service is down, or (Gov) the API is not GA in this boundary — renders
 *      as an EMPTY control. The user sees a blank required field over a record
 *      that actually has a value, and the first save writes the blank back.
 *      Silent data loss on a read-only round trip.
 *
 *      Here the stored value is ALWAYS rendered and ALWAYS kept: an id absent
 *      from the fetched list is synthesized into the option list, marked as
 *      unresolved, and stays selected until the user changes it. The picker
 *      never emits a change the user did not make.
 *
 *   2. AN EMPTY LIST DISABLES THE CONTROL.
 *      `phase3/workspace-picker.tsx` sets
 *        `disabled={loading || (workspaces?.length ?? 0) === 0}`
 *      and `azure-resource-picker.tsx` disables on `!resources.length && …`.
 *      "No results" plus a dead control is the exact shape
 *      `auto-bind-by-default.md` forbids. This control is NEVER disabled: an
 *      empty or failed load renders a guided inline MessageBar (with an
 *      optional Fix-it per `ux-baseline.md` G2) ABOVE a still-usable Dropdown,
 *      so an existing value can always be inspected and cleared. It is
 *      deliberately NOT the `EmptyState` primitive — that is a full-pane card
 *      (minHeight 320px, XXXL padding, dashed border) and this control renders
 *      inline, inside a form row.
 *
 * SCOPING IS THE CALLER'S CONTRACT. This control renders whatever the loader
 * returns; it is the caller's job to pick a route that scopes to what the
 * signed-in user may actually see. An item picker that lists across workspaces
 * the caller has no access to leaks item names, so the backing route must do
 * the authorization (e.g. `/api/items/by-type`, which authorizes the workspace
 * and otherwise filters to the caller's visible workspaces).
 *
 * WHERE THIS LIVES. `lib/components/pickers/` is the declared home for
 * discovery-backed pickers that are NOT specific to one consumer. The ~15
 * existing pickers sit beside their consumers because each serves exactly one
 * surface; this one is shared by three (and counting), so it goes in the shared
 * directory rather than in whichever editor happened to adopt it first.
 *
 * ── WHICH PICKER DO I USE? (settled against Wave 0's #3572, on the combined
 *    tree, not by reading either PR description) ───────────────────────────────
 *
 *   `components/azure/AzureBackedField` / `AzureResourcePicker`
 *       → the value is an ARM RESOURCE. Those are built on the gate registry's
 *         28 ARM options-loaders (`lib/gates/registry/types.ts` `L`) and query
 *         Azure Resource Graph via `GET /api/azure/resources`; every kind names
 *         an `armType`. Use them for anything with an ARM id: a Databricks
 *         workspace URL, a Key Vault URI, an ADX cluster endpoint, a SQL server
 *         FQDN. THAT IS THE DEFAULT — prefer it whenever it can answer.
 *
 *   THIS control
 *       → the value is an object Loom knows about that is NOT in Resource
 *         Graph, so no ARM query can produce it. The three current adopters are
 *         each of that kind: a data-product LOOM ITEM (Cosmos), a Purview
 *         Unified Catalog business DOMAIN (Purview data plane), and a
 *         model-serving ENDPOINT NAME (AML/Databricks data plane). The loader
 *         is injected rather than derived from an `armType`, precisely because
 *         there is no `armType` to derive it from.
 *
 * The two share the preservation PROPERTY (an unresolvable stored value is kept
 * and disclosed) and implement it separately — Wave 0 inside its own component,
 * this file in the exported pure `mergeStoredValue`. That duplication is worth
 * collapsing into one shared helper, but not from this branch: #3572 landed
 * days ago and the refactor belongs to whoever owns both, with both test suites
 * green on the combined tree.
 *
 * Fluent v9 + Loom tokens only; no hard-coded px / hex (`web3-ui.md`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button, Caption1, Dropdown, Field, MessageBar, MessageBarActions, MessageBarBody,
  MessageBarTitle, Option, Spinner, Text, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular, Warning16Regular } from '@fluentui/react-icons';

/** One pickable object. `id` is what gets persisted; `name` is what is shown. */
export interface LoomObjectOption {
  id: string;
  name: string;
  /** Secondary line in the option (type, workspace, region, state…). */
  caption?: string;
}

/**
 * What a discovery call hands back. `error` is surfaced VERBATIM — a loader
 * must never convert "I could not reach the service" into an empty list
 * (`deploy-integrity.md` R7): an empty list means "there are none", and an
 * error means "I do not know", and those two must stay distinguishable.
 */
export interface LoomObjectLoad {
  options: LoomObjectOption[];
  error?: string;
  /** Remediation detail shown under the error (env var, role, scope…). */
  hint?: string;
  /**
   * A STRUCTURED honest gate from the route, when the reason the list is
   * unavailable is a config gate rather than a failure. Carrying this through
   * (rather than flattening it to `error`) is what lets the host render the
   * shared `HonestGate` with its real Fix-it wizard — `ux-baseline.md` G2 makes
   * a bare remediation MessageBar non-compliant, and a route that returns
   * `fixEnvVar` into a UI that reads only `error` is a gate that LOOKS wired.
   */
  gate?: { gateId: string; missing?: string };
}

/**
 * The resolved list plus its liveness, as a value a HOST can own.
 *
 * This exists so a surface that renders N pickers over the SAME population
 * fetches once. `ports-panel.tsx` renders one picker per input port row; with a
 * per-instance fetch that was an N+1 against a cross-partition Cosmos scan,
 * re-firing on every added port.
 */
export interface LoomObjectSource {
  /** null = the first load has not resolved yet (distinct from "empty"). */
  options: LoomObjectOption[] | null;
  error: string | null;
  hint: string | null;
  /** The route's structured config gate, when it returned one. */
  gate: { gateId: string; missing?: string } | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Run a discovery call and keep its result. Call it ONCE in a host that renders
 * several pickers over the same population and pass the result to each as
 * `source`; a single-picker surface can just pass `load` and let the picker own
 * this internally.
 *
 * STALENESS: every run carries a sequence number and a late response from a
 * superseded run is DROPPED. Without it two overlapping loads resolve
 * last-to-arrive rather than last-requested, so a fast refresh landing after a
 * slow initial load would show the older list.
 */
export function useLoomObjects(load: () => Promise<LoomObjectLoad>, loadKey = ''): LoomObjectSource {
  const [options, setOptions] = useState<LoomObjectOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [gate, setGate] = useState<LoomObjectSource['gate']>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  // `load` is re-created by most callers on every render; `loadKey` is the
  // caller's DECLARED dependency, so keying on it avoids a fetch loop while
  // still refetching when the scope genuinely changes.
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    setHint(null);
    setGate(null);
    try {
      const r = await loadRef.current();
      if (mine !== seq.current) return; // superseded — a later run owns the state
      setOptions(Array.isArray(r.options) ? r.options : []);
      setError(r.error ?? null);
      setHint(r.hint ?? null);
      setGate(r.gate ?? null);
    } catch (e: any) {
      if (mine !== seq.current) return;
      // An unreachable discovery call is NOT an empty list.
      setOptions([]);
      setError(e?.message || String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [loadKey]);

  useEffect(() => { void run(); }, [run]);

  return { options, error, hint, gate, loading, reload: run };
}

export interface LoomObjectPickerProps {
  label: string;
  /** The persisted value. Rendered even when the loader cannot resolve it. */
  value: string;
  onChange: (id: string) => void;
  /** The real discovery call. Ignored when `source` is supplied. */
  load?: () => Promise<LoomObjectLoad>;
  /** A host-owned list (see {@link useLoomObjects}) — use when several pickers
   *  share one population, so the fetch happens once. */
  source?: LoomObjectSource;
  /** Re-runs `load()` when it changes. Keep it a primitive. */
  loadKey?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  /** Guided empty state (never a bare "no results"). */
  emptyTitle?: string;
  emptyBody?: string;
  /**
   * Inline Fix-it for the empty AND gated/error states (`ux-baseline.md` G2:
   * a bare remediation MessageBar with no Fix-it is not compliant).
   */
  fixIt?: { label: string; onClick: () => void };
  /**
   * Rendered INSTEAD of the plain error MessageBar when the loader reported a
   * structured config gate. Hosts pass the shared `<HonestGate>` here so the
   * gated state gets the real registry-driven Fix-it wizard rather than a
   * second, weaker copy of it inside this control.
   */
  gateSlot?: ReactNode;
  /**
   * Caption on a stored value the loader did not return. Names WHY it may be
   * missing so the user is not told a value they can see is invalid.
   */
  unresolvedCaption?: string;
  /** Test hook / a11y id passthrough. */
  'data-testid'?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0, flexWrap: 'wrap' },
  grow: { flexGrow: 1, minWidth: 0 },
  option: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  unresolved: { color: tokens.colorPaletteDarkOrangeForeground1, display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
});

/**
 * Merge the discovered options with the stored value.
 *
 * Exported so the round-trip property can be asserted directly, not only
 * through the rendered DOM: a stored id that the loader did not return MUST
 * still appear, still be selected, and still carry its own id as the value.
 *
 * The id is TRIMMED, and callers must select on the same trimmed value — see
 * `normalizeStoredValue`. A stored `' dp-1 '` is realistic precisely because
 * these fields used to be free text people pasted into.
 */
export function mergeStoredValue(
  options: LoomObjectOption[],
  value: string,
): { options: LoomObjectOption[]; unresolved: boolean } {
  const v = normalizeStoredValue(value);
  if (!v) return { options, unresolved: false };
  if (options.some((o) => o.id === v)) return { options, unresolved: false };
  // The stored id leads, so it is visible without scrolling a long list.
  return { options: [{ id: v, name: v }, ...options], unresolved: true };
}

/**
 * The single normalization applied to a stored value — used by BOTH the merge
 * and the selection lookup.
 *
 * It exists because they once disagreed: `mergeStoredValue` inserted the
 * TRIMMED id while the component looked up the RAW `value`. For a stored
 * `' dp-1 '` the merge found a match (so `unresolved` was false and no warning
 * rendered) while the lookup found nothing (so the Dropdown rendered blank and
 * `selectedOptions` matched no option) — a blank required field over a stored
 * value, with no disclosure. That is the exact symptom this primitive exists to
 * prevent, reintroduced by a one-character asymmetry.
 */
export function normalizeStoredValue(value: string | undefined): string {
  return (value || '').trim();
}

/** Sentinel loader for the host-owned (`source`) mode — never invoked for data. */
const EMPTY_LOAD = async (): Promise<LoomObjectLoad> => ({ options: [] });
const SOURCE_OWNED_KEY = '__source-owned__';

export function LoomObjectPicker({
  label, value, onChange, load, source, loadKey = '', hint, required, placeholder,
  emptyTitle, emptyBody, fixIt, gateSlot, unresolvedCaption, ...rest
}: LoomObjectPickerProps) {
  const s = useStyles();
  if (!load && !source) {
    throw new Error('LoomObjectPicker: pass either `load` (self-loading) or `source` (host-owned).');
  }
  // Hook order is stable: the fallback loader is always constructed, and simply
  // resolves to an empty list when the host owns the source.
  const own = useLoomObjects(
    load ?? EMPTY_LOAD,
    source ? SOURCE_OWNED_KEY : loadKey,
  );
  const list = source ?? own;
  const { options: raw, error, hint: loadHint, loading, reload } = list;

  const stored = normalizeStoredValue(value);

  const { options, unresolved } = useMemo(
    () => mergeStoredValue(raw ?? [], stored),
    [raw, stored],
  );

  // `selected` can only be null when `stored` is empty — mergeStoredValue
  // guarantees a non-empty stored value is present in `options`, and both sides
  // read the SAME normalized value.
  const selected = useMemo(() => options.find((o) => o.id === stored) || null, [options, stored]);

  const discovered = raw?.length ?? 0;
  const showEmpty = raw !== null && discovered === 0 && !loading;

  return (
    <div className={s.root} {...rest}>
      <Field label={label} hint={hint} required={required}>
        <div className={s.row}>
          <Dropdown
            className={s.grow}
            aria-label={label}
            // NEVER disabled: a dead control over an empty list is the
            // "no results + disabled" dead end auto-bind-by-default.md forbids,
            // and it also hides a stored value the user needs to see.
            placeholder={loading ? 'Loading…' : (placeholder || 'Select…')}
            value={selected ? selected.name : ''}
            selectedOptions={stored ? [stored] : []}
            onOptionSelect={(_, d) => onChange(String(d.optionValue ?? ''))}
          >
            {options.map((o) => (
              <Option key={o.id} value={o.id} text={o.name}>
                <span className={s.option}>
                  <Text>{o.name}</Text>
                  {o.caption && <Caption1 className={s.muted}>{o.caption}</Caption1>}
                </span>
              </Option>
            ))}
          </Dropdown>
          <Button
            size="small" appearance="subtle" icon={<ArrowSync16Regular />}
            onClick={reload} disabled={loading}
            aria-label={`Refresh ${label}`} title={`Refresh ${label}`}
          />
          {loading && <Spinner size="tiny" />}
        </div>
      </Field>

      {unresolved && (
        <Caption1 className={s.unresolved}>
          <Warning16Regular aria-hidden />
          {unresolvedCaption
            || 'Saved value — not in the list you can see right now (it may have been deleted, may live in another workspace, or the discovery call could not reach it). It is kept as-is until you change it.'}
        </Caption1>
      )}

      {/* A structured config gate gets the SHARED HonestGate (registry-driven
          Fix-it wizard). Otherwise a plain error bar, which still carries a
          Fix-it when the host supplied one — `ux-baseline.md` G2 makes a bare
          remediation MessageBar non-compliant, and the gated case is exactly
          when the user most needs the one-click way out. */}
      {error && gateSlot ? gateSlot : null}
      {error && !gateSlot && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Could not list {label.toLowerCase()}</MessageBarTitle>
            {error}
            {loadHint ? <><br /><Caption1>{loadHint}</Caption1></> : null}
          </MessageBarBody>
          <MessageBarActions>
            {fixIt && <Button size="small" appearance="primary" onClick={fixIt.onClick}>{fixIt.label}</Button>}
            <Button size="small" appearance="secondary" onClick={reload} disabled={loading}>Refresh</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {/* NOT `EmptyState`: that primitive is a full-pane card (minHeight 320px,
          XXXL padding, dashed border) and this control renders INLINE — in
          ports-panel it sits inside a port ROW, where every row would grow its
          own 320px card. An inline MessageBar with the same guidance + actions
          is the field-scale equivalent. */}
      {showEmpty && !error && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>{emptyTitle || `No ${label.toLowerCase()} found`}</MessageBarTitle>
            {emptyBody || 'Nothing to pick yet. Create one, then refresh — an existing value stays selected either way.'}
          </MessageBarBody>
          <MessageBarActions>
            {fixIt && <Button size="small" appearance="primary" onClick={fixIt.onClick}>{fixIt.label}</Button>}
            <Button size="small" appearance="secondary" onClick={reload} disabled={loading}>Refresh</Button>
          </MessageBarActions>
        </MessageBar>
      )}
    </div>
  );
}

export default LoomObjectPicker;
