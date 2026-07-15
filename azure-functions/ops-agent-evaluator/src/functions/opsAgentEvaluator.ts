/**
 * ops-agent-evaluator — timer trigger (G3).
 *
 * On OPS_AGENT_EVALUATOR_CRON (default every 5 minutes) the Function:
 *   1. reads every operations-agent item (+ its triggers) from Cosmos,
 *   2. evaluates each ADX-sourced trigger's KQL against the bound Eventhouse
 *      (Log-Analytics triggers evaluate continuously via Azure Monitor already),
 *   3. when a trigger FIRES (KQL returns ≥1 row), asks Azure OpenAI to interpret
 *      the situation + recommend an action, and
 *   4. routes the recommendation: requireApproval=true → dispatch the approval
 *      Logic App (Teams adaptive card, human-in-the-loop); otherwise the action
 *      is autonomous (logged for the bound action group to fire).
 *
 * Every external dependency is a REAL Azure call under the Function's managed
 * identity. Missing config → an honest early-exit log (no-vaporware). Azure-
 * native, no Microsoft Fabric / Power Automate dependency.
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import {
  missingConfig,
  evaluableRules,
  buildReasoningMessages,
  decide,
} from '../evaluator-core';
import { readOpsAgents, adxQuery, aoaiChat, dispatchApprovalLogicApp } from '../azure-clients';

const CRON = process.env.OPS_AGENT_EVALUATOR_CRON || '0 */5 * * * *';

export async function opsAgentEvaluator(_timer: Timer, context: InvocationContext): Promise<void> {
  const env = process.env;
  const missing = missingConfig(env);
  if (missing.length) {
    context.warn(`[ops-agent-evaluator] honest-gate: not configured — set ${missing.join(', ')}. No-op tick.`);
    return;
  }

  const cosmosEndpoint = env.LOOM_COSMOS_ENDPOINT!;
  const cosmosDb = env.LOOM_COSMOS_DATABASE || 'loom';
  const aoaiEndpoint = env.LOOM_AOAI_ENDPOINT!;
  const aoaiDeployment = env.LOOM_AOAI_DEPLOYMENT || 'gpt-4o';
  const defaultClusterUri = env.LOOM_KUSTO_CLUSTER_URI || '';
  const defaultDb = env.LOOM_KUSTO_DEFAULT_DB || 'loomdb';
  const armEndpoint = env.LOOM_ARM_ENDPOINT || 'https://management.azure.com';
  const subscriptionId = env.LOOM_SUBSCRIPTION_ID || '';
  const approvalRg = env.LOOM_OPS_AGENT_APPROVAL_RG || env.LOOM_DLZ_RG || '';
  const approvalLogicApp = env.LOOM_OPS_AGENT_APPROVAL_LOGICAPP || '';

  let agents;
  try {
    agents = await readOpsAgents(cosmosEndpoint, cosmosDb);
  } catch (e: any) {
    context.error(`[ops-agent-evaluator] Cosmos read failed: ${e?.message || e}`);
    return;
  }

  let evaluated = 0, fired = 0, approvals = 0, autonomous = 0;

  for (const agent of agents) {
    for (const rule of evaluableRules(agent)) {
      const clusterUri = rule.adxClusterUri || defaultClusterUri;
      const database = rule.adxDatabase || defaultDb;
      if (!clusterUri) {
        context.warn(`[ops-agent-evaluator] agent ${agent.id} rule ${rule.name}: no ADX cluster (set LOOM_KUSTO_CLUSTER_URI). Skipping.`);
        continue;
      }
      evaluated++;
      let result;
      try {
        result = await adxQuery(clusterUri, database, rule.query!);
      } catch (e: any) {
        context.error(`[ops-agent-evaluator] agent ${agent.id} rule ${rule.name}: ADX query failed: ${e?.message || e}`);
        continue;
      }
      if (result.count === 0) continue; // did not fire
      fired++;

      let recommendation = '';
      try {
        recommendation = await aoaiChat(aoaiEndpoint, aoaiDeployment, buildReasoningMessages(agent, rule, result));
      } catch (e: any) {
        context.error(`[ops-agent-evaluator] agent ${agent.id} rule ${rule.name}: AOAI reasoning failed: ${e?.message || e}`);
        continue;
      }

      const decision = decide(rule, recommendation);
      if (decision.kind === 'skip') { context.warn(`[ops-agent-evaluator] ${agent.id}/${rule.name}: ${decision.reason}`); continue; }

      if (decision.kind === 'approval') {
        approvals++;
        if (!approvalLogicApp || !subscriptionId || !approvalRg) {
          context.warn(`[ops-agent-evaluator] ${agent.id}/${rule.name}: approval required but Logic App not wired (set LOOM_OPS_AGENT_APPROVAL_LOGICAPP + LOOM_SUBSCRIPTION_ID + LOOM_OPS_AGENT_APPROVAL_RG). Recommendation: ${decision.recommendation}`);
          continue;
        }
        try {
          const out = await dispatchApprovalLogicApp(armEndpoint, subscriptionId, approvalRg, approvalLogicApp, {
            agentName: agent.displayName,
            ruleName: decision.ruleName,
            recommendation: decision.recommendation,
            approverUpn: String(agent.state?.recipient || ''),
          });
          context.log(`[ops-agent-evaluator] ${agent.id}/${rule.name}: approval dispatched (status ${out.status}).`);
        } catch (e: any) {
          context.error(`[ops-agent-evaluator] ${agent.id}/${rule.name}: approval dispatch failed: ${e?.message || e}`);
        }
      } else {
        autonomous++;
        // Autonomous: the trigger's Azure Monitor action group fires the bound
        // action directly; the evaluator records the reasoning for the audit log.
        context.log(`[ops-agent-evaluator] ${agent.id}/${rule.name}: AUTONOMOUS action (${rule.action?.kind || 'Teams'}). Recommendation: ${decision.recommendation}`);
      }
    }
  }

  context.log(`[ops-agent-evaluator] tick complete — agents=${agents.length} evaluated=${evaluated} fired=${fired} approvals=${approvals} autonomous=${autonomous}`);
}

app.timer('opsAgentEvaluator', {
  schedule: CRON,
  runOnStartup: false,
  handler: opsAgentEvaluator,
});
