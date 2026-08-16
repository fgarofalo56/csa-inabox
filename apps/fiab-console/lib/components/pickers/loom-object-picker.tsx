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
 *      empty or failed load renders a guided `EmptyState` (with an optional
 *      inline Fix-it per `ux-baseline.md` G2) ABOVE a still-usable Dropdown, so
 *      an existing value can always be inspected and cleared.
 *
 * SCOPING IS THE CALLER'S CONTRACT. This control renders whatever `load()`
 * returns; it is the caller's job to pick a route that scopes to what the
 * signed-in user may actually see. An item picker that lists across workspaces
 * the caller has no access to leaks item names, so the backing route must do
 * the authorization (e.g. `/api/items/by-type`, which authorizes the workspace
 * and otherwise filters to the caller's visible workspaces).
 *
 * Fluent v9 + Loom tokens only; no hard-coded px / hex (`web3-ui.md`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Caption1, Dropdown, Field, MessageBar, MessageBarBody, MessageBarTitle,
  Option, Spinner, Text, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync16Regular, Search20Regular, Warning16Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

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
}

export interface LoomObjectPickerProps {
  label: string;
  /** The persisted value. Rendered even when `load()` cannot resolve it. */
  value: string;
  onChange: (id: string) => void;
  /** The real discovery call. */
  load: () => Promise<LoomObjectLoad>;
  /** Re-runs `load()` when it changes. Keep it a primitive. */
  loadKey?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  /** Guided empty state (never a bare "no results"). */
  emptyTitle?: string;
  emptyBody?: string;
  /** Inline Fix-it for the empty / gated state (`ux-baseline.md` G2). */
  fixIt?: { label: string; onClick: () => void };
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
 */
export function mergeStoredValue(
  options: LoomObjectOption[],
  value: string,
): { options: LoomObjectOption[]; unresolved: boolean } {
  const v = (value || '').trim();
  if (!v) return { options, unresolved: false };
  if (options.some((o) => o.id === v)) return { options, unresolved: false };
  // The stored id leads, so it is visible without scrolling a long list.
  return { options: [{ id: v, name: v }, ...options], unresolved: true };
}

export function LoomObjectPicker({
  label, value, onChange, load, loadKey = '', hint, required, placeholder,
  emptyTitle, emptyBody, fixIt, unresolvedCaption, ...rest
}: LoomObjectPickerProps) {
  const s = useStyles();
  const [raw, setRaw] = useState<LoomObjectOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadHint, setLoadHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoadHint(null);
    try {
      const r = await load();
      setRaw(Array.isArray(r.options) ? r.options : []);
      setError(r.error ?? null);
      setLoadHint(r.hint ?? null);
    } catch (e: any) {
      // An unreachable discovery call is NOT an empty list.
      setRaw([]);
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
    // `load` is re-created by most callers on every render; `loadKey` is the
    // caller's declared dependency, so keying on it avoids a fetch loop while
    // still refetching when the scope genuinely changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  useEffect(() => { void run(); }, [run]);

  const { options, unresolved } = useMemo(
    () => mergeStoredValue(raw ?? [], value),
    [raw, value],
  );

  const selected = useMemo(() => options.find((o) => o.id === value) || null, [options, value]);
  // NOTE: `selected` can only be null when `value` is empty — mergeStoredValue
  // guarantees a non-empty value is always present in `options`.

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
            selectedOptions={value ? [value] : []}
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
            onClick={() => void run()} disabled={loading}
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

      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Could not list {label.toLowerCase()}</MessageBarTitle>
            {error}
            {loadHint ? <><br /><Caption1>{loadHint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}

      {showEmpty && !error && (
        <EmptyState
          icon={<Search20Regular />}
          title={emptyTitle || `No ${label.toLowerCase()} found`}
          body={emptyBody || `Nothing to pick yet. Create one, then refresh — an existing value stays selected either way.`}
          {...(fixIt ? { primaryAction: { label: fixIt.label, onClick: fixIt.onClick } } : {})}
          secondaryAction={{ label: 'Refresh', onClick: () => void run(), appearance: 'secondary' }}
        />
      )}
    </div>
  );
}

export default LoomObjectPicker;
