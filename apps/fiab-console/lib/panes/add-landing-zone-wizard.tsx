'use client';

import { clientFetch, CROSS_SUB_FETCH_TIMEOUT_MS } from '@/lib/client-fetch';
/**
 * Add Data Landing Zone — dlz-attach ONLY wizard (audit-t157)
 *
 * Reached from /admin → "Add landing zone". Unlike the first-run Setup Wizard
 * (/setup), this surface can ONLY attach a Data Landing Zone to the ALREADY
 * deployed hub. It has NO boundary step, NO deployment-mode step, and NO
 * "deploy console" affordance — so it is IMPOSSIBLE to deploy a second Console
 * from the UI. Boundary, region and the hub coordinates are read from the
 * Cosmos tenant-topology doc (GET /api/setup/tenant-topology) and shown
 * read-only; the operator never re-types an Azure resource id
 * (loom-no-freeform-config). Every control hits a real backend (no-vaporware):
 *
 *   - target subscription  → GET /api/setup/subscriptions (ARM)
 *   - existing-DLZ collision → GET /api/setup/existing-dlzs (Resource Graph)
 *   - deploy               → POST /api/setup/deploy { topology: 'dlz-attach', … }
 *
 * The deploy returns the orchestrator deploymentId (202), a GitHub run (202),
 * a 403 with the exact `az role assignment create` for the new subscription,
 * a 409 when no hub exists, or a 503 copy-paste command. No fake progress.
 */

import * as React from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
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
  Switch,
  Link,
  mergeClasses,
} from '@fluentui/react-components';
import {
  Send24Regular,
  ArrowClockwise20Regular,
  CheckmarkCircle48Filled,
  Building24Regular,
  Rocket24Regular,
} from '@fluentui/react-icons';
import { CapacityEquivalencePanel } from '@/lib/components/setup/capacity-equivalence-panel';

interface AzureSubscription {
  subscriptionId: string;
  displayName: string;
  state: string;
}

interface HubTopology {
  boundary?: string;
  location?: string;
  hubSubscriptionId?: string;
  hubVnetId?: string;
  hubAdxClusterRgName?: string;
  hubCatalogEndpoint?: string;
}

interface ExistingDlz {
  subscriptionId: string;
  domainName: string;
  region?: string;
  rg: string;
}

/** Result of POST /api/setup/landing-zones/grant (RBAC auto-grant). */
interface GrantState {
  ok: boolean;
  error?: string;
  reason?: string;
  remediation?: string;
  commands?: string[];
  outcomes?: Array<{ role: string; status: string; error?: string }>;
}

/** Client-side view of the async /api/setup/deploy-preflight verdict. */
interface PreflightState {
  status: 'idle' | 'checking' | 'ready' | 'error';
  canDeploy?: boolean;
  /** Which identity was checked — the signed-in user (passthrough) or the Console UAMI. */
  identity?: 'user' | 'uami';
  requiredRole?: string;
  remediation?: string;
  missingProviders?: string[];
  providersHint?: string[];
  error?: string;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAPACITY_OPTIONS: { sku: string; note: string; tag?: string }[] = [
  { sku: 'F2', note: 'Smallest — dev / sandbox' },
  { sku: 'F4', note: 'Light shared workloads' },
  { sku: 'F8', note: 'Recommended for a prod start', tag: 'Recommended' },
  { sku: 'F32', note: 'Department-scale analytics' },
  { sku: 'F64', note: 'Heavy concurrent BI + ML' },
  { sku: 'F128', note: 'Enterprise multi-team' },
  { sku: 'F512', note: 'Largest — mission-scale' },
];

/** The named feature toggles forwarded to main.bicep (no free-form config). */
const FEATURE_TOGGLES: { key: ToggleKey; label: string; desc: string; def: boolean }[] = [
  { key: 'adxEnabled', label: 'Azure Data Explorer (ADX)', desc: 'Real-Time eventhouse / KQL database for this DLZ.', def: true },
  { key: 'cosmosGraphVectorEnabled', label: 'Cosmos graph + vector', desc: 'Gremlin graph + vector index for lineage and semantic search.', def: true },
  { key: 'weaveOntologyEnabled', label: 'Weave ontology', desc: 'Ontology/Weave knowledge layer over the lakehouse.', def: true },
  { key: 'databricksUnityCatalogEnabled', label: 'Databricks Unity Catalog', desc: 'Attach the regional UC metastore + default catalog.', def: true },
  { key: 'databricksSqlWarehouseEnabled', label: 'Databricks SQL Warehouse', desc: 'Serverless SQL Warehouse for this DLZ.', def: true },
];

type ToggleKey =
  | 'adxEnabled'
  | 'cosmosGraphVectorEnabled'
  | 'weaveOntologyEnabled'
  | 'databricksUnityCatalogEnabled'
  | 'databricksSqlWarehouseEnabled';

type Phase = 'form' | 'deploying' | 'done';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '820px' },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow4,
    padding: tokens.spacingVerticalXXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  header: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '560px' },
  hubCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  iconChip: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  hubGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: tokens.spacingHorizontalL, rowGap: tokens.spacingVerticalS },
  cell: { display: 'flex', flexDirection: 'column', gap: '2px' },
  label: { color: tokens.colorNeutralForeground3 },
  toggleRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  toggleDesc: { marginLeft: '44px', marginTop: '-6px' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, paddingTop: tokens.spacingVerticalM },
  inlineLoad: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  doneCenter: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalM, textAlign: 'center', padding: tokens.spacingVerticalL },
  hubCardBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  preWrap: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' },
  preWrapTop: { whiteSpace: 'pre-wrap', marginTop: tokens.spacingVerticalXS, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  preWrapScroll: { whiteSpace: 'pre-wrap', marginTop: tokens.spacingVerticalXS, overflowWrap: 'anywhere', wordBreak: 'break-word', maxHeight: '240px', overflow: 'auto', maxWidth: '100%' },
  successIcon: { color: tokens.colorPaletteGreenForeground1 },
});

export function AddLandingZoneWizardPane() {
  const styles = useStyles();

  // Hub topology — the first-run discriminator + read-only hub coordinates.
  const [hub, setHub] = useState<HubTopology | null>(null);
  const [hubExists, setHubExists] = useState<boolean | null>(null);
  const [hubError, setHubError] = useState<string | undefined>();
  const [hubLoading, setHubLoading] = useState(true);

  const [subs, setSubs] = useState<AzureSubscription[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [subsError, setSubsError] = useState<string | undefined>();

  const [existing, setExisting] = useState<ExistingDlz[]>([]);

  // Async cross-sub deploy pre-flight for the CHOSEN target subscription. It runs
  // BEFORE submit (poll-friendly, no 6s cliff) so the operator sees an honest
  // "you can / can't deploy here" verdict — under their OWN ARM rights
  // (user-passthrough) — and warms the same server SWR slot the deploy reads, so
  // the subsequent Attach never re-pays the cross-sub latency.
  const [preflight, setPreflight] = useState<PreflightState>({ status: 'idle' });

  const [phase, setPhase] = useState<Phase>('form');
  const [targetSubscriptionId, setTargetSubscriptionId] = useState<string>('');
  const [targetSubscriptionName, setTargetSubscriptionName] = useState<string>('');
  const [domainName, setDomainName] = useState('');
  const [capacitySku, setCapacitySku] = useState<string>('F8');
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>(() =>
    FEATURE_TOGGLES.reduce((acc, t) => ({ ...acc, [t.key]: t.def }), {} as Record<ToggleKey, boolean>),
  );

  const [deployStage, setDeployStage] = useState<string>('');
  const [deployProgress, setDeployProgress] = useState(0);
  const [deployError, setDeployError] = useState<string | undefined>();
  const [deploymentId, setDeploymentId] = useState<string | undefined>();
  const [workflowFile, setWorkflowFile] = useState<string | undefined>();

  // RBAC auto-grant — fired after a successful attach so the Console UAMI gets
  // the least-privilege role set (Contributor + minimal data-plane) scoped to
  // the NEW DLZ's resource group, in its own subscription. The grant runs once
  // the DLZ RG exists; on an honest gate (the Console can't write role
  // assignments itself) the route returns the exact RG-scoped `az` command.
  const [grant, setGrant] = useState<GrantState | null>(null);
  const [granting, setGranting] = useState(false);

  const dlzResourceGroup = useMemo(
    () => (domainName && hub?.location ? `rg-csa-loom-dlz-${domainName}-${hub.location}` : ''),
    [domainName, hub?.location],
  );

  const grantRbac = useCallback(async () => {
    if (!targetSubscriptionId || !dlzResourceGroup) return;
    setGranting(true);
    setGrant(null);
    try {
      const res = await clientFetch('/api/setup/landing-zones/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: targetSubscriptionId, resourceGroup: dlzResourceGroup }),
      });
      const j = (await res.json().catch(() => ({}))) as GrantState;
      setGrant({ ...j, ok: res.ok && !!j.ok });
    } catch (e) {
      setGrant({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setGranting(false);
    }
  }, [targetSubscriptionId, dlzResourceGroup]);

  const loadHub = useCallback(async () => {
    setHubLoading(true);
    setHubError(undefined);
    try {
      const res = await clientFetch('/api/setup/tenant-topology');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setHubError(j.error || j.hint || `Could not read tenant topology (HTTP ${res.status}).`);
        setHubExists(null);
        return;
      }
      setHubExists(!!j.exists);
      setHub(j.topology || null);
    } catch (e) {
      setHubError(e instanceof Error ? e.message : String(e));
      setHubExists(null);
    } finally {
      setHubLoading(false);
    }
  }, []);

  const loadSubs = useCallback(async () => {
    setSubsLoading(true);
    setSubsError(undefined);
    try {
      // Cross-sub ARM list can legitimately take many seconds on a large tenant;
      // use the generous cross-sub budget (server SWR-caches so retries are
      // instant) instead of the 6s spinner ceiling that caused the attach cliff.
      const res = await clientFetch('/api/setup/subscriptions', undefined, CROSS_SUB_FETCH_TIMEOUT_MS);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setSubsError(j.error || j.hint || `Could not list subscriptions (HTTP ${res.status}).`);
        setSubs([]);
        return;
      }
      setSubs(j.subscriptions || []);
      if ((j.subscriptions || []).length === 0) {
        setSubsError(
          j.identity === 'user'
            ? 'No subscriptions are visible to your signed-in account. Ask an owner to grant you Reader on the target subscription, then Refresh.'
            : 'No subscriptions are visible to the Console identity. Grant it Reader on the target subscription.',
        );
      }
    } catch (e) {
      setSubsError(e instanceof Error ? e.message : String(e));
      setSubs([]);
    } finally {
      setSubsLoading(false);
    }
  }, []);

  const loadExisting = useCallback(async () => {
    try {
      // Resource Graph DLZ scan spans every visible subscription — same generous
      // cross-sub budget (SWR-cached server-side) as the subscription list.
      const res = await clientFetch('/api/setup/existing-dlzs', undefined, CROSS_SUB_FETCH_TIMEOUT_MS);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) setExisting(j.dlzs || []);
    } catch {
      /* collision hint is best-effort */
    }
  }, []);

  useEffect(() => {
    void loadHub();
  }, [loadHub]);

  useEffect(() => {
    if (hubExists) {
      void loadSubs();
      void loadExisting();
    }
  }, [hubExists, loadSubs, loadExisting]);

  // Async pre-flight poll: whenever a valid target subscription is chosen, ask
  // the poll-friendly deploy-preflight route whether a DLZ can be deployed there
  // (under the operator's own ARM rights). `checking` → poll again; `ready` →
  // show the verdict. Cancelled on unmount / subscription change so a stale
  // subscription's verdict never lands on a newer one.
  useEffect(() => {
    if (!targetSubscriptionId || !GUID_RE.test(targetSubscriptionId)) {
      setPreflight({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setPreflight({ status: 'checking' });
    (async () => {
      // ~30s of polling (20 × 1.5s) — the cold cross-sub read resolves well
      // inside this; each poll is served instantly once the server cache warms.
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        try {
          const res = await clientFetch(
            `/api/setup/deploy-preflight?subscriptionId=${encodeURIComponent(targetSubscriptionId)}`,
            undefined,
            CROSS_SUB_FETCH_TIMEOUT_MS,
          );
          const j = await res.json().catch(() => ({}));
          if (cancelled) return;
          if (!res.ok || !j.ok) {
            setPreflight({ status: 'error', error: j.error || `Pre-flight failed (HTTP ${res.status}).` });
            return;
          }
          if (j.status === 'checking') {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          // status === 'ready'
          setPreflight({
            status: 'ready',
            canDeploy: !!j.canDeploy,
            identity: j.identity,
            requiredRole: j.requiredRole,
            remediation: j.remediation,
            missingProviders: j.missingProviders || [],
            providersHint: j.providersHint,
          });
          return;
        } catch (e) {
          if (cancelled) return;
          setPreflight({ status: 'error', error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      if (!cancelled) setPreflight({ status: 'error', error: 'Pre-flight is taking longer than expected — you can still attempt the attach; it will re-check server-side.' });
    })();
    return () => {
      cancelled = true;
    };
  }, [targetSubscriptionId]);

  // Collision: a DLZ with this domain already exists in the chosen subscription.
  const collision = useMemo(() => {
    if (!domainName || !targetSubscriptionId) return undefined;
    return existing.find((d) => d.subscriptionId === targetSubscriptionId && d.domainName === domainName);
  }, [existing, domainName, targetSubscriptionId]);

  // Block the Attach button only on a DEFINITIVE "cannot deploy" verdict. A
  // `checking` / `error` / `idle` pre-flight is NON-blocking — the deploy route's
  // own hard gate is the source of truth, so a slow/failed prediction never
  // stops an operator who does have rights (matches the server's non-fatal
  // handling). A confirmed `canDeploy:false` disables submit with the honest gate
  // shown below.
  const preflightBlocks = preflight.status === 'ready' && preflight.canDeploy === false;

  const canDeploy =
    !!targetSubscriptionId &&
    GUID_RE.test(targetSubscriptionId) &&
    !!domainName &&
    !!capacitySku &&
    !collision &&
    !preflightBlocks;

  async function deploy() {
    setPhase('deploying');
    setDeployError(undefined);
    setDeployProgress(0);
    setDeployStage('Submitting attach request…');
    try {
      const res = await clientFetch('/api/setup/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topology: 'dlz-attach',
          targetSubscriptionId,
          domainName,
          capacitySku,
          // boundary/region are hub-defined — server fills from tenant-topology,
          // we forward what we know so the diagram/preview match.
          boundary: hub?.boundary,
          location: hub?.location,
          ...toggles,
        }),
      }, CROSS_SUB_FETCH_TIMEOUT_MS);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const t = await res.text().catch(() => '');
        setDeployError(`Deploy service returned non-JSON (HTTP ${res.status}). ${t.slice(0, 200)}`);
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (res.status === 202 && j.ok && j.deploymentMode === 'orchestrator') {
        setDeploymentId(j.deploymentId);
        setDeployStage(`Running on the Setup Orchestrator (deployment ${j.deploymentId})`);
        setDeployProgress(0.5);
        setPhase('done');
        return;
      }
      if (res.status === 202 && j.ok && j.deploymentMode === 'github-workflow-dispatch') {
        setWorkflowFile(j.workflowFile);
        setDeployStage(`Queued on GitHub Actions (${j.workflowFile})`);
        setDeployProgress(0.3);
        setPhase('done');
        return;
      }
      // Day-one path: the deployment was submitted straight to Azure Resource
      // Manager under the signed-in user's delegated token (identity==='user') or
      // the Console identity. Real ARM deployment id — pollable via statusUrl.
      if (res.status === 202 && j.ok && j.deploymentMode === 'user-arm') {
        setDeploymentId(j.deploymentId);
        setDeployStage(
          j.identity === 'user'
            ? `Submitted to Azure under your account (${j.provisioningState || 'Accepted'})`
            : `Submitted to Azure under the Console identity (${j.provisioningState || 'Accepted'})`,
        );
        setDeployProgress(0.4);
        setPhase('done');
        return;
      }
      if (res.status === 403 || j.error === 'forbidden') {
        const rem = typeof j.remediation === 'string' ? `\n\n${j.remediation}` : '';
        setDeployError(`You don't have permission to attach a Data Landing Zone (requires ${j.requiredRole || 'Contributor'}).${rem}`);
        return;
      }
      if (!res.ok) {
        const msg = j.remediation?.message || j.error || `HTTP ${res.status}`;
        const commands = j.remediation?.commands ? '\n\n' + j.remediation.commands.join('\n') : '';
        setDeployError(msg + commands);
        return;
      }
      setDeploymentId(j.deploymentId);
      setDeployStage('Submitted');
      setDeployProgress(1);
      setPhase('done');
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Loading / no-hub / hub-error states ───────────────────────────────────
  if (hubLoading) {
    return (
      <div className={styles.root}>
        <div className={styles.panel}>
          <div className={styles.inlineLoad}>
            <Spinner size="tiny" /> <Body1>Reading the deployed hub topology…</Body1>
          </div>
        </div>
      </div>
    );
  }

  if (hubError) {
    return (
      <div className={styles.root}>
        <div className={styles.panel}>
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Could not read the hub topology</MessageBarTitle>
              <div className={styles.preWrap}>{hubError}</div>
            </MessageBarBody>
          </MessageBar>
          <div className={styles.footer}>
            <span />
            <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={() => void loadHub()}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!hubExists) {
    return (
      <div className={styles.root}>
        <div className={styles.panel}>
          <div className={styles.header}>
            <Subtitle2>No hub is deployed yet</Subtitle2>
            <Body1>
              The "Add landing zone" wizard attaches a Data Landing Zone to an existing CSA Loom hub.
              No hub (Admin Plane / Console) is deployed in this tenant yet.
            </Body1>
          </div>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Run the first-run setup first</MessageBarTitle>
              Install the Admin Plane with the first-run <Link href="/setup">Setup Wizard</Link>. Once the
              hub is deployed, this page will let you attach additional landing zones to it.
            </MessageBarBody>
          </MessageBar>
        </div>
      </div>
    );
  }

  // ── Done state ─────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <div className={styles.root}>
        <div className={styles.panel}>
          <div className={styles.doneCenter}>
            <CheckmarkCircle48Filled className={styles.successIcon} aria-hidden />
            <Title2>Attach submitted</Title2>
            <Body1>
              "{domainName}" is being attached to the hub.
              {deploymentId && <> Deployment ID: <code>{deploymentId}</code></>}
              {workflowFile && <> Workflow: <code>{workflowFile}</code></>}
            </Body1>
            {/* RBAC auto-grant — set the Console UAMI's least-privilege roles on
                the new DLZ's resource group so it can manage/deploy into it. The
                DLZ RG materializes during the attach; this grant can be run as
                soon as it exists. On an honest gate the exact RG-scoped command
                is shown (no raw error). */}
            <MessageBar intent={grant?.ok ? 'success' : grant && !grant.ok ? 'warning' : 'info'}>
              <MessageBarBody>
                <MessageBarTitle>
                  {grant?.ok
                    ? 'Console RBAC granted on the new landing zone'
                    : grant && !grant.ok
                      ? grant.commands?.length
                        ? 'Run this grant as an operator with RBAC rights'
                        : 'Could not grant RBAC automatically'
                      : 'Grant the Console RBAC on the new landing zone'}
                </MessageBarTitle>
                {grant?.ok ? (
                  <>
                    The Console now holds the least-privilege role set (Contributor + minimal
                    data-plane) scoped to <code>{dlzResourceGroup}</code> — it can see, attach,
                    create, and deploy into this landing zone.
                  </>
                ) : grant && !grant.ok ? (
                  <>
                    <div className={styles.preWrapTop}>{grant.remediation || grant.error || 'Unknown error.'}</div>
                    {grant.commands?.length ? (
                      <pre className={styles.preWrapScroll}>{grant.commands.join('\n')}</pre>
                    ) : null}
                  </>
                ) : (
                  <>
                    Once the resource group <code>{dlzResourceGroup || 'rg-csa-loom-dlz-…'}</code>{' '}
                    exists, click below to assign the Console UAMI Contributor (+ the minimal
                    data-plane roles) scoped to that resource group — least-privilege, in the DLZ&apos;s
                    own subscription.
                  </>
                )}
                {(!grant || !grant.ok) && (
                  <div style={{ marginTop: tokens.spacingVerticalM }}>
                    <Button
                      appearance="primary"
                      size="small"
                      icon={granting ? <Spinner size="tiny" /> : <Send24Regular />}
                      disabled={granting || !dlzResourceGroup}
                      onClick={() => void grantRbac()}
                    >
                      {granting ? 'Granting…' : grant && !grant.ok ? 'Retry grant' : 'Grant Console RBAC'}
                    </Button>
                  </div>
                )}
              </MessageBarBody>
            </MessageBar>
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Next steps</MessageBarTitle>
                Configure mirroring from your source systems, define Activator rules over the ADX
                database, and build a semantic model on the gold layer for the new landing zone.
                <Link href="/learn?topic=setup-wizard"> Learn more</Link>
              </MessageBarBody>
            </MessageBar>
            <Button
              appearance="primary"
              icon={<Rocket24Regular />}
              onClick={() => {
                setPhase('form');
                setDomainName('');
                setTargetSubscriptionId('');
                setTargetSubscriptionName('');
                setDeploymentId(undefined);
                setWorkflowFile(undefined);
                setGrant(null);
              }}
            >
              Attach another
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Deploying state ──────────────────────────────────────────────────────
  if (phase === 'deploying') {
    return (
      <div className={styles.root}>
        <div className={styles.panel}>
          <div className={styles.header}>
            <Subtitle2>{deployError ? 'Attach could not start' : 'Attaching…'}</Subtitle2>
          </div>
          {!deployError && (
            <>
              <ProgressBar value={deployProgress} thickness="large" />
              <div className={styles.inlineLoad}><Spinner size="tiny" /><Body1>{deployStage}</Body1></div>
            </>
          )}
          {deployError && (
            <>
              <MessageBar intent={/az role assignment|az deployment sub create/.test(deployError) ? 'warning' : 'error'}>
                <MessageBarBody>
                  <MessageBarTitle>
                    {/az role assignment/.test(deployError) ? 'Grant the orchestrator Contributor on the new subscription' : 'Attach error'}
                  </MessageBarTitle>
                  <div className={styles.preWrapTop}>{deployError}</div>
                </MessageBarBody>
              </MessageBar>
              <div className={styles.footer}>
                <Button appearance="subtle" onClick={() => { setPhase('form'); setDeployError(undefined); }}>Back</Button>
                <Button appearance="primary" onClick={deploy}>Retry attach</Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <div className={styles.root}>
      <div className={styles.panel}>
        <div className={styles.header}>
          <Subtitle2>Add a Data Landing Zone</Subtitle2>
          <Body1>
            Attach a new Data Landing Zone to your deployed hub. The cloud boundary, region and hub
            coordinates are inherited from the hub (shown below, read-only) — you only choose the new
            subscription, a domain name, capacity sizing, and which services to enable.
          </Body1>
        </div>

        {/* Read-only hub coordinates (from the tenant-topology doc). This is the
            TARGET the new DLZ will attach to — shown read-only so the operator
            never re-types an Azure id. It is NOT a pending status; the attach is
            an explicit action below. */}
        <div className={styles.hubCard}>
          <span className={styles.iconChip} aria-hidden><Building24Regular /></span>
          <div className={styles.hubCardBody}>
            <Body1Strong>Target hub (read-only)</Body1Strong>
            <Caption1 className={styles.label}>
              The new landing zone will attach to this already-deployed hub. These coordinates are
              inherited automatically — you don’t enter them.
            </Caption1>
            <div className={styles.hubGrid}>
              <div className={styles.cell}>
                <Caption1 className={styles.label}>Boundary</Caption1>
                <Body1Strong>{hub?.boundary || '—'}</Body1Strong>
              </div>
              <div className={styles.cell}>
                <Caption1 className={styles.label}>Region</Caption1>
                <Body1Strong>{hub?.location || '—'}</Body1Strong>
              </div>
              <div className={styles.cell}>
                <Caption1 className={styles.label}>Hub subscription</Caption1>
                <Body1Strong>{hub?.hubSubscriptionId || '—'}</Body1Strong>
              </div>
              <div className={styles.cell}>
                <Caption1 className={styles.label}>Shared ADX RG</Caption1>
                <Body1Strong>{hub?.hubAdxClusterRgName || '—'}</Body1Strong>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.fields}>
          <Field label="Target subscription (new DLZ)" required hint="The new Data Landing Zone is provisioned into this subscription. The orchestrator identity must hold Contributor here.">
            {subsLoading ? (
              <div className={styles.inlineLoad}><Spinner size="tiny" /> <Caption1>Listing subscriptions from Azure Resource Manager…</Caption1></div>
            ) : (
              <Dropdown
                placeholder={subs.length ? 'Select the target subscription' : 'No subscriptions available'}
                disabled={subs.length === 0}
                value={targetSubscriptionName || targetSubscriptionId}
                selectedOptions={targetSubscriptionId ? [targetSubscriptionId] : []}
                onOptionSelect={(_, d) => {
                  const chosen = subs.find((x) => x.subscriptionId === d.optionValue);
                  setTargetSubscriptionId(d.optionValue as string);
                  setTargetSubscriptionName(chosen?.displayName || '');
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
              <MessageBarBody className={styles.preWrap}>{subsError}</MessageBarBody>
            </MessageBar>
          )}

          {/* Async permission pre-flight for the chosen subscription — progress,
              not failure. Checked under the operator's OWN ARM rights
              (user-passthrough), falling back to the Console identity. */}
          {targetSubscriptionId && GUID_RE.test(targetSubscriptionId) && (
            <>
              {preflight.status === 'checking' && (
                <div className={styles.inlineLoad}>
                  <Spinner size="tiny" />{' '}
                  <Caption1>Checking your deploy permission on this subscription…</Caption1>
                </div>
              )}
              {preflight.status === 'ready' && preflight.canDeploy && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Ready to deploy here</MessageBarTitle>
                    {preflight.identity === 'user'
                      ? 'Your signed-in account has Contributor on this subscription.'
                      : 'The Console identity has Contributor on this subscription.'}
                    {preflight.providersHint?.length ? (
                      <>
                        {' '}Some resource providers still need registering:
                        <pre className={styles.preWrapScroll}>{preflight.providersHint.join('\n')}</pre>
                      </>
                    ) : null}
                  </MessageBarBody>
                </MessageBar>
              )}
              {preflight.status === 'ready' && preflight.canDeploy === false && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>
                      {preflight.identity === 'user'
                        ? `You don’t have permission to deploy here (requires ${preflight.requiredRole || 'Contributor'})`
                        : `The Console identity can’t deploy here (requires ${preflight.requiredRole || 'Contributor'})`}
                    </MessageBarTitle>
                    <div className={styles.preWrapTop}>
                      {preflight.remediation ||
                        'A subscription-scoped deployment requires the Contributor role on the target subscription.'}
                    </div>
                  </MessageBarBody>
                </MessageBar>
              )}
              {preflight.status === 'error' && (
                <MessageBar intent="info">
                  <MessageBarBody className={styles.preWrap}>
                    {preflight.error || 'Could not pre-check deploy permission; the attach will re-check server-side.'}
                  </MessageBarBody>
                </MessageBar>
              )}
            </>
          )}

          <Field
            label="DLZ domain name"
            required
            hint={
              domainName
                ? `Resource group: rg-csa-loom-dlz-${domainName}-${hub?.location ?? 'region'}`
                : 'Lowercase letters, digits, and hyphens only. e.g. finance, procurement, mission-ops'
            }
          >
            <Input
              value={domainName}
              onChange={(_, d) => setDomainName(d.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="finance, procurement, mission-ops…"
            />
          </Field>
          {collision && (
            <MessageBar intent="error">
              <MessageBarBody>
                A Data Landing Zone "{collision.domainName}" already exists in this subscription
                (<code>{collision.rg}</code>). Choose a different domain name or subscription.
              </MessageBarBody>
            </MessageBar>
          )}

          <Field label="Capacity equivalence" required>
            <Dropdown
              placeholder="Select capacity"
              value={capacitySku}
              selectedOptions={capacitySku ? [capacitySku] : []}
              onOptionSelect={(_, d) => setCapacitySku(d.optionValue as string)}
            >
              {CAPACITY_OPTIONS.map((c) => (
                <Option key={c.sku} value={c.sku} text={c.sku}>
                  {c.sku} — {c.note}{c.tag ? ` (${c.tag})` : ''}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </div>

        <CapacityEquivalencePanel sku={capacitySku} />

        <Divider />

        <div className={styles.header}>
          <Body1Strong>Services to enable</Body1Strong>
          <Caption1 className={styles.label}>Each toggle maps to a named main.bicep feature flag for this landing zone.</Caption1>
        </div>
        <div className={styles.fields}>
          {FEATURE_TOGGLES.map((t) => (
            <div key={t.key} className={styles.toggleRow}>
              <Switch
                checked={toggles[t.key]}
                onChange={(_, d) => setToggles((s) => ({ ...s, [t.key]: !!d.checked }))}
                label={t.label}
              />
              <Caption1 className={mergeClasses(styles.label, styles.toggleDesc)}>{t.desc}</Caption1>
            </div>
          ))}
        </div>

        <div className={styles.footer}>
          <Button
            appearance="subtle"
            icon={<ArrowClockwise20Regular />}
            onClick={() => { setSubs([]); void loadSubs(); void loadExisting(); }}
            disabled={subsLoading}
          >
            Refresh
          </Button>
          <Button appearance="primary" icon={<Send24Regular />} disabled={!canDeploy} onClick={deploy}>
            Attach landing zone
          </Button>
        </div>
        {!canDeploy && (
          <Caption1 className={styles.label}>
            <Badge appearance="tint" color="informative" size="small">Required</Badge>{' '}
            Choose a target subscription, a unique domain name, and a capacity SKU to continue.
          </Caption1>
        )}
      </div>
    </div>
  );
}
