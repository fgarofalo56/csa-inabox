'use client';

/**
 * Loom Setup Wizard — PRP-04 (redesigned multi-step wizard)
 *
 * Conversational deployment of additional Data Landing Zones after
 * the Admin Plane is installed.
 *
 * State machine:
 *   intro → boundary → mode → subscription → domain → capacity → review → deploying → done
 *
 * UI shape (Web 3.0 / Fluent v9 + Loom tokens):
 *   - A left STEP RAIL shows numbered steps, current/complete/upcoming state,
 *     and lets the operator jump back to any already-completed step.
 *   - The right CONTENT PANEL is a spaced card per step: a clear heading, a
 *     readable description, Field-wrapped controls (never smushed), and a
 *     Back / Next footer. Boundary + mode are selectable option cards; the
 *     capacity step previews the real Azure-native services the F-SKU
 *     equivalence provisions, each rendered with itemVisual() icon + color.
 *
 * Real data wiring (unchanged):
 *   - The `subscription` step lists the operator's real Azure subscriptions
 *     via GET /api/setup/subscriptions (ARM `GET /subscriptions`) and threads
 *     the chosen subscriptionId into the deploy POST + the bicep preview.
 *   - Deploy POSTs to /api/setup/deploy, which validates the config and
 *     returns an honest 503 + copy-paste `az deployment sub create` when the
 *     Setup Orchestrator isn't deployed. No fake progress, no mocks.
 *
 * Tier dispatch:
 *   Commercial/GCC → Foundry Agent Service backend
 *   GCC-High/IL5  → MAF + AOAI direct backend
 *   Both tiers share THIS UI; only the /api/setup endpoint differs.
 */

import * as React from 'react';
import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Title2,
  Subtitle2,
  Body1,
  Body1Strong,
  Caption1,
  makeStyles,
  tokens,
  Button,
  Input,
  Dropdown,
  Option,
  Field,
  Badge,
  Divider,
  ProgressBar,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Link,
  mergeClasses,
} from '@fluentui/react-components';
import {
  Send24Regular,
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  ArrowRight20Regular,
  Checkmark16Filled,
  Globe24Regular,
  Building24Regular,
  ShieldCheckmark24Regular,
  Shield24Regular,
  Branch24Regular,
  SquareMultiple24Regular,
  CheckmarkCircle48Filled,
  ErrorCircle48Filled,
  Rocket24Regular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

type Boundary = 'Commercial' | 'GCC' | 'GCC-High' | 'IL5';
type Mode = 'single-sub' | 'multi-sub';

type Step =
  | 'intro'
  | 'boundary'
  | 'mode'
  | 'multi-sub-choice'  // New: only shown when mode='multi-sub' — branch to wire-new vs wire-existing
  | 'subscription'
  | 'domain'
  | 'capacity'
  | 'review'
  | 'deploying'
  | 'done';

interface AzureSubscription {
  subscriptionId: string;
  displayName: string;
  state: string;
  tenantId?: string;
}

interface WizardState {
  step: Step;
  boundary?: Boundary;
  mode?: Mode;
  subscriptionId?: string;
  subscriptionName?: string;
  location?: string;
  domainName?: string;
  capacitySku?: string;
  /** Optional vanity console URL (e.g. csa-loom.contoso.ai). Empty = generated Front Door host. */
  vanityDomain?: string;
  /** Multi-sub mode only: the deployment sub in which the DLZ lands (distinct from admin-plane sub) */
  dlzSubscriptionId?: string;
  dlzSubscriptionName?: string;
  /** Multi-sub Route A (wire new) vs Route B (wire existing) */
  multiSubMode?: 'wire-new' | 'wire-existing';
  /** Multi-sub Route B: list of existing DLZs discovered in the tenant (loaded async) */
  existingDlzs?: Array<{ subscriptionId: string; subscriptionName: string; domainName: string; rg: string }>;
  /** Multi-sub Route B: which existing DLZ(s) to wire into admin plane (checked state) */
  selectedExistingDlzs?: Array<{ subscriptionId: string; domainName: string }>;
  deployProgress?: number;
  deployStage?: string;
  deployError?: string;
  deploymentId?: string;
  /** GitHub-workflow-dispatch streaming: the workflow file + dispatch time we poll against. */
  workflowFile?: string;
  dispatchedAt?: string;
  /** Live run status streamed from /api/setup/workflow-run-status. */
  runStatus?: 'pending' | 'queued' | 'in_progress' | 'completed' | 'not_found';
  runConclusion?: string | null;
  runUrl?: string;
}

const REGIONS_COMMERCIAL = ['eastus2', 'eastus', 'westus2', 'westus3', 'centralus', 'westeurope', 'northeurope'];
const REGIONS_GOV = ['usgovvirginia', 'usgovtexas', 'usgovarizona'];

/** The ordered, user-facing steps shown in the rail (intro/deploying/done are transient). */
/** Note: 'multi-sub-choice' is inserted dynamically after 'mode' when mode='multi-sub'. */
const RAIL_STEPS: { key: Step; label: string; hint: string }[] = [
  { key: 'boundary', label: 'Cloud boundary', hint: 'Where Loom runs' },
  { key: 'mode', label: 'Deployment mode', hint: 'Single or multi-sub' },
  { key: 'subscription', label: 'Subscription & region', hint: 'Deploy target' },
  { key: 'domain', label: 'Domain name', hint: 'Landing-zone name' },
  { key: 'capacity', label: 'Capacity sizing', hint: 'Compute equivalence' },
  { key: 'review', label: 'Review & deploy', hint: 'Confirm and launch' },
];

const STEP_ORDER: Step[] = RAIL_STEPS.map((s) => s.key);

/** Boundary option cards. */
const BOUNDARY_OPTIONS: { value: Boundary; title: string; desc: string; icon: FluentIcon; gov: boolean }[] = [
  { value: 'Commercial', title: 'Commercial', desc: 'Azure Public cloud', icon: Globe24Regular, gov: false },
  { value: 'GCC', title: 'GCC', desc: 'M365 GCC identity over Azure Public', icon: Building24Regular, gov: false },
  { value: 'GCC-High', title: 'GCC-High / IL4', desc: 'Azure Government', icon: ShieldCheckmark24Regular, gov: true },
  { value: 'IL5', title: 'DoD IL5', desc: 'Azure Government', icon: Shield24Regular, gov: true },
];

/** Mode option cards. */
const MODE_OPTIONS: { value: Mode; title: string; desc: string; icon: FluentIcon; tag?: string }[] = [
  {
    value: 'single-sub',
    title: 'Single subscription',
    desc: 'The new DLZ lands in the same subscription as the Admin Plane. Simplest to operate.',
    icon: SquareMultiple24Regular,
  },
  {
    value: 'multi-sub',
    title: 'Multi-subscription',
    desc: 'Each DLZ gets its own subscription. Recommended for federal multi-tenant isolation.',
    icon: Branch24Regular,
    tag: 'Recommended',
  },
];

/** Capacity F-SKU equivalence rows — the Azure-native services each one provisions. */
const CAPACITY_OPTIONS: { sku: string; note: string; tag?: string }[] = [
  { sku: 'F2', note: 'Smallest — dev / sandbox' },
  { sku: 'F4', note: 'Light shared workloads' },
  { sku: 'F8', note: 'Recommended for a prod start', tag: 'Recommended' },
  { sku: 'F32', note: 'Department-scale analytics' },
  { sku: 'F64', note: 'Heavy concurrent BI + ML' },
  { sku: 'F128', note: 'Enterprise multi-team' },
  { sku: 'F512', note: 'Largest — mission-scale' },
];

/** The Azure-native services the F-SKU equivalence maps onto (visualised on the capacity step). */
const CAPACITY_SERVICES: { type: string; label: string }[] = [
  { type: 'databricks-cluster', label: 'Databricks' },
  { type: 'kql-database', label: 'ADX (Kusto)' },
  { type: 'synapse-spark-pool', label: 'Synapse Spark' },
];

/** Map the streamed GitHub run status → a Fluent Badge color + human label. */
function runStatusDisplay(s: WizardState): {
  label: string;
  color: 'informative' | 'success' | 'danger' | 'warning';
  spinning: boolean;
  done: boolean;
} {
  if (s.runStatus === 'completed') {
    const ok = s.runConclusion === 'success';
    return {
      label: ok ? 'Succeeded' : `Finished (${s.runConclusion ?? 'unknown'})`,
      color: ok ? 'success' : 'danger',
      spinning: false,
      done: true,
    };
  }
  if (s.runStatus === 'in_progress') return { label: 'Running', color: 'informative', spinning: true, done: false };
  if (s.runStatus === 'queued') return { label: 'Queued', color: 'informative', spinning: true, done: false };
  // pending / not_found → run row not visible yet
  return { label: 'Starting…', color: 'warning', spinning: true, done: false };
}

function renderBicepParam(s: WizardState): string {
  const isGov = s.boundary === 'GCC-High' || s.boundary === 'IL5';
  const isSingleSub = s.mode === 'single-sub';
  const defaultLocation = isGov ? 'usgovvirginia' : 'eastus2';
  
  const deploymentModeComment = isSingleSub
    ? `// Single-sub: Admin Plane + DLZ + all 21 deploy-planner services in ONE subscription`
    : `// Multi-sub: Admin Plane in hub (${s.subscriptionName}), DLZ in spoke (${s.dlzSubscriptionName ?? '?'})`;
  
  const dlzLines = isSingleSub
    ? [`param dlzDomainNames    = ['${s.domainName ?? ''}']`]
    : [
        `// Multi-sub mode: DLZ lands in ${s.dlzSubscriptionId}`,
        `param dlzDomainNames    = ['${s.domainName ?? ''}']`,
        `param dlzSubscriptionIds = ['${s.dlzSubscriptionId ?? ''}']`,
      ];
  
  return [
    `// Generated by Loom Setup Wizard`,
    `// Admin Plane Subscription: ${s.subscriptionName ?? '?'} (${s.subscriptionId ?? '?'})`,
    ...(isSingleSub ? [] : [`// DLZ Subscription:       ${s.dlzSubscriptionName ?? '?'} (${s.dlzSubscriptionId ?? '?'})`]),
    `// Region:                ${s.location ?? defaultLocation}`,
    `// Boundary:              ${s.boundary ?? '?'}`,
    `// Mode:                  ${s.mode ?? '?'}`,
    `// Domain:                ${s.domainName ?? '?'}`,
    `// Capacity:              ${s.capacitySku ?? '?'}`,
    ``,
    deploymentModeComment,
    `using '../main.bicep'`,
    ``,
    `param environment       = '${isGov ? 'AzureUSGovernment' : 'AzureCloud'}'`,
    `param boundary          = '${s.boundary ?? ''}'`,
    `param deploymentMode    = '${s.mode ?? ''}'`,
    `param containerPlatform = '${isGov ? 'aks' : 'containerApps'}'`,
    `param capacitySku       = '${s.capacitySku ?? ''}'`,
    ...dlzLines,
    `// ... boundary-defaulted parameters omitted for brevity`,
    ``,
    `// Deploy target (passed to: az deployment sub create):`,
    `//   --subscription ${s.subscriptionId ?? '<select a subscription>'} ${isSingleSub ? '' : '(admin/hub)'}`,
    `//   -l ${s.location ?? defaultLocation}`,
  ].join('\n');
}

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: '260px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalXXL,
    alignItems: 'start',
    maxWidth: '1100px',
  },
  // ── step rail ────────────────────────────────────────────────────────────
  rail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    position: 'sticky',
    top: tokens.spacingVerticalL,
  },
  railHead: {
    marginBottom: tokens.spacingVerticalM,
  },
  railProgress: {
    marginTop: tokens.spacingVerticalS,
  },
  railItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid transparent`,
    textAlign: 'left',
    background: 'none',
    cursor: 'default',
    width: '100%',
  },
  railItemClickable: {
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  railItemActive: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow2,
  },
  railBullet: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  railBulletActive: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    border: `1px solid ${tokens.colorBrandBackground}`,
  },
  railBulletDone: {
    backgroundColor: tokens.colorPaletteGreenBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
    border: `1px solid ${tokens.colorPaletteGreenBackground3}`,
  },
  railText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  railLabel: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  railLabelActive: { color: tokens.colorBrandForeground1 },
  railHint: { color: tokens.colorNeutralForeground3 },
  // ── content panel ──────────────────────────────────────────────────────
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    minWidth: 0,
  },
  stepHeader: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '520px' },
  // option-card grid (boundary / mode)
  optionGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  optionCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    textAlign: 'left',
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'border-color, box-shadow, background-color',
    ':hover': { border: `1px solid ${tokens.colorNeutralStroke1}`, boxShadow: tokens.shadow4 },
  },
  optionCardSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    boxShadow: tokens.shadow4,
  },
  optionIconChip: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  optionBody: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  optionTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  // service equivalence chips (capacity step)
  serviceRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  serviceChip: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  serviceIconChip: {
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusSmall,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // review summary grid
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalM,
  },
  summaryCell: { display: 'flex', flexDirection: 'column', gap: '2px' },
  summaryLabel: { color: tokens.colorNeutralForeground3 },
  preview: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    padding: tokens.spacingVerticalM,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
  // footer / buttons
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalM,
  },
  footerRight: { display: 'flex', gap: tokens.spacingHorizontalS, marginLeft: 'auto' },
  inlineLoad: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  // intro hero
  hero: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, alignItems: 'flex-start' },
  heroIconChip: {
    width: '56px',
    height: '56px',
    borderRadius: tokens.borderRadiusXLarge,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  doneCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalM, textAlign: 'center', padding: tokens.spacingVerticalL },
});

export function SetupWizardPane() {
  const styles = useStyles();
  const [state, setState] = useState<WizardState>({ step: 'intro' });
  const [subs, setSubs] = useState<AzureSubscription[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [subsError, setSubsError] = useState<string | undefined>();

  const bicepPreview = useMemo(() => renderBicepParam(state), [state]);

  const isGov = state.boundary === 'GCC-High' || state.boundary === 'IL5';
  const regions = isGov ? REGIONS_GOV : REGIONS_COMMERCIAL;

  const go = useCallback((step: Step) => setState((s) => ({ ...s, step })), []);

  const loadSubscriptions = useCallback(async () => {
    setSubsLoading(true);
    setSubsError(undefined);
    try {
      const res = await fetch('/api/setup/subscriptions');
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const t = await res.text().catch(() => '');
        setSubsError(`Subscriptions service returned non-JSON (HTTP ${res.status}). ${t.slice(0, 160)}`);
        setSubs([]);
        return;
      }
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setSubsError(j.error || j.hint || `Could not list subscriptions (HTTP ${res.status}).`);
        setSubs([]);
        return;
      }
      setSubs(j.subscriptions || []);
      if ((j.subscriptions || []).length === 0) {
        setSubsError('No subscriptions are visible to the Console identity. Grant it Reader on the target subscription.');
      }
    } catch (e) {
      setSubsError(e instanceof Error ? e.message : String(e));
      setSubs([]);
    } finally {
      setSubsLoading(false);
    }
  }, []);

  // Load subscriptions when the operator first reaches the subscription step.
  useEffect(() => {
    if (state.step === 'subscription' && subs.length === 0 && !subsLoading && !subsError) {
      void loadSubscriptions();
    }
  }, [state.step, subs.length, subsLoading, subsError, loadSubscriptions]);

  // Stream the GitHub Actions deploy run status while the wizard is on the
  // "done" step after a workflow-dispatch. Polls every 6s until the run
  // completes; cleans up on unmount / step change / completion.
  const isStreaming =
    state.step === 'done' &&
    !!state.workflowFile &&
    state.runStatus !== 'completed';

  useEffect(() => {
    if (!isStreaming || !state.workflowFile) return;
    let cancelled = false;

    async function poll() {
      try {
        const qs = new URLSearchParams({ workflow: state.workflowFile! });
        if (state.dispatchedAt) qs.set('since', state.dispatchedAt);
        const res = await fetch(`/api/setup/workflow-run-status?${qs.toString()}`);
        const j = await res.json().catch(() => ({}));
        if (cancelled || !j?.ok) return;
        setState((s) =>
          s.step === 'done'
            ? {
                ...s,
                runStatus: j.status,
                runConclusion: j.conclusion ?? null,
                runUrl: j.runUrl ?? s.runUrl,
                deployProgress:
                  j.status === 'completed' ? 1 : j.status === 'in_progress' ? 0.66 : 0.3,
              }
            : s,
        );
      } catch {
        /* transient — next tick retries */
      }
    }

    void poll();
    const id = setInterval(poll, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isStreaming, state.workflowFile, state.dispatchedAt]);

  async function deploy() {
    // The backend validates the captured config and returns 400 if anything is
    // missing, or 503 with a copy-paste `az deployment sub create` (pre-filled
    // with the selected subscription + region) when the Setup Orchestrator
    // isn't deployed. We surface either honestly — no fake progress animation.
    setState((s) => ({ ...s, step: 'deploying', deployProgress: 0, deployStage: 'Submitting deployment request…', deployError: undefined }));
    try {
      const res = await fetch('/api/setup/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const t = await res.text().catch(() => '');
        setState((s) => ({ ...s, deployError: `Deploy service returned non-JSON (HTTP ${res.status}). ${t.slice(0, 200)}` }));
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (res.status === 202 && j.ok && j.deploymentMode === 'github-workflow-dispatch') {
        setState((s) => ({
          ...s,
          deploymentId: j.workflowFile,
          workflowFile: j.workflowFile,
          dispatchedAt: j.dispatchedAt,
          runStatus: 'pending',
          runConclusion: undefined,
          runUrl: undefined,
          deployStage: `Queued on GitHub Actions (${j.workflowFile})`,
          deployProgress: 0.3,
          step: 'done',
        }));
        return;
      }
      if (!res.ok) {
        const msg = j.remediation?.message || j.error || `HTTP ${res.status}`;
        const commands = j.remediation?.commands ? '\n\n' + j.remediation.commands.join('\n') : '';
        setState((s) => ({ ...s, deployError: msg + commands }));
        return;
      }
      setState((s) => ({ ...s, deploymentId: j.deploymentId, deployStage: 'Submitted', deployProgress: 1, step: 'done' }));
    } catch (e) {
      setState((s) => ({ ...s, deployError: e instanceof Error ? e.message : String(e) }));
    }
  }

  // Which rail step is "current" for highlighting (transient steps map to review).
  const activeRailKey: Step =
    state.step === 'deploying' || state.step === 'done' ? 'review' : state.step;
  const activeIndex = STEP_ORDER.indexOf(activeRailKey);

  function isStepComplete(step: Step): boolean {
    switch (step) {
      case 'boundary': return !!state.boundary;
      case 'mode': return !!state.mode;
      case 'subscription': return !!state.subscriptionId && !!state.location;
      case 'domain': return !!state.domainName;
      case 'capacity': return !!state.capacitySku;
      case 'review': return state.step === 'done';
      default: return false;
    }
  }

  const completedCount = STEP_ORDER.filter(isStepComplete).length;

  return (
    <div className={styles.root}>
      {/* ── Step rail ─────────────────────────────────────────────────── */}
      <nav className={styles.rail} aria-label="Setup steps">
        <div className={styles.railHead}>
          <Subtitle2>Deploy a Data Landing Zone</Subtitle2>
          <ProgressBar
            className={styles.railProgress}
            value={completedCount / STEP_ORDER.length}
            thickness="medium"
          />
          <Caption1 className={styles.railHint}>{completedCount} of {STEP_ORDER.length} steps complete</Caption1>
        </div>

        {RAIL_STEPS.map((rs, i) => {
          const done = isStepComplete(rs.key);
          const isActive = rs.key === activeRailKey;
          // A step is reachable if it's already complete, the current one, or
          // the immediate next once the previous is satisfied.
          const reachable = state.step !== 'intro' && (done || i <= activeIndex);
          return (
            <button
              key={rs.key}
              type="button"
              className={mergeClasses(
                styles.railItem,
                reachable && styles.railItemClickable,
                isActive && styles.railItemActive,
              )}
              aria-current={isActive ? 'step' : undefined}
              disabled={!reachable}
              onClick={() => reachable && go(rs.key)}
            >
              <span
                className={mergeClasses(
                  styles.railBullet,
                  isActive && styles.railBulletActive,
                  done && !isActive && styles.railBulletDone,
                )}
                aria-hidden
              >
                {done && !isActive ? <Checkmark16Filled /> : i + 1}
              </span>
              <span className={styles.railText}>
                <Caption1 className={mergeClasses(styles.railLabel, isActive && styles.railLabelActive)}>
                  {rs.label}
                </Caption1>
                <Caption1 className={styles.railHint}>{rs.hint}</Caption1>
              </span>
            </button>
          );
        })}
      </nav>

      {/* ── Content panel ─────────────────────────────────────────────── */}
      <div className={styles.panel}>
        {state.step === 'intro' && (
          <div className={styles.hero}>
            <span className={styles.heroIconChip} aria-hidden><Rocket24Regular /></span>
            <Title2>Set up a new Data Landing Zone</Title2>
            <Body1>
              This wizard provisions an additional Data Landing Zone on top of your installed Admin
              Plane. You'll choose the cloud boundary, deployment mode, target subscription and
              region, a domain name, and capacity sizing — then review the generated Bicep before
              launching the deployment under JIT Contributor elevation via the Azure MCP server.
            </Body1>
            <MessageBar intent="info">
              <MessageBarBody>
                Nothing is provisioned until you confirm on the final review step.
              </MessageBarBody>
            </MessageBar>
            <div className={styles.footer}>
              <Button appearance="primary" size="large" icon={<ArrowRight20Regular />} iconPosition="after" onClick={() => go('boundary')}>
                Get started
              </Button>
            </div>
          </div>
        )}

        {state.step === 'boundary' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Which Azure boundary?</Subtitle2>
              <Body1>This determines the cloud, identity model, and container platform Loom deploys into.</Body1>
            </div>
            <div className={styles.optionGrid}>
              {BOUNDARY_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = state.boundary === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={selected}
                    className={mergeClasses(styles.optionCard, selected && styles.optionCardSelected)}
                    onClick={() => setState((s) => ({ ...s, boundary: opt.value, location: undefined }))}
                  >
                    <span className={styles.optionIconChip} aria-hidden><Icon /></span>
                    <span className={styles.optionBody}>
                      <span className={styles.optionTitleRow}>
                        <Body1Strong>{opt.title}</Body1Strong>
                        {opt.gov && <Badge appearance="tint" color="informative" size="small">Gov</Badge>}
                      </span>
                      <Caption1 className={styles.railHint}>{opt.desc}</Caption1>
                    </span>
                  </button>
                );
              })}
            </div>
            <Footer
              onBack={() => go('intro')}
              backLabel="Cancel"
              nextDisabled={!state.boundary}
              onNext={() => go('mode')}
            />
          </>
        )}

        {state.step === 'mode' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Single-sub or multi-sub?</Subtitle2>
              <Body1>Choose how the new Data Landing Zone is isolated from the Admin Plane.</Body1>
            </div>
            <div className={styles.optionGrid}>
              {MODE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = state.mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={selected}
                    className={mergeClasses(styles.optionCard, selected && styles.optionCardSelected)}
                    onClick={() => setState((s) => ({ ...s, mode: opt.value }))}
                  >
                    <span className={styles.optionIconChip} aria-hidden><Icon /></span>
                    <span className={styles.optionBody}>
                      <span className={styles.optionTitleRow}>
                        <Body1Strong>{opt.title}</Body1Strong>
                        {opt.tag && <Badge appearance="tint" color="success" size="small">{opt.tag}</Badge>}
                      </span>
                      <Caption1 className={styles.railHint}>{opt.desc}</Caption1>
                    </span>
                  </button>
                );
              })}
            </div>
            <Footer onBack={() => go('boundary')} nextDisabled={!state.mode} onNext={() => go('subscription')} />
          </>
        )}

        {state.step === 'subscription' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Target subscription &amp; region</Subtitle2>
              <Body1>
                Pick the Azure subscription the new Data Landing Zone deploys into — it's threaded into{' '}
                <code>az deployment sub create --subscription …</code>. Only subscriptions your identity
                can see are listed.
              </Body1>
            </div>

            <div className={styles.fields}>
              <Field label="Subscription" required>
                {subsLoading ? (
                  <div className={styles.inlineLoad}>
                    <Spinner size="tiny" /> <Caption1>Listing subscriptions from Azure Resource Manager…</Caption1>
                  </div>
                ) : (
                  <Dropdown
                    placeholder={subs.length ? 'Select subscription' : 'No subscriptions available'}
                    disabled={subs.length === 0}
                    value={state.subscriptionName}
                    selectedOptions={state.subscriptionId ? [state.subscriptionId] : []}
                    onOptionSelect={(_, d) => {
                      const chosen = subs.find((x) => x.subscriptionId === d.optionValue);
                      setState((s) => ({ ...s, subscriptionId: d.optionValue, subscriptionName: chosen?.displayName }));
                    }}
                  >
                    {subs.map((sub) => (
                      <Option key={sub.subscriptionId} value={sub.subscriptionId} text={sub.displayName}>
                        {sub.displayName} — {sub.subscriptionId} ({sub.state})
                      </Option>
                    ))}
                  </Dropdown>
                )}
              </Field>

              {subsError && !subsLoading && (
                <MessageBar intent="warning">
                  <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{subsError}</MessageBarBody>
                </MessageBar>
              )}

              <Field
                label="Region"
                required
                hint={isGov ? 'Azure Government regions only for this boundary.' : 'Azure Public regions for this boundary.'}
              >
                <Dropdown
                  placeholder="Select region"
                  value={state.location}
                  selectedOptions={state.location ? [state.location] : []}
                  onOptionSelect={(_, d) => setState((s) => ({ ...s, location: d.optionValue as string }))}
                >
                  {regions.map((r) => (
                    <Option key={r} value={r}>{r}</Option>
                  ))}
                </Dropdown>
              </Field>
            </div>

            <Footer
              onBack={() => go('mode')}
              nextDisabled={!state.subscriptionId || !state.location}
              onNext={() => go('domain')}
              extra={
                <Button
                  appearance="subtle"
                  icon={<ArrowClockwise20Regular />}
                  onClick={() => { setSubs([]); setSubsError(undefined); void loadSubscriptions(); }}
                  disabled={subsLoading}
                >
                  Refresh
                </Button>
              }
            />
          </>
        )}

        {state.step === 'domain' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Domain name</Subtitle2>
              <Body1>Used in the Data Landing Zone resource names. Lowercase letters, digits, and hyphens only.</Body1>
            </div>
            <div className={styles.fields}>
              <Field
                label="DLZ domain name"
                required
                hint={
                  state.domainName
                    ? `Resource group: rg-csa-loom-dlz-${state.domainName}-${state.location ?? (isGov ? 'usgovvirginia' : 'eastus2')}`
                    : 'e.g. finance → rg-csa-loom-dlz-finance-eastus2'
                }
              >
                <Input
                  value={state.domainName ?? ''}
                  onChange={(_, d) => setState((s) => ({ ...s, domainName: d.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                  placeholder="finance, procurement, mission-ops…"
                />
              </Field>
              <Field
                label="Vanity URL (optional)"
                hint={state.vanityDomain
                  ? `Console will be reachable at https://${state.vanityDomain} — the deploy outputs the 2 DNS records (CNAME + _dnsauth TXT) to add at your DNS provider.`
                  : 'e.g. csa-loom.contoso.ai — a friendly URL instead of the long generated Front Door host. Leave blank to skip.'}
              >
                <Input
                  value={state.vanityDomain ?? ''}
                  onChange={(_, d) => setState((s) => ({ ...s, vanityDomain: d.value.toLowerCase().replace(/[^a-z0-9.-]/g, '') }))}
                  placeholder="csa-loom.contoso.ai"
                />
              </Field>
            </div>
            <Footer onBack={() => go('subscription')} nextDisabled={!state.domainName} onNext={() => go('capacity')} />
          </>
        )}

        {state.step === 'capacity' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Capacity sizing</Subtitle2>
              <Body1>
                Loom uses Fabric F-SKU labels as a familiar <i>sizing equivalence</i> so existing Fabric
                guides apply, but compute is provisioned on Azure-native services you already pay for:
              </Body1>
              <div className={styles.serviceRow}>
                {CAPACITY_SERVICES.map((svc) => {
                  const v = itemVisual(svc.type);
                  const Icon = v.icon;
                  return (
                    <span key={svc.type} className={styles.serviceChip}>
                      <span className={styles.serviceIconChip} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
                        <Icon />
                      </span>
                      <Caption1>{svc.label}</Caption1>
                    </span>
                  );
                })}
              </div>
            </div>
            <div className={styles.fields}>
              <Field label="Capacity equivalence" required>
                <Dropdown
                  placeholder="Select capacity"
                  value={state.capacitySku}
                  selectedOptions={state.capacitySku ? [state.capacitySku] : []}
                  onOptionSelect={(_, d) => setState((s) => ({ ...s, capacitySku: d.optionValue as string }))}
                >
                  {CAPACITY_OPTIONS.map((c) => (
                    <Option key={c.sku} value={c.sku} text={c.sku}>
                      {c.sku} — {c.note}{c.tag ? ` (${c.tag})` : ''}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            </div>
            <Footer onBack={() => go('domain')} nextDisabled={!state.capacitySku} onNext={() => go('review')} />
          </>
        )}

        {state.step === 'review' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Review &amp; deploy</Subtitle2>
              <Body1>Confirm the configuration below. Deploy requests JIT Contributor elevation on the target subscription via PIM-for-Groups and executes via the self-hosted Azure MCP server.</Body1>
            </div>

            <div className={styles.summaryGrid}>
              <SummaryCell label="Boundary" value={state.boundary} />
              <SummaryCell label="Mode" value={state.mode === 'single-sub' ? 'Single-sub' : state.mode === 'multi-sub' ? 'Multi-sub' : undefined} />
              <SummaryCell label="Subscription" value={state.subscriptionName} sub={state.subscriptionId} />
              <SummaryCell label="Region" value={state.location} />
              <SummaryCell label="Domain" value={state.domainName} />
              <SummaryCell label="Capacity" value={state.capacitySku} />
            </div>

            <Divider />

            <div>
              <Body1Strong>Generated Bicep parameters</Body1Strong>
              <div className={styles.preview}>{bicepPreview}</div>
            </div>

            <Footer
              onBack={() => go('capacity')}
              onNext={deploy}
              nextLabel="Deploy"
              nextIcon={<Send24Regular />}
              nextAppearance="primary"
            />
          </>
        )}

        {state.step === 'deploying' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>{state.deployError ? 'Deployment could not start' : 'Deploying…'}</Subtitle2>
            </div>
            {!state.deployError && (
              <>
                <ProgressBar value={state.deployProgress ?? 0} thickness="large" />
                <div className={styles.inlineLoad}><Spinner size="tiny" /><Body1>{state.deployStage}</Body1></div>
              </>
            )}
            {state.deployError && (
              <>
                <MessageBar intent={/az deployment sub create/.test(state.deployError) ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {/az deployment sub create/.test(state.deployError) ? 'Run the deployment manually' : 'Deployment error'}
                    </MessageBarTitle>
                    <div style={{ whiteSpace: 'pre-wrap', marginTop: tokens.spacingVerticalXS }}>{state.deployError}</div>
                  </MessageBarBody>
                </MessageBar>
                <Footer
                  onBack={() => setState((s) => ({ ...s, step: 'review', deployError: undefined }))}
                  backLabel="Back to review"
                  onNext={deploy}
                  nextLabel="Retry deploy"
                  nextAppearance="primary"
                />
              </>
            )}
          </>
        )}

        {state.step === 'done' && (
          <div className={styles.doneCenter}>
            {state.deployStage?.includes('GitHub Actions') ? (
              (() => {
                const rs = runStatusDisplay(state);
                return (
                  <>
                    {rs.done && rs.color === 'success' ? (
                      <CheckmarkCircle48Filled style={{ color: tokens.colorPaletteGreenForeground1 }} aria-hidden />
                    ) : rs.done ? (
                      <ErrorCircle48Filled style={{ color: tokens.colorPaletteRedForeground1 }} aria-hidden />
                    ) : (
                      <Spinner size="large" />
                    )}
                    <Title2>
                      {rs.done && rs.color === 'success'
                        ? 'Data Landing Zone deployed'
                        : rs.done
                          ? 'Deployment finished with errors'
                          : 'Deploying on GitHub Actions'}
                    </Title2>
                    <div className={styles.inlineLoad}>
                      <Badge appearance="filled" color={rs.color}>{rs.label}</Badge>
                      <Caption1 className={styles.summaryLabel}>workflow: <code>{state.workflowFile}</code></Caption1>
                    </div>
                    <ProgressBar value={state.deployProgress ?? 0.3} thickness="large" />
                    <Body1>
                      {rs.done
                        ? 'The deployment workflow has finished. Open the run on GitHub for the full log.'
                        : 'Live status is streamed from GitHub Actions below — this page updates every few seconds.'}
                    </Body1>
                    <Button
                      appearance="primary"
                      as="a"
                      href={state.runUrl || `https://github.com/fgarofalo56/csa-inabox/actions/workflows/${state.workflowFile}`}
                      target="_blank"
                    >
                      {rs.done ? 'Open run on GitHub' : 'Watch workflow run'}
                    </Button>
                  </>
                );
              })()
            ) : (
              <>
                <CheckmarkCircle48Filled style={{ color: tokens.colorPaletteGreenForeground1 }} aria-hidden />
                <Title2>Data Landing Zone deployed</Title2>
                <Body1>
                  "{state.domainName}" was deployed successfully.
                  {state.deploymentId && <> Deployment ID: <code>{state.deploymentId}</code></>}
                </Body1>
              </>
            )}
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Next steps</MessageBarTitle>
                Configure mirroring from your source systems, define Activator rules over the ADX
                database, build a semantic model on the gold layer, and create a Data Agent grounded
                on this lakehouse. <Link href="/learn?topic=setup-wizard">Learn more</Link>
              </MessageBarBody>
            </MessageBar>
            <Button appearance="primary" icon={<Rocket24Regular />} onClick={() => { setState({ step: 'intro' }); setSubs([]); setSubsError(undefined); }}>
              Deploy another
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Step footer: Back on the left, optional extra control, primary Next on the right. */
function Footer(props: {
  onBack: () => void;
  backLabel?: string;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextIcon?: React.ReactElement;
  nextAppearance?: 'primary' | 'secondary';
  extra?: React.ReactNode;
}) {
  const styles = useStyles();
  return (
    <div className={styles.footer}>
      <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={props.onBack}>
        {props.backLabel ?? 'Back'}
      </Button>
      <div className={styles.footerRight}>
        {props.extra}
        <Button
          appearance={props.nextAppearance ?? 'primary'}
          icon={props.nextIcon ?? <ArrowRight20Regular />}
          iconPosition={props.nextIcon ? 'before' : 'after'}
          disabled={props.nextDisabled}
          onClick={props.onNext}
        >
          {props.nextLabel ?? 'Next'}
        </Button>
      </div>
    </div>
  );
}

/** A label/value cell in the review summary grid. */
function SummaryCell({ label, value, sub }: { label: string; value?: string; sub?: string }) {
  const styles = useStyles();
  return (
    <div className={styles.summaryCell}>
      <Caption1 className={styles.summaryLabel}>{label}</Caption1>
      <Body1Strong>{value ?? '—'}</Body1Strong>
      {sub && <Caption1 className={styles.summaryLabel}>{sub}</Caption1>}
    </div>
  );
}
