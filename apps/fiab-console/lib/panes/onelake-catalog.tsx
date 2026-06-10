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
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input,
  Tab, TabList, Dropdown, Option, Spinner, Link,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular, Building20Regular, Database20Regular } from '@fluentui/react-icons';

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

const useStyles = makeStyles({
  bar: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: 12 },
  layout: { display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, minHeight: '50vh' },
  side: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4, padding: 12, overflow: 'auto',
  },
  main: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4, padding: 12,
  },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
  rowSelected: { backgroundColor: tokens.colorNeutralBackground2Selected },
  govCards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
  centered: { display: 'flex', justifyContent: 'center', padding: 32 },
});

function endorsementBadge(e?: string) {
  if (!e || e === '—') return null;
  return (
    <Badge appearance="outline" color={e === 'Certified' ? 'success' : 'brand'}>{e}</Badge>
  );
}
function sensitivityBadge(v?: string) {
  if (!v) return null;
  return (
    <Badge appearance="outline" color={/highly/i.test(v) ? 'danger' : 'informative'}>{v}</Badge>
  );
}

export function OneLakeCatalogPane() {
  const s = useStyles();
  const [tab, setTab] = useState('explore');

  // ── Explore state ──────────────────────────────────────────────────────
  const [domainId, setDomainId] = useState(''); // '' = (All)
  const [q, setQ] = useState('');
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

  const selectedDomainName =
    domains.find((d) => d.id === domainId)?.name ?? '(All)';

  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        <Tab value="explore">Explore</Tab>
        <Tab value="govern">Govern</Tab>
      </TabList>

      <div style={{ marginTop: 12 }}>
        {tab === 'explore' && (
          <div>
            {searchGate && (
              <MessageBar intent="warning" style={{ marginBottom: 8 }}>
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
              <MessageBar intent="error" style={{ marginBottom: 8 }}>
                <MessageBarBody>Failed to load catalog: {error}</MessageBarBody>
              </MessageBar>
            )}

            <div className={s.bar}>
              <Building20Regular />
              <Dropdown
                value={selectedDomainName}
                selectedOptions={[domainId]}
                onOptionSelect={(_, d) => setDomainId(d.optionValue ?? '')}
              >
                {domains.map((d) => <Option key={d.id || 'all'} value={d.id}>{d.name}</Option>)}
              </Dropdown>
              <Input
                contentBefore={<Search20Regular />}
                placeholder="Search items"
                value={q}
                onChange={(_, d) => setQ(d.value)}
                style={{ flex: 1 }}
              />
              {loading && <Spinner size="tiny" />}
            </div>

            <div className={s.layout}>
              <aside className={s.side}>
                <Subtitle2>Workspaces</Subtitle2>
                {workspaces.length === 0 && !loading ? (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 8 }}>
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
                          iconBefore={<Database20Regular />}
                          className={w.id === selectedWs ? s.rowSelected : undefined}
                        >
                          {w.name}
                        </TreeItemLayout>
                      </TreeItem>
                    ))}
                  </Tree>
                )}
                {selectedWs && (
                  <Button appearance="subtle" size="small" style={{ marginTop: 8 }} onClick={() => setSelectedWs(null)}>
                    Clear filter
                  </Button>
                )}
              </aside>

              <div className={s.main}>
                <Table aria-label="Catalog items">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Owner</TableHeaderCell>
                      <TableHeaderCell>Updated</TableHeaderCell>
                      <TableHeaderCell>Workspace</TableHeaderCell>
                      <TableHeaderCell>Endorsement</TableHeaderCell>
                      <TableHeaderCell>Sensitivity</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleItems.map((i) => (
                      <TableRow key={i.id} className={s.rowHover}>
                        <TableCell>
                          <Link href={`/items/${i.itemType}/${i.id}`}>{i.displayName}</Link>
                        </TableCell>
                        <TableCell>{i.itemType}</TableCell>
                        <TableCell>{i.owner ?? '—'}</TableCell>
                        <TableCell>{i.updatedAt ? new Date(i.updatedAt).toLocaleString() : '—'}</TableCell>
                        <TableCell>{i.workspaceName ?? i.workspaceId}</TableCell>
                        <TableCell>{endorsementBadge(i.endorsement) ?? '—'}</TableCell>
                        <TableCell>{sensitivityBadge(i.sensitivity) ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {visibleItems.length === 0 && !loading && (
                  <Body1 style={{ display: 'block', marginTop: 12, color: tokens.colorNeutralForeground3 }}>
                    No catalog items match the current filters.
                  </Body1>
                )}
                <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 8, display: 'block' }}>
                  {selectedWs
                    ? `${visibleItems.length} of ${total} items (filtered to workspace)`
                    : `${total} items`}
                  {backend ? ` · source: ${backend}` : ''}
                </Caption1>
              </div>
            </div>
          </div>
        )}

        {tab === 'govern' && (
          <div>
            <Subtitle2>Insights — tenant-wide</Subtitle2>
            {governLoading && <div className={s.centered}><Spinner label="Loading governance insights…" /></div>}
            {governError && (
              <MessageBar intent="error" style={{ marginTop: 8 }}>
                <MessageBarBody>Failed to load governance insights: {governError}</MessageBarBody>
              </MessageBar>
            )}
            {govern && (
              <>
                <div className={s.govCards} style={{ marginTop: 8 }}>
                  <GovCard
                    t="Sensitivity coverage"
                    v={`${govern.labeledPct}%`}
                    sub={`${govern.labeled} of ${govern.totalItems} items labeled`}
                  />
                  <GovCard
                    t="Endorsed items"
                    v={String(govern.endorsed)}
                    sub={`${govern.endorsedPct}% of ${govern.totalItems} items`}
                  />
                  <GovCard
                    t="Classifications"
                    v={String(govern.classificationTable.length)}
                    sub={
                      govern.purviewConfigured && govern.purviewAssetCount !== null
                        ? `${govern.purviewAssetCount} Purview assets overlaid`
                        : 'Cosmos item state'
                    }
                  />
                  <GovCard
                    t="Items needing attention"
                    v={String(govern.attentionCount)}
                    sub={`${govern.ownedPct}% have an owner`}
                  />
                </div>

                {govern.purviewGate && (
                  <MessageBar intent="info" style={{ marginTop: 12 }}>
                    <MessageBarBody>
                      <MessageBarTitle>Purview classification overlay not configured</MessageBarTitle>
                      {govern.purviewGate.followUp ??
                        `Set ${govern.purviewGate.missingEnvVar} (deploy ${govern.purviewGate.bicepModule}) to overlay scan-based classifications.`}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {govern.classificationTable.length > 0 && (
                  <>
                    <Subtitle2 style={{ marginTop: 16, display: 'block' }}>Classifications</Subtitle2>
                    <Table aria-label="Classification table" style={{ marginTop: 8 }}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Classification</TableHeaderCell>
                          <TableHeaderCell>Items</TableHeaderCell>
                          {govern.purviewConfigured && <TableHeaderCell>Purview assets</TableHeaderCell>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {govern.classificationTable.map((c) => (
                          <TableRow key={c.classification}>
                            <TableCell>{c.classification}</TableCell>
                            <TableCell>{c.count}</TableCell>
                            {govern.purviewConfigured && <TableCell>{c.purviewAssets ?? 0}</TableCell>}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}

                <Subtitle2 style={{ marginTop: 16, display: 'block' }}>Items needing attention</Subtitle2>
                {govern.attention.length === 0 ? (
                  <Body1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                    Every catalog item is labeled, owned, endorsed, and classified.
                  </Body1>
                ) : (
                  <Table aria-label="Items needing attention" style={{ marginTop: 8 }}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Item</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Workspace</TableHeaderCell>
                        <TableHeaderCell>Issues</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {govern.attention.map((a) => (
                        <TableRow key={a.id} className={s.rowHover}>
                          <TableCell><Link href={a.href}>{a.displayName}</Link></TableCell>
                          <TableCell>{a.itemType}</TableCell>
                          <TableCell>{a.workspaceName}</TableCell>
                          <TableCell>
                            {a.issues.map((iss) => (
                              <Badge key={iss} appearance="outline" color="warning" style={{ marginRight: 4 }}>{iss}</Badge>
                            ))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GovCard({ t, v, sub }: { t: string; v: string; sub: string }) {
  return (
    <div style={{ padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 }}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t}</Caption1>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{v}</div>
      <Caption1>{sub}</Caption1>
    </div>
  );
}
