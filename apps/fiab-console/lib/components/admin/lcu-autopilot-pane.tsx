'use client';

/**
 * WS-10.1 — LCU-Autopilot pane (on /admin/autopilot).
 *
 * The self-driving FinOps surface: it reads the real loop state from
 * GET /api/admin/autopilot (LCU telemetry + capacity headline + recommendations
 * with $ impact + action history), lets an admin flip the approval mode
 * (propose ⇄ auto), run the loop on demand, and approve a single recommendation
 * so it self-executes (pause idle compute / roll the capacity env-config). Real
 * backend, no mock data (no-vaporware.md); Fluent v9 + Loom tokens only, TileGrid
 * / EmptyState / SplitPane primitives, honest gate MessageBar with a Fix-it link
 * (web3-ui.md / ux-baseline.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle2,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title3,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  BotSparkle24Regular,
  PauseCircle20Regular,
  ArrowAutofitWidth20Regular,
  ArrowMove20Regular,
  ArrowSync20Regular,
  CheckmarkCircle20Filled,
  Warning20Regular,
  Money20Regular,
} from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';

interface Evidence { label: string; value: string }
interface Recommendation {
  id: string;
  kind: 'pause-idle' | 'right-size' | 'migrate';
  target: string;
  title: string;
  summary: string;
  usdSavedMonthly: number;
  lcuSavedPerHour: number;
  confidence: number;
  evidence: Evidence[];
  autoApplicable: boolean;
  actuator: { type: string };
}
interface Compute {
  kind: string;
  id: string;
  name: string;
  lcuPerHour: number;
  usdMonthly: number;
  utilizationPct: number | null;
  idleMinutes: number;
  state: string;
  pausable: boolean;
}
interface Capacity {
  totalLcu: number; peakLcu: number; capacityLcu: number;
  capacitySource: 'env' | 'derived'; utilizationPct: number;
}
interface HistoryEntry {
  at: string; target: string; kind: string; mode: string;
  actuated: boolean; summary: string; usdSavedMonthly: number; error?: string;
}
interface LoopState {
  ok: true;
  mode: 'auto' | 'propose';
  ranAt: string;
  sloBreaching: boolean;
  signals: {
    compute: Compute[];
    capacity: Capacity | null;
    gatesBlocked: number;
    totalLcuPerHour: number;
    totalUsdMonthly: number;
    telemetryGate?: { reason: string; remediation: string };
  };
  recommendations: Recommendation[];
  totalMonthlySaving: number;
  history: HistoryEntry[];
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  headerRow: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM,
    alignItems: 'center', justifyContent: 'space-between',
  },
  headerActions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, alignItems: 'center', minWidth: 0 },
  statRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL },
  stat: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4, minWidth: '140px',
  },
  statVal: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: '1' },
  computeTile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4, minWidth: 0,
  },
  tileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  tileName: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  tileMetrics: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalXS },
  metric: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  recCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow8,
  },
  recHead: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center', minWidth: 0 },
  recTitle: { fontWeight: tokens.fontWeightSemibold, minWidth: 0 },
  spacer: { flexGrow: 1 },
  evidence: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM },
  evItem: { display: 'flex', gap: tokens.spacingHorizontalXXS },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  scroll: { overflow: 'auto', minHeight: 0 },
  savings: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
});

function kindIcon(kind: string) {
  if (kind === 'pause-idle') return <PauseCircle20Regular />;
  if (kind === 'right-size') return <ArrowAutofitWidth20Regular />;
  return <ArrowMove20Regular />;
}

function stateBadge(state: string): 'success' | 'warning' | 'informative' {
  if (state === 'Online' || state === 'Running') return 'success';
  if (state === 'Paused' || state === 'Stopped') return 'informative';
  return 'warning';
}

export function LcuAutopilotPane() {
  const s = useStyles();
  const [data, setData] = useState<LoopState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientFetch('/api/admin/autopilot');
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j.error || `Failed to load (${res.status})`); setData(null); }
      else setData(j as LoopState);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const setMode = useCallback(async (mode: 'auto' | 'propose') => {
    setBusy('mode');
    setNotice(null);
    try {
      const res = await clientFetch('/api/admin/autopilot', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setError(j.error || 'Failed to set mode');
      else { setNotice(`Approval mode set to ${mode}.`); await reload(); }
    } finally { setBusy(null); }
  }, [reload]);

  const runNow = useCallback(async () => {
    setBusy('run');
    setNotice(null);
    try {
      const res = await clientFetch('/api/admin/autopilot/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!res.ok || !j.ok) setError(j.error || 'Run failed');
      else {
        const n = Array.isArray(j.actuated) ? j.actuated.filter((a: { ok: boolean }) => a.ok).length : 0;
        setNotice(n > 0 ? `Loop ran — ${n} action(s) actuated.` : 'Loop ran — no auto-actions (propose mode or nothing idle).');
        setData(j as LoopState);
      }
    } finally { setBusy(null); }
  }, []);

  const approve = useCallback(async (rec: Recommendation) => {
    setBusy(rec.id);
    setNotice(null);
    try {
      const res = await clientFetch('/api/admin/autopilot/apply', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recommendationId: rec.id }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) setError(j.error || `Could not apply (${res.status})`);
      else { setNotice(`Applied: ${rec.title} — ${j.receipt?.backend || 'done'}.`); await reload(); }
    } finally { setBusy(null); }
  }, [reload]);

  const cap = data?.signals.capacity;
  const recs = data?.recommendations ?? [];
  const history = data?.history ?? [];
  const money = useMemo(() => (n: number) => `$${n.toFixed(2)}`, []);

  if (loading && !data) return <Spinner label="Reading LCU telemetry…" />;

  return (
    <div className={s.root}>
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle> {error}</MessageBarBody></MessageBar>
      )}
      {notice && (
        <MessageBar intent="success"><MessageBarBody>{notice}</MessageBarBody></MessageBar>
      )}
      {data?.signals.telemetryGate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>LCU cost telemetry unavailable</MessageBarTitle>
            {data.signals.telemetryGate.remediation}
          </MessageBarBody>
          <MessageBarActions>
            <Button as="a" href="/admin/env-config" size="small">Fix it — env-config</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {data?.sloBreaching && (
        <MessageBar intent="warning"><MessageBarBody>
          <MessageBarTitle>Auto-actuation paused</MessageBarTitle>
          A latency SLO is breaching — the loop will not pause compute or roll config until it recovers.
        </MessageBarBody></MessageBar>
      )}

      {/* header + mode toggle */}
      <div className={s.headerRow}>
        <div className={s.tileHead}>
          <BotSparkle24Regular />
          <div>
            <Title3>Self-driving FinOps</Title3>
            <div><Caption1>LCU telemetry → policy → auto-pause idle compute + capacity right-size. Real Azure backends.</Caption1></div>
          </div>
        </div>
        <div className={s.headerActions}>
          <Tooltip content="Auto mode lets the loop pause idle compute + roll capacity config unattended. Propose surfaces recommendations only." relationship="label">
            <Switch
              checked={data?.mode === 'auto'}
              disabled={busy === 'mode'}
              onChange={(_, d) => void setMode(d.checked ? 'auto' : 'propose')}
              label={data?.mode === 'auto' ? 'Auto (actuating)' : 'Propose only'}
            />
          </Tooltip>
          <Button icon={<ArrowSync20Regular />} disabled={busy === 'run'} onClick={() => void runNow()}>
            {busy === 'run' ? 'Running…' : 'Run now'}
          </Button>
        </div>
      </div>

      {/* headline stats */}
      <div className={s.statRow}>
        <div className={s.stat}>
          <span className={s.statVal}>{cap ? `${cap.utilizationPct.toFixed(0)}%` : '—'}</span>
          <Caption1>LCU utilization{cap ? ` (${cap.totalLcu.toFixed(0)} / ${cap.capacityLcu} LCU)` : ''}</Caption1>
        </div>
        <div className={s.stat}>
          <span className={s.statVal}>{data?.signals.totalLcuPerHour?.toFixed(1) ?? '—'}</span>
          <Caption1>LCU / hr (compute)</Caption1>
        </div>
        <div className={s.stat}>
          <span className={`${s.statVal} ${s.savings}`}>{data ? money(data.totalMonthlySaving) : '—'}</span>
          <Caption1>Recoverable $/mo</Caption1>
        </div>
        <div className={s.stat}>
          <span className={s.statVal}>{recs.length}</span>
          <Caption1>Recommendations</Caption1>
        </div>
      </div>

      {/* compute tiles */}
      <div className={s.section}>
        <Subtitle2>Compute</Subtitle2>
        {(!data || data.signals.compute.length === 0) ? (
          <EmptyState
            icon={<BotSparkle24Regular />}
            title="No pausable compute discovered"
            body="Configure a Synapse dedicated SQL pool or an ADX cluster (LOOM_SYNAPSE_DEDICATED_POOL / LOOM_KUSTO_CLUSTER_NAME) and the autopilot will track its LCU + idle state here."
          />
        ) : (
          <TileGrid minTileWidth={240}>
            {data.signals.compute.map((c) => (
              <Card key={c.id} className={s.computeTile}>
                <div className={s.tileHead}>
                  <Money20Regular />
                  <Text className={s.tileName}>{c.name}</Text>
                </div>
                <div className={s.badgeRow}>
                  <Badge appearance="tint" color={stateBadge(c.state)}>{c.state}</Badge>
                  {c.utilizationPct !== null && c.utilizationPct <= 5 && c.idleMinutes >= 30 && (
                    <Badge appearance="tint" color="warning">idle {c.idleMinutes}m</Badge>
                  )}
                </div>
                <div className={s.tileMetrics}>
                  <div className={s.metric}>
                    <Caption1>Utilization</Caption1>
                    <Text>{c.utilizationPct === null ? '—' : `${c.utilizationPct.toFixed(1)}%`}</Text>
                  </div>
                  <div className={s.metric}>
                    <Caption1>LCU/hr</Caption1>
                    <Text>{c.lcuPerHour.toFixed(2)}</Text>
                  </div>
                  <div className={s.metric}>
                    <Caption1>$/mo</Caption1>
                    <Text>{money(c.usdMonthly)}</Text>
                  </div>
                </div>
              </Card>
            ))}
          </TileGrid>
        )}
      </div>

      {/* recommendations | history — resizable (G3) */}
      <SplitPane direction="horizontal" storageKey="admin.autopilot.recs-history" defaultSize="60%" minSize={280} dividerLabel="Recommendations / History">
        <div className={s.section}>
          <Subtitle2>Recommendations</Subtitle2>
          {recs.length === 0 ? (
            <EmptyState
              icon={<CheckmarkCircle20Filled />}
              title="Nothing to optimize right now"
              body="No idle compute or over-provisioned capacity was detected in the current window. The loop re-evaluates every run."
            />
          ) : (
            <div className={s.section}>
              {recs.map((r) => (
                <Card key={r.id} className={s.recCard}>
                  <div className={s.recHead}>
                    {kindIcon(r.kind)}
                    <Text className={s.recTitle}>{r.title}</Text>
                    <Badge appearance="tint" color={r.kind === 'migrate' ? 'informative' : 'brand'}>{r.kind}</Badge>
                    {r.usdSavedMonthly > 0 && <Badge appearance="tint" color="success">{money(r.usdSavedMonthly)}/mo</Badge>}
                    <span className={s.spacer} />
                    {r.actuator.type === 'advisory' ? (
                      <Badge appearance="outline" icon={<Warning20Regular />}>Advisory</Badge>
                    ) : (
                      <Button
                        appearance="primary" size="small"
                        disabled={busy === r.id}
                        onClick={() => void approve(r)}
                      >
                        {busy === r.id ? 'Applying…' : 'Approve & apply'}
                      </Button>
                    )}
                  </div>
                  <Body1>{r.summary}</Body1>
                  <div className={s.evidence}>
                    {r.evidence.map((e, i) => (
                      <span key={i} className={s.evItem}>
                        <Caption1>{e.label}:</Caption1><Caption1><b>{e.value}</b></Caption1>
                      </span>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className={s.section}>
          <Subtitle2>Action history</Subtitle2>
          {history.length === 0 ? (
            <Caption1>No autopilot actions yet.</Caption1>
          ) : (
            <div className={s.scroll}>
              <Table size="small" aria-label="Autopilot action history">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>When</TableHeaderCell>
                    <TableHeaderCell>Action</TableHeaderCell>
                    <TableHeaderCell>Target</TableHeaderCell>
                    <TableHeaderCell>Result</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h, i) => (
                    <TableRow key={i}>
                      <TableCell>{new Date(h.at).toLocaleString()}</TableCell>
                      <TableCell>{h.kind} <Caption1>({h.mode})</Caption1></TableCell>
                      <TableCell>{h.target}</TableCell>
                      <TableCell>
                        {h.actuated
                          ? <Badge appearance="tint" color="success">applied{h.usdSavedMonthly > 0 ? ` · ${money(h.usdSavedMonthly)}/mo` : ''}</Badge>
                          : <Badge appearance="tint" color="danger">{h.error ? 'failed' : 'proposed'}</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </SplitPane>
    </div>
  );
}
