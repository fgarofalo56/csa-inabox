'use client';

/**
 * ApiMarketplace — the consumer/catalog view over the tenant's Azure API
 * Management instance. The Loom equivalent of the APIM developer portal.
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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LargeTitle, Subtitle2, Subtitle1, Body1, Caption1, Badge, Button, Spinner,
  Input, Textarea, Dropdown, Option, Field, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, ArrowSync20Regular, Play20Regular, Copy20Regular,
  Key20Regular, Add20Regular, Document20Regular, Apps20Regular, Open20Regular,
} from '@fluentui/react-icons';

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
  root: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  split: { display: 'grid', gridTemplateColumns: 'minmax(280px, 340px) 1fr', gap: 16, minHeight: 0, flex: 1, alignItems: 'start' },
  rail: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, padding: 8,
    maxHeight: '72vh', overflow: 'auto', backgroundColor: tokens.colorNeutralBackground1,
  },
  detail: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, padding: 16,
    display: 'flex', flexDirection: 'column', gap: 12, minHeight: '60vh',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  productHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' },
  apiRow: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px', borderRadius: 6,
    cursor: 'pointer', border: '1px solid transparent',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  apiRowActive: { backgroundColor: tokens.colorBrandBackground2, border: `1px solid ${tokens.colorBrandStroke2}` },
  metaRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  code: {
    width: '100%', minHeight: 220, maxHeight: 480, padding: 12,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    overflow: 'auto', whiteSpace: 'pre',
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 },
  card: {
    padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
    display: 'flex', flexDirection: 'column', gap: 6,
  },
});

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function stateBadge(state?: string) {
  const s = (state || '').toLowerCase();
  if (s === 'active' || s === 'published') return <Badge color="success" appearance="filled">{state}</Badge>;
  if (s === 'submitted') return <Badge color="warning" appearance="filled">{state}</Badge>;
  if (s === 'rejected' || s === 'cancelled' || s === 'expired' || s === 'suspended') return <Badge color="danger">{state}</Badge>;
  return <Badge appearance="outline">{state || 'unknown'}</Badge>;
}

export function ApiMarketplace() {
  const s = useStyles();

  // top-level view
  const [view, setView] = useState<'catalog' | 'subscriptions'>('catalog');

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
    const match = (a: ApiSummary) =>
      !q || (a.displayName || a.name || '').toLowerCase().includes(q) || (a.path || '').toLowerCase().includes(q);
    const matchP = (p: ProductSummary) =>
      !q || (p.displayName || p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q) || p.apis.some(match);
    const productsF = products.filter(matchP).map((p) => ({ ...p, apis: q ? (matchP(p) && !p.apis.some(match) ? p.apis : p.apis.filter(match)) : p.apis }));
    const inProduct = new Set(products.flatMap((p) => p.apis.map((a) => a.name || a.id)));
    const ungrouped = apis.filter((a) => !inProduct.has(a.name || a.id)).filter(match);
    return { productsF, ungrouped };
  }, [products, apis, query]);

  const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); };

  // ---------------- render ----------------
  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as any)}>
          <Tab value="catalog" icon={<Apps20Regular />}>Catalog</Tab>
          <Tab value="subscriptions" icon={<Key20Regular />}>My subscriptions</Tab>
        </TabList>
        <div style={{ flex: 1 }} />
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

      {view === 'catalog' && (
        <>
          <Field>
            <Input
              contentBefore={<Search20Regular />}
              placeholder="Search APIs and products by name, path, or description"
              value={query}
              onChange={(_, d) => setQuery(d.value)}
            />
          </Field>

          {loading && <Spinner label="Loading catalog from API Management…" labelPosition="after" />}

          {!loading && !gate && (
            <div className={s.split}>
              {/* LEFT: product/API rail */}
              <div className={s.rail} role="navigation" aria-label="API catalog">
                {filtered.productsF.length === 0 && filtered.ungrouped.length === 0 && (
                  <Body1 style={{ padding: 12, color: tokens.colorNeutralForeground3 }}>
                    No APIs or products match. {products.length === 0 && apis.length === 0 ? 'This APIM instance has nothing published yet.' : ''}
                  </Body1>
                )}
                <Tree aria-label="Products and APIs">
                  {filtered.productsF.map((p) => (
                    <TreeItem key={p.id} itemType="branch" value={p.id}>
                      <TreeItemLayout
                        aside={stateBadge(p.state)}
                      >
                        {p.displayName || p.name}
                      </TreeItemLayout>
                      <Tree>
                        <TreeItem itemType="leaf" value={`${p.id}__subscribe`}>
                          <TreeItemLayout>
                            <Button
                              size="small" appearance="primary" icon={<Add20Regular />}
                              onClick={() => openSubscribe({ kind: 'product', id: p.name || p.id, name: p.displayName || p.name })}
                            >
                              {p.approvalRequired ? 'Request access' : 'Subscribe'}
                            </Button>
                          </TreeItemLayout>
                        </TreeItem>
                        {p.apis.length === 0 && (
                          <TreeItem itemType="leaf" value={`${p.id}__empty`}>
                            <TreeItemLayout><Caption1>(no APIs in this product)</Caption1></TreeItemLayout>
                          </TreeItem>
                        )}
                        {p.apis.map((a) => (
                          <TreeItem key={`${p.id}-${a.id}`} itemType="leaf" value={`${p.id}-${a.id}`}>
                            <TreeItemLayout
                              onClick={() => selectApi(a)}
                              className={selApi?.id === a.id ? s.apiRowActive : undefined}
                            >
                              {a.displayName || a.name}
                            </TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  ))}
                </Tree>

                {filtered.ungrouped.length > 0 && (
                  <>
                    <Caption1 style={{ padding: '8px 12px 4px', color: tokens.colorNeutralForeground3 }}>
                      APIs not in a product
                    </Caption1>
                    {filtered.ungrouped.map((a) => (
                      <div
                        key={a.id}
                        className={`${s.apiRow} ${selApi?.id === a.id ? s.apiRowActive : ''}`}
                        onClick={() => selectApi(a)}
                        role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectApi(a); }}
                      >
                        <Body1>{a.displayName || a.name}</Body1>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>/{a.path}</Caption1>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* RIGHT: detail */}
              <div className={s.detail}>
                {!selApi && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, color: tokens.colorNeutralForeground3, padding: 24, textAlign: 'center', alignItems: 'center' }}>
                    <Document20Regular fontSize={40} />
                    <Subtitle1>Select an API to explore it</Subtitle1>
                    <Body1>Pick an API from a product on the left to view its description, operations, OpenAPI spec, and to try a live call through the gateway.</Body1>
                  </div>
                )}
                {selApi && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Subtitle1>{selApi.displayName || selApi.name}</Subtitle1>
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

                    <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as any)}>
                      <Tab value="overview">Overview</Tab>
                      <Tab value="operations">Operations</Tab>
                      <Tab value="spec">OpenAPI</Tab>
                      <Tab value="tryit" icon={<Play20Regular />}>Try it</Tab>
                    </TabList>

                    {detailTab === 'overview' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Path</Caption1>
                          <Body1><code>/{selApi.path}</code></Body1>
                        </div>
                        <div>
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Gateway base URL</Caption1>
                          <Body1><code>{service?.gatewayUrl ? `${service.gatewayUrl}/${selApi.path}` : '(gateway unavailable)'}</code></Body1>
                        </div>
                        {selApi.serviceUrl && (
                          <div>
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Backend service URL</Caption1>
                            <Body1><code>{selApi.serviceUrl}</code></Body1>
                          </div>
                        )}
                      </div>
                    )}

                    {detailTab === 'operations' && (
                      <>
                        {ops.loading && <Spinner size="tiny" label="Loading operations…" labelPosition="after" />}
                        {ops.error && <MessageBar intent="warning"><MessageBarBody>{ops.error}</MessageBarBody></MessageBar>}
                        {!ops.loading && !ops.error && (
                          <Table size="small" aria-label="Operations">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Method</TableHeaderCell>
                              <TableHeaderCell>Name</TableHeaderCell>
                              <TableHeaderCell>URL template</TableHeaderCell>
                              <TableHeaderCell>Try</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {ops.data.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No operations defined.</Caption1></TableCell></TableRow>}
                              {ops.data.map((op) => (
                                <TableRow key={op.id || op.name}>
                                  <TableCell><Badge appearance="tint">{op.method}</Badge></TableCell>
                                  <TableCell>{op.displayName || op.name}</TableCell>
                                  <TableCell><code>{op.urlTemplate}</code></TableCell>
                                  <TableCell>
                                    <Button size="small" icon={<Play20Regular />} onClick={() => { setTMethod(op.method || 'GET'); setTTemplate(op.urlTemplate || ''); setDetailTab('tryit'); }}>Use</Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </>
                    )}

                    {detailTab === 'spec' && (
                      <>
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
                      </>
                    )}

                    {detailTab === 'tryit' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <Body1>Sends a real request through the APIM gateway. The all-access subscription key is attached server-side; it never reaches the browser.</Body1>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'subscriptions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className={s.toolbar}>
            <Subtitle1>My subscriptions</Subtitle1>
            <div style={{ flex: 1 }} />
            <Button icon={<ArrowSync20Regular />} onClick={loadSubscriptions}>Refresh</Button>
          </div>
          {subs.loading && <Spinner label="Loading subscriptions…" labelPosition="after" />}
          {subs.error && <MessageBar intent="warning"><MessageBarBody>{subs.error}</MessageBarBody></MessageBar>}
          {!subs.loading && !subs.error && subs.data.length === 0 && (
            <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No subscriptions yet. Subscribe to a product or API from the Catalog tab.</Body1>
          )}
          {!subs.loading && subs.data.length > 0 && (
            <Table aria-label="Subscriptions">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Keys</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {subs.data.map((sub) => {
                  const keys = keyCache[sub.name];
                  return (
                    <TableRow key={sub.id}>
                      <TableCell>{sub.displayName || sub.name}</TableCell>
                      <TableCell><Caption1><code>{(sub.scope || '').replace(/^.*\/service\/[^/]+/, '')}</code></Caption1></TableCell>
                      <TableCell>{stateBadge(sub.state)}</TableCell>
                      <TableCell><Caption1>{sub.createdDate ? new Date(sub.createdDate).toLocaleDateString() : '—'}</Caption1></TableCell>
                      <TableCell>
                        {!keys && <Button size="small" icon={<Key20Regular />} onClick={() => revealKeys(sub.name)}>Show keys</Button>}
                        {keys && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <Caption1><code>{keys.primaryKey ? `${keys.primaryKey.slice(0, 8)}…` : '(none)'}</code></Caption1>
                              {keys.primaryKey && <Button size="small" icon={<Copy20Regular />} onClick={() => copy(keys.primaryKey!)}>Copy primary</Button>}
                            </div>
                            {keys.secondaryKey && <Button size="small" icon={<Copy20Regular />} onClick={() => copy(keys.secondaryKey!)}>Copy secondary</Button>}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      )}

      {/* Subscribe dialog */}
      <Dialog open={subOpen} onOpenChange={(_, d) => setSubOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{subTarget?.kind === 'product' ? 'Subscribe to product' : 'Subscribe to API'}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
