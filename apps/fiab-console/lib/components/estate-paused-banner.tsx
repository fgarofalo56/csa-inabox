'use client';

/**
 * EstatePausedBanner - the shared-shell banner shown ONLY while part of the
 * estate is paused (operator decision 2026-10-22).
 *
 *   PAUSED          "N services are paused" + which + when/by whom + [Resume]
 *                   (tenant admins) or "ask an administrator" (everyone else)
 *   PAUSING         informative, no button
 *   RESUMING        spinner, no button; promoted by the admin estate state route
 *   RESUME_FAILED   error intent, the failure text, and the button KEPT as Retry
 *   RUNNING / none  renders nothing (a fresh, never-paused estate shows no banner)
 *
 * Data: GET /api/estate/paused (the pause snapshot, no ARM). While a transition
 * is in flight an admin's tab also reads /api/admin/estate/state, the route that
 * PROMOTES the snapshot (RESUMING -> RUNNING); without that read a finished
 * resume would stay "resuming" forever. Polling pauses while the tab is hidden,
 * stops once the state settles, and both routes are excluded from the
 * idle-activity signal so this banner cannot keep the estate awake.
 *
 * A failed banner read renders nothing: the banner is advisory, and a Cosmos blip
 * must not paint an alarm on every page. The Admin estate power panel remains the
 * place that states a read failure.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';
import { useShellSession } from './session-context';
import { isTabHidden } from '@/lib/components/admin-scaling/estate-power-poll';

interface PausedBannerData {
  paused: boolean;
  state?: 'PAUSING' | 'PAUSED' | 'RESUMING' | 'RESUME_FAILED';
  count?: number;
  names?: string[];
  pausedAt?: string | null;
  pausedBy?: string | null;
  pausedByKind?: 'person' | 'automation' | 'unknown';
  failure?: string | null;
  canResume?: boolean;
}

const useStyles = makeStyles({
  wrap: { marginBottom: tokens.spacingVerticalM, minWidth: 0 },
  names: { overflowWrap: 'anywhere' },
  meta: { color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXXS },
});

/** Poll cadence while a transition is in flight. */
export const BANNER_POLL_MS = 10_000;
const MAX_NAMES = 5;

/** "a, b, c and 2 more". Pure, exported for the test. */
export function nameList(names: readonly string[]): string {
  if (names.length <= MAX_NAMES) return names.join(', ');
  return `${names.slice(0, MAX_NAMES).join(', ')} and ${names.length - MAX_NAMES} more`;
}

function who(d: PausedBannerData): string {
  if (d.pausedBy) return d.pausedBy;
  if (d.pausedByKind === 'automation') return 'automation (the idle auto-pause or the estate-power workflow)';
  if (d.pausedByKind === 'person') return 'an administrator';
  return 'an unrecorded actor';
}

export function EstatePausedBanner() {
  const s = useStyles();
  const session = useShellSession();
  const [data, setData] = useState<PausedBannerData | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await clientFetch('/api/estate/paused');
      if (!r.ok) return;
      const j = (await r.json()) as PausedBannerData & { ok?: boolean };
      if (!cancelled.current && j.ok !== false) setData(j);
    } catch { /* advisory surface: stay as we were */ }
  }, []);

  // An admin read of the state route is what PROMOTES an in-flight snapshot
  // (RESUMING -> RUNNING). Its body is not used: the banner re-reads the cheap view.
  const promote = useCallback(async () => {
    try { await clientFetch('/api/admin/estate/state'); } catch { /* the next tick retries */ }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    if (!session.authenticated) return () => { cancelled.current = true; };
    void load();
    return () => { cancelled.current = true; };
  }, [session.authenticated, load]);

  const inFlight = data?.state === 'PAUSING' || data?.state === 'RESUMING';
  useEffect(() => {
    if (!session.authenticated || !(inFlight || resuming)) return;
    const t = setInterval(async () => {
      if (isTabHidden()) return;
      if (session.isTenantAdmin) await promote();
      await load();
    }, BANNER_POLL_MS);
    return () => clearInterval(t);
  }, [session.authenticated, session.isTenantAdmin, inFlight, resuming, load, promote]);

  // Once the server reports a state other than the one we asked for, stop "resuming".
  useEffect(() => {
    if (resuming && data && (data.state === 'RESUMING' || data.state === 'RESUME_FAILED' || !data.paused)) setResuming(false);
  }, [resuming, data]);

  async function resume() {
    setResuming(true);
    setResumeError(null);
    try {
      const r = await clientFetch('/api/admin/estate/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Resume failed (${r.status})`);
      await load();
    } catch (e: unknown) {
      setResuming(false);
      setResumeError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!session.authenticated || !data || !data.paused || !data.state) return null;

  const names = nameList(data.names ?? []);
  const count = data.count ?? 0;
  const noun = count === 1 ? 'service is' : 'services are';
  const when = data.pausedAt ? new Date(data.pausedAt).toLocaleString() : 'at an unrecorded time';
  const canResume = data.canResume === true;
  const failed = data.state === 'RESUME_FAILED';
  const busy = resuming || data.state === 'RESUMING';

  const intent = failed ? 'error' : data.state === 'PAUSED' ? 'warning' : 'info';

  return (
    <div className={s.wrap} data-testid="estate-paused-banner" data-intent={intent}>
      <MessageBar intent={intent}>
        <MessageBarBody>
          {data.state === 'PAUSING' && (
            <>
              <MessageBarTitle>Pausing {count} {count === 1 ? 'service' : 'services'}</MessageBarTitle>
              <span className={s.names}>{names}</span>
            </>
          )}
          {data.state === 'PAUSED' && (
            <>
              <MessageBarTitle>{count} {noun} paused to save cost</MessageBarTitle>
              <span className={s.names}>{names}. They may be unavailable until resumed.</span>
            </>
          )}
          {busy && !failed && (
            <>
              <MessageBarTitle>Resuming {count} {count === 1 ? 'service' : 'services'}</MessageBarTitle>
              <Spinner size="tiny" label="This takes a few minutes" labelPosition="after" />
            </>
          )}
          {failed && (
            <>
              <MessageBarTitle>Resume did not complete</MessageBarTitle>
              <span className={s.names}>{data.failure ?? 'At least one service is not confirmed back up.'}</span>
            </>
          )}
          <span className={s.meta}>
            Paused {when} by {who(data)}.
            {!canResume && data.state === 'PAUSED' && ' An administrator can resume them.'}
          </span>
          {resumeError && (
            <span role="alert" className={s.meta}>Resume was not started: {resumeError}</span>
          )}
        </MessageBarBody>
        {canResume && (data.state === 'PAUSED' || failed) && (
          <MessageBarActions>
            <Button size="small" appearance="primary" disabled={busy} onClick={() => { void resume(); }}>
              {busy ? 'Resuming…' : failed ? 'Retry resume' : 'Resume'}
            </Button>
          </MessageBarActions>
        )}
      </MessageBar>
    </div>
  );
}
