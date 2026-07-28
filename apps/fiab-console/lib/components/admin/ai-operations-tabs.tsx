'use client';

/**
 * AiOperationsTabs — the /admin/ai-operations tab strip (IA-04, loom-apex Phase B).
 *
 * Per the hub-consolidation rule, every AI-operations surface lives on ONE admin
 * page instead of five sibling tiles:
 *   • Usage           — per-persona Copilot token metering (was /admin/copilot-usage).
 *   • Agent quality   — agent evals, red-team, traces, latency SLO (was /admin/agent-quality).
 *   • Copilot quality — answer / search / tier / prompt / budget quality, which
 *                       keeps its own five sub-tabs (was /admin/copilot-quality).
 *   • Model Fabric    — closed-loop promote/demote (was /admin/model-fabric).
 *   • Parity Autopilot— capture → vision-diff → gap-issue ledger (was
 *                       /admin/parity-autopilot).
 *
 * Every pane component is the SAME component the standalone page rendered —
 * moved, not rewritten — including its TeachingBanner and its LearnPopover
 * (now carried by HubTabHeader). All five old routes survive as redirect stubs.
 *
 * Deep-linkable via `?tab=<value>` (HealthHubTabs pattern), plus `?sub=<value>`
 * for the Copilot-quality sub-tabs so /admin/ai-operations?tab=quality&sub=budgets
 * lands exactly where the token-budget Fix-it link points.
 *
 * Every tab reads a real Azure OpenAI / Cosmos / Azure ML backend and honest-
 * gates when one is unwired — no Fabric dependency anywhere.
 */

import { useEffect, useState } from 'react';
import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import {
  DataUsage24Regular, Bot24Regular, TargetArrow24Regular, Molecule24Regular,
  BotSparkle24Regular,
} from '@fluentui/react-icons';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { HubTabHeader } from '@/lib/components/admin/hub-tab-header';
import { CopilotUsagePane } from '@/lib/components/admin/copilot-usage';
import { AgentQualityPanel } from '@/lib/components/admin/agent-quality-panel';
import { CopilotQualityTabs, COPILOT_QUALITY_SUBTABS } from '@/lib/components/admin/copilot-quality-tabs';
import { ModelFabricPanel } from '@/lib/components/admin/model-fabric-panel';
import { ParityAutopilotPanel } from '@/lib/components/admin/parity-autopilot-panel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tabs: { marginBottom: tokens.spacingVerticalS },
});

export type AiOperationsTab = 'usage' | 'agents' | 'quality' | 'fabric' | 'autopilot';

/** Every value `?tab=` accepts — also the contract the redirect stubs target. */
export const AI_OPERATIONS_TABS: readonly AiOperationsTab[] =
  ['usage', 'agents', 'quality', 'fabric', 'autopilot'] as const;

type QualitySubTab = (typeof COPILOT_QUALITY_SUBTABS)[number];

export function AiOperationsTabs() {
  const styles = useStyles();
  const [tab, setTab] = useState<AiOperationsTab>('usage');
  const [qualitySub, setQualitySub] = useState<QualitySubTab | undefined>(undefined);
  // The sub-tab is only honored on first paint; `ready` defers rendering the
  // quality pane until the URL has been read so a deep link never flashes the
  // default sub-tab first.
  const [ready, setReady] = useState(false);

  // Deep link: /admin/ai-operations?tab=quality&sub=budgets (client-only read —
  // no Suspense dance), the same pattern HealthHubTabs uses.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const wanted = params.get('tab');
      if (wanted && (AI_OPERATIONS_TABS as readonly string[]).includes(wanted)) {
        setTab(wanted as AiOperationsTab);
      }
      const sub = params.get('sub');
      if (sub && (COPILOT_QUALITY_SUBTABS as readonly string[]).includes(sub)) {
        setQualitySub(sub as QualitySubTab);
      }
    } catch { /* no window (SSR) — default tab stands */ }
    setReady(true);
  }, []);

  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as AiOperationsTab)}
        aria-label="AI operations sections"
      >
        <Tab value="usage" icon={<DataUsage24Regular />}>Usage</Tab>
        <Tab value="agents" icon={<Bot24Regular />}>Agent quality</Tab>
        <Tab value="quality" icon={<TargetArrow24Regular />}>Copilot quality</Tab>
        <Tab value="fabric" icon={<Molecule24Regular />}>Model Fabric</Tab>
        <Tab value="autopilot" icon={<BotSparkle24Regular />}>Parity Autopilot</Tab>
      </TabList>

      {tab === 'usage' && (
        <>
          <HubTabHeader
            title="Copilot usage"
            learn={{
              title: 'Copilot usage',
              content: 'Per-persona Copilot token metering sourced from Application Insights copilot.usage events via Log Analytics KQL. Every count is the live Azure OpenAI prompt/completion split — real prompt and completion tokens broken down by persona, model, day, and hashed user. No synthetic or estimated numbers.',
              tips: [
                'Break down consumption by persona and model to see which assistants and deployments drive spend.',
                'User identities are hashed, so you can spot heavy users without exposing who they are.',
                'The panel shows an honest gate when Application Insights / Log Analytics is not wired up.',
              ],
              learnMoreHref: 'https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-overview',
            }}
          />
          <TeachingBanner
            surfaceKey="admin-copilot-usage"
            title="Real token metering, per persona"
            message="Every count comes from Application Insights copilot.usage events via Log Analytics KQL — live Azure OpenAI prompt/completion splits by persona, model, day, and hashed user. No synthetic numbers. An honest gate shows the exact env var when App Insights isn't wired up."
            icon={DataUsage24Regular}
            accent="var(--loom-accent-blue)"
            learnMoreHref="https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-overview"
          />
          <CopilotUsagePane />
        </>
      )}

      {tab === 'agents' && (
        <>
          <HubTabHeader
            title="Agent quality"
            learn={{
              title: 'Agent Quality — evals, red-team, traces & SLOs',
              content:
                'One home for agent evaluation + observability: LLM-judge eval sets with regression-vs-baseline, defensive red-team refusal results, per-agent trace timelines with token/cost/latency and model tier, and the live Copilot turn-latency SLO. Every tile reads a real Azure OpenAI / Cosmos backend — no Fabric dependency.',
              tips: [
                'Evaluations replay a prompt-set through the agent, then an AOAI judge scores 1–5',
                'Red-team refusal rate is the Azure-native analog of the AI Red Teaming Agent',
                'Traces surface real token usage + estimated cost + the tier-router model tier',
                'Latency SLO is the same objective the tier router reads under load',
              ],
              learnMoreHref: 'https://learn.microsoft.com/azure/ai-foundry/concepts/observability',
            }}
          />
          <AgentQualityPanel />
        </>
      )}

      {tab === 'quality' && ready && (
        <>
          <HubTabHeader
            title="Copilot quality"
            learn={{
              title: 'Copilot quality — retrieval & grounding evals',
              content:
                'Per-surface answer quality for the Loom Copilot: retrieval hit-rate / MRR against the golden eval sets, LLM-judge grounding/relevance/completeness, and the pass-rate that gates a corpus change. Every score is a REAL run of the copilot-evaluator Function against the same searchDocs + Azure OpenAI path production uses — scored, capped, and written to Cosmos. Compares each surface against its E3 floor and trends it across nightly + per-roll runs.',
              tips: [
                'Retrieval hit-rate is deterministic and authoritative even when the LLM judge is deferred (daily cap).',
                '"Run now" fires the same E2 HTTP trigger the nightly schedule + every roll use.',
                'A surface below its floor is the signal a corpus or prompt change regressed retrieval or grounding.',
                'Drill in to see the exact expected-vs-retrieved chunks and the judge’s own rationale per failing question.',
              ],
              learnMoreHref: 'https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai',
            }}
          />
          <TeachingBanner
            surfaceKey="admin-copilot-quality"
            title="Real Copilot answer-quality evals"
            message="Scores come from the copilot-evaluator Function running the golden eval sets through the real retrieval + Azure OpenAI judge path and writing to Cosmos. Retrieval hit-rate/MRR is deterministic; grounding is LLM-judged (capped per day). Each surface is measured against its E3 floor. No synthetic numbers — an honest gate shows the exact remediation when the evaluator Function is unwired."
            icon={TargetArrow24Regular}
            accent="var(--loom-accent-blue)"
            learnMoreHref="https://learn.microsoft.com/azure/ai-foundry/concepts/evaluation-approach-gen-ai"
          />
          <CopilotQualityTabs initialTab={qualitySub} />
        </>
      )}

      {tab === 'fabric' && (
        <>
          <HubTabHeader
            title="Model Fabric"
            learn={{
              title: 'Closed-Loop Model Fabric — auto promote/demote from live eval',
              content:
                'A self-optimizing loop that fuses the tier-router (routing), agent evals + red-team (quality/safety), model serving (traffic-split) and the Copilot latency SLO (observability) into automatic promote/demote decisions. It promotes the live-eval winner and demotes regressions across serving traffic-splits and the reasoning tier — in Auto-apply it actuates the real Azure ML traffic-split + reasoning-tier deployment; in Propose-only it shows what it would do. Every action is audited. All signals are real Azure OpenAI / Cosmos / Azure ML data — no Fabric dependency.',
              tips: [
                'Propose-only (default) computes decisions but changes nothing until you run it',
                'Auto-apply promotes the eval winner + demotes regressions on every run',
                'Hysteresis (cooldown + margin + min-sample) stops the loop from flapping',
                'The loop pauses actuation while the Copilot latency SLO is breaching',
                'Every promote/demote is written to the audit log',
              ],
              learnMoreHref: 'https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments',
            }}
          />
          <ModelFabricPanel />
        </>
      )}

      {tab === 'autopilot' && (
        <>
          <HubTabHeader
            title="Parity Autopilot"
            learn={{
              title: 'Parity Autopilot (WS-10.5)',
              content:
                'A scheduled self-audit that keeps the UI honest at scale: it captures a live Playwright screenshot of a surface, runs an Azure OpenAI vision diff against that surface’s parity doc, and for every "built" capability it can’t see it proposes a fix plan and files a GitHub issue. This tab is the run ledger + open-gap view.',
              tips: [
                'Runs are driven by .github/workflows/loom-parity-autopilot.yml (schedule + workflow_dispatch)',
                'Vision diff + plan-model use the deployed AOAI (gpt-4o vision + reasoning tier) — honest-gated if unset',
                'Issue filing reuses LOOM_FEEDBACK_GITHUB_TOKEN; air-gapped boundaries stay gated by design',
              ],
              learnMoreHref: 'https://learn.microsoft.com/azure/ai-services/openai/how-to/gpt-with-vision',
            }}
          />
          <ParityAutopilotPanel />
        </>
      )}
    </div>
  );
}
