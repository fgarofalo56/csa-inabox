'use client';

/**
 * Settings -> Runtime (W1-8, Q9): which Entra group(s) hold the apiplane-admin
 * capability, and the remediation (with a one-click Fix it to /admin/permissions)
 * when none does. Tenant admins are always a superset, so the tab says so.
 */
import { useEffect, useState } from 'react';
import { Badge, Body1, Button, Caption1, MessageBar, MessageBarActions, MessageBarBody, Spinner, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { PeopleTeam24Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

export interface RuntimeData {
  capability: string;
  groups: Array<{ id: string; displayName: string; role: string }>;
  users: number;
  capabilityUsed: 'apiplane-admin' | 'tenant-admin';
  remediation: string | null;
}

const PERMISSIONS_URL = '/admin/permissions';

async function getRuntime(): Promise<{ ok: boolean; data?: RuntimeData; error?: string }> {
  try {
    // A computed URL (wide `string`) passes clientFetch's route check by design (same as ./api.ts).
    const url: string = '/api/admin/api-gateway/runtime';
    const res = await clientFetch(url, { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    return { ok: Boolean(json.ok), data: json.data, error: json.error ?? json.remediation };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request failed' };
  }
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function RuntimeTab() {
  const s = useStyles();
  const [res, setRes] = useState<Awaited<ReturnType<typeof getRuntime>> | null>(null);
  useEffect(() => { void getRuntime().then(setRes); }, []);

  if (!res) return <Spinner label="Loading plane administration" />;
  if (!res.ok || !res.data) {
    return <MessageBar intent="error"><MessageBarBody>{res.error ?? 'Plane administration is unavailable.'}</MessageBarBody></MessageBar>;
  }
  const d = res.data;
  return (
    <div className={s.root}>
      <Caption1 className={s.muted}>
        Plane administration is the <b>{d.capability}</b> capability, granted to an Entra group at Admin &rarr; Permissions. Tenant admins always have it.
      </Caption1>
      {d.groups.length === 0 ? (
        <MessageBar intent="warning">
          <MessageBarBody>{d.remediation}</MessageBarBody>
          <MessageBarActions>
            <Button as="a" href={PERMISSIONS_URL} appearance="primary">Grant to a group</Button>
          </MessageBarActions>
        </MessageBar>
      ) : (
        d.groups.map((g) => (
          <div key={g.id} className={s.card}>
            <div className={s.row}>
              <PeopleTeam24Regular />
              <Subtitle2>{g.displayName}</Subtitle2>
              <Badge appearance="tint" color="brand">{g.role}</Badge>
            </div>
            <Caption1 className={s.muted}>Entra group {g.id}</Caption1>
          </div>
        ))
      )}
      <Body1>You are administering as <Badge appearance="outline">{d.capabilityUsed}</Badge></Body1>
    </div>
  );
}
