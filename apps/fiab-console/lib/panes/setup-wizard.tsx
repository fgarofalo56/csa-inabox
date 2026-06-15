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
import { CapacityEquivalencePanel } from '@/lib/components/setup/capacity-equivalence-panel';
import { ServiceScanPanel } from '@/lib/components/setup/service-scan-panel';
import { SetupDeploymentDiagram, type DiagramSpoke } from '@/lib/components/setup/deployment-diagram';
import { SetupIdentityCard } from '@/lib/panes/setup-identity-step';
import { SetupServiceChoices, type ServiceChoiceMap } from '@/lib/panes/setup-service-choices';
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
  | 'domain'
  | 'capacity'
  | 'services'
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
  /**
   * Org-visuals (Embed codes F22 + Organizational visuals F23) opt-out. Default
   * on — the deploy provisions the org-visuals container grant + wires
   * LOOM_ORG_VISUALS_URL. undefined/true → enabled; false → those panes
   * honest-gate (the medallion lake is unaffected). Threaded to main.bicep's
   * loomOrgVisualsEnabled via the deploy payload.
   */
  loomOrgVisualsEnabled?: boolean;
  /**
   * Storage scan "use-existing" choice: a pre-existing HNS (Data Lake) account
   * to reuse instead of provisioning a new one (the post-deploy bootstrap wires
   * the medallion + org-visuals env from it). Empty = provision new.
   */
  existingLoomStorageAccount?: string;
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
  /**
   * Pre-deploy scan-and-choose decisions (the in-console twin of
   * scripts/csa-loom/scan-and-deploy.sh). Keyed by service ('aisearch', …);
   * threaded into the deploy POST as `serviceChoices` so the deploy provisions
   * new / reuses an existing instance / disables per the operator's choice.
   */
  serviceChoices?: ServiceChoiceMap;
}

const REGION_BOUNDARY = (b?: Boundary): RegionBoundary => (b ?? 'Commercial') as RegionBoundary;

/** The ordered, user-facing steps shown in the rail (intro/deploying/done are transient). */
/** Note: 'multi-sub-choice' is inserted dynamically after 'mode' when mode='multi-sub'. */
const RAIL_STEPS: { key: Step; label: string; hint: string }[] = [
  { key: 'boundary', label: 'Cloud boundary', hint: 'Where Loom runs' },
  { key: 'mode', label: 'Deployment mode', hint: 'Single or multi-sub' },
  { key: 'subscription', label: 'Subscription & region', hint: 'Deploy target' },
  { key: 'domain', label: 'Domain name', hint: 'Landing-zone name' },
  { key: 'capacity', label: 'Capacity sizing', hint: 'Compute equivalence' },
  { key: 'services', label: 'Scan & choose', hint: 'Reuse / new / disable' },
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
    ...(s.loomOrgVisualsEnabled === false
      ? [`param loomOrgVisualsEnabled = false  // Embed codes / Org visuals honest-gated`]
      : s.existingLoomStorageAccount
        ? [`// Reuse existing Data Lake: ${s.existingLoomStorageAccount} (org-visuals env wired post-deploy)`]
        : []),
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

  // Storage / org-visuals scan-and-choose (deploy-readiness). Discovers existing
  // HNS (Data Lake) accounts via /api/setup/existing-storage so the operator can
  // use-existing / provision-new / disable org-visuals. Recommendation =
  // provision-new (Loom needs its exact medallion + org-visuals container layout).
  const [storageScan, setStorageScan] = useState<
    Array<{ name: string; rg: string; location: string; subscriptionId: string; isLoomNamed: boolean }>
  >([]);
  const [storageScanLoading, setStorageScanLoading] = useState(false);
  const [storageScanError, setStorageScanError] = useState<string | undefined>();
  const [storageScanned, setStorageScanned] = useState(false);
  const scanStorage = useCallback(async () => {
    setStorageScanLoading(true);
    setStorageScanError(undefined);
    try {
      const res = await fetch('/api/setup/existing-storage');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setStorageScanError(j.error || `Storage scan failed (HTTP ${res.status}).`);
        setStorageScan([]);
      } else {
        setStorageScan(Array.isArray(j.accounts) ? j.accounts : []);
      }
    } catch (e) {
      setStorageScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setStorageScanLoading(false);
      setStorageScanned(true);
    }
  }, []);

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
      case 'capacity': return !!state.capacitySku;
      // Scan & choose is optional (recommended defaults are pre-seeded), so the
      // step is "complete" once the operator has progressed past capacity.
      case 'services': return !!state.capacitySku;
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
              onNext={() => go(isWireExisting ? 'review' : 'domain')}
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
            {/* Guided F-SKU → Azure-native compute equivalence (CU / Spark vCores /
                Databricks / ADX / Synapse SQL + relative cost), grounded in Learn. */}
            <CapacityEquivalencePanel sku={state.capacitySku} />
            <Footer onBack={() => go('domain')} nextDisabled={!state.capacitySku} onNext={() => go('services')} />
          </>
        )}

        {state.step === 'services' && (
          <>
            <div className={styles.stepHeader}>
              <Subtitle2>Scan &amp; choose backends</Subtitle2>
              <Body1>
                Loom scans every subscription you can see and recommends, per service, whether to reuse an
                existing instance or provision a new one. The default is everything-ON — keep the
                recommendations or adjust any service. This is the same scan the CLI{' '}
                <code>scripts/csa-loom/scan-and-deploy.sh</code> runs.
              </Body1>
            </div>
            <SetupServiceChoices
              value={state.serviceChoices ?? {}}
              onChange={(next) => setState((s) => ({ ...s, serviceChoices: next }))}
            />
            <Footer onBack={() => go('capacity')} onNext={() => go('review')} />
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

            {/* Identity & admin scan-and-choose (deploy-readiness, GH #1383):
                pick existing/new/disable for the Entra sign-in app + the
                bootstrap admin (signed-in user recommended) before deploy. */}
            <SetupIdentityCard />

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

            <Divider />

            {!isWireExisting && (() => {
              // Storage / OneLake / org-visuals scan-and-choose. The medallion
              // lake is always provisioned (foundational); this card governs the
              // org-visuals container grant + LOOM_ORG_VISUALS_URL (Embed codes
              // F22 + Org visuals F23) and lets the operator reuse an existing
              // HNS lake. Recommendation = provision-new.
              const storageChoice: 'new' | 'existing' | 'disable' =
                state.loomOrgVisualsEnabled === false
                  ? 'disable'
                  : state.existingLoomStorageAccount
                    ? 'existing'
                    : 'new';
              return (
                <div style={{ marginBottom: tokens.spacingVerticalM }}>
                  <Body1Strong>Storage &amp; organizational visuals</Body1Strong>
                  <div style={{ marginTop: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalS }}>
                    <Caption1>
                      The medallion data lake (bronze/silver/gold) is always provisioned. Choose how to handle the
                      org-visuals container that backs Embed codes &amp; Organizational visuals. Recommended: provision new.
                    </Caption1>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS }}>
                    <Button
                      size="small"
                      appearance={storageChoice === 'new' ? 'primary' : 'secondary'}
                      onClick={() => setState((s) => ({ ...s, loomOrgVisualsEnabled: undefined, existingLoomStorageAccount: undefined }))}
                    >
                      Provision new (recommended)
                    </Button>
                    <Button
                      size="small"
                      appearance={storageChoice === 'existing' ? 'primary' : 'secondary'}
                      onClick={() => {
                        if (!storageScanned) void scanStorage();
                        setState((s) => ({ ...s, loomOrgVisualsEnabled: undefined }));
                      }}
                    >
                      Use existing
                    </Button>
                    <Button
                      size="small"
                      appearance={storageChoice === 'disable' ? 'primary' : 'secondary'}
                      onClick={() => setState((s) => ({ ...s, loomOrgVisualsEnabled: false, existingLoomStorageAccount: undefined }))}
                    >
                      Disable org-visuals
                    </Button>
                  </div>
                  {storageChoice === 'existing' && (
                    <div style={{ marginBottom: tokens.spacingVerticalS }}>
                      {storageScanLoading && (
                        <div className={styles.inlineLoad}><Spinner size="tiny" /><Caption1>Scanning subscriptions for Data Lake accounts…</Caption1></div>
                      )}
                      {storageScanError && (
                        <MessageBar intent="error"><MessageBarBody>{storageScanError}</MessageBarBody></MessageBar>
                      )}
                      {!storageScanLoading && !storageScanError && storageScanned && storageScan.length === 0 && (
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            No HNS (Data Lake) accounts are visible to the Console identity — provision new instead, or grant
                            it Reader on the subscription holding your lake and rescan.
                          </MessageBarBody>
                        </MessageBar>
                      )}
                      {storageScan.length > 0 && (
                        <Dropdown
                          size="small"
                          placeholder="Select an existing Data Lake account"
                          selectedOptions={state.existingLoomStorageAccount ? [state.existingLoomStorageAccount] : []}
                          value={state.existingLoomStorageAccount || ''}
                          onOptionSelect={(_e, d) =>
                            setState((s) => ({ ...s, existingLoomStorageAccount: d.optionValue, loomOrgVisualsEnabled: undefined }))
                          }
                        >
                          {storageScan.map((a) => (
                            <Option key={`${a.subscriptionId}/${a.name}`} value={a.name} text={a.name}>
                              {a.name}{a.isLoomNamed ? '  (Loom lake)' : ''} — {a.rg} · {a.location}
                            </Option>
                          ))}
                        </Dropdown>
                      )}
                    </div>
                  )}
                  {storageChoice === 'disable' && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        Embed codes &amp; Organizational visuals will show their config gate (no SAS minting). The medallion
                        lake and all other surfaces are unaffected. You can enable it later by redeploying with org-visuals on.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              );
            })()}

            {!isWireExisting && (
              <div>
                <Body1Strong>Generated Bicep parameters</Body1Strong>
                <div className={styles.preview}>{bicepPreview}</div>
              </div>
            )}

            {!isWireExisting && (
              <>
                <Divider />
                <ServiceScanPanel boundary={state.boundary || 'Commercial'} />
              </>
            )}

            <Footer
              onBack={() => go(isWireExisting ? 'subscription' : 'services')}
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
