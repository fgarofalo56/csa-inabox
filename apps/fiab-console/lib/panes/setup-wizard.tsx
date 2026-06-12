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
  Checkbox,
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
import {
  SHARED_SERVICES,
  type SharedServiceKey,
  type ServiceCandidate,
  type ServiceChoice,
} from '@/lib/setup/shared-services';
import { CapacityEquivalencePanel } from '@/lib/components/setup/capacity-equivalence-panel';
import { SetupDeploymentDiagram, type DiagramSpoke } from '@/lib/components/setup/deployment-diagram';
import {
  regionsForBoundary,
  defaultRegion,
  type AzureRegion,
  type RegionBoundary,
} from '@/lib/azure/azure-regions';

type Boundary = 'Commercial' | 'GCC' | 'GCC-High' | 'IL5';
type Mode = 'single-sub' | 'multi-sub';

type Step =
  | 'intro'
  | 'boundary'
  | 'mode'
  | 'multi-sub-choice'  // New: only shown when mode='multi-sub' — branch to wire-new vs wire-existing
  | 'subscription'
  | 'discover'
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
  /**
   * Adopt-existing (D6): per shared-service reuse/new/gate choice. Undefined
   * until the operator reaches the 'discover' step and discovery loads. A
   * 'reuse' choice with a candidate flows into bicep as the matching
   * existing<Svc> param via the deploy payload.
   */
  serviceChoices?: Partial<Record<SharedServiceKey, ServiceChoice>>;
  /** Optional vanity console URL (e.g. csa-loom.contoso.ai). Empty = generated Front Door host. */
  vanityDomain?: string;
  /** Multi-sub mode only: the deployment sub in which the DLZ lands (distinct from admin-plane sub) */
  dlzSubscriptionId?: string;
  dlzSubscriptionName?: string;
  /** Multi-sub Route A (wire new) vs Route B (wire existing) */
  multiSubMode?: 'wire-new' | 'wire-existing';
  /** Multi-sub Route A: the spoke subscription IDs the DLZ(s) deploy into (multi-select). */
  dlzSubscriptionIds?: string[];
  /** Multi-sub Route A: id → displayName for the chosen spoke subscriptions. */
  dlzSubscriptionNames?: Record<string, string>;
  /** Multi-sub Route B: list of existing DLZs discovered in the tenant (loaded async) */
  existingDlzs?: Array<{ subscriptionId: string; subscriptionName: string; domainName: string; region?: string; rg: string }>;
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

const REGION_BOUNDARY = (b?: Boundary): RegionBoundary => (b ?? 'Commercial') as RegionBoundary;

/** The ordered, user-facing steps shown in the rail (intro/deploying/done are transient). */
/** Note: 'multi-sub-choice' is inserted dynamically after 'mode' when mode='multi-sub'. */
const RAIL_STEPS: { key: Step; label: string; hint: string }[] = [
  { key: 'boundary', label: 'Cloud boundary', hint: 'Where Loom runs' },
  { key: 'mode', label: 'Deployment mode', hint: 'Single or multi-sub' },
  { key: 'subscription', label: 'Subscription & region', hint: 'Deploy target' },
  { key: 'discover', label: 'Shared services', hint: 'Reuse or deploy new' },
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
  // adopt-existing (discover) step: one card per shared service
  svcCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  svcCardHead: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM },
  svcChecks: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  svcCheckRow: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalXS },
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

  // Admin Plane deployment defaults (single-sub auto-uses these — no dropdown).
  const [config, setConfig] = useState<{ adminSubscriptionId?: string; adminSubscriptionName?: string; location?: string } | null>(null);
  const [configError, setConfigError] = useState<string | undefined>();

  // Region list — live ARM /locations for the chosen sub, else static fallback.
  const [regions, setRegions] = useState<AzureRegion[]>([]);
  const [regionSource, setRegionSource] = useState<'arm' | 'static'>('static');
  const [regionsLoading, setRegionsLoading] = useState(false);

  // Multi-sub Route B: existing-DLZ discovery (Azure Resource Graph).
  const [existingLoading, setExistingLoading] = useState(false);
  const [existingError, setExistingError] = useState<string | undefined>();

  // Adopt-existing (D6): shared-service discovery candidates (Resource Graph)
  // and per-service validation in-flight set.
  const [serviceCandidates, setServiceCandidates] = useState<Partial<Record<SharedServiceKey, ServiceCandidate[]>> | undefined>();
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | undefined>();
  const [validating, setValidating] = useState<Partial<Record<SharedServiceKey, boolean>>>({});

  const bicepPreview = useMemo(() => renderBicepParam(state), [state]);

  const isGov = state.boundary === 'GCC-High' || state.boundary === 'IL5';
  const isSingleSub = state.mode === 'single-sub';
  const isWireExisting = state.mode === 'multi-sub' && state.multiSubMode === 'wire-existing';
  const isWireNew = state.mode === 'multi-sub' && state.multiSubMode === 'wire-new';

  const go = useCallback((step: Step) => setState((s) => ({ ...s, step })), []);

  // Load the admin-plane deployment defaults once (drives single-sub auto-fill).
  const loadConfig = useCallback(async () => {
    setConfigError(undefined);
    try {
      const res = await fetch('/api/setup/config');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setConfigError(j.error || `Could not read deployment config (HTTP ${res.status}).`);
        return;
      }
      setConfig({ adminSubscriptionId: j.adminSubscriptionId, adminSubscriptionName: j.adminSubscriptionName, location: j.location });
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (config === null && !configError) void loadConfig();
  }, [config, configError, loadConfig]);

  // Load the region list for the active boundary + chosen subscription. Prefers
  // the live ARM locations for that sub; falls back to the static per-boundary set.
  const loadRegions = useCallback(async (boundary?: Boundary, subscriptionId?: string) => {
    setRegionsLoading(true);
    try {
      const qs = new URLSearchParams();
      if (boundary) qs.set('boundary', boundary);
      if (subscriptionId) qs.set('subscription', subscriptionId);
      const res = await fetch(`/api/setup/regions?${qs.toString()}`);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok && Array.isArray(j.regions)) {
        setRegions(j.regions);
        setRegionSource(j.source === 'arm' ? 'arm' : 'static');
      } else {
        setRegions(regionsForBoundary(REGION_BOUNDARY(boundary)));
        setRegionSource('static');
      }
    } catch {
      setRegions(regionsForBoundary(REGION_BOUNDARY(boundary)));
      setRegionSource('static');
    } finally {
      setRegionsLoading(false);
    }
  }, []);

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

  // Discover already-deployed DLZs (multi-sub Route B / wire-existing).
  const loadExistingDlzs = useCallback(async () => {
    setExistingLoading(true);
    setExistingError(undefined);
    try {
      const res = await fetch('/api/setup/existing-dlzs');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setExistingError(j.error || j.hint || `Could not discover existing DLZs (HTTP ${res.status}).`);
        setState((s) => ({ ...s, existingDlzs: [] }));
        return;
      }
      setState((s) => ({ ...s, existingDlzs: j.dlzs || [] }));
      if ((j.dlzs || []).length === 0) {
        setExistingError('No existing CSA Loom Data Landing Zones are visible to the Console identity. Grant it Reader on the subscriptions whose DLZs you want to wire, or use "Deploy a new DLZ".');
      }
    } catch (e) {
      setExistingError(e instanceof Error ? e.message : String(e));
    } finally {
      setExistingLoading(false);
    }
  }, []);

  // Adopt-existing (D6): discover existing shared services across visible subs
  // via Azure Resource Graph, and seed default per-service choices. The default
  // is "deploy new" (the full deploy provisions each), except Purview — when a
  // tenant account exists it is one-per-tenant, so we pin it to reuse.
  const loadDiscoverServices = useCallback(async () => {
    setDiscoverLoading(true);
    setDiscoverError(undefined);
    try {
      const res = await fetch('/api/setup/discover-services');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setDiscoverError(j.error || j.hint || `Could not discover shared services (HTTP ${res.status}).`);
        setServiceCandidates({});
        return;
      }
      const cands = (j.services || {}) as Partial<Record<SharedServiceKey, ServiceCandidate[]>>;
      setServiceCandidates(cands);
      setState((s) => {
        const choices: Partial<Record<SharedServiceKey, ServiceChoice>> = { ...(s.serviceChoices || {}) };
        for (const svc of SHARED_SERVICES) {
          if (choices[svc.key]) continue; // preserve any operator selection
          const list = cands[svc.key] || [];
          if (svc.oneePerTenant && list.length > 0) {
            choices[svc.key] = { mode: 'reuse', candidate: list[0] };
          } else {
            choices[svc.key] = { mode: 'new' };
          }
        }
        return { ...s, serviceChoices: choices };
      });
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : String(e));
      setServiceCandidates({});
    } finally {
      setDiscoverLoading(false);
    }
  }, []);

  // Validate one reuse candidate against the target region + boundary (real
  // ARM checks). Stores the checks on the service's choice for inline display.
  const validateService = useCallback(
    async (key: SharedServiceKey, candidate: ServiceCandidate) => {
      setValidating((v) => ({ ...v, [key]: true }));
      try {
        const res = await fetch('/api/setup/validate-service', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceKey: key, candidate, targetRegion: state.location, boundary: state.boundary }),
        });
        const j = await res.json().catch(() => ({}));
        setState((s) => {
          const choices = { ...(s.serviceChoices || {}) };
          const cur = choices[key] || { mode: 'reuse' as const };
          choices[key] = {
            ...cur,
            mode: 'reuse',
            candidate,
            checks: j.ok ? j.checks : [{ label: 'Validation', status: 'warn', detail: j.error || `Validation failed (HTTP ${res.status}).` }],
            worst: j.ok ? j.worst : 'warn',
          };
          return { ...s, serviceChoices: choices };
        });
      } catch (e) {
        setState((s) => {
          const choices = { ...(s.serviceChoices || {}) };
          const cur = choices[key] || { mode: 'reuse' as const };
          choices[key] = { ...cur, mode: 'reuse', candidate, checks: [{ label: 'Validation', status: 'warn', detail: e instanceof Error ? e.message : String(e) }], worst: 'warn' };
          return { ...s, serviceChoices: choices };
        });
      } finally {
        setValidating((v) => ({ ...v, [key]: false }));
      }
    },
    [state.location, state.boundary],
  );

  // Set a per-service choice from the dropdown selection ("reuse:<idx>" | "new" | "gate").
  const setServiceChoice = useCallback(
    (key: SharedServiceKey, value: string) => {
      const list = serviceCandidates?.[key] || [];
      if (value === 'new' || value === 'gate') {
        setState((s) => ({ ...s, serviceChoices: { ...(s.serviceChoices || {}), [key]: { mode: value } } }));
        return;
      }
      const idx = Number(value.replace('reuse:', ''));
      const candidate = list[idx];
      if (!candidate) return;
      setState((s) => ({ ...s, serviceChoices: { ...(s.serviceChoices || {}), [key]: { mode: 'reuse', candidate } } }));
      void validateService(key, candidate);
    },
    [serviceCandidates, validateService],
  );

  // Load subscriptions when the operator reaches the subscription step in a
  // path that needs a picker (multi-sub wire-new chooses spoke subs).
  useEffect(() => {
    if (state.step === 'subscription' && isWireNew && subs.length === 0 && !subsLoading && !subsError) {
      void loadSubscriptions();
    }
  }, [state.step, isWireNew, subs.length, subsLoading, subsError, loadSubscriptions]);

  // Discover existing DLZs when reaching the subscription step in wire-existing.
  useEffect(() => {
    if (state.step === 'subscription' && isWireExisting && state.existingDlzs === undefined && !existingLoading && !existingError) {
      void loadExistingDlzs();
    }
  }, [state.step, isWireExisting, state.existingDlzs, existingLoading, existingError, loadExistingDlzs]);

  // Load regions on entering the subscription step, and refresh whenever the
  // chosen target subscription changes (so ARM lists that sub's enabled regions).
  useEffect(() => {
    if (state.step === 'subscription') {
      void loadRegions(state.boundary, state.subscriptionId);
    }
  }, [state.step, state.boundary, state.subscriptionId, loadRegions]);

  // Adopt-existing: discover shared services on entering the 'discover' step.
  useEffect(() => {
    if (state.step === 'discover' && serviceCandidates === undefined && !discoverLoading && !discoverError) {
      void loadDiscoverServices();
    }
  }, [state.step, serviceCandidates, discoverLoading, discoverError, loadDiscoverServices]);

  // Single-sub: auto-bind the new DLZ to the Admin Plane subscription (no dropdown)
  // and default the region to the admin-plane deployment region when available.
  useEffect(() => {
    if (state.step !== 'subscription' || state.mode !== 'single-sub' || !config) return;
    setState((s) => {
      const next: WizardState = { ...s };
      if (config.adminSubscriptionId && s.subscriptionId !== config.adminSubscriptionId) {
        next.subscriptionId = config.adminSubscriptionId;
        next.subscriptionName = config.adminSubscriptionName;
      }
      if (!s.location && config.location) next.location = config.location;
      return next;
    });
  }, [state.step, state.mode, config]);

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

  // Multi-sub Route B: wire already-deployed DLZ(s) into the Admin Plane (RBAC +
  // env patch — no new deployment). Calls /api/setup/wire-existing.
  async function wireExisting() {
    setState((s) => ({ ...s, step: 'deploying', deployProgress: 0, deployStage: 'Wiring existing Data Landing Zone(s)…', deployError: undefined }));
    try {
      const selected = (state.selectedExistingDlzs || []);
      const res = await fetch('/api/setup/wire-existing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boundary: state.boundary,
          subscriptionId: config?.adminSubscriptionId || state.subscriptionId,
          subscriptionName: config?.adminSubscriptionName || state.subscriptionName,
          location: state.location,
          selectedExistingDlzs: selected,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 || j.error === 'forbidden') {
        const cap = j.capabilityName || j.capability || 'Deploy Landing Zone';
        const rem = typeof j.remediation === 'string' ? `\n\n${j.remediation}` : '';
        setState((s) => ({ ...s, deployError: `You don't have permission to wire a Data Landing Zone (requires ${j.requiredRole || 'Admin'} on "${cap}").${rem}` }));
        return;
      }
      if (!res.ok || !j.ok) {
        const msg = j.remediation?.message || j.error || `HTTP ${res.status}`;
        const commands = j.remediation?.commands ? '\n\n' + j.remediation.commands.join('\n') : '';
        setState((s) => ({ ...s, deployError: msg + commands }));
        return;
      }
      setState((s) => ({ ...s, deployStage: j.message || 'Wired', deployProgress: 1, step: 'done' }));
    } catch (e) {
      setState((s) => ({ ...s, deployError: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function deploy() {
    // Route B (wire existing) takes a different backend — no new provisioning.
    if (isWireExisting) return wireExisting();

    // The backend tries, in order: (1) POST the config to the deployed Setup
    // Orchestrator (LOOM_SETUP_ORCHESTRATOR_URL) which runs the multi-sub
    // `az deployment sub create`; (2) dispatch the GitHub deploy workflow; (3)
    // return 503 with a copy-paste `az deployment sub create` pre-filled with
    // the selected subscription(s) + region. We surface each honestly — no fake
    // progress animation (per no-vaporware.md).
    setState((s) => ({ ...s, step: 'deploying', deployProgress: 0, deployStage: 'Submitting deployment request…', deployError: undefined }));
    try {
      // Build the deploy payload. Single-sub uses the admin-plane subscription;
      // multi-sub wire-new threads the admin sub as the hub plus the selected
      // spoke subscriptions as parallel dlzSubscriptionIds / dlzDomainNames.
      const adminSubId = config?.adminSubscriptionId || state.subscriptionId;
      const adminSubName = config?.adminSubscriptionName || state.subscriptionName;
      const spokeIds = state.dlzSubscriptionIds || [];
      const payload = {
        ...state,
        subscriptionId: isSingleSub ? adminSubId : adminSubId,
        subscriptionName: isSingleSub ? adminSubName : adminSubName,
        // Multi-sub: emit parallel arrays the bicep loop consumes. One domain per
        // spoke (suffixed when >1) keeps the DLZ resource-group names unique.
        ...(isWireNew && spokeIds.length > 0
          ? {
              dlzSubscriptionIds: spokeIds,
              dlzDomainNames: spokeIds.map((_, i) =>
                spokeIds.length === 1 ? (state.domainName || '') : `${state.domainName || 'dlz'}-${i + 1}`,
              ),
            }
          : {}),
      };
      const res = await fetch('/api/setup/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const t = await res.text().catch(() => '');
        setState((s) => ({ ...s, deployError: `Deploy service returned non-JSON (HTTP ${res.status}). ${t.slice(0, 200)}` }));
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (res.status === 202 && j.ok && j.deploymentMode === 'orchestrator') {
        // The Setup Orchestrator accepted the job and is running the real
        // multi-sub `az deployment sub create`. Surface the deploymentId.
        setState((s) => ({
          ...s,
          deploymentId: j.deploymentId,
          deployStage: `Running on the Setup Orchestrator (deployment ${j.deploymentId})`,
          deployProgress: 0.5,
          step: 'done',
        }));
        return;
      }
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
      if (res.status === 403 || j.error === 'forbidden') {
        // Feature-permission gate (admin.deploy-dlz). remediation is a string here.
        const cap = j.capabilityName || j.capability || 'Deploy Landing Zone';
        const rem = typeof j.remediation === 'string' ? `\n\n${j.remediation}` : '';
        setState((s) => ({
          ...s,
          deployError: `You don't have permission to deploy a Data Landing Zone (requires ${j.requiredRole || 'Admin'} on "${cap}").${rem}`,
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

  // Which rail step is "current" for highlighting (transient steps map to review;
  // the multi-sub-choice sub-step sits between mode and subscription).
  const activeRailKey: Step =
    state.step === 'deploying' || state.step === 'done'
      ? 'review'
      : state.step === 'multi-sub-choice'
        ? 'mode'
        : state.step;
  const activeIndex = STEP_ORDER.indexOf(activeRailKey);

  function isStepComplete(step: Step): boolean {
    switch (step) {
      case 'boundary': return !!state.boundary;
      case 'mode': return !!state.mode && (state.mode === 'single-sub' || !!state.multiSubMode);
      case 'subscription':
        if (isWireExisting) return (state.selectedExistingDlzs?.length ?? 0) > 0;
        if (isWireNew) return (state.dlzSubscriptionIds?.length ?? 0) > 0 && !!state.location;
        // single-sub: admin sub is auto-selected; region must be chosen.
        return !!(config?.adminSubscriptionId || state.subscriptionId) && !!state.location;
      case 'domain': return !!state.domainName;
      case 'discover': return !!state.serviceChoices;
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
          <div className={styles.hero} data-tour="setup-intro">
            <span className={styles.heroIconChip} aria-hidden><Rocket24Regular /></span>
            <Title2>Set up a new Data Landing Zone</Title2>
            <Body1>
              This wizard provisions an additional Data Landing Zone on top of your installed Admin
              Plane. You'll choose the cloud boundary, deployment mode, target subscription(s) and
              region, a domain name, and capacity sizing — then review a visual architecture diagram
              and the generated Bicep before launching. When the Setup Orchestrator is deployed,
              Deploy runs the real multi-subscription <code>az deployment sub create</code> for you;
              otherwise it dispatches the GitHub deploy workflow or hands you the exact command.
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
                    onClick={() => setState((s) => ({ ...s, mode: opt.value, multiSubMode: opt.value === 'multi-sub' ? (s.multiSubMode ?? 'wire-new') : undefined }))}
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
            <Footer
              onBack={() => go('boundary')}
              nextDisabled={!state.mode}
              onNext={() => go(state.mode === 'multi-sub' ? 'multi-sub-choice' : 'subscription')}
            />
          </>
        )}

        {state.step === 'multi-sub-choice' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Deploy new, or wire existing?</Subtitle2>
              <Body1>
                Multi-subscription mode keeps the Admin Plane in this (hub) subscription and places each
                Data Landing Zone in its own spoke subscription. Choose whether to deploy a brand-new DLZ
                or wire DLZs that are already deployed in other subscriptions into this Admin Plane.
              </Body1>
            </div>
            <div className={styles.optionGrid}>
              {([
                { value: 'wire-new' as const, title: 'Deploy a new DLZ', desc: 'Provision a new Data Landing Zone in one or more spoke subscriptions you select.', icon: Branch24Regular },
                { value: 'wire-existing' as const, title: 'Wire existing DLZ(s)', desc: 'Discover already-deployed DLZs and wire them into the Admin Plane (RBAC + env) — no re-deploy.', icon: SquareMultiple24Regular },
              ]).map((opt) => {
                const Icon = opt.icon;
                const selected = state.multiSubMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={selected}
                    className={mergeClasses(styles.optionCard, selected && styles.optionCardSelected)}
                    onClick={() => setState((s) => ({ ...s, multiSubMode: opt.value }))}
                  >
                    <span className={styles.optionIconChip} aria-hidden><Icon /></span>
                    <span className={styles.optionBody}>
                      <Body1Strong>{opt.title}</Body1Strong>
                      <Caption1 className={styles.railHint}>{opt.desc}</Caption1>
                    </span>
                  </button>
                );
              })}
            </div>
            <Footer onBack={() => go('mode')} nextDisabled={!state.multiSubMode} onNext={() => go('subscription')} />
          </>
        )}

        {state.step === 'subscription' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>
                {isWireExisting ? 'Select existing Data Landing Zone(s)' : isWireNew ? 'Spoke subscriptions & region' : 'Subscription & region'}
              </Subtitle2>
              <Body1>
                {isSingleSub && 'The new Data Landing Zone lands in the same subscription as the Admin Plane. Pick the deployment region.'}
                {isWireNew && 'The Admin Plane stays in this (hub) subscription. Choose one or more spoke subscriptions to deploy DLZs into, plus the region.'}
                {isWireExisting && 'These are the CSA Loom DLZs your identity can see (discovered via Azure Resource Graph). Select the ones to wire into this Admin Plane — no re-deploy.'}
              </Body1>
            </div>

            {configError && (
              <MessageBar intent="warning">
                <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{configError}</MessageBarBody>
              </MessageBar>
            )}

            {/* ── single-sub: admin subscription is auto-selected (no dropdown) ── */}
            {isSingleSub && (
              <div className={styles.fields}>
                <Field label="Subscription (Admin Plane)">
                  <div className={mergeClasses(styles.optionCard, styles.optionCardSelected)} aria-readonly>
                    <span className={styles.optionIconChip} aria-hidden><Building24Regular /></span>
                    <span className={styles.optionBody}>
                      <Body1Strong>{config?.adminSubscriptionName || config?.adminSubscriptionId || 'Admin Plane subscription'}</Body1Strong>
                      <Caption1 className={styles.railHint}>
                        {config?.adminSubscriptionId
                          ? `${config.adminSubscriptionId} — the new DLZ lands here.`
                          : 'LOOM_SUBSCRIPTION_ID is not set on the console; the deploy will use the deployment subscription.'}
                      </Caption1>
                    </span>
                  </div>
                </Field>
                <RegionField
                  styles={styles}
                  regions={regions}
                  regionsLoading={regionsLoading}
                  regionSource={regionSource}
                  value={state.location}
                  isGov={isGov}
                  onSelect={(v) => setState((s) => ({ ...s, location: v }))}
                />
              </div>
            )}

            {/* ── multi-sub wire-new: multi-select spoke subscriptions ── */}
            {isWireNew && (
              <div className={styles.fields}>
                <Field label="Hub (Admin Plane) subscription">
                  <Caption1 className={styles.railHint}>
                    {config?.adminSubscriptionName || config?.adminSubscriptionId || 'Admin Plane subscription'}
                    {config?.adminSubscriptionId ? ` (${config.adminSubscriptionId})` : ''}
                  </Caption1>
                </Field>
                <Field label="Spoke subscription(s) — DLZ targets" required>
                  {subsLoading ? (
                    <div className={styles.inlineLoad}>
                      <Spinner size="tiny" /> <Caption1>Listing subscriptions from Azure Resource Manager…</Caption1>
                    </div>
                  ) : (
                    <Dropdown
                      multiselect
                      placeholder={subs.length ? 'Select one or more spoke subscriptions' : 'No subscriptions available'}
                      disabled={subs.length === 0}
                      selectedOptions={state.dlzSubscriptionIds || []}
                      value={(state.dlzSubscriptionIds || []).map((id) => state.dlzSubscriptionNames?.[id] || id).join(', ')}
                      onOptionSelect={(_, d) => {
                        setState((s) => {
                          const sel = new Set(s.dlzSubscriptionIds || []);
                          if (sel.has(d.optionValue!)) sel.delete(d.optionValue!); else sel.add(d.optionValue!);
                          const chosen = subs.find((x) => x.subscriptionId === d.optionValue);
                          const names = { ...(s.dlzSubscriptionNames || {}) };
                          if (chosen) names[chosen.subscriptionId] = chosen.displayName;
                          return { ...s, dlzSubscriptionIds: Array.from(sel), dlzSubscriptionNames: names };
                        });
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
                <RegionField
                  styles={styles}
                  regions={regions}
                  regionsLoading={regionsLoading}
                  regionSource={regionSource}
                  value={state.location}
                  isGov={isGov}
                  onSelect={(v) => setState((s) => ({ ...s, location: v }))}
                />
              </div>
            )}

            {/* ── multi-sub wire-existing: select discovered DLZs ── */}
            {isWireExisting && (
              <div className={styles.fields}>
                {existingLoading ? (
                  <div className={styles.inlineLoad}>
                    <Spinner size="tiny" /> <Caption1>Discovering deployed DLZs via Azure Resource Graph…</Caption1>
                  </div>
                ) : (
                  <>
                    {(state.existingDlzs || []).map((dlz) => {
                      const checked = (state.selectedExistingDlzs || []).some(
                        (x) => x.subscriptionId === dlz.subscriptionId && x.domainName === dlz.domainName,
                      );
                      return (
                        <Checkbox
                          key={dlz.rg}
                          checked={checked}
                          onChange={(_, d) => {
                            setState((s) => {
                              const cur = s.selectedExistingDlzs || [];
                              const next = d.checked
                                ? [...cur, { subscriptionId: dlz.subscriptionId, domainName: dlz.domainName }]
                                : cur.filter((x) => !(x.subscriptionId === dlz.subscriptionId && x.domainName === dlz.domainName));
                              // wire-existing reuses the DLZ's own region for RG naming.
                              return { ...s, selectedExistingDlzs: next, location: s.location || dlz.region };
                            });
                          }}
                          label={`${dlz.domainName} — ${dlz.region || '?'} · ${dlz.subscriptionId}`}
                        />
                      );
                    })}
                    {existingError && (
                      <MessageBar intent="warning">
                        <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{existingError}</MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                )}
              </div>
            )}

            <Footer
              onBack={() => go(state.mode === 'multi-sub' ? 'multi-sub-choice' : 'mode')}
              nextDisabled={
                isWireExisting
                  ? (state.selectedExistingDlzs?.length ?? 0) === 0
                  : isWireNew
                    ? (state.dlzSubscriptionIds?.length ?? 0) === 0 || !state.location
                    : !state.location
              }
              onNext={() => go(isWireExisting ? 'review' : 'discover')}
              extra={
                <Button
                  appearance="subtle"
                  icon={<ArrowClockwise20Regular />}
                  onClick={() => {
                    if (isWireExisting) { setExistingError(undefined); setState((s) => ({ ...s, existingDlzs: undefined })); }
                    else { setSubs([]); setSubsError(undefined); void loadSubscriptions(); }
                    void loadRegions(state.boundary, state.subscriptionId);
                  }}
                  disabled={subsLoading || existingLoading}
                >
                  Refresh
                </Button>
              }
            />
          </>
        )}

        {state.step === 'discover' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Adopt existing shared services</Subtitle2>
              <Body1>
                Loom scanned the subscriptions your identity can see (Azure Resource Graph) for existing
                instances of each shared service. For each one, choose <b>Reuse</b> an existing resource,
                <b> Deploy new</b>, or <b>Gate</b> (leave unconfigured). Reuse picks flow into the deployment
                as <code>existing&lt;Service&gt;</code> parameters and are validated for region, permissions,
                and SKU/model compatibility — honestly, with no faked checks.
              </Body1>
            </div>

            {discoverError && (
              <MessageBar intent="warning">
                <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{discoverError}</MessageBarBody>
              </MessageBar>
            )}

            {discoverLoading ? (
              <div className={styles.inlineLoad}>
                <Spinner size="tiny" /> <Caption1>Discovering existing shared services via Azure Resource Graph…</Caption1>
              </div>
            ) : (
              <div className={styles.fields} style={{ maxWidth: 'none' }}>
                {SHARED_SERVICES.map((svc) => {
                  const v = itemVisual(svc.visual);
                  const Icon = v.icon;
                  const list = serviceCandidates?.[svc.key] || [];
                  const choice = state.serviceChoices?.[svc.key];
                  const reusePinned = !!svc.oneePerTenant && list.length > 0;
                  const selectedValue =
                    choice?.mode === 'reuse' && choice.candidate
                      ? `reuse:${list.findIndex((c) => c.id === choice.candidate!.id)}`
                      : choice?.mode === 'gate'
                        ? 'gate'
                        : 'new';
                  const selText =
                    choice?.mode === 'reuse' && choice.candidate
                      ? `Reuse ${choice.candidate.name}`
                      : choice?.mode === 'gate'
                        ? 'Gate (leave unconfigured)'
                        : 'Deploy new';
                  return (
                    <div key={svc.key} className={styles.svcCard}>
                      <div className={styles.svcCardHead}>
                        <span className={styles.serviceIconChip} style={{ backgroundColor: `${v.color}1f`, color: v.color, width: 32, height: 32 }} aria-hidden>
                          <Icon />
                        </span>
                        <div className={styles.optionBody} style={{ flex: 1 }}>
                          <span className={styles.optionTitleRow}>
                            <Body1Strong>{svc.label}</Body1Strong>
                            <Badge appearance="tint" color="informative" size="small">
                              {list.length} found
                            </Badge>
                            {reusePinned && <Badge appearance="tint" color="warning" size="small">Reuse required</Badge>}
                          </span>
                          <Caption1 className={styles.railHint}>{svc.note}</Caption1>
                        </div>
                      </div>
                      <Field label="Choice">
                        <Dropdown
                          value={selText}
                          selectedOptions={[selectedValue]}
                          onOptionSelect={(_, d) => setServiceChoice(svc.key, d.optionValue as string)}
                        >
                          {list.map((c, i) => (
                            <Option key={c.id} value={`reuse:${i}`} text={`Reuse ${c.name}`}>
                              Reuse {c.name} — {c.region || '?'} · {c.rg} · {c.subscriptionId}
                            </Option>
                          ))}
                          {!reusePinned && (
                            <Option value="new" text="Deploy new">
                              Deploy new (provision with this landing zone)
                            </Option>
                          )}
                          <Option value="gate" text="Gate (leave unconfigured)">
                            Gate — leave unconfigured (honest MessageBar until set)
                          </Option>
                        </Dropdown>
                      </Field>
                      {validating[svc.key] && (
                        <div className={styles.inlineLoad}>
                          <Spinner size="tiny" /> <Caption1>Validating {svc.label}…</Caption1>
                        </div>
                      )}
                      {choice?.mode === 'reuse' && choice.checks && choice.checks.length > 0 && (
                        <div className={styles.svcChecks}>
                          {choice.checks.map((chk, i) => (
                            <MessageBar
                              key={i}
                              intent={chk.status === 'pass' ? 'success' : chk.status === 'fail' ? 'error' : 'warning'}
                            >
                              <MessageBarBody>
                                <MessageBarTitle>{chk.label}</MessageBarTitle>{' '}
                                {chk.detail}
                              </MessageBarBody>
                            </MessageBar>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <Footer
              onBack={() => go('subscription')}
              onNext={() => go('domain')}
              extra={
                <Button
                  appearance="subtle"
                  icon={<ArrowClockwise20Regular />}
                  onClick={() => { setDiscoverError(undefined); setServiceCandidates(undefined); }}
                  disabled={discoverLoading}
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
            <Footer onBack={() => go('discover')} nextDisabled={!state.domainName} onNext={() => go('capacity')} />
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
            {/* Guided F-SKU → Azure-native compute equivalence (CU / Spark vCores /
                Databricks / ADX / Synapse SQL + relative cost), grounded in Learn. */}
            <CapacityEquivalencePanel sku={state.capacitySku} />
            <Footer onBack={() => go('domain')} nextDisabled={!state.capacitySku} onNext={() => go('review')} />
          </>
        )}

        {state.step === 'review' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Review &amp; deploy</Subtitle2>
              <Body1>
                {isWireExisting
                  ? 'Review the existing Data Landing Zone(s) being wired into this Admin Plane. Wiring grants the Console identity navigator RBAC and patches its environment — no resources are re-provisioned.'
                  : 'Confirm the planned deployment below. When the Setup Orchestrator is deployed it runs the real ' +
                    'az deployment sub create under the orchestrator identity (Contributor on each target subscription); ' +
                    'otherwise Deploy dispatches the GitHub deploy workflow, or returns the exact command to run.'}
              </Body1>
            </div>

            {/* Visual architecture diagram of the planned deployment (reuses the
                T132 React Flow canvas, read-only, built from this wizard's state). */}
            {(() => {
              const adminId = config?.adminSubscriptionId || state.subscriptionId;
              const adminName = config?.adminSubscriptionName || state.subscriptionName;
              let spokes: DiagramSpoke[] = [];
              if (isSingleSub) {
                spokes = [{ domainName: state.domainName || 'default', region: state.location }];
              } else if (isWireNew) {
                const ids = state.dlzSubscriptionIds || [];
                spokes = ids.map((id, i) => ({
                  subscriptionId: id,
                  subscriptionName: state.dlzSubscriptionNames?.[id] || id,
                  domainName: ids.length === 1 ? (state.domainName || 'dlz') : `${state.domainName || 'dlz'}-${i + 1}`,
                  region: state.location,
                }));
              } else if (isWireExisting) {
                spokes = (state.selectedExistingDlzs || []).map((d) => {
                  const found = (state.existingDlzs || []).find(
                    (x) => x.subscriptionId === d.subscriptionId && x.domainName === d.domainName,
                  );
                  return { subscriptionId: d.subscriptionId, subscriptionName: found?.subscriptionName, domainName: d.domainName, region: found?.region || state.location };
                });
              }
              return (
                <div>
                  <Body1Strong>Planned architecture</Body1Strong>
                  <div style={{ marginTop: tokens.spacingVerticalS }}>
                    <SetupDeploymentDiagram
                      boundary={state.boundary}
                      mode={state.mode}
                      adminSubscriptionId={adminId}
                      adminSubscriptionName={adminName}
                      region={state.location}
                      capacitySku={state.capacitySku}
                      spokes={spokes}
                    />
                  </div>
                </div>
              );
            })()}

            <div className={styles.summaryGrid}>
              <SummaryCell label="Boundary" value={state.boundary} />
              <SummaryCell label="Mode" value={state.mode === 'single-sub' ? 'Single-sub' : isWireExisting ? 'Multi-sub · wire existing' : 'Multi-sub · deploy new'} />
              <SummaryCell
                label={isSingleSub ? 'Subscription' : 'Hub subscription'}
                value={config?.adminSubscriptionName || state.subscriptionName}
                sub={config?.adminSubscriptionId || state.subscriptionId}
              />
              {isWireNew && (
                <SummaryCell label="Spoke subscriptions" value={`${state.dlzSubscriptionIds?.length ?? 0} selected`} sub={(state.dlzSubscriptionIds || []).join(', ') || undefined} />
              )}
              {isWireExisting && (
                <SummaryCell label="Existing DLZs" value={`${state.selectedExistingDlzs?.length ?? 0} selected`} sub={(state.selectedExistingDlzs || []).map((d) => d.domainName).join(', ') || undefined} />
              )}
              <SummaryCell label="Region" value={state.location} />
              {!isWireExisting && <SummaryCell label="Domain" value={state.domainName} />}
              {!isWireExisting && <SummaryCell label="Capacity" value={state.capacitySku} />}
            </div>

            {/* Adopt-existing: shared services the deploy will REUSE vs deploy new. */}
            {!isWireExisting && state.serviceChoices && (() => {
              const reused = SHARED_SERVICES
                .map((svc) => ({ svc, c: state.serviceChoices?.[svc.key] }))
                .filter((x) => x.c?.mode === 'reuse' && x.c.candidate);
              const newCount = SHARED_SERVICES.filter((svc) => (state.serviceChoices?.[svc.key]?.mode ?? 'new') === 'new').length;
              const gateCount = SHARED_SERVICES.filter((svc) => state.serviceChoices?.[svc.key]?.mode === 'gate').length;
              return (
                <div>
                  <Body1Strong>Shared services</Body1Strong>
                  <Caption1 className={styles.summaryLabel} style={{ display: 'block', marginTop: 2 }}>
                    {reused.length} reused · {newCount} deploy new · {gateCount} gated
                  </Caption1>
                  {reused.length > 0 && (
                    <div className={styles.summaryGrid} style={{ marginTop: tokens.spacingVerticalS }}>
                      {reused.map(({ svc, c }) => (
                        <SummaryCell
                          key={svc.key}
                          label={`Reuse · ${svc.label}`}
                          value={c!.candidate!.name}
                          sub={`${c!.candidate!.region || '?'} · ${c!.candidate!.rg}${c?.worst ? ` · ${c.worst}` : ''}`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            <Divider />

            {!isWireExisting && (
              <div>
                <Body1Strong>Generated Bicep parameters</Body1Strong>
                <div className={styles.preview}>{bicepPreview}</div>
              </div>
            )}

            <Footer
              onBack={() => go(isWireExisting ? 'subscription' : 'capacity')}
              onNext={deploy}
              nextLabel={isWireExisting ? 'Wire DLZ(s)' : 'Deploy'}
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

/**
 * Region picker: a closed dropdown over the supported regions for the active
 * cloud boundary. Sources from the live ARM `/locations` for the chosen
 * subscription when available (regionSource==='arm'), else the static
 * per-boundary fallback. Never a free-text box (loom-no-freeform-config.md).
 */
function RegionField(props: {
  styles: ReturnType<typeof useStyles>;
  regions: AzureRegion[];
  regionsLoading: boolean;
  regionSource: 'arm' | 'static';
  value?: string;
  isGov: boolean;
  onSelect: (v: string) => void;
}) {
  const { styles, regions, regionsLoading, regionSource, value, isGov, onSelect } = props;
  const selected = value ? regions.find((r) => r.name === value) : undefined;
  return (
    <Field
      label="Region"
      required
      hint={
        regionsLoading
          ? 'Loading regions…'
          : regionSource === 'arm'
            ? "Live list of regions enabled for the selected subscription (Azure Resource Manager)."
            : isGov
              ? 'Azure Government regions for this boundary.'
              : 'Azure Public regions for this boundary.'
      }
    >
      {regionsLoading ? (
        <div className={styles.inlineLoad}><Spinner size="tiny" /> <Caption1>Listing regions…</Caption1></div>
      ) : (
        <Dropdown
          placeholder="Select region"
          value={selected ? `${selected.display} (${selected.name})` : value}
          selectedOptions={value ? [value] : []}
          onOptionSelect={(_, d) => onSelect(d.optionValue as string)}
        >
          {regions.map((r) => (
            <Option key={r.name} value={r.name} text={`${r.display} (${r.name})`}>
              {r.display} — {r.name}
            </Option>
          ))}
        </Dropdown>
      )}
    </Field>
  );
}
