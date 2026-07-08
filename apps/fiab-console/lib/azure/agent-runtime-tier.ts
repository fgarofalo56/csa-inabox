/**
 * Agent-runtime TIER selection — the Gov backstop plumbing for the Foundry
 * Agent Service thread/run/step inspector path (PRP AIF-8).
 *
 * The Foundry Agents playground + the data-agent run-steps inspector run a
 * question through an agent and render the run STEPS via
 * `foundry-agent-client.runAgentAndInspect()`, which targets the
 * `services.ai.azure.com` Agent Service. That host has no confirmed
 * GCC-High / IL5 endpoint, so in Gov the whole surface would hard-gate.
 *
 * This module picks the runtime tier by HONEST detection and dispatches to the
 * right backend, returning the SAME `AgentRunInspection` shape either way:
 *
 *   • `foundry-agent-service` — the default. Used whenever the Foundry project
 *     endpoint is configured (Commercial / GCC, or an opted-in Gov project).
 *   • `maf` — the OSS Microsoft-Agent-Framework tier (`loom-copilot-maf`
 *     Container App, Gov AOAI direct). Auto-selected ONLY when the Foundry
 *     project endpoint is ABSENT *and* we're in an Azure Government boundary
 *     *and* `LOOM_MAF_ENDPOINT` is wired (the MAF app is deployed). This mirrors
 *     the orchestrator's MAF tier in `copilot-orchestrator.ts` — same app, a new
 *     `/agent-run` endpoint.
 *
 * No Fabric/Power BI dependency; both tiers are AOAI-backed. When neither tier
 * can serve the run, the caller's existing honest gate
 * (FoundryAgentNotConfiguredError → 501) still fires.
 */
import { isGovCloud } from './cloud-endpoints';
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from './fetch-with-timeout';
import {
  runAgentAndInspect,
  FoundryAgentNotConfiguredError,
  type AgentRunInspection,
  type FoundryAgentConfigOverride,
} from './foundry-agent-client';

export type AgentTier = 'foundry-agent-service' | 'maf';

export interface AgentTierDecision {
  tier: AgentTier;
  reason: string;
}

/** True when a Foundry project endpoint is configured (env or explicit override). */
function foundryConfigured(override?: FoundryAgentConfigOverride): boolean {
  return !!(override?.projectEndpoint || process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT);
}

/** True when the MAF Gov tier is deployed + reachable (LOOM_MAF_ENDPOINT wired). */
function mafDeployed(): boolean {
  return !!(process.env.LOOM_MAF_ENDPOINT || '').trim();
}

/**
 * Decide which runtime tier serves an agent run. Pure (env + cloud only) so it
 * is unit-testable without any Azure calls.
 *
 * Rule: prefer Foundry whenever its endpoint is configured. Fall to the MAF
 * tier ONLY in a Gov boundary where Foundry is unconfigured AND the MAF app is
 * deployed. Everywhere else stay on Foundry (its own honest gate handles the
 * unconfigured-Commercial case unchanged).
 */
export function selectAgentTier(override?: FoundryAgentConfigOverride): AgentTierDecision {
  if (foundryConfigured(override)) {
    return { tier: 'foundry-agent-service', reason: 'Foundry project endpoint configured' };
  }
  if (isGovCloud() && mafDeployed()) {
    return {
      tier: 'maf',
      reason: 'Gov boundary with no Foundry Agent Service host — using the MAF OSS runtime tier (Gov AOAI direct)',
    };
  }
  return {
    tier: 'foundry-agent-service',
    reason: 'no MAF tier deployed — defer to the Foundry Agent Service honest gate',
  };
}

export interface RunAgentInspectTieredOptions {
  /** Agent name/id (Foundry) or a display name (MAF — used only for tracing). */
  agentName: string;
  question: string;
  /** Trusted signed-in user oid — forwarded to the MAF app for tool-dispatch OBO. */
  userOid: string;
  /**
   * The agent's system instructions. REQUIRED for the MAF tier (there is no
   * Foundry project to look them up from); ignored by the Foundry tier, which
   * loads the agent by name from the project.
   */
  instructions?: string;
  /** AOAI deployment for the MAF tier (falls back to LOOM_AOAI_DEPLOYMENT). */
  model?: string;
  /** When false, the MAF tier runs the agent WITHOUT tools (pure prompt agent). */
  enableTools?: boolean;
  override?: FoundryAgentConfigOverride;
  maxPollMs?: number;
}

/**
 * Thrown when the MAF tier is selected but the caller supplied no agent
 * instructions — the MAF app has no Foundry project to load the agent
 * definition from, so the definition must be passed through. Surfaced as an
 * honest 400 by the route (never a silent empty run).
 */
export class MafAgentDefinitionRequiredError extends Error {
  constructor() {
    super(
      'The MAF Gov runtime tier needs the agent definition (instructions + model) ' +
        'passed with the run, because there is no Foundry Agent Service project to load it from. ' +
        'Author the agent in the Loom Agents editor and re-run — the editor sends its ' +
        'instructions/model with the run.',
    );
    this.name = 'MafAgentDefinitionRequiredError';
  }
}

/** Invoke the MAF app's /agent-run endpoint and return its AgentRunInspection. */
async function runViaMaf(opts: RunAgentInspectTieredOptions): Promise<AgentRunInspection> {
  const endpoint = (process.env.LOOM_MAF_ENDPOINT || '').replace(/\/$/, '');
  const instructions = (opts.instructions || '').trim();
  if (!instructions) throw new MafAgentDefinitionRequiredError();

  const res = await fetchWithTimeout(
    `${endpoint}/agent-run`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // VNet-internal trust — the MAF app forwards this oid for tool-dispatch OBO.
        'x-user-oid': opts.userOid,
      },
      body: JSON.stringify({
        instructions,
        model: opts.model,
        question: opts.question,
        enableTools: opts.enableTools !== false,
      }),
    },
    LLM_FETCH_TIMEOUT_MS,
  );
  const text = await res.text();
  let parsed: any = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!res.ok || parsed?.ok === false) {
    const msg = parsed?.error || (typeof parsed === 'string' ? parsed : `MAF agent-run failed (${res.status})`);
    throw new Error(`MAF tier unreachable/failed at ${endpoint}: ${String(msg).slice(0, 300)}`);
  }
  return parsed.data as AgentRunInspection;
}

/**
 * Run a question through an agent on whichever tier is active, returning the
 * unified `AgentRunInspection` shape. The tier is chosen by {@link selectAgentTier}.
 */
export async function runAgentInspectTiered(
  opts: RunAgentInspectTieredOptions,
): Promise<{ tier: AgentTier; inspection: AgentRunInspection }> {
  const decision = selectAgentTier(opts.override);
  if (decision.tier === 'maf') {
    const inspection = await runViaMaf(opts);
    return { tier: 'maf', inspection };
  }
  // Foundry Agent Service (default). Its own FoundryAgentNotConfiguredError
  // still bubbles up so the route renders the existing honest gate unchanged.
  const inspection = await runAgentAndInspect(opts.agentName, opts.question, {
    override: opts.override,
    maxPollMs: opts.maxPollMs,
  });
  return { tier: 'foundry-agent-service', inspection };
}

export { FoundryAgentNotConfiguredError };
