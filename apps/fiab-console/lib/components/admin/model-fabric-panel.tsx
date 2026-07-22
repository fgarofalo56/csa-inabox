'use client';

/**
 * WS-7 — Closed-Loop Model Fabric panel (Admin → Model Fabric).
 *
 * The control surface for the self-optimizing loop that fuses routing
 * (tier-router) + eval (LLM-judge) + red-team + serving + SLO into automatic
 * promote/demote decisions over serving traffic-splits and the reasoning tier.
 *
 * Everything is REAL data from GET /api/admin/model-fabric (a non-actuating
 * dry-run of the loop): the live traffic split, the per-deployment signals
 * feeding each decision, the freshly-computed promote/demote proposal, the
 * reasoning-tier state, the global latency-SLO guard, and the recent decision
 * history. The approval toggle (Auto vs Propose-only) PUTs the mode; "Run loop"
 * POSTs /run (actuating in Auto, recording a proposal in Propose). Fluent v9 +
 * Loom tokens, AdminShell siblings' look, SplitPane for the decision inspector
 * (web3-ui.md / ux-baseline G1-G3). Honest gate + Fix-it when serving is
 * unconfigured (no-vaporware.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Spinner, Subtitle2, Switch, Text, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, Play20Regular, BrainCircuit24Regular,
  ArrowTrendingLines24Regular, Molecule24Regular, ShieldTask24Regular,
  ArrowUp16Filled, ArrowDown16Filled, Pause16Regular, Wrench16Regular,
  CheckmarkCircle16Filled, Warning16Filled,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

// ── wire shapes (mirror lib/admin/model-fabric{,-loop}.ts) ───────────────────

interface Candidate {
  key: string; model?: string; action: 'promote' | 'demote' | 'hold';
  fromWeight: number; toWeight: number; composite: number | null; reason: string;
}
interface Decision {
  endpoint: string; candidates: Candidate[];
  newTraffic: Record<string, number>; currentTraffic: Record<string, number>;
  changed: boolean; held: boolean; heldReason?: string;
}
interface Signal {
  key: string; model?: string; evalScore?: number; evalPassRate?: number;
  evalSamples?: number; regressed?: boolean; refusalRate?: number;
  attackSuccessRate?: number; errorRate?: number; currentWeight: number;
}
interface EndpointResult {
  endpoint: string; signals: Signal[]; decision: Decision;
  actuated: boolean; actuationError?: string;
}
interface TierCand { model: string; avgScore: number; samples: number; composite: number | null }
interface TierProposal {
  reasoningConfigured: boolean; currentStrong?: string; proposedStrong?: string;
  changed: boolean; actuated: boolean; reason: string; candidates: TierCand[]; actuationError?: string;
}
interface HistoryEntry {
  at: string; target: string; kind: 'serving' | 'tier'; mode: string;
  actuated: boolean; changed: boolean; heldReason?: string; summary: string;
}
interface Gate { gateId: string; missing: string; hint: string; fixEnvVar: string }
interface Snapshot {
  ok: boolean; mode: 'auto' | 'propose'; ranAt: string; sloBreaching: boolean;
  servingGate?: Gate | null; endpoints: EndpointResult[]; tier: TierProposal;
  history: HistoryEntry[]; error?: string;
}

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalL },
  spacer: { flex: '1 1 auto' },
  modeBox: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  tileGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px,100%), 1fr))', gap: tokens.spacingHorizontalL },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, minWidth: 0,
    transitionProperty: 'box-shadow', transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  tileLabel: {
    fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  tileValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightBold, lineHeight: 1.15 },
  sub: { color: tokens.colorNeutralForeground3 },
  splitWrap: { height: '520px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden' },
  pane: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 },
  paneHead: {
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
    fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200,
  },
  paneScroll: { overflowY: 'auto', padding: tokens.spacingVerticalM, minWidth: 0, flex: '1 1 auto' },
  epList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  epItem: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer', textAlign: 'left', minWidth: 0,
    // Native <button>: without an explicit color, text inherits UA ButtonText (black-on-dark).
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  epActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2 },
  rowTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left', fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.04em',
    color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap',
  },
  td: { padding: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, verticalAlign: 'middle', fontSize: tokens.fontSizeBase200 },
  trafficRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0, marginBottom: tokens.spacingVerticalXS },
  trafficLabel: { width: '160px', minWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: tokens.fontSizeBase200 },
  barTrack: { flex: '1 1 auto', height: '10px', borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground3, minWidth: '60px', overflow: 'hidden', position: 'relative' },
  barFrom: { position: 'absolute', top: 0, left: 0, height: '10px', backgroundColor: tokens.colorNeutralStroke1, opacity: 0.5 },
  barTo: { position: 'absolute', top: 0, left: 0, height: '10px', backgroundColor: tokens.colorBrandBackground, borderRadius: tokens.borderRadiusCircular },
  reason: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  historyRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalXS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, minWidth: 0 },
});

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtNum(n?: number, dp = 1): string { return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(dp) : '—'; }
function fmtTime(iso?: string): string { if (!iso) return ''; try { return new Date(iso).toLocaleString(); } catch { return iso; } }
function actionBadge(a: Candidate['action']) {
  if (a === 'promote') return <Badge appearance="filled" color="success" icon={<ArrowUp16Filled />}>promote</Badge>;
  if (a === 'demote') return <Badge appearance="filled" color="danger" icon={<ArrowDown16Filled />}>demote</Badge>;
  return <Badge appearance="outline" icon={<Pause16Regular />}>hold</Badge>;
}

// ── panel ─────────────────────────────────────────────────────────────────────

export function ModelFabricPanel() {
  const s = useStyles();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    clientFetch('/api/admin/model-fabric', { cache: 'no-store' }, 45_000)
      .then((r) => (r.status === 401 || r.status === 403 ? null : r.json()))
      .then((j: Snapshot | null) => {
        if (!j) { setErr('Sign in as a tenant admin to view the Model Fabric loop.'); return; }
        if (j.ok) {
          setSnap(j);
          if (!selected && j.endpoints?.length) setSelected(j.endpoints[0].endpoint);
        } else setErr(j.error || 'Failed to load the model-fabric loop state');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [selected]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setMode = useCallback((mode: 'auto' | 'propose') => {
    setBusy('mode');
    clientFetch('/api/admin/model-fabric', { method: 'PUT', body: JSON.stringify({ mode }) }, 20_000)
      .then((r) => r.json())
      .then((j: any) => { if (j.ok) { setSnap((p) => (p ? { ...p, mode: j.mode } : p)); } else setErr(j.error || 'Failed to set mode'); })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(null));
  }, []);

  const runLoop = useCallback((mode?: 'auto' | 'propose') => {
    setBusy('run'); setRunResult(null);
    clientFetch('/api/admin/model-fabric/run', { method: 'POST', body: JSON.stringify(mode ? { mode } : {}) }, 60_000)
      .then((r) => r.json())
      .then((j: Snapshot) => {
        if (j.ok) {
          setSnap(j);
          const acted = j.endpoints.filter((e) => e.actuated).length + (j.tier.actuated ? 1 : 0);
          const proposed = j.endpoints.filter((e) => e.decision.changed && !e.actuated).length + (j.tier.changed && !j.tier.actuated ? 1 : 0);
          setRunResult(j.mode === 'auto'
            ? `Loop ran in AUTO — ${acted} change(s) applied${proposed ? `, ${proposed} skipped` : ''}.`
            : `Loop ran in PROPOSE — ${proposed} change(s) proposed, 0 applied.`);
        } else setErr((j as any).error || 'Loop run failed');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(null));
  }, []);

  const selectedResult = useMemo(
    () => snap?.endpoints.find((e) => e.endpoint === selected) ?? snap?.endpoints[0] ?? null,
    [snap, selected],
  );

  if (loading && !snap) {
    return <Spinner size="large" label="Running the model-fabric loop…" labelPosition="below" style={{ marginTop: tokens.spacingVerticalXXXL }} />;
  }
  if (err && !snap) {
    return <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Sign-in required</MessageBarTitle> {err}</MessageBarBody></MessageBar>;
  }
  if (!snap) return null;

  const auto = snap.mode === 'auto';
  const anyChange = snap.endpoints.some((e) => e.decision.changed) || snap.tier.changed;

  return (
    <div>
      {/* Toolbar: mode toggle + run + refresh */}
      <div className={s.toolbar}>
        <div className={s.modeBox}>
          <Molecule24Regular style={{ color: tokens.colorBrandForeground1 }} />
          <Text weight="semibold">Approval mode</Text>
          <Switch
            checked={auto}
            disabled={busy === 'mode'}
            onChange={(_e, d) => setMode(d.checked ? 'auto' : 'propose')}
            label={auto ? 'Auto-apply' : 'Propose-only'}
          />
          <Tooltip content="In Auto-apply the loop promotes the live-eval winner and demotes regressions automatically (traffic-split + reasoning tier). In Propose-only it computes the same decision but changes nothing until you run it — every change is audited." relationship="label">
            <Badge appearance="tint" color={auto ? 'success' : 'informative'}>{auto ? 'AUTO' : 'PROPOSE'}</Badge>
          </Tooltip>
        </div>
        <div className={s.spacer} />
        <Button appearance="primary" icon={<Play20Regular />} disabled={!!busy} onClick={() => runLoop()}>
          {auto ? 'Run loop (apply)' : 'Run loop (propose)'}
        </Button>
        <Button appearance="subtle" size="small" icon={<ArrowClockwise16Regular />} disabled={!!busy} onClick={load}>Refresh</Button>
      </div>

      {runResult && <MessageBar intent="success" style={{ marginBottom: tokens.spacingVerticalM }}><MessageBarBody>{runResult}</MessageBarBody></MessageBar>}
      {err && <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {snap.sloBreaching && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Latency SLO breaching</MessageBarTitle> The Copilot latency SLO is breaching — the loop will NOT reshape traffic under a live latency incident (a safety guard). It resumes once the SLO recovers.</MessageBarBody>
        </MessageBar>
      )}

      {/* Overview scorecard */}
      <Section
        title="Loop overview"
        actions={<LearnPopover
          title="Closed-Loop Model Fabric"
          content="A self-optimizing loop that fuses continuous eval + red-team + serving + SLO signals to automatically promote the live-eval winner and demote regressions across serving traffic-splits and the reasoning tier. In Propose-only it shows what it WOULD do; in Auto-apply it actuates. Every action is audited; all signals are real Azure OpenAI / Cosmos / Azure ML data — no Fabric dependency."
          learnMoreHref="https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments"
        />}
      >
        <div className={s.tileGrid}>
          <div className={s.tile}>
            <span className={s.tileLabel}><ArrowTrendingLines24Regular /> Serving endpoints</span>
            <span className={s.tileValue}>{snap.endpoints.length}</span>
            <Caption1 className={s.sub}>multi-deployment endpoints in the loop</Caption1>
          </div>
          <div className={s.tile}>
            <span className={s.tileLabel}><Molecule24Regular /> Pending changes</span>
            <span className={s.tileValue} style={{ color: anyChange ? tokens.colorPaletteGreenForeground1 : tokens.colorNeutralForeground2 }}>{snap.endpoints.filter((e) => e.decision.changed).length + (snap.tier.changed ? 1 : 0)}</span>
            <Caption1 className={s.sub}>{auto ? 'auto-applied on run' : 'proposed — run to record'}</Caption1>
          </div>
          <div className={s.tile}>
            <span className={s.tileLabel}><BrainCircuit24Regular /> Reasoning tier</span>
            <span className={mergeClasses(s.tileValue, s.ellipsis)} style={{ fontSize: tokens.fontSizeBase400 }}>{snap.tier.currentStrong || (snap.tier.reasoningConfigured ? '—' : 'not set')}</span>
            <Caption1 className={s.sub}>{snap.tier.changed ? `proposed → ${snap.tier.proposedStrong}` : 'stable'}</Caption1>
          </div>
          <div className={s.tile}>
            <span className={s.tileLabel}><ShieldTask24Regular /> Latency SLO</span>
            <span className={s.tileValue} style={{ color: snap.sloBreaching ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1 }}>{snap.sloBreaching ? 'Breaching' : 'Healthy'}</span>
            <Caption1 className={s.sub}>global actuation guard</Caption1>
          </div>
        </div>
      </Section>

      {/* Serving honest-gate + Fix it */}
      {snap.servingGate && (
        <Section title="Serving backend">
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>No model-serving backend configured</MessageBarTitle>
              {snap.servingGate.hint} The loop needs at least one serving endpoint with two deployments to shift traffic.
            </MessageBarBody>
            <MessageBarActions>
              <Button size="small" icon={<Wrench16Regular />} as="a" href={`/admin/gates?gate=${encodeURIComponent(snap.servingGate.gateId)}`}>Fix it</Button>
            </MessageBarActions>
          </MessageBar>
        </Section>
      )}

      {/* Reasoning tier */}
      <Section
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}><BrainCircuit24Regular style={{ color: tokens.colorBrandForeground1 }} /> Reasoning tier (tier-router)</span>}
      >
        {renderTier()}
      </Section>

      {/* Serving decisions — SplitPane list + inspector (G3) */}
      <Section
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}><ArrowTrendingLines24Regular style={{ color: tokens.colorBrandForeground1 }} /> Serving traffic decisions</span>}
      >
        {renderServing()}
      </Section>

      {/* Decision history */}
      <Section title="Recent decisions">
        {renderHistory()}
      </Section>
    </div>
  );

  // ── sub-renderers ──

  function renderTier() {
    const t = snap!.tier;
    if (!t.reasoningConfigured) {
      return (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Reasoning tier not configured</MessageBarTitle>
            The tier-router has no strong (reasoning) deployment, so there is no tier to optimize. Set <code>LOOM_AOAI_STRONG_DEPLOYMENT</code> to a deployed reasoning model to let the loop promote the best eval model into it.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" icon={<Wrench16Regular />} as="a" href="/admin/gates?gate=svc-model-reasoning-tier">Fix it</Button>
          </MessageBarActions>
        </MessageBar>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
        <div className={s.chips}>
          <Badge appearance="tint" color="brand">current: {t.currentStrong || '—'}</Badge>
          {t.changed
            ? <Badge appearance="filled" color="success" icon={<ArrowUp16Filled />}>propose → {t.proposedStrong}{t.actuated ? ' (applied)' : ''}</Badge>
            : <Badge appearance="outline" icon={<CheckmarkCircle16Filled />}>stable</Badge>}
        </div>
        <Body1 className={s.reason}>{t.reason}</Body1>
        {t.actuationError && <MessageBar intent="error"><MessageBarBody>Actuation failed: {t.actuationError}</MessageBarBody></MessageBar>}
        {t.candidates.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className={s.table}>
              <thead><tr><th className={s.th}>Model</th><th className={s.th}>Eval avg</th><th className={s.th}>Samples</th><th className={s.th}>Composite</th></tr></thead>
              <tbody>
                {t.candidates.map((c) => (
                  <tr key={c.model}>
                    <td className={s.td}>{c.model === t.currentStrong ? <strong>{c.model}</strong> : c.model}</td>
                    <td className={s.td}>{fmtNum(c.avgScore, 2)}/5</td>
                    <td className={s.td}>{c.samples}</td>
                    <td className={s.td}>{c.composite != null ? c.composite.toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Text className={s.sub}>No model has enough eval samples yet to rank the reasoning tier.</Text>}
      </div>
    );
  }

  function renderServing() {
    const eps = snap!.endpoints;
    if (eps.length === 0) {
      return <EmptyState
        icon={<ArrowTrendingLines24Regular />}
        title="No multi-deployment serving endpoints"
        body="The loop shifts traffic between deployments on a model-serving endpoint. Create a serving endpoint and add a second deployment (e.g. a challenger model) to give the loop something to optimize."
        primaryAction={{ label: 'Open Model serving', href: '/browse?type=model-serving-endpoint' }}
      />;
    }
    return (
      <div className={s.splitWrap}>
        <SplitPane direction="horizontal" defaultSize="34%" minSize={200} storageKey="model-fabric-endpoints" dividerLabel="Resize endpoint list">
          <div className={s.pane}>
            <div className={s.paneHead}>Endpoints ({eps.length})</div>
            <div className={mergeClasses(s.paneScroll, s.epList)}>
              {eps.map((e) => {
                const on = e.endpoint === (selectedResult?.endpoint);
                const promoted = e.decision.candidates.filter((c) => c.action === 'promote').length;
                const demoted = e.decision.candidates.filter((c) => c.action === 'demote').length;
                return (
                  <button key={e.endpoint} className={mergeClasses(s.epItem, on && s.epActive)} onClick={() => setSelected(e.endpoint)}>
                    <div className={s.rowTop}>
                      {e.decision.changed ? <ArrowUp16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : <Pause16Regular style={{ color: tokens.colorNeutralForeground3 }} />}
                      <Text size={200} weight="semibold" className={s.ellipsis} style={{ flex: '1 1 auto' }}>{e.endpoint}</Text>
                      {e.actuated && <Badge appearance="tint" color="success">applied</Badge>}
                    </div>
                    <Caption1 className={s.sub}>{e.decision.held ? `hold (${e.decision.heldReason})` : `+${promoted} / −${demoted} · ${e.signals.length} deployments`}</Caption1>
                  </button>
                );
              })}
            </div>
          </div>
          <div className={s.pane}>
            <div className={s.paneHead}>Decision inspector</div>
            <div className={s.paneScroll}>{renderInspector()}</div>
          </div>
        </SplitPane>
      </div>
    );
  }

  function renderInspector() {
    const r = selectedResult;
    if (!r) return <Text className={s.sub}>Select an endpoint to inspect its signals and the promote/demote decision.</Text>;
    const d = r.decision;
    const maxW = 100;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 }}>
        <div className={s.chips}>
          <Subtitle2 className={s.ellipsis}>{r.endpoint}</Subtitle2>
          {d.held ? <Badge appearance="outline">hold · {d.heldReason}</Badge> : <Badge appearance="tint" color={d.changed ? 'success' : 'informative'}>{d.changed ? 'change proposed' : 'no change'}</Badge>}
          {r.actuated && <Badge appearance="filled" color="success">applied</Badge>}
        </div>
        {r.actuationError && <MessageBar intent="error"><MessageBarBody>Actuation failed: {r.actuationError}</MessageBarBody></MessageBar>}

        {/* traffic split — from → to bars */}
        <div>
          <Caption1 className={s.tileLabel}>Traffic split (current → proposed)</Caption1>
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            {r.signals.map((sig) => {
              const from = d.currentTraffic[sig.key] ?? sig.currentWeight;
              const to = d.newTraffic[sig.key] ?? from;
              return (
                <div key={sig.key} className={s.trafficRow}>
                  <Tooltip content={sig.key} relationship="label"><span className={s.trafficLabel}>{sig.key}</span></Tooltip>
                  <div className={s.barTrack}>
                    <div className={s.barFrom} style={{ width: `${(from / maxW) * 100}%` }} />
                    <div className={s.barTo} style={{ width: `${(to / maxW) * 100}%` }} />
                  </div>
                  <Caption1 className={s.sub} style={{ width: '92px', textAlign: 'right' }}>{from}%→{to}%</Caption1>
                </div>
              );
            })}
          </div>
        </div>

        {/* signals + action table */}
        <div style={{ overflowX: 'auto' }}>
          <table className={s.table}>
            <thead>
              <tr>
                <th className={s.th}>Deployment</th><th className={s.th}>Model</th>
                <th className={s.th}>Eval</th><th className={s.th}>Refusal</th>
                <th className={s.th}>5xx</th><th className={s.th}>Composite</th><th className={s.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {r.signals.map((sig) => {
                const c = d.candidates.find((x) => x.key === sig.key);
                return (
                  <tr key={sig.key}>
                    <td className={s.td}><span className={s.ellipsis} style={{ display: 'inline-block', maxWidth: '160px' }}>{sig.key}</span></td>
                    <td className={mergeClasses(s.td, s.sub)}>{sig.model || '—'}</td>
                    <td className={s.td}>
                      {sig.evalScore != null ? <span>{fmtNum(sig.evalScore, 2)}/5 {sig.regressed && <Warning16Filled style={{ color: tokens.colorPaletteRedForeground1, verticalAlign: 'text-bottom' }} />}</span> : '—'}
                      {sig.evalSamples != null && <Caption1 className={s.sub}> · {sig.evalSamples}n</Caption1>}
                    </td>
                    <td className={s.td}>{sig.refusalRate != null ? `${fmtNum(sig.refusalRate, 0)}%` : '—'}</td>
                    <td className={s.td}>{sig.errorRate != null ? `${(sig.errorRate * 100).toFixed(1)}%` : '—'}</td>
                    <td className={s.td}>{c?.composite != null ? c.composite.toFixed(2) : '—'}</td>
                    <td className={s.td}>{c ? actionBadge(c.action) : actionBadge('hold')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* per-candidate reasons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
          {d.candidates.filter((c) => c.action !== 'hold').map((c) => (
            <div key={c.key} className={s.chips}>
              {actionBadge(c.action)}
              <Text size={200} className={s.reason}>{c.reason}</Text>
            </div>
          ))}
          {d.candidates.every((c) => c.action === 'hold') && <Text className={s.sub}>{d.held ? `Held — ${d.heldReason}.` : 'All deployments within tolerance — no change.'}</Text>}
        </div>
      </div>
    );
  }

  function renderHistory() {
    const h = snap!.history || [];
    if (h.length === 0) return <Text className={s.sub}>No decisions recorded yet. Run the loop to record its first promote/demote decision.</Text>;
    return (
      <div>
        {h.slice(0, 25).map((e, i) => (
          <div key={i} className={s.historyRow}>
            {e.actuated ? <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} /> : e.changed ? <ArrowUp16Filled style={{ color: tokens.colorBrandForeground1 }} /> : <Pause16Regular style={{ color: tokens.colorNeutralForeground3 }} />}
            <Badge appearance="outline" color={e.kind === 'tier' ? 'brand' : 'informative'}>{e.kind}</Badge>
            <Text size={200} weight="semibold" className={s.ellipsis} style={{ width: '180px', minWidth: '100px' }}>{e.target}</Text>
            <Text size={200} className={mergeClasses(s.reason, s.ellipsis)} style={{ flex: '1 1 auto' }}>{e.summary}</Text>
            <Badge appearance="tint" color={e.mode === 'auto' ? 'success' : 'informative'}>{e.mode}</Badge>
            <Caption1 className={s.sub} style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.at)}</Caption1>
          </div>
        ))}
      </div>
    );
  }
}

export default ModelFabricPanel;
