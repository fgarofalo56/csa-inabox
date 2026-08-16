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
import { HonestGate } from '@/lib/components/shared/honest-gate';

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
  /**
   * The chip's inner column. Lives here rather than as an inline style override
   * because web3-ui.md forbids hard-coded spacing and this file already keeps
   * every other layout rule in makeStyles. No `gap` declared at all: the CSS
   * property initialises to `normal`, which computes to zero for a flex
   * container, so the rendering is identical to the literal it replaces.
   *
   * (The first attempt at this comment spelled the offending inline attribute
   * out longhand and check-no-raw-px flagged the COMMENT — its region matcher
   * does not strip comments. Left as a note so the next person does not spend a
   * cycle on it.)
   */
  chipStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    minWidth: 0,
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

/**
 * A NOT-CONFIGURED gate (the deployment has not wired
 * `LOOM_IDENTITY_PICKER_ENABLED`) vs any other failure. Only the former belongs
 * in `HonestGate`, because only the former has a Fix-it the registry can apply.
 */
function isGateError(e: PickerError): boolean {
  return e.message === 'not_configured' || e.hint?.missingEnvVar === 'LOOM_IDENTITY_PICKER_ENABLED';
}

/**
 * A sentence, never a raw code. `admin.permissions::Reader` denials arrive as
 * `{ok:false,error:'forbidden'}` with no hint, and rendering `error.message`
 * verbatim put the literal word "forbidden" in the title where a user expects
 * an explanation.
 */
function humanErrorTitle(e: PickerError): string {
  const m = String(e.message || '');
  if (m === 'forbidden') return 'You do not have permission to search the directory';
  if (m === 'unauthenticated') return 'Your session expired — sign in again to search the directory';
  if (/^graph_40[13]$/.test(m)) return 'The Console identity is not consented to search the directory';
  if (/^graph_\d+$/.test(m)) return `Microsoft Graph returned ${m.slice(6)} — directory search is unavailable`;
  return m || 'Directory search is unavailable';
}

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
   * ESCAPE HATCH — manual object-id entry, revealed BEHIND THE GATE (only once
   * a directory search has actually failed). **Defaults to ON.**
   *
   * It shipped opt-in for one review cycle and that was a G2 defect, because
   * `LOOM_IDENTITY_PICKER_ENABLED` is FALSE on every deploy path today —
   * `main.bicep:134`, `admin-plane/main.bicep:2082`, `commercial.bicepparam`
   * hard-false, `commercial-full` / `tenant-dmlz` via
   * `readEnvironmentVariable(…, 'false')`, and unset (therefore false) in
   * `gcc` / `gcc-high` / `il5`. So `assertEnabled()` throws, the BFF 503s
   * `not_configured`, and an opt-in hatch left TEN adopted surfaces with no way
   * to enter a principal at all — each of which shipped a working `<Input>`
   * before this wave. Flipping the bicep flag is complementary, NOT a
   * substitute: a Graph 403 before admin consent produces the identical state,
   * which this component's own `notConfiguredHint.followUp` says outright.
   *
   * `EntraGroupPicker` already behaves this way (`entra-group-picker.tsx:73-75`
   * lets a pasted GUID stand, commented "the honest-gate fallback"), and the
   * argument this lane used to DECLINE migrating that component — "it would add
   * a day-one gate to a surface that works today" — condemns an opt-in hatch
   * here for exactly the same reason.
   *
   * Pass `allowManualEntry={false}` only where hand-entry is genuinely wrong.
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
  allowManualEntry = true,
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
    setResolving(true); setResolvedHit(null); setResolveNote(null);    (async () => {
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
    // The cleanup MUST release `resolvedFor`, not just the `live` flag. When a
    // dep OTHER than the value changes mid-flight (`apiBase`, `resolveValue`, or
    // any remount — which StrictMode does to every effect on every load, and
    // next.config.mjs enables it) the effect re-runs, hits the
    // `resolvedFor.current === storedValue` early return, and never reaches the
    // `setResolving(false)`. The chip then spins forever. Releasing the guard
    // here lets the re-run own the lookup again.
    return () => { live = false; resolvedFor.current = null; };
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
      // SEED the resolution from the pick. Without this the parent re-renders
      // with the new `value`, the chip paints the raw GUID, and the resolve
      // effect issues a SECOND Graph call for a principal the search just
      // returned — and if that call comes back empty the chip permanently reads
      // "Not resolvable in this directory" about something chosen from that
      // directory two seconds earlier. Seeding also means the happy path never
      // depends on `POST /directoryObjects/getByIds`, an endpoint this tree had
      // not previously called and whose behaviour under the granted consent set
      // is unproven.
      setResolvedHit(h);
      setResolveNote(null);
      setResolving(false);
      resolvedFor.current = h.id;
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
    // Sink chain, so the hatch is never a button that does nothing. A
    // SYNTHESIZED hit always accompanies the id — everything the directory would
    // have told us except the display name, which the surface renders from the
    // id until a later resolve can improve it.
    //
    // The hit is not optional politeness: `onChange(id, hit?)` is emitted with
    // NO hit on exactly one other path — clearing, where the id is `''` — and a
    // caller reading `if (!hit) …` as "cleared" would silently discard a
    // manually entered principal. powerbi-governance did precisely that, and
    // this test suite caught it. Passing a hit whenever an id is SET makes the
    // contract "no hit ⇒ cleared" true by construction for every caller,
    // including the seven this lane does not own.
    const hit: IdentityHit = { id: v, type: effectiveKind, displayName: v };
    if (onManualEntry) onManualEntry(v, effectiveKind);
    else if (onChange) onChange(v, hit);
    else onSelect?.(hit);
  }, [manual, onManualEntry, onChange, onSelect, effectiveKind]);

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
        <div className={styles.chipStack}>
          {resolvedHit ? (
            <Persona
              name={resolvedHit.displayName}
              secondaryText={secondary(resolvedHit)}
              presence={undefined as any}
            />
          ) : (
            <>
              <span className={styles.storedId}>{valueLabel || storedValue}</span>
              {/* Only when the label ADDS something. A caller that stores the id
                  as its own display name (which is what a manually entered
                  principal looks like until the directory can resolve it) would
                  otherwise render the same GUID twice. */}
              {valueLabel && valueLabel !== storedValue && (
                <Caption1 className={styles.storedNote}>{storedValue}</Caption1>
              )}
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

          {/* G2 — the gate goes through the ONE shared renderer, which carries
              the inline Fix-it wizard and the /admin/gates link. This was a bare
              `MessageBar intent="warning"` for one review cycle, which is the
              exact shape #3572 (`f8af76fb`) had just removed from
              AzureResourcePicker one commit before this branch's base, calling
              it "a G2 violation that adoption would have multiplied by 40".
              Adopting the picker eleven more times with the old shape would have
              multiplied it again. */}
          {error && isGateError(error) && (
            <HonestGate
              gateId="identity-picker"
              surface="Directory search"
              missing={error.hint?.missingEnvVar}
              detail={error.remediation || error.hint?.followUp}
            />
          )}

          {/* Everything that is NOT a not-configured gate: a Graph 5xx, a
              network failure, or an AUTHORIZATION denial. The last one has no
              `hint.rolesRequired` in its body, so the raw code — literally the
              string `forbidden` — used to render as the title. It is mapped to
              a sentence instead, and the escape hatch below still gives the
              caller a way through. */}
          {error && !isGateError(error) && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>{humanErrorTitle(error)}</MessageBarTitle>
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
