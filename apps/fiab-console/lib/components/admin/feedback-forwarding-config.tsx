'use client';

/**
 * FeedbackForwardingConfig — admin control (rel-T79) for whether auto-captured
 * errors are forwarded upstream to the product's GitHub issue tracker.
 *
 * Mounted on /admin/tenant-settings. Real Cosmos persistence via
 * /api/admin/feedback-forwarding; the anonymous /api/feedback auto-error path
 * reads the same deployment-wide singleton. Honors .claude/rules/no-vaporware.md
 * (real backend, honest state — the switch reflects what the route enforces).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Switch, Badge, Button, Caption1, Body1,
  MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import { Save24Regular, ShieldCheckmark20Regular, Open16Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';

const useStyles = makeStyles({
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  row: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalXL,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
  },
  label: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  bar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap', marginTop: tokens.spacingVerticalM,
  },
  spacer: { flex: 1 },
  learn: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    color: tokens.colorBrandForeground1, textDecoration: 'none', fontWeight: tokens.fontWeightSemibold,
    ':hover': { textDecoration: 'underline' },
  },
});

export function FeedbackForwardingConfig() {
  const s = useStyles();
  const [value, setValue] = useState(true);
  const [original, setOriginal] = useState(true);
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await clientFetch('/api/admin/feedback-forwarding');
      if (r.status === 401 || r.status === 403) { setLoadError('Tenant-admin sign-in required'); return; }
      const j = await r.json();
      if (!j.ok) { setLoadError(j.error || `HTTP ${r.status}`); return; }
      setValue(!!j.autoErrorForwarding);
      setOriginal(!!j.autoErrorForwarding);
      setTokenConfigured(!!j.tokenConfigured);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const dirty = value !== original;

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true); setSaveError(null); setStatus(null);
    try {
      const r = await clientFetch('/api/admin/feedback-forwarding', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoErrorForwarding: value }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      setOriginal(!!j.autoErrorForwarding);
      setValue(!!j.autoErrorForwarding);
      setStatus(`Saved at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally { setSaving(false); }
  }, [value, saving]);

  if (loading) {
    return (
      <Section title="Feedback & error forwarding">
        <Spinner label="Loading feedback-forwarding config…" />
      </Section>
    );
  }

  return (
    <Section title="Feedback & error forwarding">
      <Body1 className={s.hint}>
        Controls whether auto-captured application errors are forwarded to the
        CSA Loom product maintainers&apos; issue tracker for triage. Payloads are
        server-side redacted (no PII, no workspace ids, no data values) and the
        tenant id is one-way hashed. See the{' '}
        <a
          className={s.learn}
          href="https://fgarofalo56.github.io/csa-inabox/fiab/data-disclosure/"
          target="_blank"
          rel="noreferrer"
        >
          data-disclosure doc <Open16Regular />
        </a>{' '}
        for exactly what leaves your tenant.
      </Body1>

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load config</MessageBarTitle>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {!tokenConfigured && (
        <MessageBar intent="info" icon={<ShieldCheckmark20Regular />}>
          <MessageBarBody>
            <MessageBarTitle>Nothing is being forwarded from this deployment</MessageBarTitle>
            <code>LOOM_FEEDBACK_GITHUB_TOKEN</code> is not set, so this deployment never forwards
            feedback or errors upstream — reports are accepted and logged locally only. This
            switch takes effect if a token is later configured.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.row}>
        <div className={s.label}>
          <div style={{ fontWeight: 500 }}>
            Forward auto-captured errors
            {dirty && <Badge appearance="outline" color="warning" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>changed</Badge>}
          </div>
          <Caption1 className={s.hint}>
            When ON (default), the error boundary forwards redacted crash reports upstream so the
            maintainers can fix them. When OFF, auto-errors are accepted and logged locally only —
            nothing leaves your tenant. User-initiated bug &amp; feature reports are a deliberate
            action and always send regardless of this switch.
          </Caption1>
        </div>
        <Switch
          checked={value}
          onChange={(_, d) => setValue(!!d.checked)}
          disabled={saving}
          label={value ? 'On' : 'Off'}
        />
      </div>

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveError}</MessageBarBody>
        </MessageBar>
      )}
      {status && !saveError && (
        <MessageBar intent="success"><MessageBarBody>{status}</MessageBarBody></MessageBar>
      )}

      <div className={s.bar}>
        {dirty && <Badge appearance="filled" color="warning" size="small">unsaved changes</Badge>}
        <div className={s.spacer} />
        <Button
          appearance="primary"
          icon={<Save24Regular />}
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save forwarding setting'}
        </Button>
      </div>
    </Section>
  );
}
