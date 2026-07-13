'use client';

/**
 * AccessRequestsPanel — the tenant-admin onboarding queue for sign-in-boundary
 * "Request access" submissions. Lists pending / approved / denied requests from
 * GET /api/admin/access-requests, and actions them via
 * PATCH /api/admin/access-requests/[id] (approve / deny).
 *
 * On approve, the response carries the EXACT onboarding instruction (which Entra
 * group to add the user to) — surfaced verbatim so the admin knows precisely
 * what to do next (Loom does not modify tenant group membership on their behalf).
 * On deny, a note is required. Web3.0 / Loom tokens throughout.
 */
import { useState, useEffect, useCallback } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  makeStyles, tokens, TabList, Tab, Card, CardHeader, Badge, Button, Body1, Caption1,
  Subtitle2, Spinner, MessageBar, MessageBarBody, MessageBarTitle, Field, Textarea,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Persona,
} from '@fluentui/react-components';
import {
  CheckmarkCircleRegular, DismissCircleRegular, MailRegular, BuildingRegular,
  ClockRegular, InfoRegular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { isUnauthorized } from '@/lib/components/sign-in-required';
import type { SigninAccessRequest, SigninAccessRequestStatus } from '@/lib/types/signin-access-request';

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
  },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL, marginTop: tokens.spacingVerticalS },
  metaItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  reason: {
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap',
  },
  actions: { display: 'flex', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalL, flexWrap: 'wrap' },
  onboard: { marginTop: tokens.spacingVerticalM },
  decision: { marginTop: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 },
});

const TABS: { key: SigninAccessRequestStatus; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'denied', label: 'Denied' },
];

function statusBadge(status: SigninAccessRequestStatus) {
  if (status === 'approved') return <Badge appearance="tint" color="success">Approved</Badge>;
  if (status === 'denied') return <Badge appearance="tint" color="danger">Denied</Badge>;
  return <Badge appearance="tint" color="warning">Pending</Badge>;
}

export function AccessRequestsPanel() {
  const styles = useStyles();
  const [tab, setTab] = useState<SigninAccessRequestStatus>('pending');
  const [rows, setRows] = useState<SigninAccessRequest[]>([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, denied: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [onboardById, setOnboardById] = useState<Record<string, string>>({});
  // Deny dialog state.
  const [denyTarget, setDenyTarget] = useState<SigninAccessRequest | null>(null);
  const [denyNote, setDenyNote] = useState('');

  const load = useCallback(async (status: SigninAccessRequestStatus) => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch(`/api/admin/access-requests?status=${status}`);
      if (isUnauthorized(r)) { setUnauth(true); setRows([]); return; }
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setRows([]); return; }
      setUnauth(false);
      setRows(j.requests ?? []);
      if (j.counts) setCounts(j.counts);
    } catch (e: any) {
      setError(e?.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  const decide = useCallback(async (req: SigninAccessRequest, decision: 'approved' | 'denied', note?: string) => {
    setBusyId(req.id);
    setError(null);
    try {
      const r = await clientFetch(`/api/admin/access-requests/${req.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (decision === 'approved' && j.onboarding) {
        setOnboardById((m) => ({ ...m, [req.id]: j.onboarding as string }));
      }
      // Refresh the current tab + counts.
      await load(tab);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }, [tab, load]);

  const confirmDeny = useCallback(async () => {
    if (!denyTarget || !denyNote.trim()) return;
    const target = denyTarget;
    setDenyTarget(null);
    await decide(target, 'denied', denyNote.trim());
    setDenyNote('');
  }, [denyTarget, denyNote, decide]);

  return (
    <div>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as SigninAccessRequestStatus)}
      >
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key}>
            {t.label}
            {counts[t.key] > 0 ? <>&nbsp;<Badge appearance="filled" color={t.key === 'pending' ? 'warning' : 'informative'} size="small">{counts[t.key]}</Badge></> : null}
          </Tab>
        ))}
      </TabList>

      {unauth && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Admin access required</MessageBarTitle>
            The onboarding queue is restricted to tenant admins. Set LOOM_TENANT_ADMIN_OID
            to your user OID (or add yourself to LOOM_TENANT_ADMIN_GROUP_ID) on the
            loom-console container app.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && !unauth && (
        <MessageBar intent="error" layout="multiline"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}

      {loading ? (
        <Spinner label="Loading requests…" />
      ) : !unauth && rows.length === 0 ? (
        <EmptyState
          icon={<MailRegular />}
          title={`No ${tab} requests`}
          body={
            tab === 'pending'
              ? 'When someone without access uses “Request access” at the sign-in screen, their request appears here for you to approve or deny.'
              : `There are no ${tab} access requests.`
          }
        />
      ) : (
        <div className={styles.list}>
          {rows.map((req) => (
            <Card key={req.id} className={styles.card}>
              <CardHeader
                image={<Persona name={req.displayName} size="extra-large" avatar={{ color: 'colorful' }} textAlignment="center" primaryText="" secondaryText="" />}
                header={<Subtitle2>{req.displayName}</Subtitle2>}
                description={<Caption1>{statusBadge(req.status)}</Caption1>}
              />
              <div className={styles.meta}>
                <span className={styles.metaItem}><MailRegular aria-hidden />{req.email}</span>
                {req.organization && <span className={styles.metaItem}><BuildingRegular aria-hidden />{req.organization}</span>}
                <span className={styles.metaItem}><ClockRegular aria-hidden />{new Date(req.createdAt).toLocaleString()}</span>
              </div>

              <Body1 as="p" className={styles.reason}>{req.reason}</Body1>

              {req.aadObjectId && (
                <Caption1 className={styles.metaItem} style={{ marginTop: tokens.spacingVerticalS }}>
                  <InfoRegular aria-hidden />Entra object id: {req.aadObjectId}
                </Caption1>
              )}

              {req.status === 'pending' ? (
                <div className={styles.actions}>
                  <Button
                    appearance="primary"
                    icon={busyId === req.id ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />}
                    disabled={busyId === req.id}
                    onClick={() => decide(req, 'approved')}
                  >
                    Approve &amp; onboard
                  </Button>
                  <Button
                    appearance="secondary"
                    icon={<DismissCircleRegular />}
                    disabled={busyId === req.id}
                    onClick={() => { setDenyTarget(req); setDenyNote(''); }}
                  >
                    Deny
                  </Button>
                </div>
              ) : (
                <div className={styles.decision}>
                  <Caption1>
                    {req.status === 'approved' ? 'Approved' : 'Denied'}
                    {req.reviewedBy ? ` by ${req.reviewedBy}` : ''}
                    {req.reviewedAt ? ` · ${new Date(req.reviewedAt).toLocaleString()}` : ''}
                    {req.decisionNote ? ` — “${req.decisionNote}”` : ''}
                  </Caption1>
                </div>
              )}

              {onboardById[req.id] && (
                <MessageBar intent="info" layout="multiline" className={styles.onboard}>
                  <MessageBarBody>
                    <MessageBarTitle>Next step — onboard this user</MessageBarTitle>
                    {onboardById[req.id]}
                  </MessageBarBody>
                </MessageBar>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Deny — capture a required note for the audit trail. */}
      <Dialog open={!!denyTarget} onOpenChange={(_, d) => { if (!d.open) setDenyTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Deny access request</DialogTitle>
            <DialogContent>
              <Body1 as="p" style={{ marginBottom: tokens.spacingVerticalM }}>
                Denying the request from <strong>{denyTarget?.displayName}</strong> ({denyTarget?.email}).
                A note is required and recorded in the audit log.
              </Body1>
              <Field label="Reason for denial" required>
                <Textarea
                  rows={3} value={denyNote}
                  onChange={(_, d) => setDenyNote(d.value.slice(0, 500))}
                  placeholder="e.g. Not a member of the requesting organization"
                  resize="vertical"
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" disabled={!denyNote.trim()} onClick={confirmDeny}>Deny request</Button>
              <Button appearance="secondary" onClick={() => setDenyTarget(null)}>Cancel</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
