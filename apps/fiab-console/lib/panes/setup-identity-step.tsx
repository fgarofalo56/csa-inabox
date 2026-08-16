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
 * Both principal fields were free-text until Wave 1C: the app (client) id was a
 * GUID box even though `/api/setup/identity` had ALREADY discovered the tenant's
 * app registrations, and the admin group was a "group OID" box. Both are now
 * pickers over real discovery, and both keep a stored value the directory can no
 * longer resolve (an app registration deleted out-of-band, a group in another
 * tenant) rather than dropping it on load.
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
  Button,
  Spinner,
  Badge,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { IdentityPicker } from '@/lib/components/ui/identity-picker';

const useStyles = makeStyles({
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  field: { minWidth: '240px', flex: 1 },
});

type AppMode = 'existing' | 'new' | 'disable';
type AdminMode = 'self' | 'group';

/** Sentinel option value — "search every app registration, not just the scanned ones". */
const OTHER_APP = '__other__';

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
  const [searchAllApps, setSearchAllApps] = useState(false);
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

  // Discovered app registrations, plus the recorded choice when the scan no
  // longer returns it — the value must survive a scan that came back empty.
  const discovered = data.appRegistrations.items || [];
  const appRegOptions = [
    ...discovered.map((a) => ({ appId: a.appId, label: `${a.displayName} — ${a.appId}` })),
    ...(existingClientId && !discovered.some((a) => a.appId === existingClientId)
      ? [{ appId: existingClientId, label: `${existingClientId} (recorded; not returned by the current scan)` }]
      : []),
  ];
  const appRegLabel = appRegOptions.find((a) => a.appId === existingClientId)?.label ?? '';

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
          <Field className={styles.field} label="Existing app registration">
            {/* The scan already knows the tenant's Loom app registrations, so
                the id is CHOSEN, not typed. A stored id the scan no longer
                returns (deleted, renamed, or the scan itself unreachable) is
                kept as its own option so re-opening the wizard cannot silently
                blank a recorded choice.

                "Other / search all app registrations" is ALWAYS offered, not
                only when the scan came back empty. `discoverApps()` filters
                `startswith(displayName,'CSA Loom Console')`, so an operator
                with one matching app plus the differently-named one they
                actually want would otherwise have no way to reach the latter —
                they used to type its client id. Keying the fallback on an
                EMPTY list was the bug; keying it on the operator's choice is
                the fix. */}
            {!searchAllApps && appRegOptions.length > 0 ? (
              <Dropdown
                placeholder="Select an app registration"
                value={appRegLabel}
                selectedOptions={existingClientId ? [existingClientId] : []}
                onOptionSelect={(_, d) => {
                  const v = String(d.optionValue || '');
                  if (v === OTHER_APP) { setSearchAllApps(true); setExistingClientId(''); return; }
                  setExistingClientId(v);
                }}
              >
                {appRegOptions.map((a) => (
                  <Option key={a.appId} value={a.appId} text={a.label}>{a.label}</Option>
                ))}
                <Option value={OTHER_APP} text="Other / search all app registrations…">
                  Other / search all app registrations…
                </Option>
              </Dropdown>
            ) : (
              <>
                <IdentityPicker
                  kind="spn"
                  label="Search the tenant's app registrations"
                  placeholder="App registration display name"
                  value={existingClientId}
                  onChange={(id, hit) => setExistingClientId(hit?.appId || id)}
                />
                {appRegOptions.length > 0 && (
                  <Button
                    appearance="transparent"
                    size="small"
                    onClick={() => { setSearchAllApps(false); setExistingClientId(''); }}
                  >
                    Back to the {appRegOptions.length} discovered registration(s)
                  </Button>
                )}
              </>
            )}
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
          <div className={styles.field}>
            <IdentityPicker
              kind="group"
              label="Admin group"
              hint="Members of this Entra security group can open /admin/*."
              value={groupId}
              onChange={(id) => setGroupId(id)}
            />
          </div>
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
