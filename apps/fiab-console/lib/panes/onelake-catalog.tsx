'use client';

/**
 * OneLakeCatalogPane — Explore + Govern tabs, domain selector, workspace tree,
 * and item list, all driven by REAL backends (no hardcoded constants):
 *
 *   Explore → GET /api/onelake/catalog
 *             - workspace tree built from the live tenant workspace list
 *             - domain selector built from the live governance domain list
 *             - item list + real facet counts from AI Search (default) or the
 *               Cosmos fallback; honest MessageBar gate when AI Search is absent
 *   Govern  → GET /api/onelake/governance
 *             - real % labeled / endorsed / owned + classification + attention
 *
 * Azure-native default per .claude/rules/no-fabric-dependency.md — the backing
 * route never touches a Fabric / OneLake REST host on its default path.
 *
 * Styled to the Loom design bar (Fluent v9 + Loom tokens): Section cards,
 * the shared LoomDataTable (sortable / resizable / filterable, real empty +
 * loading states), a Tile | List view toggle for the item collection, and
 * chip-iconed metric tiles with coverage bars for the Govern insights.
 */

import { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Text, Badge, Button, Dropdown, Option,
  Tab, TabList, Spinner, Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Building20Regular, Database20Regular, Folder20Regular,
  Tag20Regular, Ribbon20Regular, Warning20Regular,
  DismissCircle16Regular, type FluentIcon,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';

interface CatalogItem {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  itemType: string;
  displayName: string;
  owner?: string;
  updatedAt?: string;
  endorsement?: string;
  sensitivity?: string;
  domainId?: string;
  isDiscoverable?: boolean;
}
interface WorkspaceNode { id: string; name: string; domain?: string; }
interface DomainOption { id: string; name: string; }
interface SearchGate { missingEnvVar: string; bicepModule: string; followUp?: string; }
interface PurviewGate { missingEnvVar: string; bicepModule: string; followUp?: string; }
interface AttentionRow {
  id: string; itemType: string; displayName: string;
  workspaceName: string; issues: string[]; href: string;
}
interface GovernPayload {
  ok: boolean;
  totalItems: number;
  labeled: number; endorsed: number; owned: number;
  labeledPct: number; endorsedPct: number; ownedPct: number;
  attentionCount: number;
  classificationTable: Array<{ classification: string; count: number; purviewAssets?: number }>;
  attention: AttentionRow[];
  purviewConfigured: boolean;
  purviewAssetCount: number | null;
  purviewGate?: PurviewGate;
}

const ALL_DOMAINS: DomainOption = { id: '', name: '(All)' };

// Loom accent palette (CSS vars with brand fallbacks) — shared with the other
// admin panes so iconography reads consistently across the console.
const ACCENT = {
  teal: 'var(--loom-accent-teal, #14b8a6)',
  blue: 'var(--loom-accent-blue, #3b82f6)',
  amber: 'var(--loom-accent-amber, #f59e0b)',
  violet: 'var(--loom-accent-violet, #8b5cf6)',
  green: 'var(--loom-accent-green, #22c55e)',
};

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: '260px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  side: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow2,
    padding: tokens.spacingVerticalL,
    position: 'sticky',
    top: tokens.spacingVerticalM,
    maxHeight: 'calc(100vh - 160px)',
    overflow: 'auto',
    minWidth: 0,
  },
  sideHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  treeItemSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  filterBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM,
  },
  filterChip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  // ── metric tiles (Govern) ─────────────────────────────────────────────
  tilesRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2, minWidth: 0,
  },
  tileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  chip: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '36px', height: '36px', borderRadius: tokens.borderRadiusLarge,
  },
  tileVal: {
    fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: 1.1,
    color: tokens.colorNeutralForeground1,
  },
  tileSub: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  bar: {
    height: '6px', backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular, overflow: 'hidden', marginTop: tokens.spacingVerticalXS,
  },
  barFill: { height: '100%', borderRadius: tokens.borderRadiusCircular },
  centered: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXXL },
  muted: { color: tokens.colorNeutralForeground3 },
});

function endorsementBadge(e?: string) {
  if (!e || e === '—') return null;
  return <Badge appearance="tint" size="small" color={e === 'Certified' ? 'success' : 'brand'}>{e}</Badge>;
}
function sensitivityBadge(v?: string) {
  if (!v) return null;
  return <Badge appearance="tint" size="small" color={/highly|restricted|secret/i.test(v) ? 'danger' : 'informative'}>{v}</Badge>;
}
function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
}

// ── Metric tile (chip icon + value + sub + optional coverage bar) ─────────
function GovTile({
  icon: Icon, color, value, label, sub, pct,
}: {
  icon: FluentIcon; color: string; value: string; label: string; sub: string; pct?: number;
}) {
  const s = useStyles();
  return (
    <div className={s.tile}>
      <div className={s.tileHead}>
        <span className={s.chip} style={{ backgroundColor: `${color}1f` }} aria-hidden>
          <Icon style={{ width: 20, height: 20, color }} />
        </span>
        <Text className={s.tileVal}>{value}</Text>
      </div>
      <Text className={s.tileSub} weight="semibold" style={{ color: tokens.colorNeutralForeground1 }}>{label}</Text>
      <Caption1 className={s.tileSub}>{sub}</Caption1>
      {typeof pct === 'number' && (
        <div className={s.bar}>
          <div className={s.barFill} style={{ width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: color }} />
        </div>
      )}
    </div>
  );
}

export function OneLakeCatalogPane() {
  const s = useStyles();
  const router = useRouter();
  const [tab, setTab] = useState('explore');

  // ── Explore state ──────────────────────────────────────────────────────
  const [domainId, setDomainId] = useState(''); // '' = (All)
  const [q, setQ] = useState('');
  const [view, setView] = useState<LoomView>('list');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>([]);
  const [domains, setDomains] = useState<DomainOption[]>([ALL_DOMAINS]);
  const [total, setTotal] = useState(0);
  const [backend, setBackend] = useState<string>('');
  const [selectedWs, setSelectedWs] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchGate, setSearchGate] = useState<SearchGate | null>(null);

  // ── Govern state (lazy) ────────────────────────────────────────────────
  const [govern, setGovern] = useState<GovernPayload | null>(null);
  const [governLoading, setGovernLoading] = useState(false);
  const [governError, setGovernError] = useState<string | null>(null);

  // Explore fetch — debounced on q + domain change.
  useEffect(() => {
    const ctrl = new AbortController();
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (domainId) qs.set('domainId', domainId);
      fetch(`/api/onelake/catalog?${qs.toString()}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => {
          if (!d.ok) { setError(d.error || 'Failed to load catalog'); return; }
          setItems(d.items ?? []);
          setWorkspaces(d.workspaces ?? []);
          setDomains([ALL_DOMAINS, ...((d.domains ?? []) as DomainOption[])]);
          setTotal(d.total ?? 0);
          setBackend(d.backend ?? '');
          setSearchGate(d.searchGate ?? null);
        })
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => setLoading(false));
    }, 300);
    return () => { clearTimeout(handle); ctrl.abort(); };
  }, [q, domainId]);

  // Govern fetch — only when the tab is opened.
  useEffect(() => {
    if (tab !== 'govern' || govern) return;
    setGovernLoading(true);
    setGovernError(null);
    fetch('/api/onelake/governance')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { setGovernError(d.error || 'Failed to load governance insights'); return; }
        setGovern(d);
      })
      .catch((e) => setGovernError(e.message))
      .finally(() => setGovernLoading(false));
  }, [tab, govern]);

  // Workspace tree click filters the visible item list locally (server already
  // returns the tenant-scoped set; this is an in-pane drill-down).
  const visibleItems = useMemo(
    () => (selectedWs ? items.filter((i) => i.workspaceId === selectedWs) : items),
    [items, selectedWs],
  );

  const selectedDomainName = domains.find((d) => d.id === domainId)?.name ?? '(All)';
  const selectedWsName = workspaces.find((w) => w.id === selectedWs)?.name;

  const openItem = (i: CatalogItem) => router.push(`/items/${i.itemType}/${i.id}`);

  // ── Explore: catalog item columns for the shared LoomDataTable ──────────
  const itemColumns = useMemo<LoomColumn<CatalogItem>[]>(() => [
    {
      key: 'displayName', label: 'Name', sortable: true, filterable: true, width: 260,
      getValue: (i) => i.displayName,
      render: (i) => <Text weight="semibold">{i.displayName}</Text>,
    },
    { key: 'itemType', label: 'Type', sortable: true, filterable: true, filterType: 'select', width: 150, getValue: (i) => i.itemType },
    { key: 'owner', label: 'Owner', sortable: true, filterable: true, width: 180, getValue: (i) => i.owner ?? '', render: (i) => i.owner ?? '—' },
    { key: 'updatedAt', label: 'Updated', sortable: true, filterable: true, filterType: 'date', width: 180, getValue: (i) => i.updatedAt ?? '', render: (i) => fmtDate(i.updatedAt) },
    { key: 'workspaceName', label: 'Workspace', sortable: true, filterable: true, filterType: 'select', width: 180, getValue: (i) => i.workspaceName ?? i.workspaceId, render: (i) => i.workspaceName ?? i.workspaceId },
    { key: 'endorsement', label: 'Endorsement', sortable: true, filterable: true, filterType: 'select', width: 150, getValue: (i) => i.endorsement ?? '', render: (i) => endorsementBadge(i.endorsement) ?? <Text className={s.muted}>—</Text> },
    { key: 'sensitivity', label: 'Sensitivity', sortable: true, filterable: true, filterType: 'select', width: 160, getValue: (i) => i.sensitivity ?? '', render: (i) => sensitivityBadge(i.sensitivity) ?? <Text className={s.muted}>—</Text> },
  ], [s.muted]);

  const classColumns = useMemo<LoomColumn<{ classification: string; count: number; purviewAssets?: number }>[]>(() => {
    const cols: LoomColumn<{ classification: string; count: number; purviewAssets?: number }>[] = [
      { key: 'classification', label: 'Classification', sortable: true, filterable: true, getValue: (r) => r.classification, render: (r) => <Text weight="semibold">{r.classification}</Text> },
      { key: 'count', label: 'Items', sortable: true, filterable: false, width: 120, getValue: (r) => r.count },
    ];
    if (govern?.purviewConfigured) {
      cols.push({ key: 'purviewAssets', label: 'Purview assets', sortable: true, filterable: false, width: 160, getValue: (r) => r.purviewAssets ?? 0, render: (r) => String(r.purviewAssets ?? 0) });
    }
    return cols;
  }, [govern?.purviewConfigured]);

  const attentionColumns = useMemo<LoomColumn<AttentionRow>[]>(() => [
    { key: 'displayName', label: 'Item', sortable: true, filterable: true, width: 240, getValue: (a) => a.displayName, render: (a) => <Text weight="semibold">{a.displayName}</Text> },
    { key: 'itemType', label: 'Type', sortable: true, filterable: true, filterType: 'select', width: 150, getValue: (a) => a.itemType },
    { key: 'workspaceName', label: 'Workspace', sortable: true, filterable: true, filterType: 'select', width: 180, getValue: (a) => a.workspaceName },
    {
      key: 'issues', label: 'Issues', sortable: false, filterable: false, width: 280,
      getValue: (a) => a.issues.join(', '),
      render: (a) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS }}>
          {a.issues.map((iss) => (
            <Badge key={iss} appearance="tint" size="small" color="warning">{iss}</Badge>
          ))}
        </span>
      ),
    },
  ], []);

  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)} size="large" style={{ marginBottom: tokens.spacingVerticalL }}>
        <Tab value="explore" icon={<Database20Regular />}>Explore</Tab>
        <Tab value="govern" icon={<Ribbon20Regular />}>Govern</Tab>
      </TabList>

      {tab === 'explore' && (
        <div>
          {searchGate && (
            <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
              <MessageBarBody>
                <MessageBarTitle>Full-text search + facets unavailable</MessageBarTitle>
                Catalog is served from Azure-native Cosmos. Set{' '}
                <code>{searchGate.missingEnvVar}</code> (deploy{' '}
                <code>{searchGate.bicepModule}</code>) to enable AI Search
                full-text search and real facet counts.
              </MessageBarBody>
            </MessageBar>
          )}
          {error && (
            <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}>
              <MessageBarBody><MessageBarTitle>Failed to load catalog</MessageBarTitle>{error}</MessageBarBody>
            </MessageBar>
          )}

          <div className={s.layout}>
            <aside className={s.side}>
              <div className={s.sideHead}>
                <Folder20Regular style={{ color: ACCENT.blue }} />
                <Subtitle2>Workspaces</Subtitle2>
              </div>
              {workspaces.length === 0 && !loading ? (
                <Caption1 className={s.muted} style={{ display: 'block', marginTop: tokens.spacingVerticalS }}>
                  No workspaces in this tenant.
                </Caption1>
              ) : (
                <Tree aria-label="Workspaces tree">
                  {workspaces.map((w) => (
                    <TreeItem
                      key={w.id}
                      itemType="leaf"
                      value={w.id}
                      onClick={() => setSelectedWs(w.id === selectedWs ? null : w.id)}
                    >
                      <TreeItemLayout
                        iconBefore={<Database20Regular style={{ color: w.id === selectedWs ? ACCENT.blue : tokens.colorNeutralForeground3 }} />}
                        className={w.id === selectedWs ? s.treeItemSelected : undefined}
                      >
                        {w.name}
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                </Tree>
              )}
              {selectedWs && (
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<DismissCircle16Regular />}
                  style={{ marginTop: tokens.spacingVerticalM }}
                  onClick={() => setSelectedWs(null)}
                >
                  Clear workspace filter
                </Button>
              )}
            </aside>

            <Section
              title="Catalog items"
              actions={
                <Caption1 className={s.muted}>
                  {selectedWs
                    ? `${visibleItems.length} of ${total} items · ${selectedWsName}`
                    : `${total} items`}
                  {backend ? ` · source: ${backend}` : ''}
                </Caption1>
              }
            >
              <Toolbar
                search={q}
                onSearch={setQ}
                searchPlaceholder="Search items"
                actions={
                  <>
                    {loading && <Spinner size="tiny" />}
                    <ViewToggle value={view} onChange={setView} ariaLabel="Switch catalog item view" />
                  </>
                }
              >
                <span className={s.filterChip}>
                  <Building20Regular className={s.muted} />
                  <Dropdown
                    value={selectedDomainName}
                    selectedOptions={[domainId]}
                    aria-label="Filter by domain"
                    onOptionSelect={(_, d) => setDomainId(d.optionValue ?? '')}
                    style={{ minWidth: 180 }}
                  >
                    {domains.map((d) => <Option key={d.id || 'all'} value={d.id}>{d.name}</Option>)}
                  </Dropdown>
                </span>
              </Toolbar>

              {selectedWs && (
                <Badge
                  appearance="tint" color="brand"
                  style={{ marginBottom: tokens.spacingVerticalM, cursor: 'pointer' }}
                  onClick={() => setSelectedWs(null)}
                >
                  Workspace: {selectedWsName} ✕
                </Badge>
              )}

              {view === 'list' ? (
                <LoomDataTable
                  columns={itemColumns}
                  rows={visibleItems}
                  getRowId={(i) => i.id}
                  loading={loading && items.length === 0}
                  onRowClick={openItem}
                  ariaLabel="Catalog items"
                  empty="No catalog items match the current filters."
                />
              ) : loading && items.length === 0 ? (
                <div className={s.centered}><Spinner label="Loading catalog…" /></div>
              ) : visibleItems.length === 0 ? (
                <Body1 className={s.muted} style={{ display: 'block', padding: tokens.spacingVerticalXL, textAlign: 'center' }}>
                  No catalog items match the current filters.
                </Body1>
              ) : (
                <TileGrid>
                  {visibleItems.map((i) => (
                    <ItemTile
                      key={i.id}
                      type={i.itemType}
                      title={i.displayName}
                      subtitle={i.itemType}
                      meta={`${i.workspaceName ?? i.workspaceId} · ${fmtDate(i.updatedAt)}`}
                      sensitivityLabel={i.sensitivity}
                      badge={endorsementBadge(i.endorsement) ?? undefined}
                      footer={i.owner ? <Caption1 className={s.muted}>{i.owner}</Caption1> : undefined}
                      onClick={() => openItem(i)}
                    />
                  ))}
                </TileGrid>
              )}
            </Section>
          </div>
        </div>
      )}

      {tab === 'govern' && (
        <div>
          {governLoading && <div className={s.centered}><Spinner label="Loading governance insights…" /></div>}
          {governError && (
            <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
              <MessageBarBody><MessageBarTitle>Failed to load governance insights</MessageBarTitle>{governError}</MessageBarBody>
            </MessageBar>
          )}
          {govern && (
            <>
              <Section title="Insights — tenant-wide" actions={<Badge appearance="tint" color="informative">live · Cosmos</Badge>}>
                <div className={s.tilesRow}>
                  <GovTile
                    icon={Tag20Regular} color={ACCENT.violet}
                    value={`${govern.labeledPct}%`} label="Sensitivity coverage"
                    sub={`${govern.labeled} of ${govern.totalItems} items labeled`}
                    pct={govern.labeledPct}
                  />
                  <GovTile
                    icon={Ribbon20Regular} color={ACCENT.green}
                    value={String(govern.endorsed)} label="Endorsed items"
                    sub={`${govern.endorsedPct}% of ${govern.totalItems} items`}
                    pct={govern.endorsedPct}
                  />
                  <GovTile
                    icon={Database20Regular} color={ACCENT.blue}
                    value={String(govern.classificationTable.length)} label="Classifications"
                    sub={govern.purviewConfigured && govern.purviewAssetCount !== null
                      ? `${govern.purviewAssetCount} Purview assets overlaid`
                      : 'Cosmos item state'}
                  />
                  <GovTile
                    icon={Warning20Regular} color={ACCENT.amber}
                    value={String(govern.attentionCount)} label="Items needing attention"
                    sub={`${govern.ownedPct}% have an owner`}
                  />
                </div>

                {govern.purviewGate && (
                  <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalL }}>
                    <MessageBarBody>
                      <MessageBarTitle>Purview classification overlay not configured</MessageBarTitle>
                      {govern.purviewGate.followUp ??
                        `Set ${govern.purviewGate.missingEnvVar} (deploy ${govern.purviewGate.bicepModule}) to overlay scan-based classifications.`}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </Section>

              {govern.classificationTable.length > 0 && (
                <Section title="Classifications">
                  <LoomDataTable
                    columns={classColumns}
                    rows={govern.classificationTable}
                    getRowId={(c) => c.classification}
                    ariaLabel="Classification table"
                    empty="No classifications recorded yet."
                  />
                </Section>
              )}

              <Section
                title="Items needing attention"
                actions={<Badge appearance="tint" color={govern.attention.length ? 'warning' : 'success'}>{govern.attention.length} flagged</Badge>}
              >
                {govern.attention.length === 0 ? (
                  <div className={s.centered}>
                    <Body1 className={s.muted}>Every catalog item is labeled, owned, endorsed, and classified.</Body1>
                  </div>
                ) : (
                  <LoomDataTable
                    columns={attentionColumns}
                    rows={govern.attention}
                    getRowId={(a) => a.id}
                    onRowClick={(a) => router.push(a.href)}
                    ariaLabel="Items needing attention"
                    empty="No items need attention."
                  />
                )}
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default OneLakeCatalogPane;
