'use client';

/**
 * Recipient view (FGC-30) — what an external B2B guest sees after redeeming the
 * invite. Lists every external share addressed to the caller's email (real
 * /api/external-shares/received), and lets the guest ACCEPT a pending share
 * (POST .../accept). An accepted share shows the read-only subset + the ADLS
 * coordinates the guest can read via their scoped grant. No Fabric dependency.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Card, CardHeader, Body1, Caption1, Subtitle2, Badge, Button, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Globe24Regular, CheckmarkCircle20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try { r = await clientFetch(input, init); }
  catch (e: any) { return { ok: false, status: 0, error: e?.message || String(e) }; }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return { ok: false, status: r.status, error: `Unexpected ${ct || 'response'} (HTTP ${r.status})` };
  try { return await r.json(); } catch (e: any) { return { ok: false, status: r.status, error: String(e) }; }
}

interface ReceivedShare {
  id: string;
  sourceItemId: string;
  sourceItemName?: string;
  sourceItemType: string;
  container: string;
  sharedPath: string;
  readOnly: boolean;
  expiry: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdAt: string;
}

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { padding: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'center', marginTop: tokens.spacingVerticalS },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
});

function color(s: ReceivedShare['state']): 'success' | 'warning' | 'danger' | 'informative' {
  return s === 'accepted' ? 'success' : s === 'pending' ? 'warning' : s === 'expired' ? 'informative' : 'danger';
}

export function ReceivedSharesView() {
  const s = useStyles();
  const [rows, setRows] = useState<ReceivedShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const r = await fetchJson('/api/external-shares/received');
    setLoading(false);
    if (r?.ok === false) { setError(r.error || 'Failed to load your shares'); return; }
    setRows(Array.isArray(r.shares) ? r.shares : []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const accept = useCallback(async (row: ReceivedShare) => {
    setAccepting(row.id);
    const r = await fetchJson(`/api/external-shares/${encodeURIComponent(row.id)}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceItemId: row.sourceItemId }),
    });
    setAccepting(null);
    if (r?.ok === false) { setError(r.error || 'Accept failed'); return; }
    void load();
  }, [load]);

  if (loading) return <Spinner label="Loading shares…" />;

  return (
    <div className={s.list}>
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {rows.length === 0 && !error && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Nothing shared with you yet</MessageBarTitle>
            When another organization shares data with your account, it appears here. If you just redeemed an
            invitation, give it a moment and refresh.
          </MessageBarBody>
        </MessageBar>
      )}
      {rows.map((row) => (
        <Card key={row.id} className={s.card}>
          <CardHeader
            image={<Globe24Regular />}
            header={<Subtitle2>{row.sourceItemName || row.sourceItemId}</Subtitle2>}
            description={<Caption1>{row.sourceItemType} · read-only</Caption1>}
            action={<Badge appearance="tint" color={color(row.state)}>{row.state}</Badge>}
          />
          <Divider />
          <div className={s.row}>
            <Caption1>Subset: <span className={s.mono}>{row.container}/{row.sharedPath}</span></Caption1>
            <Caption1>Expires: <strong>{row.expiry ? new Date(row.expiry).toLocaleDateString() : '—'}</strong></Caption1>
          </div>
          {row.state === 'pending' && (
            <div className={s.row}>
              <Button appearance="primary" icon={accepting === row.id ? <Spinner size="tiny" /> : <CheckmarkCircle20Regular />} disabled={accepting === row.id} onClick={() => accept(row)}>
                Accept share
              </Button>
            </div>
          )}
          {row.state === 'accepted' && (
            <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalS }}>
              <MessageBarBody>
                <MessageBarTitle>Access confirmed</MessageBarTitle>
                You can read <span className={s.mono}>{row.container}/{row.sharedPath}</span> in the sharing
                organization&apos;s data lake with your guest identity (read-only). Use your ADLS client / Storage
                Explorer against that path.
              </MessageBarBody>
            </MessageBar>
          )}
        </Card>
      ))}
    </div>
  );
}

export default ReceivedSharesView;
