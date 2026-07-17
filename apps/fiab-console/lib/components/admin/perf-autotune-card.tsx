'use client';

/**
 * PERF-4.2 — auto-adjust card (on /admin/performance).
 *
 * Per-tunable-type "Auto-adjust" toggles + admin min/max bounds, persisted in
 * the perf-tunables Cosmos doc. When a class is ON, the auto-tune engine
 * (piggybacked on the warm-pool sweep, ~5 min cadence) applies that class of
 * recommendation automatically — every value clamped inside the bounds set
 * here. Includes the applied-change audit trail (manual + auto). Fluent v9 +
 * Loom tokens only (web3-ui.md); real Cosmos-backed config via
 * /api/admin/performance/tunables (no-vaporware.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Caption1,
  MessageBar,
  MessageBarBody,
  SpinButton,
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Settings20Regular, History20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface Bounds {
  enabled: boolean;
  min: number;
  max: number;
}
interface AuditRow {
  id: string;
  at: number;
  actor: string;
  recommendationId: string;
  cls: string;
  summary: string;
  ok: boolean;
  error?: string;
}
interface TunablesModel {
  autoAdjust: Record<string, Bounds>;
  cacheOverride: Record<string, unknown>;
  updatedAt: number;
  updatedBy?: string;
}

const CLASS_META: Record<string, { label: string; unit: string; hint: string }> = {
  'spark-pool-size': {
    label: 'Spark warm-pool size',
    unit: 'sessions',
    hint: 'Raises/lowers the warm-session target on measured cold-start rate.',
  },
  'spark-session-ttl': {
    label: 'Warm-session idle TTL',
    unit: 'seconds',
    hint: 'Extends the idle TTL when sessions expire just before demand returns.',
  },
  'cache-ttl': {
    label: 'Result-cache TTL',
    unit: 'seconds',
    hint: 'Raises the cache TTL when the hit-rate is under target with real volume.',
  },
  'adx-autoscale': {
    label: 'ADX optimized autoscale',
    unit: 'instances',
    hint: 'Enables the native ADX autoscale window when query p95 breaches the bar.',
  },
  'warehouse-scale': {
    label: 'Warehouse DWU scale',
    unit: 'DWU ladder index',
    hint: 'One bounded DWU step up on persistent dedicated-pool p95 breach (no native autoscale exists; a scale briefly reconnects queries).',
  },
};

const useStyles = makeStyles({
  rows: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  rowLabel: { display: 'flex', flexDirection: 'column', minWidth: '240px', flexGrow: 1 },
  hint: { color: tokens.colorNeutralForeground3 },
  boundsWrap: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spin: { width: '110px' },
  audit: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  auditRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    alignItems: 'center',
    color: tokens.colorNeutralForeground2,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  bar: { marginBottom: tokens.spacingVerticalM },
});

export function PerfAutoTuneCard() {
  const styles = useStyles();
  const [model, setModel] = useState<TunablesModel | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    clientFetch('/api/admin/performance/tunables', { cache: 'no-store' }, 30_000)
      .then((r) => r.json())
      .then((j: any) => {
        if (j?.ok) {
          setModel(j.tunables as TunablesModel);
          setAudit((j.audit ?? []) as AuditRow[]);
        } else setErr(j?.error || 'Failed to load tunables');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const patchClass = useCallback(
    (cls: string, patch: Partial<Bounds>) => {
      if (!model) return;
      const next = { ...model.autoAdjust[cls], ...patch };
      setBusy(true);
      setErr(null);
      setNote(null);
      clientFetch(
        '/api/admin/performance/tunables',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ autoAdjust: { [cls]: next } }),
        },
        30_000,
      )
        .then(async (r) => {
          const j = await r.json();
          if (r.status === 403) {
            setErr('Tenant admin required to change auto-adjust settings.');
            return;
          }
          if (j?.ok) {
            setModel(j.tunables as TunablesModel);
            setAudit((j.audit ?? []) as AuditRow[]);
            setNote(`Saved — ${CLASS_META[cls]?.label ?? cls} auto-adjust updated (applies on the next auto-tune tick).`);
          } else setErr(j?.error || 'Save failed');
        })
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    },
    [model],
  );

  const learn = (
    <LearnPopover
      title="Auto-adjust (PERF-4.2)"
      content="Each tunable type gets its own auto-pilot toggle. When ON, the auto-tune engine (running on the warm-pool sweep heartbeat, ~5 min) applies that recommendation class automatically — one change per class per tick, a 30-min per-recommendation cooldown, ARM-touching classes only after the signal persists two consecutive ticks, and every value clamped inside the admin min/max here. All applies land in the audit trail below."
      learnMoreHref="https://learn.microsoft.com/azure/well-architected/performance-efficiency/principles"
    />
  );

  return (
    <Section title="Auto-adjust" actions={learn}>
      {err && (
        <MessageBar intent="error" className={styles.bar}>
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
      {note && (
        <MessageBar intent="success" className={styles.bar}>
          <MessageBarBody>{note}</MessageBarBody>
        </MessageBar>
      )}

      {loading || !model ? (
        <Spinner label="Loading auto-adjust settings…" />
      ) : (
        <>
          <div className={styles.rows}>
            {Object.entries(model.autoAdjust).map(([cls, bounds]) => {
              const meta = CLASS_META[cls] ?? { label: cls, unit: '', hint: '' };
              return (
                <div key={cls} className={styles.row}>
                  <span aria-hidden>
                    <Settings20Regular />
                  </span>
                  <div className={styles.rowLabel}>
                    <Text weight="semibold">{meta.label}</Text>
                    <Caption1 className={styles.hint}>{meta.hint}</Caption1>
                  </div>
                  <Switch
                    checked={bounds.enabled}
                    disabled={busy}
                    label={bounds.enabled ? 'Auto-adjust ON' : 'Auto-adjust OFF'}
                    onChange={(_, d) => patchClass(cls, { enabled: !!d.checked })}
                  />
                  <div className={styles.boundsWrap}>
                    <Caption1>min</Caption1>
                    <SpinButton
                      className={styles.spin}
                      value={bounds.min}
                      disabled={busy}
                      onChange={(_, d) => {
                        const v = typeof d.value === 'number' ? d.value : Number(d.displayValue);
                        if (Number.isFinite(v)) patchClass(cls, { min: v });
                      }}
                    />
                    <Caption1>max</Caption1>
                    <SpinButton
                      className={styles.spin}
                      value={bounds.max}
                      disabled={busy}
                      onChange={(_, d) => {
                        const v = typeof d.value === 'number' ? d.value : Number(d.displayValue);
                        if (Number.isFinite(v)) patchClass(cls, { max: v });
                      }}
                    />
                    <Badge appearance="outline">{meta.unit}</Badge>
                  </div>
                </div>
              );
            })}
          </div>

          <Text weight="semibold">
            <History20Regular aria-hidden style={{ verticalAlign: 'text-bottom' }} /> Applied changes (last 20)
          </Text>
          <div className={styles.audit}>
            {audit.length === 0 ? (
              <Caption1 className={styles.hint}>
                No changes applied yet — manual Applies and auto-tune applies both land here (30-day retention).
              </Caption1>
            ) : (
              audit.map((a) => (
                <Caption1 key={a.id} className={styles.auditRow}>
                  <Badge appearance="tint" color={a.ok ? 'success' : 'danger'}>
                    {a.ok ? 'applied' : 'failed'}
                  </Badge>
                  <Badge appearance="outline" color={a.actor === 'auto' ? 'brand' : 'informative'}>
                    {a.actor === 'auto' ? 'auto-tune' : a.actor}
                  </Badge>
                  <span>{new Date(a.at).toLocaleString()}</span>
                  <span>{a.summary}</span>
                  {a.error && <span>— {a.error}</span>}
                </Caption1>
              ))
            )}
          </div>
        </>
      )}
    </Section>
  );
}

export default PerfAutoTuneCard;
