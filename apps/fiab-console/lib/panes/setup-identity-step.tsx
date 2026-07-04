'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Setup Wizard — "Identity & Admin" card (deploy-readiness, GH #1383).
 *
 * Surfaces the auth-domain scan-and-choose in the Setup Wizard: it reads
 * GET /api/setup/identity (real backend — current MSAL wiring, existing Entra
 * app registrations discovered via Graph, and the recommended bootstrap admin =
 * the signed-in user), lets the operator pick existing / new / disable for the
 * app registration and self / group for the bootstrap admin (structured
 * pickers, no freeform per loom-no-freeform-config), and POSTs the choice.
 *
 * Honest: the POST records the choice + returns the exact apply path (bootstrap
 * script + deploy params) — it does NOT fake an "applied" success, because
 * provisioning the app registration is a privileged Graph + Container-App action
 * (per no-vaporware.md honest config-only state). Self-contained so it mounts in
 * the existing wizard without restructuring its state machine.
 */

import * as React from 'react';
import { useEffect, useState } from 'react';
import {
  Card,
  Body1,
  Body1Strong,
  Caption1,
  Field,
  Dropdown,
  Option,
  Input,
  Button,
  Spinner,
  Badge,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  field: { minWidth: '240px', flex: 1 },
});

type AppMode = 'existing' | 'new' | 'disable';
type AdminMode = 'self' | 'group';

interface IdentityState {
  msal: { configured: boolean; configuredClientId?: string; tenantId?: string; recommendation: AppMode };
  appRegistrations: { reachable: boolean; items: { appId: string; displayName: string; redirectUris: string[] }[] };
  bootstrapAdmin: { currentOid?: string; currentGroupId?: string; recommendedOid: string; recommendedUpn: string; configured: boolean };
}

export function SetupIdentityCard() {
  const styles = useStyles();
  const [data, setData] = useState<IdentityState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<AppMode>('new');
  const [existingClientId, setExistingClientId] = useState('');
  const [adminMode, setAdminMode] = useState<AdminMode>('self');
  const [groupId, setGroupId] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await clientFetch('/api/setup/identity', { cache: 'no-store' });
        const j = await r.json();
        if (!active) return;
        if (!j?.ok) {
          setError(j?.error || 'Failed to load identity status');
        } else {
          setData(j);
          setAppMode(j.msal.recommendation);
          if (j.appRegistrations?.items?.[0]?.appId) setExistingClientId(j.appRegistrations.items[0].appId);
        }
      } catch (e: any) {
        if (active) setError(e?.message || 'network error');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function apply() {
    setSaved(null);
    try {
      const r = await clientFetch('/api/setup/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appRegistration: { mode: appMode, existingClientId },
          bootstrapAdmin: { mode: adminMode, groupId },
        }),
      });
      const j = await r.json();
      setSaved(j?.ok ? 'Choice recorded — see the apply steps in the deploy receipt.' : (j?.error || 'failed'));
    } catch (e: any) {
      setSaved(e?.message || 'network error');
    }
  }

  if (loading) return <Spinner label="Checking identity configuration…" />;
  if (error) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>Identity status unavailable: {error}. The deploy still provisions the app registration by default.</MessageBarBody>
      </MessageBar>
    );
  }
  if (!data) return null;

  return (
    <Card className={styles.card}>
      <div>
        <Body1Strong>Identity &amp; admin</Body1Strong>{' '}
        {data.msal.configured ? (
          <Badge appearance="tint" color="success">Sign-in configured</Badge>
        ) : (
          <Badge appearance="tint" color="warning">Will be provisioned</Badge>
        )}
      </div>
      <Body1>
        The Entra sign-in app + client secret + a stable session secret are provisioned by default so the
        Console can sign in on first login. Choose how to wire the app registration and who the bootstrap
        admin is.
      </Body1>

      <div className={styles.row}>
        <Field className={styles.field} label="Entra app registration (MSAL sign-in)">
          <Dropdown
            value={appMode === 'new' ? 'Provision new (recommended)' : appMode === 'existing' ? 'Use existing' : 'Disable (unauthenticated)'}
            selectedOptions={[appMode]}
            onOptionSelect={(_, d) => setAppMode((d.optionValue as AppMode) || 'new')}
          >
            <Option value="new">Provision new (recommended)</Option>
            <Option value="existing" disabled={!data.appRegistrations.reachable && data.appRegistrations.items.length === 0}>
              Use existing
            </Option>
            <Option value="disable">Disable (unauthenticated)</Option>
          </Dropdown>
        </Field>
        {appMode === 'existing' && (
          <Field className={styles.field} label="Existing app (client) id">
            <Input value={existingClientId} onChange={(_, d) => setExistingClientId(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
        )}
      </div>

      <div className={styles.row}>
        <Field className={styles.field} label="Bootstrap tenant admin (can open /admin/*)">
          <Dropdown
            value={adminMode === 'self' ? `You — ${data.bootstrapAdmin.recommendedUpn} (recommended)` : 'An Entra group'}
            selectedOptions={[adminMode]}
            onOptionSelect={(_, d) => setAdminMode((d.optionValue as AdminMode) || 'self')}
          >
            <Option value="self">{`You — ${data.bootstrapAdmin.recommendedUpn} (recommended)`}</Option>
            <Option value="group">An Entra group</Option>
          </Dropdown>
        </Field>
        {adminMode === 'group' && (
          <Field className={styles.field} label="Admin group object id">
            <Input value={groupId} onChange={(_, d) => setGroupId(d.value)} placeholder="group OID" />
          </Field>
        )}
      </div>

      {data.appRegistrations.reachable && data.appRegistrations.items.length > 0 && (
        <Caption1>Found {data.appRegistrations.items.length} existing "CSA Loom Console" app registration(s) in this tenant.</Caption1>
      )}

      <div className={styles.row}>
        <Button appearance="primary" onClick={apply}>Record identity choice</Button>
      </div>
      {saved && (
        <MessageBar intent="info">
          <MessageBarBody>{saved}</MessageBarBody>
        </MessageBar>
      )}
    </Card>
  );
}

/** tiny spacer to keep the badge baseline tidy without extra deps */
function Caption1as() {
  return <span />;
}
