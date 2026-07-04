'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useConfirm } from '@/lib/components/confirm-dialog';
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
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Play20Regular, Copy20Regular,
  Key20Regular, Add20Regular, Apps20Regular,
  ArrowLeft20Regular, MoreHorizontal20Regular, Delete20Regular, Rename20Regular,
  Branch20Regular, Open16Regular, Code20Regular, Key16Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ResponseBodyViewer } from '@/lib/components/marketplace/response-body';
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
  fieldBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  tryGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalM,
  },
  tabBody: { paddingTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  code: {
    width: '100%', minHeight: '220px', maxHeight: '480px', padding: tokens.spacingVerticalM,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    overflow: 'auto', whiteSpace: 'pre',
  },
  codeMeta: {
    width: '100%', maxHeight: '160px', padding: tokens.spacingVerticalS,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2,
    overflow: 'auto', whiteSpace: 'pre',
  },
  respLabelRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
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
  const { confirm, dialog: confirmDialog } = useConfirm();

  // top-level view
  const [view, setView] = useState<'catalog' | 'subscriptions'>('catalog');
  // catalog tile/list switch
  const [catView, setCatView] = useState<LoomView>('tile');

  // catalog
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
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
  const [tResp, setTResp] = useState<{ status: number; statusText: string; headers: Record<string, string>; body: string; keySource?: string } | null>(null);
  const [tErr, setTErr] = useState<string | null>(null);
  // Subscription/key selection for the Try console + curl samples. tSubId is a
  // subscription (sid) whose key the server resolves; tKey is a key pasted by
  // the user (overrides the resolved one). Either makes the gateway return 200
  // for a subscription-required API instead of 401.
  const [tSubId, setTSubId] = useState('');
  const [tKey, setTKey] = useState('');

  // subscriptions
  const [subs, setSubs] = useState<{ loading: boolean; data: SubscriptionSummary[]; error?: string }>({ loading: false, data: [] });
  const [keyCache, setKeyCache] = useState<Record<string, { primaryKey?: string; secondaryKey?: string }>>({});

  // subscribe dialog
  const [subOpen, setSubOpen] = useState(false);
  const [subTarget, setSubTarget] = useState<{ kind: 'product' | 'api'; id: string; name: string; approvalRequired?: boolean } | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subMsg, setSubMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // catalog filters (beyond search)
  const [accessFilter, setAccessFilter] = useState<'all' | 'open' | 'subscription'>('all');

  // subscription management
  const [subActionMsg, setSubActionMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SubscriptionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // "Use this API" drawer (code samples + mini-app builder)
  const [useSub, setUseSub] = useState<SubscriptionSummary | null>(null);
  const [useKeys, setUseKeys] = useState<{ primaryKey?: string; secondaryKey?: string } | null>(null);
  const [sampleLang, setSampleLang] = useState<'curl' | 'python' | 'javascript'>('curl');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [miniWs, setMiniWs] = useState('');
  const [miniName, setMiniName] = useState('');
  const [miniBusy, setMiniBusy] = useState(false);
  const [miniMsg, setMiniMsg] = useState<{ intent: 'success' | 'error'; text: string; link?: string; linkLabel?: string } | null>(null);

  // ---------------- loaders ----------------

  const loadCatalog = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null); setRetrying(false);
    // APIM gateways cold-start: the first request after idle can transiently 502
    // /503/504. Auto-retry with backoff a couple of times before surfacing an
    // error, so a cold gateway isn't reported as a failure.
    const maxAttempts = 3;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const r = await clientFetch('/api/marketplace/catalog', { cache: 'no-store' });
          const ct = r.headers.get('content-type') || '';
          const j = ct.includes('application/json') ? await r.json() : null;
          if (r.status === 503 && j?.gated) { setGate({ msg: j.error, hint: j.hint, bicep: j.bicepModule }); return; }
          // Transient gateway cold-start (NOT an honest gate) → retry.
          if ((r.status === 502 || r.status === 503 || r.status === 504) && attempt < maxAttempts) {
            setRetrying(true);
            await new Promise((res) => setTimeout(res, 1200 * attempt));
            continue;
          }
          if (!j) { setErr(`Unexpected response (${r.status})`); return; }
          if (!j?.ok) { setErr(j?.error || `HTTP ${r.status}`); return; }
          setProducts(j.products || []);
          setApis(j.apis || []);
          setService(j.service || null);
          return;
        } catch (e: any) {
          if (attempt < maxAttempts) { setRetrying(true); await new Promise((res) => setTimeout(res, 1200 * attempt)); continue; }
          setErr(e?.message || String(e));
        }
      }
    } finally {
      setLoading(false); setRetrying(false);
    }
  }, []);

  const loadSubscriptions = useCallback(async () => {
    setSubs((p) => ({ ...p, loading: true, error: undefined }));
    try {
      const r = await clientFetch('/api/marketplace/subscriptions', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gated) { setSubs({ loading: false, data: [], error: j.error }); return; }
      if (!j?.ok) { setSubs({ loading: false, data: [], error: j?.error || `HTTP ${r.status}` }); return; }
      setSubs({ loading: false, data: j.subscriptions || [] });
    } catch (e: any) { setSubs({ loading: false, data: [], error: e?.message || String(e) }); }
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  // Subscriptions back both the "My subscriptions" tab AND the Try-console key
  // picker, so load them up-front (the route 503-gates cleanly when unconfigured).
  useEffect(() => { loadSubscriptions(); }, [loadSubscriptions]);
  useEffect(() => { if (view === 'subscriptions') loadSubscriptions(); }, [view, loadSubscriptions]);

  const loadOps = useCallback(async (apiId: string) => {
    setOps({ loading: true, data: [] });
    try {
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(apiId)}/operations`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setOps({ loading: false, data: [], error: j?.error || `HTTP ${r.status}` }); return; }
      setOps({ loading: false, data: j.operations || [] });
    } catch (e: any) { setOps({ loading: false, data: [], error: e?.message || String(e) }); }
  }, []);

  const loadSpec = useCallback(async (apiId: string) => {
    setSpec({ loading: true });
    try {
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(apiId)}/spec?format=openapi+json`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSpec({ loading: false, error: j?.error || `HTTP ${r.status}` }); return; }
      setSpec({ loading: false, value: j.value, format: j.format });
    } catch (e: any) { setSpec({ loading: false, error: e?.message || String(e) }); }
  }, []);

  const selectApi = useCallback((api: ApiSummary) => {
    setSelApi(api); setDetailTab('overview');
    setOps({ loading: false, data: [] }); setSpec({ loading: false });
    setTResp(null); setTErr(null); setTTemplate(''); setTMethod('GET');
    setTSubId(''); setTKey('');
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
      const r = await clientFetch(`/api/items/apim-api/${encodeURIComponent(selApi.name || selApi.id)}/test-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: tMethod, urlTemplate: tTemplate, headers,
          body: ['GET', 'HEAD'].includes(tMethod) ? undefined : tBody,
          subscriptionId: tSubId || undefined,
          subscriptionKey: tKey.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setTErr(j?.error || `HTTP ${r.status}`); return; }
      setTResp({ status: j.status, statusText: j.statusText, headers: j.headers || {}, body: j.body || '', keySource: j.keySource });
    } catch (e: any) { setTErr(e?.message || String(e)); }
    finally { setTBusy(false); }
  }, [selApi, tMethod, tTemplate, tHeaders, tBody, tSubId, tKey]);

  // ---------------- subscribe ----------------
  const openSubscribe = useCallback((target: { kind: 'product' | 'api'; id: string; name: string; approvalRequired?: boolean }) => {
    setSubTarget(target); setSubMsg(null); setSubOpen(true);
  }, []);

  const doSubscribe = useCallback(async () => {
    if (!subTarget) return;
    setSubBusy(true); setSubMsg(null);
    try {
      // Auto-provision an ACTIVE subscription (key works immediately) unless the
      // product requires admin approval — then APIM creates it 'submitted' and
      // it stays pending. API-scoped subscriptions have no approval concept.
      const wantActive = !subTarget.approvalRequired;
      const body: Record<string, unknown> = subTarget.kind === 'product'
        ? { product: subTarget.id, displayName: subTarget.name }
        : { api: subTarget.id, displayName: subTarget.name };
      if (wantActive) body.state = 'active';
      const r = await clientFetch('/api/marketplace/subscriptions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSubMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      const st = j.subscription?.state || (wantActive ? 'active' : 'submitted');
      setSubMsg({
        intent: 'success',
        text: st === 'submitted'
          ? 'Access requested. The subscription is pending administrator approval.'
          : `Subscribed. Subscription "${j.subscription?.name}" is ${st} — its key is active now (open it under My subscriptions → Use this API, or pick it in the Try console).`,
      });
      loadSubscriptions();
    } catch (e: any) { setSubMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSubBusy(false); }
  }, [subTarget, loadSubscriptions]);

  const revealKeys = useCallback(async (sid: string) => {
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sid)}/keys`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setKeyCache((p) => ({ ...p, [sid]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
      else setKeyCache((p) => ({ ...p, [sid]: { primaryKey: `(error: ${j?.error || r.status})` } }));
    } catch (e: any) { setKeyCache((p) => ({ ...p, [sid]: { primaryKey: `(error: ${e?.message})` } })); }
  }, []);

  // Resolve a subscription's primary key (from cache, else reveal it). Returns
  // the key so the Try console can inject it into the visible key field.
  const ensureKey = useCallback(async (sid: string): Promise<string | undefined> => {
    const cached = keyCache[sid]?.primaryKey;
    if (cached && !cached.startsWith('(error')) return cached;
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sid)}/keys`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        setKeyCache((p) => ({ ...p, [sid]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
        return j.primaryKey;
      }
    } catch { /* key resolution is best-effort; server resolves it on send too */ }
    return undefined;
  }, [keyCache]);

  // ---------------- subscription management ----------------
  const renameSub = useCallback(async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setSubActionMsg(null);
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(renameTarget.name)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: renameValue.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSubActionMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setRenameOpen(false); setSubActionMsg({ intent: 'success', text: 'Subscription renamed.' }); loadSubscriptions();
    } catch (e: any) { setSubActionMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [renameTarget, renameValue, loadSubscriptions]);

  const setSubState = useCallback(async (sub: SubscriptionSummary, state: 'active' | 'suspended' | 'cancelled') => {
    setSubActionMsg(null);
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sub.name)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSubActionMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setSubActionMsg({ intent: 'success', text: `Subscription ${state}.` }); loadSubscriptions();
    } catch (e: any) { setSubActionMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [loadSubscriptions]);

  const deleteSub = useCallback(async (sub: SubscriptionSummary) => {
    if (!(await confirm({
      title: `Delete subscription "${sub.displayName || sub.name}"?`,
      body: 'This revokes its API keys immediately and cannot be undone.',
      danger: true,
      confirmLabel: 'Delete & revoke keys',
    }))) return;
    setSubActionMsg(null);
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sub.name)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSubActionMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setSubActionMsg({ intent: 'success', text: 'Subscription deleted.' }); loadSubscriptions();
    } catch (e: any) { setSubActionMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [loadSubscriptions]);

  const regenKey = useCallback(async (sub: SubscriptionSummary, which: 'primary' | 'secondary') => {
    setSubActionMsg(null);
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sub.name)}/keys/regenerate?which=${which}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setSubActionMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setKeyCache((p) => ({ ...p, [sub.name]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
      if (useSub?.name === sub.name) setUseKeys({ primaryKey: j.primaryKey, secondaryKey: j.secondaryKey });
      setSubActionMsg({ intent: 'success', text: `${which === 'primary' ? 'Primary' : 'Secondary'} key regenerated.` });
    } catch (e: any) { setSubActionMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [useSub]);

  // Open the "Use this API" drawer for a subscription: reveal keys + load workspaces.
  const openUse = useCallback(async (sub: SubscriptionSummary) => {
    setUseSub(sub); setUseKeys(keyCache[sub.name] || null); setMiniMsg(null);
    setMiniName(`${sub.displayName || sub.name} mini-app`);
    if (!keyCache[sub.name]) {
      try {
        const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sub.name)}/keys`, { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (j?.ok) { setUseKeys({ primaryKey: j.primaryKey, secondaryKey: j.secondaryKey }); setKeyCache((p) => ({ ...p, [sub.name]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } })); }
      } catch { /* keys optional in the drawer */ }
    }
    try {
      const r = await clientFetch('/api/loom/workspaces', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) { setWorkspaces(j.workspaces || []); if ((j.workspaces || []).length) setMiniWs(j.workspaces[0].id); }
    } catch { /* workspace list optional */ }
  }, [keyCache]);

  // Which API a subscription's scope points at (for code samples + mini-app).
  const subApi = useMemo(() => {
    if (!useSub?.scope) return null;
    const m = useSub.scope.match(/\/apis\/([^/]+)$/);
    if (!m) return null; // product- or all-APIs-scoped: no single API to target
    const apiName = decodeURIComponent(m[1]);
    const all = [...products.flatMap((p) => p.apis), ...apis];
    return all.find((a) => (a.name || a.id) === apiName) || { id: apiName, name: apiName } as ApiSummary;
  }, [useSub, products, apis]);

  // Subscriptions usable to call the selected API in the Try console: an
  // API-scoped sub matching it, an all-APIs sub, or a product-scoped sub whose
  // product contains it. Mirrors how APIM matches a key to a request.
  const trySubs = useMemo(() => {
    if (!selApi) return [] as SubscriptionSummary[];
    const apiKey = selApi.name || selApi.id;
    const productsWithApi = new Set<string>();
    for (const p of products) if (p.apis.some((a) => (a.name || a.id) === apiKey)) productsWithApi.add(p.name || p.id);
    return (subs.data || []).filter((su) => {
      const sc = su.scope || '';
      const apiM = sc.match(/\/apis\/([^/]+)$/);
      if (apiM) return decodeURIComponent(apiM[1]) === apiKey;
      if (/\/apis$/.test(sc)) return true; // all-APIs scope
      const prodM = sc.match(/\/products\/([^/]+)$/);
      if (prodM) return productsWithApi.has(decodeURIComponent(prodM[1]));
      return false;
    });
  }, [selApi, subs.data, products]);

  // Pick a subscription for the Try console: stash its sid + inject its key.
  const pickTrySub = useCallback(async (sid: string) => {
    setTSubId(sid);
    if (!sid) { setTKey(''); return; }
    const k = await ensureKey(sid);
    if (k) setTKey(k);
  }, [ensureKey]);

  const buildMiniApp = useCallback(async () => {
    if (!subApi || !miniWs) return;
    setMiniBusy(true); setMiniMsg(null);
    try {
      const r = await clientFetch('/api/marketplace/mini-app', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: miniWs, apiId: subApi.name || subApi.id, apiName: subApi.displayName || subApi.name,
          gatewayUrl: service?.gatewayUrl || '', apiPath: subApi.path || '', appName: miniName.trim(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setMiniMsg({ intent: 'error', text: j?.error || `HTTP ${r.status}` }); return; }
      setMiniMsg({ intent: 'success', text: j.message, link: j.link, linkLabel: j.linkLabel });
    } catch (e: any) { setMiniMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setMiniBusy(false); }
  }, [subApi, miniWs, miniName, service]);

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
    const matchAccess = (a: ApiSummary) =>
      accessFilter === 'all'
        ? true
        : accessFilter === 'open' ? !a.subscriptionRequired : !!a.subscriptionRequired;
    const apisF = allApis.filter((a) => matchA(a) && matchAccess(a));
    return { productsF, apisF };
  }, [products, apis, query, accessFilter]);

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
    {
      key: 'actions', label: 'Actions', width: 200, sortable: false, filterable: false,
      render: (r) => (
        <div className={s.metaRow} onClick={(e) => e.stopPropagation()}>
          <Button size="small" appearance="primary" icon={<Branch20Regular />} onClick={() => openUse(r)}>Use this API</Button>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label="More actions" />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Rename20Regular />} onClick={() => { setRenameTarget(r); setRenameValue(r.displayName || r.name); setRenameOpen(true); }}>Rename</MenuItem>
                <MenuItem icon={<Key20Regular />} onClick={() => regenKey(r, 'primary')}>Regenerate primary key</MenuItem>
                <MenuItem icon={<Key20Regular />} onClick={() => regenKey(r, 'secondary')}>Regenerate secondary key</MenuItem>
                <MenuDivider />
                {(r.state || '').toLowerCase() === 'suspended'
                  ? <MenuItem onClick={() => setSubState(r, 'active')}>Activate</MenuItem>
                  : <MenuItem onClick={() => setSubState(r, 'suspended')}>Suspend</MenuItem>}
                <MenuItem icon={<Delete20Regular />} onClick={() => deleteSub(r)}>Delete</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      ),
    },
  ], [keyCache, revealKeys, s.keysCell, s.keyLine, s.metaRow, openUse, regenKey, setSubState, deleteSub]);

  // ---------------- render ----------------
  return (
    <div className={s.root}>
      {confirmDialog}
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

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>API marketplace</MessageBarTitle>
          Publishes <strong>operational APIs</strong> fronted by Azure API Management — subscribe for a
          key, then call them over HTTP (the <code>Ocp-Apim-Subscription-Key</code> header). To discover
          governed <strong>datasets</strong> (lakehouses, warehouses, semantic models) instead, use the{' '}
          <a href="/data-products">Data marketplace</a>.
        </MessageBarBody>
      </MessageBar>

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
              <Spinner
                label={retrying ? 'Gateway is warming up — retrying…' : 'Loading catalog from API Management…'}
                labelPosition="after"
              />
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
                            onClick={(e) => { e.stopPropagation(); openSubscribe({ kind: 'product', id: p.name || p.id, name: p.displayName || p.name, approvalRequired: p.approvalRequired }); }}
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
                            onClick={(e) => { e.stopPropagation(); openSubscribe({ kind: 'product', id: r.name || r.id, name: r.displayName || r.name, approvalRequired: r.approvalRequired }); }}
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
              <Section
                title={`APIs${filtered.apisF.length ? ` (${filtered.apisF.length})` : ''}`}
                actions={
                  <Field label="Access" orientation="horizontal">
                    <Dropdown
                      style={{ minWidth: 150 }}
                      value={accessFilter === 'all' ? 'All' : accessFilter === 'open' ? 'Open (no key)' : 'Subscription required'}
                      selectedOptions={[accessFilter]}
                      onOptionSelect={(_, d) => setAccessFilter((d.optionValue as 'all' | 'open' | 'subscription') || 'all')}
                    >
                      <Option value="all">All</Option>
                      <Option value="open">Open (no key)</Option>
                      <Option value="subscription">Subscription required</Option>
                    </Dropdown>
                  </Field>
                }
              >
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
              {ops.error && <MessageBar intent="warning"><MessageBarBody>{ops.error}</MessageBarBody></MessageBar>}
              {!ops.error && (
                <LoomDataTable<Operation>
                  ariaLabel="Operations"
                  loading={ops.loading}
                  skeleton
                  columns={[
                    { key: 'method', label: 'Method', width: 110, sortable: true, filterable: true, getValue: (r) => r.method || '', render: (r) => <Badge appearance="tint">{r.method}</Badge> },
                    { key: 'name', label: 'Name', width: 240, sortable: true, filterable: true, getValue: (r) => r.displayName || r.name, render: (r) => r.displayName || r.name },
                    { key: 'url', label: 'URL template', width: 280, sortable: true, filterable: true, getValue: (r) => r.urlTemplate || '', render: (r) => <code>{r.urlTemplate}</code> },
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
              <Body1>
                Sends a real request through the APIM gateway from the Console (in-VNet), then shows the live
                status, headers, and body. For a subscription-required API, pick one of your subscriptions or
                paste a key below — it is attached as <code>Ocp-Apim-Subscription-Key</code> so the call returns
                200 instead of 401.
              </Body1>
              {selApi.subscriptionRequired && trySubs.length === 0 && !tKey.trim() && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No subscription key yet</MessageBarTitle>
                    This API requires a subscription key. Subscribe to get an active key, or paste one below.
                  </MessageBarBody>
                  <MessageBarActions>
                    <Button size="small" icon={<Add20Regular />}
                      onClick={() => openSubscribe({ kind: 'api', id: selApi.name || selApi.id, name: selApi.displayName || selApi.name })}>
                      Subscribe to this API
                    </Button>
                  </MessageBarActions>
                </MessageBar>
              )}
              <div className={s.tryGrid}>
                <Field label="Method">
                  <Dropdown value={tMethod} selectedOptions={[tMethod]} onOptionSelect={(_, d) => d.optionValue && setTMethod(d.optionValue)}>
                    {HTTP_METHODS.map((m) => <Option key={m} value={m}>{m}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="URL template (appended to the API path)">
                  <Input value={tTemplate} onChange={(_, d) => setTTemplate(d.value)} placeholder="/orders/{id}" />
                </Field>
                <Field label="Subscription (resolves its key server-side)">
                  <Dropdown
                    placeholder={trySubs.length ? 'Select a subscription' : 'No matching subscriptions'}
                    disabled={trySubs.length === 0}
                    value={trySubs.find((su) => su.name === tSubId) ? (trySubs.find((su) => su.name === tSubId)!.displayName || tSubId) : ''}
                    selectedOptions={tSubId ? [tSubId] : []}
                    onOptionSelect={(_, d) => pickTrySub(d.optionValue || '')}
                  >
                    {trySubs.map((su) => (
                      <Option key={su.name} value={su.name} text={su.displayName || su.name}>
                        {su.displayName || su.name} {su.state ? `(${su.state})` : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Subscription key (override — paste one to use it directly)">
                  <Input type="password" value={tKey} onChange={(_, d) => setTKey(d.value)} placeholder="Ocp-Apim-Subscription-Key" />
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }} aria-live="polite">
                  <div className={s.metaRow}>
                    <Badge appearance="filled" color={tResp.status < 400 ? 'success' : tResp.status < 500 ? 'warning' : 'danger'}>
                      {tResp.status} {tResp.statusText}
                    </Badge>
                    <Caption1>{tResp.headers['content-type'] || ''}</Caption1>
                    <Badge appearance="outline" icon={<Key16Regular />}>
                      key: {tResp.keySource === 'subscription' ? 'selected subscription'
                        : tResp.keySource === 'provided' ? 'pasted key'
                        : tResp.keySource === 'master' ? 'all-access (master)'
                        : 'none'}
                    </Badge>
                  </div>
                  {tResp.status === 401 && tResp.keySource === 'none' && (
                    <MessageBar intent="warning"><MessageBarBody>
                      401 — no subscription key was attached. Pick a subscription or paste a key above, then resend.
                    </MessageBarBody></MessageBar>
                  )}
                  <div className={s.respLabelRow}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response headers</Caption1>
                    <Button size="small" appearance="subtle" icon={<Copy20Regular />}
                      onClick={() => copy(Object.entries(tResp.headers).map(([k, v]) => `${k}: ${v}`).join('\n'))}>
                      Copy
                    </Button>
                  </div>
                  <div className={s.codeMeta} role="region" aria-label="Response headers">
                    {Object.entries(tResp.headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'}
                  </div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Response body</Caption1>
                  <ResponseBodyViewer body={tResp.body || ''} contentType={tResp.headers['content-type']} />
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
          {subActionMsg && <MessageBar intent={subActionMsg.intent}><MessageBarBody>{subActionMsg.text}</MessageBarBody></MessageBar>}
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

      {/* Rename subscription dialog */}
      <Dialog open={renameOpen} onOpenChange={(_, d) => setRenameOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rename subscription</DialogTitle>
            <DialogContent>
              <Field label="Display name">
                <Input value={renameValue} onChange={(_, d) => setRenameValue(d.value)} />
              </Field>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
              <Button appearance="primary" icon={<Rename20Regular />} onClick={renameSub} disabled={!renameValue.trim()}>Save</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* "Use this API" drawer — code samples + mini-app builder */}
      <Drawer type="overlay" position="end" open={!!useSub} onOpenChange={(_, d) => { if (!d.open) setUseSub(null); }} style={{ width: '520px', maxWidth: '94vw' }}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => setUseSub(null)} aria-label="Close" />}>
            Use {useSub?.displayName || useSub?.name}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {useSub && (() => {
            const base = subApi && service?.gatewayUrl ? `${service.gatewayUrl.replace(/\/+$/, '')}/${(subApi.path || '').replace(/^\/+/, '')}` : (service?.gatewayUrl || '<gateway>');
            const key = useKeys?.primaryKey || '<your-subscription-key>';
            const samples: Record<string, string> = {
              curl: `curl "${base}/" \\\n  -H "Ocp-Apim-Subscription-Key: ${key}"`,
              python: `import requests\nBASE = "${base}"\nr = requests.get(f"{BASE}/", headers={"Ocp-Apim-Subscription-Key": "${key}"})\nr.raise_for_status()\nprint(r.json())`,
              javascript: `const res = await fetch("${base}/", {\n  headers: { "Ocp-Apim-Subscription-Key": "${key}" },\n});\nconsole.log(await res.json());`,
            };
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
                <div className={s.fieldBlock}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Gateway base URL</Caption1>
                  <Body1><code>{base}</code></Body1>
                </div>
                {!subApi && (
                  <MessageBar intent="info"><MessageBarBody>This subscription is scoped to a product or all-APIs. Code samples use the gateway root; pick a specific API operation in the Catalog for full paths.</MessageBarBody></MessageBar>
                )}

                <div className={s.fieldBlock}>
                  <div className={s.metaRow}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Subscription key</Caption1>
                    {useKeys?.primaryKey && <Button size="small" icon={<Copy20Regular />} onClick={() => copy(useKeys.primaryKey!)}>Copy</Button>}
                    {useSub && <Button size="small" icon={<Key20Regular />} onClick={() => regenKey(useSub, 'primary')}>Regenerate</Button>}
                  </div>
                  <Body1><code>{useKeys?.primaryKey ? `${useKeys.primaryKey.slice(0, 10)}…` : '(hidden)'}</code></Body1>
                </div>

                <div className={s.fieldBlock}>
                  <div className={s.metaRow}>
                    <Subtitle2>Call it from code</Subtitle2>
                    <TabList selectedValue={sampleLang} onTabSelect={(_, d) => setSampleLang(d.value as 'curl' | 'python' | 'javascript')} size="small">
                      <Tab value="curl">cURL</Tab>
                      <Tab value="python">Python</Tab>
                      <Tab value="javascript">JavaScript</Tab>
                    </TabList>
                    <Button size="small" icon={<Copy20Regular />} onClick={() => copy(samples[sampleLang])}>Copy</Button>
                  </div>
                  <div className={s.code} role="region" aria-label="Code sample">{samples[sampleLang]}</div>
                </div>

                {/* Mini-app builder */}
                <div className={s.fieldBlock}>
                  <Subtitle2><Code20Regular /> Build a mini-app</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Scaffold a Loom Notebook pre-wired to call this API (Python client + the API’s operations + a starter analysis cell) — an analyst-ready mini-app you can build on.
                  </Caption1>
                  <Field label="Workspace" style={{ marginTop: tokens.spacingVerticalS }}>
                    <Dropdown
                      placeholder={workspaces.length ? 'Select a workspace' : 'No workspaces'}
                      value={workspaces.find((w) => w.id === miniWs)?.name || ''}
                      selectedOptions={miniWs ? [miniWs] : []}
                      onOptionSelect={(_, d) => setMiniWs(d.optionValue || '')}
                    >
                      {workspaces.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Mini-app name">
                    <Input value={miniName} onChange={(_, d) => setMiniName(d.value)} />
                  </Field>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={!subApi || !miniWs || miniBusy} style={{ marginTop: tokens.spacingVerticalS, alignSelf: 'flex-start' }} onClick={buildMiniApp}>
                    {miniBusy ? 'Building…' : 'Build mini-app'}
                  </Button>
                  {!subApi && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Pick an API-scoped subscription to build a mini-app.</Caption1>}
                  {miniMsg && (
                    <MessageBar intent={miniMsg.intent} style={{ marginTop: tokens.spacingVerticalS }}>
                      <MessageBarBody>
                        {miniMsg.text}
                        {miniMsg.link && <> <a href={miniMsg.link} style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>{miniMsg.linkLabel} <Open16Regular /></a></>}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              </div>
            );
          })()}
        </DrawerBody>
      </Drawer>
    </div>
  );
}
