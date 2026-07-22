'use client';

/**
 * AdminRuntimeFlagsPane — the /admin Runtime-flags panel (FLAG0).
 *
 * Lists every REGISTERED runtime kill-switch (typed registry in
 * lib/admin/runtime-flags.ts) with its live Cosmos state and a Switch that
 * flips it WITHOUT a deploy: PUT /api/admin/runtime-flags/[id] upserts the
 * flag doc, invalidates the read cache, and writes the audit-log row — the
 * surface reverts to its pre-item behavior on the next load (replicas
 * converge within ≤15 s). Default-ON per loom_default_on_opt_out; flags are
 * operational kill-switches, never spend/config gates.
 *
 * Real backend only (no-vaporware.md): every row comes from
 * GET /api/admin/runtime-flags (registry ⋈ Cosmos); a Cosmos-less deployment
 * gets the honest MessageBar naming LOOM_COSMOS_ENDPOINT.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  makeStyles, tokens, Badge, Body1, Caption1, Subtitle2, Switch, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import { ToggleLeft24Regular, ShieldTask24Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface FlagState {
  id: string;
  label: string;
  description: string;
  ownerItem: string;
  surface: string;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  card: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalL,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  cardIcon: {
    display: 'flex', flexShrink: 0, color: tokens.colorBrandForeground1,
    marginTop: tokens.spacingVerticalXXS,
  },
  cardBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, flexGrow: 1 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  switchWrap: { flexShrink: 0, display: 'flex', alignItems: 'center' },
});

async function fetchFlags(): Promise<{ ok: boolean; flags?: FlagState[]; error?: string; status: number }> {
  const res = await clientFetch('/api/admin/runtime-flags', { cache: 'no-store' });
  const json = await res.json().catch(() => ({}));
  return { ...json, status: res.status };
}

export function AdminRuntimeFlagsPane() {
  const s = useStyles();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flipError, setFlipError] = useState<string | null>(null);
  const { data, isLoading, refetch } = useQuery({ queryKey: ['admin-runtime-flags'], queryFn: fetchFlags });

  const flip = async (id: string, enabled: boolean) => {
    setBusyId(id);
    setFlipError(null);
    try {
      const res = await clientFetch(`/api/admin/runtime-flags/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok !== true) throw new Error(json?.error || `HTTP ${res.status}`);
      await refetch();
    } catch (e) {
      setFlipError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) return <Spinner label="Loading runtime flags…" />;
  if (data?.status === 401) return <SignInRequired />;
  if (data?.status === 403) {
    return (
      <MessageBar intent="warning" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Tenant admins only</MessageBarTitle>
          Runtime flags revert user-visible surfaces deployment-wide, so this panel is restricted to
          tenant admins. {data?.error}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!data?.ok) {
    return (
      <MessageBar intent="error" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>Runtime flags unavailable</MessageBarTitle>
          {data?.error ||
            'Could not read runtime flags — Cosmos DB is required. Set LOOM_COSMOS_ENDPOINT and grant the Console UAMI "Cosmos DB Built-in Data Contributor".'}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const flags = data.flags ?? [];
  if (flags.length === 0) {
    return (
      <EmptyState
        icon={<ToggleLeft24Regular />}
        title="No runtime flags registered yet"
        body="Features register a kill-switch here in the same PR that ships their flagged surface (registry: lib/admin/runtime-flags.ts). Every registered flag is default-ON; flipping one OFF reverts its surface to the previous behavior instantly — no rebuild, no revision roll."
      />
    );
  }

  return (
    <div className={s.root}>
      <MessageBar intent="info" layout="multiline">
        <MessageBarBody>
          Flags are default-ON operational kill-switches. Flipping one OFF reverts its surface to the
          pre-feature behavior on the next page load — no deploy. Every flip is written to the audit
          log (who, prior/new state, timestamp) and streams to the SIEM audit trail.
        </MessageBarBody>
      </MessageBar>
      {flipError && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Flip failed</MessageBarTitle>
            {flipError}
          </MessageBarBody>
        </MessageBar>
      )}
      {flags.map((f) => (
        <div key={f.id} className={s.card}>
          <span className={s.cardIcon} aria-hidden><ShieldTask24Regular /></span>
          <div className={s.cardBody}>
            <div className={s.badgeRow}>
              <Subtitle2>{f.label}</Subtitle2>
              <Badge appearance="tint" color={f.enabled ? 'success' : 'danger'}>
                {f.enabled ? 'On' : 'Off — surface reverted'}
              </Badge>
              <Badge appearance="outline">{f.ownerItem}</Badge>
            </div>
            <Body1>{f.description}</Body1>
            <Caption1 className={s.hint}>Surface: {f.surface}</Caption1>
            <Caption1 className={s.hint}>
              {f.updatedAt
                ? `Last changed ${new Date(f.updatedAt).toLocaleString()}${f.updatedBy ? ` by ${f.updatedBy}` : ''} (audited)`
                : 'Never flipped — running at the default (On)'}
            </Caption1>
          </div>
          <div className={s.switchWrap}>
            <Switch
              checked={f.enabled}
              disabled={busyId !== null}
              label={f.enabled ? 'On' : 'Off'}
              aria-label={`${f.label} — ${f.enabled ? 'on' : 'off'}`}
              onChange={(_e, d) => void flip(f.id, !!d.checked)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
