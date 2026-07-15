'use client';

/**
 * PSR-8 — Copilot turn-latency SLO card for /admin/performance.
 *
 * Renders the LIVE first-token + full-turn SLO attainment from
 * GET /api/admin/performance/copilot-slo (copilot-slo objectives evaluated over
 * the rolling window of real recent turns). Shows the target budget, the % of
 * turns under budget, met/breaching, and the error-budget burn — the same burn
 * the tier router reads to shave a tier off a non-reasoning turn under latency
 * pressure. Real numbers (no-vaporware.md), Azure OpenAI only
 * (no-fabric-dependency.md), Fluent v9 + Loom tokens (web3-ui.md).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Badge, Button, Spinner, Text,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Timer20Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface SloEval {
  id: string;
  budgetMs: number;
  objective: number;
  sampled: number;
  good: number;
  attainment: number;
  met: boolean;
  burn: number;
}
interface SloTarget { id: string; label: string; budgetMs: number; learnUrl: string; description: string }
interface SloResponse {
  targets: SloTarget[];
  evaluations: SloEval[];
  window: { fullTurn: number; firstToken: number };
}

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minWidth: 0,
  },
  label: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  value: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightBold, lineHeight: 1.1 },
  sub: { color: tokens.colorNeutralForeground3 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  chips: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
});

function pct(rate: number): string { return `${Math.round((rate || 0) * 100)}%`; }

export function CopilotSloCard() {
  const s = useStyles();
  const [data, setData] = useState<SloResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    clientFetch('/api/admin/performance/copilot-slo', { cache: 'no-store' }, 20_000)
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((j: any) => {
        if (!j) { setErr('Sign in as a tenant admin to view Copilot SLO telemetry.'); return; }
        if (j.ok) setData(j as SloResponse);
        else setErr(j.error || 'Failed to load Copilot SLO telemetry');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const targetsById = new Map((data?.targets ?? []).map((t) => [t.id, t]));

  return (
    <Section
      title="Copilot turn-latency SLO"
      actions={
        <div className={s.toolbar}>
          <LearnPopover
            title="Copilot turn-latency SLO (PSR-8)"
            content="Objectives for the Copilot experience: 95% of turns should clear the streaming first-token budget and the full-turn budget. The rolling-window burn (breach rate ÷ allowed budget) also drives the tier router — a breaching SLO shaves a tier off a non-reasoning turn to answer faster. Targets are env-tunable (LOOM_COPILOT_SLO_FIRST_TOKEN_MS / LOOM_COPILOT_SLO_FULL_TURN_MS)."
            learnMoreHref="https://learn.microsoft.com/azure/ai-services/openai/how-to/latency"
          />
          <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={load} disabled={loading}>
            Refresh
          </Button>
        </div>
      }
    >
      {loading && !data ? (
        <Spinner size="small" label="Loading Copilot SLO…" labelPosition="after" />
      ) : err ? (
        <Text className={s.sub}>{err}</Text>
      ) : data ? (
        <>
          <div className={s.grid}>
            {data.evaluations.map((e) => {
              const t = targetsById.get(e.id);
              return (
                <div key={e.id} className={s.card}>
                  <span className={s.label}>
                    <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS, color: tokens.colorBrandForeground1 }}>
                      <Timer20Regular />
                    </span>
                    {t?.label ?? e.id}
                  </span>
                  <span className={s.value} style={{ color: e.met ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>
                    {e.sampled > 0 ? pct(e.attainment) : '—'}
                  </span>
                  <Caption1 className={s.sub}>
                    budget {Math.round(e.budgetMs / 100) / 10}s · objective {pct(e.objective)} · {e.good}/{e.sampled} turns
                  </Caption1>
                  <div className={s.chips}>
                    <Badge appearance="outline" color={e.met ? 'success' : 'danger'}>
                      {e.sampled === 0 ? 'no turns yet' : e.met ? 'SLO met' : 'breaching'}
                    </Badge>
                    {e.sampled > 0 && (
                      <Badge appearance="tint" color={e.burn > 1 ? 'warning' : 'informative'}>
                        burn {Math.round(e.burn * 100) / 100}×
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <Caption1 className={s.sub} style={{ marginTop: tokens.spacingVerticalS, display: 'block' }}>
            Live over the last {data.window.fullTurn} turns on this replica. A full-turn burn above 1× makes the tier
            router shave a tier off non-reasoning turns to protect the SLO.
          </Caption1>
        </>
      ) : null}
    </Section>
  );
}

export default CopilotSloCard;
