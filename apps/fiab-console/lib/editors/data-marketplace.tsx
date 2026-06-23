'use client';

/**
 * DataMarketplaceEditor — F14/F18 consumer data-product discovery surface.
 *
 * Parity target: Microsoft Purview / Fabric "OneLake data hub" + data-product
 * marketplace — a consumer browses Published data products, searches (with
 * exact-phrase support), filters by faceted navigation (governance domain,
 * type, owner, glossary terms, CDEs), explores by governance-domain card grid,
 * and tracks their own access requests.
 *
 * Backend (all real, no-vaporware):
 *   - Discover     POST /api/data-products/search  → loom-data-products AI Search index
 *   - Domains      POST /api/data-products/search (top:0) → @search.facets.domainName counts
 *   - Publish      GET/POST /api/data-products, PATCH/DELETE /api/data-products/[id]
 *   - My access    GET /api/data-products/my-access-requests → audit-log records
 *   - Request acc. POST /api/catalog/request-access
 *
 * Honest infra-gate: when LOOM_AI_SEARCH_SERVICE is unset, the search route
 * returns 503 { code:'not_configured', missing } and the Discover/Domains tabs
 * render a Fluent MessageBar naming the env var (the rest of the surface still
 * renders). No Microsoft Fabric / Power BI dependency on any path.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Title3, Body1, Caption1, Text, Badge, Button, Spinner, Divider,
  Card, CardHeader, Input, Textarea, Field, Select, Checkbox, Tag, Tooltip,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, ArrowSync20Regular, Add20Regular, Delete20Regular,
  Open20Regular, Dismiss16Regular, Database20Regular, KeyReset20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, paddingBottom: tokens.spacingVerticalXS },
  searchRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  discoverBody: { display: 'grid', gridTemplateColumns: 'minmax(220px, 250px) 1fr', gap: tokens.spacingHorizontalL, minHeight: 0, flex: 1 },
  facetPanel: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, overflowY: 'auto',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: tokens.spacingHorizontalM, maxHeight: '540px',
  },
  facetGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  facetRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalXS },
  results: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, overflowY: 'auto', maxHeight: '560px' },
  chips: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  resultCard: { padding: tokens.spacingHorizontalM },
  cardMeta: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS, alignItems: 'center' },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
  domainGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: tokens.spacingHorizontalM },
  domainCard: { padding: tokens.spacingHorizontalL, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacingHorizontalM },
  receipt: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100, whiteSpace: 'pre-wrap',
    background: tokens.colorNeutralBackground2, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusSmall,
    maxHeight: '220px', overflow: 'auto',
  },
  empty: { padding: tokens.spacingHorizontalXXL, textAlign: 'center', color: tokens.colorNeutralForeground3 },
});

const PRODUCT_TYPES = ['Lakehouse', 'Warehouse', 'Dataset', 'Semantic model', 'KQL database', 'Report', 'API', 'Notebook'];

interface WorkspaceLite { id: string; name: string }
interface DomainLite { id: string; name: string; color?: string }
interface FacetBucket { value: string; count: number }
type Facets = Record<string, FacetBucket[]>;

interface Hit {
  id: string;
  displayName: string;
  description?: string;
  domain?: string;
  domainName?: string;
  productType?: string;
  owner?: string;
  glossaryTerms?: string[];
  CDEs?: string[];
  sla?: string;
  url?: string;
  workspaceId?: string;
  /** governed (default) | self-serve | request — how a subscribe is provisioned. */
  accessModel?: string;
}

interface Product {
  id: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
  updatedAt?: string;
}

interface AccessRequest {
  id: string; productId: string; summary: string; requestedAt: string; permission: string; status: string;
}

const FACET_LABELS: Record<string, string> = {
  domainName: 'Governance domain',
  productType: 'Type',
  owner: 'Owner',
  glossaryTerms: 'Glossary terms',
  CDEs: 'Critical data elements',
};
const FACET_ORDER = ['domainName', 'productType', 'owner', 'glossaryTerms', 'CDEs'];

/**
 * DataProductsMarketplace — the data-product discover/domains/publish/access
 * panels, with no item chrome. Embedded as the "Data products" tab of the
 * unified Loom Marketplace (/marketplace) AND wrapped by DataMarketplaceEditor
 * for the legacy item route.
 */
export function DataProductsMarketplace() {
  const s = useStyles();
  const [tab, setTab] = useState<string>('discover');

  // Discover state
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [facets, setFacets] = useState<Facets>({});
  const [count, setCount] = useState(0);
  const [raw, setRaw] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<{ missing: string; hint?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);

  // Publish state
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [domains, setDomains] = useState<DomainLite[]>([]);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // My access state
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [reqErr, setReqErr] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string, sel: Record<string, string[]>) => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/data-products/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, selectedFacets: sel, top: 50 }),
      });
      const j = await r.json();
      if (r.status === 503 && j?.code === 'not_configured') {
        setGate({ missing: j.missing, hint: j.hint });
        setHits([]); setFacets({}); setCount(0); setRaw(j);
        return;
      }
      setGate(null);
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setHits([]); return; }
      setHits(j.results || []);
      setFacets(j.facets || {});
      setCount(j.count || 0);
      setRaw(j.searchResponse ?? j);
    } catch (e: any) {
      setErr(e?.message || String(e)); setHits([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial + reactive search.
  useEffect(() => { void runSearch(submitted, selected); }, [submitted, selected, runSearch]);

  const loadWorkspacesAndDomains = useCallback(async () => {
    try {
      const [wr, dr] = await Promise.all([
        fetch('/api/loom/workspaces').then((r) => r.json()).catch(() => ({})),
        fetch('/api/admin/domains').then((r) => r.json()).catch(() => ({})),
      ]);
      if (wr?.ok) setWorkspaces(wr.workspaces || []); else setWorkspaces([]);
      if (dr?.ok) setDomains((dr.domains || []).map((d: any) => ({ id: d.id, name: d.name, color: d.color })));
    } catch { setWorkspaces([]); }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const r = await fetch('/api/data-products');
      const j = await r.json();
      setProducts(j.ok ? (j.products || []) : []);
    } catch { setProducts([]); }
  }, []);

  const loadRequests = useCallback(async () => {
    setReqErr(null);
    try {
      const r = await fetch('/api/data-products/my-access-requests');
      const j = await r.json();
      if (!j.ok) { setReqErr(j.error || `HTTP ${r.status}`); setRequests([]); return; }
      setRequests(j.requests || []);
    } catch (e: any) { setReqErr(e?.message || String(e)); setRequests([]); }
  }, []);

  useEffect(() => {
    if (tab === 'publish' && products === null) { void loadWorkspacesAndDomains(); void loadProducts(); }
    if (tab === 'access' && requests === null) { void loadRequests(); }
  }, [tab, products, requests, loadWorkspacesAndDomains, loadProducts, loadRequests]);

  const toggleFacet = (field: string, value: string) => {
    setSelected((prev) => {
      const cur = prev[field] || [];
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
      const copy = { ...prev };
      if (next.length) copy[field] = next; else delete copy[field];
      return copy;
    });
  };

  const clearFacet = (field: string, value: string) => {
    setSelected((prev) => {
      const next = (prev[field] || []).filter((v) => v !== value);
      const copy = { ...prev };
      if (next.length) copy[field] = next; else delete copy[field];
      return copy;
    });
  };

  const activeChips = useMemo(
    () => Object.entries(selected).flatMap(([f, vals]) => vals.map((v) => ({ field: f, value: v }))),
    [selected],
  );

  const requestAccess = useCallback(async (hit: Hit, permission: string) => {
    const r = await fetch('/api/catalog/request-access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assetId: hit.id.replace(/^dp[:_]/, ''),
        assetName: hit.displayName,
        itemType: 'data-product',
        permission,
        accessModel: hit.accessModel || 'governed',
      }),
    });
    const j = await r.json();
    return j;
  }, []);

  const domainCards = facets.domainName || [];

  const main = (
    <div className={s.pad}>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(String(d.value))} className={s.tabs}>
        <Tab value="discover" icon={<Search20Regular />}>Discover</Tab>
        <Tab value="domains" icon={<Database20Regular />}>Domains</Tab>
        <Tab value="publish" icon={<Add20Regular />}>Publish</Tab>
        <Tab value="access" icon={<KeyReset20Regular />}>My data access</Tab>
      </TabList>

      {gate && (tab === 'discover' || tab === 'domains') && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Search not configured</MessageBarTitle>
            The data marketplace needs Azure AI Search. Set <code>{gate.missing}</code> to a deployed
            Microsoft.Search/searchServices name (bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep)
            and grant the Loom UAMI the &quot;Search Index Data Contributor&quot; role. {gate.hint}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ------- DISCOVER ------- */}
      {tab === 'discover' && (
        <>
          <div className={s.searchRow}>
            <Input
              style={{ minWidth: 360, flex: 1 }}
              contentBefore={<Search20Regular />}
              placeholder={'Search data products — e.g. "sales report" for an exact phrase'}
              value={query}
              onChange={(_, d) => setQuery(d.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSubmitted(query); }}
            />
            <Button appearance="primary" icon={<Search20Regular />} onClick={() => setSubmitted(query)}>Search</Button>
            {loading && <Spinner size="tiny" />}
            <Text size={200}>{count} published</Text>
          </div>
          <Caption1 className={s.hint}>
            Tip: wrap a term in double quotes for an exact phrase match — e.g. <code>&quot;customer 360&quot;</code>.
            Only Published products in your tenant are shown.
          </Caption1>

          {activeChips.length > 0 && (
            <div className={s.chips}>
              <Caption1>Filters:</Caption1>
              {activeChips.map((c) => (
                <Tag key={`${c.field}:${c.value}`} dismissible dismissIcon={<Dismiss16Regular />}
                  onClick={() => clearFacet(c.field, c.value)}>
                  {(FACET_LABELS[c.field] || c.field)}: {c.value}
                </Tag>
              ))}
              <Button size="small" appearance="subtle" onClick={() => setSelected({})}>Clear all</Button>
            </div>
          )}

          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

          <div className={s.discoverBody}>
            {/* Facet panel */}
            <div className={s.facetPanel}>
              {FACET_ORDER.map((field) => {
                const buckets = facets[field] || [];
                if (buckets.length === 0) return null;
                return (
                  <div key={field} className={s.facetGroup}>
                    <Subtitle2>{FACET_LABELS[field] || field}</Subtitle2>
                    {buckets.map((b) => (
                      <div key={b.value} className={s.facetRow}>
                        <Checkbox
                          checked={(selected[field] || []).includes(b.value)}
                          onChange={() => toggleFacet(field, b.value)}
                          label={b.value}
                        />
                        <Caption1 className={s.hint}>{b.count}</Caption1>
                      </div>
                    ))}
                  </div>
                );
              })}
              {Object.keys(facets).length === 0 && !gate && (
                <Caption1 className={s.hint}>No facets yet — publish a product to populate them.</Caption1>
              )}
            </div>

            {/* Results */}
            <div className={s.results}>
              {hits === null && loading && <Spinner label="Searching the live index…" />}
              {hits && hits.length === 0 && !gate && (
                <div className={s.empty}>No published data products match. Try a broader search or clear filters.</div>
              )}
              {(hits || []).map((h) => (
                <Tooltip key={h.id} relationship="description"
                  content={`${h.description || 'No description'}${h.owner ? ` · Owner: ${h.owner}` : ''}${h.sla ? ` · SLA: ${h.sla}` : ''}`}>
                  <Card className={s.resultCard}>
                    <CardHeader
                      header={<Body1><b>{h.displayName}</b></Body1>}
                      description={<Caption1 className={s.hint}>{h.description || '—'}</Caption1>}
                    />
                    <div className={s.cardMeta}>
                      {h.domainName && <Badge appearance="tint" color="brand">{h.domainName}</Badge>}
                      {h.productType && <Badge appearance="outline">{h.productType}</Badge>}
                      {h.accessModel && h.accessModel !== 'governed' && (
                        <Badge appearance="tint" color={h.accessModel === 'self-serve' ? 'success' : 'informative'}>
                          {h.accessModel === 'self-serve' ? 'Self-serve' : 'Request only'}
                        </Badge>
                      )}
                      {h.owner && <Caption1 className={s.hint}>Owner: {h.owner}</Caption1>}
                      {(h.glossaryTerms || []).map((t) => <Tag key={`g-${t}`} size="extra-small">{t}</Tag>)}
                      {(h.CDEs || []).map((c) => <Tag key={`c-${c}`} size="extra-small" appearance="outline">CDE: {c}</Tag>)}
                    </div>
                    <div className={s.cardActions}>
                      {h.url && (
                        <Button as="a" size="small" icon={<Open20Regular />} href={h.url}>Open</Button>
                      )}
                      <RequestAccessButton hit={h} onRequest={requestAccess} />
                    </div>
                  </Card>
                </Tooltip>
              ))}
            </div>
          </div>

          <Divider />
          <Button appearance="subtle" size="small" onClick={() => setShowReceipt((v) => !v)}>
            {showReceipt ? 'Hide' : 'Show'} search response (receipt)
          </Button>
          {showReceipt && <div className={s.receipt}>{JSON.stringify(raw, null, 2)}</div>}
        </>
      )}

      {/* ------- DOMAINS ------- */}
      {tab === 'domains' && !gate && (
        <>
          <Subtitle2>Explore by governance domain</Subtitle2>
          <Caption1 className={s.hint}>Live product counts from the index facet aggregate.</Caption1>
          {loading && <Spinner size="tiny" />}
          {domainCards.length === 0 && !loading && (
            <div className={s.empty}>No domains have published products yet.</div>
          )}
          <div className={s.domainGrid}>
            {domainCards.map((d) => (
              <Card key={d.value} className={s.domainCard}
                onClick={() => { setSelected({ domainName: [d.value] }); setTab('discover'); }}>
                <Database20Regular />
                <Subtitle2>{d.value}</Subtitle2>
                <Text size={400}><b>{d.count}</b> product{d.count === 1 ? '' : 's'}</Text>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* ------- PUBLISH ------- */}
      {tab === 'publish' && (
        <PublishTab
          workspaces={workspaces}
          domains={domains}
          products={products}
          onReload={() => { void loadProducts(); void runSearch(submitted, selected); }}
          createOpen={createOpen}
          setCreateOpen={setCreateOpen}
          styles={s}
        />
      )}

      {/* ------- MY DATA ACCESS ------- */}
      {tab === 'access' && (
        <>
          <Subtitle2>My data access requests</Subtitle2>
          <Caption1 className={s.hint}>
            Recorded requests from the catalog. Owners grant access in Governance → Policies (real Azure RBAC).
          </Caption1>
          {reqErr && <MessageBar intent="error"><MessageBarBody>{reqErr}</MessageBarBody></MessageBar>}
          {requests === null && <Spinner size="tiny" />}
          {requests && requests.length === 0 && (
            <div className={s.empty}>You have no recorded data-product access requests.</div>
          )}
          {requests && requests.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Product</TableHeaderCell>
                  <TableHeaderCell>Requested</TableHeaderCell>
                  <TableHeaderCell>Permission</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.summary || r.productId}</TableCell>
                    <TableCell>{new Date(r.requestedAt).toLocaleString()}</TableCell>
                    <TableCell><Badge appearance="outline">{r.permission}</Badge></TableCell>
                    <TableCell><Badge appearance="tint" color="warning">{r.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );

  return main;
}

/**
 * DataMarketplaceEditor — legacy item-route wrapper (/items/data-marketplace/…).
 * data-marketplace is now a coreSurface reached from the unified Loom
 * Marketplace, so this wrapper just frames the panels with item chrome and a
 * pointer to the full marketplace.
 */
export function DataMarketplaceEditor({ item, id }: { item: FabricItemType; id: string }) {
  const ribbon: RibbonTab[] = [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'Marketplace',
          actions: [
            { label: 'Open Loom Marketplace', icon: <Open20Regular />,
              onClick: () => { window.location.href = '/marketplace'; } },
          ],
        },
      ],
    },
  ];
  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={<DataProductsMarketplace />} />;
}

/** A small request-access control with a permission picker + confirmation. */
function RequestAccessButton({ hit, onRequest }: { hit: Hit; onRequest: (h: Hit, p: string) => Promise<any> }) {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState('read');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" icon={<KeyReset20Regular />}>Request access</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Request access — {hit.displayName}</DialogTitle>
          <DialogContent>
            {msg ? (
              <MessageBar intent="success"><MessageBarBody>{msg}</MessageBarBody></MessageBar>
            ) : (
              <Field label="Permission">
                <Select value={perm} onChange={(_, d) => setPerm(d.value)}>
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="admin">Admin</option>
                </Select>
              </Field>
            )}
          </DialogContent>
          <DialogActions>
            {!msg && (
              <Button appearance="primary" disabled={busy} onClick={async () => {
                setBusy(true);
                const j = await onRequest(hit, perm);
                setBusy(false);
                setMsg(j?.ok ? (j.message || 'Access request recorded.') : (j?.error || 'Request failed.'));
              }}>{busy ? 'Requesting…' : 'Submit request'}</Button>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={() => { setMsg(null); }}>Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Producer tab — create + publish/unpublish + delete owned data products. */
function PublishTab({
  workspaces, domains, products, onReload, createOpen, setCreateOpen, styles,
}: {
  workspaces: WorkspaceLite[] | null;
  domains: DomainLite[];
  products: Product[] | null;
  onReload: () => void;
  createOpen: boolean;
  setCreateOpen: (v: boolean) => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [domain, setDomain] = useState('');
  const [productType, setProductType] = useState('');
  const [owner, setOwner] = useState('');
  const [sla, setSla] = useState('');
  const [glossary, setGlossary] = useState('');
  const [cdes, setCdes] = useState('');
  const [publishStatus, setPublishStatus] = useState('Published');
  const [accessModel, setAccessModel] = useState('governed');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => {
    setName(''); setDesc(''); setDomain(''); setProductType(''); setOwner(''); setSla('');
    setGlossary(''); setCdes(''); setPublishStatus('Published'); setAccessModel('governed'); setErr(null);
  };

  const submit = async () => {
    if (!workspaceId || !name) { setErr('Workspace and name are required.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/data-products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId, displayName: name, description: desc,
          state: { domain, productType, owner, sla, glossaryTerms: glossary, CDEs: cdes, publishStatus, accessModel },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      setCreateOpen(false); reset(); onReload();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const setStatus = async (p: Product, status: string) => {
    await fetch(`/api/data-products/${p.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publishStatus: status }),
    });
    onReload();
  };
  const remove = async (p: Product) => {
    await fetch(`/api/data-products/${p.id}`, { method: 'DELETE' });
    onReload();
  };

  return (
    <>
      <div className={styles.searchRow}>
        <Subtitle2>My data products</Subtitle2>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setCreateOpen(true)}>New data product</Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={onReload}>Refresh</Button>
      </div>
      <Caption1 className={styles.hint}>
        Set a product to <b>Published</b> to make it visible to consumers in Discover. Draft/Deprecated products
        are hidden from consumer search.
      </Caption1>

      {products === null && <Spinner size="tiny" />}
      {products && products.length === 0 && (
        <div className={styles.empty}>No data products yet. Create one to publish it to the marketplace.</div>
      )}
      {products && products.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Domain</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => {
              const st = (p.state || {}) as Record<string, unknown>;
              const status = String(st.publishStatus || 'Draft');
              return (
                <TableRow key={p.id}>
                  <TableCell>{p.displayName}</TableCell>
                  <TableCell>{String(st.domain || '—')}</TableCell>
                  <TableCell>{String(st.productType || '—')}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={status === 'Published' ? 'success' : status === 'Deprecated' ? 'danger' : 'warning'}>
                      {status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {status !== 'Published'
                      ? <Button size="small" onClick={() => setStatus(p, 'Published')}>Publish</Button>
                      : <Button size="small" onClick={() => setStatus(p, 'Draft')}>Unpublish</Button>}
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(p)} aria-label="Delete" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New data product</DialogTitle>
            <DialogContent>
              <div className={styles.formGrid}>
                <Field label="Workspace" required className={styles.field}>
                  <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)}>
                    <option value="">Select a workspace…</option>
                    {(workspaces || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </Field>
                <Field label="Name" required className={styles.field}>
                  <Input value={name} onChange={(_, d) => setName(d.value)} />
                </Field>
                <Field label="Governance domain" className={styles.field}>
                  <Select value={domain} onChange={(_, d) => setDomain(d.value)}>
                    <option value="">(none)</option>
                    {domains.map((dm) => <option key={dm.id} value={dm.id}>{dm.name}</option>)}
                  </Select>
                </Field>
                <Field label="Type" className={styles.field}>
                  <Select value={productType} onChange={(_, d) => setProductType(d.value)}>
                    <option value="">(none)</option>
                    {PRODUCT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </Field>
                <Field label="Owner (UPN)" className={styles.field}>
                  <Input value={owner} onChange={(_, d) => setOwner(d.value)} placeholder="owner@contoso.com" />
                </Field>
                <Field label="SLA" className={styles.field}>
                  <Input value={sla} onChange={(_, d) => setSla(d.value)} placeholder="e.g. 99.9% / daily refresh" />
                </Field>
                <Field label="Glossary terms (comma-separated)" className={styles.field}>
                  <Input value={glossary} onChange={(_, d) => setGlossary(d.value)} placeholder="Revenue, Customer" />
                </Field>
                <Field label="Critical data elements (comma-separated)" className={styles.field}>
                  <Input value={cdes} onChange={(_, d) => setCdes(d.value)} placeholder="CustomerId, SSN" />
                </Field>
                <Field label="Publish status" className={styles.field}>
                  <Select value={publishStatus} onChange={(_, d) => setPublishStatus(d.value)}>
                    <option value="Published">Published</option>
                    <option value="Draft">Draft</option>
                    <option value="Deprecated">Deprecated</option>
                  </Select>
                </Field>
                <Field label="Access model" className={styles.field}
                  hint="How a consumer's subscribe is provisioned.">
                  <Select value={accessModel} onChange={(_, d) => setAccessModel(d.value)}>
                    <option value="governed">Governed — multi-tier approval → real RBAC</option>
                    <option value="self-serve">Self-serve — immediate grant where policy allows</option>
                    <option value="request">Request only — owner provisions manually</option>
                  </Select>
                </Field>
              </div>
              <Field label="Description" className={styles.field} style={{ marginTop: tokens.spacingVerticalM }}>
                <Textarea value={desc} onChange={(_, d) => setDesc(d.value)} />
              </Field>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" disabled={busy} onClick={submit}>{busy ? 'Creating…' : 'Create'}</Button>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
