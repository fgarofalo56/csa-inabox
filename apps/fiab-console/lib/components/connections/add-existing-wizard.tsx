'use client';

/**
 * AddExistingConnectionWizard — discover + one-click import any Azure resource
 * the signed-in user can already reach (their RBAC + ABAC, across ALL their
 * subscriptions) as a Key Vault-backed Loom Connection.
 *
 * Backed by GET /api/azure/connectables (Azure Resource Graph queried with the
 * user's delegated token, UAMI fallback). Results are grouped by subscription,
 * decorated with the same item-type-visual icons the rest of Loom uses, and
 * filterable by type + free-text. "Add" POSTs to /api/connections with
 * authMethod='entra-mi' (managed identity — no secret), pinning the ARM
 * resource id + subscription/RG/location as non-secret provenance.
 *
 * Real backend only (no mock list) — when neither the user nor the UAMI path
 * can see anything, the route returns an honest gate and we render the exact
 * one-time admin actions as a warning MessageBar (no-vaporware.md). Fluent v9 +
 * Loom tokens; a picker/wizard, never raw JSON (loom-no-freeform-config.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Dropdown, Option, Badge, Spinner, Caption1, Body1,
  MessageBar, MessageBarBody, MessageBarTitle, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, CheckmarkCircle20Filled, ArrowSync16Regular, Search20Regular,
  PlugConnected24Regular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import {
  CONN_TYPE_LABEL, CONN_TILE_SLUG, type ConnectableResource,
} from '@/lib/azure/connectable-types';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '620px', maxWidth: '780px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  search: { flex: 1, minWidth: '220px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, maxHeight: '46vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  subHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalS },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rowIcon: { flexShrink: 0 },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  rowName: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowAction: { flexShrink: 0 },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalM, textAlign: 'center' },
});

interface ApiResponse {
  ok: boolean;
  resources?: ConnectableResource[];
  via?: 'user' | 'uami';
  code?: string;
  error?: string;
}

function shortSub(sub: string): string {
  return sub && sub.length > 14 ? `${sub.slice(0, 8)}…${sub.slice(-4)}` : sub || 'unknown';
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

  const load = useCallback(async () => {
    setLoading(true); setGate(null); setError(null);
    try {
      const res = await fetch('/api/azure/connectables');
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
    if (open) { setAdded({}); void load(); }
  }, [open, load]);

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
    setAdding(r.armResourceId); setError(null);
    try {
      const res = await fetch('/api/connections', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: r.name,
          type: r.connType,
          authMethod: r.suggestedAuth,
          host: r.host || undefined,
          database: r.database || undefined,
          armResourceId: r.armResourceId,
          subscriptionId: r.subscriptionId || undefined,
          resourceGroup: r.resourceGroup || undefined,
          location: r.location || undefined,
          origin: 'existing',
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.error || `HTTP ${res.status}`); return; }
      setAdded((prev) => ({ ...prev, [r.armResourceId]: true }));
      onImported();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setAdding(null);
    }
  }, [onImported]);

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
                across every subscription you have access to. Importing creates a managed-identity
                connection — no secret is stored.
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
                    <div key={g.sub}>
                      <div className={s.subHeader}>
                        <Badge appearance="outline" size="small" color="informative">Subscription</Badge>
                        <Caption1 className={s.meta} title={g.sub}>{g.label}</Caption1>
                      </div>
                      <Divider />
                      {g.items.map((r) => {
                        const visual = itemVisual(CONN_TILE_SLUG[r.connType] || r.connType);
                        const Icon = visual.icon;
                        const done = !!added[r.armResourceId];
                        return (
                          <div key={r.armResourceId} className={s.row}>
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
                                <Button
                                  size="small" appearance="primary" icon={<Add20Regular />}
                                  disabled={adding === r.armResourceId}
                                  onClick={() => importOne(r)}
                                >
                                  {adding === r.armResourceId ? 'Adding…' : 'Add'}
                                </Button>
                              )}
                            </span>
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
