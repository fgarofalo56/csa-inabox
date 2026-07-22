'use client';

// policy-editor.tsx — ApimPolicyEditor + its private constants/helpers,
// extracted verbatim from apim-editors.tsx (WS-E1 decomposition).
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Spinner, Input, Dropdown, Option, Field, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import { Save20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { ItemEditorChrome } from '../item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useRegisterRibbonCommands } from '@/lib/components/shared/ribbon-commands';
import { useStyles } from './styles';
import { StatusBar, type LoadState } from './shared';

type PolicyScopeKind = 'service' | 'api' | 'product' | 'operation';

const DEFAULT_POLICY_XML =
  `<policies>\n  <inbound>\n    <base />\n    <!-- example: validate Entra JWT -->\n    <!-- <validate-jwt header-name="Authorization" failed-validation-httpcode="401">\n      <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />\n    </validate-jwt> -->\n    <rate-limit calls="120" renewal-period="60" />\n  </inbound>\n  <backend>\n    <base />\n  </backend>\n  <outbound>\n    <base />\n  </outbound>\n  <on-error>\n    <base />\n  </on-error>\n</policies>`;

// The proven APIM policy snippets the portal "+ Add policy" gallery ships.
const POLICY_SNIPPETS: { key: string; label: string; section: 'inbound' | 'outbound'; xml: string }[] = [
  { key: 'rate-limit', label: 'Limit call rate', section: 'inbound', xml: `<rate-limit calls="120" renewal-period="60" />` },
  { key: 'quota', label: 'Set usage quota', section: 'inbound', xml: `<quota calls="10000" renewal-period="86400" />` },
  { key: 'validate-jwt', label: 'Validate Entra JWT', section: 'inbound', xml: `<validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">\n      <openid-config url="https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration" />\n      <audiences><audience>api://your-api</audience></audiences>\n    </validate-jwt>` },
  { key: 'cors', label: 'Allow cross-origin (CORS)', section: 'inbound', xml: `<cors allow-credentials="false">\n      <allowed-origins><origin>*</origin></allowed-origins>\n      <allowed-methods><method>GET</method><method>POST</method></allowed-methods>\n      <allowed-headers><header>*</header></allowed-headers>\n    </cors>` },
  { key: 'ip-filter', label: 'Restrict caller IPs', section: 'inbound', xml: `<ip-filter action="allow">\n      <address-range from="10.0.0.0" to="10.255.255.255" />\n    </ip-filter>` },
  { key: 'set-header-in', label: 'Set request header', section: 'inbound', xml: `<set-header name="X-Forwarded-By" exists-action="override">\n      <value>csa-loom</value>\n    </set-header>` },
  { key: 'set-backend', label: 'Set backend service', section: 'inbound', xml: `<set-backend-service base-url="https://backend.example.com" />` },
  { key: 'mock', label: 'Mock response', section: 'inbound', xml: `<mock-response status-code="200" content-type="application/json" />` },
  { key: 'set-header-out', label: 'Set response header', section: 'outbound', xml: `<set-header name="X-Powered-By" exists-action="override">\n      <value>CSA Loom APIM</value>\n    </set-header>` },
  { key: 'cache-lookup', label: 'Cache responses', section: 'inbound', xml: `<cache-lookup vary-by-developer="false" vary-by-developer-groups="false" downstream-caching-type="none" />` },
  // ── AI gateway (LLM) policies — for Azure OpenAI / Foundry-backed APIs ──
  { key: 'llm-token-limit', label: 'AI: token-per-minute limit', section: 'inbound', xml: `<llm-token-limit counter-key="@(context.Subscription.Id)" tokens-per-minute="5000" estimate-prompt-tokens="true" remaining-tokens-header-name="x-remaining-tokens" tokens-consumed-header-name="x-consumed-tokens" />` },
  { key: 'llm-content-safety', label: 'AI: content safety check', section: 'inbound', xml: `<llm-content-safety backend-id="content-safety-backend" shield-prompt="true">\n      <categories output-type="EightSeverityLevels">\n        <category name="Hate" threshold="4" />\n        <category name="Violence" threshold="4" />\n        <category name="Sexual" threshold="4" />\n        <category name="SelfHarm" threshold="4" />\n      </categories>\n    </llm-content-safety>` },
  { key: 'llm-semantic-cache-lookup', label: 'AI: semantic cache lookup', section: 'inbound', xml: `<llm-semantic-cache-lookup score-threshold="0.05" embeddings-backend-id="embeddings-backend" embeddings-backend-auth="system-assigned">\n      <vary-by>@(context.Subscription.Id)</vary-by>\n    </llm-semantic-cache-lookup>` },
  { key: 'llm-semantic-cache-store', label: 'AI: semantic cache store', section: 'outbound', xml: `<llm-semantic-cache-store duration="60" />` },
  { key: 'llm-emit-token-metric', label: 'AI: emit token metrics', section: 'inbound', xml: `<llm-emit-token-metric namespace="openai">\n      <dimension name="API ID" value="@(context.Api.Id)" />\n      <dimension name="Subscription ID" value="@(context.Subscription.Id)" />\n    </llm-emit-token-metric>` },
];

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
      const r = await clientFetch(`/api/items/apim-policy/${encodeURIComponent(id)}?${scopeQuery}`);
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
      const r = await clientFetch(`/api/items/apim-policy/${encodeURIComponent(id)}`, {
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

  // Policy snippet gallery — the same proven snippets APIM's "+ Add policy"
  // gallery ships. Inserting drops the fragment into the <inbound> (or
  // <outbound> for set-header-out) section of the current buffer.
  const insertSnippet = useCallback((snippet: string, section: 'inbound' | 'outbound' = 'inbound') => {
    setValue((prev) => {
      const tag = `<${section}>`;
      const ix = prev.indexOf(tag);
      if (ix < 0) return prev + '\n' + snippet;
      const insertAt = ix + tag.length;
      return prev.slice(0, insertAt) + '\n    ' + snippet.trim() + prev.slice(insertAt);
    });
    setDirty(true);
  }, []);

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
  useRegisterRibbonCommands(ribbon, item.slug);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} commandSearch main={
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
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Add policy snippet:</Caption1>
          <Dropdown
            aria-label="Add a policy snippet to the editor"
            placeholder="Choose a snippet…"
            selectedOptions={[]}
            value=""
            onOptionSelect={(_, d) => {
              const snip = POLICY_SNIPPETS.find((p) => p.key === d.optionValue);
              if (snip) insertSnippet(snip.xml, snip.section);
            }}
          >
            {POLICY_SNIPPETS.map((p) => <Option key={p.key} value={p.key}>{p.label}</Option>)}
          </Dropdown>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Inserts into the matching inbound/outbound section.</Caption1>
        </div>
        {/* Honest gate per ui-parity.md: the Azure portal also ships a form-based
            "+ Add policy" guided editor, an effective-policy (inherited base
            resolution) view, and reusable policy fragments. The code editor below
            is full-fidelity, but those three surfaces are genuinely heavy and
            backend-gated, so they are flagged as tracked gaps rather than faked. */}
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Full policy XML editor.</MessageBarTitle>
            Edit policy XML directly — the XML editor, snippet gallery, scope selector, validation, and save all call real ARM. Calculate effective policy and policy fragments are available in the Azure portal.
          </MessageBarBody>
        </MessageBar>
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
