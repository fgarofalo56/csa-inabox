'use client';

/**
 * External-tenant share panel (FGC-30) — the "External tenant" tab of the Share
 * dialog. Shares a storage-backed item (lakehouse / dataset) to a FOREIGN Entra
 * tenant guest, read-only, scoped to a folder/table subset, with an expiry —
 * the Azure-native cross-tenant path (Entra B2B guest + scoped ADLS grant), no
 * Microsoft Fabric dependency.
 *
 * Real backend: POST/GET/DELETE /api/external-shares. When external sharing is
 * not enabled the create call returns a 503 honest gate naming the exact env var
 * + Graph permission (rendered as a warning MessageBar) — per no-vaporware.md.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Input, Field, Badge, Spinner, Caption1, Divider, Persona, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Globe20Regular, Delete16Regular, ShareRegular, Copy16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  validateExternalShare, type ExternalShareState,
} from '@/lib/azure/external-share-model';

async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try { r = await clientFetch(input, init); }
  catch (e: any) { return { ok: false, status: 0, error: e?.message || String(e) }; }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return { ok: false, status: r.status, error: `Unexpected ${ct || 'response'} (HTTP ${r.status})` };
  }
  try { return await r.json(); } catch (e: any) { return { ok: false, status: r.status, error: String(e) }; }
}

interface ExternalShareRow {
  id: string;
  targetEmail: string;
  targetDomain: string;
  sharedPath: string;
  expiry: string;
  state: ExternalShareState;
  createdAt: string;
  inviteRedeemUrl?: string;
}

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingVerticalM },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  tableWrap: { maxHeight: '220px', overflowY: 'auto' },
});

function stateColor(s: ExternalShareState): 'success' | 'warning' | 'danger' | 'informative' {
  return s === 'accepted' ? 'success' : s === 'pending' ? 'warning' : s === 'expired' ? 'informative' : 'danger';
}

export interface ExternalSharePanelProps {
  itemId: string;
  itemType: string;
  /** False when the item has no resolved ADLS storage path (external sharing needs one). */
  hasStoragePath?: boolean;
}

export function ExternalSharePanel({ itemId, itemType, hasStoragePath }: ExternalSharePanelProps) {
  const s = useStyles();
  const [target, setTarget] = useState('');
  const [sharedPath, setSharedPath] = useState('');
  const [expiry, setExpiry] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10); // yyyy-mm-dd (date input)
  });
  const [rows, setRows] = useState<ExternalShareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchJson(`/api/external-shares?sourceItemId=${encodeURIComponent(itemId)}&sourceItemType=${encodeURIComponent(itemType)}`);
    setLoading(false);
    if (r?.ok) setRows(Array.isArray(r.shares) ? r.shares : []);
  }, [itemId, itemType]);

  useEffect(() => { void load(); }, [load]);

  // Expiry as an ISO instant at end-of-day of the picked date.
  const expiryIso = useMemo(() => {
    if (!expiry) return '';
    const d = new Date(`${expiry}T23:59:59`);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }, [expiry]);

  const validation = useMemo(() => validateExternalShare({
    sourceItemId: itemId,
    container: hasStoragePath === false ? '' : 'resolved', // server resolves the real container
    sharedPath,
    targetUpnOrDomain: target,
    expiry: expiryIso,
  }), [itemId, hasStoragePath, sharedPath, target, expiryIso]);

  const create = useCallback(async () => {
    setBusy(true); setError(null); setGate(null); setOk(null);
    const r = await fetchJson('/api/external-shares', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceItemId: itemId, sourceItemType: itemType, sharedPath, targetUpnOrDomain: target, expiry: expiryIso }),
    });
    setBusy(false);
    if (r?.ok === false) {
      if (r.status === 503) setGate(r.error || 'External sharing is not enabled');
      else setError(r.error || 'Failed to create the external share');
      return;
    }
    setOk(`Shared with ${target}${r.share?.inviteRedeemUrl ? ' — invitation sent.' : '.'}`);
    setTarget(''); setSharedPath('');
    void load();
  }, [itemId, itemType, sharedPath, target, expiryIso, load]);

  const copyInvite = useCallback((url: string) => {
    navigator.clipboard?.writeText(url)
      .then(() => { setError(null); setOk('Invitation link copied to clipboard.'); })
      .catch(() => setError('Clipboard access was blocked — copy the link manually.'));
  }, []);

  const revoke = useCallback(async (id: string) => {
    const r = await fetchJson(`/api/external-shares/${encodeURIComponent(id)}?sourceItemId=${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    if (r?.ok) void load();
    else setError(r?.error || 'Revoke failed');
  }, [itemId, load]);

  return (
    <div className={s.pad}>
      <MessageBar intent="info" icon={<Globe20Regular />}>
        <MessageBarBody>
          <MessageBarTitle>Share to an external Entra tenant (read-only)</MessageBarTitle>
          The recipient is invited as an <strong>Entra B2B guest</strong> and granted read access to
          <strong> only the folder/table subset</strong> you choose, via a scoped ADLS ACL — no Microsoft Fabric,
          no Power BI. The share expires automatically on the date you set.
        </MessageBarBody>
      </MessageBar>

      {hasStoragePath === false && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No storage path on this item</MessageBarTitle>
            External sharing grants access to the item&apos;s ADLS data — this item has no resolved storage path,
            so there is nothing to scope a cross-tenant grant to. Share a lakehouse / dataset instead.
          </MessageBarBody>
        </MessageBar>
      )}

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>External sharing not enabled</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {ok && <MessageBar intent="success"><MessageBarBody>{ok}</MessageBarBody></MessageBar>}

      <div className={s.grid}>
        <Field
          label="External guest (UPN or tenant domain)"
          validationState={!target || validation.ok || !/valid|UPN|domain/i.test(validation.error || '') ? 'none' : 'error'}
          validationMessage={target && !validation.ok && /valid|UPN|domain/i.test(validation.error || '') ? validation.error : undefined}
        >
          <Input value={target} onChange={(_, d) => setTarget(d.value)} placeholder="user@contoso.com" />
        </Field>
        <Field label="Expires on">
          <Input type="date" value={expiry} onChange={(_, d) => setExpiry(d.value)} />
        </Field>
      </div>
      <Field
        label="Folder / table subset to share (path under the item's storage root)"
        validationState={!sharedPath || validation.ok || !/path|subset/i.test(validation.error || '') ? 'none' : 'error'}
        validationMessage={sharedPath && !validation.ok && /path|subset/i.test(validation.error || '') ? validation.error : undefined}
      >
        <Input value={sharedPath} onChange={(_, d) => setSharedPath(d.value)} placeholder="Tables/orders" />
      </Field>

      <div>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <ShareRegular />} disabled={busy || !validation.ok || hasStoragePath === false} onClick={create}>
          {busy ? 'Sharing…' : 'Share externally'}
        </Button>
        {!validation.ok && (target || sharedPath) && (
          <Caption1 style={{ marginLeft: 12, color: tokens.colorPaletteRedForeground1 }}>{validation.error}</Caption1>
        )}
      </div>

      <Divider />
      <Caption1>External shares of this item ({rows.length})</Caption1>
      {loading ? <Spinner size="tiny" label="Loading…" /> : (
        rows.length === 0 ? <Caption1>No external shares yet.</Caption1> : (
          <div className={s.tableWrap}>
            <Table size="small" aria-label="External shares">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Guest</TableHeaderCell>
                  <TableHeaderCell>Subset</TableHeaderCell>
                  <TableHeaderCell>Expires</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><Persona name={r.targetEmail} secondaryText={r.targetDomain} avatar={{ color: 'colorful' }} /></TableCell>
                    <TableCell><span className={s.mono}>{r.sharedPath}</span></TableCell>
                    <TableCell>{r.expiry ? new Date(r.expiry).toLocaleDateString() : '—'}</TableCell>
                    <TableCell><Badge appearance="tint" color={stateColor(r.state)}>{r.state}</Badge></TableCell>
                    <TableCell>
                      {r.state === 'pending' && r.inviteRedeemUrl && (
                        <Tooltip content="Copy the B2B invitation redemption link to send to the guest" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Copy16Regular />} onClick={() => copyInvite(r.inviteRedeemUrl!)}>Invite link</Button>
                        </Tooltip>
                      )}
                      {(r.state === 'pending' || r.state === 'accepted') && (
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => revoke(r.id)}>Revoke</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      )}
    </div>
  );
}

export default ExternalSharePanel;
