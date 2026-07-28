'use client';

/**
 * Dependency chaos tab (CH1) — the dependency-fault resilience harness on the
 * Health & Reliability hub. Arm a Cosmos-429 / Azure OpenAI 429 / AOAI timeout /
 * ADX cold-start / Key Vault throttle fault against THIS replica and PROVE the
 * surface degrades to serve-stale or an honest gate — never a crash.
 *
 * REAL data only (no-vaporware.md): reads + writes GET/POST
 * /api/admin/chaos/dependency, which mutates the live in-process fault registry
 * the cosmos-client / fetch-with-timeout chokepoints consult. When the harness
 * is not armable (LOOM_DEPENDENCY_CHAOS_ENABLED unset), the tab still renders the
 * resilience matrix + an honest MessageBar naming the exact env var + the
 * internal token — the full surface, gated, never a blank pane.
 *
 * This is a deliberately OPT-IN surface (the ch1-dependency-chaos flag gates the
 * tab itself); the arm controls are additionally triple-gated server-side.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1Strong, Button, Caption1, Divider, Field, Input, MessageBar,
  MessageBarBody, MessageBarTitle, Spinner, Subtitle2, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, Beaker24Regular, DismissCircle16Regular, Flash16Regular,
  Open16Regular, ShieldCheckmark24Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

const RUNBOOK_URL =
  'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/resilience-matrix.md';

interface FaultPointDesc {
  point: string;
  label: string;
  dependency: string;
  proves: string;
}
interface InjectionRecord {
  at: number;
  point: string;
  detail: string;
}
interface ArmedFaultView {
  point: string;
  label: string;
  dependency: string;
  armedAt: number;
  expiresAt: number;
  msRemaining: number;
  remaining: number | null;
  reason: string;
  armedBy: string;
  injectedCount: number;
  recentInjections: InjectionRecord[];
}
interface MechRow {
  faultPoint: string | null;
  dependency: string;
  sourceFile: string;
  mechanisms: { timeout: boolean; retry: boolean; breaker: boolean; serveStale: boolean; honestGate: boolean };
  degradesTo: string;
}
interface ChaosStatus {
  ok: boolean;
  enabled: boolean;
  flagOn: boolean;
  armable: boolean;
  armed: ArmedFaultView[];
  faultPoints: FaultPointDesc[];
  matrix: MechRow[];
  coverage: {
    totalRows: number; faultRows: number; withTimeout: number; withRetry: number;
    withBreaker: number; withServeStale: number; withHonestGate: number;
    faultRowsWithoutStaleOrBreaker: number;
  };
  limits: { maxTtlMs: number; maxOccurrences: number };
}

const useStyles = makeStyles({
  card: {
    padding: tokens.spacingVerticalXL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    marginBottom: tokens.spacingVerticalXL,
    boxShadow: tokens.shadow4,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalMNudge,
    marginBottom: tokens.spacingVerticalL,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    minWidth: 0,
  },
  statValue: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700 },
  faultBlock: {
    marginTop: tokens.spacingVerticalL,
    paddingTop: tokens.spacingVerticalL,
    minWidth: 0,
  },
  faultHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    marginBottom: tokens.spacingVerticalXS,
  },
  armRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    minWidth: 0,
    marginTop: tokens.spacingVerticalS,
  },
  ttlField: { maxWidth: '140px' },
  badgeRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    marginTop: tokens.spacingVerticalXS,
  },
});

function mech(v: boolean): React.ReactElement {
  return v
    ? <Badge appearance="tint" color="success">yes</Badge>
    : <Badge appearance="tint" color="informative">—</Badge>;
}

const MATRIX_COLUMNS: LoomColumn<MechRow>[] = [
  { key: 'dependency', label: 'Dependency / layer', render: (r) => <Body1Strong>{r.dependency}</Body1Strong>, getValue: (r) => r.dependency },
  { key: 'timeout', label: 'Timeout', render: (r) => mech(r.mechanisms.timeout), getValue: (r) => (r.mechanisms.timeout ? 1 : 0) },
  { key: 'retry', label: 'Retry / failover', render: (r) => mech(r.mechanisms.retry), getValue: (r) => (r.mechanisms.retry ? 1 : 0) },
  { key: 'breaker', label: 'Breaker', render: (r) => mech(r.mechanisms.breaker), getValue: (r) => (r.mechanisms.breaker ? 1 : 0) },
  { key: 'serveStale', label: 'Serve-stale', render: (r) => mech(r.mechanisms.serveStale), getValue: (r) => (r.mechanisms.serveStale ? 1 : 0) },
  { key: 'honestGate', label: 'Honest gate', render: (r) => mech(r.mechanisms.honestGate), getValue: (r) => (r.mechanisms.honestGate ? 1 : 0) },
  {
    key: 'degradesTo', label: 'Degrades to',
    render: (r) => (
      <Tooltip relationship="description" content={r.degradesTo}>
        <span>{r.degradesTo.slice(0, 72)}{r.degradesTo.length > 72 ? '…' : ''}</span>
      </Tooltip>
    ),
    getValue: (r) => r.degradesTo,
  },
];

export function DependencyChaosPane() {
  const styles = useStyles();
  const [data, setData] = useState<ChaosStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ intent: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [ttlByPoint, setTtlByPoint] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/chaos/dependency', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setError(j?.error || `chaos status failed (${r.status})`); return; }
      setData(j as ChaosStatus);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (bodyObj: Record<string, unknown>, okText: string) => {
    setBusy(String(bodyObj.point || bodyObj.action)); setActionMsg(null);
    try {
      const r = await clientFetch('/api/admin/chaos/dependency', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodyObj),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setActionMsg({ intent: 'warning', text: j?.error || `action failed (${r.status})` });
      } else {
        setActionMsg({ intent: 'success', text: okText });
        setData((prev) => (prev ? { ...prev, armed: (j.armed as ArmedFaultView[]) ?? prev.armed } : prev));
      }
    } catch (e: unknown) {
      setActionMsg({ intent: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, []);

  const armedByPoint = new Map((data?.armed ?? []).map((a) => [a.point, a]));
  const cov = data?.coverage;

  return (
    <section className={styles.card} aria-label="Dependency chaos harness">
      <div className={styles.head}>
        <Beaker24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Dependency chaos harness</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
          Inject a real Cosmos / Azure OpenAI / ADX / Key Vault fault against this replica to prove the
          surface degrades to serve-stale or an honest gate — never a crash.
        </Caption1>
        <span style={{ flex: 1 }} />
        <Button appearance="subtle" icon={<Open16Regular />} as="a" href={RUNBOOK_URL} target="_blank" rel="noreferrer">
          Resilience matrix
        </Button>
        <Button appearance="secondary" icon={loading ? <Spinner size="tiny" /> : <ArrowSync24Regular />} onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {/* Honest gate — the harness is opt-in + env-gated; the surface still renders. */}
      {data && !data.armable && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Chaos harness is not armable in this deployment</MessageBarTitle>
            {!data.flagOn && 'The ch1-dependency-chaos runtime flag is OFF (deliberately opt-in). Enable it in Admin → Runtime flags to arm a drill. '}
            {!data.enabled && 'Set LOOM_DEPENDENCY_CHAOS_ENABLED=true in a NON-PROD deployment (it MUST stay off in production). '}
            Arming also requires a valid LOOM_INTERNAL_TOKEN on the request. The resilience matrix below is
            read-only and always available.
          </MessageBarBody>
        </MessageBar>
      )}

      {actionMsg && (
        <MessageBar intent={actionMsg.intent} layout="multiline">
          <MessageBarBody>{actionMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load the chaos harness</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !data && !error && <Spinner label="Loading chaos harness…" />}

      {data && (
        <>
          {/* Resilience coverage summary */}
          {cov && (
            <div className={styles.stats} role="group" aria-label="Resilience coverage">
              <div className={styles.stat}>
                <Caption1>Clients / layers</Caption1>
                <Body1Strong className={styles.statValue}>{cov.totalRows}</Body1Strong>
              </div>
              <div className={styles.stat}>
                <Caption1>Timeout-bounded</Caption1>
                <Body1Strong className={styles.statValue}>{cov.withTimeout}</Body1Strong>
              </div>
              <div className={styles.stat}>
                <Caption1>Serve-stale</Caption1>
                <Body1Strong className={styles.statValue}>{cov.withServeStale}</Body1Strong>
              </div>
              <div className={styles.stat}>
                <Caption1>Honest gate</Caption1>
                <Body1Strong className={styles.statValue}>{cov.withHonestGate}</Body1Strong>
              </div>
              <div className={styles.stat}>
                <Caption1>Armed now</Caption1>
                <Body1Strong className={styles.statValue}>{data.armed.length}</Body1Strong>
              </div>
            </div>
          )}

          {data.armed.length > 0 && (
            <div className={styles.badgeRow}>
              <Button size="small" appearance="secondary" icon={<DismissCircle16Regular />}
                disabled={busy !== null}
                onClick={() => post({ action: 'disarm-all' }, 'All faults disarmed.')}>
                Disarm all
              </Button>
            </div>
          )}

          {/* Per-fault arm controls */}
          {data.faultPoints.map((fp) => {
            const armed = armedByPoint.get(fp.point);
            const ttl = ttlByPoint[fp.point] ?? '';
            return (
              <div key={fp.point} className={styles.faultBlock}>
                <Divider />
                <div className={styles.faultHead} style={{ marginTop: tokens.spacingVerticalM }}>
                  <Flash16Regular style={{ color: armed ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }} />
                  <Body1Strong>{fp.label}</Body1Strong>
                  <Badge appearance="tint" color="informative">{fp.dependency}</Badge>
                  {armed && (
                    <Badge appearance="filled" color="danger">
                      ARMED · {Math.ceil(armed.msRemaining / 1000)}s left{armed.remaining !== null ? ` · ${armed.remaining} left` : ''}
                    </Badge>
                  )}
                  {armed && armed.injectedCount > 0 && (
                    <Badge appearance="tint" color="warning">{armed.injectedCount} injected</Badge>
                  )}
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{fp.proves}</Caption1>

                <div className={styles.armRow}>
                  <Field label="TTL (seconds)" className={styles.ttlField}>
                    <Input
                      type="number" value={ttl} placeholder="60"
                      disabled={!data.armable || busy !== null}
                      onChange={(_, d) => setTtlByPoint((prev) => ({ ...prev, [fp.point]: d.value }))}
                    />
                  </Field>
                  <Tooltip relationship="description"
                    content={data.armable
                      ? 'Arm this fault against this replica. It auto-expires (default 60s, max 5 min) so a forgotten drill self-heals.'
                      : 'The harness is not armable — enable the flag + LOOM_DEPENDENCY_CHAOS_ENABLED (see the banner above).'}>
                    <Button appearance="primary" icon={<Flash16Regular />}
                      disabled={!data.armable || busy !== null}
                      onClick={() => {
                        const secs = Number(ttl);
                        post(
                          { action: 'arm', point: fp.point, ttlMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined, reason: 'admin chaos drill' },
                          `Armed ${fp.label} — run the target surface to observe the degradation.`,
                        );
                      }}>
                      {busy === fp.point ? 'Arming…' : 'Arm'}
                    </Button>
                  </Tooltip>
                  {armed && (
                    <Button appearance="secondary" icon={<DismissCircle16Regular />}
                      disabled={busy !== null}
                      onClick={() => post({ action: 'disarm', point: fp.point }, `${fp.label} disarmed.`)}>
                      Disarm
                    </Button>
                  )}
                </div>

                {armed && armed.recentInjections.length > 0 && (
                  <div className={styles.badgeRow}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Recent injections (audited): {armed.recentInjections.slice(-3).map((i) => new Date(i.at).toLocaleTimeString()).join(', ')}
                    </Caption1>
                  </div>
                )}
              </div>
            );
          })}

          {/* The resilience matrix — always shown (read-only inventory) */}
          <div className={styles.faultBlock}>
            <Divider />
            <div className={styles.faultHead} style={{ marginTop: tokens.spacingVerticalM }}>
              <ShieldCheckmark24Regular style={{ color: tokens.colorBrandForeground1 }} />
              <Subtitle2>Resilience matrix</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
                Which lib/azure clients retry, break, serve-stale, or honest-gate on 429/503/timeout —
                the inventory ratcheted by check-breaker-coverage.
              </Caption1>
            </div>
            <LoomDataTable<MechRow>
              columns={MATRIX_COLUMNS}
              rows={data.matrix}
              getRowId={(r) => `${r.dependency}:${r.sourceFile}`}
              density="compact"
              ariaLabel="Resilience matrix"
            />
          </div>
        </>
      )}
    </section>
  );
}
