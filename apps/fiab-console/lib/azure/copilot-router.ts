/**
 * Copilot router — ONE chat window, intent-based agent routing + attribution.
 *
 * CSA Loom historically surfaced two Copilot popups from a single launcher:
 *   - the right-rail "Copilot" (cross-item ACT orchestrator, copilot-orchestrator.ts)
 *   - the floating "Loom Copilot" (docs/repo RAG, help-copilot-orchestrator.ts)
 * Both listened to the same `csaloom:open-copilot` event, so the topbar Sparkle
 * opened both at once. This module unifies them behind ONE window: it classifies
 * the user's intent with a real Azure OpenAI `tool_choice` call, emits a single
 * `agent` attribution step (which agent answered + why), then delegates to the
 * matching real orchestrator and re-yields its SSE step stream verbatim.
 *
 * Routing targets (both Azure-native, no Fabric dependency):
 *   - docs  → orchestrateHelp()  (searchDocs / searchRepo RAG, citations, openLoomPage)
 *   - build → orchestrate()      (the full cross-item tool registry: Synapse / ADLS /
 *                                  Databricks / ADX / ADF / Power BI / Activator / …)
 *
 * The classifier reuses the SAME AOAI deployment resolveAoaiTarget() resolves
 * (or the tenant admin's optional `routerDeployment` — picked from the real
 * ARM-listed deployments in /admin/tenant-settings → Copilot & Agents — when
 * the operator wires a cheaper model just for routing; no new env var, no
 * bicep change). Routing + attribution are derived from real model output and
 * the orchestrators' resolved personas, never faked.
 *
 * When the window is opened from an editor pane (a non-default contextSlug) or
 * with an explicit CopilotPersonaDef (e.g. 'activator'), the user has already
 * chosen a build persona — classification is skipped and the request goes
 * straight to the build orchestrator, still emitting an `agent` step so the
 * badge always shows who answered.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from './fetch-with-timeout';
import { cogScope } from './cloud-endpoints';
import {
  orchestrate,
  resolveAoaiTarget,
  type OrchestrateOptions,
  type OrchestratorStep,
} from './copilot-orchestrator';
import {
  orchestrateHelp,
  type HelpStep,
  type HelpOrchestrateOptions,
} from './help-copilot-orchestrator';
import { getPanePersona, resolvePersona } from './copilot-personas';
import type { TenantCopilotConfig } from '../types/copilot-config';

// ---------- Types ----------

/** Which agent answered + the one-line reason, surfaced as an inline badge. */
export interface AgentStep {
  kind: 'agent';
  /** Stable id, e.g. 'help', 'persona:activator', 'pane:warehouse'. */
  agentId: string;
  /** Human label for the badge, e.g. 'Help & docs', 'Warehouse Copilot'. */
  agentName: string;
  /** Why this agent was chosen (model-supplied or derived). */
  reason: string;
}

/** The unified SSE step union the single Copilot window consumes. */
export type RoutedStep = AgentStep | OrchestratorStep | HelpStep;

export type RouteAgent = 'docs' | 'build';

export interface RouteDecision {
  agent: RouteAgent;
  reason: string;
}

export interface RouteCopilotOptions extends OrchestrateOptions {
  /** When true (the global launcher with the default pane + no explicit
   *  persona), classify intent. When false, go straight to the build agent.
   *  Defaults to {@link decideAutoRoute}(opts). */
  autoRoute?: boolean;
  /** Short-circuit classification (e.g. tutorial-step help is always docs). */
  forceAgent?: RouteAgent;
  /** Route/tutorial awareness forwarded to the docs agent. */
  helpContext?: HelpOrchestrateOptions['pageContext'];
}

// ---------- Pure helpers (unit-tested) ----------

/**
 * Auto-route only the GLOBAL launcher: the default pane, no explicit
 * CopilotPersonaDef, and no editor-supplied persona context. Any of those
 * signals means the user already picked a build persona, so the request goes
 * straight to the build orchestrator (no classification round-trip).
 */
export function decideAutoRoute(opts: {
  persona?: string | null;
  contextSlug?: string;
  personaContext?: Record<string, unknown> | null;
}): boolean {
  const persona = (opts.persona || 'cross-item').trim();
  const slug = (opts.contextSlug || 'default').trim();
  const hasPersonaCtx = !!opts.personaContext && Object.keys(opts.personaContext).length > 0;
  return slug === 'default' && (persona === 'cross-item' || persona === '') && !hasPersonaCtx;
}

/** Parse the classifier's tool-call arguments into a safe RouteDecision. */
export function parseRouteDecision(rawArgs: string | undefined | null): RouteDecision {
  try {
    const j = JSON.parse(rawArgs || '{}') as { agent?: unknown; reason?: unknown };
    const agent: RouteAgent = j.agent === 'docs' ? 'docs' : 'build';
    const reason =
      typeof j.reason === 'string' && j.reason.trim()
        ? j.reason.trim().slice(0, 160)
        : agent === 'docs'
          ? 'Documentation / how-to question — answered from the docs + repo.'
          : 'Build or data request — handled by the cross-item build agent.';
    return { agent, reason };
  } catch {
    return { agent: 'build', reason: 'Could not parse routing — defaulted to the build & data agent.' };
  }
}

/** Resolve the build agent's display name + id for the attribution badge. */
export function buildAgentIdentity(opts: { persona?: string | null; contextSlug?: string }): {
  agentId: string;
  agentName: string;
} {
  const def = resolvePersona(opts.persona);
  if (def) return { agentId: `persona:${def.id}`, agentName: def.name };
  const pane = getPanePersona(opts.contextSlug);
  const slug = (opts.contextSlug || 'default').trim();
  // The default pane title is the bare "Copilot" — give the global build agent
  // a clearer label so the badge reads as a distinct agent.
  const agentName = slug === 'default' || pane.title === 'Copilot' ? 'Build & data' : pane.title;
  return { agentId: `pane:${slug}`, agentName };
}

// ---------- AOAI classifier ----------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

const ROUTER_SYSTEM =
  'You are the CSA Loom Copilot router. Classify the user request and call the `route` ' +
  'function exactly once. Choose "docs" for documentation / how-to / "what is" / "where ' +
  'is X" / explain / navigate questions answered from docs + repo. Choose "build" for ' +
  'requests to ACT on data or Azure: create / run / query / configure items, write SQL / ' +
  'KQL / DAX / pipelines, provision resources, or admin / ops / diagnostics. When unsure, ' +
  'prefer "build". Keep the reason under 120 characters.';

const ROUTER_TOOL = {
  type: 'function',
  function: {
    name: 'route',
    description: 'Route the user request to the correct CSA Loom assistant.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['docs', 'build'],
          description: 'docs = explain / how-to / documentation; build = act on data or Azure.',
        },
        reason: { type: 'string', description: 'One short sentence (<=120 chars) why this agent.' },
      },
      required: ['agent', 'reason'],
      additionalProperties: false,
    },
  },
};

/**
 * Classify intent with a single forced-`tool_choice` AOAI call. Reuses the
 * resolved chat deployment unless the tenant admin selected a dedicated
 * (cheaper) `routerDeployment` in /admin/tenant-settings → Copilot & Agents.
 * Any failure degrades safely to the build agent — never an error, never a
 * blocked chat.
 */
export async function classifyIntent(
  prompt: string,
  tenantConfig: TenantCopilotConfig | null,
): Promise<RouteDecision> {
  try {
    const target = await resolveAoaiTarget(tenantConfig);
    const routerDeployment = tenantConfig?.routerDeployment?.trim();
    const deployment = routerDeployment || target.deployment;
    const token = await aoaiToken();
    const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${target.apiVersion}`;
    // No temperature — newer reasoning deployments reject non-default sampling,
    // and forced tool_choice already makes the call deterministic enough.
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: ROUTER_SYSTEM },
            { role: 'user', content: prompt.slice(0, 4000) },
          ],
          tools: [ROUTER_TOOL],
          tool_choice: { type: 'function', function: { name: 'route' } },
        }),
      },
      LLM_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      return { agent: 'build', reason: 'Router unavailable — defaulted to the build & data agent.' };
    }
    const j = await res.json();
    const call = j?.choices?.[0]?.message?.tool_calls?.[0];
    return parseRouteDecision(call?.function?.arguments);
  } catch {
    return { agent: 'build', reason: 'Router error — defaulted to the build & data agent.' };
  }
}

// ---------- Orchestration ----------

/**
 * Route + delegate. Emits exactly one {@link AgentStep} for attribution, then
 * the chosen orchestrator's full step stream. Both orchestrators persist their
 * own steps + run their own content-safety checks, so this layer adds no
 * duplicate persistence.
 */
export async function* routeCopilot(opts: RouteCopilotOptions): AsyncIterable<RoutedStep> {
  const auto = opts.autoRoute ?? decideAutoRoute(opts);

  let decision: RouteDecision;
  if (opts.forceAgent) {
    decision = {
      agent: opts.forceAgent,
      reason:
        opts.forceAgent === 'docs'
          ? 'Tutorial / help context — routed to the docs & help agent.'
          : 'Routed to the build & data agent.',
    };
  } else if (!auto) {
    const id = buildAgentIdentity(opts);
    decision = { agent: 'build', reason: `Opened from the ${id.agentName} surface.` };
  } else {
    decision = await classifyIntent(opts.prompt, opts.tenantConfig ?? null);
  }

  if (decision.agent === 'docs') {
    yield { kind: 'agent', agentId: 'help', agentName: 'Help & docs', reason: decision.reason };
    yield* orchestrateHelp({
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      userId: opts.userOid,
      tenantConfig: opts.tenantConfig ?? null,
      pageContext: opts.helpContext,
    });
    return;
  }

  const id = buildAgentIdentity(opts);
  yield { kind: 'agent', agentId: id.agentId, agentName: id.agentName, reason: decision.reason };
  yield* orchestrate(opts);
}
