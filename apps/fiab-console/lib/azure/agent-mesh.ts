/**
 * agent-mesh — WS-9 Sovereign Agent Mesh runner (BTB-4 / BTB-9).
 *
 * `runMeshTask` executes a GOVERNED multi-agent task: a LEAD agent (the mesh
 * orchestrator) delegates the task to its member agents (governance / pipeline /
 * BI …), then synthesizes a single final answer from their findings. The two
 * invariants that make this a SOVEREIGN mesh (not just fan-out):
 *
 *   1. EVERY inter-agent call is POLICY-CHECKED. Before the lead delegates to a
 *      member, `deps.authorize(lead, member, 'execute')` consults the PDP
 *      (lib/auth/pdp) — a `deny` blocks the hop (the member never runs) and is
 *      recorded. This is the `access-policy-client` / PDP check on every hop the
 *      spec requires.
 *   2. EVERY hop is AUDITED. `deps.audit(row)` writes one row per decision +
 *      per run to the real audit log, so an operator can prove which agent
 *      called which, under what policy verdict, and whether any tool egressed.
 *
 * Per-agent MCP tool scoping + egress fail-closed are enforced INSIDE
 * `deps.runAgent` (wired in agent-mesh-run.ts via scopeMcpServersForAgent +
 * classifyMeshEgress) so an agent can only reach the tools it is granted and, on
 * an air-gap profile, nothing leaves the VNet boundary.
 *
 * This module is PURE apart from the injected `deps` (no Azure SDK / Cosmos / AOAI
 * import) so the 3-agent completion, the unauthorized-hop block, and the
 * egress-fail-closed behaviors are all unit-tested with stub deps.
 */

import type { Action } from '@/lib/auth/pdp/resource-ref';
import type { MeshAgentDef, MeshEgressProfile } from '@/lib/copilot/agent-registry';

/** One tool invocation a member agent made during its turn (for the trace). */
export interface MeshToolCall {
  agentId: string;
  /** Tool kind (native) or `mcp:<serverId>` / `a2a:<host>`. */
  kind: string;
  detail?: string;
  executed: boolean;
  /** True when this call was refused by the egress guard (air-gap / gov). */
  egressBlocked?: boolean;
  egressReason?: string;
}

/** The verdict of one inter-agent policy check. */
export interface MeshPolicyCheck {
  from: string;
  to: string;
  action: Action;
  effect: 'allow' | 'deny';
  reason: string;
  source?: string;
  at: string;
}

/** One delegation step in the mesh run. */
export interface MeshStep {
  agentId: string;
  agentName: string;
  kind: string;
  status: 'delegated' | 'blocked' | 'gated';
  answer?: string;
  toolCalls: MeshToolCall[];
  /** The policy check that authorized (or blocked) this delegation. */
  policy: MeshPolicyCheck;
  /** Honest gate when the member could not run for a non-policy reason. */
  gate?: string;
}

/** One audit row the runner emits (mirrored to the audit-log container in prod). */
export interface MeshAuditRow {
  taskId: string;
  from: string;
  to: string;
  action: Action | 'run' | 'synthesize';
  effect: 'allow' | 'deny' | 'run';
  reason: string;
  at: string;
}

/** Injected backends — real in prod (agent-mesh-run.ts), stubbed in tests. */
export interface MeshDeps {
  /** Policy check on an inter-agent call (PDP authorize). */
  authorize: (
    caller: MeshAgentDef,
    callee: MeshAgentDef,
    action: Action,
  ) => Promise<{ effect: 'allow' | 'deny'; reason: string; source?: string }>;
  /** Run ONE agent's grounded turn over the task + prior findings. */
  runAgent: (
    agent: MeshAgentDef,
    task: string,
    grounding: string[],
  ) => Promise<{ answer: string; toolCalls: MeshToolCall[] }>;
  /** Append ONE audit row (real Cosmos write in prod). */
  audit: (row: MeshAuditRow) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export interface MeshRunResult {
  taskId: string;
  task: string;
  leadId: string;
  leadName: string;
  profile: MeshEgressProfile;
  finalAnswer: string;
  steps: MeshStep[];
  policyChecks: MeshPolicyCheck[];
  /** How many inter-agent hops were policy-DENIED. */
  policyDenied: number;
  /** How many tool calls were egress-blocked (air-gap / gov). */
  egressBlocked: number;
  /** True when the lead produced a final answer (the task completed). */
  completed: boolean;
}

const MAX_MEMBERS = 8;

function genTaskId(): string {
  return `mesh-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run a governed mesh task. `agents[0]` is the LEAD (orchestrator); the rest are
 * members it may delegate to. Returns the full trace: every policy check, every
 * step, every egress-blocked tool call, and the synthesized final answer.
 *
 * The lead delegates to each member ONLY after a passing `authorize` check; a
 * denied hop blocks the member (it never runs) and is recorded. All hops are
 * audited. When no member is authorized, the lead still runs the task alone so the
 * mesh always returns a governed answer (never a silent empty).
 */
export async function runMeshTask(
  agents: MeshAgentDef[],
  task: string,
  deps: MeshDeps,
): Promise<MeshRunResult> {
  const now = deps.now || (() => new Date().toISOString());
  const taskId = genTaskId();
  if (agents.length === 0) {
    throw new Error('runMeshTask requires at least one agent (the lead).');
  }
  const lead = agents[0];
  const members = agents.slice(1, 1 + MAX_MEMBERS);

  const steps: MeshStep[] = [];
  const policyChecks: MeshPolicyCheck[] = [];
  const findings: string[] = [];
  let policyDenied = 0;
  let egressBlocked = 0;

  for (const member of members) {
    // 1) POLICY CHECK on the inter-agent call (lead → member).
    let decision: { effect: 'allow' | 'deny'; reason: string; source?: string };
    try {
      decision = await deps.authorize(lead, member, 'execute');
    } catch (e: any) {
      // FAIL-CLOSED: an unavailable PDP denies the hop (never silently allows).
      decision = { effect: 'deny', reason: `policy check unavailable — failing closed: ${e?.message || String(e)}` };
    }
    const check: MeshPolicyCheck = {
      from: lead.id,
      to: member.id,
      action: 'execute',
      effect: decision.effect,
      reason: decision.reason,
      source: decision.source,
      at: now(),
    };
    policyChecks.push(check);
    await deps.audit({
      taskId,
      from: lead.id,
      to: member.id,
      action: 'execute',
      effect: decision.effect,
      reason: decision.reason,
      at: check.at,
    });

    if (decision.effect === 'deny') {
      policyDenied++;
      steps.push({
        agentId: member.id,
        agentName: member.name,
        kind: member.kind,
        status: 'blocked',
        toolCalls: [],
        policy: check,
        gate: `Delegation blocked by policy: ${decision.reason}`,
      });
      continue;
    }

    // 2) RUN the member (per-agent tool scoping + egress enforced inside runAgent).
    try {
      const { answer, toolCalls } = await deps.runAgent(member, task, findings);
      const blockedHere = toolCalls.filter((t) => t.egressBlocked).length;
      egressBlocked += blockedHere;
      findings.push(`### ${member.name} (${member.kind})\n${answer}`);
      steps.push({
        agentId: member.id,
        agentName: member.name,
        kind: member.kind,
        status: 'delegated',
        answer,
        toolCalls,
        policy: check,
      });
    } catch (e: any) {
      steps.push({
        agentId: member.id,
        agentName: member.name,
        kind: member.kind,
        status: 'gated',
        toolCalls: [],
        policy: check,
        gate: `Member run failed: ${e?.message || String(e)}`,
      });
    }
  }

  // 3) LEAD synthesizes a final governed answer from the members' findings.
  let finalAnswer = '';
  let leadToolCalls: MeshToolCall[] = [];
  try {
    const synth = await deps.runAgent(lead, task, findings);
    finalAnswer = synth.answer;
    leadToolCalls = synth.toolCalls;
    egressBlocked += leadToolCalls.filter((t) => t.egressBlocked).length;
  } catch (e: any) {
    finalAnswer = `The mesh could not synthesize a final answer: ${e?.message || String(e)}`;
  }
  await deps.audit({
    taskId,
    from: lead.id,
    to: lead.id,
    action: 'synthesize',
    effect: 'run',
    reason: `lead synthesized final answer from ${findings.length} finding(s)`,
    at: now(),
  });

  // The lead's own step (records its synthesis + any tool calls it made).
  steps.push({
    agentId: lead.id,
    agentName: lead.name,
    kind: lead.kind,
    status: 'delegated',
    answer: finalAnswer,
    toolCalls: leadToolCalls,
    policy: {
      from: lead.id,
      to: lead.id,
      action: 'execute',
      effect: 'allow',
      reason: 'lead self-run (synthesis)',
      at: now(),
    },
  });

  return {
    taskId,
    task,
    leadId: lead.id,
    leadName: lead.name,
    profile: lead.egressProfile,
    finalAnswer,
    steps,
    policyChecks,
    policyDenied,
    egressBlocked,
    completed: !!finalAnswer.trim(),
  };
}
