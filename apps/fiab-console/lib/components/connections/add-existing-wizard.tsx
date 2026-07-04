'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AddExistingConnectionWizard — discover + one-click import any Azure resource
 * the signed-in user can already reach (their RBAC + ABAC, across ALL their
 * subscriptions) as a Key Vault-backed Loom Connection.
 *
 * Backed by GET /api/azure/connectables (Azure Resource Graph queried with the
 * user's delegated token, UAMI fallback). Results are grouped by subscription,
 * decorated with the same item-type-visual icons the rest of Loom uses, and
 * filterable by type + free-text. "Add" opens an inline auth-method selector;
 * for methods that require a secret (sql-password, connection-string, account-key,
 * service-principal) a secret input is revealed before the POST. The POST +
 * `createConnection()` write the secret to Key Vault when `authNeedsSecret()`
 * is true. If Key Vault is not configured, the route returns an honest gate that
 * is surfaced here via MessageBar (no-vaporware.md). Fluent v9 + Loom tokens;
 * a picker/wizard, never raw JSON (loom-no-freeform-config.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Dropdown, Option, Badge, Spinner, Caption1, Body1, Label,
  MessageBar, MessageBarBody, MessageBarTitle, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, CheckmarkCircle20Filled, ArrowSync16Regular, Search20Regular,
  PlugConnected24Regular, ChevronDown20Regular, ChevronUp20Regular, Eye20Regular, EyeOff20Regular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import {
  CONN_TYPE_LABEL, CONN_TILE_SLUG, CONN_TYPE_AUTH_OPTIONS, AUTH_METHOD_LABEL,
  type ConnectableResource,
} from '@/lib/azure/connectable-types';
import { type AuthMethod } from '@/lib/azure/connections-store';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '620px', maxWidth: '800px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  search: { flex: 1, minWidth: '220px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxHeight: '46vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  subHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXXS },
  row: {
    display: 'flex', flexDirection: 'column',
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'background-color, border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      boxShadow: tokens.shadow2,
    },
  },
  rowMain: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  rowIcon: { flexShrink: 0, display: 'inline-flex', fontSize: '20px' },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  rowName: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowAction: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  authPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  authRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  secretRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  secretInput: { flex: 1, minWidth: '200px' },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalM, textAlign: 'center' },
});

interface ApiResponse {
  ok: boolean;
  resources?: ConnectableResource[];
  via?: 'user' | 'uami';
  code?: string;
  error?: string;
}

/** Per-resource import state: chosen auth method + secret value + visibility toggle. */
interface ImportState {
  authMethod: AuthMethod;
  secret: string;
  secretVisible: boolean;
  /** Extra field for sql-password: username. */
  username: string;
}

function shortSub(sub: string): string {
  return sub && sub.length > 14 ? `${sub.slice(0, 8)}…${sub.slice(-4)}` : sub || 'unknown';
}

/** Returns true for auth methods that require a secret written to Key Vault. */
function methodNeedsSecret(m: AuthMethod): boolean {
  return m === 'sql-password' || m === 'connection-string' || m === 'account-key' || m === 'service-principal';
}

/** Secret placeholder text per method, so the user knows what to paste. */
function secretPlaceholder(m: AuthMethod): string {
  switch (m) {
    case 'sql-password':     return 'Password';
    case 'connection-string': return 'Connection string (e.g. Server=...;Database=...;Password=...)';
    case 'account-key':      return 'Storage account key (base64)';
    case 'service-principal': return 'Client secret';
    default:                 return 'Secret';
  }
}

export function AddExistingConnectionWizard({
  open, onClose, onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Fires after each successful import so the page can refresh its list. */
  onImported: () => void;
}) {
  const s = useStyles();
  const [resources, setResources] = useState<ConnectableResource[]>([]);
  const [via, setVia] = useState<'user' | 'uami' | null>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<string | null>(null);
  /** Which resource's auth panel is expanded (one at a time). */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Per-resource import state (auth method / secret / username). */
  const [importState, setImportState] = useState<Record<string, ImportState>>({});

  const load = useCallback(async () => {
    setLoading(true); setGate(null); setError(null);
    try {
      const res = await clientFetch('/api/azure/connectables');
      const j: ApiResponse = await res.json();
      if (j.ok && Array.isArray(j.resources)) {
        setResources(j.resources);
        setVia(j.via ?? null);
      } else if (j.code === 'no_access') {
        setResources([]);
        setGate(j.error || 'No access to Azure resources.');
      } else {
        setResources([]);
        setError(j.error || `Request failed (HTTP ${res.status}).`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load whenever the dialog opens; reset transient state on close.
  useEffect(() => {
    if (open) { setAdded({}); setExpandedId(null); setImportState({}); void load(); }
  }, [open, load]);

  /** Get (or lazily initialise) the import state for a resource. */
  function getState(r: ConnectableResource): ImportState {
    return importState[r.armResourceId] ?? {
      authMethod: r.suggestedAuth,
      secret: '',
      secretVisible: false,
      username: '',
    };
  }

  function patchState(id: string, patch: Partial<ImportState>) {
    setImportState((prev) => ({
      ...prev,
      [id]: { ...getStateById(id, prev), ...patch },
    }));
  }

  /** Read state by id, falling back to default derived from the resource list. */
  function getStateById(id: string, map: Record<string, ImportState>): ImportState {
    if (map[id]) return map[id];
    const r = resources.find((x) => x.armResourceId === id);
    return {
      authMethod: r?.suggestedAuth ?? 'entra-mi',
      secret: '',
      secretVisible: false,
      username: '',
    };
  }

  const typesPresent = useMemo(() => {
    const set = new Set(resources.map((r) => r.connType));
    return Array.from(set).sort();
  }, [resources]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return resources.filter((r) => {
      if (typeFilter !== 'all' && r.connType !== typeFilter) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.host || '').toLowerCase().includes(q) ||
        (r.resourceGroup || '').toLowerCase().includes(q) ||
        (r.subscriptionName || '').toLowerCase().includes(q)
      );
    });
  }, [resources, search, typeFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; items: ConnectableResource[] }>();
    for (const r of filtered) {
      const key = r.subscriptionId || 'unknown';
      if (!map.has(key)) map.set(key, { label: r.subscriptionName || shortSub(key), items: [] });
      map.get(key)!.items.push(r);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([sub, v]) => ({ sub, ...v }));
  }, [filtered]);

  const importOne = useCallback(async (r: ConnectableResource) => {
    const st = importState[r.armResourceId] ?? { authMethod: r.suggestedAuth, secret: '', secretVisible: false, username: '' };
    setAdding(r.armResourceId); setError(null);
    try {
      const body: Record<string, unknown> = {
        name: r.name,
        type: r.connType,
        authMethod: st.authMethod,
        host: r.host || undefined,
        database: r.database || undefined,
        armResourceId: r.armResourceId,
        subscriptionId: r.subscriptionId || undefined,
        resourceGroup: r.resourceGroup || undefined,
        location: r.location || undefined,
        origin: 'existing',
      };
      if (methodNeedsSecret(st.authMethod)) {
        body.secret = st.secret;
        if (st.username) body.username = st.username;
      }
      const res = await clientFetch('/api/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.error || `HTTP ${res.status}`); return; }
      setAdded((prev) => ({ ...prev, [r.armResourceId]: true }));
      setExpandedId(null);
      onImported();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setAdding(null);
    }
  }, [importState, onImported]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span className={s.statusRow}><PlugConnected24Regular /> Add existing Azure resource</span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Body1 className={s.meta}>
                Resources you can already reach with your Azure role assignments (RBAC + ABAC),
                across every subscription you have access to. Choose the auth method per resource;
                for methods that require a secret it is written to Key Vault — never stored in
                plaintext.
              </Body1>

              <div className={s.toolbar}>
                <Input
                  className={s.search}
                  value={search}
                  placeholder="Search by name, host, resource group…"
                  contentBefore={<Search20Regular />}
                  onChange={(_, d) => setSearch(d.value)}
                />
                <Dropdown
                  value={typeFilter === 'all' ? 'All types' : (CONN_TYPE_LABEL[typeFilter as keyof typeof CONN_TYPE_LABEL] || typeFilter)}
                  selectedOptions={[typeFilter]}
                  onOptionSelect={(_, d) => setTypeFilter(d.optionValue || 'all')}
                >
                  <Option value="all">All types</Option>
                  {typesPresent.map((t) => (
                    <Option key={t} value={t}>{CONN_TYPE_LABEL[t] || t}</Option>
                  ))}
                </Dropdown>
                <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={loading} onClick={load} aria-label="Refresh resource list" />
              </div>

              <div className={s.statusRow}>
                {loading && <Spinner size="tiny" label="Querying Azure Resource Graph…" />}
                {!loading && via && (
                  <Badge appearance="tint" color={via === 'user' ? 'brand' : 'informative'} size="small"
                    title={via === 'user' ? 'Resolved with your Azure RBAC + ABAC' : 'Resolved with the Loom managed identity'}>
                    {via === 'user' ? 'your RBAC' : 'managed identity'}
                  </Badge>
                )}
                {!loading && !gate && !error && (
                  <Caption1 className={s.meta}>
                    {filtered.length} of {resources.length} resource{resources.length === 1 ? '' : 's'} across {grouped.length} subscription{grouped.length === 1 ? '' : 's'}
                  </Caption1>
                )}
              </div>

              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No Azure resources visible</MessageBarTitle>
                    {gate}
                  </MessageBarBody>
                </MessageBar>
              )}
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not list / import</MessageBarTitle>
                    {error}
                  </MessageBarBody>
                </MessageBar>
              )}

              {!loading && !gate && (
                <div className={s.list}>
                  {filtered.length === 0 && !error && (
                    <div className={s.empty}>No matching resources.</div>
                  )}
                  {grouped.map((g) => (
                    <div key={g.sub} className={s.group}>
                      <div className={s.subHeader}>
                        <Badge appearance="outline" size="small" color="informative">Subscription</Badge>
                        <Caption1 className={s.meta} title={g.sub}>{g.label}</Caption1>
                      </div>
                      <Divider />
                      {g.items.map((r) => {
                        const visual = itemVisual(CONN_TILE_SLUG[r.connType] || r.connType);
                        const Icon = visual.icon;
                        const done = !!added[r.armResourceId];
                        const isExpanded = expandedId === r.armResourceId;
                        const st = getState(r);
                        const authOptions = CONN_TYPE_AUTH_OPTIONS[r.connType] ?? ['entra-mi'];
                        const needsSecret = methodNeedsSecret(st.authMethod);
                        const canSubmit = !needsSecret || st.secret.trim().length > 0;
                        return (
                          <div key={r.armResourceId} className={s.row}>
                            <div className={s.rowMain}>
                              <span className={s.rowIcon} style={{ color: visual.color }}><Icon /></span>
                              <span className={s.rowText}>
                                <span className={s.rowName} title={r.name}>{r.name}</span>
                                <Caption1 className={s.rowSub} title={`${r.host || ''} · ${r.resourceGroup} · ${r.location || ''}`}>
                                  {CONN_TYPE_LABEL[r.connType] || r.connType}
                                  {r.host ? ` · ${r.host}` : ''}
                                  {r.resourceGroup ? ` · ${r.resourceGroup}` : ''}
                                </Caption1>
                              </span>
                              <span className={s.rowAction}>
                                {done ? (
                                  <Badge appearance="tint" color="success" size="medium" icon={<CheckmarkCircle20Filled />}>Added</Badge>
                                ) : (
                                  <>
                                    {/* Expand/collapse the auth panel — or directly import for MI-only types. */}
                                    {authOptions.length > 1 || needsSecret ? (
                                      <Button
                                        size="small"
                                        appearance={isExpanded ? 'outline' : 'primary'}
                                        icon={isExpanded ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
                                        onClick={() => setExpandedId(isExpanded ? null : r.armResourceId)}
                                        aria-expanded={isExpanded}
                                        aria-label={isExpanded ? 'Collapse auth options' : 'Configure and add'}
                                      >
                                        {isExpanded ? 'Cancel' : 'Configure'}
                                      </Button>
                                    ) : (
                                      <Button
                                        size="small" appearance="primary" icon={<Add20Regular />}
                                        disabled={adding === r.armResourceId}
                                        onClick={() => importOne(r)}
                                      >
                                        {adding === r.armResourceId ? 'Adding…' : 'Add'}
                                      </Button>
                                    )}
                                  </>
                                )}
                              </span>
                            </div>

                            {/* Auth method + optional secret panel */}
                            {isExpanded && !done && (
                              <div className={s.authPanel}>
                                <div className={s.authRow}>
                                  <Label htmlFor={`auth-${r.armResourceId}`} style={{ minWidth: '110px', flexShrink: 0 }}>
                                    Auth method
                                  </Label>
                                  <Dropdown
                                    id={`auth-${r.armResourceId}`}
                                    value={AUTH_METHOD_LABEL[st.authMethod] ?? st.authMethod}
                                    selectedOptions={[st.authMethod]}
                                    onOptionSelect={(_, d) => {
                                      patchState(r.armResourceId, {
                                        authMethod: (d.optionValue as AuthMethod) ?? st.authMethod,
                                        secret: '',
                                        username: '',
                                      });
                                    }}
                                    style={{ minWidth: '220px' }}
                                  >
                                    {authOptions.map((m) => (
                                      <Option key={m} value={m}>{AUTH_METHOD_LABEL[m]}</Option>
                                    ))}
                                  </Dropdown>
                                </div>

                                {/* Username field for sql-password */}
                                {st.authMethod === 'sql-password' && (
                                  <div className={s.authRow}>
                                    <Label htmlFor={`user-${r.armResourceId}`} style={{ minWidth: '110px', flexShrink: 0 }}>
                                      Username
                                    </Label>
                                    <Input
                                      id={`user-${r.armResourceId}`}
                                      value={st.username}
                                      placeholder="SQL login or AAD username"
                                      onChange={(_, d) => patchState(r.armResourceId, { username: d.value })}
                                      style={{ minWidth: '220px' }}
                                    />
                                  </div>
                                )}

                                {/* Secret field — only when the chosen method needs one */}
                                {needsSecret && (
                                  <div className={s.authRow}>
                                    <Label htmlFor={`secret-${r.armResourceId}`} style={{ minWidth: '110px', flexShrink: 0 }}>
                                      {st.authMethod === 'sql-password' ? 'Password' : 'Secret'}
                                    </Label>
                                    <div className={s.secretRow} style={{ flex: 1 }}>
                                      <Input
                                        id={`secret-${r.armResourceId}`}
                                        className={s.secretInput}
                                        type={st.secretVisible ? 'text' : 'password'}
                                        value={st.secret}
                                        placeholder={secretPlaceholder(st.authMethod)}
                                        onChange={(_, d) => patchState(r.armResourceId, { secret: d.value })}
                                        required
                                      />
                                      <Button
                                        size="small" appearance="subtle"
                                        icon={st.secretVisible ? <EyeOff20Regular /> : <Eye20Regular />}
                                        onClick={() => patchState(r.armResourceId, { secretVisible: !st.secretVisible })}
                                        aria-label={st.secretVisible ? 'Hide secret' : 'Reveal secret'}
                                      />
                                    </div>
                                  </div>
                                )}

                                {st.authMethod === 'entra-mi' && (
                                  <Caption1 className={s.meta}>
                                    No secret needed — the Loom managed identity authenticates via Entra ID.
                                    Ensure the Loom UAMI has the appropriate RBAC role on this resource.
                                  </Caption1>
                                )}

                                <div className={s.authRow}>
                                  <Button
                                    appearance="primary" icon={<Add20Regular />}
                                    disabled={adding === r.armResourceId || !canSubmit}
                                    onClick={() => importOne(r)}
                                  >
                                    {adding === r.armResourceId ? 'Adding…' : 'Add connection'}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Done</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
