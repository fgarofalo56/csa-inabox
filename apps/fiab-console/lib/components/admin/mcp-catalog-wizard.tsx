'use client';

/**
 * McpCatalogBrowser — the "Browse library" surface for External MCP Tools.
 *
 * Renders the curated MCP_CATALOG as a grid of cards. "Deploy" opens a Fluent
 * wizard that renders ONE control per the entry's configSchema (password Input
 * for secret fields, Dropdown for enums, Switch for bools, Input otherwise — no
 * JSON), then POSTs to /api/admin/mcp-servers/deploy which provisions an internal
 * Azure Container App, writes per-field secrets to Key Vault, and auto-registers
 * the endpoint for Copilot. Honest infra gate (MessageBar) when ACA/KV/CAE isn't
 * wired (e.g. the AKS sovereign boundary).
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Switch, Badge, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, SearchBox, Link,
  Card, CardHeader, Caption1, Body1, Text, makeStyles, mergeClasses, tokens,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import {
  Rocket20Regular, Code24Regular, Grid24Regular, Box24Regular,
  Archive24Regular, Globe24Regular, Delete20Regular, ArrowClockwise20Regular,
  Open16Regular, SearchInfo24Regular,
} from '@fluentui/react-icons';
import {
  MCP_DEPLOY_CATALOG as MCP_CATALOG, entryEgress, reachesExternalSaas, govMetaFor,
  type McpCatalogEntry, type McpDeployConfigField as McpConfigField, type McpEgressProfile,
} from '@/lib/mcp/catalog';
import type { McpServerConfigDoc } from '@/lib/types/mcp-config';

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalM,
  },
  search: { minWidth: '260px', flex: '0 1 320px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, flex: 1 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'background-color, color, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  chipActive: {
    backgroundColor: tokens.colorBrandBackground2,
    borderColor: tokens.colorBrandStroke1,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  count: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalL,
    marginTop: tokens.spacingVerticalS,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-2px)',
    },
  },
  cardDesc: { color: tokens.colorNeutralForeground2, flex: 1, minHeight: '40px' },
  rowActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  cardMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minHeight: '20px',
  },
  cardFoot: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  docsLink: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, fontSize: tokens.fontSizeBase200 },
  spacer: { flex: 1 },
  iconWrap: { color: tokens.colorBrandForeground1, display: 'flex', alignItems: 'center' },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXXL,
    marginTop: tokens.spacingVerticalM,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  emptyIcon: { color: tokens.colorNeutralForeground4 },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM },
  gateDetail: { marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200 },
  gateCommands: {
    marginTop: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase100,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
    maxHeight: '240px',
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: tokens.fontFamilyMonospace,
  },
  previewWrap: { marginTop: tokens.spacingVerticalS, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  saasBar: { marginTop: tokens.spacingVerticalS },
  deployedWrap: { marginTop: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL },
  cellStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

type McpCategory = McpCatalogEntry['category'];

const CATEGORY_GLYPH: Record<McpCategory, ReactNode> = {
  developer: <Code24Regular />,
  observability: <Grid24Regular />,
  data: <Box24Regular />,
  productivity: <Archive24Regular />,
  reference: <Globe24Regular />,
};

function egressBadge(egress: McpEgressProfile) {
  if (egress === 'air-gap-safe') return <Badge appearance="tint" color="success" size="small">Air-gap safe</Badge>;
  if (egress === 'azure-internal') return <Badge appearance="tint" color="brand" size="small">Azure-internal</Badge>;
  return <Badge appearance="tint" color="warning" size="small">External SaaS</Badge>;
}

const MAINTAINER_LABEL: Record<NonNullable<McpCatalogEntry['maintainer']>, string> = {
  anthropic: 'Anthropic',
  microsoft: 'Microsoft',
  vendor: 'Vendor',
  community: 'Community',
};

function maintainerBadge(maintainer?: McpCatalogEntry['maintainer']) {
  if (!maintainer) return null;
  const color = maintainer === 'anthropic' || maintainer === 'microsoft' ? 'brand' : 'informative';
  return <Badge appearance="tint" color={color} size="small">{MAINTAINER_LABEL[maintainer]}</Badge>;
}

function provBadge(state?: string) {
  const v = (state || '').toLowerCase();
  if (v === 'succeeded') return <Badge appearance="outline" color="success" size="small">Succeeded</Badge>;
  if (v === 'failed' || v === 'canceled') return <Badge appearance="outline" color="danger" size="small">{state}</Badge>;
  if (!state) return <Badge appearance="outline" color="subtle" size="small">—</Badge>;
  return <Badge appearance="outline" color="warning" size="small">{state}</Badge>;
}

const CATEGORY_LABEL: Record<McpCategory, string> = {
  developer: 'Developer',
  observability: 'Observability',
  data: 'Data',
  productivity: 'Productivity',
  reference: 'Reference',
};

interface DeployGate {
  message: string;
  missing?: string;
  boundary?: string;
  deployModule?: string;
  commands?: string[];
}

function fieldDefault(f: McpConfigField): string {
  return f.default ?? (f.type === 'bool' ? 'false' : '');
}

function DeployWizard({
  entry,
  onClose,
  onDeployed,
}: {
  entry: McpCatalogEntry;
  onClose: () => void;
  onDeployed: (server: McpServerConfigDoc) => void;
}) {
  const s = useStyles();
  const [name, setName] = useState(entry.name);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of entry.configSchema) init[f.key] = fieldDefault(f);
    return init;
  });
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<DeployGate | null>(null);

  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const missingRequired = entry.configSchema
    .filter((f) => f.required)
    .some((f) => !values[f.key] || values[f.key].trim() === '');

  const deploy = useCallback(async () => {
    setDeploying(true); setError(null); setGate(null);
    try {
      const r = await fetch('/api/admin/mcp-servers/deploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalogId: entry.id, name, values }),
      });
      const j = await r.json();
      if (r.status === 503 && j.gate) { setGate(j.gate); return; }
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      onDeployed(j.server);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setDeploying(false); }
  }, [entry.id, name, values, onDeployed]);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Deploy {entry.name}</DialogTitle>
          <DialogContent>
            <Body1>{entry.description}</Body1>
            <div className={s.previewWrap}>
              {egressBadge(entryEgress(entry))}
              {maintainerBadge(entry.maintainer)}
              {entry.license && <Badge appearance="outline" size="small">{entry.license}</Badge>}
              {entry.preview && <Badge appearance="tint" color="warning" size="small">Preview</Badge>}
            </div>
            {reachesExternalSaas(entry) && (
              <MessageBar intent="warning" className={s.saasBar}>
                <MessageBarBody>
                  <MessageBarTitle>Reaches an external SaaS API</MessageBarTitle>
                  This server makes outbound calls to {(entry.externalHosts || []).join(', ') || 'an external host'}.
                  On a US-Gov boundary (GCC / GCC-High / IL5) ensure an approved egress path or proxy is in place
                  before deploying.
                </MessageBarBody>
              </MessageBar>
            )}
            <div className={s.form}>
              <Field label="Display name" hint="Shown in the External MCP Tools list and in Copilot.">
                <Input value={name} onChange={(_, d) => setName(d.value)} />
              </Field>

              {entry.configSchema.map((f) => {
                if (f.type === 'bool') {
                  return (
                    <Field key={f.key} label={f.label} hint={f.help}>
                      <Switch
                        checked={values[f.key] === 'true'}
                        onChange={(_, d) => set(f.key, d.checked ? 'true' : 'false')}
                      />
                    </Field>
                  );
                }
                if (f.type === 'enum' && f.options) {
                  return (
                    <Field key={f.key} label={f.label} hint={f.help} required={f.required}>
                      <Dropdown
                        value={values[f.key] || ''}
                        selectedOptions={[values[f.key] || '']}
                        onOptionSelect={(_, d) => set(f.key, d.optionValue || '')}
                      >
                        {f.options.map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  );
                }
                return (
                  <Field key={f.key} label={f.label} hint={f.help} required={f.required}>
                    <Input
                      value={values[f.key] || ''}
                      type={f.secret ? 'password' : (f.type === 'number' ? 'number' : 'text')}
                      onChange={(_, d) => set(f.key, d.value)}
                      contentAfter={f.secret ? <Badge size="small" appearance="tint" color="brand">Key Vault</Badge> : undefined}
                    />
                  </Field>
                );
              })}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Deploy failed</MessageBarTitle>{error}</MessageBarBody>
                </MessageBar>
              )}
              {gate && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Infrastructure not wired ({gate.boundary})</MessageBarTitle>
                    {gate.message}
                    {gate.missing && <div className={s.gateDetail}>Set/grant: <code>{gate.missing}</code></div>}
                    {gate.deployModule && <div className={s.gateDetail}>Bicep: <code>{gate.deployModule}</code></div>}
                    {gate.commands && gate.commands.length > 0 && (
                      <pre className={s.gateCommands}>
                        {gate.commands.join('\n')}
                      </pre>
                    )}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={deploying}>Cancel</Button>
            <Button
              appearance="primary"
              icon={deploying ? <Spinner size="tiny" /> : <Rocket20Regular />}
              disabled={deploying || missingRequired}
              onClick={() => void deploy()}
            >
              {deploying ? 'Deploying…' : 'Deploy & register'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface LiveStatus {
  provisioningState: string;
  runningStatus?: string;
  fqdn?: string;
}

/** Live status + teardown table for catalog-deployed servers (source==='catalog'). */
function DeployedServers({
  servers,
  onChanged,
}: {
  servers: McpServerConfigDoc[];
  onChanged: () => void;
}) {
  const s = useStyles();
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: 'name' | 'app' | 'state'; dir: 'ascending' | 'descending' }>({ column: 'name', dir: 'ascending' });

  const deployed = useMemo(
    () => servers.filter((sv) => sv.source === 'catalog' && sv.deployment?.containerAppName),
    [servers],
  );
  const sortedDeployed = useMemo(() => {
    const dirMul = sort.dir === 'ascending' ? 1 : -1;
    const keyFor = (sv: McpServerConfigDoc) =>
      sort.column === 'name' ? sv.name
        : sort.column === 'app' ? (sv.deployment?.containerAppName || '')
        : (statuses[sv.serverId]?.provisioningState || sv.deployment?.provisioningState || '');
    return [...deployed].sort((a, b) =>
      keyFor(a).localeCompare(keyFor(b), undefined, { sensitivity: 'base' }) * dirMul,
    );
  }, [deployed, sort, statuses]);
  const toggleSort = (column: 'name' | 'app' | 'state') =>
    setSort((prev) =>
      prev.column === column
        ? { column, dir: prev.dir === 'ascending' ? 'descending' : 'ascending' }
        : { column, dir: 'ascending' });

  if (deployed.length === 0) return null;

  const refresh = async (server: McpServerConfigDoc) => {
    setBusyId(server.serverId);
    try {
      const r = await fetch(`/api/admin/mcp-servers/deployed/status?id=${encodeURIComponent(server.serverId)}`);
      const j = await r.json();
      if (j.ok && j.status) setStatuses((p) => ({ ...p, [server.serverId]: j.status }));
    } catch { /* surfaced via the stored snapshot below */ } finally { setBusyId(null); }
  };

  const teardown = async (server: McpServerConfigDoc) => {
    if (!confirm(`Delete the deployed MCP server "${server.name}"? This removes the Azure Container App and its Key Vault secrets.`)) return;
    setBusyId(server.serverId);
    try {
      const r = await fetch(`/api/admin/mcp-servers/deployed/teardown?id=${encodeURIComponent(server.serverId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { alert(`Delete failed: ${j.error || `HTTP ${r.status}`}`); return; }
      onChanged();
    } catch (e: any) {
      alert(`Delete failed: ${e?.message || e}`);
    } finally { setBusyId(null); }
  };

  return (
    <div className={s.deployedWrap}>
      <Text weight="semibold">Deployed from library</Text>
      <Table aria-label="Deployed catalog MCP servers" style={{ marginTop: tokens.spacingVerticalS }}>
        <TableHeader>
          <TableRow>
            <TableHeaderCell
              sortable
              sortDirection={sort.column === 'name' ? sort.dir : undefined}
              onClick={() => toggleSort('name')}
            >Server</TableHeaderCell>
            <TableHeaderCell
              sortable
              sortDirection={sort.column === 'app' ? sort.dir : undefined}
              onClick={() => toggleSort('app')}
            >Container App</TableHeaderCell>
            <TableHeaderCell
              sortable
              sortDirection={sort.column === 'state' ? sort.dir : undefined}
              onClick={() => toggleSort('state')}
            >State</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedDeployed.map((server) => {
            const live = statuses[server.serverId];
            const state = live?.provisioningState || server.deployment?.provisioningState;
            const running = live?.runningStatus || server.deployment?.runningStatus;
            return (
              <TableRow key={server.serverId}>
                <TableCell>
                  <div className={s.cellStack}>
                    <Text weight="semibold">{server.name}</Text>
                    <Caption1>{server.deployment?.image}</Caption1>
                  </div>
                </TableCell>
                <TableCell><Caption1>{server.deployment?.containerAppName}</Caption1></TableCell>
                <TableCell>
                  {provBadge(state)}
                  {running && <div><Caption1>{running}</Caption1></div>}
                </TableCell>
                <TableCell>
                  <div className={s.rowActions}>
                    <Button icon={<ArrowClockwise20Regular />} size="small" disabled={busyId === server.serverId} onClick={() => void refresh(server)}>Status</Button>
                    <Button icon={<Delete20Regular />} size="small" disabled={busyId === server.serverId} onClick={() => void teardown(server)}>Delete</Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function McpCatalogBrowser({
  onDeployed,
  deployedServers = [],
  onChanged,
}: {
  onDeployed: (server: McpServerConfigDoc) => void;
  /** Catalog-deployed servers (source==='catalog') for the live status/teardown table. */
  deployedServers?: McpServerConfigDoc[];
  /** Called after a teardown so the parent reloads its server list. */
  onChanged?: () => void;
}) {
  const s = useStyles();
  const [selected, setSelected] = useState<McpCatalogEntry | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<McpCategory | null>(null);

  // Categories actually present in the curated catalog (no empty filter chips).
  const categories = useMemo<McpCategory[]>(() => {
    const order: McpCategory[] = ['developer', 'observability', 'data', 'productivity', 'reference'];
    const present = new Set(MCP_CATALOG.map((e) => e.category));
    return order.filter((c) => present.has(c));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MCP_CATALOG.filter((e) => {
      if (category && e.category !== category) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  const resetFilters = useCallback(() => { setQuery(''); setCategory(null); }, []);
  const hasFilters = query.trim() !== '' || category !== null;

  return (
    <div>
      <Body1>
        Browse the curated library of MCP servers. Deploying provisions the server as an internal
        Azure Container App, stores credentials per-field in Key Vault, and registers it for Copilot
        automatically — no further setup.
      </Body1>
      <DeployedServers servers={deployedServers} onChanged={() => onChanged?.()} />

      <div className={s.toolbar}>
        <SearchBox
          className={s.search}
          placeholder="Search servers…"
          value={query}
          aria-label="Search MCP catalog"
          onChange={(_, d) => setQuery(d.value)}
        />
        <div className={s.chips} role="group" aria-label="Filter by category">
          {categories.map((c) => {
            const active = category === c;
            return (
              <span
                key={c}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                className={mergeClasses(s.chip, active && s.chipActive)}
                onClick={() => setCategory(active ? null : c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCategory(active ? null : c); }
                }}
              >
                {CATEGORY_LABEL[c]}
              </span>
            );
          })}
        </div>
      </div>

      <Caption1 className={s.count} aria-live="polite">
        {filtered.length} {filtered.length === 1 ? 'server' : 'servers'}
        {hasFilters ? ` of ${MCP_CATALOG.length}` : ''}
      </Caption1>

      {filtered.length === 0 ? (
        <div className={s.empty}>
          <SearchInfo24Regular className={s.emptyIcon} fontSize={32} />
          <Body1>No servers match your search.</Body1>
          <Caption1>Try a different keyword or clear the filters.</Caption1>
          <Button appearance="secondary" size="small" onClick={resetFilters}>Clear filters</Button>
        </div>
      ) : (
        <div className={s.grid}>
          {filtered.map((entry) => {
            const gov = govMetaFor(entry.id);
            return (
            <Card key={entry.id} className={s.card}>
              <CardHeader
                image={<span className={s.iconWrap}>{CATEGORY_GLYPH[entry.category]}</span>}
                header={<Text weight="semibold">{entry.name}</Text>}
                description={<Caption1>{CATEGORY_LABEL[entry.category]}</Caption1>}
              />
              <Text className={s.cardDesc} size={200}>{entry.description}</Text>
              <div className={s.cardMeta}>
                {egressBadge(entryEgress(entry))}
                {maintainerBadge(entry.maintainer)}
                {entry.preview && <Badge appearance="tint" color="warning" size="small">Preview</Badge>}
                {gov && !gov.airGapSafe && gov.govSafe && (
                  <Badge appearance="outline" color="success" size="small">Gov-safe</Badge>
                )}
                {gov && <Badge appearance="outline" color="informative" size="small">{gov.license}</Badge>}
                {entry.configSchema.some((f) => f.secret) && (
                  <Badge appearance="outline" color="brand" size="small">Key Vault secret</Badge>
                )}
                <Badge appearance="ghost" color="informative" size="small">{entry.transport.toUpperCase()}</Badge>
              </div>
              <div className={s.cardFoot}>
                {entry.docsUrl && (
                  <Link
                    className={s.docsLink}
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    View source <Open16Regular />
                  </Link>
                )}
                <div className={s.spacer} />
                <Button appearance="primary" size="small" icon={<Rocket20Regular />} onClick={() => setSelected(entry)}>
                  Deploy
                </Button>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {selected && (
        <DeployWizard
          entry={selected}
          onClose={() => setSelected(null)}
          onDeployed={(server) => { setSelected(null); onDeployed(server); }}
        />
      )}
    </div>
  );
}
