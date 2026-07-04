'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useConfirm } from '@/lib/components/confirm-dialog';
/**
 * McpCatalogPanel — admin "Deploy from catalog" surface for vetted MCP servers.
 *
 * Mounted inside MCPServersPanel (Copilot & Agents → External MCP Tools). Lets a
 * tenant admin:
 *   • Browse the vetted, gov-safe MCP catalog (GET /api/admin/mcp-catalog) as a
 *     searchable / category- + egress-filterable Tile grid or List (LoomDataTable)
 *   • Deploy a server as an Azure Container App (POST .../deploy) — choosing from
 *     a dropdown (no free-form image strings), with an egress warning + optional
 *     Key Vault secret name for secret-gated servers
 *   • See live deployment status of each deployed server (GET .../status)
 *   • Tear a deployment down (DELETE .../delete)
 *
 * Honest gate: when the Container Apps platform isn't wired the catalog still
 * renders but Deploy is disabled and a MessageBar names the missing env var.
 * Fluent v9 + Loom tokens; reuses the shared Section/Toolbar/ViewToggle/
 * TileGrid/ItemTile/LoomDataTable primitives so it matches every other Loom
 * collection surface. No JSON config.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field, Input, Spinner, Badge, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Caption1, Body2, Body1Strong, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowClockwise20Regular, CloudArrowUp20Regular,
  Filter20Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { LoomDataTable } from '@/lib/components/ui/loom-data-table';
import type { McpServerConfigDoc } from '@/lib/types/mcp-config';

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  image: string;
  license: string;
  maintainer: string;
  category: string;
  egress: 'air-gap-safe' | 'azure-internal' | 'external-saas';
  port: number;
  needsStorage: boolean;
  secretEnv?: string;
  govSafe?: boolean;
  airGapSafe?: boolean;
  defaultRecommended?: boolean;
  externalHosts?: string[];
  preview?: boolean;
}

interface DeployStatus {
  name: string;
  provisioningState: string;
  runningStatus?: string;
  fqdn?: string;
}

const EGRESS_LABEL: Record<CatalogEntry['egress'], string> = {
  'air-gap-safe': 'Air-gap safe',
  'azure-internal': 'Azure-internal',
  'external-saas': 'External SaaS',
};

const useStyles = makeStyles({
  hint: { color: tokens.colorNeutralForeground3 },
  intro: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  cellStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' },
  badgeRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  filterSelect: { minWidth: '160px' },
  gateVars: { marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200 },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  dialogGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXXL,
    minHeight: '180px',
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  emptyIcon: { fontSize: '32px', color: tokens.colorNeutralForeground4 },
  countPill: { color: tokens.colorNeutralForeground3 },
});

function egressBadge(egress: CatalogEntry['egress']) {
  if (egress === 'air-gap-safe') return <Badge appearance="tint" color="success" size="small">{EGRESS_LABEL[egress]}</Badge>;
  if (egress === 'azure-internal') return <Badge appearance="tint" color="brand" size="small">{EGRESS_LABEL[egress]}</Badge>;
  return <Badge appearance="tint" color="warning" size="small">{EGRESS_LABEL[egress]}</Badge>;
}

function provBadge(state?: string) {
  const v = (state || '').toLowerCase();
  if (v === 'succeeded') return <Badge appearance="outline" color="success" size="small">Succeeded</Badge>;
  if (v === 'failed' || v === 'canceled') return <Badge appearance="outline" color="danger" size="small">{state}</Badge>;
  if (!state) return <Badge appearance="outline" color="subtle" size="small">—</Badge>;
  return <Badge appearance="outline" color="warning" size="small">{state}</Badge>;
}

export function McpCatalogPanel({
  onChanged,
}: {
  /** Bump this whenever the parent reloads so the panel re-syncs its deployed list. */
  onChanged: () => void;
}) {
  const s = useStyles();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [deployed, setDeployed] = useState<McpServerConfigDoc[]>([]);
  const [deployConfigured, setDeployConfigured] = useState(false);
  const [gate, setGate] = useState<{ missing: string[]; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Catalog browse controls
  const [view, setView] = useState<LoomView>('tile');
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [egressFilter, setEgressFilter] = useState<string>('all');

  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [deployName, setDeployName] = useState('');
  const [secretName, setSecretName] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const [statuses, setStatuses] = useState<Record<string, DeployStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await clientFetch('/api/admin/mcp-catalog');
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setCatalog(Array.isArray(j.catalog) ? j.catalog : []);
      setDeployed(Array.isArray(j.deployed) ? j.deployed : []);
      setDeployConfigured(!!j.deployConfigured);
      setGate(j.gate || null);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const deployedServers = deployed.filter((sv) => sv.deployment);

  // Distinct categories for the filter dropdown.
  const categories = useMemo(
    () => Array.from(new Set(catalog.map((c) => c.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [catalog],
  );

  // Apply search + category + egress filters to the catalog.
  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalog.filter((e) => {
      if (categoryFilter !== 'all' && e.category !== categoryFilter) return false;
      if (egressFilter !== 'all' && e.egress !== egressFilter) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.maintainer.toLowerCase().includes(q)
      );
    });
  }, [catalog, query, categoryFilter, egressFilter]);

  const openDeploy = (entry: CatalogEntry) => {
    setSelected(entry);
    setDeployName('');
    setSecretName('');
    setDeployError(null);
  };

  const doDeploy = useCallback(async () => {
    if (!selected) return;
    setDeploying(true); setDeployError(null);
    try {
      const r = await clientFetch('/api/admin/mcp-catalog/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          catalogId: selected.id,
          name: deployName.trim() || undefined,
          keyVaultSecretName: secretName.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setDeployError(j.gate ? j.gate.message : (j.error || `HTTP ${r.status}`));
        return;
      }
      setSelected(null);
      onChanged();
      void load();
    } catch (e: any) {
      setDeployError(e?.message || String(e));
    } finally { setDeploying(false); }
  }, [selected, deployName, secretName, onChanged, load]);

  const refreshStatus = useCallback(async (server: McpServerConfigDoc) => {
    setBusyId(server.serverId);
    try {
      const r = await clientFetch(`/api/admin/mcp-catalog/status?id=${encodeURIComponent(server.serverId)}`);
      const j = await r.json();
      if (j.ok && j.status) {
        setStatuses((prev) => ({ ...prev, [server.serverId]: j.status }));
      }
    } catch { /* surfaced via stored snapshot below */ } finally { setBusyId(null); }
  }, []);

  const teardown = useCallback(async (server: McpServerConfigDoc) => {
    if (!(await confirm({
      title: `Delete "${server.name}"?`,
      body: 'This removes the deployed Azure Container App. This cannot be undone.',
      danger: true,
      confirmLabel: 'Delete server',
    }))) return;
    setBusyId(server.serverId);
    try {
      const r = await clientFetch(`/api/admin/mcp-catalog/delete?id=${encodeURIComponent(server.serverId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { alert(`Delete failed: ${j.gate ? j.gate.message : (j.error || `HTTP ${r.status}`)}`); return; }
      onChanged();
      void load();
    } catch (e: any) {
      alert(`Delete failed: ${e?.message || e}`);
    } finally { setBusyId(null); }
  }, [onChanged, load]);

  // A reusable Deploy button (used by both tile + list catalog views).
  const deployButton = (entry: CatalogEntry) => {
    const btn = (
      <Button
        icon={<CloudArrowUp20Regular />}
        size="small"
        appearance="primary"
        disabled={!deployConfigured}
        onClick={(e) => { e.stopPropagation(); openDeploy(entry); }}
      >Deploy</Button>
    );
    if (deployConfigured) return btn;
    return (
      <Tooltip relationship="label" content="Deploy is disabled until the Container Apps platform is configured.">
        <span>{btn}</span>
      </Tooltip>
    );
  };

  if (loading) {
    return (
      <Section title="Deploy MCP servers from the catalog">
        <Spinner label="Loading MCP catalog…" labelPosition="after" />
      </Section>
    );
  }

  return (
    <>
      {confirmDialog}
      {/* Deployed catalog servers — their own Section so they read as a managed list. */}
      {deployedServers.length > 0 && (
        <Section
          title={`Deployed MCP servers (${deployedServers.length})`}
          actions={
            <Button icon={<ArrowClockwise20Regular />} size="small" appearance="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        >
          <LoomDataTable<McpServerConfigDoc>
            ariaLabel="Deployed MCP servers"
            getRowId={(r) => r.serverId}
            rows={deployedServers}
            empty="No MCP servers deployed yet."
            columns={[
              {
                key: 'name', label: 'Deployed server', width: 260,
                getValue: (r) => r.name,
                render: (r) => (
                  <div className={s.cellStack}>
                    <Body1Strong className={s.ellipsis} title={r.name}>{r.name}</Body1Strong>
                    <Caption1 className={mergeClasses(s.hint, s.ellipsis)} title={r.deployment?.image}>{r.deployment?.image}</Caption1>
                  </div>
                ),
              },
              {
                key: 'containerApp', label: 'Container App', width: 220,
                getValue: (r) => r.deployment?.containerAppName || '',
                render: (r) => <Caption1 className={s.ellipsis} title={r.deployment?.containerAppName}>{r.deployment?.containerAppName}</Caption1>,
              },
              {
                key: 'state', label: 'State', width: 160,
                getValue: (r) => statuses[r.serverId]?.provisioningState || r.deployment?.provisioningState || '',
                render: (r) => {
                  const live = statuses[r.serverId];
                  const state = live?.provisioningState || r.deployment?.provisioningState;
                  const running = live?.runningStatus || r.deployment?.runningStatus;
                  return (
                    <div className={s.cellStack}>
                      {provBadge(state)}
                      {running && <Caption1 className={s.hint}>{running}</Caption1>}
                    </div>
                  );
                },
              },
              {
                key: 'actions', label: 'Actions', width: 180, sortable: false, filterable: false,
                render: (r) => (
                  <div className={s.actions}>
                    <Button
                      icon={<ArrowClockwise20Regular />}
                      size="small"
                      onClick={(e) => { e.stopPropagation(); void refreshStatus(r); }}
                      disabled={busyId === r.serverId}
                    >Status</Button>
                    <Button
                      icon={<Delete20Regular />}
                      size="small"
                      onClick={(e) => { e.stopPropagation(); void teardown(r); }}
                      disabled={busyId === r.serverId}
                    >Delete</Button>
                  </div>
                ),
              },
            ]}
          />
        </Section>
      )}

      {/* Catalog */}
      <Section
        title="Deploy MCP servers from the catalog"
        actions={
          <div className={s.badgeRow}>
            <Caption1 className={s.countPill}>
              {filteredCatalog.length === catalog.length
                ? `${catalog.length} server${catalog.length === 1 ? '' : 's'}`
                : `${filteredCatalog.length} of ${catalog.length}`}
            </Caption1>
            <ViewToggle value={view} onChange={setView} ariaLabel="Switch catalog view" />
          </div>
        }
      >
        <div className={s.intro}>
          <Body2 className={s.hint}>
            Stand up a vetted, gov-safe MCP server as an Azure Container App. Servers are chosen from the
            curated allow-list below (no arbitrary images). Air-gap-safe servers make zero external calls.
          </Body2>
        </div>

        {loadError && (
          <MessageBar intent="error">
            <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{loadError}</MessageBarBody>
            <MessageBarActions><Button size="small" onClick={() => void load()}>Retry</Button></MessageBarActions>
          </MessageBar>
        )}

        {!deployConfigured && gate && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Deploy not configured</MessageBarTitle>
              {gate.message}
              {gate.missing.length > 0 && (
                <div className={s.gateVars}>
                  Set{' '}
                  {gate.missing.map((v, i) => (
                    <span key={v}>
                      {i > 0 ? ', ' : ''}<code className={s.code}>{v}</code>
                    </span>
                  ))}{' '}
                  on the loom-console container app.
                </div>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Filter bar: search + category + egress filters. */}
        <Toolbar
          search={query}
          onSearch={setQuery}
          searchPlaceholder="Search by name, description, category, or maintainer"
          actions={
            <>
              <Field label="Category" orientation="horizontal">
                <Dropdown
                  className={s.filterSelect}
                  size="small"
                  value={categoryFilter === 'all' ? 'All categories' : categoryFilter}
                  selectedOptions={[categoryFilter]}
                  onOptionSelect={(_e, d) => setCategoryFilter(d.optionValue || 'all')}
                  aria-label="Filter by category"
                >
                  <Option value="all">All categories</Option>
                  {categories.map((c) => (
                    <Option key={c} value={c}>{c}</Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Egress" orientation="horizontal">
                <Dropdown
                  className={s.filterSelect}
                  size="small"
                  value={egressFilter === 'all' ? 'All' : EGRESS_LABEL[egressFilter as CatalogEntry['egress']]}
                  selectedOptions={[egressFilter]}
                  onOptionSelect={(_e, d) => setEgressFilter(d.optionValue || 'all')}
                  aria-label="Filter by egress posture"
                >
                  <Option value="all">All</Option>
                  <Option value="air-gap-safe">{EGRESS_LABEL['air-gap-safe']}</Option>
                  <Option value="azure-internal">{EGRESS_LABEL['azure-internal']}</Option>
                  <Option value="external-saas">{EGRESS_LABEL['external-saas']}</Option>
                </Dropdown>
              </Field>
            </>
          }
        />

        {catalog.length === 0 ? (
          <div className={s.empty}>
            <CloudArrowUp20Regular className={s.emptyIcon} />
            <Body2>No catalog servers are available in this deployment.</Body2>
            <Caption1>The vetted allow-list ships with Loom; try refreshing.</Caption1>
            <Button icon={<ArrowClockwise20Regular />} size="small" onClick={() => void load()}>Refresh catalog</Button>
          </div>
        ) : filteredCatalog.length === 0 ? (
          <div className={s.empty}>
            <Filter20Regular className={s.emptyIcon} />
            <Body2>No servers match your filters.</Body2>
            <Button
              size="small"
              appearance="secondary"
              onClick={() => { setQuery(''); setCategoryFilter('all'); setEgressFilter('all'); }}
            >Clear filters</Button>
          </div>
        ) : view === 'tile' ? (
          <TileGrid minTileWidth={300}>
            {filteredCatalog.map((entry) => (
              <ItemTile
                key={entry.id}
                type="apim-api"
                title={entry.name}
                subtitle={entry.description}
                meta={
                  <div className={s.badgeRow}>
                    {egressBadge(entry.egress)}
                    <Badge appearance="outline" color="informative" size="small">{entry.category}</Badge>
                  </div>
                }
                badge={
                  <div className={s.badgeRow}>
                    {entry.preview && <Badge appearance="tint" color="informative" size="small">Preview</Badge>}
                    {entry.defaultRecommended && <Badge appearance="tint" color="brand" size="small">Recommended</Badge>}
                  </div>
                }
                footer={
                  <div className={s.badgeRow} style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Caption1 className={mergeClasses(s.hint, s.ellipsis)} title={`${entry.license} · ${entry.maintainer}`}>
                      {entry.license} · {entry.maintainer}
                    </Caption1>
                    {deployButton(entry)}
                  </div>
                }
              />
            ))}
          </TileGrid>
        ) : (
          <LoomDataTable<CatalogEntry>
            ariaLabel="MCP server catalog"
            getRowId={(r) => r.id}
            rows={filteredCatalog}
            empty="No servers match your filters."
            columns={[
              {
                key: 'name', label: 'Server', width: 320,
                getValue: (r) => r.name,
                render: (r) => (
                  <div className={s.cellStack}>
                    <Body1Strong className={s.badgeRow}>
                      <span className={s.ellipsis} title={r.name}>{r.name}</span>
                      {r.preview && <Badge appearance="tint" color="informative" size="small">Preview</Badge>}
                      {r.defaultRecommended && <Badge appearance="tint" color="brand" size="small">Recommended</Badge>}
                    </Body1Strong>
                    <Caption1 className={mergeClasses(s.hint, s.ellipsis)} title={r.description}>{r.description}</Caption1>
                  </div>
                ),
              },
              {
                key: 'category', label: 'Category', width: 160,
                getValue: (r) => r.category,
                filterType: 'select',
                render: (r) => <Caption1>{r.category}</Caption1>,
              },
              {
                key: 'egress', label: 'Egress', width: 150,
                getValue: (r) => EGRESS_LABEL[r.egress],
                filterType: 'select',
                render: (r) => egressBadge(r.egress),
              },
              {
                key: 'license', label: 'License · maintainer', width: 220,
                getValue: (r) => `${r.license} · ${r.maintainer}`,
                render: (r) => <Caption1 className={s.ellipsis} title={`${r.license} · ${r.maintainer}`}>{r.license} · {r.maintainer}</Caption1>,
              },
              {
                key: 'deploy', label: 'Deploy', width: 130, sortable: false, filterable: false,
                render: (r) => deployButton(r),
              },
            ]}
          />
        )}
      </Section>

      {/* Deploy dialog */}
      <Dialog open={!!selected} onOpenChange={(_, d) => { if (!d.open) setSelected(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Deploy {selected?.name}</DialogTitle>
            <DialogContent>
              <div className={s.dialogGrid}>
                <Caption1>{selected?.description}</Caption1>
                {selected && (
                  <div className={s.badgeRow}>
                    {egressBadge(selected.egress)}
                    <Badge appearance="outline" color="informative" size="small">{selected.category}</Badge>
                    <Caption1 className={s.hint}>{selected.license} · {selected.maintainer}</Caption1>
                  </div>
                )}
                {selected?.egress === 'external-saas' && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      This server reaches an external SaaS API
                      {selected.externalHosts && selected.externalHosts.length > 0 && (
                        <> ({selected.externalHosts.join(', ')})</>
                      )}
                      . Ensure your boundary has an approved egress path.
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Name (optional)" hint="Lowercase letters, digits, hyphens; starts with a letter, ≤ 32 chars. Auto-generated if blank.">
                  <Input
                    value={deployName}
                    onChange={(_, d) => setDeployName(d.value)}
                    placeholder={`mcp-${selected?.id || 'server'}`}
                  />
                </Field>
                {selected?.secretEnv && (
                  <Field
                    label="Key Vault secret name"
                    hint={`Resolved into the ${selected.secretEnv} env var via secretRef (read by the MCP UAMI). Leave blank to deploy without it.`}
                  >
                    <Input value={secretName} onChange={(_, d) => setSecretName(d.value)} placeholder="my-secret-name" />
                  </Field>
                )}
                {selected?.needsStorage && (
                  <Caption1 className={s.hint}>
                    Mounts the Loom MCP Azure Files share at /data when LOOM_MCP_STORAGE_NAME is configured.
                  </Caption1>
                )}
                {deployError && (
                  <MessageBar intent="error">
                    <MessageBarBody><MessageBarTitle>Deploy failed</MessageBarTitle>{deployError}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setSelected(null)} disabled={deploying}>Cancel</Button>
              <Button appearance="primary" icon={<Add20Regular />} onClick={() => void doDeploy()} disabled={deploying}>
                {deploying ? 'Deploying…' : 'Deploy'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
