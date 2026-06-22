'use client';

/**
 * MyAccess — unified "what do I have / what did I request" view across the
 * marketplace product kinds. All real backends:
 *
 *   API subscriptions      GET /api/marketplace/subscriptions          (APIM)
 *   Data-product requests  GET /api/data-products/my-access-requests   (audit log)
 *
 * Accepted Delta shares surface as mounted Unity Catalog catalogs (see the Data
 * shares tab) — noted here so users know where to find them.
 */

import { useEffect, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Connector20Regular, Database20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  empty: {
    paddingTop: tokens.spacingVerticalXL, paddingBottom: tokens.spacingVerticalXL,
    textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
  },
});

interface Sub { id?: string; name?: string; displayName?: string; productName?: string; state?: string }
interface Req { id: string; productId: string; summary: string; requestedAt: string; permission: string; status: string }

export function MyAccess() {
  const s = useStyles();
  const [subs, setSubs] = useState<Sub[] | null>(null);
  const [subNote, setSubNote] = useState<string | null>(null);
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [reqErr, setReqErr] = useState<string | null>(null);

  const load = async () => {
    setSubNote(null); setReqErr(null);
    try {
      const r = await fetch('/api/marketplace/subscriptions');
      const j = await r.json();
      if (r.status === 503 && j?.gated) { setSubNote(j.hint || j.error || 'API Management not configured.'); setSubs([]); }
      else setSubs(j.ok ? (j.subscriptions || []) : []);
    } catch { setSubs([]); }
    try {
      const r = await fetch('/api/data-products/my-access-requests');
      const j = await r.json();
      if (!j.ok) { setReqErr(j.error || `HTTP ${r.status}`); setReqs([]); }
      else setReqs(j.requests || []);
    } catch (e: any) { setReqErr(e?.message || String(e)); setReqs([]); }
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className={s.pad}>
      <div className={s.row}>
        <Subtitle2>My access</Subtitle2>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
      </div>

      {/* API subscriptions */}
      <div className={s.row}><Connector20Regular /><Subtitle2>API subscriptions</Subtitle2></div>
      {subNote && <MessageBar intent="warning"><MessageBarBody>{subNote}</MessageBarBody></MessageBar>}
      {subs === null && <Spinner size="tiny" />}
      {subs && subs.length === 0 && !subNote && <div className={s.empty}>No API subscriptions yet — subscribe from the APIs tab.</div>}
      {subs && subs.length > 0 && (
        <Table>
          <TableHeader><TableRow>
            <TableHeaderCell>Subscription</TableHeaderCell>
            <TableHeaderCell>Scope</TableHeaderCell>
            <TableHeaderCell>State</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {subs.map((sub) => (
              <TableRow key={sub.id || sub.name}>
                <TableCell>{sub.displayName || sub.name}</TableCell>
                <TableCell>{sub.productName || '—'}</TableCell>
                <TableCell>
                  <Badge appearance="tint" color={sub.state === 'active' ? 'success' : 'warning'}>{sub.state || 'unknown'}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Divider />

      {/* Data-product access requests */}
      <div className={s.row}><Database20Regular /><Subtitle2>Data-product access requests</Subtitle2></div>
      <Caption1 className={s.hint}>
        Owners grant access in Governance → Policies (real Azure RBAC). Accepted Delta shares appear as mounted catalogs in the Data shares tab.
      </Caption1>
      {reqErr && <MessageBar intent="error"><MessageBarBody>{reqErr}</MessageBarBody></MessageBar>}
      {reqs === null && <Spinner size="tiny" />}
      {reqs && reqs.length === 0 && !reqErr && <div className={s.empty}>No data-product access requests recorded.</div>}
      {reqs && reqs.length > 0 && (
        <Table>
          <TableHeader><TableRow>
            <TableHeaderCell>Product</TableHeaderCell>
            <TableHeaderCell>Requested</TableHeaderCell>
            <TableHeaderCell>Permission</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {reqs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.summary || r.productId}</TableCell>
                <TableCell>{new Date(r.requestedAt).toLocaleString()}</TableCell>
                <TableCell><Badge appearance="outline">{r.permission}</Badge></TableCell>
                <TableCell><Badge appearance="tint" color="warning">{r.status}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
