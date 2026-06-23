'use client';

/**
 * AccessRequestInboxEditor — the F16 multi-tier approval inbox.
 *
 * A data-asset access request flows through four approval tiers, in order:
 *   Manager → Privacy reviewer → Approver → Access provider
 *
 * The tab strip is the tier selector. Each tab fetches
 * GET /api/access-requests?tier=<tier>&status=open and renders only the
 * requests awaiting THAT tier's action ("approver inbox filtered to the
 * signed-in approver's current tier"). Approve / Deny POST to
 * /api/access-requests/[id]/decision, which advances the workflow in Cosmos.
 *
 * The final (Access provider) approval provisions a REAL Azure RBAC grant on
 * the backing store (Storage RBAC / Synapse SQL / ADX) and marks the requester
 * a subscriber; the resulting ARM role-assignment id is shown on the row. A
 * Completed / Denied history tab surfaces closed requests with their receipt
 * (role assignment id, or denial reason). No Microsoft Fabric dependency.
 *
 * Design: Fluent v9 + Loom tokens — spaced Section cards, accent status badges,
 * keyboard-navigable controls. Honest infra/config gates surface as a Fluent
 * MessageBar naming the exact env var / role to provision (no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';
import {
  makeStyles, tokens, Spinner, Badge, Button, Text, Caption1, Body1Strong,
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Textarea, Input, Dropdown, Option, Field,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Regular, DismissCircle20Regular, ChevronDown20Regular,
  ChevronRight20Regular, ShieldKeyhole20Regular, History20Regular,
} from '@fluentui/react-icons';
import {
  TIER_SEQUENCE, TIER_LABEL,
  type ApprovalTier, type ApprovalStatus, type AccessRequestEnforcement,
} from '@/lib/types/access-request-workflow';

// ── Local mirror of the server doc (only the fields the UI reads). ────────────
interface ApprovalStep {
  decision: 'approved' | 'denied';
  by: string;
  at: string;
  reason?: string;
}
interface AccessRequest {
  id: string;
  assetId: string;
  assetName: string;
  itemType: string;
  scopeType: string;
  scopeRef: string;
  permission: 'read' | 'write' | 'admin';
  justification: string;
  requesterUpn: string;
  requestedAt: string;
  tier: ApprovalTier;
  status: ApprovalStatus;
  managerApproval?: ApprovalStep;
  privacyApproval?: ApprovalStep;
  approverApproval?: ApprovalStep;
  accessProviderApproval?: ApprovalStep;
  enforcement?: AccessRequestEnforcement;
  subscribedAt?: string;
  deniedAt?: string;
  denialReason?: string;
  deniedAtTier?: ApprovalTier;
}

const SCOPE_TYPES = ['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection'];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tabs: { marginBottom: tokens.spacingVerticalS },
  tabCount: { marginLeft: tokens.spacingHorizontalXS },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL,
    boxShadow: tokens.shadow2,
    minWidth: 0,
  },
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3, textAlign: 'center',
  },
  nameCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end' },
  expandBtn: { minWidth: 'auto' },
  detail: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  detailRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  kv: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '160px' },
  kvLabel: { textTransform: 'uppercase', letterSpacing: '0.04em', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-all',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  dialogFields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
  err: { marginBottom: tokens.spacingVerticalM },
});

const STATUS_BADGE: Record<ApprovalStatus, { color: 'informative' | 'success' | 'danger'; label: string }> = {
  open: { color: 'informative', label: 'Open' },
  completed: { color: 'success', label: 'Completed' },
  denied: { color: 'danger', label: 'Denied' },
};

function fmt(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function stepFor(r: AccessRequest, tier: ApprovalTier): ApprovalStep | undefined {
  return tier === 'manager' ? r.managerApproval
    : tier === 'privacy' ? r.privacyApproval
      : tier === 'approver' ? r.approverApproval
        : r.accessProviderApproval;
}

type ViewKey = ApprovalTier | 'history';

export function AccessRequestInboxEditor() {
  const s = useStyles();
  const [view, setView] = useState<ViewKey>('manager');
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});

  // Decision dialog state.
  const [dlg, setDlg] = useState<{ req: AccessRequest; decision: 'approved' | 'denied' } | null>(null);
  const [reason, setReason] = useState('');
  const [scopeType, setScopeType] = useState('adls-container');
  const [scopeRef, setScopeRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState<string | null>(null);

  const load = useCallback(async (v: ViewKey) => {
    setLoading(true); setError(null);
    try {
      const isHistory = v === 'history';
      const url = isHistory
        ? '/api/access-requests?status=completed'
        : `/api/access-requests?tier=${v}&status=open`;
      const r = await fetch(url);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setRequests([]); return; }
      let rows: AccessRequest[] = j.requests || [];
      if (isHistory) {
        // Merge denied requests into the history view too.
        try {
          const rd = await fetch('/api/access-requests?status=denied');
          const jd = await rd.json();
          if (jd.ok) rows = [...rows, ...(jd.requests || [])];
        } catch { /* completed-only is acceptable */ }
        rows.sort((a, b) => (b.subscribedAt || b.deniedAt || b.requestedAt).localeCompare(a.subscribedAt || a.deniedAt || a.requestedAt));
      }
      setRequests(rows);
    } catch (e: any) {
      setError(e?.message || String(e)); setRequests([]);
    } finally { setLoading(false); }
  }, []);

  // Refresh per-tier open counts for the tab badges.
  const loadCounts = useCallback(async () => {
    const next: Record<string, number> = {};
    await Promise.all(TIER_SEQUENCE.map(async (t) => {
      try {
        const r = await fetch(`/api/access-requests?tier=${t}&status=open`);
        const j = await r.json();
        next[t] = j.ok ? (j.requests || []).length : 0;
      } catch { next[t] = 0; }
    }));
    setCounts(next);
  }, []);

  useEffect(() => { load(view); }, [view, load]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  const onTab = (_e: SelectTabEvent, d: SelectTabData) => setView(d.value as ViewKey);

  const toggle = (id: string) => setExpanded((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const openDialog = (req: AccessRequest, decision: 'approved' | 'denied') => {
    setDlg({ req, decision });
    setReason('');
    setScopeType(req.scopeType || 'adls-container');
    setScopeRef(req.scopeRef || '');
    setDlgError(null);
  };

  const isFinalTier = dlg?.req.tier === 'access-provider';

  const submit = useCallback(async () => {
    if (!dlg) return;
    setBusy(true); setDlgError(null);
    try {
      const payload: Record<string, unknown> = { decision: dlg.decision };
      if (reason.trim()) payload.reason = reason.trim();
      if (dlg.decision === 'approved' && isFinalTier) {
        payload.scopeType = scopeType;
        if (scopeRef.trim()) payload.scopeRef = scopeRef.trim();
      }
      const r = await fetch(`/api/access-requests/${dlg.req.id}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) {
        // Honest gate / grant error — keep the dialog open with the precise reason.
        setDlgError(j.warning || j.error || `HTTP ${r.status}`);
        return;
      }
      if (j.warning) {
        // pending infra/config gate — surfaced but request stays at this tier.
        setDlgError(j.warning);
        await Promise.all([load(view), loadCounts()]);
        return;
      }
      setDlg(null);
      await Promise.all([load(view), loadCounts()]);
    } catch (e: any) {
      setDlgError(e?.message || String(e));
    } finally { setBusy(false); }
  }, [dlg, reason, isFinalTier, scopeType, scopeRef, load, view, loadCounts]);

  const tabs = useMemo(() => TIER_SEQUENCE.map((t) => ({ value: t as ViewKey, label: TIER_LABEL[t] })), []);

  return (
    <div className={s.root}>
      <TabList className={s.tabs} selectedValue={view} onTabSelect={onTab}>
        {tabs.map((t) => (
          <Tab key={t.value} value={t.value} icon={<ShieldKeyhole20Regular />}>
            {t.label}
            {counts[t.value] > 0 && (
              <Badge className={s.tabCount} appearance="filled" color="brand" size="small">{counts[t.value]}</Badge>
            )}
          </Tab>
        ))}
        <Tab value="history" icon={<History20Regular />}>History</Tab>
      </TabList>

      <div className={s.card}>
        <Caption1 className={s.intro}>
          {view === 'history'
            ? 'Closed requests — completed (with the real Azure role assignment provisioned) and denied (with the reason).'
            : `Requests awaiting ${TIER_LABEL[view as ApprovalTier]} action. Approving advances the request to the next tier; the final Access provider approval provisions a real Azure RBAC grant on the backing store and subscribes the requester.`}
        </Caption1>

        {error && (
          <MessageBar intent="error" className={s.err}>
            <MessageBarBody><MessageBarTitle>Couldn’t load requests</MessageBarTitle>{error}</MessageBarBody>
          </MessageBar>
        )}

        {loading && <Spinner label="Loading requests…" style={{ justifyContent: 'flex-start' }} />}

        {!loading && requests.length === 0 && !error && (
          <div className={s.empty}>
            <ShieldKeyhole20Regular style={{ width: 28, height: 28 }} />
            <Text>
              {view === 'history'
                ? 'No closed requests yet.'
                : `No requests awaiting ${TIER_LABEL[view as ApprovalTier]} action.`}
            </Text>
          </div>
        )}

        {!loading && requests.length > 0 && (
          <Table aria-label="Access requests" size="medium">
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: 36 }} />
                <TableHeaderCell>Asset</TableHeaderCell>
                <TableHeaderCell>Requester</TableHeaderCell>
                <TableHeaderCell>Permission</TableHeaderCell>
                <TableHeaderCell>Requested</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell style={{ textAlign: 'right' }}>Decision</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => {
                const open = expanded.has(r.id);
                const sb = STATUS_BADGE[r.status];
                return (
                  <Fragment key={r.id}>
                    <TableRow>
                      <TableCell>
                        <Button
                          className={s.expandBtn}
                          appearance="transparent"
                          size="small"
                          aria-label={open ? 'Collapse details' : 'Expand details'}
                          icon={open ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
                          onClick={() => toggle(r.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <span className={s.nameCell}>
                          <Body1Strong>{r.assetName}</Body1Strong>
                          <Caption1>{r.itemType || r.scopeType}</Caption1>
                        </span>
                      </TableCell>
                      <TableCell>{r.requesterUpn}</TableCell>
                      <TableCell><Badge appearance="tint" color="brand">{r.permission}</Badge></TableCell>
                      <TableCell>{fmt(r.requestedAt)}</TableCell>
                      <TableCell><Badge appearance="tint" color={sb.color}>{sb.label}</Badge></TableCell>
                      <TableCell>
                        {r.status === 'open' ? (
                          <span className={s.rowActions}>
                            <Tooltip content="Approve — advance to the next tier" relationship="label">
                              <Button
                                size="small" appearance="primary"
                                icon={<CheckmarkCircle20Regular />}
                                onClick={() => openDialog(r, 'approved')}
                              >
                                {r.tier === 'access-provider' ? 'Approve & grant' : 'Approve'}
                              </Button>
                            </Tooltip>
                            <Tooltip content="Deny — close with a reason" relationship="label">
                              <Button
                                size="small" appearance="outline"
                                icon={<DismissCircle20Regular />}
                                onClick={() => openDialog(r, 'denied')}
                              >
                                Deny
                              </Button>
                            </Tooltip>
                          </span>
                        ) : (
                          <Caption1>{r.status === 'completed' ? `Granted ${fmt(r.subscribedAt)}` : `Denied ${fmt(r.deniedAt)}`}</Caption1>
                        )}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow key={`${r.id}-detail`}>                        <TableCell />
                        <TableCell colSpan={6}>
                          <div className={s.detail}>
                            <div className={s.detailRow}>
                              <span className={s.kv}>
                                <Caption1 className={s.kvLabel}>Justification</Caption1>
                                <Text>{r.justification || '—'}</Text>
                              </span>
                              <span className={s.kv}>
                                <Caption1 className={s.kvLabel}>Grant scope</Caption1>
                                <Text>{r.scopeType}{r.scopeRef ? ` · ${r.scopeRef}` : ''}</Text>
                              </span>
                              <span className={s.kv}>
                                <Caption1 className={s.kvLabel}>Current tier</Caption1>
                                <Text>{r.status === 'open' ? TIER_LABEL[r.tier] : STATUS_BADGE[r.status].label}</Text>
                              </span>
                            </div>

                            <div className={s.steps}>
                              <Caption1 className={s.kvLabel}>Approval trail</Caption1>
                              {TIER_SEQUENCE.map((t) => {
                                const step = stepFor(r, t);
                                return (
                                  <Caption1 key={t}>
                                    <strong>{TIER_LABEL[t]}:</strong>{' '}
                                    {step
                                      ? `${step.decision} by ${step.by} on ${fmt(step.at)}${step.reason ? ` — “${step.reason}”` : ''}`
                                      : (r.status === 'open' && r.tier === t ? 'awaiting decision' : '—')}
                                  </Caption1>
                                );
                              })}
                            </div>

                            {r.enforcement && (
                              <span className={s.kv}>
                                <Caption1 className={s.kvLabel}>RBAC enforcement</Caption1>
                                {r.enforcement.status === 'active' ? (
                                  <>
                                    <Text>{r.enforcement.roleName} — active</Text>
                                    {r.enforcement.roleAssignmentId && (
                                      <span className={s.mono}>{r.enforcement.roleAssignmentId}</span>
                                    )}
                                  </>
                                ) : (
                                  <MessageBar intent={r.enforcement.status === 'error' ? 'error' : 'warning'}>
                                    <MessageBarBody>{r.enforcement.detail || r.enforcement.status}</MessageBarBody>
                                  </MessageBar>
                                )}
                              </span>
                            )}

                            {r.status === 'denied' && (
                              <span className={s.kv}>
                                <Caption1 className={s.kvLabel}>Denial reason</Caption1>
                                <Text>{r.denialReason || '—'}{r.deniedAtTier ? ` (at ${TIER_LABEL[r.deniedAtTier]} tier)` : ''}</Text>
                              </span>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Decision dialog */}
      <Dialog open={!!dlg} onOpenChange={(_, d) => { if (!d.open) setDlg(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {dlg?.decision === 'approved'
                ? (isFinalTier ? 'Approve & provision access' : `Approve at ${dlg ? TIER_LABEL[dlg.req.tier] : ''} tier`)
                : 'Deny request'}
            </DialogTitle>
            <DialogContent>
              <div className={s.dialogFields}>
                {dlg && (
                  <Caption1>
                    {dlg.req.permission} access to <strong>{dlg.req.assetName}</strong> for {dlg.req.requesterUpn}.
                  </Caption1>
                )}

                {dlgError && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Action needs attention</MessageBarTitle>
                      {dlgError}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {dlg?.decision === 'approved' && isFinalTier && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        Final approval provisions a <strong>real Azure RBAC role assignment</strong> on the
                        backing store and subscribes the requester. Confirm the scope below.
                      </MessageBarBody>
                    </MessageBar>
                    <Field label="Scope type">
                      <Dropdown
                        value={scopeType}
                        selectedOptions={[scopeType]}
                        onOptionSelect={(_, d) => d.optionValue && setScopeType(d.optionValue)}
                      >
                        {SCOPE_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field
                      label="Backing container / database"
                      hint="ADLS container name, Synapse pool/db, or ADX database the grant binds to."
                    >
                      <Input value={scopeRef} onChange={(_, d) => setScopeRef(d.value)} placeholder="e.g. gold" />
                    </Field>
                  </>
                )}

                <Field
                  label={dlg?.decision === 'denied' ? 'Reason (required)' : 'Note (optional)'}
                  required={dlg?.decision === 'denied'}
                >
                  <Textarea
                    value={reason}
                    onChange={(_, d) => setReason(d.value)}
                    placeholder={dlg?.decision === 'denied' ? 'Why is this request denied?' : 'Optional context for the audit trail'}
                    rows={3}
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDlg(null)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={submit}
                disabled={busy || (dlg?.decision === 'denied' && !reason.trim())}
                icon={busy ? <Spinner size="tiny" /> : undefined}
              >
                {dlg?.decision === 'approved' ? (isFinalTier ? 'Approve & grant' : 'Approve') : 'Deny'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
