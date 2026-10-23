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
  Body1, Caption1, Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle,
  Field, Switch, makeStyles,
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
import { EstateContainerAppsSection } from '@/lib/components/admin-scaling/estate-container-apps-section';
import { isTabHidden, isThrottledResponse, nextPollDelayMs } from '@/lib/components/admin-scaling/estate-power-poll';

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

// ===========================================================================
// IDLE ACTIVITY + AUTO-PAUSE (PRP-02 step 3, #4876)
//
// Shows how long the console has been idle, when the estate was last paused and
// resumed, and the auto-pause setting the auto-pause lane reads. Honest states:
//   - no activity recorded  -> informative note (it is NOT "idle forever", and
//     the auto-pause lane will not fire on it), never an error;
//   - setting never saved   -> says the armed default is in effect;
//   - setting unreadable    -> a warning with a one-click "Reset to defaults";
//   - save refused          -> a warning with Retry.
// ===========================================================================

const useSectionStyles = makeStyles({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
});

/** "2h 5m" / "37m" / "under a minute". Pure, exported for the test. */
export function formatIdle(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 60) return 'under a minute';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Same bounds as the server (`validateAutoPause`); the server is still the authority. */
export function parseIdleHours(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 168 ? n : null;
}

export function EstateAutoPauseSection({ power, styles, onChanged }: {
  power: any;
  styles: Record<string, string>;
  onChanged: () => Promise<unknown> | void;
}) {
  const s = useSectionStyles();
  const ap = power?.autoPause;
  const activity = power?.activity;
  const [enabled, setEnabled] = useState<boolean>(ap?.enabled ?? true);
  const [hours, setHours] = useState<string>(String(ap?.idleHours ?? 2));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow the server value until the operator starts editing.
  useEffect(() => {
    if (dirty || !ap) return;
    setEnabled(ap.enabled);
    setHours(String(ap.idleHours));
  }, [ap?.enabled, ap?.idleHours, ap?.updatedAt, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!power) return null;

  const parsed = parseIdleHours(hours);
  const hoursInvalid = dirty && parsed === null;

  async function save(next: { enabled: boolean; idleHours: number; containerApps?: { enabled: boolean; exempt: string[] } }) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const r = await clientFetch('/api/admin/estate/autopause', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Save failed (${r.status})`);
      setDirty(false);
      setSaved(true);
      await onChanged();
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const noActivity = activity && activity.lastActivityAt === null;

  return (
    <div className={`${styles.powerSection} ${styles.powerDivider}`} data-testid="estate-autopause">
      <Caption1 className={styles.fieldLabel}>Idle auto-pause</Caption1>

      <div className={s.row}>
        {activity?.unreadable ? (
          <Badge appearance="tint" color="warning">activity unreadable</Badge>
        ) : noActivity ? (
          <Badge appearance="tint" color="informative">no activity recorded yet</Badge>
        ) : (
          <>
            <Badge appearance="tint" color="brand">
              last activity {new Date(activity.lastActivityAt).toLocaleString()}
            </Badge>
            <Badge appearance="tint" color="subtle">idle for {formatIdle(activity.idleForSeconds)}</Badge>
          </>
        )}
        <Badge appearance="tint" color="subtle">
          last paused {power.lastPausedAt ? new Date(power.lastPausedAt).toLocaleString() : 'never'}
        </Badge>
        <Badge appearance="tint" color="subtle">
          last resumed {power.lastResumedAt ? new Date(power.lastResumedAt).toLocaleString() : 'never'}
        </Badge>
      </div>

      {(noActivity || activity?.unreadable) && (
        <Caption1 className={styles.powerSub}>
          {activity?.unreadable
            ? 'Loom could not read the last-activity record, so it treats idleness as unknown and will not auto-pause.'
            : 'Nothing has recorded a person using the console yet. Loom treats that as unknown, not idle, and will not auto-pause until activity has been seen.'}
        </Caption1>
      )}

      {ap?.source === 'unreadable' && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>The saved auto-pause setting could not be read</MessageBarTitle>
            Showing the defaults below; Loom will not auto-pause on an unreadable setting.
            Saving writes a fresh, explicit setting.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" disabled={saving}
              onClick={() => { void save({ enabled: true, idleHours: 2, containerApps: { enabled: true, exempt: [] } }); }}>
              Reset to defaults (on, 2 hours)
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      <div className={s.row}>
        <Switch
          checked={enabled}
          label={enabled ? 'Auto-pause when idle' : 'Auto-pause is off'}
          onChange={(_, d) => { setEnabled(d.checked); setDirty(true); setSaved(false); }}
        />
        <Field
          label="Idle hours"
          validationState={hoursInvalid ? 'error' : 'none'}
          validationMessage={hoursInvalid ? 'Enter a number from 1 to 168.' : undefined}
          hint={hoursInvalid ? undefined : '1 to 168 (one week). Default 2.'}
        >
          <Input
            type="number"
            value={hours}
            disabled={!enabled}
            aria-label="Idle hours before auto-pause"
            onChange={(_, d) => { setHours(d.value); setDirty(true); setSaved(false); }}
          />
        </Field>
        <Button appearance="primary" disabled={!dirty || parsed === null || saving}
          onClick={() => { if (parsed !== null) void save({ enabled, idleHours: parsed }); }}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {ap?.source === 'default' && !dirty && !saved && (
        <Caption1 className={styles.powerSub}>
          Using the default: on, after 2 idle hours. Save to make it an explicit setting.
          Auto-pause still needs the pause feature armed and a current preview to act.
        </Caption1>
      )}
      {saved && (
        <MessageBar intent="success"><MessageBarBody>Auto-pause setting saved.</MessageBarBody></MessageBar>
      )}
      {saveError && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>The auto-pause setting was not saved</MessageBarTitle>
            {saveError}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" disabled={saving || parsed === null}
              onClick={() => { if (parsed !== null) void save({ enabled, idleHours: parsed }); }}>
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}
    </div>
  );
}

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
  // Consecutive reads that reported ARM throttling; drives the poll back-off.
  const throttledStreak = useRef(0);
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const j = await jsonGet('/api/admin/estate/state');
    throttledStreak.current = isThrottledResponse(j) ? throttledStreak.current + 1 : 0;
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
  // hammer a warming engine. Every poll is an ARM fan-out on a read quota the
  // whole subscription shares, so: NO poll while the tab is hidden (it resumes
  // with an immediate read when the tab returns), and an exponential back-off
  // (to 60 s) while the last read reported throttling.
  useEffect(() => {
    const state: EstateState | undefined = data?.state;
    if (state !== 'PAUSING' && state !== 'RESUMING') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const schedule = () => {
      const delay = nextPollDelayMs(throttledStreak.current);
      setNextRetryAt(throttledStreak.current > 0 ? Date.now() + delay : null);
      timer = setTimeout(async () => {
        if (cancelled) return;
        if (!isTabHidden()) await refresh();
        if (!cancelled) schedule();
      }, delay);
    };
    const onVisibility = () => {
      if (isTabHidden() || cancelled) return;
      clearTimeout(timer);
      void refresh().then(() => { if (!cancelled) schedule(); });
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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
                  + 'Analysis Services suspend, scale-set capacity 0, Container Apps scaled to zero replicas '
                  + '(the console and a short never-pause list excepted). Nothing is deleted and no data is '
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
      {/* ARM throttled this read. A rate limit is not a failure and not a verdict
          on any resource: calm info, the last confirmed state stays on screen. */}
      {!error && isThrottledResponse(data) && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Azure is rate-limiting power-state reads</MessageBarTitle>
            Reads of {data.throttled} resource(s) were throttled by Azure Resource Manager, so their state
            was not read this time. Nothing was changed and no failure was recorded; the state shown is the
            last one Loom confirmed.{' '}
            {nextRetryAt
              ? `Next automatic retry at ${new Date(nextRetryAt).toLocaleTimeString()}.`
              : 'It is re-read on the next refresh.'}
          </MessageBarBody>
        </MessageBar>
      )}
      {notice && !error && (
        <MessageBar intent="success">
          <MessageBarBody>{notice}</MessageBarBody>
        </MessageBar>
      )}

      {!loading && data?.power && (
        <EstateAutoPauseSection power={data.power} styles={styles} onChanged={refresh} />
      )}
      {!loading && data?.power && (
        <EstateContainerAppsSection
          power={data.power} containerApps={data.containerApps} styles={styles} onChanged={refresh}
        />
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

      {/* TAG DISCOVERY (#5099). A Resource Graph failure, or a subscription the console cannot
          read, makes the list PARTIAL. Say so in words: it is never "nothing to pause". */}
      {!loading && state === 'RUNNING' && data?.discovery?.incomplete && (
        <MessageBar intent="warning" data-testid="estate-discovery-incomplete">
          <MessageBarBody>
            <MessageBarTitle>Discovery incomplete — this preview may be missing resources</MessageBarTitle>
            {data.discovery.note}
          </MessageBarBody>
        </MessageBar>
      )}
      {!loading && state === 'RUNNING' && (data?.discovery?.heldOut?.length ?? 0) > 0 && (
        <Caption1 className={styles.powerSub} data-testid="estate-discovery-heldout">
          Tagged for this estate but deliberately left running:{' '}
          {data.discovery.heldOut.map((h: any) => `${h.name} (${h.reason})`).join(' · ')}
        </Caption1>
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
              <MessageBarTitle>
                {data?.discovery?.incomplete
                  ? 'Nothing was found in scope to pause — but discovery is incomplete'
                  : 'Nothing is in scope to pause — and that is the safe answer'}
              </MessageBarTitle>
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
