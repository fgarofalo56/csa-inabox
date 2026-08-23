'use client';

/**
 * DeployDemoBanner — one-click, self-serve deploy of the WHOLE comprehensive
 * CSA Loom demo (the ~14 showcase apps + their `Demo —` workspaces). Answers the
 * operator ask "how can a user deploy and test it all themselves" — the
 * in-console equivalent of scripts/csa-loom/demo-seed.mjs, available to any user.
 *
 * States:
 *   - not deployed → a hero card + "Deploy demo environment" primary button.
 *   - deploying    → live progress + per-app status list (real states, see below).
 *   - finished     → the REAL counts: installed / with gates / failed / unconfirmed.
 *
 * Backend: POST /api/demo/deploy (202 {jobId}) → poll GET /api/demo/deploy/{jobId}.
 * Loom design system only (Fluent v9 + tokens); no ad-hoc px/hex.
 *
 * ── #3905: THIS SURFACE MUST NOT OVERSTATE ─────────────────────────────────
 * It used to render "{doneCount}/14 apps installed · done — open the Demo —
 * workspaces to explore" from sub-job entries the orchestrator marked `done` on
 * jobId RECEIPT, before provisioning had started. That is what told the operator
 * 14 apps were installed while the lakehouses were empty.
 *
 * Two properties now hold, and both are covered by specs:
 *   1. "N/N apps installed" renders ONLY when N installs actually reached a
 *      succeeded terminal state — the count comes from `summarizeDemoSubJobs`
 *      over the PER-APP facts, never from a server-supplied verdict field. If
 *      the job doc claimed `status:'done'` over unconfirmed sub-jobs, this
 *      surface would still refuse to claim it.
 *   2. `unknown` renders AS unknown — never folded into success, never silently
 *      dropped. Failures and unconfirmed installs get a named list, the reason,
 *      a link into the app's workspace, and the existing idempotent Redeploy.
 *
 * The client also stops trusting a demo job that has stopped advancing: installs
 * run as detached promises on a multi-replica console, so a lost worker leaves
 * the doc frozen. A frozen doc is reported as unknown, not polled forever.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Card, Button, Badge, Spinner, ProgressBar, Tooltip, Link,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Title3, Body1, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Rocket24Regular, CheckmarkCircle20Filled, ErrorCircle20Filled, Warning20Filled,
  QuestionCircle20Filled, Clock20Regular, Circle20Regular, ArrowClockwise20Regular,
  Open20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { useRouter } from 'next/navigation';
import {
  summarizeDemoSubJobs, DEMO_SUB_STATUS_LABEL,
  type DemoSubJob, type DemoSubStatus,
} from '@/lib/apps/demo-deploy-status';

interface DemoJob {
  status: 'running' | 'done' | 'partial' | 'failed';
  percentComplete: number;
  updatedAt?: string;
  subJobs?: DemoSubJob[];
}

const useStyles = makeStyles({
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 70%)`,
    border: `1px solid ${tokens.colorBrandStroke2}`, borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow8,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  icon: {
    display: 'grid', placeItems: 'center', width: '48px', height: '48px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  headText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  hint: { color: tokens.colorNeutralForeground2 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  progressWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS,
  },
  appRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXXS, minWidth: 0, flexWrap: 'wrap',
  },
  appLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  attentionRow: {
    display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap', minWidth: 0, marginTop: tokens.spacingVerticalXXS,
  },
  attentionWhy: { color: tokens.colorNeutralForeground2, minWidth: 0 },
});

/** Showcase-app count used only for the marketing copy — every rendered COUNT
 *  is derived from the job's per-app facts, never from this constant. */
const SHOWCASE_TOTAL = 14;

/** Default client poll cadence + the point at which a demo job doc that has
 *  stopped advancing is declared unknown rather than polled forever. */
const DEFAULT_POLL_MS = 4_000;
const DEFAULT_STALL_MS = 6 * 60_000;
/** Consecutive poll failures tolerated before the surface says it lost contact. */
const MAX_POLL_FAILURES = 6;

function statusIcon(s: DemoSubStatus) {
  switch (s) {
    case 'succeeded': return <CheckmarkCircle20Filled color={tokens.colorPaletteGreenForeground1} />;
    case 'partial': return <Warning20Filled color={tokens.colorPaletteYellowForeground1} />;
    case 'failed': return <ErrorCircle20Filled color={tokens.colorPaletteRedForeground1} />;
    case 'unknown': return <QuestionCircle20Filled color={tokens.colorPaletteYellowForeground1} />;
    case 'installing': return <Spinner size="extra-tiny" />;
    case 'accepted': return <Clock20Regular color={tokens.colorNeutralForeground3} />;
    default: return <Circle20Regular color={tokens.colorNeutralForeground4} />;
  }
}

/** What the user should do about a non-succeeded app. Never asserts a cause the
 *  deploy did not establish (deploy-integrity.md R7). */
function whyText(j: DemoSubJob): string {
  if (j.error) return j.error;
  if (j.detail) return j.detail;
  if (j.status === 'unknown') return 'this install was not confirmed';
  return DEMO_SUB_STATUS_LABEL[j.status];
}

export function DeployDemoBanner(props: { pollIntervalMs?: number; stallTimeoutMs?: number } = {}) {
  const pollIntervalMs = props.pollIntervalMs ?? DEFAULT_POLL_MS;
  const stallTimeoutMs = props.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const s = useStyles();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [wsCount, setWsCount] = useState(0);
  const [job, setJob] = useState<DemoJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Set when the demo job doc stopped advancing / became unreadable — the
   *  deploy's outcome is then UNKNOWN, which is what we say. */
  const [lostContact, setLostContact] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressRef = useRef<{ stamp: string; at: number } | null>(null);
  const failuresRef = useRef(0);

  const loadStatus = useCallback(() => {
    clientFetch('/api/demo/deploy')
      .then((r) => r.json())
      .then((d) => { if (d?.ok) { setWsCount(d.demoWorkspaceCount || 0); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadStatus(); return () => { if (pollRef.current) clearTimeout(pollRef.current); }; }, [loadStatus]);

  const poll = useCallback((jobId: string) => {
    const again = (ms: number) => { pollRef.current = setTimeout(() => poll(jobId), ms); };
    const lostIt = (why: string) => { setLostContact(why); setBusy(false); loadStatus(); };
    clientFetch(`/api/demo/deploy/${jobId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d?.ok || !d.job) {
          failuresRef.current += 1;
          if (failuresRef.current >= MAX_POLL_FAILURES) {
            lostIt(`the deploy status could not be read after ${failuresRef.current} attempts, so the outcome of this deploy is not known`);
          } else again(pollIntervalMs);
          return;
        }
        failuresRef.current = 0;
        const j: DemoJob = d.job;
        setJob(j);
        if (j.status !== 'running') { setBusy(false); loadStatus(); return; }
        // Still running — but a job doc that has stopped CHANGING is not
        // progress. Installs are detached promises on a multi-replica console:
        // a lost worker freezes the doc with no error written.
        const stamp = `${j.updatedAt || ''}|${j.percentComplete}|${(j.subJobs || []).map((x) => x.status).join(',')}`;
        const prev = progressRef.current;
        if (!prev || prev.stamp !== stamp) {
          progressRef.current = { stamp, at: Date.now() };
          again(pollIntervalMs);
        } else if (Date.now() - prev.at >= stallTimeoutMs) {
          lostIt(`the deploy stopped reporting progress for ${Math.round((Date.now() - prev.at) / 1000)}s — its worker may have been lost, so the outcome of the unfinished installs is not known`);
        } else {
          again(pollIntervalMs);
        }
      })
      .catch((e) => {
        failuresRef.current += 1;
        if (failuresRef.current >= MAX_POLL_FAILURES) {
          lostIt(`the deploy status could not be read (${String(e?.message || e).slice(0, 120)}), so the outcome of this deploy is not known`);
        } else again(pollIntervalMs + 1_000);
      });
  }, [loadStatus, pollIntervalMs, stallTimeoutMs]);

  const deploy = useCallback(() => {
    setBusy(true); setErr(null); setJob(null); setLostContact(null);
    progressRef.current = null; failuresRef.current = 0;
    clientFetch('/api/demo/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((d) => { if (d?.ok && d.jobId) poll(d.jobId); else { setErr(d?.error || 'Failed to start'); setBusy(false); } })
      .catch((e) => { setErr(String(e?.message || e)); setBusy(false); });
  }, [poll]);

  // EVERY count on this surface comes from the per-app facts. A server-supplied
  // verdict is never rendered as the headline (#3905).
  const roll = useMemo(() => summarizeDemoSubJobs(job?.subJobs), [job]);
  const finished = (!!job && job.status !== 'running') || !!lostContact;
  // While the deploy runs, only genuinely-terminal failures are called out.
  // Once it has finished, ANYTHING that is not `succeeded` needs attention —
  // including an app left `accepted` (dispatched, never confirmed), which is
  // exactly the state #3905 used to paint green.
  const attention = useMemo(
    () => (job?.subJobs || []).filter((j) => (finished ? j.status !== 'succeeded' : j.status === 'failed')),
    [job, finished],
  );
  const succeededAll = roll.allSucceeded && finished;
  const pct = roll.total > 0 ? roll.percentComplete / 100 : (job ? (job.percentComplete || 0) / 100 : 0);

  return (
    <Card className={s.card}>
      <div className={s.head}>
        <span className={s.icon}><Rocket24Regular /></span>
        <div className={s.headText}>
          <Title3>Deploy the full CSA Loom demo</Title3>
          <Caption1 className={s.hint}>
            One click installs {SHOWCASE_TOTAL} showcase apps — medallion lakehouse, Direct Lake, real-time / IoT,
            ML &amp; RAG, sovereign AI agents, governance, data mesh, FinOps — each into its own
            <b> Demo — </b> workspace with a real Azure-native backend and seeded data. Explore + test the whole
            art-of-the-possible yourself.
          </Caption1>
        </div>
        <div className={s.actions}>
          {loading ? <Spinner size="tiny" /> : (
            <>
              {wsCount > 0 && !busy && (
                <>
                  {/* Workspace PRESENCE only. It is not evidence that anything
                      provisioned, so it is not labelled "Deployed" (#3905). */}
                  <Tooltip
                    relationship="description"
                    content="Counts the Demo — workspaces that exist. Workspace presence is not proof that the apps provisioned — per-app install status is shown while a deploy runs."
                  >
                    <Badge appearance="tint" color="informative" data-testid="demo-workspace-badge">
                      {wsCount} Demo workspace{wsCount === 1 ? '' : 's'}
                    </Badge>
                  </Tooltip>
                  <Button appearance="primary" icon={<Open20Regular />} onClick={() => router.push('/browse')}>Open demo</Button>
                  <Button appearance="subtle" icon={<ArrowClockwise20Regular />} disabled={busy} onClick={deploy}>Redeploy</Button>
                </>
              )}
              {(wsCount === 0 || busy) && (
                <Button appearance="primary" size="large" icon={<Rocket24Regular />} disabled={busy} onClick={deploy}>
                  {busy ? 'Deploying…' : 'Deploy demo environment'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {(busy || job || lostContact) && (
        <div className={s.progressWrap}>
          {/* The bar's COLOUR carries the verdict too, so a full bar over a
              failed/unconfirmed run can't read as success at a glance. */}
          <ProgressBar
            value={pct}
            thickness="large"
            color={!finished ? 'brand' : succeededAll ? 'success' : roll.failed > 0 ? 'error' : 'warning'}
          />
          <Caption1 className={s.hint} data-testid="demo-deploy-headline">
            {roll.total > 0 ? roll.headline : 'Starting the deploy…'}
            {succeededAll && ' · open the Demo — workspaces to explore'}
          </Caption1>

          {lostContact && (
            <MessageBar intent="warning" data-testid="demo-deploy-lost-contact">
              <MessageBarTitle>Deploy status unknown</MessageBarTitle>
              <MessageBarBody>
                {lostContact}. The installs listed below as unconfirmed may still be running, may have
                completed, or may have been lost — this surface will not guess. Open each Demo — workspace
                to see what actually exists, or redeploy (it is idempotent and reuses the same workspaces).
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" icon={<ArrowClockwise20Regular />} disabled={busy} onClick={deploy}>Redeploy</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {attention.length > 0 && (
            <MessageBar
              intent={roll.failed > 0 ? 'error' : 'warning'}
              data-testid="demo-deploy-attention"
            >
              <MessageBarTitle>
                {finished
                  ? `${attention.length} app${attention.length === 1 ? '' : 's'} did not finish as installed`
                  : `${attention.length} app${attention.length === 1 ? '' : 's'} failed so far`}
              </MessageBarTitle>
              <MessageBarBody>
                {attention.map((j) => (
                  <div key={j.appId} className={s.attentionRow}>
                    {statusIcon(j.status)}
                    <Body1>{j.wsLabel.replace(/^Demo — /, '')}</Body1>
                    <Badge appearance="outline" color={j.status === 'failed' ? 'danger' : 'warning'}>
                      {DEMO_SUB_STATUS_LABEL[j.status]}
                    </Badge>
                    <Caption1 className={s.attentionWhy}>— {whyText(j)}</Caption1>
                    {j.workspaceId && (
                      <Link href={`/workspaces/${encodeURIComponent(j.workspaceId)}`}>Open workspace</Link>
                    )}
                  </div>
                ))}
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" icon={<ArrowClockwise20Regular />} disabled={busy} onClick={deploy}>
                  Redeploy
                </Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {job?.subJobs && job.subJobs.length > 0 && (
            <div className={s.grid} data-testid="demo-deploy-app-grid">
              {job.subJobs.map((j) => (
                <div key={j.appId} className={s.appRow} data-testid={`demo-app-${j.appId}`}>
                  {statusIcon(j.status)}
                  <Body1 className={s.appLabel}>{j.wsLabel.replace(/^Demo — /, '')}</Body1>
                  <Caption1 className={s.hint}>{DEMO_SUB_STATUS_LABEL[j.status]}</Caption1>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {err && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Caption1>}
    </Card>
  );
}
