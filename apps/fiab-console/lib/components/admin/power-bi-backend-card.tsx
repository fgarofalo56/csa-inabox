'use client';

/**
 * PowerBiBackendCard — the in-console runtime toggle for the Power BI backend.
 *
 * Solves the operator's complaint: editors said "Power BI embed is opt-in — set
 * NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi to enable", but that var is baked into the
 * client bundle at BUILD time and there was NOWHERE in the console to set it.
 * This switch writes a RUNTIME platform setting (Cosmos, admin-gated) that the
 * editors read live via GET /api/config/ui — flipping it needs no rebuild and no
 * env var.
 *
 * Azure-native is the DEFAULT and never auto-enabled (no-fabric-dependency.md):
 * turning this ON is an explicit, disclosed opt-in to the Fabric-family Power BI
 * path (model build + workspace sync + embed). A Power BI workspace / capacity is
 * still a genuine external requirement — the honest note below names it — but the
 * ENABLE control itself now lives here.
 *
 * Backend: GET/PUT /api/admin/platform-settings (real Cosmos + audit).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Card, Switch, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Title3, Body1, Caption1, Link, makeStyles, tokens,
} from '@fluentui/react-components';
import { DataArea24Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { invalidatePlatformConfig } from '@/lib/components/platform-config';

type BiBackendMode = 'loom-native' | 'powerbi';
type BiBackendSource = 'runtime' | 'env' | 'default';

interface BiBackendResolution {
  mode: BiBackendMode;
  source: BiBackendSource;
  runtimeValue?: BiBackendMode;
  envValue?: string;
  updatedAt?: string;
  updatedBy?: string;
}

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    marginBottom: tokens.spacingVerticalL,
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  headerText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  icon: {
    display: 'grid', placeItems: 'center',
    width: '40px', height: '40px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  toggleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  toggleText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  meta: { color: tokens.colorNeutralForeground3, display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
});

export function PowerBiBackendCard() {
  const s = useStyles();
  const [res, setRes] = useState<BiBackendResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    clientFetch('/api/admin/platform-settings')
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && d.biBackend) setRes(d.biBackend as BiBackendResolution);
        else setError(d?.error || 'Failed to load platform settings');
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const onToggle = useCallback((enabled: boolean) => {
    const mode: BiBackendMode = enabled ? 'powerbi' : 'loom-native';
    setSaving(true);
    setError(null);
    clientFetch('/api/admin/platform-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ biBackend: mode }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && d.biBackend) {
          setRes(d.biBackend as BiBackendResolution);
          setSavedAt(new Date().toLocaleTimeString());
          // Drop the client config cache so editors re-read the new value.
          invalidatePlatformConfig();
        } else {
          setError(d?.error || 'Failed to save');
        }
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setSaving(false));
  }, []);

  const enabled = res?.mode === 'powerbi';

  return (
    <Card className={s.card}>
      <div className={s.header}>
        <span className={s.icon}><DataArea24Regular /></span>
        <div className={s.headerText}>
          <Title3>Power BI backend</Title3>
          <Caption1 className={s.hint}>
            Opt in to the Fabric-family Power BI path for BI models and reports. Azure-native is the default.
          </Caption1>
        </div>
      </div>

      {loading ? (
        <Spinner size="tiny" label="Loading…" labelPosition="after" />
      ) : (
        <>
          <div className={s.toggleRow}>
            <div className={s.toggleText}>
              <Body1><strong>Enable Power BI backend (model build + workspace sync + embed)</strong></Body1>
              <Caption1 className={s.hint}>
                When ON, BI editors (Semantic model, Report, Dashboard, Paginated report, Scorecard) show the
                Power BI workspace picker, embed, and Weave&nbsp;→&nbsp;Power BI model-build. When OFF, Loom uses
                the Azure-native path (Loom-native tabular over your warehouse/lakehouse + Loom-native report
                renderer) — no Power BI workspace required.
              </Caption1>
            </div>
            <Switch
              checked={enabled}
              disabled={saving}
              onChange={(_, data) => onToggle(!!data.checked)}
              label={enabled ? 'On' : 'Off'}
            />
          </div>

          <div className={s.meta}>
            <Badge appearance="tint" color={enabled ? 'brand' : 'informative'}>
              Active: {enabled ? 'Power BI' : 'Azure-native (Loom-native)'}
            </Badge>
            {res?.source === 'runtime' && <Caption1 className={s.hint}>Set in console{res.updatedBy ? ` by ${res.updatedBy}` : ''}</Caption1>}
            {res?.source === 'env' && <Caption1 className={s.hint}>From LOOM_BI_BACKEND env (deploy-time fallback)</Caption1>}
            {res?.source === 'default' && <Caption1 className={s.hint}>Default (no override set)</Caption1>}
            {saving && <Spinner size="extra-tiny" label="Saving…" labelPosition="after" />}
            {savedAt && !saving && <Caption1 className={s.hint}>Saved {savedAt}</Caption1>}
          </div>

          {enabled && (
            <MessageBar intent="info" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Power BI workspace still required</MessageBarTitle>
                Enabling the backend turns on the UI + REST paths. To publish models and embed reports you still
                need a real Power BI workspace where the Console identity is a Member/Contributor. Map it under{' '}
                <Link href="/admin/tenant-settings">Copilot &amp; Agents</Link> or the workspace&apos;s Power BI
                settings. This is a genuine external requirement — the toggle here is the in-console opt-in.
              </MessageBarBody>
            </MessageBar>
          )}

          {res?.source === 'runtime' && res.envValue && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                The runtime setting is overriding the deploy-time <code>LOOM_BI_BACKEND={res.envValue}</code> env
                var. The value you set here wins at runtime.
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
