'use client';

/**
 * ApiMarketplace — the consumer/catalog view over the tenant's Azure API
 * Management instance. The Loom equivalent of the APIM developer portal /
 * Azure API Center hub.
 *
 * No mock data. Every panel is wired to a real BFF route that calls Azure
 * REST against Microsoft.ApiManagement/service:
 *   - catalog (products + their APIs + flat API list)  GET /api/marketplace/catalog
 *   - operations for a selected API                    GET /api/items/apim-api/{id}/operations
 *   - OpenAPI spec export                              GET /api/items/apim-api/{id}/spec
 *   - "Try it" gateway call                            POST /api/items/apim-api/{id}/test-call
 *   - my subscriptions                                 GET /api/marketplace/subscriptions
 *   - subscribe / request access                       POST /api/marketplace/subscriptions
 *   - reveal subscription keys                         POST /api/marketplace/subscriptions/{sid}/keys
 *
 * When APIM isn't provisioned the catalog route returns a 503 { gated:true,
 * hint } which we render as a Fluent MessageBar (intent="warning"); the full
 * UI shell still renders behind it.
 *
 * UI follows the Web-3.0 design contract (docs/fiab/design/ui-web3-guide.md):
 * Section/Toolbar layout, ItemTile + TileGrid catalog with a ViewToggle to a
 * LoomDataTable list, capped search, and a LoomDataTable for subscriptions.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner,
  Input, Textarea, Dropdown, Option, Field, Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, Copy20Regular,
  Key20Regular, Add20Regular, Apps20Regular,
  ArrowLeft20Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

// ---------------- types mirrored from the BFF ----------------

interface ApiSummary {
  id: string; name: string; displayName?: string; path?: string;
  protocols?: string[]; serviceUrl?: string; subscriptionRequired?: boolean; type?: string;
}
interface ProductSummary {
  id: string; name: string; displayName?: string; description?: string;
  subscriptionRequired?: boolean; approvalRequired?: boolean; state?: string;
  apis: ApiSummary[];
}
interface SubscriptionSummary {
  id: string; name: string; displayName?: string; scope?: string; state?: string; createdDate?: string;
}
interface Operation { id: string; name: string; displayName?: string; method?: string; urlTemplate?: string; }
interface ServiceInfo { name?: string; gatewayUrl?: string; state?: string }

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  topBar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  detailHead: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
  },
  metaRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  overviewGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: tokens.spacingVerticalL, marginTop: tokens.spacingVerticalM,
  },
  fieldBlock: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  tryGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM,
  },
  tabBody: { paddingTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  code: {
    width: '100%', minHeight: '220px', maxHeight: '480px', padding: tokens.spacingVerticalM,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    overflow: 'auto', whiteSpace: 'pre',
  },
  keysCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, alignItems: 'flex-start' },
  keyLine: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' },
});

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function stateBadge(state?: string) {
  const st = (state || '').toLowerCase();
  if (st === 'active' || st === 'published') return <Badge color="success" appearance="filled">{state}</Badge>;
  if (st === 'submitted') return <Badge color="warning" appearance="filled">{state}</Badge>;
  if (st === 'rejected' || st === 'cancelled' || st === 'expired' || st === 'suspended') return <Badge color="danger">{state}</Badge>;
  return <Badge appearance="outline">{state || 'unknown'}</Badge>;
}

export function ApiMarketplace() {
  const s = useStyles();

  // top-level view
  const [view, setView] = useState<'catalog' | 'subscriptions'>('catalog');
  // catalog tile/list switch
  const [catView, setCatView] = useState<LoomView>('tile');

  // catalog
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ msg: string; hint?: string; bicep?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [apis, setApis] = useState<ApiSummary[]>([]);
  const [service, setService] = useState<ServiceInfo | null>(null);
  const [query, setQuery] = useState('');

  // selection + detail
  const [selApi, setSelApi] = useState<ApiSummary | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'operations' | 'spec' | 'tryit'>('overview');
  const [ops, setOps] = useState<{ loading: boolean; data: Operation[]; error?: string }>({ loading: false, data: [] });
  const [spec, setSpec] = useState<{ loading: boolean; value?: string; format?: string; error?: string }>({ loading: false });

  // try-it
  const [tMethod, setTMethod] = useState('GET');
  const [tTemplate, setTTemplate] = useState('');
  const [tHeaders, setTHeaders] = useState('');
  const [tBody, setTBody] = useState('');
  const [tBusy, setTBusy] = useState(false);
  const [tResp, setTResp] = useState<{ status: number; statusText: string; headers: Record<string, string>; body: string } | null>(null);
  const [tErr, setTErr] = useState<string | null>(null);

  // subscriptions
  const [subs, setSubs] = useState<{ loading: boolean; data: SubscriptionSummary[]; error?: string }>({ loading: false, data: [] });
  const [keyCache, setKeyCache] = useState<Record<string, { primaryKey?: string; secondaryKey?: string }>>({});

  // subscribe dialog
  const [subOpen, setSubOpen] = useState(false);
  const [subTarget, setSubTarget] = useState<{ kind: 'product' | 'api'; id: string; name: string } | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subMsg, setSubMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // ---------------- loaders ----------------

  const loadCatalog = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const r = await fetch('/api/marketplace/catalog', { cache: 'no-store' });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { setErr(`Unexpected response (${r.status})`); return; }
      const j = await r.json();
      if (r.status === 503 && j?.gated) { setGate({ msg: j.error, hint: j.hint, bicep: j.bicepModule }); return; }
      if (!j?.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
      setProducts(j.products || []);
      setApis(j.apis || []);
      setService(j.service || null);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadSubscriptions = useCallback(async () => {
    setSubs((p) => ({ ...p, loading: true, error: undefined }));
    try {
      const r = await fetch('/api/marketplace/subscriptions', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gated) { setSubs({ loading: false, data: [], error: j.error }); return; }
      if (!j?.ok) { setSubs({ loading: false, data: [], error: j?.error || `HTTP ${r.status}` }); return; }
      setSubs({ loading: false, data: j.subscriptions || [] });
    } catch (e: any) { setSubs({ loading: false, data: [], error: e?.message || String(e) }); }
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  useEffect(() => { if (view === 'subscriptions') loadSubscriptions(); }, [view, loadSubscriptions]);

  const loadOps = useCallback(async (apiId: string) => {
    setOps({ loading: true, data: [] });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(apiId)}/operations`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setOps({ loading: false, data: [], error: j?.error || `HTTP ${r.status}` }); return; }
      setOps({ loading: false, data: j.operations || [] });
    } catch (e: any) { setOps({ loading: false, data: [], error: e?.message || String(e) }); }
  }, []);

  const loadSpec = useCallback(async (apiId: string) => {
    setSpec({ loading: true });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(apiId)}/spec?format=openapi+json`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSpec({ loading: false, error: j?.error || `HTTP ${r.status}` }); return; }
      setSpec({ loading: false, value: j.value, format: j.format });
    } catch (e: any) { setSpec({ loading: false, error: e?.message || String(e) }); }
  }, []);

  const selectApi = useCallback((api: ApiSummary) => {
    setSelApi(api); setDetailTab('overview');
    setOps({ loading: false, data: [] }); setSpec({ loading: false });
    setTResp(null); setTErr(null); setTTemplate(''); setTMethod('GET');
  }, []);

  // lazy-load detail tabs
  useEffect(() => {
    if (!selApi) return;
    if (detailTab === 'operations' && !ops.loading && ops.data.length === 0 && !ops.error) loadOps(selApi.name || selApi.id);
    if (detailTab === 'spec' && !spec.loading && spec.value === undefined && !spec.error) loadSpec(selApi.name || selApi.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTab, selApi]);

  // ---------------- try it ----------------
  const sendTest = useCallback(async () => {
    if (!selApi) return;
    setTBusy(true); setTErr(null); setTResp(null);
    const headers: Record<string, string> = {};
    tHeaders.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
      const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(selApi.name || selApi.id)}/test-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: tMethod, urlTemplate: tTemplate, headers,
          body: ['GET', 'HEAD'].includes(tMethod) ? undefined : tBody,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setTErr(j?.error || `HTTP ${r.status}`); return; }
      setTResp({ status: j.status, statusText: j.statusText, headers: j.headers || {}, body: j.body || '' });
    } catch (e: any) { setTErr(e?.message || String(e)); }
    finally { setTBusy(false); }
  }, [selApi, tMethod, tTemplate, tHeaders, tBody]);

  // ---------------- subscribe ----------------
  const openSubscribe = useCallback((target: { kind: 'product' | 'api'; id: string; name: string }) => {
    setSubTarget(target); setSubMsg(null); setSubOpen(true);
  }, []);

  const doSubscribe = useCallback(async () => {
    if (!subTarget) return;
    setSubBusy(true); setSubMsg(null);
    try {
      const body = subTarget.kind === 'product'
        ? { product: subTarget.id, displayName: subTarget.name }
        : { api: subTarget.id, displayName: subTarget.name };
      const r = await fetch('/api/marketplace/subscriptions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSubMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      const st = j.subscription?.state || 'submitted';
      setSubMsg({
        intent: 'success',
        text: st === 'submitted'
          ? 'Access requested. The subscription is pending administrator approval.'
          : `Subscribed. Subscription "${j.subscription?.name}" is ${st}.`,
      });
      loadSubscriptions();
    } catch (e: any) { setSubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSubBusy(false); }
  }, [subTarget, loadSubscriptions]);

  const revealKeys = useCallback(async (sid: string) => {
    try {
      const r = await fetch(`/api/marketplace/subscriptions/${encodeURIComponent(sid)}/keys`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setKeyCache((p) => ({ ...p, [sid]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
      else setKeyCache((p) => ({ ...p, [sid]: { primaryKey: `(error: ${j?.error || r.status})` } }));
    } catch (e: any) { setKeyCache((p) => ({ ...p, [sid]: { primaryKey: `(error: ${e?.message})` } })); }
  }, []);

  // ---------------- filtering ----------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchA = (a: ApiSummary) =>
      !q || (a.displayName || a.name || '').toLowerCase().includes(q) || (a.path || '').toLowerCase().includes(q);
    const matchP = (p: ProductSummary) =>
      !q || (p.displayName || p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q) || p.apis.some(matchA);
    const productsF = products.filter(matchP);
    // flat de-duped API list across products + ungrouped, for the API collection
    const seen = new Set<string>();
    const allApis: ApiSummary[] = [];
    for (const a of [...products.flatMap((p) => p.apis), ...apis]) {
      const k = a.name || a.id;
      if (seen.has(k)) continue;
      seen.add(k); allApis.push(a);
    }
    const apisF = allApis.filter(matchA);
    return { productsF, apisF };
  }, [products, apis, query]);

  const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); };

  // product → which product (if any) an API belongs to, for the API subtitle
  const apiProductLabel = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of products) for (const a of p.apis) map[a.name || a.id] = p.displayName || p.name;
    return map;
  }, [products]);

  // ---------------- subscription columns ----------------
  const subColumns: LoomColumn<SubscriptionSummary>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 220,
      getValue: (r) => r.displayName || r.name,
      render: (r) => <strong>{r.displayName || r.name}</strong>,
    },
    {
      key: 'scope', label: 'Scope', width: 220,
      getValue: (r) => (r.scope || '').replace(/^.*\/service\/[^/]+/, ''),
      render: (r) => <Caption1><code>{(r.scope || '').replace(/^.*\/service\/[^/]+/, '') || '—'}</code></Caption1>,
    },
    {
      key: 'state', label: 'State', width: 120,
      getValue: (r) => r.state || '',
      render: (r) => stateBadge(r.state),
    },
    {
      key: 'created', label: 'Created', width: 130, filterable: false,
      getValue: (r) => r.createdDate || '',
      render: (r) => <Caption1>{r.createdDate ? new Date(r.createdDate).toLocaleDateString() : '—'}</Caption1>,
    },
    {
      key: 'keys', label: 'Keys', width: 260, sortable: false, filterable: false,
      render: (r) => {
        const keys = keyCache[r.name];
        if (!keys) {
          return (
            <Button size="small" icon={<Key20Regular />} onClick={(e) => { e.stopPropagation(); revealKeys(r.name); }}>
              Show keys
            </Button>
          );
        }
        return (
          <div className={s.keysCell}>
            <div className={s.keyLine}>
              <Caption1><code>{keys.primaryKey ? `${keys.primaryKey.slice(0, 8)}…` : '(none)'}</code></Caption1>
              {keys.primaryKey && (
                <Button size="small" icon={<Copy20Regular />} onClick={(e) => { e.stopPropagation(); copy(keys.primaryKey!); }}>
                  Copy primary
                </Button>
              )}
            </div>
            {keys.secondaryKey && (
              <Button size="small" icon={<Copy20Regular />} onClick={(e) => { e.stopPropagation(); copy(keys.secondaryKey!); }}>
                Copy secondary
              </Button>
            )}
          </div>
        );
      },
    },
  ], [keyCache, revealKeys, s.keysCell, s.keyLine]);

  // ---------------- render ----------------
  return (
    <div className={s.root}>
      <div className={s.topBar}>
        <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as 'catalog' | 'subscriptions')}>
          <Tab value="catalog" icon={<Apps20Regular />}>Catalog</Tab>
          <Tab value="subscriptions" icon={<Key20Regular />}>My subscriptions</Tab>
        </TabList>
        <div className={s.spacer} />
        {service?.gatewayUrl && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Gateway: <code>{service.gatewayUrl}</code>
          </Caption1>
        )}
        <Button icon={<ArrowSync20Regular />} onClick={() => { loadCatalog(); if (view === 'subscriptions') loadSubscriptions(); }}>
          Refresh
        </Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>API Management not provisioned</MessageBarTitle>
            {gate.msg} {gate.hint}
            {gate.bicep && <> Deploy it with <code>{gate.bicep}</code>.</>}
          </MessageBarBody>
        </MessageBar>
      )}
      {err && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load the catalog</MessageBarTitle>{err}</MessageBarBody>
          <MessageBarActions><Button size="small" onClick={loadCatalog}>Retry</Button></MessageBarActions>
        </MessageBar>
      )}

      {view === 'catalog' && !selApi && (
        <>
          {loading && (
            <Section title="API catalog">
              <Spinner label="Loading catalog from API Management…" labelPosition="after" />
            </Section>
          )}

          {!loading && !gate && (
            <>
              {/* Products */}
              <Section
                title={`Products${filtered.productsF.length ? ` (${filtered.productsF.length})` : ''}`}
                actions={<ViewToggle value={catView} onChange={setCatView} ariaLabel="Switch catalog view" />}
              >
                <Toolbar
                  search={query}
                  onSearch={setQuery}
                  searchPlaceholder="Search APIs and products by name, path, or description"
                />
                {filtered.productsF.length === 0 ? (
                  <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {products.length === 0 ? 'This APIM instance has no products published yet.' : 'No products match your search.'}
                  </Body1>
                ) : catView === 'tile' ? (
                  <TileGrid>
                    {filtered.productsF.map((p) => (
                      <ItemTile
                        key={p.id}
                        type="apim-product"
                        title={p.displayName || p.name}
                        subtitle={p.description || `${p.apis.length} API${p.apis.length === 1 ? '' : 's'}`}
                        meta={
                          <div className={s.metaRow}>
                            {stateBadge(p.state)}
                            {p.approvalRequired && <Badge appearance="tint" color="warning">approval required</Badge>}
                          </div>
                        }
                        badge={
                          <Button
                            size="small" appearance="primary" icon={<Add20Regular />}
                            onClick={(e) => { e.stopPropagation(); openSubscribe({ kind: 'product', id: p.name || p.id, name: p.displayName || p.name }); }}
                          >
                            {p.approvalRequired ? 'Request' : 'Subscribe'}
                          </Button>
                        }
                      />
                    ))}
                  </TileGrid>
                ) : (
                  <LoomDataTable<ProductSummary>
                    ariaLabel="Products"
                    columns={[
                      { key: 'name', label: 'Product', width: 240, getValue: (r) => r.displayName || r.name, render: (r) => <strong>{r.displayName || r.name}</strong> },
                      { key: 'description', label: 'Description', width: 300, getValue: (r) => r.description || '' },
                      { key: 'apis', label: 'APIs', width: 80, filterable: false, getValue: (r) => r.apis.length, render: (r) => String(r.apis.length) },
                      { key: 'state', label: 'State', width: 120, getValue: (r) => r.state || '', render: (r) => stateBadge(r.state) },
                      {
                        key: 'subscribe', label: 'Access', width: 140, sortable: false, filterable: false,
                        render: (r) => (
                          <Button
                            size="small" appearance="primary" icon={<Add20Regular />}
                            onClick={(e) => { e.stopPropagation(); openSubscribe({ kind: 'product', id: r.name || r.id, name: r.displayName || r.name }); }}
                          >
                            {r.approvalRequired ? 'Request' : 'Subscribe'}
                          </Button>
                        ),
                      },
                    ]}
                    rows={filtered.productsF}
                    getRowId={(r) => r.id}
                    empty="No products match your search."
                  />
                )}
              </Section>

              {/* APIs */}
              <Section title={`APIs${filtered.apisF.length ? ` (${filtered.apisF.length})` : ''}`}>
                {filtered.apisF.length === 0 ? (
                  <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {apis.length === 0 && products.every((p) => p.apis.length === 0)
                      ? 'This APIM instance has no APIs published yet.'
                      : 'No APIs match your search.'}
                  </Body1>
                ) : catView === 'tile' ? (
                  <TileGrid>
                    {filtered.apisF.map((a) => (
                      <ItemTile
                        key={a.id}
                        type="apim-api"
                        title={a.displayName || a.name}
                        subtitle={a.path ? `/${a.path}` : apiProductLabel[a.name || a.id] || 'API'}
                        meta={
                          <div className={s.metaRow}>
                            <Badge appearance="outline">{a.type || 'http'}</Badge>
                            {a.subscriptionRequired
                              ? <Badge color="warning" appearance="tint">subscription</Badge>
                              : <Badge color="success" appearance="tint">open</Badge>}
                          </div>
                        }
                        onClick={() => selectApi(a)}
                      />
                    ))}
                  </TileGrid>
                ) : (
                  <LoomDataTable<ApiSummary>
                    ariaLabel="APIs"
                    columns={[
                      { key: 'name', label: 'API', width: 240, getValue: (r) => r.displayName || r.name, render: (r) => <strong>{r.displayName || r.name}</strong> },
                      { key: 'path', label: 'Path', width: 200, getValue: (r) => r.path || '', render: (r) => <code>/{r.path}</code> },
                      { key: 'type', label: 'Type', width: 100, getValue: (r) => r.type || 'http' },
                      {
                        key: 'sub', label: 'Access', width: 140, sortable: false, filterable: false,
                        getValue: (r) => (r.subscriptionRequired ? 'subscription' : 'open'),
                        render: (r) => r.subscriptionRequired
                          ? <Badge color="warning" appearance="tint">subscription</Badge>
                          : <Badge color="success" appearance="tint">open</Badge>,
                      },
                    ]}
                    rows={filtered.apisF}
                    getRowId={(r) => r.id}
                    onRowClick={selectApi}
                    empty="No APIs match your search."
                  />
                )}
              </Section>
            </>
          )}
        </>
      )}

      {/* API detail — replaces the catalog grid when an API is selected */}
      {view === 'catalog' && selApi && (
        <Section
          title={selApi.displayName || selApi.name}
          actions={
            <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => setSelApi(null)}>
              Back to catalog
            </Button>
          }
        >
          <div className={s.detailHead}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={s.metaRow}>
                <Badge appearance="outline">{selApi.type || 'http'}</Badge>
                {(selApi.protocols || []).map((pr) => <Badge key={pr} appearance="tint">{pr}</Badge>)}
                {selApi.subscriptionRequired
                  ? <Badge color="warning" appearance="tint">subscription required</Badge>
                  : <Badge color="success" appearance="tint">open</Badge>}
              </div>
            </div>
            <Button
              appearance="primary" icon={<Add20Regular />}
              onClick={() => openSubscribe({ kind: 'api', id: selApi.name || selApi.id, name: selApi.displayName || selApi.name })}
            >
              Subscribe to this API
            </Button>
          </div>

          <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as 'overview' | 'operations' | 'spec' | 'tryit')}>
            <Tab value="overview">Overview</Tab>
            <Tab value="operations">Operations</Tab>
            <Tab value="spec">OpenAPI</Tab>
            <Tab value="tryit" icon={<Play20Regular />}>Try it</Tab>
          </TabList>

          {detailTab === 'overview' && (
            <div className={s.overviewGrid}>
              <div className={s.fieldBlock}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Path</Caption1>
                <Body1><code>/{selApi.path}</code></Body1>
              </div>
              <div className={s.fieldBlock}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Gateway base URL</Caption1>
                <Body1><code>{service?.gatewayUrl ? `${service.gatewayUrl}/${selApi.path}` : '(gateway unavailable)'}</code></Body1>
              </div>
              {selApi.serviceUrl && (
                <div className={s.fieldBlock}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Backend service URL</Caption1>
                  <Body1><code>{selApi.serviceUrl}</code></Body1>
                </div>
              )}
            </div>
          )}

          {detailTab === 'operations' && (
            <div className={s.tabBody}>
              {ops.loading && <Spinner size="tiny" label="Loading operations…" labelPosition="after" />}
              {ops.error && <MessageBar intent="warning"><MessageBarBody>{ops.error}</MessageBarBody></MessageBar>}
              {!ops.loading && !ops.error && (
                <LoomDataTable<Operation>
                  ariaLabel="Operations"
                  columns={[
                    { key: 'method', label: 'Method', width: 110, getValue: (r) => r.method || '', render: (r) => <Badge appearance="tint">{r.method}</Badge> },
                    { key: 'name', label: 'Name', width: 240, getValue: (r) => r.displayName || r.name, render: (r) => r.displayName || r.name },
                    { key: 'url', label: 'URL template', width: 280, getValue: (r) => r.urlTemplate || '', render: (r) => <code>{r.urlTemplate}</code> },
                    {
                      key: 'try', label: 'Try', width: 90, sortable: false, filterable: false,
                      render: (r) => (
                        <Button
                          size="small" icon={<Play20Regular />}
                          onClick={(e) => { e.stopPropagation(); setTMethod(r.method || 'GET'); setTTemplate(r.urlTemplate || ''); setDetailTab('tryit'); }}
                        >
                          Use
                        </Button>
                      ),
                    },
                  ]}
                  rows={ops.data}
                  getRowId={(r) => r.id || r.name}
                  empty="No operations defined."
                />
              )}
            </div>
          )}

          {detailTab === 'spec' && (
            <div className={s.tabBody}>
              <div className={s.metaRow}>
                <Subtitle2>OpenAPI spec</Subtitle2>
                <Badge appearance="outline">{spec.format || 'openapi+json'}</Badge>
                <Button size="small" icon={<Copy20Regular />} disabled={!spec.value} onClick={() => spec.value && copy(spec.value)}>Copy</Button>
                <Button size="small" icon={<ArrowSync20Regular />} onClick={() => loadSpec(selApi.name || selApi.id)}>Refresh</Button>
              </div>
              {spec.loading && <Spinner size="tiny" label="Exporting spec from APIM…" labelPosition="after" />}
              {spec.error && <Caption1>Spec unavailable: {spec.error}</Caption1>}
              {!spec.loading && !spec.error && (
                <div className={s.code} role="region" aria-label="OpenAPI spec">
                  {spec.value || '(no spec attached to this API)'}
                </div>
              )}
            </div>
          )}

          {detailTab === 'tryit' && (
            <div className={s.tabBody}>
              <Body1>Sends a real request through the APIM gateway. The all-access subscription key is attached server-side; it never reaches the browser.</Body1>
              <div className={s.tryGrid}>
                <Field label="Method">
                  <Dropdown value={tMethod} selectedOptions={[tMethod]} onOptionSelect={(_, d) => d.optionValue && setTMethod(d.optionValue)}>
                    {HTTP_METHODS.map((m) => <Option key={m} value={m}>{m}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="URL template (appended to the API path)">
                  <Input value={tTemplate} onChange={(_, d) => setTTemplate(d.value)} placeholder="/orders/{id}" />
                </Field>
                <Field label="Request headers (one per line, Name: value)" style={{ gridColumn: '1 / -1' }}>
                  <Textarea value={tHeaders} onChange={(_, d) => setTHeaders(d.value)} rows={2} placeholder={'Accept: application/json'} />
                </Field>
                {!['GET', 'HEAD'].includes(tMethod) && (
                  <Field label="Request body" style={{ gridColumn: '1 / -1' }}>
                    <Textarea value={tBody} onChange={(_, d) => setTBody(d.value)} rows={4} placeholder={'{ "name": "value" }'} />
                  </Field>
                )}
              </div>
              <Button appearance="primary" icon={<Play20Regular />} onClick={sendTest} disabled={tBusy} style={{ alignSelf: 'flex-start' }}>
                {tBusy ? 'Sending…' : 'Send'}
              </Button>
              {tErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Request failed</MessageBarTitle>{tErr}</MessageBarBody></MessageBar>}
              {tResp && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                  <div className={s.metaRow}>
                    <Badge appearance="filled" color={tResp.status < 400 ? 'success' : tResp.status < 500 ? 'warning' : 'danger'}>
                      {tResp.status} {tResp.statusText}
                    </Badge>
                    <Caption1>{tResp.headers['content-type'] || ''}</Caption1>
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response body</Caption1>
                  <div className={s.code}>{tResp.body || '(empty)'}</div>
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {view === 'subscriptions' && (
        <Section
          title="My subscriptions"
          actions={<Button icon={<ArrowSync20Regular />} onClick={loadSubscriptions}>Refresh</Button>}
        >
          {subs.error && <MessageBar intent="warning"><MessageBarBody>{subs.error}</MessageBarBody></MessageBar>}
          {!subs.error && (
            <LoomDataTable<SubscriptionSummary>
              ariaLabel="Subscriptions"
              columns={subColumns}
              rows={subs.data}
              getRowId={(r) => r.id}
              loading={subs.loading}
              empty="No subscriptions yet. Subscribe to a product or API from the Catalog tab."
            />
          )}
        </Section>
      )}

      {/* Subscribe dialog */}
      <Dialog open={subOpen} onOpenChange={(_, d) => setSubOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{subTarget?.kind === 'product' ? 'Subscribe to product' : 'Subscribe to API'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                <Body1>
                  Request access to <strong>{subTarget?.name}</strong>. This creates an APIM subscription scoped to the
                  {subTarget?.kind === 'product' ? ' product' : ' API'}. If approval is required, the request stays pending until an administrator approves it; otherwise it activates immediately and the subscription key is available under <em>My subscriptions</em>.
                </Body1>
                {subMsg && (
                  <MessageBar intent={subMsg.intent}>
                    <MessageBarBody>{subMsg.text}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Close</Button></DialogTrigger>
              <Button appearance="primary" icon={<Add20Regular />} onClick={doSubscribe} disabled={subBusy}>
                {subBusy ? 'Submitting…' : 'Confirm subscribe'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
