/**
 * a2a-platform-execute — the REAL executor behind the platform A2A endpoint (WS-5.2).
 *
 * Given the delegating caller's session + a requested skill, this runs the task
 * against the SAME governed Azure-native backends the in-product surfaces use:
 *
 *   - query-data-agent      → owner-scoped data agent + chatGrounded (real AOAI)
 *   - run-agent-flow        → owner-scoped agent flow + runAgentFlowTurn
 *   - query-ontology-object → declared-type + object-level security + weave listObjects
 *   - run-ontology-action   → declared-action + action security + weave runActionType
 *
 * Every path enforces owner-scoping (loadOwnedItem by the caller's oid), the
 * WS-4.3 object/action security marking, and honest gates (weaveGate / no-AOAI) —
 * so an external agent that delegates in receives exactly the result the caller
 * is cleared to get, never more. No mocks; real backends (no-vaporware.md).
 * Azure-native; no Fabric.
 *
 * Returns an {@link A2aExecuteResult}; an honest gate / permission failure is a
 * `failed` result (not a throw) so the A2A Task carries the reason in its status.
 */

import type { SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import {
  chatGrounded, NoAoaiDeploymentError, type DataAgentConfig, type ChatTurn,
} from '@/lib/azure/data-agent-client';
import { enrichSemanticModelSources } from '@/app/api/items/semantic-model/_lib/prep-for-ai-store';
import { runAgentFlowTurn } from '@/lib/azure/agent-flow-execute';
import type { AgentFlowState } from '@/lib/azure/agent-flow-run';
import {
  objectTypeNames, objectTypeByName, normalizeOntoActionTypes,
  validateActionRun, evaluateSubmissionCriteria,
} from '@/lib/editors/ontology-model';
import {
  normalizeObjectSecurity, objectTypeSecurity, secureInstances,
  isActionAllowed, actionSecurity,
} from '@/lib/foundry/object-security';
import { weaveGate, listObjects, runActionType, type WeaveActionType } from '@/lib/azure/weave-ontology-store';
import { A2A_SKILL, inferSkillId, isPlatformSkill } from './a2a-tasks';
import type { A2aExecuteResult, A2aPart } from './a2a-protocol';

function text(t: string, state: 'completed' | 'failed' = 'completed'): A2aExecuteResult {
  return { parts: [{ kind: 'text', text: t }], state, ...(state === 'failed' ? { statusText: t } : {}) };
}
function fail(t: string): A2aExecuteResult {
  return { parts: [{ kind: 'text', text: t }], state: 'failed', statusText: t };
}
function dataResult(summary: string, data: Record<string, unknown>): A2aExecuteResult {
  const parts: A2aPart[] = [{ kind: 'text', text: summary }, { kind: 'data', data }];
  return { parts, state: 'completed' };
}

/** Build a grounded data-agent config from persisted state (mirrors the chat route). */
function stateToConfig(state: Record<string, unknown>): DataAgentConfig {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  return {
    instructions: String(state.instructions || state.systemPrompt || ''),
    description: state.description ? String(state.description) : undefined,
    sources: sources.map((s) => ({
      id: String(s.id || s.name || ''),
      type: s.type,
      name: String(s.name || ''),
      tables: s.tables ? String(s.tables) : undefined,
      description: s.description ? String(s.description) : undefined,
      instructions: s.instructions ? String(s.instructions) : undefined,
      examples: Array.isArray(s.examples) ? s.examples : undefined,
      aiSearch: s.aiSearch && typeof s.aiSearch === 'object' ? s.aiSearch : undefined,
      graph: s.graph && typeof s.graph === 'object' ? s.graph : undefined,
    })),
  };
}

export interface PlatformExecInput {
  skillId?: string;
  text: string;
  data: Record<string, unknown>;
}

/**
 * Execute a delegated platform task for `session`. Resolves the skill (explicit
 * id, else inferred from the data), runs the governed backend, and returns a
 * terminal result. Never returns another tenant's / another owner's data.
 */
export async function executePlatformSkill(
  session: SessionPayload,
  input: PlatformExecInput,
): Promise<A2aExecuteResult> {
  const oid = session.claims.oid;
  const skillId = (isPlatformSkill(input.skillId) && input.skillId) || inferSkillId(input.data);
  if (!skillId) {
    return fail(
      'No A2A skill was named and none could be inferred. Send a data part naming one of: ' +
      'agentId (query-data-agent), flowId (run-agent-flow), objectType (query-ontology-object), ' +
      'or action (run-ontology-action).',
    );
  }

  switch (skillId) {
    case A2A_SKILL.QUERY_DATA_AGENT: {
      const agentId = String(input.data.agentId || '');
      if (!agentId) return fail('query-data-agent requires a data part { "agentId": "<data-agent id>" }.');
      if (!input.text) return fail('query-data-agent requires a text part with the question.');
      const item = await loadOwnedItem(agentId, 'data-agent', oid);
      if (!item) return fail(`Data agent "${agentId}" not found or not accessible to the delegating caller.`);
      const cfg = stateToConfig((item.state || {}) as Record<string, unknown>);
      try {
        cfg.sources = await enrichSemanticModelSources(cfg.sources, oid);
        const answer = await chatGrounded(cfg, [] as ChatTurn[], input.text, { tenantId: oid });
        return text(answer.answer || '(the agent returned no answer)');
      } catch (e: any) {
        if (e instanceof NoAoaiDeploymentError) {
          return fail(`${e.message} — deploy a model from the AI Foundry hub, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.`);
        }
        return fail(`data-agent query failed: ${e?.message || String(e)}`);
      }
    }

    case A2A_SKILL.RUN_AGENT_FLOW: {
      const flowId = String(input.data.flowId || '');
      if (!flowId) return fail('run-agent-flow requires a data part { "flowId": "<agent-flow id>" }.');
      if (!input.text) return fail('run-agent-flow requires a text part with the request.');
      const item = await loadOwnedItem(flowId, 'agent-flow', oid);
      if (!item) return fail(`Agent flow "${flowId}" not found or not accessible to the delegating caller.`);
      try {
        const turn = await runAgentFlowTurn((item.state || {}) as AgentFlowState, oid, input.text, []);
        return text(turn.answer || '(the flow returned no answer)');
      } catch (e: any) {
        if (e instanceof NoAoaiDeploymentError) {
          return fail(`${e.message} — deploy a model, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.`);
        }
        return fail(`agent-flow run failed: ${e?.message || String(e)}`);
      }
    }

    case A2A_SKILL.QUERY_ONTOLOGY_OBJECT: {
      const ontologyId = String(input.data.ontologyId || '');
      const objectType = String(input.data.objectType || '');
      const top = Math.min(500, Math.max(1, Number(input.data.top) || 50));
      if (!ontologyId || !objectType) {
        return fail('query-ontology-object requires a data part { "ontologyId": "…", "objectType": "…" }.');
      }
      const onto = await loadOwnedItem(ontologyId, 'ontology', oid);
      if (!onto) return fail(`Ontology "${ontologyId}" not found or not accessible to the delegating caller.`);
      const state = (onto.state || {}) as Record<string, unknown>;
      if (!objectTypeNames(state).has(objectType)) {
        return fail(`"${objectType}" is not a declared object type on ontology "${ontologyId}".`);
      }
      const gate = weaveGate();
      if (gate) return fail(`Weave ontology graph store not configured (${gate.missing}). ${gate.remediation || ''}`.trim());
      try {
        const objects = await listObjects(objectType, top);
        // WS-4.3 object-level security: row-filter + property-mask by caller groups.
        const security = normalizeObjectSecurity(state.objectSecurity);
        const sec = objectTypeSecurity(security, objectType);
        const bypass = isTenantAdminTier(session);
        const secured = secureInstances(sec, session.claims.groups || [], objects, bypass);
        return dataResult(
          `Returned ${secured.objects.length} ${objectType} instance(s)${secured.restricted ? ` (${secured.filteredCount} filtered by object security)` : ''}.`,
          { objectType, objects: secured.objects, restricted: secured.restricted },
        );
      } catch (e: any) {
        return fail(`ontology object query failed: ${e?.message || String(e)}`);
      }
    }

    case A2A_SKILL.RUN_ONTOLOGY_ACTION: {
      const ontologyId = String(input.data.ontologyId || '');
      const actionName = String(input.data.action || '');
      if (!ontologyId || !actionName) {
        return fail('run-ontology-action requires a data part { "ontologyId": "…", "action": "…", "params": {…} }.');
      }
      const rawParams = (input.data.params && typeof input.data.params === 'object' ? input.data.params : {}) as Record<string, unknown>;
      const onto = await loadOwnedItem(ontologyId, 'ontology', oid);
      if (!onto) return fail(`Ontology "${ontologyId}" not found or not accessible to the delegating caller.`);
      const state = (onto.state || {}) as Record<string, unknown>;
      const action = normalizeOntoActionTypes(state.actionTypes).find((a) => a.name === actionName);
      if (!action) return fail(`Action "${actionName}" is not declared on ontology "${ontologyId}".`);
      if (!objectTypeNames(state).has(action.objectType)) {
        return fail(`Action "${actionName}" targets object type "${action.objectType}" which is no longer declared.`);
      }
      // WS-4.3 action-level security.
      const security = normalizeObjectSecurity(state.objectSecurity);
      const bypass = isTenantAdminTier(session);
      if (!isActionAllowed(security, actionName, session.claims.groups || [], bypass)) {
        const allow = actionSecurity(security, actionName)?.allowGroups.map((g) => g.name || g.id) || [];
        return fail(`Action "${actionName}" is restricted — the delegating caller is not cleared to run it${allow.length ? ` (allowed: ${allow.join(', ')})` : ''}.`);
      }
      // Validate + coerce typed params, then submission criteria (parity rows).
      const validated = validateActionRun(action, rawParams);
      if (!validated.ok) return fail(validated.error);
      const criteria = evaluateSubmissionCriteria(action, validated.values);
      if (!criteria.ok) return fail(criteria.error);
      const gate = weaveGate();
      if (gate) return fail(`Weave ontology graph store not configured (${gate.missing}). ${gate.remediation || ''}`.trim());
      const runParams: Record<string, unknown> = { ...validated.values };
      const rawId = (rawParams as { id?: unknown }).id;
      if (rawId !== undefined && rawId !== null && rawId !== '') runParams.id = String(rawId);
      try {
        const weaveAction: WeaveActionType = { name: action.name, objectType: action.objectType, kind: action.kind };
        const result = await runActionType(weaveAction, runParams);
        return dataResult(`Action "${actionName}" (${action.kind}) executed against object type "${action.objectType}".`, { ...result });
      } catch (e: any) {
        return fail(`Action "${actionName}" failed: ${e?.message || String(e)}`);
      }
    }

    default:
      return fail(`Unknown A2A skill "${skillId}".`);
  }
}
