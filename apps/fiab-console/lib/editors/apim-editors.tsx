'use client';

/**
 * APIM editors — wired live to Azure API Management (apim-csa-loom-eastus2)
 * via the BFF (/api/items/apim-*). No mock data.
 *
 *   ApimApiEditor       — load operations + spec, edit displayName/path/protocols/subscriptionRequired, Save -> PUT
 *   ApimProductEditor   — load product, edit displayName/description/state/flags, Save -> PUT
 *   ApimPolicyEditor    — load policy XML for a scope, validate well-formed XML client-side, Save -> PUT
 *   DataProductEditor   — visual, but the Publish-to-APIM button POSTs a real product (idempotent upsert)
 *
 * APIM is the API-first glue per the CSA reference architecture: every Loom
 * function, ML endpoint, GraphQL API, and data-product surface is fronted
 * through APIM for auth, rate limiting, observability, and marketplace discovery.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Switch, Dropdown, Option, Field,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Save20Regular, ArrowSync20Regular, Copy20Regular, CloudArrowUp20Regular,
  Document20Regular, Code20Regular, Library20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' },
  monaco: {
    width: '100%', minHeight: 400,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  specViewer: {
    width: '100%', minHeight: 280, maxHeight: 480,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    overflow: 'auto', whiteSpace: 'pre',
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
  treePad: { padding: 8 },
  protocolRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
});

// ============================================================
// Shared helpers
// ============================================================

function StatusBar({ status }: { status: { kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string } }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'saving') return <Spinner size="tiny" label="Saving to APIM…" labelPosition="after" />;
  if (status.kind === 'ok') {
    return (
      <MessageBar intent="success">
        <MessageBarBody><MessageBarTitle>Saved</MessageBarTitle>{status.msg}</MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="error">
      <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{status.msg || 'Unknown error'}</MessageBarBody>
    </MessageBar>
  );
}

type LoadState<T> = { loading: boolean; data: T | null; error?: string };

// ============================================================
// ApimApiEditor
// ============================================================
// (Ribbon defined inside the component via useMemo so onClick handlers can
// reference inline save / load / loadSpec / copySpec state.)

interface ApimApi {
  id: string;
  name: string;
  displayName: string;
  path: string;
  protocols: string[];
  serviceUrl?: string;
  subscriptionRequired?: boolean;
}

interface ApimOperation {
  id: string;
  name: string;
  displayName: string;
  method: string;
  urlTemplate: string;
}

const PROTOCOLS = ['https', 'http', 'ws', 'wss'] as const;

export function ApimApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const isNew = id === 'new';
  const [api, setApi] = useState<LoadState<ApimApi>>({ loading: !isNew, data: null });
  const [ops, setOps] = useState<LoadState<ApimOperation[]>>({ loading: false, data: null });
  const [spec, setSpec] = useState<LoadState<{ format: string; value: string }>>({ loading: false, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  // Form fields
  const [displayName, setDisplayName] = useState('');
  const [path, setPath] = useState('');
  const [protocols, setProtocols] = useState<string[]>(['https']);
  const [subscriptionRequired, setSubscriptionRequired] = useState(true);
  const [serviceUrl, setServiceUrl] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (isNew) return;
    setApi({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setApi({ loading: false, data: null, error: j.error || 'Failed to load' }); return; }
      setApi({ loading: false, data: j.api });
      setDisplayName(j.api.displayName || '');
      setPath(j.api.path || '');
      setProtocols(j.api.protocols?.length ? j.api.protocols : ['https']);
      setSubscriptionRequired(j.api.subscriptionRequired ?? true);
      setServiceUrl(j.api.serviceUrl || '');
      setDirty(false);
    } catch (e: any) {
      setApi({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, isNew]);

  const loadOps = useCallback(async () => {
    if (isNew) return;
    setOps({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/operations`);
      const j = await r.json();
      if (!j.ok) { setOps({ loading: false, data: [], error: j.error }); return; }
      setOps({ loading: false, data: j.operations });
    } catch (e: any) {
      setOps({ loading: false, data: [], error: e?.message || String(e) });
    }
  }, [id, isNew]);

  const loadSpec = useCallback(async () => {
    if (isNew) return;
    setSpec({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}/spec?format=openapi%2Bjson`);
      const j = await r.json();
      if (!j.ok) { setSpec({ loading: false, data: null, error: j.error }); return; }
      setSpec({ loading: false, data: { format: j.format, value: j.value } });
    } catch (e: any) {
      setSpec({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, isNew]);

  useEffect(() => { load(); loadOps(); loadSpec(); }, [load, loadOps, loadSpec]);

  const save = useCallback(async () => {
    if (!displayName.trim() || !path.trim()) {
      setStatus({ kind: 'err', msg: 'displayName and path are required' });
      return;
    }
    setStatus({ kind: 'saving' });
    // Phase 4.5 — capture the body we're about to PUT before the await so
    // if a user keystroke commits to React state mid-request we don't
    // silently report success for bytes that were never sent. Status msg
    // always references the snapshot we actually transmitted.
    const body = { displayName, path, protocols: [...protocols], subscriptionRequired, serviceUrl: serviceUrl || undefined };
    try {
      const r = await fetch(`/api/items/apim-api/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `${j.api.displayName} (${j.api.name}) at ${new Date().toLocaleTimeString()}` });
      setApi({ loading: false, data: j.api });
      setDirty(false);
      loadOps();
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, displayName, path, protocols, subscriptionRequired, serviceUrl, loadOps]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && displayName.trim() && path.trim()) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, displayName, path, save]);

  const toggleProtocol = (p: string) => {
    setProtocols((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
    setDirty(true);
  };

  const copySpec = () => {
    if (spec.data?.value) navigator.clipboard?.writeText(spec.data.value).catch(() => {});
  };

  // Ribbon — Save / Reload / Copy spec wired inline; Edit OpenAPI is honestly
  // disabled (no inline editor for the OpenAPI document — APIM Studio is the
  // path of record). Open policy editor deep-links to the apim-policy item.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'API', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && (isNew || dirty) && displayName.trim() && path.trim() ? save : undefined, disabled: status.kind === 'saving' || (!isNew && !dirty) || !displayName.trim() || !path.trim(), title: !displayName.trim() || !path.trim() ? 'displayName and path are required' : (!dirty && !isNew ? 'No unsaved changes' : undefined) },
        { label: 'Reload', onClick: !isNew ? () => { load(); loadOps(); loadSpec(); } : undefined, disabled: isNew, title: isNew ? 'Save the API first' : undefined },
      ]},
      { label: 'Definition', actions: [
        { label: 'Edit OpenAPI', disabled: true, title: 'Edit OpenAPI — needs in-browser spec editor (deferred; use APIM Studio for now)' },
        { label: 'Copy spec', onClick: spec.data?.value ? copySpec : undefined, disabled: !spec.data?.value, title: !spec.data?.value ? 'No spec attached to this API' : undefined },
      ]},
      { label: 'Policy', actions: [
        { label: 'Open policy editor', onClick: !isNew ? () => router.push(`/items/apim-policy/${encodeURIComponent(id)}?scope=api&apiId=${encodeURIComponent(id)}`) : undefined, disabled: isNew, title: isNew ? 'Save the API first' : undefined },
      ]},
    ]},
  ], [status.kind, isNew, dirty, displayName, path, save, load, loadOps, loadSpec, spec.data, router, id]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="API operations" defaultOpenItems={['operations']}>
            <TreeItem itemType="branch" value="operations">
              <TreeItemLayout iconBefore={<Code20Regular />}>
                Operations ({ops.data?.length ?? 0})
              </TreeItemLayout>
              <Tree>
                {ops.loading && (
                  <TreeItem itemType="leaf" value="loading"><TreeItemLayout>Loading…</TreeItemLayout></TreeItem>
                )}
                {!ops.loading && (ops.data?.length ?? 0) === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>{ops.error || (isNew ? 'Save the API to add operations' : 'No operations yet')}</TreeItemLayout>
                  </TreeItem>
                )}
                {(ops.data || []).map((op) => (
                  <TreeItem key={op.id || op.name} itemType="leaf" value={`op-${op.name}`}>
                    <TreeItemLayout iconBefore={<Document20Regular />}>
                      <strong>{op.method}</strong> {op.urlTemplate} <Caption1>· {op.displayName}</Caption1>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">APIM API</Badge>
            <Badge appearance="outline">{api.data?.name || id}</Badge>
            {subscriptionRequired && <Badge appearance="outline">Subscription required</Badge>}
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={status.kind === 'saving' || (!isNew && !dirty)}>
              {status.kind === 'saving' ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </Button>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => { load(); loadOps(); loadSpec(); }}>
              Reload
            </Button>
          </div>
          <StatusBar status={status} />
          {api.loading && <Spinner size="small" label="Loading API from APIM…" labelPosition="after" />}
          {api.error && !api.loading && (
            <BackendStateBar error={api.error} title="APIM API" />
          )}
          <div className={s.form}>
            <Field label="Display name" required>
              <Input value={displayName} onChange={(_, d) => { setDisplayName(d.value); setDirty(true); }} />
            </Field>
            <Field label="Path" required hint="URL suffix after the gateway hostname, e.g. 'orders'">
              <Input value={path} onChange={(_, d) => { setPath(d.value); setDirty(true); }} />
            </Field>
            <Field label="Service URL" hint="Backend base URL (optional)">
              <Input value={serviceUrl} onChange={(_, d) => { setServiceUrl(d.value); setDirty(true); }} placeholder="https://backend.example.com" />
            </Field>
            <Field label="Subscription required">
              <Switch checked={subscriptionRequired} onChange={(_, d) => { setSubscriptionRequired(d.checked); setDirty(true); }} label={subscriptionRequired ? 'Yes' : 'No'} />
            </Field>
            <Field label="Protocols" hint="At least one">
              <div className={s.protocolRow}>
                {PROTOCOLS.map((p) => (
                  <Switch key={p} checked={protocols.includes(p)} label={p} onChange={() => toggleProtocol(p)} />
                ))}
              </div>
            </Field>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <Subtitle2>OpenAPI spec</Subtitle2>
            <Badge appearance="outline">{spec.data?.format || 'openapi+json'}</Badge>
            <Button size="small" icon={<Copy20Regular />} onClick={copySpec} disabled={!spec.data?.value}>Copy</Button>
            <Button size="small" icon={<ArrowSync20Regular />} onClick={loadSpec}>Refresh</Button>
          </div>
          {spec.loading && <Spinner size="tiny" label="Exporting from APIM…" labelPosition="after" />}
          {!spec.loading && spec.error && <Caption1>Spec unavailable: {spec.error}</Caption1>}
          {!spec.loading && !spec.error && (
            <div className={s.specViewer} role="region" aria-label="OpenAPI spec (read-only)">
              {spec.data?.value || (isNew ? 'Save the API first, then import a spec.' : '(no spec attached to this API)')}
            </div>
          )}
        </div>
      }
    />
  );
}

// ============================================================
// ApimProductEditor
// ============================================================
// (Ribbon defined inside the component via useMemo.)

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
  const isNew = id === 'new';
  const [product, setProduct] = useState<LoadState<ApimProduct>>({ loading: !isNew, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<'published' | 'notPublished'>('notPublished');
  const [subscriptionRequired, setSubscriptionRequired] = useState(true);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    if (isNew) return;
    setProduct({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}`);
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
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}`, {
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
      const r = await fetch(`/api/items/apim-product/${encodeURIComponent(id)}`, {
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
    ]},
  ], [status.kind, isNew, dirty, displayName, save, load, state, publishToggle]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
      </div>
    } />
  );
}

// ============================================================
// ApimPolicyEditor
// ============================================================
// (Ribbon defined inside the component via useMemo so onClick handlers can
// reference inline save / load / setScopeKind state.)

// v3.27: added 'operation' scope — APIM's finest-grain policy attach point.
type PolicyScopeKind = 'service' | 'api' | 'product' | 'operation';

const DEFAULT_POLICY_XML =
  `<policies>\n  <inbound>\n    <base />\n    <!-- example: validate Entra JWT -->\n    <!-- <validate-jwt header-name="Authorization" failed-validation-httpcode="401">\n      <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />\n    </validate-jwt> -->\n    <rate-limit calls="120" renewal-period="60" />\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>`;

function isWellFormedXml(xml: string): { ok: true } | { ok: false; error: string } {
  try {
    if (typeof DOMParser === 'undefined') return { ok: true }; // SSR fallback
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) return { ok: false, error: err.textContent || 'XML parse error' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function ApimPolicyEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [scopeKind, setScopeKind] = useState<PolicyScopeKind>('service');
  const [apiId, setApiId] = useState('');
  const [productId, setProductId] = useState('');
  const [operationId, setOperationId] = useState('');
  const [value, setValue] = useState(DEFAULT_POLICY_XML);
  const [loadState, setLoadState] = useState<LoadState<{ value: string; format: string }>>({ loading: true, data: null });
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);

  const scopeQuery = useMemo(() => {
    const sp = new URLSearchParams({ scope: scopeKind });
    if ((scopeKind === 'api' || scopeKind === 'operation') && apiId) sp.set('apiId', apiId);
    if (scopeKind === 'product' && productId) sp.set('productId', productId);
    if (scopeKind === 'operation' && operationId) sp.set('operationId', operationId);
    return sp.toString();
  }, [scopeKind, apiId, productId, operationId]);

  const load = useCallback(async () => {
    setLoadState({ loading: true, data: null });
    try {
      const r = await fetch(`/api/items/apim-policy/${encodeURIComponent(id)}?${scopeQuery}`);
      const j = await r.json();
      if (!j.ok) { setLoadState({ loading: false, data: null, error: j.error }); return; }
      setLoadState({ loading: false, data: { value: j.value, format: j.format } });
      if (j.value) setValue(j.value);
      else setValue(DEFAULT_POLICY_XML);
      setDirty(false);
    } catch (e: any) {
      setLoadState({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [id, scopeQuery]);

  useEffect(() => {
    // Only auto-load when scope is fully specified.
    if (scopeKind === 'service') load();
    else if (scopeKind === 'api' && apiId) load();
    else if (scopeKind === 'product' && productId) load();
    else if (scopeKind === 'operation' && apiId && operationId) load();
    else setLoadState({ loading: false, data: null });
  }, [load, scopeKind, apiId, productId, operationId]);

  const save = useCallback(async () => {
    // Phase 4.5 — snapshot the XML buffer via functional setter so the
    // bytes validated, sent, and reflected back in the status match the
    // user's actual edit even if Monaco fires another onChange during the
    // await. Mirrors notebook-editor.tsx patchCell snapshot pattern.
    let snapshot = value;
    setValue((prev) => { snapshot = prev; return prev; });
    const check = isWellFormedXml(snapshot);
    if (!check.ok) { setStatus({ kind: 'err', msg: `Invalid XML: ${check.error}` }); return; }
    if (scopeKind === 'api' && !apiId) { setStatus({ kind: 'err', msg: 'apiId is required for API scope' }); return; }
    if (scopeKind === 'product' && !productId) { setStatus({ kind: 'err', msg: 'productId is required for product scope' }); return; }
    if (scopeKind === 'operation' && (!apiId || !operationId)) { setStatus({ kind: 'err', msg: 'apiId and operationId are required for operation scope' }); return; }
    setStatus({ kind: 'saving' });
    try {
      const r = await fetch(`/api/items/apim-policy/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scopeKind, apiId, productId, operationId, value: snapshot }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `Policy saved at scope: ${j.scope} at ${new Date().toLocaleTimeString()}` });
      setDirty(false);
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id, scopeKind, apiId, productId, operationId, value]);

  // Phase 4.5 — Ctrl+S / Cmd+S keyboard shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving') save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, save]);

  // Ribbon — Save / Reload wired inline; Validate XML runs the existing
  // isWellFormedXml check; Global/API/Product/Operation set the local scopeKind.
  const validateXml = useCallback(() => {
    const check = isWellFormedXml(value);
    if (check.ok) {
      setStatus({ kind: 'ok', msg: 'XML is well-formed.' });
    } else {
      setStatus({ kind: 'err', msg: `Invalid XML: ${check.error}` });
    }
  }, [value]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && dirty ? save : undefined, disabled: status.kind === 'saving' || !dirty, title: !dirty ? 'No unsaved changes' : undefined },
        { label: 'Reload', onClick: load },
        { label: 'Validate XML', onClick: validateXml },
      ]},
      { label: 'Scope', actions: [
        { label: 'Global', onClick: () => setScopeKind('service') },
        { label: 'API', onClick: () => setScopeKind('api') },
        { label: 'Product', onClick: () => setScopeKind('product') },
        { label: 'Operation', onClick: () => setScopeKind('operation') },
      ]},
    ]},
  ], [status.kind, dirty, save, load, validateXml]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">APIM Policy</Badge>
          <Field label="Scope">
            <Dropdown
              value={scopeKind}
              selectedOptions={[scopeKind]}
              onOptionSelect={(_, d) => d.optionValue && setScopeKind(d.optionValue as PolicyScopeKind)}
            >
              <Option value="service">Global (service)</Option>
              <Option value="api">API</Option>
              <Option value="product">Product</Option>
              <Option value="operation">API operation</Option>
            </Dropdown>
          </Field>
          {(scopeKind === 'api' || scopeKind === 'operation') && (
            <Field label="API id">
              <Input value={apiId} onChange={(_, d) => setApiId(d.value)} placeholder="e.g. orders-api" />
            </Field>
          )}
          {scopeKind === 'operation' && (
            <Field label="Operation id">
              <Input value={operationId} onChange={(_, d) => setOperationId(d.value)} placeholder="e.g. getOrderById" />
            </Field>
          )}
          {scopeKind === 'product' && (
            <Field label="Product id">
              <Input value={productId} onChange={(_, d) => setProductId(d.value)} placeholder="e.g. customer-360" />
            </Field>
          )}
          {dirty && <Badge appearance="outline" color="warning" style={{ marginLeft: 'auto' }}>unsaved</Badge>}
          <Button
            appearance="primary"
            icon={<Save20Regular />}
            onClick={save}
            disabled={status.kind === 'saving' || !dirty}
            style={dirty ? undefined : { marginLeft: 'auto' }}
          >
            {status.kind === 'saving' ? 'Saving…' : 'Save policy'}
          </Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
        </div>
        <StatusBar status={status} />
        {loadState.loading && <Spinner size="tiny" label="Loading policy…" labelPosition="after" />}
        {loadState.error && !loadState.loading && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Could not load existing policy</MessageBarTitle>
              {loadState.error}
            </MessageBarBody>
          </MessageBar>
        )}
        <MonacoTextarea
          value={value}
          onChange={(v) => { setValue(v); setDirty(true); }}
          language="xml"
          height={320}
          minHeight={240}
          ariaLabel="APIM policy XML"
        />
      </div>
    } />
  );
}

// ============================================================
// DataProductEditor
// ============================================================
// (Ribbon defined inside the component via useMemo.)

interface DataProductState {
  displayName: string;
  description: string;
  domain: string;
  owner: string;
  certified: boolean;
  sla: string;
  bundle: string[];
  // Phase 1 Purview Unified Catalog wiring — populated by
  // POST /api/items/data-product/[id]/register-purview on success.
  purviewDataProductId?: string;
  lastRegisteredAt?: string;
}

const DP_EMPTY: DataProductState = {
  displayName: '',
  description: '',
  domain: '',
  owner: '',
  certified: false,
  sla: '',
  bundle: [],
};

// Hint payload returned with HTTP 501 from /register-purview when the
// LOOM_PURVIEW_ACCOUNT env var is not set. Mirrors PurviewNotConfiguredHint
// in lib/azure/purview-client.ts.
interface PurviewNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  rolesRequired: { name: string; scope: string; reason: string }[];
  followUp: string;
}

export function DataProductEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<DataProductState>(DP_EMPTY);
  const [loading, setLoading] = useState(id !== 'new');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);
  // Phase 1: when /register-purview returns 501, we surface the structured
  // hint payload as a dedicated MessageBar so the operator sees the bicep
  // module path + roles to grant.
  const [purviewHint, setPurviewHint] = useState<PurviewNotConfiguredHint | null>(null);

  // Phase 4.5 — all field mutations use functional updates so that if an
  // async response (e.g. registerPurview hydrating purviewDataProductId)
  // lands between the user's keystroke and React's commit, neither edit
  // clobbers the other. Same pattern as notebook-editor.tsx patchCell fix.
  const patchState = useCallback((patch: Partial<DataProductState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  // v3.27: F-vaporware fix — Cosmos-backed load, removes hardcoded
  // 'Customer 360' / alice@contoso / fixed bundle grid.
  useEffect(() => {
    if (id === 'new') { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`);
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) {
          // 404 on fresh items is expected; show empty form rather than error.
          if (r.status !== 404) setLoadErr(j.error || `HTTP ${r.status}`);
        } else if (j.item?.state) {
          setState({ ...DP_EMPTY, ...(j.item.state as Partial<DataProductState>) });
          setDirty(false);
        }
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const save = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    // Snapshot current state from the latest committed render via functional
    // setter — guarantees we PUT the user's freshest field values, not a
    // stale closure capture from when the Save callback was last memoised.
    let snapshot: DataProductState = DP_EMPTY;
    setState((prev) => { snapshot = prev; return prev; });
    try {
      const r = await fetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: snapshot, displayName: snapshot.displayName || 'Untitled data product' }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setDirty(false);
      setStatus({ kind: 'ok', msg: snapshot.purviewDataProductId
        ? 'Saved to Cosmos. Re-register with Purview to propagate edits to the Unified Catalog.'
        : 'Saved to Cosmos. Click Register with Purview to publish to the Unified Catalog.' });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  const publishApimMirror = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    // Snapshot to avoid stale closure of state.displayName/description.
    let snapshot: DataProductState = DP_EMPTY;
    setState((prev) => { snapshot = prev; return prev; });
    try {
      const r = await fetch(`/api/items/apim-product`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          displayName: snapshot.displayName || 'Untitled data product',
          description: snapshot.description,
          state: 'published',
          subscriptionRequired: true,
          approvalRequired: false,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setStatus({ kind: 'err', msg: j.error || `HTTP ${r.status}` }); return; }
      setStatus({ kind: 'ok', msg: `Published API consumer surface as APIM product '${j.product.name}'. (Note: this is the API access layer, NOT the Purview Data Product registration.)` });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  const registerPurview = useCallback(async () => {
    setStatus({ kind: 'saving' });
    setPurviewHint(null);
    try {
      const r = await fetch(`/api/items/data-product/${encodeURIComponent(id)}/register-purview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const j = await r.json();
      if (r.status === 501 && j?.hint) {
        // Honest config-only state per .claude/rules/no-vaporware.md — the
        // backend is gated, surface the actionable hint to the operator.
        setPurviewHint(j.hint as PurviewNotConfiguredHint);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!j.ok) {
        const detail = j.hint?.followUp ? ` Hint: ${j.hint.followUp}` : (j.hint ? ` Hint: ${j.hint}` : '');
        setStatus({ kind: 'err', msg: `${j.error || `HTTP ${r.status}`}${detail}` });
        return;
      }
      // Success — hydrate the local state with the returned id + timestamp
      // so the MessageBar flips from "pending" to "registered" without a reload.
      setState((prev) => ({
        ...prev,
        purviewDataProductId: j.purviewDataProductId,
        lastRegisteredAt: j.lastRegisteredAt,
      }));
      setStatus({
        kind: 'ok',
        msg: `Registered with Purview Unified Catalog. dataProductId=${j.purviewDataProductId} · lastRegisteredAt=${j.lastRegisteredAt}`,
      });
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message || String(e) });
    }
  }, [id]);

  const setBundleText = (text: string) => patchState({ bundle: text.split('\n').map(s => s.trim()).filter(Boolean) });

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut for Save. Matches notebook-editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && status.kind !== 'saving' && state.displayName) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, status.kind, state.displayName, save]);

  // Ribbon — Save + Publish to APIM wired to inline handlers. Semantic schema /
  // SLA / Owner stay honestly disabled (the form below is the actual edit
  // surface; jumping to a separate panel is a future v2 enhancement).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Product', actions: [
        { label: status.kind === 'saving' ? 'Saving…' : 'Save', onClick: status.kind !== 'saving' && dirty ? save : undefined, disabled: status.kind === 'saving' || !dirty, title: !dirty ? 'No unsaved changes' : undefined },
        { label: 'Publish to APIM', onClick: status.kind !== 'saving' && state.displayName ? publishApimMirror : undefined, disabled: status.kind === 'saving' || !state.displayName, title: !state.displayName ? 'displayName is required' : undefined },
      ]},
      { label: 'Contract', actions: [
        { label: 'Semantic schema', disabled: true, title: 'Semantic schema — use the Bundle field below to list semantic contracts (dedicated editor deferred to v2)' },
        { label: 'SLA', disabled: true, title: 'SLA — use the SLA field in the form below (dedicated editor deferred to v2)' },
        { label: 'Owner', disabled: true, title: 'Owner — use the Owner field in the form below (dedicated editor deferred to v2)' },
      ]},
    ]},
  ], [status.kind, dirty, save, state.displayName, publishApimMirror]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        {state.purviewDataProductId ? (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Registered with Purview Unified Catalog</MessageBarTitle>
              Data product <code>{state.purviewDataProductId}</code> is live in the catalog.{' '}
              {state.lastRegisteredAt && <>Last registered <code>{state.lastRegisteredAt}</code>.{' '}</>}
              Re-click <strong>Register with Purview</strong> after edits to push updates. APIM publish remains a separate, API-access-layer concern.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Not yet registered with Purview Unified Catalog</MessageBarTitle>
              The item persists configuration to Cosmos, but it has not been published to the canonical Purview Data Product catalog. Click <strong>Register with Purview</strong> below to create the Unified Catalog data product via <code>POST /datagovernance/catalog/dataProducts</code>. Requires a Purview account (<code>LOOM_PURVIEW_ACCOUNT</code>), a <code>businessDomainId</code> GUID in <code>state.domain</code>, and the Loom UAMI to hold the <code>Data Curator</code> + <code>Data Product Owner</code> roles. See <code>docs/fiab/data-product-parity-spec.md</code>.
            </MessageBarBody>
          </MessageBar>
        )}

        {purviewHint && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Purview is not provisioned in this deployment</MessageBarTitle>
              Missing env var: <code>{purviewHint.missingEnvVar}</code>.{' '}
              Bicep module: <code>{purviewHint.bicepModule}</code> — {purviewHint.bicepStatus}{' '}
              Required Purview roles (granted via the Purview portal, NOT ARM RBAC):
              <ul style={{ margin: '6px 0 6px 18px' }}>
                {purviewHint.rolesRequired.map((r) => (
                  <li key={r.name}><strong>{r.name}</strong> at {r.scope} — {r.reason}</li>
                ))}
              </ul>
              {purviewHint.followUp}
            </MessageBarBody>
          </MessageBar>
        )}

        {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
        {loading && <Spinner size="tiny" label="Loading…" />}

        <div className={s.toolbar}>
          {state.domain && <Badge appearance="filled" color="brand">Domain: {state.domain}</Badge>}
          {state.owner && <Badge appearance="outline">Owner: {state.owner}</Badge>}
          {state.certified && <Badge appearance="outline" color="success">Certified</Badge>}
          {state.purviewDataProductId && <Badge appearance="outline" color="success">Purview: {state.purviewDataProductId.slice(0, 8)}…</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="secondary" icon={<Save20Regular />} onClick={save} disabled={status.kind === 'saving' || !dirty}>Save</Button>
          <Button
            appearance={state.purviewDataProductId ? 'secondary' : 'primary'}
            icon={<Library20Regular />}
            onClick={registerPurview}
            disabled={status.kind === 'saving' || !state.displayName}
            style={{ marginLeft: 'auto' }}
          >
            {status.kind === 'saving'
              ? 'Registering…'
              : state.purviewDataProductId ? 'Re-register with Purview' : 'Register with Purview'}
          </Button>
          <Button appearance="secondary" icon={<CloudArrowUp20Regular />} onClick={publishApimMirror} disabled={status.kind === 'saving' || !state.displayName}>
            {status.kind === 'saving' ? 'Publishing…' : 'Publish to APIM'}
          </Button>
        </div>
        <StatusBar status={status} />

        <div className={s.form}>
          <Field label="Display name"><Input value={state.displayName} onChange={(_, d) => patchState({ displayName: d.value })} /></Field>
          <Field label="Domain (Purview businessDomainId GUID)"><Input value={state.domain} onChange={(_, d) => patchState({ domain: d.value })} placeholder="e.g. 0a1b2c3d-4e5f-6789-abcd-ef0123456789" /></Field>
          <Field label="Owner (email)"><Input value={state.owner} onChange={(_, d) => patchState({ owner: d.value })} placeholder="owner@contoso.com" /></Field>
          <Field label="SLA"><Input value={state.sla} onChange={(_, d) => patchState({ sla: d.value })} placeholder="99.9% · P95 < 200 ms" /></Field>
          <Field label="Description" style={{ gridColumn: '1 / -1' }}>
            <Textarea value={state.description} onChange={(_, d) => patchState({ description: d.value })} rows={3} />
          </Field>
          <Field label="Certified" style={{ gridColumn: '1 / -1' }}>
            <Switch checked={state.certified} onChange={(_, d) => patchState({ certified: d.checked })} label={state.certified ? 'Certified by data governance' : 'Not certified'} />
          </Field>
          <Field label="Bundle (one per line — datasets, contracts, APIs, policies)" style={{ gridColumn: '1 / -1' }}>
            <Textarea value={state.bundle.join('\n')} onChange={(_, d) => setBundleText(d.value)} rows={6} placeholder={'Dataset: silver_revenue (Delta)\nSemantic contract: orders.yaml (v2)\nAPIM API: orders-api v2.1'} />
          </Field>
        </div>

        {state.bundle.length > 0 && (
          <>
            <Subtitle2 style={{ marginTop: 8 }}>Bundle preview</Subtitle2>
            <div className={s.cardGrid}>
              {state.bundle.map((b, i) => <div key={i} className={s.card}>{b}</div>)}
            </div>
          </>
        )}
      </div>
    } />
  );
}
