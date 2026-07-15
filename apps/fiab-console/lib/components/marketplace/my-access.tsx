'use client';

import { clientFetch } from '@/lib/client-fetch';
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
  Subtitle2, Caption1, Badge, Button, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync20Regular, Connector20Regular, Database20Regular, Connector24Regular, Database24Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { LOOM_ACCENT } from '@/lib/components/shared/accent-tokens';

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  // Each access category sits in its own elevated card, matching the Marketplace
  // surface it lives beside (web3-ui.md — reads as the same product).
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  cardHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { marginLeft: 'auto' },
  iconChip: {
    flexShrink: 0, width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
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
      const r = await clientFetch('/api/marketplace/subscriptions');
      const j = await r.json();
      if (r.status === 503 && j?.gated) { setSubNote(j.hint || j.error || 'API Management not configured.'); setSubs([]); }
      else setSubs(j.ok ? (j.subscriptions || []) : []);
    } catch { setSubs([]); }
    try {
      const r = await clientFetch('/api/data-products/my-access-requests');
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
        <Button appearance="subtle" className={s.spacer} icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
      </div>

      <TeachingBanner
        surfaceKey="marketplace-my-access"
        title="Everything you can use"
        message="One place for every API you've subscribed to and every data product you've requested — with live state. Accepted Delta shares mount as read-only catalogs; find them in the Data shares tab."
        icon={Connector20Regular}
        accent={LOOM_ACCENT.teal}
      />

      {/* API subscriptions */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <span className={s.iconChip} style={{ background: LOOM_ACCENT.blue }} aria-hidden="true"><Connector20Regular /></span>
          <Subtitle2>API subscriptions</Subtitle2>
          {subs && subs.length > 0 && <Badge appearance="tint" color="informative">{subs.length}</Badge>}
        </div>
        {subNote && <MessageBar intent="warning"><MessageBarBody>{subNote}</MessageBarBody></MessageBar>}
        {subs === null && <Spinner size="tiny" label="Loading subscriptions…" labelPosition="after" />}
        {subs && subs.length === 0 && !subNote && (
          <EmptyState
            icon={<Connector24Regular />}
            title="No API subscriptions yet"
            body="Subscribe to an API from the APIs tab to see your keys, scope, and subscription state here."
          />
        )}
        {subs && subs.length > 0 && (
          <Table size="small" aria-label="API subscriptions">
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
      </section>

      {/* Data-product access requests */}
      <section className={s.card}>
        <div className={s.cardHead}>
          <span className={s.iconChip} style={{ background: LOOM_ACCENT.violet }} aria-hidden="true"><Database20Regular /></span>
          <Subtitle2>Data-product access requests</Subtitle2>
          {reqs && reqs.length > 0 && <Badge appearance="tint" color="informative">{reqs.length}</Badge>}
        </div>
        <Caption1 className={s.hint}>
          Owners grant access in Governance → Policies (real Azure RBAC). Accepted Delta shares appear as mounted catalogs in the Data shares tab.
        </Caption1>
        {reqErr && <MessageBar intent="error"><MessageBarBody>{reqErr}</MessageBarBody></MessageBar>}
        {reqs === null && <Spinner size="tiny" label="Loading requests…" labelPosition="after" />}
        {reqs && reqs.length === 0 && !reqErr && (
          <EmptyState
            icon={<Database24Regular />}
            title="No access requests yet"
            body="Request access to a data product from Discover; your requests and their approval status appear here."
          />
        )}
        {reqs && reqs.length > 0 && (
          <Table size="small" aria-label="Data-product access requests">
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
                  <TableCell>
                    {/* DP-10 — a completed request is zero-touch PROVISIONED. */}
                    {r.status === 'completed'
                      ? <Badge appearance="tint" color="success">Provisioned</Badge>
                      : <Badge appearance="tint" color={r.status === 'approved' ? 'brand' : r.status === 'rejected' ? 'danger' : 'warning'}>{r.status}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
