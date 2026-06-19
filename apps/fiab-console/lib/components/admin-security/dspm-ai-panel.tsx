'use client';

/**
 * DSPM for AI panel — the Azure-native 1:1 of Microsoft Purview DSPM for AI →
 * "Discover › Apps and agents". An admin security report of which AI agents /
 * Copilots touch sensitive-labeled data.
 *
 * Reads GET /api/admin/dspm-ai, which joins the Cosmos estate (data-agent items
 * + each bound source's sensitivity label) with real per-agent usage from the
 * `copilot.usage` telemetry the data-agent chat path emits (KQL over Log
 * Analytics). No synthetic data.
 *
 * Honest gates (per .claude/rules/no-vaporware.md):
 *   • 503 dspm_ai_not_configured → Cosmos unset (NotConfiguredBar, whole surface).
 *   • gates.mip   → Graph IP unset: labels still shown, ordering uses a static
 *                   rank + protection state is unknown (info bar).
 *   • gates.usage → Log Analytics unset: usage columns blank (info bar).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Caption1, Body1, Badge, Button, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, ShieldLockFilled, ShieldProhibitedFilled,
  Bot24Regular, Warning24Regular, TagMultiple24Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { EmptyState } from '@/lib/components/empty-state';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';

interface SourceRow { name: string; type: string; label: string | null }
interface AgentRow {
  agentId: string;
  agentName: string;
  workspaceId: string;
  itemType: string;
  sources: SourceRow[];
  totalSourceCount: number;
  sensitiveSourceCount: number;
  labelDistribution: { label: string; count: number }[];
  maxLabel: string | null;
  protected: boolean;
  usageCalls: number;
  lastUsedAt: string | null;
}
interface Summary {
  agentCount: number;
  agentsTouchingSensitive: number;
  labelCounts: { label: string; agents: number; protected: boolean }[];
  usageGated: boolean;
  windowDays: number;
}
interface ApiResp {
  ok: boolean;
  agents?: AgentRow[];
  summary?: Summary;
  gates?: { mip?: NotConfiguredHint; usage?: NotConfiguredHint };
  code?: string;
  hint?: NotConfiguredHint;
  reason?: string;
  remediation?: string;
  error?: string;
}

function labelColor(l: string | null): 'danger' | 'warning' | 'informative' | 'subtle' {
  if (!l) return 'subtle';
  if (l === 'Highly Confidential' || l === 'Restricted' || /secret/i.test(l)) return 'danger';
  if (l === 'Confidential') return 'warning';
  if (l === 'Internal') return 'informative';
  return 'subtle';
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL, display: 'block', maxWidth: '880px', lineHeight: tokens.lineHeightBase300 },
  code: {
    fontFamily: tokens.fontFamilyMonospace, fontSize: '12px',
    padding: '1px 5px', borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2,
  },
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalL,
  },
  statCard: {
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    transition: 'box-shadow 0.15s ease, transform 0.15s ease',
    ':hover': { boxShadow: tokens.shadow8, transform: 'translateY(-2px)' },
  },
  statHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  statIcon: { fontSize: '22px', color: tokens.colorNeutralForeground3, flexShrink: 0 },
  statIconAlert: { fontSize: '22px', color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  statVal: { fontSize: '32px', lineHeight: '34px', fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1 },
  statValAlert: { fontSize: '32px', lineHeight: '34px', fontWeight: tokens.fontWeightSemibold, color: tokens.colorPaletteRedForeground1 },
  statLabel: { fontSize: '12px', color: tokens.colorNeutralForeground3, textTransform: 'uppercase', letterSpacing: '0.04em' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  sourceChips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  loadingBox: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL },
  gap: { marginBottom: tokens.spacingVerticalL },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function DspmAiPanel({ days = 30 }: { days?: number }) {
  const s = useStyles();
  const [resp, setResp] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/dspm-ai?days=${days}`);
      setResp(await r.json());
    } catch (e) {
      setResp({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const agentColumns: LoomColumn<AgentRow>[] = [
    {
      key: 'agentName', label: 'Agent', width: 220, getValue: (a) => a.agentName,
      render: (a) => (
        <div>
          <strong>{a.agentName}</strong>
          <Caption1 block className={s.muted}>{a.itemType}</Caption1>
        </div>
      ),
    },
    {
      key: 'sources', label: 'Data sources touched', width: 320, getValue: (a) => a.totalSourceCount,
      render: (a) => (
        a.sources.length === 0
          ? <Caption1 className={s.muted}>No sources attached</Caption1>
          : (
            <div className={s.sourceChips}>
              {a.sources.map((src, i) => (
                <Tooltip key={`${src.name}-${i}`} relationship="label" content={`${src.type}${src.label ? ` · ${src.label}` : ' · unlabeled'}`}>
                  <Badge appearance={src.label ? 'filled' : 'outline'} color={labelColor(src.label)} size="small">
                    {src.name}
                  </Badge>
                </Tooltip>
              ))}
            </div>
          )
      ),
    },
    {
      key: 'maxLabel', label: 'Max sensitivity', width: 170, getValue: (a) => a.maxLabel || '',
      render: (a) => a.maxLabel
        ? <Badge appearance="filled" color={labelColor(a.maxLabel)} size="small">{a.maxLabel}</Badge>
        : <Caption1 className={s.muted}>None</Caption1>,
    },
    {
      key: 'protected', label: 'Protection', width: 130, getValue: (a) => (a.protected ? 1 : 0),
      render: (a) => a.sensitiveSourceCount === 0
        ? <Caption1 className={s.muted}>—</Caption1>
        : a.protected
          ? <Badge appearance="tint" color="success" icon={<ShieldLockFilled />} size="small">Protected</Badge>
          : <Badge appearance="tint" color="warning" icon={<ShieldProhibitedFilled />} size="small">Unprotected</Badge>,
    },
    {
      key: 'usageCalls', label: 'Calls', width: 100, getValue: (a) => a.usageCalls,
      render: (a) => resp?.summary?.usageGated
        ? <Caption1 className={s.muted}>—</Caption1>
        : <strong>{a.usageCalls.toLocaleString()}</strong>,
    },
    {
      key: 'lastUsedAt', label: 'Last used', width: 180, getValue: (a) => (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0),
      render: (a) => a.lastUsedAt
        ? <Caption1>{new Date(a.lastUsedAt).toLocaleString()}</Caption1>
        : <Caption1 className={s.muted}>{resp?.summary?.usageGated ? '—' : 'Never'}</Caption1>,
    },
  ];

  return (
    <>
      <Body1 className={s.intro}>
        Which AI agents and Copilots touch sensitive-labeled data. For every agent in the estate
        this report resolves the sensitivity label of each grounded data source (Cosmos), ranks
        the most-sensitive label and its protection state (Microsoft Graph Information Protection),
        and attributes real usage from the <code className={s.code}>copilot.usage</code> telemetry the agent chat path
        emits (Log Analytics KQL). No Microsoft Fabric / Power BI dependency. No synthetic data.
      </Body1>

      {/* HARD gate — Cosmos unset (whole surface). */}
      {resp && !resp.ok && resp.code === 'dspm_ai_not_configured' && (
        <NotConfiguredBar surface="DSPM for AI" hint={resp.hint} />
      )}
      {resp && !resp.ok && resp.code === 'admin_only' && (
        <MessageBar intent="warning" className={s.gap}>
          <MessageBarBody>
            <MessageBarTitle>Tenant admins only</MessageBarTitle>
            {resp.reason} {resp.remediation}
          </MessageBarBody>
        </MessageBar>
      )}
      {resp && !resp.ok && !resp.code && (
        <MessageBar intent="error" className={s.gap}>
          <MessageBarBody>
            <MessageBarTitle>Could not load DSPM for AI report</MessageBarTitle>
            {resp.error || 'unknown error'}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Per-source honest gates (the report still renders). */}
      {resp?.ok && resp.gates?.mip && (
        <NotConfiguredBar surface="Sensitivity-label ordering (Microsoft Graph)" hint={resp.gates.mip} />
      )}
      {resp?.ok && resp.gates?.usage && (
        <div className={s.gap}>
          <NotConfiguredBar surface="Per-agent usage metering (Log Analytics)" hint={resp.gates.usage} />
        </div>
      )}

      {loading && !resp && <div className={s.loadingBox}><Spinner label="Computing AI data-exposure posture…" /></div>}

      {/* Empty estate — API responded ok but no agents exist yet. */}
      {resp?.ok && resp.summary && resp.summary.agentCount === 0 && (
        <EmptyState
          icon={<Bot24Regular />}
          title="No AI agents found yet"
          body="DSPM for AI posture — which agents touch sensitive-labeled data — appears here once data agents exist in the estate. Create a data agent, operations agent, or prompt flow, attach data sources, and return to this view."
          primaryAction={{ label: 'Create a data agent', href: '/data-agent' }}
        />
      )}

      {resp?.ok && resp.summary && resp.summary.agentCount > 0 && (
        <>
          <Section
            title="AI data-exposure posture"
            actions={<Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>}
            bare
          >
            <div className={s.statsRow}>
              <div className={s.statCard}>
                <div className={s.statHead}>
                  <div className={s.statVal}>{resp.summary.agentCount}</div>
                  <Bot24Regular className={s.statIcon} />
                </div>
                <div className={s.statLabel}>AI agents</div>
              </div>
              <div className={s.statCard}>
                <div className={s.statHead}>
                  <div className={resp.summary.agentsTouchingSensitive > 0 ? s.statValAlert : s.statVal}>
                    {resp.summary.agentsTouchingSensitive}
                  </div>
                  <Warning24Regular className={resp.summary.agentsTouchingSensitive > 0 ? s.statIconAlert : s.statIcon} />
                </div>
                <div className={s.statLabel}>touch labeled data</div>
              </div>
              <div className={s.statCard}>
                <div className={s.statHead}>
                  <div className={s.statVal}>{resp.summary.labelCounts.length}</div>
                  <TagMultiple24Regular className={s.statIcon} />
                </div>
                <div className={s.statLabel}>distinct labels exposed</div>
              </div>
            </div>
          </Section>

          {resp.summary.labelCounts.length > 0 && (
            <Section title="Sensitivity labels reachable by agents">
              <div className={s.chips}>
                {resp.summary.labelCounts.map((lc) => (
                  <Badge
                    key={lc.label}
                    appearance="filled"
                    color={labelColor(lc.label)}
                    size="large"
                    icon={lc.protected ? <ShieldLockFilled /> : undefined}
                  >
                    {lc.label} · {lc.agents} agent{lc.agents === 1 ? '' : 's'}
                  </Badge>
                ))}
              </div>
            </Section>
          )}

          <Section title={`Agents (${resp.summary.windowDays}d usage window)`}>
            <LoomDataTable
              columns={agentColumns}
              rows={resp.agents || []}
              getRowId={(a) => a.agentId}
              ariaLabel="AI agents and the sensitive data they touch"
              empty="No AI agents found in this tenant yet. Create a data agent, operations agent, or prompt flow and attach data sources; it appears here once saved."
            />
          </Section>
        </>
      )}
    </>
  );
}
