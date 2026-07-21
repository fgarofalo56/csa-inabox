'use client';

/**
 * WS-10.5 — Parity Autopilot admin panel (Admin → Parity Autopilot).
 *
 * A REAL-data view over GET /api/admin/parity-autopilot: the recent autopilot
 * run ledger (from the parity-autopilot-runs Cosmos container) + the currently
 * open auto-filed gap issues (from the GitHub REST API, label `parity-autopilot`).
 * Runs are DRIVEN by the schedule (loom-parity-autopilot.yml → parity-autopilot.mjs
 * → POST /run) — this surface shows last run, gaps found, and filed issues.
 *
 * Honest gates (no-vaporware.md): a run whose vision/plan step was gated shows an
 * inline MessageBar with the exact reason; if GitHub egress is unconfigured the
 * issues card names LOOM_FEEDBACK_GITHUB_TOKEN. Fluent v9 + Loom tokens, sibling
 * AdminShell look, TileGrid summary, EmptyState for empty panes (web3-ui.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Spinner, Text, Link,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, ScanText24Regular, BranchCompare20Regular,
  CheckmarkCircle16Filled, Warning16Filled, DocumentBulletList24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';

interface GapOutcome {
  gap: { num: string; capability: string; evidence: string };
  plan?: { summary: string; steps: { title: string }[] };
  planError?: string;
  issue?: { filed?: boolean; deduped?: boolean; gated?: boolean; issueNumber?: number; issueUrl?: string; error?: string; reason?: string };
}
interface RunDoc {
  id: string; slug: string; title: string; route?: string;
  checked: number; gapCount: number; gaps: GapOutcome[];
  gated?: boolean; gateReason?: string;
  ranAt: string; ranBy: string; theme?: string; url?: string;
}
interface IssueRow { number: number; title: string; url: string; createdAt: string; state: string }
interface Snapshot {
  ok: boolean; error?: string;
  runs: RunDoc[];
  issues: IssueRow[];
  githubGated?: boolean; githubGateReason?: string; githubError?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  runCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1, minWidth: 0,
  },
  runHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  grow: { flexGrow: 1, minWidth: 0 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  gapRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalXS, paddingInline: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2,
  },
  gapList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  muted: { color: tokens.colorNeutralForeground3 },
  issueRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS, flexWrap: 'wrap', minWidth: 0,
  },
  runsWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

function tile(label: string, value: string | number, icon: React.ReactNode) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
      padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
      border: `1px solid ${tokens.colorNeutralStroke2}`, boxShadow: tokens.shadow4,
      backgroundColor: tokens.colorNeutralBackground1, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
        {icon}<Caption1 className={undefined}>{label}</Caption1>
      </div>
      <Text weight="semibold" size={600}>{value}</Text>
    </div>
  );
}

export function ParityAutopilotPanel() {
  const s = useStyles();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientFetch('/api/admin/parity-autopilot');
      const j = (await res.json()) as Snapshot;
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSnap(j);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading && !snap) {
    return <div style={{ padding: tokens.spacingVerticalXXL, textAlign: 'center' }}><Spinner label="Loading Parity Autopilot…" /></div>;
  }

  const runs = snap?.runs ?? [];
  const issues = snap?.issues ?? [];
  const lastRun = runs[0];
  const totalGaps = runs.reduce((a, r) => a + (r.gapCount || 0), 0);

  return (
    <div className={s.root}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed to load</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      <MessageBar intent="info" layout="multiline">
        <MessageBarBody>
          <MessageBarTitle>How it runs</MessageBarTitle>
          The Parity Autopilot is a scheduled job (<Text weight="semibold">.github/workflows/loom-parity-autopilot.yml</Text> →
          {' '}<Text weight="semibold">scripts/csa-loom/parity-autopilot.mjs</Text>): for a target surface it captures a live
          Playwright screenshot (Track-0), runs an Azure OpenAI vision diff against the surface&apos;s parity doc, and for every
          &ldquo;built&rdquo; capability it can&apos;t see it proposes a fix plan and files a GitHub issue (label{' '}
          <code>parity-autopilot</code>). This page shows the run ledger and the open gap issues.
        </MessageBarBody>
      </MessageBar>

      <TileGrid minTileWidth={200}>
        {tile('Runs recorded', runs.length, <ScanText24Regular />)}
        {tile('Gaps found (all runs)', totalGaps, <BranchCompare20Regular />)}
        {tile('Open gap issues', issues.length, <DocumentBulletList24Regular />)}
        {tile('Last run', lastRun ? new Date(lastRun.ranAt).toLocaleString() : '—', <ArrowClockwise16Regular />)}
      </TileGrid>

      <Section
        title="Recent runs"
        actions={<Button size="small" icon={<ArrowClockwise16Regular />} onClick={() => void load()}>Refresh</Button>}
      >
        {runs.length === 0 ? (
          <EmptyState
            icon={<ScanText24Regular />}
            title="No autopilot runs yet"
            body="The scheduled workflow files a run here after it captures a surface and diffs it against its parity doc. Trigger loom-parity-autopilot.yml (workflow_dispatch) to record the first run."
          />
        ) : (
          <div className={s.runsWrap}>
            {runs.map((r) => (
              <div key={r.id} className={s.runCard}>
                <div className={s.runHead}>
                  <ScanText24Regular />
                  <div className={s.grow}>
                    <Text weight="semibold">{r.title}</Text>{' '}
                    <Caption1 className={s.muted}>({r.slug}{r.route ? ` · ${r.route}` : ''})</Caption1>
                  </div>
                  <div className={s.badges}>
                    <Badge appearance="tint" color="informative">{r.checked} checked</Badge>
                    <Badge appearance="tint" color={r.gapCount > 0 ? 'danger' : 'success'}>
                      {r.gapCount} gap{r.gapCount === 1 ? '' : 's'}
                    </Badge>
                    {r.theme && <Badge appearance="outline">{r.theme}</Badge>}
                  </div>
                </div>
                <Caption1 className={s.muted}>{new Date(r.ranAt).toLocaleString()} · by {r.ranBy}</Caption1>

                {r.gated && (
                  <MessageBar intent="warning" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Run gated</MessageBarTitle>{r.gateReason}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {r.gaps.length > 0 && (
                  <div className={s.gapList}>
                    {r.gaps.map((g) => (
                      <div key={g.gap.num} className={s.gapRow}>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                          <Warning16Filled primaryFill={tokens.colorPaletteDarkOrangeForeground1} />
                          <Text weight="semibold">#{g.gap.num} {g.gap.capability}</Text>
                          {g.issue?.filed && g.issue.issueUrl && (
                            <Badge appearance="tint" color="brand" as="a" {...({ href: g.issue.issueUrl, target: '_blank' } as any)}>
                              filed #{g.issue.issueNumber}
                            </Badge>
                          )}
                          {g.issue?.deduped && (
                            <Badge appearance="outline" color="informative">already open #{g.issue.issueNumber}</Badge>
                          )}
                          {g.issue?.gated && <Badge appearance="outline" color="warning">issue gated</Badge>}
                        </div>
                        <Caption1 className={s.muted}>{g.gap.evidence}</Caption1>
                        {g.plan?.summary && <Caption1>Plan: {g.plan.summary}</Caption1>}
                        {g.planError && <Caption1 className={s.muted}>{g.planError}</Caption1>}
                        {g.issue?.gated && g.issue.reason && <Caption1 className={s.muted}>{g.issue.reason}</Caption1>}
                      </div>
                    ))}
                  </div>
                )}
                {!r.gated && r.gaps.length === 0 && (
                  <Caption1 className={s.muted}>
                    <CheckmarkCircle16Filled primaryFill={tokens.colorPaletteGreenForeground1} /> No gaps — every &ldquo;built&rdquo; row was visible.
                  </Caption1>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Open gap issues">
        {snap?.githubGated ? (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>GitHub issue filing not configured</MessageBarTitle>
              {snap.githubGateReason}
            </MessageBarBody>
          </MessageBar>
        ) : snap?.githubError ? (
          <MessageBar intent="error"><MessageBarBody>{snap.githubError}</MessageBarBody></MessageBar>
        ) : issues.length === 0 ? (
          <EmptyState
            icon={<DocumentBulletList24Regular />}
            title="No open gap issues"
            body="When a run finds a built-claimed capability that isn't visible on the live surface, it files a labelled GitHub issue with a proposed plan. None are open right now."
          />
        ) : (
          <div>
            {issues.map((i) => (
              <div key={i.number} className={s.issueRow}>
                <DocumentBulletList24Regular />
                <div className={s.grow}>
                  <Link href={i.url} target="_blank">#{i.number} {i.title}</Link>
                </div>
                <Caption1 className={s.muted}>{new Date(i.createdAt).toLocaleDateString()}</Caption1>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
