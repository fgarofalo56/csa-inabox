'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Data-access mode section (F10 / EH-P1-OBO #1800).
 *
 * Renders the "Data access mode" control for an item whose data-plane READS can
 * run under the signed-in user's own Azure identity (on-behalf-of) instead of
 * the Loom service identity — the SQL analytics endpoints
 * (synapse-dedicated-sql-pool / synapse-serverless-sql-pool) plus `report`
 * (Loom-native Synapse visuals) and `kql-database` (ADX queries):
 *   - Delegated (service identity)  — reads run as the Loom console service
 *     principal/UAMI. Always works; no per-user provisioning.
 *   - User's identity               — reads run as the signed-in user's own
 *     Azure identity (so RLS / SUSER_NAME() / audit reflect the real user).
 *
 * Switching TO user's identity shows a one-time confirmation dialog explaining
 * the consequence and the prerequisite (the user must be provisioned in the
 * backend). The selection is persisted via PATCH .../access-mode (Cosmos) and
 * re-read on mount, so it survives reload. Real network calls only — no mock
 * state; on failure the radio snaps back and a MessageBar shows the error.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  RadioGroup, Radio, Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogActions, DialogContent, Button, MessageBar, MessageBarBody, MessageBarTitle,
  Body1Strong, Body1, Caption1, Spinner, tokens, makeStyles,
} from '@fluentui/react-components';

export type SqlAccessMode = 'service' | 'user';

/** Item types whose editor exposes this control (⊆ USER_ACCESS_MODE_ITEM_TYPES). */
export type AccessModeItemType =
  | 'synapse-dedicated-sql-pool'
  | 'synapse-serverless-sql-pool'
  | 'report'
  | 'kql-database';

interface Props {
  itemId: string;
  itemType: AccessModeItemType;
}

/** Per-item-type copy so the same control reads correctly on each surface. */
function copyFor(itemType: AccessModeItemType): {
  noun: string;
  description: string;
  userHint: string;
  dialogPrereq: string;
} {
  switch (itemType) {
    case 'report':
      return {
        noun: 'report',
        description:
          'Controls which Azure identity executes this report’s visual queries against its ' +
          'Loom-native (Synapse) data source.',
        userHint:
          'Visual queries run as your own signed-in Azure identity, so row-level security and the ' +
          'SQL audit log reflect you. Your account must be provisioned in the report’s Synapse source. ' +
          'Applies to the Loom-native (Synapse) and delegatable Synapse-connection sources; other ' +
          'sources return an honest message.',
        dialogPrereq:
          'Your Azure account must be a contained database user (dedicated pool) or hold the required ' +
          'Storage access (serverless OPENROWSET) on this report’s Synapse source. If your SQL token ' +
          'has expired, sign out and sign back in.',
      };
    case 'kql-database':
      return {
        noun: 'KQL database',
        description:
          'Controls which Azure identity executes queries against this KQL database (Azure Data Explorer).',
        userHint:
          'Queries run as your own signed-in Azure identity, so ADX row-level security and audit ' +
          'reflect you. Your account must hold a database principal (Viewer or higher) on the target ' +
          'ADX database.',
        dialogPrereq:
          'Your Azure account must be a database principal (Viewer or higher) on this ADX database, and ' +
          'the Loom app registration must have the Azure Data Explorer delegated permission with admin ' +
          'consent. If your token has expired, sign out and sign back in.',
      };
    default:
      return {
        noun: 'SQL endpoint',
        description: 'Controls which Azure identity executes queries against this SQL endpoint.',
        userHint:
          'Queries run as your own signed-in Azure identity, so row-level security, SUSER_NAME() and the ' +
          'SQL audit log reflect you. Your account must be provisioned in the SQL endpoint.',
        dialogPrereq:
          'Your Azure account must be a contained database user (Dedicated pool) or hold the required ' +
          'Storage access (Serverless OPENROWSET) on this workspace. If your SQL token has expired, sign ' +
          'out and sign back in.',
      };
  }
}

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  radioGroup: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS },
  hint: { color: tokens.colorNeutralForeground3, paddingLeft: '28px', marginBottom: tokens.spacingVerticalXXS },
  desc: { color: tokens.colorNeutralForeground3 },
  dialogBody: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
});

export function SqlAccessModeSection({ itemId, itemType }: Props) {
  const s = useStyles();
  const copy = copyFor(itemType);
  const [mode, setMode] = useState<SqlAccessMode>('service');
  const [upn, setUpn] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<SqlAccessMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the persisted mode (item.state.accessMode) + the signed-in user's UPN.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      clientFetch(`/api/items/${itemType}/${itemId}`).then((r) => r.json()).catch(() => null),
      clientFetch('/api/me').then((r) => r.json()).catch(() => null),
    ]).then(([item, me]) => {
      if (cancelled) return;
      const m = (item?.state?.accessMode === 'user' ? 'user' : 'service') as SqlAccessMode;
      setMode(m);
      setUpn(me?.user?.upn ?? null);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [itemId, itemType]);

  const applyMode = useCallback(async (m: SqlAccessMode) => {
    setSaving(true);
    setError(null);
    try {
      const res = await clientFetch(`/api/items/${itemType}/${itemId}/access-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessMode: m }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${res.status}`);
      setMode((j?.accessMode === 'user' ? 'user' : 'service') as SqlAccessMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setPending(null);
    }
  }, [itemId, itemType]);

  function onRadioChange(_: unknown, d: { value: string }) {
    const next = d.value as SqlAccessMode;
    if (next === mode) return;
    if (next === 'user') {
      // One-time confirmation when switching to user's identity.
      setPending('user');
    } else {
      // Switching back to the service identity is always safe — no dialog.
      applyMode('service');
    }
  }

  if (!loaded) {
    return (
      <div className={s.section}>
        <Spinner size="tiny" label="Loading data access mode…" labelPosition="after" />
      </div>
    );
  }

  return (
    <div className={s.section}>
      <Body1Strong>Data access mode</Body1Strong>
      <Body1 className={s.desc}>{copy.description}</Body1>
      <RadioGroup className={s.radioGroup} value={mode} onChange={onRadioChange} disabled={saving}>
        <Radio value="service" label="Delegated (service identity)" />
        <Caption1 className={s.hint}>
          Queries run as the Loom console service identity (managed identity). The console identity must have
          access to the {copy.noun}. This is the default and always works.
        </Caption1>
        <Radio value="user" label="User's identity" />
        <Caption1 className={s.hint}>{copy.userHint}</Caption1>
      </RadioGroup>

      {saving && <Spinner size="tiny" label="Saving…" labelPosition="after" />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not change mode</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* One-time confirmation when switching to user's identity. */}
      <Dialog
        open={pending === 'user'}
        onOpenChange={(_, d) => { if (!d.open) setPending(null); }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Switch to user&apos;s identity?</DialogTitle>
            <DialogContent>
              <div className={s.dialogBody}>
                <Body1>
                  From now on, queries on this endpoint will execute as{' '}
                  <strong>{upn ?? 'your signed-in account'}</strong> instead of the Loom service identity.
                </Body1>
                <Body1 className={s.desc}>
                  {copy.dialogPrereq} This is a one-time choice — it persists and applies to all future queries
                  from this {copy.noun} until you switch back.
                </Body1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => applyMode('user')} disabled={saving}>
                {saving ? 'Saving…' : "Confirm — use my identity"}
              </Button>
              <Button appearance="secondary" onClick={() => setPending(null)} disabled={saving}>
                Cancel
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
