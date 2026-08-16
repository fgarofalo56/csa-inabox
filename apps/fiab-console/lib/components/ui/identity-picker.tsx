'use client';

/**
 * IdentityPicker — reusable Entra principal picker (user / group / service
 * principal) backed by real Microsoft Graph search, with transitive
 * (nested-group) expansion.
 *
 * Drop-in anywhere Loom needs to select a principal: RBAC grants, access
 * policies, item ownership, sharing. Mirrors the Azure portal "Select members"
 * blade and Fabric's people-picker — TabList by kind, debounced $search input,
 * Persona result rows, inline group → transitive-members expansion.
 *
 * Backend: GET /api/governance/identities/search (graph-identity-client.ts).
 * When the Console UAMI lacks the Graph AppRoles (or the feature env is unset),
 * the BFF returns 503 with a structured hint and this component renders an
 * honest Fluent MessageBar naming the exact grants required — never a blank
 * list or a fake result (per no-vaporware.md).
 *
 * ── STORED-VALUE MODE (`value` / `onChange`) ────────────────────────────────
 * The picker shipped with a `selected: IdentityHit` prop, i.e. it could only
 * show a principal the caller had ALREADY resolved to a rich object. Every
 * surface that persists a bare object id (an RBAC grant, a policy statement, an
 * AAS role member, a leaver revoke-all) therefore could not adopt it and kept a
 * free-text `<Input>` instead — the adoption gap this mode closes.
 *
 * `value` is the PERSISTED string (object id / UPN / appId). Two properties are
 * load-bearing and are covered by tests:
 *
 *   1. AN UNRESOLVABLE STORED VALUE STILL RENDERS AND STILL SAVES. The chip is
 *      built from `value` itself, never by finding `value` in the fetched
 *      result list. A deleted user, a cross-tenant guest, a non-Entra principal
 *      or a Graph 403 changes only the SUBTITLE, never whether the value is
 *      displayed or round-tripped. (The sibling `azure-resource-picker.tsx`
 *      derives "selected" from the fetched list and silently drops exactly
 *      these values — do not reintroduce that here.)
 *   2. THE LOOKUP NEVER ASSERTS WHAT IT DID NOT ESTABLISH (deploy-integrity R7).
 *      "Graph could not be reached" and "Graph answered, no such object" are
 *      different sentences. A failed lookup says the lookup failed.
 *
 * Resolution is a non-blocking nicety: the chip paints from `value` on the
 * first frame and is only ever UPGRADED to a display name if the directory
 * answers.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Input, Field, Tab, TabList, Persona, Spinner, Link, Badge, Button, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search16Regular, Person16Regular, People16Regular, Apps16Regular,
  ChevronDown16Regular, ChevronRight16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';

// Mirrors IdentityHit from lib/azure/graph-identity-client.ts. Duplicated here
// so the client component never imports server-only Graph code.
export type IdentityKind = 'user' | 'group' | 'spn';

export interface IdentityHit {
  id: string;
  type: IdentityKind;
  displayName: string;
  upn?: string;
  mail?: string;
  appId?: string;
  spnType?: string;
  description?: string;
}

interface RoleHint {
  name: string;
  appRoleId: string;
  scope?: string;
  reason?: string;
}
interface NotConfiguredHint {
  missingEnvVar?: string;
  bicepModule?: string;
  bicepStatus?: string;
  rolesRequired?: RoleHint[];
  followUp?: string;
}
interface PickerError {
  message: string;
  remediation?: string;
  hint?: NotConfiguredHint;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '320px' },
  results: {
    maxHeight: '280px', overflowY: 'auto', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, padding: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '8px', padding: '6px 8px', borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowSelected: { backgroundColor: tokens.colorBrandBackground2 },
  rowMain: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 },
  rowActions: { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
  nested: {
    marginLeft: '24px', paddingLeft: '8px',
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', flexDirection: 'column', gap: '2px',
  },
  empty: { padding: '8px', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  hintCode: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    display: 'block', padding: '2px 0',
  },
  selectedChip: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '8px', padding: '6px 8px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  storedNote: {
    color: tokens.colorNeutralForeground3,
    display: 'block',
    marginTop: tokens.spacingVerticalXXS,
  },
  storedId: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    wordBreak: 'break-all',
    minWidth: 0,
  },
});

const ALL_KINDS: IdentityKind[] = ['user', 'group', 'spn'];

/** An Entra object id. Used only to validate the escape hatch's input. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function kindLabel(t: IdentityKind): string {
  if (t === 'group') return 'group';
  if (t === 'spn') return 'service principal';
  return 'user';
}

function kindIcon(t: IdentityKind) {
  if (t === 'group') return <People16Regular />;
  if (t === 'spn') return <Apps16Regular />;
  return <Person16Regular />;
}

function secondary(h: IdentityHit): string {
  if (h.type === 'user') return h.upn || h.mail || 'user';
  if (h.type === 'spn') return h.appId ? `appId ${h.appId}` : 'service principal';
  return h.description || h.mail || 'group';
}

export interface IdentityPickerProps {
  /**
   * Restrict to one principal kind, 'all' (default), or an explicit subset —
   * e.g. `['user','group']` for an Analysis Services role, which cannot take a
   * service principal. A subset of two or more renders as tabs.
   */
  kind?: IdentityKind | 'all' | IdentityKind[];
  /** Called when the user picks a principal. */
  onSelect?: (hit: IdentityHit) => void;
  /** Currently-selected principal (controlled, rich object), if any. */
  selected?: IdentityHit | null;
  /**
   * STORED-VALUE MODE — the persisted principal string (object id / UPN /
   * appId). Rendered verbatim as a chip whether or not the directory can
   * resolve it. Pass `''` for "nothing selected".
   */
  value?: string;
  /** A display name the caller already persisted alongside `value`, if any. */
  valueLabel?: string;
  /**
   * Emitted on pick (with the full hit) and on clear (with `''`). Providing
   * this is what puts the picker in stored-value mode.
   */
  onChange?: (id: string, hit?: IdentityHit) => void;
  /**
   * Look the stored `value` up in the directory to show a display name.
   * Default true. The lookup NEVER gates rendering or saving — set false to
   * skip it entirely (e.g. when `value` is a UPN the caller already displays).
   */
  resolveValue?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Allow expanding a group to its transitive members. Default true. */
  allowGroupExpand?: boolean;
  /**
   * ESCAPE HATCH (opt-in, default off). Reveals a manual object-id entry
   * BEHIND THE GATE — only once a directory search has actually failed.
   *
   * The wave that built stored-value mode initially DELETED the manual box on
   * `onelake-security-tab.tsx`, and that was wrong: with Graph unreachable the
   * role wizard could not add a member at all, which is the "no results +
   * nothing you can do" dead end `auto-bind-by-default.md` forbids outright. A
   * gate naming the exact AppRoles does not fix that — the operator cannot act
   * past it ON THAT SURFACE.
   *
   * The rule's target is that hand-typing stops being the DEFAULT, not that it
   * becomes impossible when discovery is down. So the hatch is: off unless the
   * caller opts in, invisible until the search errors, validated, and — because
   * its placeholder names what it takes in words — visible to
   * `check-no-freeform.mjs` as a counted free-text SITE. An escape hatch no
   * guard can count is how these went unmeasured in the first place.
   *
   * KNOWN LIMIT, stated because an unstated one reads as coverage: the guard
   * scans a wrapper's DEFINITION file, not its call sites (its own header says
   * so), so this hatch is counted ONCE here however many surfaces enable it.
   * That is the deliberate trade against forking a bypass per surface — which
   * is the exact adoption-gap shape this component exists to end.
   */
  allowManualEntry?: boolean;
  /**
   * Where a manually entered id goes. Defaults to `onChange(value)`. Multi-add
   * callers (a role's member list) pass their own adder; the active kind is
   * supplied so the caller can record the principal type it could not resolve.
   */
  onManualEntry?: (value: string, kind: IdentityKind) => void;
  /** BFF base, defaults to '/api/governance/identities/search'. */
  apiBase?: string;
  label?: string;
  /** Field-level hint rendered under the search box. */
  hint?: string;
  required?: boolean;
}

export function IdentityPicker({
  kind = 'all',
  onSelect,
  selected = null,
  value,
  valueLabel,
  onChange,
  resolveValue = true,
  placeholder,
  disabled = false,
  allowGroupExpand = true,
  allowManualEntry = false,
  onManualEntry,
  apiBase = '/api/governance/identities/search',
  label = 'Search Entra',
  hint,
  required,
}: IdentityPickerProps) {
  const styles = useStyles();
  // Keyed on the CONTENT, not the array identity. Callers pass `kind={['user',
  // 'group','spn']}` as an inline literal, which is a fresh array on every
  // render, so memoising on `[kind]` recomputed `kinds` every render and
  // re-fired the clamp effect below every render. A prop that is semantically
  // constant must not churn. (This was FIRST written on the theory that the
  // churn was eating keystrokes in the manual-entry box; it was measured and it
  // is NOT — the box types in full when the picker is mounted standalone, and
  // the loss only appears inside a Fluent Dialog, whose tabster focus trap
  // fights userEvent under jsdom. The memo fix is kept because it is correct on
  // its own terms, not because it fixed that.)
  const kindKey = Array.isArray(kind) ? kind.join(',') : kind;
  const kinds = useMemo<IdentityKind[]>(() => {
    if (Array.isArray(kind)) return kind.length ? kind : ALL_KINDS;
    return kind === 'all' ? ALL_KINDS : [kind];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindKey]);
  const tabbed = kinds.length > 1;
  const [activeKind, setActiveKind] = useState<IdentityKind>(kinds[0]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<IdentityHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);

  // Per-group transitive-member expansion state.
  const [expanded, setExpanded] = useState<Record<string, IdentityHit[]>>({});
  const [expandingId, setExpandingId] = useState<string | null>(null);

  // A `kind` change (the Power BI / policy surfaces switch it from a sibling
  // Dropdown) must not leave the tab strip on a tab that no longer exists.
  useEffect(() => {
    setActiveKind((k) => (kinds.includes(k) ? k : kinds[0]));
  }, [kinds]);

  const effectiveKind = tabbed ? activeKind : kinds[0];

  // ── stored-value mode ────────────────────────────────────────────────────
  const storedValue = (value ?? '').trim();
  const hasStored = storedValue.length > 0;
  const [resolvedHit, setResolvedHit] = useState<IdentityHit | null>(null);
  const [resolveNote, setResolveNote] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // The last value we resolved, so a re-render (or a parent that rebuilds the
  // props object) cannot re-issue the same Graph lookup.
  const resolvedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!hasStored) {
      setResolvedHit(null); setResolveNote(null); setResolving(false);
      resolvedFor.current = null;
      return;
    }
    if (resolveValue === false) { setResolvedHit(null); setResolveNote(null); return; }
    if (resolvedFor.current === storedValue) return;
    resolvedFor.current = storedValue;
    let live = true;
    setResolving(true); setResolvedHit(null); setResolveNote(null);
    (async () => {
      try {
        const res = await fetch(`${apiBase}?resolve=${encodeURIComponent(storedValue)}`, { cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (!live) return;
        const first = res.ok && json?.ok && Array.isArray(json.results) ? json.results[0] : undefined;
        if (first) { setResolvedHit(first); return; }
        // deploy-integrity R7 — distinguish "the directory answered, nothing
        // matched" from "the directory could not be asked". The stored value is
        // kept and remains saveable in BOTH cases.
        setResolveNote(
          res.ok && json?.ok
            ? 'Not resolvable in this directory — it may be a deleted, cross-tenant or non-Entra principal. Stored value kept as-is.'
            : `Directory lookup unavailable (${json?.error || json?.message || `HTTP ${res.status}`}) — showing the stored value.`,
        );
      } catch (e: any) {
        if (live) setResolveNote(`Directory lookup unavailable (${e?.message || String(e)}) — showing the stored value.`);
      } finally {
        if (live) setResolving(false);
      }
    })();
    return () => { live = false; };
  }, [storedValue, hasStored, apiBase, resolveValue]);

  // Debounced search (300ms) — identical cadence to the RBAC grant dialog.
  useEffect(() => {
    if (disabled) return;
    const phrase = q.trim();
    if (phrase.length < 2) { setHits([]); setError(null); setLoading(false); return; }
    const handle = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${apiBase}?q=${encodeURIComponent(phrase)}&kind=${effectiveKind}`,
          { cache: 'no-store' },
        );
        const json = await res.json();
        if (!res.ok || !json?.ok) {
          setError({
            message: json?.error || `Graph ${res.status}`,
            remediation: json?.remediation,
            hint: json?.hint,
          });
          setHits([]);
        } else {
          setHits(json.results || []);
        }
      } catch (e: any) {
        setError({ message: e?.message || String(e) });
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [q, effectiveKind, apiBase, disabled]);

  const toggleExpand = useCallback(async (group: IdentityHit) => {
    if (expanded[group.id]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[group.id];
        return next;
      });
      return;
    }
    setExpandingId(group.id);
    setError(null);
    try {
      const res = await fetch(`${apiBase}?expand=${encodeURIComponent(group.id)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setError({ message: json?.error || `Graph ${res.status}`, remediation: json?.remediation, hint: json?.hint });
      } else {
        setExpanded((prev) => ({ ...prev, [group.id]: json.results || [] }));
      }
    } catch (e: any) {
      setError({ message: e?.message || String(e) });
    } finally {
      setExpandingId(null);
    }
  }, [apiBase, expanded]);

  const pick = useCallback((h: IdentityHit) => {
    onSelect?.(h);
    if (onChange) {
      // Stored-value mode owns the query box: collapse the result list once a
      // principal is committed. Left alone for the `onSelect`-only callers,
      // where the list is a multi-add surface (share recipients, reviewers).
      onChange(h.id, h);
      setQ(''); setHits([]); setExpanded({});
    }
  }, [onSelect, onChange]);

  const clearStored = useCallback(() => {
    onChange?.('');
    setQ(''); setHits([]); setExpanded({});
    resolvedFor.current = null;
    setResolvedHit(null); setResolveNote(null);
  }, [onChange]);

  // ── manual-entry escape hatch (behind the gate) ──────────────────────────
  const [manual, setManual] = useState('');
  const [manualErr, setManualErr] = useState<string | null>(null);
  const manualSubmit = useCallback(() => {
    const v = manual.trim();
    if (!GUID_RE.test(v)) {
      // Reject with a reason rather than a disabled button — a control that is
      // dead and silent about why is the same dead end in a smaller box.
      setManualErr('That is not an Entra object id. Expected a GUID, e.g. 8 hex-4-4-4-12.');
      return;
    }
    setManualErr(null);
    setManual('');
    if (onManualEntry) onManualEntry(v, effectiveKind);
    else onChange?.(v);
  }, [manual, onManualEntry, onChange, effectiveKind]);

  const placeholderText = useMemo(() => {
    if (placeholder) return placeholder;
    if (effectiveKind === 'group') return 'Group display name';
    if (effectiveKind === 'spn') return 'App / managed-identity name';
    return 'Display name or UPN';
  }, [placeholder, effectiveKind]);

  // A stored value ALWAYS paints, from `value` itself. Resolution can only
  // improve the label — it can never decide whether the chip exists.
  const storedChip = hasStored ? (
    <div className={styles.selectedChip}>
      <div className={styles.rowMain}>
        {kindIcon(resolvedHit?.type ?? (kinds.length === 1 ? kinds[0] : 'user'))}
        <div className={styles.rowMain} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
          {resolvedHit ? (
            <Persona
              name={resolvedHit.displayName}
              secondaryText={secondary(resolvedHit)}
              presence={undefined as any}
            />
          ) : (
            <>
              <span className={styles.storedId}>{valueLabel || storedValue}</span>
              {valueLabel && <Caption1 className={styles.storedNote}>{storedValue}</Caption1>}
            </>
          )}
          {resolving && <Caption1 className={styles.storedNote}>Resolving in the directory…</Caption1>}
          {resolveNote && <Caption1 className={styles.storedNote}>{resolveNote}</Caption1>}
        </div>
      </div>
      {onChange && (
        <Button
          appearance="subtle"
          size="small"
          icon={<Dismiss16Regular />}
          aria-label="Clear selected principal"
          disabled={disabled}
          onClick={clearStored}
        />
      )}
    </div>
  ) : null;

  return (
    <div className={styles.root}>
      {storedChip}
      {/* In stored-value mode the search surface is REPLACED by the chip until
          the value is cleared — mirrors the Azure portal "Selected member" row.
          Clearing always brings the search back, so there is no dead end. */}
      {hasStored && onChange ? null : (
        <>
          {tabbed && (
            <TabList
              selectedValue={activeKind}
              onTabSelect={(_e, d) => { setActiveKind(d.value as IdentityKind); setHits([]); setExpanded({}); }}
              disabled={disabled}
            >
              {kinds.includes('user') && <Tab value="user" icon={<Person16Regular />}>Users</Tab>}
              {kinds.includes('group') && <Tab value="group" icon={<People16Regular />}>Groups</Tab>}
              {kinds.includes('spn') && <Tab value="spn" icon={<Apps16Regular />}>Service principals</Tab>}
            </TabList>
          )}

          <Field label={label} hint={hint} required={required}>
            <Input
              value={q}
              onChange={(_e, d) => setQ(d.value)}
              placeholder={placeholderText}
              contentBefore={<Search16Regular />}
              disabled={disabled}
            />
          </Field>

          {selected && (
            <div className={styles.selectedChip}>
              <div className={styles.rowMain}>
                {kindIcon(selected.type)}
                <Persona name={selected.displayName} secondaryText={secondary(selected)} presence={undefined as any} />
              </div>
              {onSelect && (
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<Dismiss16Regular />}
                  aria-label="Clear selection"
                  onClick={() => onSelect(undefined as unknown as IdentityHit)}
                />
              )}
            </div>
          )}

          {error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>{error.message}</MessageBarTitle>
                {error.remediation && <div style={{ marginTop: tokens.spacingVerticalXS }}>{error.remediation}</div>}
                {error.hint?.rolesRequired && error.hint.rolesRequired.length > 0 && (
                  <div style={{ marginTop: tokens.spacingVerticalSNudge }}>
                    Grant the Console UAMI these Microsoft Graph application permissions:
                    {error.hint.rolesRequired.map((r) => (
                      <code key={r.appRoleId} className={styles.hintCode}>
                        {r.name} — {r.appRoleId}
                      </code>
                    ))}
                  </div>
                )}
                {error.hint?.followUp && <div style={{ marginTop: tokens.spacingVerticalSNudge }}>{error.hint.followUp}</div>}
              </MessageBarBody>
              {error.hint?.bicepModule && (
                <MessageBarActions>
                  <span className={styles.empty}>{error.hint.bicepModule}</span>
                </MessageBarActions>
              )}
            </MessageBar>
          )}

          {/* ESCAPE HATCH — reachable only once the directory has actually
              failed. Deleting this is what turned a gated surface into a dead
              end; making it the default is the defect the wave removes. Its
              placeholder names what it takes in words (never a specimen GUID —
              a placeholder rendering the value's syntax is the surface teaching
              the user to compose one), so check-no-freeform counts it as a
              free-text SITE without it entering the violation ratchet.

              `disabled` is hoisted to the CONDITION rather than sat on the
              <Input>, on its own merits: the search effect early-returns while
              `disabled`, so an `error` set before the caller disabled the picker
              PERSISTS, and with `disabled` on the element the hatch would still
              render — an inert box that looks like an option is worse than no
              box. Hoisting removes the affordance outright, which is what a
              caller who disabled the control asked for. Pinned by a spec so it
              cannot be "simplified" back. (It also sidestepped an extractor bug
              that #3579 has since fixed; that is history now, not a reason.)

              MEASURED AS `sites=1 violations=0`, matching the Wave-0 escape
              hatches, and that is the ratchet ADJUDICATING it rather than a
              preference. Carrying an `aria-label="Entra object id"` too put it
              in the NAME tier and baselined the file — at which point the
              boy-scout rule blocks every future edit to a component now adopted
              at 18 call sites, with no satisfiable fix short of deleting the
              hatch again. The visible `<Field label>` already names the control,
              and an aria-label would OVERRIDE it rather than merely repeat it —
              a label-in-name smell — so dropping it is an a11y improvement, not
              just a neutral one.

              NOT an `ACCEPTED` candidate, which was this lane's own earlier
              proposal and was wrong: `applyAccepted` keys on the CLASSIFIED map
              and fails an entry whose file has no classified site, so declaring
              a violations=0 hatch there would break the guard rather than
              document the hatch. It is visible as a counted free-text site with
              a placeholder that names what it takes, and that is the whole of
              its ledger entry. */}
          {allowManualEntry && error && !disabled && (
            <Field
              label="Add by identifier"
              hint="Directory search is unavailable. Add by identifier until it is restored — the name resolves on its own once the grants land."
              validationState={manualErr ? 'error' : 'none'}
              validationMessage={manualErr ?? undefined}
            >
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, minWidth: 0 }}>
                <Input
                  value={manual}
                  onChange={(_e, d) => { setManual(d.value); setManualErr(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); manualSubmit(); } }}
                  placeholder="Entra object id"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <Button appearance="secondary" onClick={manualSubmit}>Add</Button>
              </div>
            </Field>
          )}

          {q.trim().length >= 2 && (
            <div className={styles.results}>
              {loading && <Spinner size="tiny" label="Searching Entra…" />}
              {/* A zero-result search is NOT a dead end: the box stays enabled
                  and the copy says what to try. Directory search can also
                  legitimately return nothing for reasons that are not the
                  operator's fault (scoped Graph consent, a guest-only match),
                  so it must never read as "you typed it wrong". */}
              {!loading && !error && hits.length === 0 && (
                <div className={styles.empty}>
                  No {kinds.map(kindLabel).join(' / ')} matched “{q.trim()}”. Try a display name, UPN or mail
                  address — search is a prefix/token match, not a substring one.
                </div>
              )}
              {!loading && hits.map((h) => {
                const isGroup = h.type === 'group';
                const members = expanded[h.id];
                const isSelected = selected?.id === h.id || (hasStored && storedValue === h.id);
                return (
                  <div key={h.id}>
                    <div
                      className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => pick(h)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(h); } }}
                    >
                      <div className={styles.rowMain}>
                        {kindIcon(h.type)}
                        <Persona name={h.displayName} secondaryText={secondary(h)} presence={undefined as any} />
                      </div>
                      <div className={styles.rowActions}>
                        {h.type === 'spn' && h.spnType && <Badge appearance="outline" size="small">{h.spnType}</Badge>}
                        {isGroup && allowGroupExpand && (
                          <Link
                            as="button"
                            onClick={(e) => { e.stopPropagation(); void toggleExpand(h); }}
                            aria-label={members ? 'Collapse members' : 'Expand transitive members'}
                          >
                            {expandingId === h.id
                              ? <Spinner size="tiny" />
                              : members
                                ? <><ChevronDown16Regular /> Members</>
                                : <><ChevronRight16Regular /> Members</>}
                          </Link>
                        )}
                      </div>
                    </div>
                    {isGroup && members && (
                      <div className={styles.nested}>
                        {members.length === 0 && <div className={styles.empty}>No transitive members.</div>}
                        {members.map((m) => (
                          <div
                            key={m.id}
                            className={`${styles.row} ${selected?.id === m.id ? styles.rowSelected : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => pick(m)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }}
                          >
                            <div className={styles.rowMain}>
                              {kindIcon(m.type)}
                              <Persona name={m.displayName} secondaryText={secondary(m)} presence={undefined as any} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default IdentityPicker;
