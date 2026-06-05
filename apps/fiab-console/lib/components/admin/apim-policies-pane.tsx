'use client';

import { useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Dropdown, Option,
  Caption1,
} from '@fluentui/react-components';
import { Section } from '@/lib/components/ui/section';

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
    fetch(`/api/items/apim-policy?scope=${scope}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setPolicyText(d.value || '');
        } else {
          setError(d.error || 'Failed to load policy');
        }
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [scope]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/items/apim-policy', {
        method: 'PUT',
        body: JSON.stringify({ scope, value: policyText }),
      });
      const d = await res.json();
      if (d.ok) {
        setPolicyText(d.value || policyText);
      } else {
        setError(d.error || 'Save failed');
      }
    } catch (e) {
      setError(String(e));
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
          style={{
            fontFamily: 'monospace',
            fontSize: '13px',
            padding: '12px',
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
