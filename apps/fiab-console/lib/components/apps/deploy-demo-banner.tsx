'use client';

/**
 * DeployDemoBanner — one-click, self-serve deploy of the WHOLE comprehensive
 * CSA Loom demo (the ~14 showcase apps + their `Demo —` workspaces). Answers the
 * operator ask "how can a user deploy and test it all themselves" — the
 * in-console equivalent of scripts/csa-loom/demo-seed.mjs, available to any user.
 *
 * States:
 *   - not deployed → a hero card + "Deploy demo environment" primary button.
 *   - deploying    → live progress (N/14) + per-app status list.
 *   - deployed     → "Demo deployed" + Open workspaces + idempotent Redeploy.
 *
 * Backend: POST /api/demo/deploy (202 {jobId}) → poll GET /api/demo/deploy/{jobId}.
 * Loom design system only (Fluent v9 + tokens); no ad-hoc px/hex.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Card, Button, Badge, Spinner, ProgressBar,
  Title3, Body1, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Rocket24Regular, CheckmarkCircle20Filled, ErrorCircle20Filled,
  Circle20Regular, ArrowClockwise20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { useRouter } from 'next/navigation';

interface SubJob {
  appId: string; wsLabel: string; workspaceId?: string; installJobId?: string;
  status: 'pending' | 'installing' | 'done' | 'error'; error?: string;
}
interface DemoJob {
  status: 'running' | 'done' | 'partial' | 'failed';
  percentComplete: number; subJobs?: SubJob[];
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
    padding: tokens.spacingVerticalXXS, minWidth: 0,
  },
  appLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
});

const TOTAL = 14;

export function DeployDemoBanner() {
  const s = useStyles();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [deployed, setDeployed] = useState(false);
  const [wsCount, setWsCount] = useState(0);
  const [job, setJob] = useState<DemoJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStatus = useCallback(() => {
    clientFetch('/api/demo/deploy')
      .then((r) => r.json())
      .then((d) => { if (d?.ok) { setDeployed(!!d.deployed); setWsCount(d.demoWorkspaceCount || 0); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { loadStatus(); return () => { if (pollRef.current) clearTimeout(pollRef.current); }; }, [loadStatus]);

  const poll = useCallback((jobId: string) => {
    clientFetch(`/api/demo/deploy/${jobId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && d.job) {
          setJob(d.job);
          if (d.job.status === 'running') { pollRef.current = setTimeout(() => poll(jobId), 4000); }
          else { setBusy(false); loadStatus(); }
        } else { pollRef.current = setTimeout(() => poll(jobId), 4000); }
      })
      .catch(() => { pollRef.current = setTimeout(() => poll(jobId), 5000); });
  }, [loadStatus]);

  const deploy = useCallback(() => {
    setBusy(true); setErr(null); setJob(null);
    clientFetch('/api/demo/deploy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((d) => { if (d?.ok && d.jobId) poll(d.jobId); else { setErr(d?.error || 'Failed to start'); setBusy(false); } })
      .catch((e) => { setErr(String(e?.message || e)); setBusy(false); });
  }, [poll]);

  const doneCount = job?.subJobs?.filter((j) => j.status === 'done').length ?? 0;
  const errCount = job?.subJobs?.filter((j) => j.status === 'error').length ?? 0;
  const pct = job ? (job.percentComplete || 0) / 100 : 0;

  return (
    <Card className={s.card}>
      <div className={s.head}>
        <span className={s.icon}><Rocket24Regular /></span>
        <div className={s.headText}>
          <Title3>Deploy the full CSA Loom demo</Title3>
          <Caption1 className={s.hint}>
            One click installs {TOTAL} showcase apps — medallion lakehouse, Direct Lake, real-time / IoT,
            ML &amp; RAG, sovereign AI agents, governance, data mesh, FinOps — each into its own
            <b> Demo — </b> workspace with a real Azure-native backend and seeded data. Explore + test the whole
            art-of-the-possible yourself.
          </Caption1>
        </div>
        <div className={s.actions}>
          {loading ? <Spinner size="tiny" /> : deployed && !busy ? (
            <>
              <Badge appearance="tint" color="success" icon={<CheckmarkCircle20Filled />}>
                Deployed · {wsCount} workspace{wsCount === 1 ? '' : 's'}
              </Badge>
              <Button appearance="primary" icon={<Open20Regular />} onClick={() => router.push('/browse')}>Open demo</Button>
              <Button appearance="subtle" icon={<ArrowClockwise20Regular />} disabled={busy} onClick={deploy}>Redeploy</Button>
            </>
          ) : (
            <Button appearance="primary" size="large" icon={<Rocket24Regular />} disabled={busy} onClick={deploy}>
              {busy ? 'Deploying…' : 'Deploy demo environment'}
            </Button>
          )}
        </div>
      </div>

      {(busy || job) && (
        <div className={s.progressWrap}>
          <ProgressBar value={pct} thickness="large" />
          <Caption1 className={s.hint}>
            {doneCount}/{TOTAL} apps installed{errCount ? ` · ${errCount} need attention` : ''}
            {job?.status === 'done' && ' · done — open the Demo — workspaces to explore'}
            {job?.status === 'partial' && ' · finished with some gates (open each app to see honest remediation)'}
          </Caption1>
          {job?.subJobs && (
            <div className={s.grid}>
              {job.subJobs.map((j) => (
                <div key={j.appId} className={s.appRow}>
                  {j.status === 'done' ? <CheckmarkCircle20Filled color={tokens.colorPaletteGreenForeground1} />
                    : j.status === 'error' ? <ErrorCircle20Filled color={tokens.colorPaletteRedForeground1} />
                    : j.status === 'installing' ? <Spinner size="extra-tiny" />
                    : <Circle20Regular color={tokens.colorNeutralForeground4} />}
                  <Body1 className={s.appLabel}>{j.wsLabel.replace(/^Demo — /, '')}</Body1>
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
