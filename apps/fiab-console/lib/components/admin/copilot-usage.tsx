'use client';

/**
 * Copilot usage panel — REAL per-persona token consumption from App Insights.
 *
 * Reads /api/admin/copilot-usage, which runs KQL against the Loom Log Analytics
 * workspace over the `copilot.usage` custom events the Copilot orchestrator and
 * the copilot-chat Function emit (real AOAI prompt_tokens / completion_tokens —
 * no synthetic numbers).
 *
 * Two exports:
 *   • CopilotUsagePane   — full admin page: KPI cards + per-persona breakdown +
 *                          daily trend sparkline + per-model + per-user tables.
 *   • CopilotUsageInline — compact KPI strip for the Monitor → Cost tab.
 *
 * Honest gates:
 *   • gate     → App Insights / Log Analytics unconfigured (warning MessageBar
 *                naming the exact env var).
 *   • noEvents → workspace OK but no Copilot calls recorded yet (info MessageBar).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Caption1, Body1, Subtitle2, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface PersonaRow {
  persona: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}
interface DayRow {
  day: string;
  model: string;
  persona: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}
interface UserRow {
  userHash: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}
interface ModelRow {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}
interface UsageSummary {
  byPersona: PersonaRow[];
  byDay: DayRow[];
  byUser: UserRow[];
  totals: { promptTokens: number; completionTokens: number; totalTokens: number; calls: number };
  models: string[];
  days: number;
}
interface Gate { missing: string[]; message: string }

interface ApiResp {
  ok: boolean;
  data?: UsageSummary | null;
  noEvents?: boolean;
  gate?: Gate;
  error?: string;
}

const PERSONA_LABELS: Record<string, string> = {
  'cross-item': 'Cross-item Copilot',
  'help-chat': 'Help chat widget',
  notebook: 'Notebook Copilot',
  unknown: 'Other',
};
const personaLabel = (p: string) => PERSONA_LABELS[p] || p;

const fmt = (n: number) => n.toLocaleString();

const useStyles = makeStyles({
  intro: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalL,
    display: 'block',
  },
  statsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  statCard: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  statVal: {
    fontSize: '30px',
    lineHeight: '34px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  statLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
  },
  barLabel: {
    fontSize: '13px',
    minWidth: '170px',
    maxWidth: '170px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  barTrack: {
    flex: 1,
    height: '8px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: tokens.colorBrandBackground,
    borderRadius: tokens.borderRadiusSmall,
  },
  barCount: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    minWidth: '70px',
    textAlign: 'right',
  },
  sparkRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '2px',
    height: '80px',
    marginTop: tokens.spacingVerticalS,
  },
  sparkBar: {
    flex: 1,
    minWidth: '4px',
    backgroundColor: tokens.colorBrandBackground,
    borderRadius: tokens.borderRadiusSmall,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  loadingBox: {
    display: 'flex',
    justifyContent: 'center',
    padding: tokens.spacingVerticalXXL,
  },
  gap: { marginBottom: tokens.spacingVerticalL },
});

function useCopilotUsage(days: number) {
  const [resp, setResp] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/copilot-usage?days=${days}`);
      const j: ApiResp = await r.json();
      setResp(j);
    } catch (e) {
      setResp({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);
  return { resp, loading, reload: load };
}

function GateBar({ gate }: { gate: Gate }) {
  const s = useStyles();
  return (
    <MessageBar intent="warning" className={s.gap}>
      <MessageBarBody>
        <MessageBarTitle>App Insights metering not configured</MessageBarTitle>
        {gate.message}
      </MessageBarBody>
    </MessageBar>
  );
}

function NoEventsBar() {
  const s = useStyles();
  return (
    <MessageBar intent="info" className={s.gap}>
      <MessageBarBody>
        <MessageBarTitle>No Copilot calls recorded yet</MessageBarTitle>
        Make a real call from the Copilot pane — once the first session completes, per-persona
        token counts appear here (typically within ~5 minutes of App Insights ingestion).
      </MessageBarBody>
    </MessageBar>
  );
}

/** Roll the per-(model,day) rows up to per-model totals for the model table. */
function modelTotals(byDay: DayRow[]): ModelRow[] {
  const m = new Map<string, ModelRow>();
  for (const d of byDay) {
    const key = d.model || '(unspecified)';
    const cur = m.get(key) || { model: key, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    cur.promptTokens += d.promptTokens;
    cur.completionTokens += d.completionTokens;
    cur.totalTokens += d.totalTokens;
    cur.calls += d.calls;
    m.set(key, cur);
  }
  return Array.from(m.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Sum tokens by day (across persona/model) for the trend sparkline. */
function dailyTotals(byDay: DayRow[]): Array<{ day: string; totalTokens: number; calls: number }> {
  const m = new Map<string, { day: string; totalTokens: number; calls: number }>();
  for (const d of byDay) {
    const cur = m.get(d.day) || { day: d.day, totalTokens: 0, calls: 0 };
    cur.totalTokens += d.totalTokens;
    cur.calls += d.calls;
    m.set(d.day, cur);
  }
  return Array.from(m.values()).sort((a, b) => a.day.localeCompare(b.day));
}

/** KPI stat cards shared by the full pane + the inline cost variant. */
function KpiCards({ totals }: { totals: UsageSummary['totals'] }) {
  const s = useStyles();
  return (
    <div className={s.statsRow}>
      <div className={s.statCard}>
        <div className={s.statVal}>{fmt(totals.promptTokens)}</div>
        <div className={s.statLabel}>prompt tokens</div>
      </div>
      <div className={s.statCard}>
        <div className={s.statVal}>{fmt(totals.completionTokens)}</div>
        <div className={s.statLabel}>completion tokens</div>
      </div>
      <div className={s.statCard}>
        <div className={s.statVal}>{fmt(totals.totalTokens)}</div>
        <div className={s.statLabel}>total tokens</div>
      </div>
      <div className={s.statCard}>
        <div className={s.statVal}>{fmt(totals.calls)}</div>
        <div className={s.statLabel}>copilot calls</div>
      </div>
    </div>
  );
}

/** Full standalone admin pane. */
export function CopilotUsagePane({ days = 30 }: { days?: number }) {
  const s = useStyles();
  const { resp, loading, reload } = useCopilotUsage(days);

  const data = resp?.ok ? resp.data ?? null : null;

  const personaMax = Math.max(1, ...((data?.byPersona || []).map((p) => p.totalTokens)));
  const daily = useMemo(() => (data ? dailyTotals(data.byDay) : []), [data]);
  const maxDay = Math.max(1, ...daily.map((d) => d.totalTokens));
  const models = useMemo(() => (data ? modelTotals(data.byDay) : []), [data]);

  const modelColumns = useMemo<LoomColumn<ModelRow>[]>(() => [
    { key: 'model', label: 'Model', width: 220, getValue: (r) => r.model, render: (r) => <strong>{r.model}</strong> },
    { key: 'calls', label: 'Calls', width: 110, getValue: (r) => r.calls, render: (r) => fmt(r.calls) },
    { key: 'promptTokens', label: 'Prompt', width: 140, getValue: (r) => r.promptTokens, render: (r) => fmt(r.promptTokens) },
    { key: 'completionTokens', label: 'Completion', width: 140, getValue: (r) => r.completionTokens, render: (r) => fmt(r.completionTokens) },
    { key: 'totalTokens', label: 'Total', width: 140, getValue: (r) => r.totalTokens, render: (r) => <strong>{fmt(r.totalTokens)}</strong> },
  ], []);

  const userColumns = useMemo<LoomColumn<UserRow>[]>(() => [
    { key: 'userHash', label: 'User (hashed)', width: 200, getValue: (r) => r.userHash, render: (r) => <code>{r.userHash || '—'}</code> },
    { key: 'calls', label: 'Calls', width: 110, getValue: (r) => r.calls, render: (r) => fmt(r.calls) },
    { key: 'promptTokens', label: 'Prompt', width: 140, getValue: (r) => r.promptTokens, render: (r) => fmt(r.promptTokens) },
    { key: 'completionTokens', label: 'Completion', width: 140, getValue: (r) => r.completionTokens, render: (r) => fmt(r.completionTokens) },
    { key: 'totalTokens', label: 'Total', width: 140, getValue: (r) => r.totalTokens, render: (r) => <strong>{fmt(r.totalTokens)}</strong> },
  ], []);

  return (
    <>
      <Body1 className={s.intro}>
        Per-persona Copilot token consumption over the last {days} days. Real prompt / completion
        token counts from the Azure OpenAI usage field, emitted as <code>copilot.usage</code> events
        to App Insights and queried from Log Analytics (KQL). No synthetic numbers.
      </Body1>

      {resp && !resp.ok && resp.gate && <GateBar gate={resp.gate} />}
      {resp && !resp.ok && !resp.gate && (
        <MessageBar intent="error" className={s.gap}>
          <MessageBarBody>
            <MessageBarTitle>Could not load Copilot usage</MessageBarTitle>
            {resp.error || 'unknown error'}
          </MessageBarBody>
        </MessageBar>
      )}
      {resp && resp.ok && resp.noEvents && <NoEventsBar />}

      {loading && !resp && (
        <div className={s.loadingBox}><Spinner label="Querying App Insights…" /></div>
      )}

      {data && (
        <>
          <Section
            title="Token totals"
            actions={<Button icon={<ArrowSync24Regular />} onClick={reload} disabled={loading}>Refresh</Button>}
            bare
          >
            <KpiCards totals={data.totals} />
          </Section>

          <Section title="By persona">
            <div className={s.panel}>
              <Subtitle2>Total tokens per Copilot surface</Subtitle2>
              {data.byPersona.length === 0 && <Caption1 className={s.muted}>No persona data yet.</Caption1>}
              {data.byPersona.map((p) => (
                <div key={p.persona} className={s.bar}>
                  <span className={s.barLabel}>{personaLabel(p.persona)}</span>
                  <div className={s.barTrack}>
                    <div className={s.barFill} style={{ width: `${(p.totalTokens / personaMax) * 100}%` }} />
                  </div>
                  <span className={s.barCount}>{fmt(p.totalTokens)}</span>
                  <Badge appearance="outline" size="small">{fmt(p.calls)} calls</Badge>
                </div>
              ))}
            </div>
          </Section>

          <Section title={`Daily token trend (${days}d)`}>
            <div className={s.panel}>
              {daily.length === 0 && (
                <Caption1 className={s.muted}>No daily activity in this window yet.</Caption1>
              )}
              {daily.length > 0 && (
                <div className={s.sparkRow}>
                  {daily.map((d) => (
                    <div
                      key={d.day}
                      className={s.sparkBar}
                      style={{ height: `${Math.max(4, (d.totalTokens / maxDay) * 100)}%` }}
                      title={`${d.day}: ${fmt(d.totalTokens)} tokens · ${fmt(d.calls)} calls`}
                    />
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title="By model">
            <LoomDataTable
              columns={modelColumns}
              rows={models}
              getRowId={(r) => r.model}
              ariaLabel="Copilot tokens by model"
              empty="No model-level usage yet."
            />
          </Section>

          <Section title="Top users (hashed, top 20)">
            <LoomDataTable
              columns={userColumns}
              rows={data.byUser}
              getRowId={(r) => r.userHash}
              ariaLabel="Copilot tokens by user"
              empty="No per-user usage yet."
            />
          </Section>
        </>
      )}
    </>
  );
}

/** Compact KPI strip for the Monitor → Cost tab. */
export function CopilotUsageInline({ days = 30 }: { days?: number }) {
  const { resp, loading } = useCopilotUsage(days);
  const data = resp?.ok ? resp.data ?? null : null;

  return (
    <Section title={`Copilot token consumption (${days}d)`}>
      {resp && !resp.ok && resp.gate && <GateBar gate={resp.gate} />}
      {resp && resp.ok && resp.noEvents && <NoEventsBar />}
      {loading && !resp && <Spinner label="Querying App Insights…" />}
      {data && <KpiCards totals={data.totals} />}
    </Section>
  );
}
