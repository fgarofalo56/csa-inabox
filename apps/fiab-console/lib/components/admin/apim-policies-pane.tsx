'use client';

import { useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Dropdown, Option,
  Caption1,
} from '@fluentui/react-components';
import { Section } from '@/lib/components/ui/section';
import { apimFetchJson } from './apim-pane-fetch';

const useStyles = makeStyles({
  container: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  controls: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end' },
});

export function ApimPoliciesPane() {
  const styles = useStyles();
  const [scope, setScope] = useState('service');
  const [policyText, setPolicyText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // apimFetchJson surfaces a non-JSON body / honest 503 gate as a readable
    // error instead of crashing the pane with "Unexpected token '<'".
    apimFetchJson(`/api/items/apim-policy?scope=${scope}`)
      .then((d) => {
        if (d.ok) {
          setPolicyText((d.value as string) || '');
        } else {
          setError(d.error || 'Failed to load policy');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [scope]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const d = await apimFetchJson('/api/items/apim-policy', {
        method: 'PUT',
        body: JSON.stringify({ scope, value: policyText }),
      });
      if (d.ok) {
        setPolicyText((d.value as string) || policyText);
      } else {
        setError(d.error || 'Save failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Global & scoped policies" className={styles.container}>
      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
        Manage APIM policies (XML) at service scope (global) or individual API/product scopes.
        Policies control authentication, authorization, transformation, and request/response handling.
      </Caption1>

      <div className={styles.controls}>
        <Dropdown
          aria-label="Policy scope"
          placeholder="Policy scope"
          value={scope}
          selectedOptions={[scope]}
          onOptionSelect={(_, d) => setScope(d.optionValue || 'service')}
          style={{ minWidth: 200 }}
        >
          <Option value="service">Service (global)</Option>
          <Option value="apis/example">API (choose in editor)</Option>
          <Option value="products/example">Product (choose in editor)</Option>
          <Option value="operations/example">Operation (choose in editor)</Option>
        </Dropdown>
        <Button appearance="primary" onClick={handleSave} disabled={loading || saving}>
          {saving ? 'Saving...' : 'Save policy'}
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner label="Loading policy..." />
      ) : (
        <textarea
          value={policyText}
          onChange={(e) => setPolicyText(e.currentTarget.value)}
          aria-label="Policy XML"
          spellCheck={false}
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
          placeholder='<policies>...</policies>'
        />
      )}
    </Section>
  );
}
