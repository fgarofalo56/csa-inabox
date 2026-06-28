/**
 * Fabric/Foundry Data Agent runtime client for Loom.
 *
 * A data agent grounds a natural-language question against up to five typed
 * sources (Warehouse / Lakehouse / KQL / Semantic model / AI Search). The real
 * Fabric runtime is the Azure OpenAI Assistants API + per-source query engines.
 * Loom's test-chat path uses the SAME AOAI deployment the cross-item Copilot
 * resolves (resolveAoaiTarget) so it is genuinely live whenever an AOAI model
 * is deployed on the Foundry hub — no fake echoes.
 *
 * The agent instructions + per-source grounding + few-shot example pairs are
 * composed into the system prompt. The model is asked to (a) answer in natural
 * language and (b) emit the query it would run (SQL/KQL/DAX) per the attached
 * source. We surface both back to the editor's chat pane.
 */
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { resolveAoaiTarget, NoAoaiDeploymentError } from './copilot-orchestrator';
import { buildAoaiBody, type AoaiChatMessage } from './aoai-model-contract';
import { cogScope } from './cloud-endpoints';
import { executeSourceQuery, executionToText, type SourceExecution } from './data-agent-execute';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export { NoAoaiDeploymentError };

export type DataAgentSourceType =
  | 'warehouse'
  | 'lakehouse'
  | 'kql'
  | 'semantic-model'
  | 'ai-search'
  | 'ontology'
  | 'graph';

export interface DataAgentSource {
  id: string;
  type: DataAgentSourceType;
  name: string;          // resolved item / resource name
  tables?: string;       // comma-separated selected tables / views / functions / model name (schema selection)
  description?: string;  // routing description — helps the agent decide if this source answers a question
  instructions?: string; // per-source grounding (## General knowledge / ## Table descriptions / ## When asked about)
  examples?: { question: string; query: string }[]; // few-shot pairs (lakehouse/warehouse/kql/graph/ai-search only)
}

export interface DataAgentConfig {
  instructions: string;            // agent-level (≤15k chars)
  sources: DataAgentSource[];
  description?: string;
}

const QUERY_LANG: Record<DataAgentSourceType, string> = {
  warehouse: 'T-SQL',
  lakehouse: 'Spark SQL',
  kql: 'KQL',
  'semantic-model': 'DAX',
  'ai-search': 'an Azure AI Search query',
  ontology: 'an ontology / Fabric IQ semantic query',
  graph: 'a GQL / Cypher graph traversal',
};

function composeSystemPrompt(cfg: DataAgentConfig): string {
  const lines: string[] = [];
  lines.push('You are a CSA Loom data agent (CSA Loom is its own Azure-based data + AI platform, not Microsoft Fabric). Answer the user\'s question in natural language, grounded ONLY in the attached data sources below.');
  lines.push('CRITICAL — ACT, DO NOT ASK: When a question can be answered from a source, ALWAYS write the exact query and include it in the tools JSON below. The platform RUNS your query automatically and feeds you the real rows to answer from. NEVER ask "would you like me to run it?", NEVER say "I will query…" without including the query, and NEVER describe hypothetical / "typical" results or tell the user to imagine them. If you do not yet know a schema, emit a real discovery query (list tables/columns) rather than guessing. Every numeric or factual claim MUST come from rows the platform actually returned.');
  lines.push('After your natural-language answer, append EXACTLY ONE fenced ```json code block describing the tools you used, in this shape:');
  lines.push('```json');
  lines.push('{"toolsUsed":[{"source":"<source name>","type":"<source type>","action":"query|search|traverse|retrieve","query":"<the exact query/KQL/DAX/search text you would run>"}]}');
  lines.push('```');
  lines.push('List EVERY source you consulted (one entry each) — include multiple when the question spans sources. Put the tools JSON LAST; keep the prose answer above it with no code fences.');
  lines.push('');
  if (cfg.instructions?.trim()) {
    lines.push('## Agent instructions');
    lines.push(cfg.instructions.trim());
    lines.push('');
  }
  lines.push('## Attached data sources');
  if (!cfg.sources.length) {
    lines.push('(none attached yet — explain that no sources are configured and ask the author to attach at least one.)');
  }
  for (const src of cfg.sources) {
    lines.push(`### ${src.name} — ${src.type} (queries expressed as ${QUERY_LANG[src.type] ?? 'the source-native query language'})`);
    if (src.description?.trim()) lines.push(`When to use this source: ${src.description.trim()}`);
    if (src.tables?.trim()) lines.push(`Selected tables / model: ${src.tables.trim()}`);
    if (src.instructions?.trim()) {
      lines.push('Grounding instructions:');
      lines.push(src.instructions.trim());
    }
    if (src.examples?.length) {
      lines.push('Example question → query pairs:');
      for (const ex of src.examples) {
        if (ex.question && ex.query) lines.push(`- Q: ${ex.question}\n  Query: ${ex.query}`);
      }
    }
    lines.push('');
  }
  lines.push('Route financial / aggregated metrics to a semantic model when present; raw exploration to lakehouse / warehouse; log / telemetry analysis to KQL; document retrieval to AI Search.');
  return lines.join('\n');
}

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token for data agent');
  return t.token;
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface DataAgentUsage { promptTokens: number; completionTokens: number; totalTokens: number; }

/** One tool/source the agent consulted for an answer (sourcing metadata). */
export interface DataAgentTool {
  source: string;
  type?: string;
  action: string;   // query | search | traverse | retrieve
  query?: string;
  /** Real-execution metadata (task-008): the query was run read-only on the
   * Azure-native backend and these are the actual results (or an honest gate). */
  executed?: boolean;
  rowCount?: number;
  columns?: string[];
  rows?: unknown[][];
  /** Honest gate when the query was shown but not executed (unreachable source). */
  gate?: string;
}

export interface DataAgentAnswer {
  answer: string;
  query?: string;       // first tool's query (back-compat)
  sourceUsed?: string;  // first tool's source (back-compat)
  raw: string;
  /** Every source the agent consulted + its query (multi-source citations). */
  tools?: DataAgentTool[];
  /** Token/context usage for this turn (from the AOAI response). */
  usage?: DataAgentUsage;
  /** The model deployment that answered. */
  model?: string;
  /** Names of the sources attached to the agent (grounding context surfaced). */
  sourcesAvailable?: string[];
}

/**
 * Parse the model output into prose + structured tools-used. Prefers the
 * trailing ```json {"toolsUsed":[…]} block (multi-source citations); falls back
 * to the legacy single-fenced-block + name-match heuristic so older prompts and
 * non-compliant responses still surface something.
 */
function parseAnswer(content: string, sources: DataAgentSource[]): DataAgentAnswer {
  let tools: DataAgentTool[] | undefined;
  let answer = content;

  // 1) Structured toolsUsed JSON block (last fenced json wins).
  const jsonBlocks = [...content.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  const lastJson = jsonBlocks[jsonBlocks.length - 1];
  if (lastJson) {
    try {
      const obj = JSON.parse(lastJson[1].trim());
      const arr = Array.isArray(obj?.toolsUsed) ? obj.toolsUsed : Array.isArray(obj) ? obj : null;
      if (arr) {
        tools = arr
          .map((t: any) => ({
            source: String(t?.source ?? t?.name ?? '').trim(),
            type: t?.type ? String(t.type) : undefined,
            action: String(t?.action ?? 'query'),
            query: t?.query ? String(t.query) : undefined,
          }))
          .filter((t: DataAgentTool) => t.source || t.query);
        // Strip the tools JSON block from the prose answer.
        answer = content.replace(lastJson[0], '').trim();
      }
    } catch { /* not valid JSON — fall through to heuristic */ }
  }

  // 2) Fallback: legacy single fenced query block + name match.
  if (!tools || tools.length === 0) {
    const fence = content.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
    const query = fence ? fence[1].trim() : undefined;
    answer = content.replace(/```[a-zA-Z]*\n[\s\S]*?```/g, '').trim();
    let sourceUsed: string | undefined;
    let srcType: string | undefined;
    for (const s of sources) {
      if (s.name && content.toLowerCase().includes(s.name.toLowerCase())) { sourceUsed = s.name; srcType = s.type; break; }
    }
    if (query || sourceUsed) tools = [{ source: sourceUsed || 'source', type: srcType, action: 'query', query }];
  }

  const first = tools?.[0];
  return {
    answer: answer || content,
    query: first?.query,
    sourceUsed: first?.source,
    tools,
    raw: content,
  };
}

/**
 * Run one grounded turn against the live AOAI deployment.
 * Throws NoAoaiDeploymentError when no model is deployed (editor surfaces a
 * MessageBar with the Foundry-hub "deploy gpt-4o-mini" remediation).
 */
export async function chatGrounded(cfg: DataAgentConfig, history: ChatTurn[], question: string): Promise<DataAgentAnswer> {
  const target = await resolveAoaiTarget();
  const token = await aoaiToken();
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;

  // One AOAI round-trip with the reasoning-model temperature fallback.
  const runChat = async (messages: Array<{ role: string; content: string }>): Promise<{ content: string; usage: any }> => {
    const send = async (withTemp: boolean) => fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildAoaiBody({ messages: messages as AoaiChatMessage[], maxCompletionTokens: 1200, temperature: withTemp ? 0.2 : undefined })),
    }, LLM_FETCH_TIMEOUT_MS);
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (/unsupported_value|does not support|Only the default \(1\) value is supported/i.test(t) && /temperature|top_p/i.test(t)) {
        res = await send(false);
      } else {
        throw new Error(`Data agent chat failed (400): ${t.slice(0, 400)}`);
      }
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Data agent chat failed (${res.status}): ${t.slice(0, 400)}`);
    }
    const j: any = await res.json();
    return { content: j?.choices?.[0]?.message?.content || '', usage: j?.usage || {} };
  };

  // ── Phase 1: model proposes an answer + the per-source query it would run ──
  const phase1Messages = [
    { role: 'system', content: composeSystemPrompt(cfg) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];
  const first = await runChat(phase1Messages);
  const parsed = parseAnswer(first.content, cfg.sources);

  // ── Phase 2: actually RUN each generated query read-only on the real backend ──
  let usage = first.usage;
  let finalAnswer = parsed.answer;
  if (parsed.tools && parsed.tools.length > 0) {
    const groundingBlocks: string[] = [];
    for (const tool of parsed.tools) {
      if (!tool.query) continue;
      // Resolve the typed source for this tool (by name, else synthesise from the tool).
      const src = cfg.sources.find((s) => s.name && tool.source && s.name.toLowerCase() === tool.source.toLowerCase())
        || (tool.type ? { id: tool.source, type: tool.type as DataAgentSource['type'], name: tool.source } : undefined);
      if (!src) { tool.executed = false; tool.gate = 'Source not found on this agent.'; continue; }
      const exec: SourceExecution = await executeSourceQuery(src, tool.query);
      tool.executed = exec.executed;
      tool.rowCount = exec.rowCount;
      tool.columns = exec.columns;
      tool.rows = exec.rows;
      tool.gate = exec.gate;
      groundingBlocks.push(executionToText(tool.source || src.name, exec));
    }

    // If at least one query actually returned rows, re-prompt the model to give a
    // final answer grounded ONLY in those real rows (no fabricated numbers).
    const anyExecuted = parsed.tools.some((t) => t.executed && (t.rowCount ?? 0) >= 0);
    if (anyExecuted && groundingBlocks.length > 0) {
      const phase2 = [
        { role: 'system', content: composeSystemPrompt(cfg) },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: question },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content:
            'Here are the ACTUAL results of running those queries against the live data:\n\n' +
            groundingBlocks.join('\n\n') +
            '\n\nUsing ONLY these real results, give the final answer to my question. ' +
            'Cite concrete numbers from the rows. If a source was NOT executed, say so honestly and do not invent its data. ' +
            'Return prose only — do NOT include the tools JSON block this time.',
        },
      ];
      try {
        const second = await runChat(phase2);
        finalAnswer = parseAnswer(second.content, cfg.sources).answer || second.content;
        usage = second.usage; // last turn's usage
      } catch {
        /* keep phase-1 answer if the re-ground call fails */
      }
    }
  }

  const u = usage || {};
  return {
    ...parsed,
    answer: finalAnswer,
    usage: (u.total_tokens != null)
      ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 }
      : undefined,
    model: target.deployment,
    sourcesAvailable: cfg.sources.map((s) => s.name).filter(Boolean),
  };
}

/** Map typed sources to Foundry Agent Service tool entries (for publish). */
export function sourcesToFoundryTools(sources: DataAgentSource[]): Array<Record<string, unknown>> {
  return sources.map((s) => ({
    type: s.type,
    name: s.name,
    tables: s.tables || undefined,
    description: s.description || undefined,
    instructions: s.instructions || undefined,
    examples: s.examples && s.examples.length ? s.examples : undefined,
  }));
}
