'use client';

/**
 * AccessReviewEvidenceDialog (loom-apex B-N19c') — the signed-evidence surface
 * for a review campaign.
 *
 * Reads the campaign's hash-chained evidence records from
 * `/api/access-governance/reviews/[id]/evidence`, shows the chain-integrity
 * verdict (VERIFIED / tampered, with the exact issue per record), the record
 * hashes, and the readable auditor summary — and downloads the pack as JSON
 * (machine-verifiable) or TXT (readable). A campaign that has not closed yet has
 * no evidence: that's an honest, guided empty state, not an error.
 *
 * Fluent v9 + Loom tokens only; badges wrap; the summary pane is scroll-bounded.
 */
import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  makeStyles, tokens, Badge, Button, Caption1, Subtitle2, Text, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Switch, Tooltip,
} from '@fluentui/react-components';
import {
  ShieldCheckmark24Regular, ArrowDownload20Regular, DocumentText20Regular,
  Code20Regular, ShieldError24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

export interface EvidenceChainIssueView {
  sequence: number;
  recordId: string;
  kind: string;
  detail: string;
}
export interface EvidenceVerificationView {
  ok: boolean;
  records: number;
  issues: EvidenceChainIssueView[];
  brokenAt?: number;
  headHash?: string;
}
export interface EvidenceRecordView {
  id: string;
  sequence: number;
  prevHash: string;
  contentHash: string;
  recordedAt: string;
  recordedBy: string;
  totals: { total: number; attested: number; revoked: number; pending: number; autoRevoked: number; backendRevoked: number };
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  spacer: { flex: 1 },
  hash: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
  record: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  records: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  summary: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: '320px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    minWidth: 0,
  },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function AccessReviewEvidenceDialog({
  campaignId, campaignName, onClose,
}: { campaignId: string; campaignName: string; onClose: () => void }) {
  const s = useStyles();
  const [tenantScope, setTenantScope] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [records, setRecords] = useState<EvidenceRecordView[]>([]);
  const [verification, setVerification] = useState<EvidenceVerificationView | null>(null);
  const [summary, setSummary] = useState('');

  const base = `/api/access-governance/reviews/${encodeURIComponent(campaignId)}/evidence`;
  const qs = tenantScope ? '?scope=tenant' : '';

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await clientFetch(`${base}${qs}`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setRecords([]); setVerification(null); setSummary(''); return; }
      setRecords(j.records || []);
      setVerification(j.verification || null);
      setSummary(j.summary || '');
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, qs]);
  useEffect(() => { void load(); }, [load]);

  const download = useCallback((fmt: 'json' | 'txt') => {
    const sep = qs ? '&' : '?';
    window.open(`${base}${qs}${sep}download=${fmt}`, '_blank', 'noopener');
  }, [base, qs]);

  const verified = !!verification?.ok && records.length > 0;

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: '880px', width: '90vw' }}>
        <DialogBody>
          <DialogTitle>Evidence pack — {campaignName}</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.row}>
                <Caption1 className={s.muted}>
                  Each closed campaign is sealed into an append-only record — campaign metadata, every
                  decision, the resulting revocations — hashed with SHA-256 and chained to the previous
                  record for this tenant, so any later edit breaks the chain.
                </Caption1>
                <LearnPopover
                  title="How the tamper evidence works"
                  content="The record's contentHash is SHA-256 over a canonical JSON encoding of its own body — and that body embeds prevHash, the previous record's hash for this tenant. Editing any historical decision changes the recomputed hash of that record AND orphans every record after it, so a single-row edit cannot be hidden. Re-sealing the edited record only moves the break to the next link."
                  tips={[
                    'Records live in the append-only Cosmos container access-review-evidence (PK /tenantId)',
                    'Every seal also fans out to the SIEM audit stream and any subscribed webhook',
                    'Turn on "Verify the whole tenant chain" to prove continuity across all campaigns',
                  ]}
                  learnMoreHref="https://learn.microsoft.com/entra/id-governance/access-reviews-overview"
                />
              </div>

              <div className={s.row}>
                <Switch
                  checked={tenantScope}
                  onChange={(_, d) => setTenantScope(!!d.checked)}
                  label="Verify the whole tenant chain (not just this campaign)"
                />
                <div className={s.spacer} />
                <Tooltip content="Machine-verifiable pack: every record with its prevHash and contentHash" relationship="label">
                  <Button appearance="primary" size="small" icon={<Code20Regular />} disabled={loading || records.length === 0} onClick={() => download('json')}>
                    Download JSON
                  </Button>
                </Tooltip>
                <Tooltip content="Readable auditor summary" relationship="label">
                  <Button appearance="secondary" size="small" icon={<DocumentText20Regular />} disabled={loading || records.length === 0} onClick={() => download('txt')}>
                    Download summary
                  </Button>
                </Tooltip>
              </div>

              {loading && <Spinner size="tiny" label="Reading the evidence chain…" labelPosition="after" />}
              {err && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Evidence</MessageBarTitle>{err}</MessageBarBody>
                </MessageBar>
              )}

              {!loading && !err && records.length === 0 && (
                <EmptyState
                  icon={<ShieldCheckmark24Regular />}
                  title="No evidence sealed yet"
                  body="An evidence record is sealed when the campaign closes. Close this campaign (or let the review sweep close it at its deadline) and the signed record — decisions, revocations, and a chained content hash — appears here."
                />
              )}

              {!loading && !err && records.length > 0 && verification && (
                <>
                  <MessageBar intent={verified ? 'success' : 'error'} layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>
                        {verified ? 'Chain integrity verified' : 'Chain integrity FAILED — evidence has been altered'}
                      </MessageBarTitle>
                      {verified
                        ? `${verification.records} record(s) re-hashed to their sealed values and each links to its predecessor.`
                        : `Verification failed at record #${verification.brokenAt}. ${verification.issues.map((i) => `seq ${i.sequence} (${i.kind}): ${i.detail}`).join(' · ')}`}
                    </MessageBarBody>
                  </MessageBar>

                  <div className={s.records}>
                    <Subtitle2>Records</Subtitle2>
                    {records.map((r) => {
                      const bad = verification.issues.some((i) => i.recordId === r.id);
                      return (
                        <div key={r.id} className={s.record}>
                          <div className={s.row}>
                            {bad ? <ShieldError24Regular /> : <ShieldCheckmark24Regular />}
                            <Text weight="semibold">Record #{r.sequence}</Text>
                            <div className={s.badges}>
                              <Badge appearance="tint" size="small">{r.totals.total} decision(s)</Badge>
                              <Badge appearance="tint" color="success" size="small">{r.totals.attested} attested</Badge>
                              <Badge appearance="tint" color="danger" size="small">{r.totals.revoked} revoked</Badge>
                              {r.totals.autoRevoked > 0 && <Badge appearance="tint" color="warning" size="small">{r.totals.autoRevoked} auto</Badge>}
                              <Badge appearance="tint" color={bad ? 'danger' : 'brand'} size="small">{bad ? 'tampered' : 'sealed'}</Badge>
                            </div>
                          </div>
                          <Caption1 className={s.muted}>Sealed {new Date(r.recordedAt).toLocaleString()} by {r.recordedBy}</Caption1>
                          <Caption1 className={s.hash}>prev {r.prevHash}</Caption1>
                          <Caption1 className={s.hash}>hash {r.contentHash}</Caption1>
                        </div>
                      );
                    })}
                  </div>

                  <Subtitle2>Readable summary</Subtitle2>
                  <div className={s.summary}>{summary}</div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" icon={<ArrowDownload20Regular />} disabled={loading || records.length === 0} onClick={() => download('json')}>
              Download evidence pack
            </Button>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
