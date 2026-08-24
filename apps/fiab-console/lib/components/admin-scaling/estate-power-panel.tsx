'use client';

/**
 * ESTATE POWER — the pause / resume switch (PRP: estate-pause-resume, W5).
 *
 * Extracted from `app/admin/scaling/page.tsx` on 2026-08-23. That page went
 * from 1148 to 1814 LOC when this panel landed and tripped the repository's
 * monolith-creep guard (`scripts/ci/check-file-size.mjs`, 1500-LOC warn
 * ceiling); splitting by bounded context is the fix that guard names, and this
 * panel was already a self-contained context — it took `styles` as a prop and
 * shared no state with the scaling page around it.
 *
 * `styles` is typed structurally rather than as `ReturnType<typeof useStyles>`
 * so this module does not import back from the page it is rendered by.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Body1, Caption1, Button, MessageBar, MessageBarBody, MessageBarTitle,
  Input, tokens, Badge, ProgressBar, Spinner, Subtitle2,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
} from '@fluentui/react-components';
import {
  PauseCircle24Regular, PlayCircle24Regular, ArrowSync24Regular,
  CheckmarkCircle24Filled, ErrorCircle24Filled, Timer24Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { jsonGet } from '@/lib/components/admin-scaling/json-get';

// ===========================================================================
// ESTATE POWER — the pause / resume switch (PRP: estate-pause-resume, W5)
//
// This is the surface the operator asked for: "where is the pause/stop button
// and how do I test it?". It lives at the TOP of /admin/scaling because
// /admin/capacity:441 already promises this capability in prose and links here,
// which made that promise a live no-vaporware.md violation until now.
//
// Three things this panel does that a naive version would not:
//
//  1. It shows the DRY RUN before the confirm, with the owning tag on every
//     row (R-SCOPE-4). The operator sees exactly which resources are in scope
//     and why, before anything stops. 12 of the 23 pausable resources in these
//     subscriptions belong to ten unrelated projects; the preview is how you
//     know none of them is in the list.
//
//  2. It states its POPULATION, including when that population is ZERO. An
//     empty list next to an enabled Pause button is indistinguishable from a
//     broken feature, so an empty scope disables the button and explains which
//     ownership signal is missing (#3922).
//
//  3. It renders RESUME progress as PER-RESOURCE state, never a spinner. A
//     resume is ~15 minutes at best, and RESUME_FAILED is a loud, distinct,
//     terminal state with a remediation per resource — never a bar that
//     eventually says "done".
// ===========================================================================

type EstateState = 'RUNNING' | 'PAUSING' | 'PAUSED' | 'RESUMING' | 'RESUME_FAILED';

interface EstateProgressRow {
  resourceId: string;
  name: string;
  resourceType: string;
  powerState: string;
  expectation: 'running' | 'stopped';
  atExpectedState: boolean;
  phase: 'done' | 'in-flight' | 'unknown' | 'failed';
  detail: string;
  servable?: boolean;
  probed?: boolean;
  typicalResumeSeconds?: number;
}

/** How each estate state is presented. Colour + label + icon in one place. */
const ESTATE_PRESENTATION: Record<EstateState, {
  label: string;
  color: 'success' | 'warning' | 'danger' | 'informative' | 'brand';
  accent: string;
  hint: string;
}> = {
  RUNNING: {
    label: 'Running',
    color: 'success',
    accent: tokens.colorPaletteGreenBorderActive,
    hint: 'Every Loom-owned resource in scope is up. Compute is billing.',
  },
  PAUSING: {
    label: 'Pausing…',
    color: 'warning',
    accent: tokens.colorPaletteYellowBorderActive,
    hint: 'Pause verbs are accepted; Loom is re-reading Azure to confirm each resource actually stopped.',
  },
  PAUSED: {
    label: 'Paused',
    color: 'informative',
    accent: tokens.colorPaletteBlueBorderActive,
    hint: 'Every in-scope resource is CONFIRMED stopped by a fresh read from Azure. Data is intact; compute is not billing.',
  },
  RESUMING: {
    label: 'Resuming…',
    color: 'warning',
    accent: tokens.colorPaletteYellowBorderActive,
    hint: 'Resume is in flight. Loom reports Running only once every resource answers a real request, not merely when Azure reports it online.',
  },
  RESUME_FAILED: {
    label: 'Resume failed',
    color: 'danger',
    accent: tokens.colorPaletteRedBorderActive,
    hint: 'At least one resource is NOT confirmed back up. This is not a display state — those resources are unusable until the remediation below is applied.',
  },
};

export function EstatePowerPanel({ styles }: { styles: Record<string, string> }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'pause' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  // The elapsed clock is a mirror ref as well as state: the poll callback is
  // captured by an interval and would otherwise read a stale `data`.
  const dataRef = useRef<any>(null);
  dataRef.current = data;

  const refresh = useCallback(async () => {
    const j = await jsonGet('/api/admin/estate/state');
    setData(j);
    setLoading(false);
    // A gate (503) is a real answer, not a spinner. Surface it verbatim.
    if (j?.ok === false && j?.error) setError(j.error);
    else setError(null);
    return j;
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while a transition is in flight. 10s: fast enough that the operator
  // sees movement, slow enough that a resume poll's data-plane probes do not
  // hammer a warming engine.
  useEffect(() => {
    const state: EstateState | undefined = data?.state;
    if (state !== 'PAUSING' && state !== 'RESUMING') return;
    const t = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(t);
  }, [data?.state, refresh]);

  const state: EstateState = (data?.state as EstateState) ?? 'RUNNING';
  const present = ESTATE_PRESENTATION[state] ?? ESTATE_PRESENTATION.RUNNING;
  const population = data?.population;
  const preview: Array<Record<string, any>> = data?.preview?.wouldPause ?? [];
  const progress: EstateProgressRow[] = data?.progress ?? [];
  const risks: Array<Record<string, any>> = data?.risks ?? [];
  const outOfTier: Array<Record<string, any>> = data?.outOfTier ?? [];
  const estateId: string = data?.estateId ?? '';
  // `armed === false` means LOOM_ESTATE_PAUSE_ENABLED is unset while the deploy
  // DOES name resources. That is a different state from "nothing is in scope",
  // and conflating them is what made the first version of this PR misreport its
  // own merge risk.
  const notArmed = population?.armed === false;
  const canPause = state === 'RUNNING' && !notArmed && !population?.empty && preview.length > 0;
  const canResume = state === 'PAUSED' || state === 'RESUME_FAILED';

  async function doPause() {
    setBusy('pause');
    setError(null);
    setNotice(null);
    try {
      const r = await clientFetch('/api/admin/estate/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim(), confirmToken: data?.confirmToken }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Pause failed (${r.status})`);
      setNotice(j.message || 'Pause dispatched.');
      setConfirmOpen(false);
      setTyped('');
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doResume() {
    setBusy('resume');
    setError(null);
    setNotice(null);
    try {
      const r = await clientFetch('/api/admin/estate/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Resume failed (${r.status})`);
      setNotice(j.message || 'Resume dispatched.');
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  const previewColumns: LoomColumn<any>[] = [
    {
      key: 'name', label: 'Resource', width: 220,
      render: (r) => (
        <div className={styles.resourceCell}>
          <Caption1><strong>{r.name}</strong></Caption1>
          <Caption1 className={styles.subtle}>{r.resourceType}</Caption1>
        </div>
      ),
    },
    {
      key: 'resourceGroup', label: 'Resource group', width: 220,
      render: (r) => <Caption1 className={styles.subtle}>{r.resourceGroup}</Caption1>,
    },
    {
      key: 'owner', label: 'Owned because', width: 300, sortable: false, filterable: false,
      render: (r) => (
        <div className={styles.progressLabel}>
          <div className={styles.badgeRow}>
            <Badge appearance="tint" color="brand">
              {r.owningTagKey ? `${r.owningTagKey}=${r.owningTagValue}` : r.ownershipSource}
            </Badge>
          </div>
          <Caption1 className={styles.progressDetail}>{r.ownershipReason}</Caption1>
        </div>
      ),
    },
    {
      key: 'mechanism', label: 'How it stops', width: 160, sortable: false, filterable: false,
      render: (r) => <Caption1 className={styles.subtle}>{r.mechanism}</Caption1>,
    },
    {
      key: 'risk', label: 'Resume risk', width: 240, sortable: false, filterable: false,
      render: (r) => {
        const risk = risks.find((x) => x.resourceId === r.resourceId);
        if (!risk) return <Caption1 className={styles.subtle}>—</Caption1>;
        return (
          <div className={styles.progressLabel}>
            <div className={styles.badgeRow}>
              <Badge appearance="tint" color={risk.risk === 'high' ? 'warning' : 'informative'}>
                {risk.risk === 'high' ? 'Capacity-constrained' : 'No capacity contention'}
              </Badge>
              {/* The LIVE SKU, read from authoritative ARM — this is the thing
                  that has to be re-acquired on resume, so the risk names it. */}
              {risk.sku && <Badge appearance="tint" color="subtle">{risk.sku}</Badge>}
              {risk.powerState && <Badge appearance="tint" color="subtle">{risk.powerState}</Badge>}
            </div>
            {risk.fallbackSku?.name && (
              <Caption1 className={styles.progressDetail}>Declared fallback: {risk.fallbackSku.name}</Caption1>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className={styles.powerCard}>
      <div className={styles.powerAccent} style={{ backgroundColor: present.accent }} aria-hidden />

      <div className={styles.powerHeader}>
        <div className={styles.powerTitleWrap}>
          <span className={styles.powerIcon} style={{ backgroundColor: present.accent }} aria-hidden>
            {state === 'RUNNING' ? <PauseCircle24Regular /> : <PlayCircle24Regular />}
          </span>
          <div className={styles.powerTitle}>
            <div className={styles.badgeRow}>
              <Subtitle2>Estate power</Subtitle2>
              <Badge appearance="filled" color={present.color}>{present.label}</Badge>
              <LearnPopover
                title="Pausing the estate"
                content={
                  'Pause issues each backing service’s NATIVE pause verb — Synapse pause, ADX stop, '
                  + 'Analysis Services suspend, scale-set capacity 0. Nothing is deleted and no data is '
                  + 'touched; only compute stops billing. Resume restores each resource to exactly the '
                  + 'state and SKU recorded in a snapshot taken at pause time.'
                }
                tips={[
                  'Scope is per RESOURCE, from the loom-estate-id tag or the deploy manifest — never a whole subscription',
                  'Azure does not reserve capacity while a resource is stopped: a resume can fail with a capacity error',
                  'Resume is ~15 minutes at best; Loom reports Running only after a real request succeeds',
                ]}
                learnMoreHref="https://learn.microsoft.com/fabric/enterprise/pause-resume"
              />
            </div>
            <Caption1 className={styles.powerSub}>
              {present.hint}
              {estateId && <> Estate <span className={styles.mono}>{estateId}</span>.</>}
            </Caption1>
          </div>
        </div>

        <div className={styles.powerActions}>
          <Button appearance="secondary" icon={<ArrowSync24Regular />} disabled={loading || !!busy}
            onClick={() => { void refresh(); }}>
            Refresh
          </Button>

          {canResume && (
            <Button appearance="primary" icon={<PlayCircle24Regular />} disabled={!!busy}
              onClick={() => { void doResume(); }}>
              {busy === 'resume' ? 'Resuming…' : 'Resume estate'}
            </Button>
          )}

          {state === 'RUNNING' && (
            <Dialog open={confirmOpen} onOpenChange={(_, d) => setConfirmOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary" icon={<PauseCircle24Regular />}
                  disabled={!canPause || !!busy}
                  onClick={() => setConfirmOpen(true)}>
                  Pause estate
                </Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Pause {preview.length} resource(s)?</DialogTitle>
                  <DialogContent>
                    <Body1>
                      This issues each resource&apos;s native pause verb. <strong>Nothing is deleted</strong>,
                      no SKU is changed, and no data is touched — only compute stops billing.
                    </Body1>
                    <ul className={styles.dialogList}>
                      {preview.map((r) => (
                        <li key={r.resourceId}>
                          <span className={styles.mono}>{r.name}</span> — {r.mechanism} · owned via{' '}
                          {r.owningTagKey ? `${r.owningTagKey}=${r.owningTagValue}` : r.ownershipSource}
                        </li>
                      ))}
                    </ul>
                    {data?.highRisk > 0 && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>{data.highRisk} resource(s) release a dedicated SKU</MessageBarTitle>
                          Azure does not reserve capacity while a resource is stopped, so a later resume can
                          fail with a capacity error until the region has room. Each of these declares a
                          fallback SKU, recorded in the snapshot; applying it is a manual step in this release.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    <Caption1 className={styles.powerSub}>
                      Type the estate id <span className={styles.mono}>{estateId}</span> to confirm.
                    </Caption1>
                    <Input className={styles.confirmInput} value={typed} placeholder={estateId}
                      aria-label="Type the estate id to confirm"
                      onChange={(_, d) => setTyped(d.value)} />
                  </DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Cancel</Button>
                    </DialogTrigger>
                    <Button appearance="primary" icon={<PauseCircle24Regular />}
                      disabled={typed.trim() !== estateId || !!busy}
                      onClick={() => { void doPause(); }}>
                      {busy === 'pause' ? 'Pausing…' : 'Pause now'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          )}
        </div>
      </div>

      {loading && <ProgressBar aria-label="Loading estate power state" />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Estate power</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {notice && !error && (
        <MessageBar intent="success">
          <MessageBarBody>{notice}</MessageBarBody>
        </MessageBar>
      )}

      {/* RESUME_FAILED — loud, terminal, and per-resource. Never a spinner. */}
      {state === 'RESUME_FAILED' && data?.summary && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>{data.summary.headline}</MessageBarTitle>
            <div className={styles.powerSection}>
              {(data.summary.details ?? []).map((d: any) => (
                <div key={d.resourceId} className={styles.remediation}>
                  <Caption1><strong>{d.resourceId.split('/').pop()}</strong> — {d.kind}</Caption1>
                  <Caption1 className={styles.progressDetail}>{d.remediation}</Caption1>
                </div>
              ))}
            </div>
          </MessageBarBody>
        </MessageBar>
      )}

      {/* THE POPULATION. Always stated; when it is zero, that is the headline. */}
      {!loading && state === 'RUNNING' && population && (
        notArmed ? (
          /*
            NOT ARMED — distinct from "nothing in scope". The deploy names real
            resources and manifest ownership alone would be enough to pause
            them; the arming switch is what stands between this surface and
            ~$3,000/mo of compute. Say exactly that, and name the env var.
          */
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Pause is not armed — this is deliberate</MessageBarTitle>
              {population.statement}
              <div className={styles.censusRow}>
                <Badge appearance="tint" color="warning">
                  named by the deploy: {population.namedByDeploy}
                </Badge>
                <Badge appearance="tint" color="brand">
                  loom-estate-id: {population.tagCensus.loomEstateId}
                </Badge>
                <Badge appearance="tint" color="danger">
                  LOOM_ESTATE_PAUSE_ENABLED: unset
                </Badge>
              </div>
              <Caption1 className={styles.powerSub}>
                To arm it, set <span className={styles.mono}>LOOM_ESTATE_PAUSE_ENABLED=true</span> on
                the console container app. Nothing has been paused from this code against a live
                Azure resource yet, automatic fallback-SKU recovery (R-CAP-2) is not implemented, and
                a capacity-failed resume is manual recovery today.
              </Caption1>
            </MessageBarBody>
          </MessageBar>
        ) : population.empty ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Nothing is in scope to pause — and that is the safe answer</MessageBarTitle>
              {population.statement}
              {/*
                Every signal counted SEPARATELY. Never one summed "tagged"
                number: only `loom-estate-id` carries an estate VALUE, so only
                it can tell this estate from a sibling sharing the subscription.
                The other two are shown so the gap is visible and named, not so
                anything can fall back to them.
              */}
              <div className={styles.censusRow}>
                <Badge appearance="tint" color="brand">
                  loom-estate-id (accepted): {population.tagCensus.loomEstateId}
                </Badge>
                <Badge appearance="tint" color="brand">
                  deploy manifest (accepted): {population.byEvidence.deployManifest}
                </Badge>
                <Badge appearance="tint" color="warning">
                  loom-managed (boolean — NOT accepted): {population.tagCensus.loomManaged}
                </Badge>
                <Badge appearance="tint" color="informative">
                  loom-item-id (names an item, not an estate — NOT accepted): {population.tagCensus.loomItemId}
                </Badge>
                <Badge appearance="tint" color="subtle">no Loom tag: {population.tagCensus.untagged}</Badge>
              </div>
            </MessageBarBody>
          </MessageBar>
        ) : (
          <Caption1 className={styles.powerSub}>{population.statement}</Caption1>
        )
      )}

      {/* DRIFT — a PAUSED estate with resources back up. Loud, because PRP §5
          lists four mechanisms that do this unprompted and the reconciler that
          would correct it does not exist yet. */}
      {!loading && data?.drifted && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>
              {data.driftedResources?.length ?? 0} paused resource(s) are RUNNING again
            </MessageBarTitle>
            {data.reason}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* The dry run — what a pause WOULD touch, with the owning tag per row. */}
      {!loading && state === 'RUNNING' && preview.length > 0 && (
        <div className={styles.powerSection}>
          <Caption1 className={styles.fieldLabel}>Preview — exactly what would be paused</Caption1>
          <LoomDataTable
            columns={previewColumns}
            rows={preview}
            getRowId={(r) => r.resourceId}
            noFilters
            ariaLabel="Resources that would be paused"
            empty="No resource is positively owned by this estate."
          />
        </div>
      )}

      {/* Coverage gap: tier types the deploy named no env var for. */}
      {!loading && state === 'RUNNING' && (data?.unresolved?.length ?? 0) > 0 && (
        <Caption1 className={styles.powerSub}>
          Not covered by this pause because the deployment names no resource for them:{' '}
          {data.unresolved.map((u: any) => u.label).join(', ')}.
        </Caption1>
      )}

      {/*
        HELD OUT OF THIS TIER — Loom-owned, pausable, and deliberately not
        touched. This was computed from the start but never rendered, so the
        Container Apps exclusion (the console runs as one; pausing it would
        remove the surface that resumes the estate) was invisible to the very
        operator who needs to know why their ACA spend is untouched.
      */}
      {!loading && state === 'RUNNING' && outOfTier.length > 0 && (
        <div className={styles.powerSection}>
          <Caption1 className={styles.fieldLabel}>
            Loom-owned, but deliberately NOT paused ({outOfTier.length})
          </Caption1>
          {outOfTier.map((r) => (
            <div key={r.resourceId} className={styles.remediationNeutral}>
              <Caption1><strong>{r.name}</strong> · {r.resourceType}</Caption1>
              <Caption1 className={styles.progressDetail}>{r.reason}</Caption1>
            </div>
          ))}
        </div>
      )}

      {/* Cloud boundary — stated, and stated as UNVERIFIED where it is. */}
      {!loading && data?.cloud && (
        <Caption1 className={styles.powerSub}>
          Boundary: <span className={styles.mono}>{data.cloud}</span>.
          {data.cloud === 'AzureCloud'
            ? ' Pause/resume has been exercised against fixtures only — no live Azure receipt exists in any cloud.'
            : ' Azure Government is UNTESTED for this feature: no Gov deploy and no Gov ARM call have been made.'
              + ' The ARM path is cloud-aware and would act here, which is why the arming switch is unset by default.'
              + ' Gov is owned by PRP work item W7.'}
        </Caption1>
      )}

      {/* Per-resource progress — the model a slow resume needs. */}
      {!loading && progress.length > 0 && (
        <div className={`${styles.powerSection} ${styles.powerDivider}`}>
          <div className={styles.badgeRow}>
            <Caption1 className={styles.fieldLabel}>
              {state === 'RESUMING' || state === 'RESUME_FAILED' ? 'Resume progress' : 'Pause progress'}
            </Caption1>
            {(state === 'PAUSING' || state === 'RESUMING') && <Spinner size="tiny" />}
            {state === 'RESUMING' && (
              <Caption1 className={styles.powerSub}>
                <Timer24Regular /> Typically {Math.round(Math.max(0, ...progress.map((p) => p.typicalResumeSeconds ?? 0)) / 60)} min
                for the slowest resource. Microsoft publishes no guaranteed figure.
              </Caption1>
            )}
          </div>
          {progress.map((p) => (
            <div key={p.resourceId} className={styles.progressRow}>
              <div className={styles.progressLabel}>
                <div className={styles.badgeRow}>
                  <Caption1><strong>{p.name}</strong></Caption1>
                  {/*
                    Bound to the OBSERVED power state and the expectation, never
                    to a confirmation enum: `confirmed-running` is also returned
                    for a resource that was already stopped and correctly still
                    is, so a badge keyed to it would paint a stopped resource
                    green.
                  */}
                  <Badge
                    appearance="tint"
                    color={p.phase === 'done' ? 'success' : p.phase === 'unknown' ? 'danger' : 'warning'}
                  >
                    {p.powerState}
                    {p.expectation === 'stopped' ? ' (was stopped before the pause)' : ''}
                  </Badge>
                  {p.servable === true && <Badge appearance="tint" color="success">answered a real request</Badge>}
                  {p.probed === false && <Badge appearance="tint" color="warning">no probe wired</Badge>}
                </div>
                <Caption1 className={styles.subtle}>{p.resourceType}</Caption1>
              </div>
              <div className={styles.progressLabel}>
                {p.phase === 'done'
                  ? <Caption1 className={styles.okText}><CheckmarkCircle24Filled /> {p.detail}</Caption1>
                  : p.phase === 'unknown'
                    ? <Caption1 className={styles.errorText}><ErrorCircle24Filled /> {p.detail}</Caption1>
                    : (
                      <>
                        <ProgressBar aria-label={`${p.name} in progress`} />
                        <Caption1 className={styles.progressDetail}>{p.detail}</Caption1>
                      </>
                    )}
              </div>
            </div>
          ))}
          {typeof data?.confirmed === 'number' && (
            <Caption1 className={styles.powerSub}>{data.reason}</Caption1>
          )}
        </div>
      )}
    </div>
  );
}

