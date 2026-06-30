'use client';

/**
 * RegisterExistingSourceDialog — the "Add existing (browse subscriptions)" path
 * on /governance/scans. Discovers every Azure resource the signed-in user can
 * already reach (their RBAC + ABAC, across ALL their subscriptions) via the
 * cross-subscription Resource Graph browser (GET /api/azure/connectables), maps
 * each to a Microsoft Purview Data Map source kind, and one-click registers it
 * as a scan source (POST /api/governance/scans/register-existing →
 * registerDataSource(), optional upsertScan()).
 *
 * Ties the strong ARG discovery already wired for /connections to the Purview
 * scanning plane, so an operator doesn't have to hand-type source name + kind +
 * endpoint. Fluent v9 + Loom tokens; a picker, never raw JSON. Real backend or
 * an honest gate (no_access from ARG; unsupported kind for EH/SB/Key Vault;
 * Purview-not-configured) surfaced via MessageBar (no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Dropdown, Option, Badge, Spinner, Caption1, Body1, Checkbox, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, CheckmarkCircle20Filled, ArrowSync16Regular, Search20Regular,
  DatabaseSearch24Regular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { CONN_TYPE_LABEL, CONN_TILE_SLUG, type ConnectableResource } from '@/lib/azure/connectable-types';
import type { ConnectionType } from '@/lib/azure/connections-store';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '620px', maxWidth: '820px' },
  meta: { color: tokens.colorNeutralForeground3 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  search: { flex: 1, minWidth: '220px' },
  statusRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxHeight: '46vh', overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  subHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXXS },
  row: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'background-color, border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, boxShadow: tokens.shadow2 },
  },
  rowIcon: { flexShrink: 0, display: 'inline-flex', fontSize: '20px' },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  rowName: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowSub: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowAction: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalM, textAlign: 'center' },
});

interface ApiResponse {
  ok: boolean;
  resources?: ConnectableResource[];
  via?: string;
  code?: string;
  error?: string;
}

/**
 * Preview of the Purview source kind each connection type maps to (the
 * authoritative mapping lives server-side in purview-source-map.ts). EH / SB /
 * Key Vault are NOT Purview Data Map scannable stores → shown as not-scannable.
 */
const CONN_TYPE_PURVIEW_KIND: Partial<Record<ConnectionType, string>> = {
  'storage-adls': 'AdlsGen2',
  'azure-sql': 'AzureSqlDatabase',
  'generic-sql': 'AzureSqlDatabase',
  'synapse-serverless': 'AzureSynapseWorkspace',
  'synapse-dedicated': 'AzureSynapseWorkspace',
  'cosmos': 'AzureCosmosDb',
  'postgres': 'AzurePostgreSql',
  'adx': 'AzureDataExplorer',
  'databricks-sql': 'AzureDatabricksUnityCatalog',
};

function isScannable(connType: ConnectionType): boolean {
  return !!CONN_TYPE_PURVIEW_KIND[connType];
}

function shortSub(sub: string): string {
  return sub && sub.length > 14 ? `${sub.slice(0, 8)}…${sub.slice(-4)}` : sub || 'unknown';
}

export function RegisterExistingSourceDialog({
  open, onClose, onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  /** Fires after each successful register so the page can reload its sources. */
  onRegistered: () => void;
}) {
  const s = useStyles();
  const [resources, setResources] = useState<ConnectableResource[]>([]);
  const [via, setVia] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [defineScan, setDefineScan] = useState(false);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

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

  useEffect(() => {
    if (open) { setDone({}); setError(null); void load(); }
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

  const registerOne = useCallback(async (r: ConnectableResource) => {
    setBusyId(r.armResourceId); setError(null);
    try {
      const res = await clientFetch('/api/governance/scans/register-existing', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceId: r.armResourceId,
          name: r.name,
          connType: r.connType,
          host: r.host || undefined,
          database: r.database || undefined,
          subscriptionId: r.subscriptionId || undefined,
          resourceGroup: r.resourceGroup || undefined,
          location: r.location || undefined,
          defineScan,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.error || `HTTP ${res.status}`); return; }
      setDone((prev) => ({ ...prev, [r.armResourceId]: true }));
      onRegistered();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }, [defineScan, onRegistered]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span className={s.statusRow}><DatabaseSearch24Regular /> Add existing — browse my subscriptions</span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Body1 className={s.meta}>
                Azure data stores you can already reach with your role assignments (RBAC + ABAC), across every
                subscription you have access to. Register any as a Microsoft Purview Data Map scan source in one
                click — name, kind, and endpoint are mapped for you. Messaging namespaces and Key Vaults aren’t
                Data Map scannable and are shown as such.
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
                  <Badge appearance="tint" color={via === 'user' || via === 'user-arm' ? 'brand' : 'informative'} size="small"
                    title={via.startsWith('user') ? 'Resolved with your Azure RBAC + ABAC' : 'Resolved with the Loom managed identity'}>
                    {via.startsWith('user') ? 'your RBAC' : 'managed identity'}
                  </Badge>
                )}
                {!loading && !gate && !error && (
                  <Caption1 className={s.meta}>
                    {filtered.length} of {resources.length} resource{resources.length === 1 ? '' : 's'} across {grouped.length} subscription{grouped.length === 1 ? '' : 's'}
                  </Caption1>
                )}
                <div style={{ flex: 1 }} />
                <Checkbox
                  label="Define + run a scan after register"
                  checked={defineScan}
                  onChange={(_, d) => setDefineScan(!!d.checked)}
                />
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
                    <MessageBarTitle>Could not list / register</MessageBarTitle>
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
                        const isDone = !!done[r.armResourceId];
                        const scannable = isScannable(r.connType);
                        const kind = CONN_TYPE_PURVIEW_KIND[r.connType];
                        return (
                          <div key={r.armResourceId} className={s.row}>
                            <span className={s.rowIcon} style={{ color: visual.color }}><Icon /></span>
                            <span className={s.rowText}>
                              <span className={s.rowName} title={r.name}>{r.name}</span>
                              <Caption1 className={s.rowSub} title={`${r.host || ''} · ${r.resourceGroup} · ${r.location || ''}`}>
                                {CONN_TYPE_LABEL[r.connType] || r.connType}
                                {kind ? ` → ${kind}` : ''}
                                {r.host ? ` · ${r.host}` : ''}
                              </Caption1>
                            </span>
                            <span className={s.rowAction}>
                              {isDone ? (
                                <Badge appearance="tint" color="success" size="medium" icon={<CheckmarkCircle20Filled />}>Registered</Badge>
                              ) : scannable ? (
                                <Button
                                  size="small" appearance="primary" icon={<Add20Regular />}
                                  disabled={busyId === r.armResourceId}
                                  onClick={() => registerOne(r)}
                                >
                                  {busyId === r.armResourceId ? 'Registering…' : 'Register'}
                                </Button>
                              ) : (
                                <Badge appearance="outline" size="small" color="subtle" title="Not a Purview Data Map scannable store">
                                  Not scannable
                                </Badge>
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
