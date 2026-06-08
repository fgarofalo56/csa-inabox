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
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Input, Field, Tab, TabList, Persona, Spinner, Link, Badge, Button,
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
});

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
  /** Restrict to one principal kind, or 'all' (default) for a tabbed picker. */
  kind?: IdentityKind | 'all';
  /** Called when the user picks a principal. */
  onSelect?: (hit: IdentityHit) => void;
  /** Currently-selected principal (controlled), if any. */
  selected?: IdentityHit | null;
  placeholder?: string;
  disabled?: boolean;
  /** Allow expanding a group to its transitive members. Default true. */
  allowGroupExpand?: boolean;
  /** BFF base, defaults to '/api/governance/identities/search'. */
  apiBase?: string;
  label?: string;
}

export function IdentityPicker({
  kind = 'all',
  onSelect,
  selected = null,
  placeholder,
  disabled = false,
  allowGroupExpand = true,
  apiBase = '/api/governance/identities/search',
  label = 'Search Entra',
}: IdentityPickerProps) {
  const styles = useStyles();
  const tabbed = kind === 'all';
  const [activeKind, setActiveKind] = useState<IdentityKind>(tabbed ? 'user' : (kind as IdentityKind));
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<IdentityHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);

  // Per-group transitive-member expansion state.
  const [expanded, setExpanded] = useState<Record<string, IdentityHit[]>>({});
  const [expandingId, setExpandingId] = useState<string | null>(null);

  const effectiveKind = tabbed ? activeKind : (kind as IdentityKind);

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

  const pick = useCallback((h: IdentityHit) => { onSelect?.(h); }, [onSelect]);

  const placeholderText = useMemo(() => {
    if (placeholder) return placeholder;
    if (effectiveKind === 'group') return 'Group display name';
    if (effectiveKind === 'spn') return 'App / managed-identity name';
    return 'Display name or UPN';
  }, [placeholder, effectiveKind]);

  return (
    <div className={styles.root}>
      {tabbed && (
        <TabList
          selectedValue={activeKind}
          onTabSelect={(_e, d) => { setActiveKind(d.value as IdentityKind); setHits([]); setExpanded({}); }}
          disabled={disabled}
        >
          <Tab value="user" icon={<Person16Regular />}>Users</Tab>
          <Tab value="group" icon={<People16Regular />}>Groups</Tab>
          <Tab value="spn" icon={<Apps16Regular />}>Service principals</Tab>
        </TabList>
      )}

      <Field label={label}>
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
            {error.remediation && <div style={{ marginTop: 4 }}>{error.remediation}</div>}
            {error.hint?.rolesRequired && error.hint.rolesRequired.length > 0 && (
              <div style={{ marginTop: 6 }}>
                Grant the Console UAMI these Microsoft Graph application permissions:
                {error.hint.rolesRequired.map((r) => (
                  <code key={r.appRoleId} className={styles.hintCode}>
                    {r.name} — {r.appRoleId}
                  </code>
                ))}
              </div>
            )}
            {error.hint?.followUp && <div style={{ marginTop: 6 }}>{error.hint.followUp}</div>}
          </MessageBarBody>
          {error.hint?.bicepModule && (
            <MessageBarActions>
              <span className={styles.empty}>{error.hint.bicepModule}</span>
            </MessageBarActions>
          )}
        </MessageBar>
      )}

      {q.trim().length >= 2 && (
        <div className={styles.results}>
          {loading && <Spinner size="tiny" label="Searching Entra…" />}
          {!loading && !error && hits.length === 0 && (
            <div className={styles.empty}>No matches.</div>
          )}
          {!loading && hits.map((h) => {
            const isGroup = h.type === 'group';
            const members = expanded[h.id];
            const isSelected = selected?.id === h.id;
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
    </div>
  );
}

export default IdentityPicker;
