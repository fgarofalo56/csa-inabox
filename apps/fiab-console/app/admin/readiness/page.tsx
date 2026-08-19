'use client';

/**
 * /admin/readiness — Readiness UX (WS-H): capability dependency graph (H1),
 * workload readiness scorecard (H2), and the ready-to-run tenant profile
 * export (H3).
 *
 * Everything on this surface is computed from REAL sources by GET
 * /api/admin/readiness (the gate-registry env-presence checks + the live
 * self-audit probes) — no fabricated status (no-vaporware.md). Selecting a
 * capability shows its exact backend dependencies, required env vars
 * (present/missing), RBAC role, provisioning bicep module, live probe status,
 * and — when blocked — the precise unmet prerequisites with a one-click Fix-it
 * wizard (the same shared GateFixitDialog the gate registry uses).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Card, Divider, MessageBar, MessageBarBody,
  MessageBarTitle, Spinner, Subtitle2, Title3, Tooltip,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, ArrowDownload16Regular, Wrench16Regular,
  CheckmarkCircle20Filled, Warning20Filled, DismissCircle20Filled, Circle20Regular,
  QuestionCircle20Regular,
  Flash16Regular, DatabaseLink20Regular, Key16Regular, Flowchart16Regular,
  Server16Regular, CloudArrowUp20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { GateFixitDialog } from '@/lib/components/shared/honest-gate';
import { clientFetch, CROSS_SUB_FETCH_TIMEOUT_MS } from '@/lib/client-fetch';
import { getGate } from '@/lib/gates/registry';
import {
  WORKLOADS,
  type CapabilityNode, type ReadinessReport, type ReadinessState, type WorkloadScore,
} from '@/lib/admin/readiness';
import type { DeployStatusReport } from '@/lib/admin/deploy-status';
import type { FleetEstate } from '@/lib/admin/estate-fleet';

// ── deploy status (2026-08-05) ───────────────────────────────────────────────
// The operator watched this page report 98/100 for two weeks while the two
// lanes that put code into the estate were red and merged bicep was inert.
// Nothing on this surface — or anywhere else — said "the estate is N commits
// behind" or "the last infra deploy failed", so every capability row was
// describing an estate nobody was updating.
//
// This banner is that missing fact, first thing on the page, above the score.
// It is deliberately NOT foldable into the readiness score: a capability being
// configured and the estate running the code that configures it are different
// claims, and averaging them is how the signal got lost in the first place.

/** Fluent intent per deploy severity. `ok` is informative, never green-on-nothing. */
const DEPLOY_INTENT = { ok: 'info', warning: 'warning', error: 'error' } as const;

/** Badge colour per drift state. `unknown` is its OWN colour, never a green. */
const DRIFT_COLOR = {
  current: 'success', behind: 'danger', divergent: 'danger', unknown: 'warning',
} as const;

/** The word shown on each estate's badge. */
const DRIFT_LABEL = {
  current: 'On main', behind: 'Behind', divergent: 'Divergent', unknown: 'Unmeasured',
} as const;

/**
 * Per-cloud drift table (#3730).
 *
 * WHY THIS IS A TABLE OF EVERY CLOUD AND NOT A LINE ABOUT THIS ONE. The banner
 * above it describes the estate serving the page, which is all it could ever
 * describe — and that is exactly how Azure Government sat 251 commits and seven
 * days behind main, at version 0.90.2 against Commercial's 0.98.11, while every
 * Commercial signal read green. `cloud-parity.md`: a view that structurally
 * cannot see the sovereign boundary is not a drift view, it is a Commercial
 * drift view.
 *
 * Each row states the four facts the operator had to curl for by hand: live
 * SHA, build stamp, running version, and commits behind main.
 *
 * AN UNMEASURED ESTATE IS ITS OWN STATE. A sovereign boundary usually has no
 * egress to the other cloud, so "we could not read it" is the COMMON row here,
 * not an edge case — and it renders as `Unmeasured` in warning, with the exact
 * reason. It is never drawn as `On main` (a green over an estate nobody read)
 * and never as `Behind` (a claim nobody measured). deploy-integrity.md R7.
 */
function EstateFleetTable({ estates, styles }: { estates: FleetEstate[] | null; styles: Styles }) {
  // ABSENT IS NOT EMPTY, and rendering nothing for both would recreate this
  // surface's founding defect one level up. `estates` is optional on the report
  // (an older CACHED payload predates #3730, and the route caches for 10 minutes
  // with serve-stale-on-error), so "no fleet was reported" and "there are no
  // other clouds" would otherwise look identical — a silent absence standing in
  // for a measurement, which is the whole thing this table exists to stop.
  if (!estates) {
    return (
      <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
        <MessageBarBody>
          <MessageBarTitle>Per-cloud drift not reported</MessageBarTitle>
          This response carried no per-estate data, so how far each cloud is behind main is UNKNOWN
          — not zero. A cached response from before this view existed looks exactly like this;
          refresh to re-measure.
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (estates.length === 0) return null;
  return (
    <Card className={styles.fleetCard}>
      <div className={styles.fleetHead}>
        <CloudArrowUp20Regular />
        <Subtitle2>Every cloud vs main</Subtitle2>
        <Caption1>live build of each estate, read from its own build marker</Caption1>
      </div>
      <div className={styles.fleetRows}>
        {estates.map((e) => (
          <div key={e.id} className={styles.fleetRow}>
            <div className={styles.fleetRowTop}>
              <Badge appearance="filled" color={DRIFT_COLOR[e.drift.state]} size="small">
                {DRIFT_LABEL[e.drift.state]}
              </Badge>
              <Body1 className={styles.fleetName}>{e.name}</Body1>
              {e.isSelf && <Badge appearance="tint" size="small">this console</Badge>}
              {e.version && <Badge appearance="outline" size="small">v{e.version}</Badge>}
              {/* commitsBehind is rendered ONLY when it was measured. A null
                  must never render as 0 — that is the arithmetic that turns an
                  unread estate into a healthy-looking one. */}
              {typeof e.drift.commitsBehind === 'number' && e.drift.commitsBehind > 0 && (
                <Badge appearance="filled" color="danger" size="small">
                  {e.drift.commitsBehind} behind
                </Badge>
              )}
            </div>
            <Caption1 className={styles.fleetMeta}>
              <code>{e.drift.buildSha ? e.drift.buildSha.slice(0, 8) : '—'}</code>
              {e.drift.buildStamp ? ` · built ${e.drift.buildStamp}` : ''}
              {e.source === 'remote-marker' ? ' · read over HTTPS from its own marker' : ' · read from this image'}
            </Caption1>
            <Caption1 className={styles.fleetDetail}>
              {e.reachable ? e.drift.detail : e.unreachableReason}
            </Caption1>
            {e.drift.compareUrl && e.drift.state === 'behind' && e.drift.commitsBehind ? (
              <a href={e.drift.compareUrl} target="_blank" rel="noreferrer">
                See the {e.drift.commitsBehind} commits this estate is missing
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

function DeployStatusBanner() {
  const [status, setStatus] = useState<DeployStatusReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const s = useStyles();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await clientFetch('/api/admin/deploy-status', undefined, CROSS_SUB_FETCH_TIMEOUT_MS);
        const j = await res.json();
        if (!alive) return;
        if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        setStatus(j as DeployStatusReport);
      } catch (e: any) {
        // The banner failing to load is itself reported — silence here would
        // recreate the exact blind spot this banner exists to close.
        if (alive) setFailed(e?.message || String(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  if (failed) {
    return (
      <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
        <MessageBarBody>
          <MessageBarTitle>Deploy status unavailable</MessageBarTitle>
          Could not determine whether this estate is running the latest code — {failed}. Everything below
          describes the capabilities of an estate whose freshness is UNKNOWN, not confirmed current.
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!status) return null;

  const problems = status.paths.filter((p) => p.severity !== 'ok');
  const estates = (status.estates as FleetEstate[] | undefined) ?? null;
  return (
    <>
      <MessageBar
        intent={DEPLOY_INTENT[status.severity]}
        layout="multiline"
        style={{ marginBottom: tokens.spacingVerticalM }}
      >
        <MessageBarBody>
          <MessageBarTitle>{status.headline}</MessageBarTitle>
          {status.estate.detail}
          {status.estate.compareUrl && status.estate.state === 'behind' && status.estate.commitsBehind ? (
            <> <a href={status.estate.compareUrl} target="_blank" rel="noreferrer">See the {status.estate.commitsBehind} commits</a>.</>
          ) : null}
          {problems.length > 0 && (
            <div style={{ marginTop: tokens.spacingVerticalS }}>
              <Button appearance="transparent" size="small" onClick={() => setOpen((v) => !v)}>
                {open ? 'Hide' : `Show ${problems.length} deploy path(s) needing attention`}
              </Button>
              {open && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS }}>
                  {problems.map((p) => (
                    <div key={p.workflow} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 }}>
                        <Badge appearance="filled" size="small" color={p.severity === 'error' ? 'danger' : 'warning'}>
                          {p.state}
                        </Badge>
                        <Body1 style={{ minWidth: 0 }}>{p.title}</Body1>
                      </div>
                      <Caption1>{p.detail}</Caption1>
                      <Caption1>{p.why}</Caption1>
                      <a href={p.runsUrl} target="_blank" rel="noreferrer">Open {p.workflow} in Actions</a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </MessageBarBody>
      </MessageBar>
      {/* Deliberately OUTSIDE the MessageBar and always shown: the per-cloud
          table is the fact the operator was missing, and folding it into a
          collapsed section of a banner would reproduce the "buried where nobody
          reads it" failure this whole change exists to fix. */}
      <EstateFleetTable estates={estates} styles={s} />
    </>
  );
}

// ── state visuals ────────────────────────────────────────────────────────────

const STATE_COLOR: Record<ReadinessState, 'success' | 'warning' | 'danger' | 'informative'> = {
  ready: 'success', partial: 'warning', blocked: 'danger', 'opt-in': 'informative', unknown: 'informative',
};
const STATE_LABEL: Record<ReadinessState, string> = {
  ready: 'Ready', partial: 'Partial', blocked: 'Blocked', 'opt-in': 'Opt-in', unknown: 'Not established',
};

function StateIcon({ state }: { state: ReadinessState }) {
  if (state === 'ready') return <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
  if (state === 'partial') return <Warning20Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  // Opt-in: an additive feature deliberately not deployed — neutral, not an error.
  if (state === 'opt-in') return <Circle20Regular style={{ color: tokens.colorNeutralForeground3 }} />;
  // Not established: the live probe did not finish, so nothing is known either
  // way. Neutral by design — a non-observation must never read as a failure.
  if (state === 'unknown') return <QuestionCircle20Regular style={{ color: tokens.colorNeutralForeground3 }} />;
  return <DismissCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
}

const ACCENT: Record<ReadinessState, string> = {
  ready: tokens.colorPaletteGreenBackground3,
  partial: tokens.colorPaletteYellowBackground3,
  blocked: tokens.colorPaletteRedBackground3,
  'opt-in': tokens.colorNeutralStroke1,
  unknown: tokens.colorNeutralStroke1,
};

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL,
  },
  spacer: { flexGrow: 1 },
  summary: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center',
    gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalL,
  },
  scoreChip: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  countRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalXL, marginBottom: tokens.spacingVerticalM,
  },
  grid: {
    display: 'grid', gap: tokens.spacingHorizontalL, width: '100%',
    // min(260px, 100%) so a single column never forces horizontal overflow on a
    // narrow pane; minmax(260px,…) alone clips below 260px. (web3-ui.md: minmax(0,…))
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))',
    marginBottom: tokens.spacingVerticalL,
  },
  wlCard: {
    padding: tokens.spacingHorizontalL, minWidth: 0,
    cursor: 'pointer', transition: 'box-shadow 120ms ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  wlCardActive: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-1px' },
  wlHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  wlGlyph: { fontSize: '22px', lineHeight: 1 },
  wlTitle: { flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  wlDesc: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS, minHeight: '32px' },
  wlCounts: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    marginTop: tokens.spacingVerticalS, minWidth: 0,
  },
  wlScoreBar: {
    height: '6px', borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground5, overflow: 'hidden',
    marginTop: tokens.spacingVerticalS,
  },
  graphShell: {
    // Responsive height (was a hard 560px that clipped ~68 orphan nodes into a
    // fixed scroller). Grows with the viewport; the SplitPane inside is still
    // user-resizable + persisted. #2754.
    height: 'clamp(560px, 72vh, 960px)',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  graphPane: {
    height: '100%', overflowY: 'auto', padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL,
  },
  wlGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  wlGroupHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  nodeWrap: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  node: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    // Was a FIXED 184px that truncated long titles to "Federated SQL en…". Now a
    // bounded flex box so a 2-line title fits without a tooltip (#2754); the max
    // keeps the wrap grid tidy, minWidth:0 lets it shrink before clipping.
    flex: '1 1 190px', minWidth: '170px', maxWidth: '250px', boxSizing: 'border-box',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeftWidth: '3px',
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer', transition: 'box-shadow 120ms ease, background-color 120ms ease',
    ':hover': { boxShadow: tokens.shadow8, backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  nodeActive: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-1px' },
  nodeTop: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  nodeDot: { flexShrink: 0, width: '8px', height: '8px', borderRadius: tokens.borderRadiusCircular, marginTop: '5px' },
  nodeName: {
    // Two-line clamp (was whiteSpace:'nowrap' + ellipsis → unreadable truncation).
    flexGrow: 1, minWidth: 0, fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase200,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  nodeSub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  // inspector
  inspector: {
    // minWidth:0 lets the pane shrink instead of forcing its content wider than
    // graphShell (overflow:hidden), which clipped the right side unreachably.
    // overflowWrap:anywhere breaks unbroken strings (a 68-char bicep path in
    // `provisionedBy`, a 37-char env var) so nothing extends past the pane.
    height: '100%', minWidth: 0, overflowY: 'auto', overflowX: 'hidden',
    overflowWrap: 'anywhere', wordBreak: 'break-word',
    padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  inspectorHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  depBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  depLabel: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground2 },
  // A 448-char monospace bicep path (svc-ducklake-catalog, the longest in the
  // registry) rendered as one unbroken run and overflowed. Wrap it and cap the
  // font so it reads as a path, not a wall.
  depMono: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
  },
  // Body text (role, backends) can also be multi-hundred chars — wrap, don't clip.
  depBody: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  // A single env-var Badge can be wider than the pane; Fluent Badge does not
  // truncate, so flexWrap on the row cannot rescue one over-wide child. Cap it
  // and ellipsize; the full value stays available via title.
  envBadge: {
    maxWidth: '100%', minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0, maxWidth: '100%' },
  loading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: tokens.spacingVerticalXXL },
  // ── per-cloud drift table (#3730) ──────────────────────────────────────
  // Card elevation + borderRadiusLarge + a section icon, matching the sibling
  // polished surfaces (web3-ui.md). Spacing, colour, radius and shadow all come
  // from tokens; the ONE raw value is the 3px accent rule below, which Fluent
  // ships no token for and which matches four sibling surfaces (readiness's own
  // `node`, and the canvas node-kit accent). Called out rather than claimed
  // away: `check-no-raw-px` scans inline `style={{}}` only and never reads this
  // makeStyles block, so it was never evidence either way.
  fleetCard: {
    padding: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalM,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minWidth: 0,
    boxShadow: tokens.shadow4,
    borderRadius: tokens.borderRadiusLarge,
    transition: 'box-shadow 120ms ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  fleetHead: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS, minWidth: 0,
  },
  fleetRows: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  fleetRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    minWidth: 0,
    paddingLeft: tokens.spacingHorizontalM,
    // Light 3px accent rather than a heavy band (ux-baseline node compactness).
    borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
  },
  // flexWrap + minWidth:0 so the badge row can never overlap at any width
  // (ux-baseline: "badges never overlap" — overlap at any width is a defect).
  fleetRowTop: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS, minWidth: 0,
  },
  fleetName: { minWidth: 0, overflowWrap: 'anywhere' },
  fleetMeta: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', minWidth: 0 },
  fleetDetail: { color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere', minWidth: 0 },
});

interface WorkloadGroup { key: string; title: string; glyph: string; nodes: CapabilityNode[]; state?: ReadinessState; }

export default function AdminReadinessPage() {
  const s = useStyles();
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workloadFilter, setWorkloadFilter] = useState<string | null>(null);
  const [fixGateId, setFixGateId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  /**
   * `refresh` re-runs every live probe instead of reading the 30 s probe cache.
   *
   * The Refresh button used to hit the route with no cache-buster, so clicking
   * it inside the TTL replayed the SAME probe results. #3729 was "reproduced
   * twice" that way: one measurement, read twice, presented as confirmation.
   */
  const reload = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch(
        `/api/admin/readiness${refresh ? '?refresh=1' : ''}`,
        undefined,
        CROSS_SUB_FETCH_TIMEOUT_MS,
      );
      const j = await r.json().catch(() => null);
      if (j?.ok) {
        setReport(j as ReadinessReport);
        setProbeError(j.probeError || null);
      } else {
        setError(j?.error || j?.remediation || `load failed (${r.status})`);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const nodeById = useMemo(
    () => new Map((report?.capabilities || []).map((n) => [n.id, n])),
    [report],
  );

  // Group capabilities by workload; unassigned gates land in "Other capabilities".
  const groups = useMemo<WorkloadGroup[]>(() => {
    if (!report) return [];
    const wlById = new Map(report.workloads.map((w) => [w.id, w]));
    const assigned = new Set<string>();
    const out: WorkloadGroup[] = [];
    for (const def of WORKLOADS) {
      const wl = wlById.get(def.id);
      // A capability may belong to >1 workload (e.g. svc-synapse in both Data
      // Integration and Data Engineering) — shown under EACH so the per-workload
      // filter is complete. Node cards use a workload-scoped React key so the
      // duplicates never collide.
      const nodes = def.capabilityIds.map((id) => nodeById.get(id)).filter((n): n is CapabilityNode => !!n);
      nodes.forEach((n) => assigned.add(n.id));
      out.push({ key: def.id, title: def.title, glyph: def.glyph, nodes, state: wl?.state });
    }
    const other = (report.capabilities || []).filter((n) => !assigned.has(n.id));
    if (other.length) out.push({ key: '__other', title: 'Other capabilities', glyph: '🧷', nodes: other });
    return out;
  }, [report, nodeById]);

  const visibleGroups = useMemo(
    () => (workloadFilter ? groups.filter((g) => g.key === workloadFilter) : groups),
    [groups, workloadFilter],
  );

  // Default selection: first blocked capability, else the first whose live check
  // did not complete, else the first capability.
  useEffect(() => {
    if (!report || selectedId) return;
    const first = report.capabilities.find((n) => n.state === 'blocked')
      || report.capabilities.find((n) => n.state === 'unknown');
    setSelectedId(first?.id || report.capabilities[0]?.id || null);
  }, [report, selectedId]);

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const fixGate = fixGateId ? getGate(fixGateId) : undefined;
  // The live capability node behind the Fix-it — so the dialog can tell an
  // "env values are missing" gate (its form IS the fix) apart from a gate whose
  // env is complete and whose only blocker is a live probe (#3729).
  const fixNode = fixGateId ? nodeById.get(fixGateId) : undefined;

  const download = useCallback(async (format: 'json' | 'md') => {
    setDownloading(true);
    try {
      const r = await clientFetch(`/api/admin/readiness/export?format=${format}`, undefined, CROSS_SUB_FETCH_TIMEOUT_MS);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-readiness-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setDownloading(false);
    }
  }, []);

  return (
    <AdminShell
      sectionTitle="Readiness"
      learn={{
        title: 'Readiness — capability graph + workload scorecard',
        content:
          'A live go/no-go view of the deployment. The workload scorecard rolls up every capability into named workloads (Data Integration, Real-Time Intelligence, Governance, AI & Copilot, …) with a Ready / Partial / Blocked verdict computed only from real gate + probe state. The capability dependency graph shows, per capability, its backend surfaces, required env vars, RBAC role, provisioning bicep module, and live probe status — and the exact unmet prerequisites with a one-click Fix it. Export the whole posture as a ready-to-run tenant profile (JSON or a readable report).',
        tips: [
          'Ready = configured and (where a live probe exists) probe-verified; config-only means env-verified but not exercised end-to-end.',
          'A blocked critical capability makes its whole workload no-go.',
          'Fix it discovers real Azure resources and applies through the audited env-config write path.',
          'Export the tenant profile to share readiness posture across teams.',
        ],
      }}
    >
      {/* FIRST, above the score: is this estate even running the code the score
          is describing? Two weeks of an unchanged 98/100 over a dead deploy
          path is what this answers. */}
      <DeployStatusBanner />
      {error && (
        <MessageBar intent="error" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Could not load readiness</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {probeError && (
        <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>Live probes unavailable — showing config-only readiness</MessageBarTitle>
            {probeError}. Capability state falls back to env-presence (configured/blocked); backends were not live-probed this run.
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !report ? (
        <div className={s.loading}><Spinner size="small" /><Caption1>Evaluating capabilities + probing backends…</Caption1></div>
      ) : !report ? (
        <EmptyState
          icon={<DatabaseLink20Regular />}
          title="No readiness data"
          body="The readiness evaluation returned nothing. Refresh to re-run the gate + probe evaluation."
          primaryAction={{ label: 'Refresh', onClick: () => void reload(true) }}
        />
      ) : (
        <>
          <div className={s.summary}>
            <div className={s.scoreChip}>
              <Flash16Regular />
              <Subtitle2>{report.summary.score}/100</Subtitle2>
              <Caption1>overall readiness</Caption1>
            </div>
            <div className={s.countRow}>
              <CheckmarkCircle20Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />
              <Subtitle2>{report.summary.capabilities.ready}</Subtitle2><Caption1>ready</Caption1>
            </div>
            <div className={s.countRow}>
              <Warning20Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />
              <Subtitle2>{report.summary.capabilities.partial}</Subtitle2><Caption1>partial</Caption1>
            </div>
            <div className={s.countRow}>
              <DismissCircle20Filled style={{ color: tokens.colorPaletteRedForeground1 }} />
              <Subtitle2>{report.summary.capabilities.blocked}</Subtitle2><Caption1>blocked</Caption1>
            </div>
            {report.summary.capabilities.unknown > 0 && (
              <div className={s.countRow}>
                <QuestionCircle20Regular style={{ color: tokens.colorNeutralForeground3 }} />
                <Subtitle2>{report.summary.capabilities.unknown}</Subtitle2><Caption1>not established</Caption1>
              </div>
            )}
            <Caption1>
              {report.summary.workloads.ready}/{report.summary.workloads.total} workloads ready
              {report.summary.configOnly ? ` · ${report.summary.configOnly} config-only` : ''}
            </Caption1>
            <div className={s.spacer} />
            <Tooltip content="Re-runs every live probe (bypasses the 30s probe cache)" relationship="description">
              <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={() => void reload(true)}>Re-check now</Button>
            </Tooltip>
            <Button size="small" appearance="secondary" icon={<ArrowDownload16Regular />} disabled={downloading} onClick={() => download('md')}>Export report</Button>
            <Button size="small" appearance="secondary" icon={<ArrowDownload16Regular />} disabled={downloading} onClick={() => download('json')}>Export JSON</Button>
          </div>

          {/* H2 — workload scorecard */}
          <div className={s.sectionHead}>
            <Server16Regular />
            <Title3>Workload readiness</Title3>
            {workloadFilter && (
              <Button size="small" appearance="transparent" onClick={() => setWorkloadFilter(null)}>Clear filter</Button>
            )}
          </div>
          <div className={s.grid}>
            {report.workloads.map((w) => (
              <WorkloadCard
                key={w.id}
                w={w}
                active={workloadFilter === w.id}
                onClick={() => setWorkloadFilter(workloadFilter === w.id ? null : w.id)}
                styles={s}
              />
            ))}
          </div>

          {/* H1 — capability dependency graph */}
          <div className={s.sectionHead}>
            <Flowchart16Regular />
            <Title3>Capability dependency graph</Title3>
            <Caption1>{workloadFilter ? `filtered to ${WORKLOADS.find((x) => x.id === workloadFilter)?.title || workloadFilter}` : 'every capability, grouped by workload'}</Caption1>
          </div>
          <div className={s.graphShell}>
            <SplitPane
              direction="horizontal"
              primary="second"
              defaultSize="38%"
              minSize={280}
              storageKey="admin-readiness-graph"
              dividerLabel="Resize capability inspector"
            >
              <div className={s.graphPane}>
                {visibleGroups.map((g) => (
                  <div key={g.key} className={s.wlGroup}>
                    <div className={s.wlGroupHead}>
                      <span className={s.wlGlyph} aria-hidden>{g.glyph}</span>
                      <Subtitle2>{g.title}</Subtitle2>
                      {g.state && <Badge appearance="tint" color={STATE_COLOR[g.state]} size="small">{STATE_LABEL[g.state]}</Badge>}
                      <Caption1>{g.nodes.length} capabilit{g.nodes.length === 1 ? 'y' : 'ies'}</Caption1>
                    </div>
                    <div className={s.nodeWrap}>
                      {g.nodes.map((n) => (
                        <CapabilityNodeCard
                          key={`${g.key}:${n.id}`}
                          n={n}
                          active={selectedId === n.id}
                          onClick={() => setSelectedId(n.id)}
                          styles={s}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className={s.inspector}>
                {selected ? (
                  <CapabilityInspector node={selected} styles={s} onFix={() => setFixGateId(selected.id)} />
                ) : (
                  <Caption1>Select a capability to see its dependency chain.</Caption1>
                )}
              </div>
            </SplitPane>
          </div>
        </>
      )}

      {fixGate && (
        <GateFixitDialog
          gate={fixGate}
          open={!!fixGateId}
          probe={fixNode?.probe ?? null}
          capabilityState={fixNode?.state}
          onClose={() => setFixGateId(null)}
          onRecheck={() => void reload(true)}
          onResolved={() => { setFixGateId(null); void reload(true); }}
        />
      )}
    </AdminShell>
  );
}

type Styles = ReturnType<typeof useStyles>;

function WorkloadCard({ w, active, onClick, styles }: { w: WorkloadScore; active: boolean; onClick: () => void; styles: Styles }) {
  const pct = w.summary.total ? Math.round((w.summary.ready / w.summary.total) * 100) : 0;
  return (
    <Card
      className={mergeClasses(styles.wlCard, active && styles.wlCardActive)}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div className={styles.wlHead}>
        <span className={styles.wlGlyph} aria-hidden>{w.glyph}</span>
        <Subtitle2 className={styles.wlTitle}>{w.title}</Subtitle2>
        <Badge appearance="filled" color={STATE_COLOR[w.state]} size="small">{STATE_LABEL[w.state]}</Badge>
      </div>
      <Caption1 className={styles.wlDesc}>{w.description}</Caption1>
      <div className={styles.wlCounts}>
        <Badge appearance="tint" color="success" size="small">{w.summary.ready} ready</Badge>
        {w.summary.partial > 0 && <Badge appearance="tint" color="warning" size="small">{w.summary.partial} partial</Badge>}
        {w.summary.blocked > 0 && <Badge appearance="tint" color="danger" size="small">{w.summary.blocked} blocked</Badge>}
        <Badge appearance="outline" size="small">score {w.score}</Badge>
      </div>
      <div className={styles.wlScoreBar}>
        <div style={{ width: `${pct}%`, height: '100%', backgroundColor: ACCENT[w.state] }} />
      </div>
    </Card>
  );
}

function CapabilityNodeCard({ n, active, onClick, styles }: { n: CapabilityNode; active: boolean; onClick: () => void; styles: Styles }) {
  const badgeText = n.state === 'blocked'
    ? (n.missing.length ? `${n.missing.length} missing` : 'blocked')
    : n.state === 'partial' ? 'partial'
      : n.state === 'opt-in' ? 'opt-in'
        : n.verified === 'live-probe' ? 'live' : 'config';
  const badgeColor = STATE_COLOR[n.state];
  return (
    <Tooltip content={n.title} relationship="label">
      <div
        className={mergeClasses(styles.node, active && styles.nodeActive)}
        style={{ borderLeftColor: ACCENT[n.state] }}
        onClick={onClick}
        role="button"
        tabIndex={0}
        aria-label={`${n.title} — ${STATE_LABEL[n.state]}`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      >
        <div className={styles.nodeTop}>
          <span className={styles.nodeDot} style={{ backgroundColor: ACCENT[n.state] }} aria-hidden />
          <span className={styles.nodeName}>{n.title}</span>
        </div>
        <div className={styles.nodeSub}>
          <Badge appearance="tint" color={badgeColor} size="extra-small">{badgeText}</Badge>
        </div>
      </div>
    </Tooltip>
  );
}

function CapabilityInspector({ node, styles, onFix }: { node: CapabilityNode; styles: Styles; onFix: () => void }) {
  return (
    <>
      <div className={styles.inspectorHead}>
        <StateIcon state={node.state} />
        <Subtitle2>{node.title}</Subtitle2>
        <Badge appearance="tint" color={STATE_COLOR[node.state]} size="small">{STATE_LABEL[node.state]}</Badge>
        <Badge appearance="outline" size="small">{node.verified === 'live-probe' ? 'live-probed' : 'config-only'}</Badge>
      </div>
      <Caption1><code>{node.id}</code> · {node.category} · {node.severity}</Caption1>

      {node.state === 'opt-in' && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Opt-in — not deployed</MessageBarTitle>
            This is an additive feature that is off by default; its absence removes no capability
            (the default path is fully functional). Deploy it only if you want it.
            {node.remediation ? ` ${node.remediation}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {node.state === 'unknown' && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Not established — the live check did not complete</MessageBarTitle>
            Nothing was observed either way: this is NOT a finding that the backend is broken,
            and NOT a claim that it works. {node.remediation}
          </MessageBarBody>
        </MessageBar>
      )}

      {node.state !== 'ready' && node.state !== 'opt-in' && node.state !== 'unknown' && (
        <MessageBar intent={node.state === 'blocked' ? 'error' : 'warning'} layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>{node.state === 'blocked' ? 'Unmet prerequisites' : 'Degraded'}</MessageBarTitle>
            {node.missing.length ? `Missing: ${node.missing.join(', ')}. ` : ''}{node.remediation}
          </MessageBarBody>
        </MessageBar>
      )}

      {(node.state === 'blocked' || node.state === 'partial' || node.state === 'unknown') && (
        <div>
          <Button appearance="primary" size="small" icon={<Wrench16Regular />} onClick={onFix}>
            {node.state === 'unknown' ? 'Re-check' : 'Fix it'}
          </Button>
        </div>
      )}

      {node.state === 'opt-in' && (
        <div>
          <Button appearance="secondary" size="small" icon={<Wrench16Regular />} onClick={onFix}>Deploy this (opt-in)</Button>
        </div>
      )}

      <Divider />

      <div className={styles.depBlock}>
        <Caption1 className={styles.depLabel}><Server16Regular /> Backend surfaces</Caption1>
        {node.backends.length ? (
          <Body1 className={styles.depBody}>{node.backends.join(' · ')}</Body1>
        ) : <Caption1>—</Caption1>}
      </div>

      <div className={styles.depBlock}>
        <Caption1 className={styles.depLabel}><Key16Regular /> Required configuration</Caption1>
        {node.requiredEnv.length ? (
          <div className={styles.badgeRow}>
            {node.requiredEnv.map((e) => (
              <Badge
                key={e.envVar}
                appearance={e.present ? 'outline' : 'filled'}
                color={e.present ? 'success' : 'warning'}
                size="small"
                className={styles.envBadge}
                title={`${e.envVar}${e.required ? '' : ' (any-of)'}`}
              >
                {e.envVar}{e.required ? '' : ' (any-of)'}
              </Badge>
            ))}
          </div>
        ) : <Caption1>No env configuration required.</Caption1>}
      </div>

      {node.role && (
        <div className={styles.depBlock}>
          <Caption1 className={styles.depLabel}><Key16Regular /> RBAC role</Caption1>
          <Body1 className={styles.depBody}>{node.role}</Body1>
        </div>
      )}

      {node.provisionedBy && (
        <div className={styles.depBlock}>
          <Caption1 className={styles.depLabel}><Flowchart16Regular /> Provisioned by</Caption1>
          <span className={styles.depMono}>{node.provisionedBy}</span>
        </div>
      )}

      <div className={styles.depBlock}>
        <Caption1 className={styles.depLabel}><Flash16Regular /> Live probe</Caption1>
        {node.probe ? (
          <Body1>
            <Badge
              appearance="tint"
              color={node.probe.status === 'pass' ? 'success' : node.probe.inconclusive ? 'informative' : node.probe.status === 'warn' ? 'warning' : 'danger'}
              size="small"
            >
              {node.probe.status === 'pass' ? 'pass' : node.probe.inconclusive ? 'did not complete' : node.probe.status}
            </Badge>{' '}{node.probe.detail}
          </Body1>
        ) : (
          <Caption1>No live probe for this capability — status reflects configuration presence only.</Caption1>
        )}
      </div>

      {node.canAutoResolve && (
        <Caption1>Auto-resolved by a push-button deploy — zero operator input needed.</Caption1>
      )}
    </>
  );
}
