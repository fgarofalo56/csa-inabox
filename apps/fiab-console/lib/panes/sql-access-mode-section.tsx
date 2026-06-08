'use client';

/**
 * SQL endpoint data-access mode section (F10).
 *
 * Renders the "Data access mode" control for a SQL analytics endpoint
 * (synapse-dedicated-sql-pool / synapse-serverless-sql-pool):
 *   - Delegated (service identity)  — queries run as the Loom console service
 *     principal/UAMI. Always works; no per-user SQL provisioning.
 *   - User's identity               — queries run as the signed-in user's own
 *     Azure identity (so RLS / SUSER_NAME() / SQL audit reflect the real user).
 *
 * Switching TO user's identity shows a one-time confirmation dialog explaining
 * the consequence and the prerequisite (the user must be provisioned in the SQL
 * endpoint). The selection is persisted via PATCH .../access-mode (Cosmos) and
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

interface Props {
  itemId: string;
  itemType: 'synapse-dedicated-sql-pool' | 'synapse-serverless-sql-pool';
}

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '6px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  radioGroup: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  hint: { color: tokens.colorNeutralForeground3, paddingLeft: '28px', marginBottom: '4px' },
  desc: { color: tokens.colorNeutralForeground3 },
  dialogBody: { display: 'flex', flexDirection: 'column', rowGap: '12px' },
});

export function SqlAccessModeSection({ itemId, itemType }: Props) {
  const s = useStyles();
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
      fetch(`/api/items/${itemType}/${itemId}`).then((r) => r.json()).catch(() => null),
      fetch('/api/me').then((r) => r.json()).catch(() => null),
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
      const res = await fetch(`/api/items/${itemType}/${itemId}/access-mode`, {
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
      <Body1 className={s.desc}>
        Controls which Azure identity executes queries against this SQL endpoint.
      </Body1>
      <RadioGroup className={s.radioGroup} value={mode} onChange={onRadioChange} disabled={saving}>
        <Radio value="service" label="Delegated (service identity)" />
        <Caption1 className={s.hint}>
          Queries run as the Loom console service identity (managed identity). The console identity must have
          access to the SQL endpoint. This is the default and always works.
        </Caption1>
        <Radio value="user" label="User's identity" />
        <Caption1 className={s.hint}>
          Queries run as your own signed-in Azure identity, so row-level security, SUSER_NAME() and the SQL audit
          log reflect you. Your account must be provisioned in the SQL endpoint.
        </Caption1>
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
                  Your Azure account must be a contained database user (Dedicated pool) or hold the required
                  Storage access (Serverless OPENROWSET) on this workspace. If your SQL token has expired, sign
                  out and sign back in. This is a one-time choice — it persists and applies to all future queries
                  from this endpoint until you switch back.
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
