'use client';

// product-editor.tsx — ApimProductEditor + its private types, extracted
// verbatim from apim-editors.tsx (WS-E1 decomposition).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Switch, Dropdown, Option, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Tooltip,
  tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, ArrowSync20Regular, Copy20Regular,
  Document20Regular, Code20Regular, Add20Regular, Delete20Regular,
  Eye20Regular, EyeOff20Regular, Key20Regular, Play20Regular, Warning20Filled,
  ChevronDown16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { useStyles } from './styles';
import { StatusBar, type LoadState } from './shared';

interface ApimProduct {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  subscriptionRequired?: boolean;
  approvalRequired?: boolean;
  state?: string;
}

export function ApimProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const isNew = id === 'new';
  const [product, setProduct] = useState<LoadState<ApimProduct>>({ loading: !isNew, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<'published' | 'notPublished'>('notPublished');
  const [subscriptionRequired, setSubscriptionRequired] = useState(true);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Tabs: Settings | APIs | Subscriptions
  const [tab, setTab] = useState<'settings' | 'apis' | 'subs'>('settings');

  // APIs-in-product.
  const [apis, setApis] = useState<LoadState<{ productApis: any[]; allApis: any[] }>>({ loading: false, data: null });
  const [addApiId, setAddApiId] = useState('');
  const [apiBusy, setApiBusy] = useState(false);
  const [apiMsg, setApiMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Subscriptions.
  const [subs, setSubs] = useState<LoadState<any[]>>({ loading: false, data: null });
  // Per-subscription key reveal. APIM never returns keys on GET; the real
  // POST /api/marketplace/subscriptions/[sid]/keys route resolves them via
  // listSecrets server-side. Keyed by subscription name; cleared on tab leave.
  const [subKeys, setSubKeys] = useState<Record<string, { primaryKey?: string; secondaryKey?: string }>>({});
  const [subKeyBusy, setSubKeyBusy] = useState<string | null>(null);
  const [subKeyErr, setSubKeyErr] = useState<{ sid: string; msg: string } | null>(null);
  // Subscription state transitions (Suspend / Activate / Cancel) — real ARM
  // PATCH .../subscriptions/{sid} via /api/marketplace/subscriptions/[sid].
  const [subStateBusy, setSubStateBusy] = useState<string | null>(null);
  const [subStateErr, setSubStateErr] = useState<{ sid: string; msg: string } | null>(null);
  // Key regeneration — real ARM POST regenerate{Primary,Secondary}Key + listSecrets
  // via /api/marketplace/subscriptions/[sid]/keys/regenerate?which=...
  const [subRegenBusy, setSubRegenBusy] = useState<{ sid: string; which: 'primary' | 'secondary' } | null>(null);
  // Confirmation gate for destructive ops (Cancel subscription / regenerate key).
  // Both immediately revoke access, so they mirror the portal's confirm dialog
  // rather than firing on a single click.
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState<{ sid: string; which: 'primary' | 'secondary' } | null>(null);

  const revealSubKeys = useCallback(async (sid: string) => {
    // Toggle off if already revealed.
    if (subKeys[sid]) { setSubKeys((cur) => { const n = { ...cur }; delete n[sid]; return n; }); return; }
    setSubKeyBusy(sid); setSubKeyErr(null);
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sid)}/keys`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setSubKeyErr({ sid, msg: j.error || `HTTP ${r.status}` }); return; }
      setSubKeys((cur) => ({ ...cur, [sid]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
    } catch (e: any) { setSubKeyErr({ sid, msg: e?.message || String(e) }); }
    finally { setSubKeyBusy(null); }
  }, [subKeys]);

  // Suspend / Activate / Cancel — real ARM PATCH .../subscriptions/{sid} (If-Match:*).
  // The BFF returns the updated SubscriptionContract; we patch the row in place.
  const changeSubState = useCallback(async (sid: string, newState: 'active' | 'suspended' | 'cancelled') => {
    setSubStateBusy(sid); setSubStateErr(null);
    try {
      const r = await clientFetch(`/api/marketplace/subscriptions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: newState }),
      });
      const j = await r.json();
      if (!j.ok) { setSubStateErr({ sid, msg: j.error || `HTTP ${r.status}` }); return; }
      const resolved = j.subscription?.state ?? newState;
      setSubs((cur) => ({
        ...cur,
        data: (cur.data || []).map((s: any) => (s.name === sid ? { ...s, state: resolved } : s)),
      }));
    } catch (e: any) { setSubStateErr({ sid, msg: e?.message || String(e) }); }
    finally { setSubStateBusy(null); }
  }, []);

  // Regenerate a subscription key — real ARM POST regenerate{Primary,Secondary}Key,
  // then listSecrets so the fresh value is shown immediately (old key is revoked).
  const regenKey = useCallback(async (sid: string, which: 'primary' | 'secondary') => {
    setSubRegenBusy({ sid, which }); setSubKeyErr(null);
    try {
      const r = await clientFetch(
        `/api/marketplace/subscriptions/${encodeURIComponent(sid)}/keys/regenerate?which=${which}`,
        { method: 'POST' },
      );
      const j = await r.json();
      if (!j.ok) { setSubKeyErr({ sid, msg: j.error || `HTTP ${r.status}` }); return; }
      // Reveal-in-place: update both keys (listSecrets returns the full pair).
      setSubKeys((cur) => ({ ...cur, [sid]: { primaryKey: j.primaryKey, secondaryKey: j.secondaryKey } }));
    } catch (e: any) { setSubKeyErr({ sid, msg: e?.message || String(e) }); }
    finally { setSubRegenBusy(null); }
  }, []);

  const loadApis = useCallback(async () => {
    if (isNew) return;
    setApis({ loading: true, data: null });
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}/apis`);
      const j = await r.json();
      if (!j.ok) { setApis({ loading: false, data: null, error: j.error }); return; }
      setApis({ loading: false, data: { productApis: j.productApis || [], allApis: j.allApis || [] } });
    } catch (e: any) { setApis({ loading: false, data: null, error: e?.message || String(e) }); }
  }, [id, isNew]);

  const loadSubs = useCallback(async () => {
    if (isNew) return;
    setSubs({ loading: true, data: null });
    setSubKeys({}); setSubKeyErr(null); // re-conceal keys on every reload
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}/subscriptions`);
      const j = await r.json();
      if (!j.ok) { setSubs({ loading: false, data: null, error: j.error }); return; }
      setSubs({ loading: false, data: j.subscriptions || [] });
    } catch (e: any) { setSubs({ loading: false, data: null, error: e?.message || String(e) }); }
  }, [id, isNew]);

  useEffect(() => { if (tab === 'apis') loadApis(); if (tab === 'subs') loadSubs(); }, [tab, loadApis, loadSubs]);

  const addApi = useCallback(async () => {
    if (!addApiId) return;
    setApiBusy(true); setApiMsg(null);
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}/apis`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiId: addApiId }),
      });
      const j = await r.json();
      if (!j.ok) { setApiMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setApis((cur) => ({ loading: false, data: { productApis: j.productApis || [], allApis: cur.data?.allApis || [] } }));
      setApiMsg({ intent: 'success', text: `Added ${addApiId} to the product.` });
      setAddApiId('');
    } catch (e: any) { setApiMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setApiBusy(false); }
  }, [id, addApiId]);

  const removeApi = useCallback(async (apiName: string) => {
    setApiBusy(true); setApiMsg(null);
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}/apis?apiId=${encodeURIComponent(apiName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setApiMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setApis((cur) => ({ loading: false, data: { productApis: j.productApis || [], allApis: cur.data?.allApis || [] } }));
      setApiMsg({ intent: 'success', text: `Removed ${apiName}.` });
    } catch (e: any) { setApiMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setApiBusy(false); }
  }, [id]);

  const load = useCallback(async () => {
    if (isNew) return;
    setProduct({ loading: true, data: null });
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setProduct({ loading: false, data: null, error: j.error || 'Failed to load' }); return; }
      setProduct({ loading: false, data: j.product });
      setDisplayName(j.product.displayName || '');
      setDescription(j.product.description || '');
      setState((j.product.state as any) || 'notPublished');
      setSubscriptionRequired(j.product.subscriptionRequired ?? true);
      setApprovalRequired(j.product.approvalRequired ?? false);
      setDirty(false);
    } catch (e: any) {
      setProduct({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, isNew]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    if (!displayName.trim()) { setStatus({ kind: 'err', msg: 'displayName is required' }); return; }
    setStatus({ kind: 'saving' });
    // Phase 4.5 — snapshot body before await so the user can keep typing
    // without the request landing on bytes that differ from what we sent.
    const body = { displayName, description, state, subscriptionRequired, approvalRequired };
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `${j.product.displayName} (${j.product.state}) at ${new Date().toLocaleTimeString()}` });
      setProduct({ loading: false, data: j.product });
      setDirty(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, displayName, description, state, subscriptionRequired, approvalRequired]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && displayName.trim()) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, displayName, save]);

  // Ribbon — Save / Reload wire to inline handlers; Publish/Unpublish flip the
  // lifecycle state and re-save in one click.
  const publishToggle = useCallback(async (next: 'published' | 'notPublished') => {
    setState(next);
    setDirty(true);
    // Defer save to next tick so React commits the state change before we read
    // it from closure. The save() above captures `state` via closure, so we
    // can't just await save() — instead we hand-roll a parallel PUT here that
    // takes the override.
    setStatus({ kind: 'saving' });
    try {
      const r = await clientFetch(`/api/items/apim-product/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, description, state: next, subscriptionRequired, approvalRequired }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `${j.product.displayName} (${j.product.state}) at ${new Date().toLocaleTimeString()}` });
      setProduct({ loading: false, data: j.product });
      setDirty(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, displayName, description, subscriptionRequired, approvalRequired]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Product', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && (isNew || dirty) && displayName.trim() ? save : undefined, disabled: status.kind === 'saving' || (!isNew && !dirty) || !displayName.trim(), title: !displayName.trim() ? 'displayName is required' : (!dirty && !isNew ? 'No unsaved changes' : undefined) },
        { label: 'Reload', onClick: !isNew ? load : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
      ]},
      { label: 'Lifecycle', actions: [
        { label: 'Publish', onClick: status.kind !== 'saving' && state !== 'published' && displayName.trim() ? () => publishToggle('published') : undefined, disabled: status.kind === 'saving' || state === 'published' || !displayName.trim(), title: state === 'published' ? 'Already published' : (!displayName.trim() ? 'displayName is required' : undefined) },
        { label: 'Unpublish', onClick: status.kind !== 'saving' && state === 'published' ? () => publishToggle('notPublished') : undefined, disabled: status.kind === 'saving' || state !== 'published', title: state !== 'published' ? 'Already not published' : undefined },
      ]},
      { label: 'Configure', actions: [
        { label: 'APIs', onClick: !isNew ? () => setTab('apis') : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
        { label: 'Subscriptions', onClick: !isNew ? () => setTab('subs') : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
        { label: 'Product policy', onClick: !isNew ? () => router.push(`/items/apim-policy/${encodeURIComponent(id)}?scope=product&productId=${encodeURIComponent(id)}`) : undefined, disabled: isNew, title: isNew ? 'Save the product first' : undefined },
      ]},
    ]},
  ], [status.kind, isNew, dirty, displayName, save, load, state, publishToggle, router, id]);
  useRegisterRibbonCommands(ribbon, item.slug);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} commandSearch main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">APIM Product</Badge>
          <Badge appearance="outline">{product.data?.name || id}</Badge>
          {product.data?.state && (
            <Badge appearance="outline" color={product.data.state === 'published' ? 'success' : 'informative'}>
              {product.data.state}
            </Badge>
          )}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={status.kind === 'saving' || (!isNew && !dirty)}>
            {status.kind === 'saving' ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
        </div>
        <StatusBar status={status} />
        {product.loading && <Spinner size="small" label="Loading product…" labelPosition="after" />}
        {product.error && !product.loading && (
          <BackendStateBar error={product.error} title="APIM Product" />
        )}

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
          <Tab value="settings" icon={<Document20Regular />}>Settings</Tab>
          <Tab value="apis" icon={<Code20Regular />} disabled={isNew}>APIs</Tab>
          <Tab value="subs" icon={<Key20Regular />} disabled={isNew}>Subscriptions</Tab>
        </TabList>

        {tab === 'settings' && (
          <div className={s.form}>
            <Field label="Display name" required>
              <Input value={displayName} onChange={(_, d) => { setDisplayName(d.value); setDirty(true); }} />
            </Field>
            <Field label="Lifecycle state">
              <Dropdown
                value={state}
                selectedOptions={[state]}
                onOptionSelect={(_, d) => { if (d.optionValue) { setState(d.optionValue as 'published' | 'notPublished'); setDirty(true); } }}
              >
                <Option value="notPublished">Not published</Option>
                <Option value="published">Published</Option>
              </Dropdown>
            </Field>
            <div style={{ gridColumn: '1 / span 2' }}>
              <Field label="Description" hint="Shown in the developer portal">
                <Textarea value={description} onChange={(_, d) => { setDescription(d.value); setDirty(true); }} rows={4} />
              </Field>
            </div>
            <Field label="Subscription required">
              <Switch checked={subscriptionRequired} onChange={(_, d) => { setSubscriptionRequired(d.checked); setDirty(true); }} label={subscriptionRequired ? 'Yes' : 'No'} />
            </Field>
            <Field label="Approval required" hint="Only meaningful when subscription is required">
              <Switch checked={approvalRequired} onChange={(_, d) => { setApprovalRequired(d.checked); setDirty(true); }} disabled={!subscriptionRequired} label={approvalRequired ? 'Yes' : 'No'} />
            </Field>
          </div>
        )}

        {tab === 'apis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Add an API to this product" style={{ minWidth: 280 }}>
                <Dropdown
                  placeholder={apis.loading ? 'Loading…' : 'Select an API'}
                  value={(apis.data?.allApis || []).find((a: any) => a.name === addApiId)?.displayName || addApiId}
                  selectedOptions={addApiId ? [addApiId] : []}
                  onOptionSelect={(_, d) => setAddApiId(d.optionValue || '')}
                >
                  {(apis.data?.allApis || []).map((a: any) => <Option key={a.name} value={a.name}>{`${a.displayName} (${a.name})`}</Option>)}
                </Dropdown>
              </Field>
              <Button appearance="primary" icon={<Add20Regular />} onClick={addApi} disabled={apiBusy || !addApiId}>Add</Button>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadApis}>Reload</Button>
            </div>
            {apiMsg && <MessageBar intent={apiMsg.intent}><MessageBarBody>{apiMsg.text}</MessageBarBody></MessageBar>}
            {apis.loading && <Spinner size="tiny" label="Loading product APIs…" labelPosition="after" />}
            {apis.error && <MessageBar intent="warning"><MessageBarBody>{apis.error}</MessageBarBody></MessageBar>}
            {apis.data && (
              <Table size="small" aria-label="Product APIs">
                <TableHeader><TableRow>
                  <TableHeaderCell>API</TableHeaderCell>
                  <TableHeaderCell>Path</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow></TableHeader>
                <TableBody>
                  {apis.data.productApis.length === 0 && (
                    <TableRow><TableCell>No APIs in this product yet.</TableCell><TableCell /><TableCell /></TableRow>
                  )}
                  {apis.data.productApis.map((a: any) => (
                    <TableRow key={a.name}>
                      <TableCell><strong>{a.displayName}</strong> <Caption1>· {a.name}</Caption1></TableCell>
                      <TableCell><code style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{a.path}</code></TableCell>
                      <TableCell><Button size="small" icon={<Delete20Regular />} onClick={() => removeApi(a.name)} disabled={apiBusy}>Remove</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {tab === 'subs' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadSubs}>Reload</Button>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Subscriptions scoped to this product. Use <strong>Show keys</strong> to reveal the primary/secondary key (resolved server-side via listSecrets — keys never persist in the browser).
              </Caption1>
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Click a subscription&apos;s <strong>state badge</strong> to Suspend, Activate, or Cancel it (real ARM <code>PATCH .../subscriptions/&#123;sid&#125;</code>).
              {' '}Use <strong>Regen</strong> next to a revealed key to rotate it — the old key is revoked immediately
              (<code>regeneratePrimaryKey</code>/<code>regenerateSecondaryKey</code> + <code>listSecrets</code>).
            </Caption1>
            {subs.loading && <Spinner size="tiny" label="Loading subscriptions…" labelPosition="after" />}
            {subs.error && <MessageBar intent="warning"><MessageBarBody>{subs.error}</MessageBarBody></MessageBar>}
            {subs.data && (
              <Table size="small" aria-label="Subscriptions">
                <TableHeader><TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Display name</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>Keys</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {subs.data.length === 0 && (
                    <TableRow><TableCell>No subscriptions to this product.</TableCell><TableCell /><TableCell /><TableCell /><TableCell /></TableRow>
                  )}
                  {subs.data.map((sub: any) => {
                    const revealed = subKeys[sub.name];
                    return (
                      <TableRow key={sub.name}>
                        <TableCell><code style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{sub.name}</code></TableCell>
                        <TableCell>{sub.displayName || '—'}</TableCell>
                        <TableCell>
                          {['active', 'suspended'].includes(sub.state) ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, alignItems: 'flex-start' }}>
                              <Menu>
                                <MenuTrigger disableButtonEnhancement>
                                  <Tooltip content="Change subscription state" relationship="label">
                                    <Badge
                                      appearance="outline"
                                      color={sub.state === 'active' ? 'success' : 'warning'}
                                      style={{ cursor: 'pointer' }}
                                      icon={subStateBusy === sub.name ? <Spinner size="extra-tiny" /> : <ChevronDown16Regular />}
                                      iconPosition="after"
                                    >
                                      {sub.state}
                                    </Badge>
                                  </Tooltip>
                                </MenuTrigger>
                                <MenuPopover>
                                  <MenuList>
                                    {sub.state === 'suspended' && (
                                      <MenuItem icon={<Play20Regular />} disabled={subStateBusy === sub.name} onClick={() => changeSubState(sub.name, 'active')}>Activate</MenuItem>
                                    )}
                                    {sub.state === 'active' && (
                                      <MenuItem icon={<Warning20Filled />} disabled={subStateBusy === sub.name} onClick={() => changeSubState(sub.name, 'suspended')}>Suspend</MenuItem>
                                    )}
                                    <MenuItem icon={<Delete20Regular />} disabled={subStateBusy === sub.name} onClick={() => setConfirmCancel(sub.name)}>Cancel</MenuItem>
                                  </MenuList>
                                </MenuPopover>
                              </Menu>
                              {subStateErr && subStateErr.sid === sub.name && (
                                <MessageBar intent="error" style={{ maxWidth: 280 }}>
                                  <MessageBarBody>{subStateErr.msg}</MessageBarBody>
                                </MessageBar>
                              )}
                            </div>
                          ) : (
                            <Badge appearance="outline" color="informative">{sub.state || '—'}</Badge>
                          )}
                        </TableCell>
                        <TableCell>{sub.createdDate || '—'}</TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                            <Button
                              size="small"
                              icon={revealed ? <EyeOff20Regular /> : <Eye20Regular />}
                              onClick={() => revealSubKeys(sub.name)}
                              disabled={subKeyBusy === sub.name}
                              aria-label={revealed ? `Hide keys for ${sub.name}` : `Show keys for ${sub.name}`}
                            >
                              {subKeyBusy === sub.name ? 'Revealing…' : revealed ? 'Hide keys' : 'Show keys'}
                            </Button>
                            {subKeyErr && subKeyErr.sid === sub.name && (
                              <MessageBar intent="error" style={{ maxWidth: 320 }}>
                                <MessageBarBody>{subKeyErr.msg}</MessageBarBody>
                              </MessageBar>
                            )}
                            {revealed && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                                {(['primaryKey', 'secondaryKey'] as const).map((k) => (
                                  <div key={k} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                                    <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 64 }}>{k === 'primaryKey' ? 'Primary' : 'Secondary'}</Caption1>
                                    <code style={{ fontSize: tokens.fontSizeBase100, wordBreak: 'break-all', maxWidth: 240 }}>{revealed[k] || '—'}</code>
                                    {revealed[k] && (
                                      <Button size="small" appearance="transparent" icon={<Copy20Regular />} aria-label={`Copy ${k === 'primaryKey' ? 'primary' : 'secondary'} key`} onClick={() => navigator.clipboard?.writeText(revealed[k]!).catch(() => {})} />
                                    )}
                                    {(() => {
                                      const which = k === 'primaryKey' ? 'primary' : 'secondary';
                                      const busy = !!subRegenBusy && subRegenBusy.sid === sub.name && subRegenBusy.which === which;
                                      return (
                                        <Tooltip content={`Rotate the ${which} key — the current value is revoked immediately`} relationship="label">
                                          <Button
                                            size="small"
                                            appearance="transparent"
                                            icon={busy ? <Spinner size="extra-tiny" /> : <ArrowSync20Regular />}
                                            disabled={!!subRegenBusy}
                                            aria-label={`Regenerate ${which} key for ${sub.name}`}
                                            onClick={() => setConfirmRegen({ sid: sub.name, which })}
                                          >
                                            {busy ? 'Regenerating…' : 'Regen'}
                                          </Button>
                                        </Tooltip>
                                      );
                                    })()}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            {/* Confirm: Cancel subscription (irreversible — revokes the consumer's access). */}
            <Dialog open={!!confirmCancel} onOpenChange={(_, d) => { if (!d.open) setConfirmCancel(null); }}>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Cancel subscription?</DialogTitle>
                  <DialogContent>
                    <Body1>
                      Cancelling <code>{confirmCancel}</code> immediately revokes the consumer&apos;s access through
                      both keys. This calls real ARM (<code>PATCH .../subscriptions/&#123;sid&#125;</code> with
                      {' '}<code>state: cancelled</code>) and cannot be undone from here.
                    </Body1>
                  </DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Keep subscription</Button>
                    </DialogTrigger>
                    <Button
                      appearance="primary"
                      icon={<Delete20Regular />}
                      onClick={() => { const sid = confirmCancel; setConfirmCancel(null); if (sid) changeSubState(sid, 'cancelled'); }}
                    >
                      Cancel subscription
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Confirm: Regenerate key (irreversible — the current key is revoked immediately). */}
            <Dialog open={!!confirmRegen} onOpenChange={(_, d) => { if (!d.open) setConfirmRegen(null); }}>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Regenerate {confirmRegen?.which} key?</DialogTitle>
                  <DialogContent>
                    <Body1>
                      Rotating the {confirmRegen?.which} key for <code>{confirmRegen?.sid}</code> revokes the current
                      value immediately — any client still using it will start failing. This calls real ARM
                      {' '}(<code>regenerate{confirmRegen?.which === 'primary' ? 'Primary' : 'Secondary'}Key</code>),
                      then re-reads the pair via <code>listSecrets</code>.
                    </Body1>
                  </DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Keep current key</Button>
                    </DialogTrigger>
                    <Button
                      appearance="primary"
                      icon={<ArrowSync20Regular />}
                      onClick={() => { const c = confirmRegen; setConfirmRegen(null); if (c) regenKey(c.sid, c.which); }}
                    >
                      Regenerate key
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>
        )}
      </div>
    } />
  );
}
