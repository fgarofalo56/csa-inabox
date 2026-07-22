'use client';

/**
 * Journeys tab (V1) — the last synthetic user-journey runs from the scheduled
 * in-VNet `loom-synthetic-monitor` job, per-journey verdicts included.
 *
 * REAL data only (no-vaporware.md): reads GET /api/admin/synthetic-runs, which
 * lists the run artifacts the monitor uploads to Blob
 * (uat-runs/synthetic/<runId>/verdicts.ndjson). Unwired results store → the
 * route's svc-synthetic-monitor gate envelope renders through the shared
 * HonestGate (G2 Fix-it), never a bare banner.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1, Body1Strong, Button, Caption1, Divider, MessageBar,
  MessageBarBody, MessageBarTitle, Spinner, Subtitle2, Tooltip, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, CheckmarkCircle24Filled, ErrorCircle24Filled,
  HeartPulse24Regular, Open16Regular, Warning24Filled,
} from '@fluentui/react-icons';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { EmptyState } from '@/lib/components/empty-state';

interface JourneySummary {
  name: string;
  verdict: string;
  status: 'pass' | 'fail' | 'skip' | 'vaporware';
  ms?: number;
  notes?: string;
  screenshot?: string;
}
interface RunSummary {
  runId: string;
  ts: string;
  pass: number;
  fail: number;
  skip: number;
  journeys: JourneySummary[];
}
interface GateEnvelope {
  id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[];
  state?: 'blocked' | 'cloud-unavailable'; fallbackNote?: string;
}

const RUNBOOK_URL = 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/synthetic-journeys.md';

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL, border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL, boxShadow: tokens.shadow4,
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalMNudge,
  marginBottom: tokens.spacingVerticalL, flexWrap: 'wrap', minWidth: 0,
};
const runRow: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  padding: `${tokens.spacingVerticalM} 0`, minWidth: 0,
};
const journeyChips: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0,
};

function statusColor(s: JourneySummary['status']): 'success' | 'danger' | 'warning' | 'informative' {
  if (s === 'pass') return 'success';
  if (s === 'fail') return 'danger';
  if (s === 'skip') return 'informative';
  return 'warning';
}

function RunHealthIcon({ r }: { r: RunSummary }) {
  if (r.fail > 0) return <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
  if (r.journeys.length === 0) return <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
}

export function SyntheticJourneysPane() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [gate, setGate] = useState<GateEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch('/api/admin/synthetic-runs?n=12', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gate) { setGate(j.gate as GateEnvelope); return; }
      if (!r.ok || j?.ok === false) { setError(j?.error || `synthetic-runs failed (${r.status})`); return; }
      setRuns(Array.isArray(j.runs) ? j.runs : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section style={card} aria-label="Synthetic journeys">
      <div style={head}>
        <HeartPulse24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Synthetic journeys</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
          Six real end-to-end journeys every 15 minutes, in-VNet — incl. the TRUE MSAL login probe
          (the 2026-07-19 class minted-session monitoring misses).
        </Caption1>
        <span style={{ flex: 1 }} />
        <Button appearance="subtle" icon={<Open16Regular />} as="a" href={RUNBOOK_URL}
          target="_blank" rel="noreferrer">
          Runbook
        </Button>
        <Button appearance="secondary" icon={loading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
          onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {gate && (
        <HonestGate surface="Synthetic journeys" gate={gate} onResolved={load} />
      )}

      {error && !gate && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load synthetic runs</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !runs && !gate && !error && <Spinner label="Loading synthetic runs…" />}

      {!loading && !gate && !error && runs && runs.length === 0 && (
        <EmptyState
          title="No synthetic runs yet"
          body="The loom-synthetic-monitor job uploads a run summary every 15 minutes once deployed (modules/admin-plane/synthetic-monitor-job.bicep — default-ON via the observabilityConfig bag). Dispatch the loom-synthetic-monitor workflow, or start the job once, and the first run appears here."
          primaryAction={{ label: 'Open the runbook', href: RUNBOOK_URL }}
        />
      )}

      {!gate && runs && runs.length > 0 && (
        <div role="list" aria-label="Synthetic runs">
          {runs.map((r, i) => (
            <div key={r.runId} role="listitem" style={runRow}>
              {i > 0 && <Divider />}
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 }}>
                <RunHealthIcon r={r} />
                <Body1Strong>{r.ts ? new Date(r.ts).toLocaleString() : r.runId}</Body1Strong>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                  {r.runId}
                </Caption1>
                <span style={{ flex: 1 }} />
                <Badge appearance="tint" color={r.fail > 0 ? 'danger' : 'success'}>
                  {r.pass} pass · {r.fail} fail{r.skip > 0 ? ` · ${r.skip} skip` : ''}
                </Badge>
              </div>
              <div style={journeyChips}>
                {r.journeys.map((j) => (
                  <Tooltip
                    key={`${r.runId}-${j.name}`}
                    relationship="description"
                    content={`${j.notes || j.status}${typeof j.ms === 'number' ? ` — ${(j.ms / 1000).toFixed(1)}s` : ''}${j.screenshot ? ` — screenshot: ${j.screenshot}` : ''}`}
                  >
                    <Badge appearance="tint" color={statusColor(j.status)} style={{ minWidth: 0, maxWidth: '100%' }}>
                      {j.name} · {j.status}
                    </Badge>
                  </Tooltip>
                ))}
                {r.journeys.length === 0 && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Run summary not uploaded (in progress, or the execution crashed before Playwright ran) — check the job logs.
                  </Caption1>
                )}
              </div>
              {r.journeys.filter((j) => j.status === 'fail').map((j) => (
                <MessageBar key={`${r.runId}-${j.name}-fail`} intent="error" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>{j.name} failed</MessageBarTitle>
                    <Body1>{j.notes || 'See the run artifacts in the results container for the trace.'}</Body1>
                  </MessageBarBody>
                </MessageBar>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
