'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button,
  Dropdown, Option, Caption1, Field,
} from '@fluentui/react-components';
import { Section } from '@/lib/components/ui/section';
import type { ApimApiSummary, ApimProductSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

const useStyles = makeStyles({
  container: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  controls: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  snippetRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

type ScopeKind = 'service' | 'api' | 'product';

// A blank policy document to seed an empty scope, mirroring the portal's
// starting template (sections run in inbound → backend → outbound → on-error).
const EMPTY_POLICY = `<policies>
  <inbound>
    <base />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>`;

// Common policy snippets the user can insert at the caret — the same building
// blocks the portal's policy gallery surfaces, so this is a guided helper over
// the 1:1 XML editor rather than a raw blob with no assistance.
const SNIPPETS: { label: string; xml: string }[] = [
  { label: 'Rate limit', xml: '<rate-limit calls="100" renewal-period="60" />' },
  { label: 'CORS', xml: '<cors allow-credentials="true">\n      <allowed-origins>\n        <origin>*</origin>\n      </allowed-origins>\n      <allowed-methods>\n        <method>GET</method>\n        <method>POST</method>\n      </allowed-methods>\n    </cors>' },
  { label: 'Set backend', xml: '<set-backend-service backend-id="my-backend" />' },
  { label: 'Validate JWT', xml: '<validate-jwt header-name="Authorization" failed-validation-httpcode="401">\n      <openid-config url="https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration" />\n    </validate-jwt>' },
  { label: 'IP filter', xml: '<ip-filter action="allow">\n      <address-range from="10.0.0.0" to="10.255.255.255" />\n    </ip-filter>' },
];

export function ApimPoliciesPane() {
  const styles = useStyles();
  const [kind, setKind] = useState<ScopeKind>('service');
  const [apis, setApis] = useState<ApimApiSummary[]>([]);
  const [products, setProducts] = useState<ApimProductSummary[]>([]);
  const [targetId, setTargetId] = useState('');           // selected api/product name
  const [policyText, setPolicyText] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // The apim-client PolicyScope string: '' → global, 'apis/<id>', 'products/<id>'.
  const scope = useMemo(() => {
    if (kind === 'service') return 'service';
    if (!targetId) return '';
    return kind === 'api' ? `apis/${targetId}` : `products/${targetId}`;
  }, [kind, targetId]);

  // Load the real API + product lists so the scope picker offers actual entities
  // (not the old `apis/example` placeholder). Both routes do real ARM REST.
  useEffect(() => {
    setListLoading(true);
    Promise.all([
      apimFetchJson('/api/apim/apis').catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
      apimFetchJson('/api/apim/products').catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
    ])
      .then(([a, p]) => {
        if (a.ok && Array.isArray(a.apis)) setApis(a.apis as ApimApiSummary[]);
        if (p.ok && Array.isArray(p.products)) setProducts(p.products as ApimProductSummary[]);
        if (!a.ok && !p.ok) setError((a.error as string) || (p.error as string) || 'Failed to load APIs/products.');
        setListLoading(false);
      });
  }, []);

  const loadPolicy = useCallback((s: string) => {
    if (s === '') { setPolicyText(''); return; }
    setLoading(true);
    setError(null);
    setSavedNote(null);
    apimFetchJson(`/api/items/apim-policy?scope=${encodeURIComponent(s)}`)
      .then((d) => {
        if (d.ok) {
          setPolicyText(((d.value as string) || '').trim() || EMPTY_POLICY);
        } else {
          setError(d.error || 'Failed to load policy');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  // Reload whenever the resolved scope changes (scope picker or target select).
  useEffect(() => { loadPolicy(scope); }, [scope, loadPolicy]);

  async function handleSave() {
    if (scope === '') { setError('Select an API or product first.'); return; }
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      const d = await apimFetchJson('/api/items/apim-policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, value: policyText }),
      });
      if (d.ok) {
        setPolicyText((d.value as string) || policyText);
        setSavedNote('Policy saved.');
      } else {
        setError(d.error || 'Save failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function insertSnippet(xml: string) {
    // Insert inside the <inbound> section after <base />, the most common spot.
    const marker = '<inbound>\n    <base />';
    if (policyText.includes(marker)) {
      setPolicyText(policyText.replace(marker, `${marker}\n    ${xml}`));
    } else {
      setPolicyText(`${policyText}\n${xml}`);
    }
    setSavedNote(null);
  }

  const needsTarget = kind !== 'service';
  const targetOptions = kind === 'api' ? apis : products;

  return (
    <Section title="Global & scoped policies" className={styles.container}>
      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
        Manage APIM policies (XML) at service scope (global) or at an individual API or product scope.
        Policies control authentication, authorization, rate limiting, transformation, and request/response handling.
        Use the snippet buttons to insert common policy blocks, then Save to apply via the real APIM REST.
      </Caption1>

      <div className={styles.controls}>
        <Field label="Scope">
          <Dropdown
            aria-label="Policy scope kind"
            value={kind === 'service' ? 'Service (global)' : kind === 'api' ? 'API' : 'Product'}
            selectedOptions={[kind]}
            onOptionSelect={(_, d) => { setKind((d.optionValue as ScopeKind) || 'service'); setTargetId(''); }}
            style={{ minWidth: 180 }}
          >
            <Option value="service">Service (global)</Option>
            <Option value="api">API</Option>
            <Option value="product">Product</Option>
          </Dropdown>
        </Field>

        {needsTarget && (
          <Field label={kind === 'api' ? 'API' : 'Product'}>
            <Dropdown
              aria-label={kind === 'api' ? 'Select API' : 'Select product'}
              placeholder={listLoading ? 'Loading…' : `Select ${kind}`}
              value={targetOptions.find((o) => o.name === targetId)?.displayName || ''}
              selectedOptions={targetId ? [targetId] : []}
              onOptionSelect={(_, d) => setTargetId(d.optionValue || '')}
              disabled={listLoading}
              style={{ minWidth: 240 }}
            >
              {targetOptions.map((o) => (
                <Option key={o.name} value={o.name}>{o.displayName || o.name}</Option>
              ))}
            </Dropdown>
          </Field>
        )}

        <Button appearance="primary" onClick={handleSave} disabled={loading || saving || (needsTarget && !targetId)}>
          {saving ? 'Saving...' : 'Save policy'}
        </Button>
      </div>

      {needsTarget && targetOptions.length === 0 && !listLoading && (
        <MessageBar intent="info">
          <MessageBarBody>
            No {kind === 'api' ? 'APIs' : 'products'} defined yet. Create one on the {kind === 'api' ? 'APIs' : 'Products'} tab,
            then return here to attach a policy.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarTitle>Policy error</MessageBarTitle>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {savedNote && (
        <MessageBar intent="success"><MessageBarBody>{savedNote}</MessageBarBody></MessageBar>
      )}

      <div className={styles.snippetRow}>
        <Caption1 style={{ alignSelf: 'center', color: tokens.colorNeutralForeground3 }}>Insert:</Caption1>
        {SNIPPETS.map((s) => (
          <Button
            key={s.label}
            size="small"
            appearance="outline"
            disabled={loading || (needsTarget && !targetId)}
            onClick={() => insertSnippet(s.xml)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <Spinner label="Loading policy..." />
      ) : (
        <textarea
          value={policyText}
          onChange={(e) => { setPolicyText(e.currentTarget.value); setSavedNote(null); }}
          aria-label="Policy XML"
          spellCheck={false}
          disabled={needsTarget && !targetId}
          style={{
            fontFamily: 'monospace',
            fontSize: '13px',
            padding: tokens.spacingVerticalM,
            borderRadius: tokens.borderRadiusMedium,
            border: `1px solid ${tokens.colorNeutralStroke2}`,
            minHeight: '400px',
            resize: 'vertical',
            backgroundColor: tokens.colorNeutralBackground1,
            color: tokens.colorNeutralForeground1,
          }}
          placeholder={EMPTY_POLICY}
        />
      )}
    </Section>
  );
}
