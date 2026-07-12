'use client';

/**
 * Exercise services — the "does the real path WORK" panel on /admin/health.
 *
 * The self-audit above checks config presence + reachability; this panel goes
 * deeper: POST /api/admin/health/exercise starts a background run in which each
 * probe EXERCISES the real backend data path (a real Livy session on the Spark
 * pool, SELECT 1 over TDS, print 1 over KQL, a lake list, a Cosmos query, a
 * 1-shot AOAI completion, a dry-run domain sync, an ADF pipeline list), then
 * this pane polls GET for the structured pass / honest-gate / fail report with
 * real evidence. A configured-but-broken backend (the faulted-Spark-pool class
 * that silently killed notebooks) shows up here as a red 'fail' — by default.
 *
 * Real engine in lib/admin/service-probes.ts — no mock results (no-vaporware.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button, Badge,
  Subtitle2, Body1, Body1Strong, Caption1, Divider, tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircle24Filled, Warning24Filled, ErrorCircle24Filled,
  Play24Regular, ArrowSync24Regular, PulseSquare24Regular,
} from '@fluentui/react-icons';

type ProbeStatus = 'pass' | 'gate' | 'fail';
interface ProbeResult {
  service: string; title: string; status: ProbeStatus;
  detail: string; latencyMs: number; evidence?: string;
}
interface ExerciseReport {
  startedAt: string; generatedAt: string; durationMs: number; ranBy: string;
  summary: { pass: number; gate: number; fail: number; total: number };
  results: ProbeResult[];
}
interface ExerciseRunState {
  runId: string; status: 'running' | 'complete'; startedAt: string;
  services?: string[]; report?: ExerciseReport;
}

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4,
};

function StatusIcon({ s }: { s: ProbeStatus }) {
  if (s === 'pass') return <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
  if (s === 'gate') return <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
}

const STATUS_BADGE: Record<ProbeStatus, { color: 'success' | 'warning' | 'danger'; label: string }> = {
  pass: { color: 'success', label: 'pass' },
  gate: { color: 'warning', label: 'honest gate' },
  fail: { color: 'danger', label: 'fail' },
};

const POLL_MS = 5_000;

export function ServiceExercisePane() {
  const [state, setState] = useState<ExerciseRunState | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState<string | null>(null); // 'all' | service id
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await clientFetch('/api/admin/health/exercise', { cache: 'no-store' });
      if (r.status === 403) { setForbidden(true); stopPoll(); return; }
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to load exercise state'); stopPoll(); return; }
      setError(null);
      setState(j.state ?? null);
      setStale(!!j.stale);
      const running = j.state?.status === 'running' && !j.stale;
      if (!running) stopPoll();
      return running as boolean;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      stopPoll();
    } finally {
      setLoading(false);
    }
  }, [stopPoll]);

  const startPoll = useCallback(() => {
    stopPoll();
    pollRef.current = setInterval(() => { void load(); }, POLL_MS);
  }, [load, stopPoll]);

  useEffect(() => {
    void load().then((running) => { if (running) startPoll(); });
    return stopPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async (service?: string) => {
    setStarting(service || 'all'); setError(null);
    try {
      const url = service
        ? `/api/admin/health/exercise?service=${encodeURIComponent(service)}`
        : '/api/admin/health/exercise';
      const r = await clientFetch(url, { method: 'POST' });
      if (r.status === 403) { setForbidden(true); return; }
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to start exercise run'); return; }
      await load();
      startPoll();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  }, [load, startPoll]);

  const running = state?.status === 'running' && !stale;
  const report = state?.status === 'complete' ? state.report : undefined;

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge, marginBottom: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
        <PulseSquare24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Exercise services</Subtitle2>
        {report && (
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
            <Badge appearance="filled" color="success">{report.summary.pass} pass</Badge>
            <Badge appearance="filled" color="warning">{report.summary.gate} gated</Badge>
            <Badge appearance="filled" color="danger">{report.summary.fail} fail</Badge>
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
          {running && <Spinner size="tiny" label="Exercising…" labelPosition="after" />}
          <Button
            appearance="primary"
            icon={report ? <ArrowSync24Regular /> : <Play24Regular />}
            disabled={running || starting !== null || forbidden}
            onClick={() => run()}
          >
            {starting === 'all' ? 'Starting…' : report ? 'Re-run all probes' : 'Run all probes'}
          </Button>
        </div>
      </div>
      <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalM }}>
        Deeper than the self-audit: each probe exercises the REAL backend data path — a live Livy session on the
        default Spark pool, SELECT 1 over TDS, print 1 over KQL, a lake container list, a Cosmos query, a one-shot
        model completion, a dry-run domain sync, and an ADF pipeline list. A backend that is configured but broken
        (e.g. a faulted Spark pool) fails here even when every config check above is green. Probes self-clean —
        the Spark probe deletes its session. The Spark probe can take a few minutes.
      </Caption1>

      {forbidden && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Tenant admin required</MessageBarTitle>
            Exercise runs execute real operations against shared tenant backends, so only a tenant admin can start
            or view them. Set LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID to your principal.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Exercise</MessageBarTitle> {error}</MessageBarBody>
        </MessageBar>
      )}
      {stale && state?.status === 'running' && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>Stale run</MessageBarTitle>
            A previous run started {new Date(state.startedAt).toLocaleString()} and never completed (the replica may
            have restarted). Start a new run.
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !state && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL }}>
          <Spinner label="Loading last exercise run…" />
        </div>
      )}

      {!loading && !state && !forbidden && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>No exercise run yet</MessageBarTitle>
            Run the probes to verify every backend actually executes work — not just that it is configured.
          </MessageBarBody>
        </MessageBar>
      )}

      {running && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Run in progress</MessageBarTitle>
            Started {new Date(state!.startedAt).toLocaleString()}
            {state!.services?.length ? ` — probing: ${state!.services.join(', ')}` : ' — probing every service'}.
            The report appears here when the run completes (the Spark probe waits for a real session to reach idle).
          </MessageBarBody>
        </MessageBar>
      )}

      {report && (
        <div>
          <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
            Last run {new Date(report.generatedAt).toLocaleString()} by {report.ranBy} · {Math.round(report.durationMs / 1000)}s total
            {state?.services?.length ? ` · scoped to ${state.services.join(', ')}` : ''}
          </Caption1>
          {report.results.map((r, i) => (
            <div key={r.service}>
              {i > 0 && <Divider style={{ marginTop: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalM }} />}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' }}>
                <div style={{ marginTop: tokens.spacingVerticalXXS }}><StatusIcon s={r.status} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                    <Body1Strong>{r.title}</Body1Strong>
                    <Badge appearance="tint" size="small" color={STATUS_BADGE[r.status].color}>{STATUS_BADGE[r.status].label}</Badge>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{(r.latencyMs / 1000).toFixed(1)}s</Caption1>
                  </div>
                  <Body1 style={{ display: 'block', marginTop: tokens.spacingVerticalXXS, color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                    {r.detail}
                  </Body1>
                  {r.evidence && (
                    <div style={{ marginTop: tokens.spacingVerticalS }}>
                      <Button size="small" appearance="subtle"
                        onClick={() => setOpenEvidence((o) => ({ ...o, [r.service]: !o[r.service] }))}>
                        {openEvidence[r.service] ? '▾ Hide evidence' : '▸ Show evidence (real backend response)'}
                      </Button>
                      {openEvidence[r.service] && (
                        <pre style={{
                          marginTop: tokens.spacingVerticalSNudge, padding: tokens.spacingVerticalMNudge,
                          borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground4,
                          color: tokens.colorNeutralForeground1, overflow: 'auto', maxWidth: '100%',
                          maxHeight: '20rem', fontSize: tokens.fontSizeBase200,
                          fontFamily: 'Consolas, "Cascadia Code", monospace', whiteSpace: 'pre-wrap', lineHeight: 1.5,
                        }}>
                          {r.evidence}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
                <Button size="small" appearance="outline" icon={<Play24Regular />}
                  disabled={running || starting !== null}
                  title={`Re-run only the ${r.service} probe`}
                  onClick={() => run(r.service)}>
                  {starting === r.service ? 'Starting…' : 'Re-run'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
