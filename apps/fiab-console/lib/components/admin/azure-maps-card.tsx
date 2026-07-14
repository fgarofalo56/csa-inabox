'use client';

/**
 * AzureMapsCard — the in-console runtime config for Azure Maps.
 *
 * Solves the same class of complaint the Power BI card did: geo/tapestry/map
 * editors used to read the client-baked NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY /
 * _ACCOUNT build vars, which froze at BUILD time and had nowhere in the console
 * to be set. The client no longer reads any NEXT_PUBLIC_* map var — surfaces
 * read `mapsEnabled` + `mapsAccount` at RUNTIME from GET /api/config/ui, the
 * raster basemap is fetched through the credential-free /api/maps/static proxy,
 * and the account label is settable HERE (real Cosmos + audit).
 *
 * The account label is non-secret (it's the public x-ms-client-id the browser
 * SDK sends). The actual CREDENTIAL (LOOM_AZURE_MAPS_CLIENT_ID for AAD, preferred
 * / gov-safe, or LOOM_AZURE_MAPS_KEY) stays a server-side setting — this card
 * reports whether it is configured and names the honest remediation when not.
 *
 * Backend: GET/PUT /api/admin/platform-settings (mapsAccount) + GET /api/config/ui
 * (mapsEnabled — credential present, checked without minting a token).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Button, Input, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Title3, Body1, Caption1, Field, makeStyles, tokens,
} from '@fluentui/react-components';
import { Map24Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { invalidatePlatformConfig } from '@/lib/components/platform-config';

const useStyles = makeStyles({
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL,
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  headerText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  icon: {
    display: 'grid', placeItems: 'center', width: '40px', height: '40px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2,
  },
  row: {
    display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  field: { flex: 1, minWidth: '260px' },
  hint: { color: tokens.colorNeutralForeground3 },
  meta: { color: tokens.colorNeutralForeground3, display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
});

export function AzureMapsCard() {
  const s = useStyles();
  const [account, setAccount] = useState('');
  const [envFallback, setEnvFallback] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      clientFetch('/api/admin/platform-settings').then((r) => r.json()).catch(() => ({})),
      clientFetch('/api/config/ui').then((r) => r.json()).catch(() => ({})),
    ])
      .then(([admin, cfg]) => {
        if (admin?.ok) {
          setAccount(typeof admin.mapsAccount === 'string' ? admin.mapsAccount : '');
          setEnvFallback(admin.mapsEnvFallback ?? null);
        } else if (admin?.error) {
          setError(admin.error);
        }
        setConfigured(cfg?.mapsEnabled === true);
        setDirty(false);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(() => {
    setSaving(true);
    setError(null);
    clientFetch('/api/admin/platform-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapsAccount: account.trim() }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) {
          setSavedAt(new Date().toLocaleTimeString());
          setDirty(false);
          invalidatePlatformConfig(); // editors re-read the account at runtime
        } else {
          setError(d?.error || 'Failed to save');
        }
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setSaving(false));
  }, [account]);

  return (
    <Card className={s.card}>
      <div className={s.header}>
        <span className={s.icon}><Map24Regular /></span>
        <div className={s.headerText}>
          <Title3>Azure Maps</Title3>
          <Caption1 className={s.hint}>
            Runtime config for the geo / tapestry / map editors&apos; live basemap. No build var — set it here.
          </Caption1>
        </div>
      </div>

      {loading ? (
        <Spinner size="tiny" label="Loading…" labelPosition="after" />
      ) : (
        <>
          <div className={s.row}>
            <Field className={s.field} label="Azure Maps account (name / uniqueId)" hint="Non-secret — the public x-ms-client-id the browser SDK sends. Prefills the geo editors.">
              <Input
                value={account}
                placeholder={envFallback || 'e.g. maps-loom-<suffix>'}
                onChange={(_, d) => { setAccount(d.value); setDirty(true); }}
              />
            </Field>
            <Button appearance="primary" disabled={saving || !dirty} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>

          <div className={s.meta}>
            <Badge appearance="tint" color={configured ? 'success' : 'informative'}>
              Basemap: {configured ? 'Configured' : 'Vector-only (no credential)'}
            </Badge>
            {envFallback && !account && <Caption1 className={s.hint}>Falling back to env account <code>{envFallback}</code></Caption1>}
            {savedAt && !saving && <Caption1 className={s.hint}>Saved {savedAt}</Caption1>}
          </div>

          {!configured && (
            <MessageBar intent="info" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Live basemap needs a server-side credential</MessageBarTitle>
                Geo surfaces render the vector overlay without Azure Maps. To layer the live raster basemap, provision{' '}
                <code>Microsoft.Maps/accounts</code> (see{' '}
                <code>platform/fiab/bicep/modules/landing-zone/azure-maps.bicep</code>), set{' '}
                <code>LOOM_MAPS_BACKEND=azure-maps</code> plus a credential — <code>LOOM_AZURE_MAPS_CLIENT_ID</code>{' '}
                (Entra, preferred / gov-safe; grant the Console identity &quot;Azure Maps Data Reader&quot;) or{' '}
                <code>LOOM_AZURE_MAPS_KEY</code> (subscription key, Commercial only). The credential is server-side —
                it never reaches the browser (the /api/maps/* proxy brokers it). No Power BI / Fabric required.
              </MessageBarBody>
            </MessageBar>
          )}

          {error && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}
        </>
      )}
    </Card>
  );
}
