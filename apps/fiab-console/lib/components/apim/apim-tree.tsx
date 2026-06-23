'use client';

/**
 * ApimTree — the Azure API Management "service" navigator.
 *
 * The APIM equivalent of the ADF Factory Resources / Synapse Workspace
 * Resources / Databricks Workspace panes. Collapses the Azure portal's APIM
 * left blade (APIs / Products / Named values / Backends / Subscriptions /
 * Gateways) into one typed Fluent v9 tree: one group per object type with a
 * live count, a ＋New affordance, a "Filter by name" box, a create dialog, and
 * inline delete — all on real ARM REST through the /api/apim/* BFF routes:
 *   - APIs          → /api/apim/apis           (list / create / delete; expand → operations)
 *   - Products      → /api/apim/products        (list / create / delete)
 *   - Named values  → /api/apim/named-values    (list / create / delete)
 *   - Backends      → /api/apim/backends         (list / create / delete)
 *   - Subscriptions → /api/apim/subscriptions    (list / create / delete)
 *   - Operations    → /api/apim/operations       (read-only, per API)
 *   - Gateways      → /api/apim/gateways          (read-only, self-hosted gateways)
 *
 * Selecting an API opens the existing APIM API editor (onOpenApi). "New API"
 * either opens the editor's new-API form (onNewApi) or, via the dialog, creates
 * directly from name + path + display name + optional OpenAPI link.
 *
 * Things the APIM portal exposes but we don't yet wire (policy XML editor at the
 * tree, API operations authoring, OpenAPI import wizard, revisions/versions)
 * render as honest ⚠️ "coming" rows naming what's missing and where it already
 * lives in the editor — never a fake list. No mocks.
 *
 * The APIM service is the env-pinned default (LOOM_APIM_NAME + LOOM_APIM_RG +
 * LOOM_SUBSCRIPTION_ID). When unconfigured the routes 503 and the whole tree
 * shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option, Switch,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Open16Regular,
  Code20Regular, Box20Regular, Key20Regular, Server20Regular,
  Library20Regular, Globe20Regular, Document20Regular,
  Search20Regular, Warning20Regular, LockClosed16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 260 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
});

const APIS_ROUTE = '/api/apim/apis';
const PRODUCTS_ROUTE = '/api/apim/products';
const NV_ROUTE = '/api/apim/named-values';
const BACKENDS_ROUTE = '/api/apim/backends';
const SUBS_ROUTE = '/api/apim/subscriptions';
const OPS_ROUTE = '/api/apim/operations';
const GW_ROUTE = '/api/apim/gateways';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface ApiRow { id: string; name: string; displayName: string; path: string; protocols?: string[]; subscriptionRequired?: boolean }
interface ProductRow { id: string; name: string; displayName: string; state?: string }
interface NamedValueRow { id: string; name: string; displayName: string; secret?: boolean; value?: string }
interface BackendRow { id: string; name: string; url: string; protocol?: string; title?: string }
interface SubscriptionRow { id: string; name: string; displayName?: string; scope?: string; state?: string }
interface GatewayRow { id: string; name: string; description?: string; region?: string }
interface OperationRow { id: string; name: string; displayName: string; method: string; urlTemplate: string }

type CreateGroup = 'api' | 'product' | 'namedValue' | 'backend' | 'subscription';

function productColor(state?: string) {
  return state === 'published' ? ('success' as const) : ('informative' as const);
}
function subColor(state?: string) {
  if (state === 'active') return 'success' as const;
  if (state === 'submitted') return 'warning' as const;
  return 'informative' as const;
}

export interface ApimTreeProps {
  /** Currently selected API (highlighted in the tree). */
  selectedApiName?: string | null;
  /** Open / bind a saved API in the host editor. */
  onOpenApi?: (apiName: string) => void;
  /** Start a brand-new API in the host editor's new-API form. */
  onNewApi?: () => void;
  /** Open a saved product in the product editor. */
  onOpenProduct?: (productName: string) => void;
  /** Increment to force a refresh from the parent (e.g. after a save/create). */
  refreshKey?: number;
}

export function ApimTree({
  selectedApiName = null, onOpenApi, onNewApi, onOpenProduct, refreshKey = 0,
}: ApimTreeProps) {
  const s = useStyles();

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [apis, setApis] = useState<ApiRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [namedValues, setNamedValues] = useState<NamedValueRow[]>([]);
  const [backends, setBackends] = useState<BackendRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [gateways, setGateways] = useState<GatewayRow[]>([]);

  // Per-API operations, lazy-loaded when an API branch expands.
  const [ops, setOps] = useState<Record<string, { loading: boolean; rows: OperationRow[]; error?: string }>>({});

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreateGroup | null>(null);
  const [cName, setCName] = useState('');
  const [cDisplay, setCDisplay] = useState('');
  const [cPath, setCPath] = useState('');
  const [cSpecUrl, setCSpecUrl] = useState('');
  const [cValue, setCValue] = useState('');
  const [cSecret, setCSecret] = useState(false);
  const [cUrl, setCUrl] = useState('');
  const [cProtocol, setCProtocol] = useState<'http' | 'soap'>('http');
  const [cScope, setCScope] = useState<'allApis' | 'product' | 'api'>('allApis');
  const [cTarget, setCTarget] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ar, pr, nr, br, sr, gr] = await Promise.all([
        fetch(APIS_ROUTE).then(readJson),
        fetch(PRODUCTS_ROUTE).then(readJson),
        fetch(NV_ROUTE).then(readJson),
        fetch(BACKENDS_ROUTE).then(readJson),
        fetch(SUBS_ROUTE).then(readJson),
        fetch(GW_ROUTE).then(readJson),
      ]);
      for (const b of [ar, pr, nr, br, sr, gr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (ar.ok) setApis(ar.apis || []); else setError(ar.error || 'failed to list APIs');
      if (pr.ok) setProducts(pr.products || []);
      if (nr.ok) setNamedValues(nr.namedValues || []);
      if (br.ok) setBackends(br.backends || []);
      if (sr.ok) setSubscriptions(sr.subscriptions || []);
      if (gr.ok) setGateways(gr.gateways || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  const loadOps = useCallback(async (apiName: string) => {
    setOps((cur) => ({ ...cur, [apiName]: { loading: true, rows: cur[apiName]?.rows || [] } }));
    try {
      const body = await fetch(`${OPS_ROUTE}?apiId=${encodeURIComponent(apiName)}`).then(readJson);
      if (applyGate(body)) return;
      if (!body.ok) { setOps((cur) => ({ ...cur, [apiName]: { loading: false, rows: [], error: body.error } })); return; }
      setOps((cur) => ({ ...cur, [apiName]: { loading: false, rows: body.operations || [] } }));
    } catch (e: any) {
      setOps((cur) => ({ ...cur, [apiName]: { loading: false, rows: [], error: e?.message || String(e) } }));
    }
  }, []);

  // ---------------------------------------------------------------
  // Create / delete (real REST)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreateGroup) => {
    setCreateGroup(g); setCreateError(null);
    setCName(''); setCDisplay(''); setCPath(''); setCSpecUrl('');
    setCValue(''); setCSecret(false); setCUrl(''); setCProtocol('http');
    setCScope('allApis'); setCTarget('');
  }, []);

  const submitCreate = useCallback(async () => {
    if (!createGroup) return;
    setBusy(true); setCreateError(null);
    try {
      let route = APIS_ROUTE; let payload: any = {};
      if (createGroup === 'api') {
        if (!cDisplay.trim()) { setCreateError('Display name is required.'); setBusy(false); return; }
        if (!cPath.trim()) { setCreateError('Path is required.'); setBusy(false); return; }
        route = APIS_ROUTE;
        payload = { displayName: cDisplay.trim(), path: cPath.trim(), name: cName.trim() || undefined, specUrl: cSpecUrl.trim() || undefined };
      } else if (createGroup === 'product') {
        if (!cDisplay.trim()) { setCreateError('Display name is required.'); setBusy(false); return; }
        route = PRODUCTS_ROUTE;
        payload = { displayName: cDisplay.trim(), name: cName.trim() || undefined };
      } else if (createGroup === 'namedValue') {
        if (!cDisplay.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        if (!cValue.trim()) { setCreateError('Value is required.'); setBusy(false); return; }
        route = NV_ROUTE;
        payload = { displayName: cDisplay.trim(), value: cValue, secret: cSecret };
      } else if (createGroup === 'backend') {
        if (!cUrl.trim()) { setCreateError('Runtime URL is required.'); setBusy(false); return; }
        route = BACKENDS_ROUTE;
        payload = { name: cName.trim() || undefined, url: cUrl.trim(), protocol: cProtocol, title: cDisplay.trim() || undefined };
      } else if (createGroup === 'subscription') {
        if (!cDisplay.trim()) { setCreateError('Name is required.'); setBusy(false); return; }
        if (cScope !== 'allApis' && !cTarget.trim()) { setCreateError(`${cScope === 'product' ? 'Product' : 'API'} is required for this scope.`); setBusy(false); return; }
        route = SUBS_ROUTE;
        payload = { displayName: cDisplay.trim(), scope: cScope, target: cTarget.trim() || undefined };
      }
      const res = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      setCreateGroup(null);
      await loadAll();
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, cName, cDisplay, cPath, cSpecUrl, cValue, cSecret, cUrl, cProtocol, cScope, cTarget, loadAll]);

  const del = useCallback(async (route: string, id: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${route}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n?: string) => !f || (n || '').toLowerCase().includes(f);
  const fApis = useMemo(() => apis.filter((a) => match(a.displayName) || match(a.name)), [apis, f]);
  const fProducts = useMemo(() => products.filter((p) => match(p.displayName) || match(p.name)), [products, f]);
  const fNamedValues = useMemo(() => namedValues.filter((n) => match(n.displayName)), [namedValues, f]);
  const fBackends = useMemo(() => backends.filter((b) => match(b.name) || match(b.url)), [backends, f]);
  const fSubs = useMemo(() => subscriptions.filter((x) => match(x.displayName) || match(x.name)), [subscriptions, f]);
  const fGateways = useMemo(() => gateways.filter((g) => match(g.name)), [gateways, f]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------
  const groupHeader = (
    label: string, icon: React.ReactElement, count: number,
    onAdd?: () => void, addTitle?: string,
  ) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>API Management</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>APIM service not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the Console Container App — along with{' '}
            <code>LOOM_APIM_NAME</code> (e.g. <code>apim-csa-loom-eastus2</code>) and{' '}
            <code>LOOM_APIM_RG</code> — so the Loom console can reach a real Azure API
            Management service. The navigator stays here; objects appear once the service is
            reachable. The Loom UAMI must hold the <strong>API Management Service Contributor</strong>{' '}
            role on the APIM service (granted via{' '}
            <code>scripts/csa-loom/grant-apim-rbac.sh</code>). Provisioned by the APIM bicep
            module under <code>platform/fiab/bicep/modules/**</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>API Management</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="Add new" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="Add new" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Code20Regular />} onClick={() => (onNewApi ? onNewApi() : openCreate('api'))}>API</MenuItem>
                <MenuItem icon={<Box20Regular />} onClick={() => openCreate('product')}>Product</MenuItem>
                <MenuItem icon={<Key20Regular />} onClick={() => openCreate('namedValue')}>Named value</MenuItem>
                <MenuItem icon={<Server20Regular />} onClick={() => openCreate('backend')}>Backend</MenuItem>
                <MenuItem icon={<Library20Regular />} onClick={() => openCreate('subscription')}>Subscription</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh APIM" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading APIM…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>APIM error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="API Management service" defaultOpenItems={['g-apis']}>
          {/* APIs (expand → operations) */}
          <TreeItem itemType="branch" value="g-apis">
            {groupHeader('APIs', <Code20Regular />, apis.length, () => (onNewApi ? onNewApi() : openCreate('api')), 'New API')}
            <Tree>
              {fApis.length === 0 && <TreeItem itemType="leaf" value="a-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No APIs'}</Caption1></TreeItemLayout></TreeItem>}
              {fApis.map((a) => {
                const opState = ops[a.name];
                return (
                  <TreeItem
                    key={a.name}
                    itemType="branch"
                    value={`a-${a.name}`}
                    onOpenChange={(_, d) => { if (d.open && !opState) loadOps(a.name); }}
                  >
                    <TreeItemLayout iconBefore={<Code20Regular />}>
                      <span className={s.leafRow}>
                        <span
                          role="button" tabIndex={0}
                          style={{ cursor: onOpenApi ? 'pointer' : undefined, fontWeight: selectedApiName === a.name ? tokens.fontWeightSemibold : undefined }}
                          onClick={(e) => { e.stopPropagation(); onOpenApi?.(a.name); }}
                          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenApi) { e.preventDefault(); onOpenApi(a.name); } }}
                        >
                          {a.displayName || a.name}
                        </span>
                        <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                          <Caption1>/{a.path}</Caption1>
                          {a.subscriptionRequired === false && <Badge size="small" appearance="outline">open</Badge>}
                          {onOpenApi && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenApi(a.name)} aria-label={`Open ${a.displayName}`} /></Tooltip>}
                          <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(APIS_ROUTE, a.name)} aria-label={`Delete ${a.displayName}`} /></Tooltip>
                        </span>
                      </span>
                    </TreeItemLayout>
                    <Tree>
                      {opState?.loading && <TreeItem itemType="leaf" value={`op-${a.name}-l`}><TreeItemLayout><Caption1>Loading operations…</Caption1></TreeItemLayout></TreeItem>}
                      {opState && !opState.loading && opState.rows.length === 0 && (
                        <TreeItem itemType="leaf" value={`op-${a.name}-e`}><TreeItemLayout><Caption1>{opState.error || 'No operations'}</Caption1></TreeItemLayout></TreeItem>
                      )}
                      {(opState?.rows || []).map((op) => (
                        <TreeItem key={op.id || op.name} itemType="leaf" value={`op-${a.name}-${op.name}`}>
                          <TreeItemLayout iconBefore={<Document20Regular />}>
                            <span><strong>{op.method}</strong> {op.urlTemplate} <Caption1>· {op.displayName}</Caption1></span>
                          </TreeItemLayout>
                        </TreeItem>
                      ))}
                    </Tree>
                  </TreeItem>
                );
              })}
            </Tree>
          </TreeItem>

          {/* Products */}
          <TreeItem itemType="branch" value="g-products">
            {groupHeader('Products', <Box20Regular />, products.length, () => openCreate('product'), 'New product')}
            <Tree>
              {fProducts.length === 0 && <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No products'}</Caption1></TreeItemLayout></TreeItem>}
              {fProducts.map((p) => (
                <TreeItem key={p.name} itemType="leaf" value={`p-${p.name}`}>
                  <TreeItemLayout iconBefore={<Box20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0}
                        style={{ cursor: onOpenProduct ? 'pointer' : undefined }}
                        onClick={() => onOpenProduct?.(p.name)}
                        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onOpenProduct) { e.preventDefault(); onOpenProduct(p.name); } }}
                      >
                        {p.displayName || p.name}
                      </span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Badge size="small" appearance="filled" color={productColor(p.state)}>{p.state === 'published' ? 'published' : 'draft'}</Badge>
                        {onOpenProduct && <Tooltip content="Open" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => onOpenProduct(p.name)} aria-label={`Open ${p.displayName}`} /></Tooltip>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(PRODUCTS_ROUTE, p.name)} aria-label={`Delete ${p.displayName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Named values */}
          <TreeItem itemType="branch" value="g-namedvalues">
            {groupHeader('Named values', <Key20Regular />, namedValues.length, () => openCreate('namedValue'), 'New named value')}
            <Tree>
              {fNamedValues.length === 0 && <TreeItem itemType="leaf" value="nv-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No named values'}</Caption1></TreeItemLayout></TreeItem>}
              {fNamedValues.map((n) => (
                <TreeItem key={n.name} itemType="leaf" value={`nv-${n.name}`}>
                  <TreeItemLayout iconBefore={n.secret ? <LockClosed16Regular /> : <Key20Regular />}>
                    <span className={s.leafRow}>
                      <span>{n.displayName}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {n.secret ? <Badge size="small" appearance="tint" color="warning">secret</Badge> : <Caption1 style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.value}</Caption1>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(NV_ROUTE, n.name)} aria-label={`Delete ${n.displayName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Backends */}
          <TreeItem itemType="branch" value="g-backends">
            {groupHeader('Backends', <Server20Regular />, backends.length, () => openCreate('backend'), 'New backend')}
            <Tree>
              {fBackends.length === 0 && <TreeItem itemType="leaf" value="b-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No backends'}</Caption1></TreeItemLayout></TreeItem>}
              {fBackends.map((b) => (
                <TreeItem key={b.name} itemType="leaf" value={`b-${b.name}`}>
                  <TreeItemLayout iconBefore={<Server20Regular />}>
                    <span className={s.leafRow}>
                      <span>{b.title || b.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {b.protocol && <Badge size="small" appearance="outline">{b.protocol}</Badge>}
                        <Caption1 style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.url}</Caption1>
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(BACKENDS_ROUTE, b.name)} aria-label={`Delete ${b.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Subscriptions */}
          <TreeItem itemType="branch" value="g-subscriptions">
            {groupHeader('Subscriptions', <Library20Regular />, subscriptions.length, () => openCreate('subscription'), 'New subscription')}
            <Tree>
              {fSubs.length === 0 && <TreeItem itemType="leaf" value="s-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No subscriptions'}</Caption1></TreeItemLayout></TreeItem>}
              {fSubs.map((x) => (
                <TreeItem key={x.name} itemType="leaf" value={`s-${x.name}`}>
                  <TreeItemLayout iconBefore={<Library20Regular />}>
                    <span className={s.leafRow}>
                      <span>{x.displayName || x.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {x.state && <Badge size="small" appearance="filled" color={subColor(x.state)}>{x.state}</Badge>}
                        <Tooltip content="Delete" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(SUBS_ROUTE, x.name)} aria-label={`Delete ${x.displayName || x.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Gateways (read-only) */}
          <TreeItem itemType="branch" value="g-gateways">
            {groupHeader('Gateways', <Globe20Regular />, gateways.length, undefined)}
            <Tree>
              {fGateways.length === 0 && <TreeItem itemType="leaf" value="gw-empty"><TreeItemLayout><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{f ? 'No matches' : 'Managed gateway only — self-hosted gateways require the Premium (or Developer self-hosted) tier; this instance exposes only the built-in managed gateway.'}</Caption1></TreeItemLayout></TreeItem>}
              {fGateways.map((g) => (
                <TreeItem key={g.name} itemType="leaf" value={`gw-${g.name}`}>
                  <TreeItemLayout iconBefore={<Globe20Regular />}>
                    <span className={s.leafRow}>
                      <span>{g.name}</span>
                      <span className={s.leafActions}>
                        {g.region && <Badge size="small" appearance="tint">{g.region}</Badge>}
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest "coming" rows — APIM exposes these; the editor wires some, the
              tree-level affordance is not built yet. Never a fake list. */}
          <TreeItem itemType="branch" value="g-coming">
            <TreeItemLayout iconBefore={<Warning20Regular />}>More (in the editor / coming)</TreeItemLayout>
            <Tree>
              {[
                [‘Policy XML editor’, ‘Global / API / product policy XML — open the APIM policy editor from the API editor’s "Open policy editor" action. Full XML editing, snippet gallery, scope selector, validation, and save are live.’],
                [‘API operations authoring’, ‘Add/edit/delete operations with parameters + per-operation policy. Today operations are imported via the OpenAPI document in the API editor; manual authoring is coming.’],
                [‘OpenAPI import wizard’, ‘Multi-step import (validate + map + preview) — today ＋New API takes an OpenAPI link inline, and the editor has full inline/link/WSDL/GraphQL import.’],
                [‘Revisions & versions’, ‘API revisions + version sets — revisions are fully live in the API editor’s Revisions tab (list, create, release); a tree-level version-set view is coming.’],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`coming-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Create dialog */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'api' ? 'API'
                : createGroup === 'product' ? 'product'
                : createGroup === 'namedValue' ? 'named value'
                : createGroup === 'backend' ? 'backend'
                : 'subscription'}
            </DialogTitle>
            <DialogContent>
              {createGroup === 'api' && (
                <>
                  <Field label="Display name" required>
                    <Input value={cDisplay} onChange={(_, d) => setCDisplay(d.value)} placeholder="Orders API" />
                  </Field>
                  <Field label="Name (id)" hint="Optional — slugged from display name when blank" style={{ marginTop: 8 }}>
                    <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="orders-api" />
                  </Field>
                  <Field label="API URL suffix (path)" required hint="After the gateway host, e.g. 'orders'" style={{ marginTop: 8 }}>
                    <Input value={cPath} onChange={(_, d) => setCPath(d.value)} placeholder="orders" />
                  </Field>
                  <Field label="OpenAPI spec URL" hint="Optional — imports operations from the spec" style={{ marginTop: 8 }}>
                    <Input value={cSpecUrl} onChange={(_, d) => setCSpecUrl(d.value)} placeholder="https://example.com/openapi.json" />
                  </Field>
                </>
              )}
              {createGroup === 'product' && (
                <>
                  <Field label="Display name" required>
                    <Input value={cDisplay} onChange={(_, d) => setCDisplay(d.value)} placeholder="Starter" />
                  </Field>
                  <Field label="Name (id)" hint="Optional — slugged from display name when blank" style={{ marginTop: 8 }}>
                    <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="starter" />
                  </Field>
                  <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                    Created in <strong>draft (not published)</strong>. Add APIs and publish in the product editor.
                  </Caption1>
                </>
              )}
              {createGroup === 'namedValue' && (
                <>
                  <Field label="Name" required hint="Letters, digits, dash, dot, underscore">
                    <Input value={cDisplay} onChange={(_, d) => setCDisplay(d.value)} placeholder="backend-url" />
                  </Field>
                  <Field label="Value" required style={{ marginTop: 8 }}>
                    <Input type={cSecret ? 'password' : 'text'} value={cValue} onChange={(_, d) => setCValue(d.value)} placeholder="https://backend.example.com" />
                  </Field>
                  <Switch checked={cSecret} onChange={(_, d) => setCSecret(d.checked)} label="Secret (encrypt, hide value)" style={{ marginTop: 8 }} />
                </>
              )}
              {createGroup === 'backend' && (
                <>
                  <Field label="Runtime URL" required>
                    <Input value={cUrl} onChange={(_, d) => setCUrl(d.value)} placeholder="https://backend.example.com" />
                  </Field>
                  <Field label="Title" hint="Optional friendly name" style={{ marginTop: 8 }}>
                    <Input value={cDisplay} onChange={(_, d) => setCDisplay(d.value)} placeholder="Orders backend" />
                  </Field>
                  <Field label="Name (id)" hint="Optional — slugged from title/URL when blank" style={{ marginTop: 8 }}>
                    <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="orders-backend" />
                  </Field>
                  <Field label="Protocol" style={{ marginTop: 8 }}>
                    <Dropdown value={cProtocol} selectedOptions={[cProtocol]} onOptionSelect={(_, d) => setCProtocol((d.optionValue as 'http' | 'soap') || 'http')}>
                      <Option value="http">http (REST)</Option>
                      <Option value="soap">soap</Option>
                    </Dropdown>
                  </Field>
                </>
              )}
              {createGroup === 'subscription' && (
                <>
                  <Field label="Name" required>
                    <Input value={cDisplay} onChange={(_, d) => setCDisplay(d.value)} placeholder="Partner subscription" />
                  </Field>
                  <Field label="Scope" style={{ marginTop: 8 }}>
                    <Dropdown value={cScope} selectedOptions={[cScope]} onOptionSelect={(_, d) => { setCScope((d.optionValue as typeof cScope) || 'allApis'); setCTarget(''); }}>
                      <Option value="allApis">All APIs</Option>
                      <Option value="product">Product</Option>
                      <Option value="api">Single API</Option>
                    </Dropdown>
                  </Field>
                  {cScope === 'product' && (
                    <Field label="Product" required style={{ marginTop: 8 }}>
                      <Dropdown placeholder="Select a product" value={products.find((p) => p.name === cTarget)?.displayName || cTarget} selectedOptions={cTarget ? [cTarget] : []} onOptionSelect={(_, d) => setCTarget(d.optionValue || '')}>
                        {products.map((p) => <Option key={p.name} value={p.name}>{p.displayName} ({p.name})</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {cScope === 'api' && (
                    <Field label="API" required style={{ marginTop: 8 }}>
                      <Dropdown placeholder="Select an API" value={apis.find((a) => a.name === cTarget)?.displayName || cTarget} selectedOptions={cTarget ? [cTarget] : []} onOptionSelect={(_, d) => setCTarget(d.optionValue || '')}>
                        {apis.map((a) => <Option key={a.name} value={a.name}>{a.displayName} ({a.name})</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                    Created <strong>active</strong> (admin-minted, no developer-portal approval).
                  </Caption1>
                </>
              )}
              {createError && <MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
