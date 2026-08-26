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
import { resolveAoaiTarget, NoAoaiDeploymentError, type AoaiTarget } from './copilot-orchestrator';
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
  | 'metric-view'
  | 'ai-search'
  | 'ontology'
  | 'graph'
  | 'microsoft-graph'
  | 'agent';

/** Typed AI Search retrieval options persisted on an `ai-search` source. */
export interface DataAgentAiSearchConfig {
  /** keyword (simple) | semantic (needs a semantic config) | vector (integrated vectorization) | hybrid. */
  queryKind?: 'keyword' | 'semantic' | 'vector' | 'hybrid';
  /** Top-N documents per retrieval (1–50). */
  top?: number;
  /** Number grounding rows [1]…[n] and instruct the model to cite them. */
  citations?: boolean;
}

/** Typed Microsoft Graph grounding scope persisted on a `microsoft-graph` source. */
export interface DataAgentGraphScope {
  kind: 'site' | 'drive' | 'mail';
  site?: string;     // SharePoint site id or https URL
  driveId?: string;  // Graph drive id
  mailbox?: string;  // mailbox UPN
}

/** Compose-back config persisted on an `agent` source (DBX-2). */
export interface DataAgentAgentConfig {
  /** Cosmos item id of the backing loom-app-runtime item. */
  appItemId?: string;
  /** Live app URL — its `/invoke` endpoint is called to answer routed questions. */
  url?: string;
}

// Container-Apps host suffixes an agent `/invoke` URL is allowed to target. A
// hosted Loom App always lives on the Azure Container Apps managed domain
// (Commercial `.azurecontainerapps.io`, Gov `.azurecontainerapps.us`), so this
// is a tight SSRF allowlist: the grounding executor will only POST to a URL
// whose parsed hostname ends with one of these — never an arbitrary host.
const AGENT_INVOKE_HOST_SUFFIXES = ['.azurecontainerapps.io', '.azurecontainerapps.us'];

/**
 * Resolve + validate a hosted-agent `/invoke` URL from a stored app URL. Returns
 * the fully-qualified invoke URL when the input is an https URL on an Azure
 * Container Apps managed host, else null (SSRF guard — parses the hostname, does
 * NOT substring-match). Pure + unit-tested.
 */
export function resolveAgentInvokeUrl(rawUrl?: string | null): string | null {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!AGENT_INVOKE_HOST_SUFFIXES.some((suf) => host.endsWith(suf))) return null;
  // Normalise to origin + /invoke (ignore any path/query the stored URL carried).
  return `https://${u.host}/invoke`;
}

export interface DataAgentSource {
  id: string;
  type: DataAgentSourceType;
  name: string;          // resolved item / resource name
  tables?: string;       // comma-separated selected tables / views / functions / model name (schema selection)
  description?: string;  // routing description — helps the agent decide if this source answers a question
  instructions?: string; // per-source grounding (## General knowledge / ## Table descriptions / ## When asked about)
  examples?: { question: string; query: string }[]; // few-shot pairs for every source type; a semantic-model source's pairs are its curated Verified Answers (NL→DAX), merged in by enrichSemanticModelSources (Prep for AI, G5)
  aiSearch?: DataAgentAiSearchConfig;  // ai-search retrieval options (honored by the executor)
  graph?: DataAgentGraphScope;         // microsoft-graph scope (site/drive/mail)
  agent?: DataAgentAgentConfig;        // agent compose-back (hosted Loom App /invoke)
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
  'metric-view': 'SQL over the governed metric view (GROUP BY governed dimensions, select the governed measure expressions)',
  'ai-search': 'an Azure AI Search query',
  ontology: 'an ontology / Loom IQ semantic query',
  graph: 'a GQL / Cypher graph traversal',
  'microsoft-graph': 'a plain full-text Microsoft Graph search phrase (no operators)',
  agent: 'a plain natural-language instruction — the hosted agent runs its own tool-calling loop and returns an answer',
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
    if (src.type === 'ai-search' && src.aiSearch) {
      const kind = src.aiSearch.queryKind || 'keyword';
      lines.push(`Retrieval mode: ${kind}${src.aiSearch.top ? ` · top ${src.aiSearch.top} documents` : ''}. Emit a plain search phrase as the query — the platform runs it in ${kind} mode.`);
      if (src.aiSearch.citations) {
        lines.push('CITATIONS REQUIRED: retrieved documents arrive numbered [1]…[n]; cite the matching [n] inline for every claim grounded on this source.');
      }
    }
    if (src.type === 'microsoft-graph' && src.graph) {
      const g = src.graph;
      const scopeDesc = g.kind === 'mail'
        ? `the ${g.mailbox || '(unset)'} Exchange Online mailbox`
        : g.kind === 'drive'
          ? `the OneDrive/SharePoint drive ${g.driveId || '(unset)'}`
          : `the SharePoint site ${g.site || '(unset)'}`;
      lines.push(`Scope: ${scopeDesc}. Emit a short plain-text search phrase as the query — the platform runs it against Microsoft Graph and returns the matching ${g.kind === 'mail' ? 'messages' : 'files'}.`);
    }
    if (src.type === 'agent') {
      lines.push('This is a HOSTED AGENT (a bring-your-own agent harness). Emit a clear natural-language instruction as the query — the platform POSTs it to the agent\'s /invoke endpoint, which runs its own multi-step tool-calling loop and returns a final answer you then ground your response on.');
    }
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
  lines.push('Route financial / aggregated metrics to a semantic model when present; raw exploration to lakehouse / warehouse; log / telemetry analysis to KQL; document retrieval to AI Search; SharePoint/OneDrive files and mailbox content to a Microsoft 365 (Graph) source.');
  return lines.join('\n');
}

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token for data agent');
  return t.token;
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/**
 * Token budget for the #4091 QUERY-ONLY recovery turn. The visible payload is a
 * few hundred tokens of JSON, but a reasoning deployment spends its (invisible)
 * reasoning tokens against this same cap before emitting a character — so the
 * budget has to cover both or the recovery reproduces the very truncation it
 * exists to defeat.
 */
const QUERY_ONLY_MAX_TOKENS = 1600;

/**
 * One AOAI chat round-trip against a resolved {@link AoaiTarget}, with the
 * reasoning-model temperature fallback (some reasoning deployments reject a
 * non-default `temperature`/`top_p` — we retry once without it). `opts.deployment`
 * overrides the target's deployment so a caller can route THIS turn to a
 * different tier (e.g. the WS-1.1 strong/reasoning deployment) without changing
 * the endpoint. Reused by {@link chatGrounded} and the reasoning-mode planner
 * (`data-agent-reasoning.ts`), so both share one battle-tested request path.
 */
export async function aoaiChatTurn(
  target: AoaiTarget,
  messages: Array<{ role: string; content: string }>,
  opts: { deployment?: string; maxCompletionTokens?: number; temperature?: number } = {},
): Promise<{ content: string; usage: any; finishReason?: string }> {
  const token = await aoaiToken();
  const deployment = opts.deployment?.trim() || target.deployment;
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const maxCompletionTokens = opts.maxCompletionTokens ?? 1200;
  // Caller-supplied sampling temperature (e.g. a Spindle function's model/settings
  // panel) overrides the default 0.2; the unsupported-param retry still drops it
  // entirely for reasoning deployments that reject any non-default temperature.
  const temp = typeof opts.temperature === 'number' ? opts.temperature : 0.2;
  const send = async (withTemp: boolean) => fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildAoaiBody({ messages: messages as AoaiChatMessage[], maxCompletionTokens, temperature: withTemp ? temp : undefined })),
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
  const choice = j?.choices?.[0];
  // `finish_reason` is LOAD-BEARING, not decoration. On a reasoning deployment
  // (o-series / gpt-5) the reasoning tokens are billed against the SAME
  // `max_completion_tokens` cap as the visible answer, so a modest cap routinely
  // returns `finish_reason:'length'` with truncated — or entirely EMPTY —
  // content. Discarding it (as this function used to) makes a truncated
  // completion indistinguishable from a model that deliberately said nothing,
  // which is exactly how a data-agent turn could report "no plan was produced"
  // when the truth was "the plan never fit in the budget". See issue #4091.
  return {
    content: choice?.message?.content || '',
    usage: j?.usage || {},
    finishReason: choice?.finish_reason ? String(choice.finish_reason) : undefined,
  };
}

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
  /**
   * #4091 — did ANY generated query actually execute against a real backend?
   * Computed from the executor's real metadata (`tools[].executed`), never from
   * the model's prose. `false` with sources attached means the answer is NOT
   * grounded in real rows, however confident it reads.
   */
  grounded?: boolean;
  /**
   * #4091 — the honest gate when sources are attached but nothing executed:
   * either the per-source backend gates, or "the model produced no runnable
   * query". Absent when the turn genuinely ran a query.
   */
  groundingGate?: string;
  /**
   * #4091 — true when the first pass narrated instead of emitting a query and
   * the QUERY-ONLY recovery turn had to recover a runnable one. Surfaced so a
   * chronically narrating deployment is visible rather than silently papered over.
   */
  recoveredQuery?: boolean;
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
 * The QUERY-ONLY recovery prompt (issue #4091).
 *
 * {@link composeSystemPrompt} asks for prose FIRST and the executable tools JSON
 * LAST. That ordering is the single most fragile thing in the turn: the one part
 * the platform can actually RUN is the last thing generated, so it is the first
 * thing lost when a completion is truncated — and on a reasoning deployment the
 * reasoning tokens eat the same budget before a single visible character is
 * emitted. It also leaves the model free to narrate ("I will query… let me run
 * the query") and simply never reach the JSON.
 *
 * This prompt removes both failure modes for the retry: it asks for the tools
 * JSON and NOTHING else, so the executable payload is the ONLY thing generated.
 * Prose is forbidden, so narration is not an available answer.
 */
function composeQueryOnlyPrompt(cfg: DataAgentConfig): string {
  const lines: string[] = [];
  lines.push('You are the QUERY GENERATOR for a CSA Loom data agent (Azure-native — Synapse / ADX / Databricks / Azure AI Search — never Microsoft Fabric).');
  lines.push('Your previous reply described a query instead of emitting one, so nothing could be executed. Do NOT explain, do NOT narrate, do NOT apologise.');
  lines.push('Emit the query (or queries) needed to answer the question, and NOTHING else.');
  lines.push('If you are unsure of the exact schema, emit a real DISCOVERY query (list tables/columns from INFORMATION_SCHEMA or the source equivalent) — never a placeholder, never a comment, never an empty query.');
  lines.push('Respond with EXACTLY ONE fenced json block and no other text:');
  lines.push('```json');
  lines.push('{"toolsUsed":[{"source":"<source name>","type":"<source type>","action":"query|search|traverse|retrieve","query":"<the exact runnable query>"}]}');
  lines.push('```');
  lines.push('');
  lines.push('## Attached data sources');
  for (const src of cfg.sources) {
    lines.push(`### ${src.name} — ${src.type} (queries expressed as ${QUERY_LANG[src.type] ?? 'the source-native query language'})`);
    if (src.tables?.trim()) lines.push(`Selected tables / model: ${src.tables.trim()}`);
    if (src.description?.trim()) lines.push(`When to use this source: ${src.description.trim()}`);
    if (src.instructions?.trim()) lines.push(src.instructions.trim());
    if (src.examples?.length) {
      lines.push('Example question → query pairs:');
      for (const ex of src.examples) {
        if (ex.question && ex.query) lines.push(`- Q: ${ex.question}\n  Query: ${ex.query}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Does this prose PROMISE an execution it never performed? Matches the exact
 * failure the operator hit on the live estate: *"To answer your question, I will
 * query the casino.fact_session table… Let me run the query."* — a confident,
 * fluent answer containing no data, which reads as working to casual inspection.
 *
 * Used ONLY to decide whether an ungrounded answer needs an explicit honest
 * prefix; the structured {@link DataAgentAnswer.groundingGate} is always set.
 * Pure + unit-tested.
 */
export function promisesExecution(text: string): boolean {
  const t = String(text || '');
  return /\b(?:i(?:'|’)?ll|i\s+will|let\s+me|going\s+to|i\s+am\s+going\s+to|i(?:'|’)?m\s+going\s+to|shall\s+i|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to)\s+(?:now\s+|then\s+|first\s+)?(?:run|execute|query|fetch|retrieve|pull|check|look\s+up|calculate|compute)\b/i.test(t);
}

/** True when at least one parsed tool carries a query the platform can run. */
function hasRunnableQuery(a: Pick<DataAgentAnswer, 'tools'>): boolean {
  return !!a.tools?.some((t) => typeof t.query === 'string' && t.query.trim().length > 0);
}

/**
 * Run one grounded turn against the live AOAI deployment.
 * Throws NoAoaiDeploymentError when no model is deployed (editor surfaces a
 * MessageBar with the Foundry-hub "deploy gpt-4o-mini" remediation).
 */
export async function chatGrounded(cfg: DataAgentConfig, history: ChatTurn[], question: string, ctx?: { tenantId?: string; deployment?: string; temperature?: number; maxCompletionTokens?: number }): Promise<DataAgentAnswer> {
  const target = await resolveAoaiTarget();

  // One AOAI round-trip on the resolved target (shared temperature-fallback path).
  // A caller may PIN this turn to a specific tier deployment / temperature / token
  // cap (Spindle's per-function model & settings panel) — all optional, so every
  // existing caller is byte-identical.
  const runChat = (messages: Array<{ role: string; content: string }>, maxCompletionTokens?: number) =>
    aoaiChatTurn(target, messages, {
      deployment: ctx?.deployment,
      temperature: ctx?.temperature,
      maxCompletionTokens: maxCompletionTokens ?? ctx?.maxCompletionTokens,
    });

  // ── Phase 1: model proposes an answer + the per-source query it would run ──
  const phase1Messages = [
    { role: 'system', content: composeSystemPrompt(cfg) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];
  const first = await runChat(phase1Messages);
  let parsed = parseAnswer(first.content, cfg.sources);

  // ── Phase 1b: RECOVERY — the turn produced NOTHING to run (issue #4091) ────
  // The model narrated ("I will query… let me run the query") instead of
  // emitting the tools JSON, or the trailing JSON block was truncated off the
  // end of a long completion. Either way phase 2 has no query to execute, and
  // without this retry the narration is returned verbatim as a successful,
  // confident, data-free answer — the exact no-vaporware failure mode.
  //
  // Ask again with the QUERY-ONLY prompt, which cannot be narrated away and
  // puts the runnable payload FIRST so truncation cannot eat it.
  let recoveredQuery = false;
  // #4095 — WHY the recovery produced nothing, when it produced nothing. A
  // recovery call that THREW never reached the model at all, so the honest gate
  // below must not report it as "the model emitted no query": that would assert
  // a cause the code never established (deploy-integrity.md R7). Undefined means
  // the call genuinely completed and simply carried no runnable query.
  let recoveryFailure: string | undefined;
  if (cfg.sources.length > 0 && !hasRunnableQuery(parsed)) {
    try {
      const retry = await runChat(
        [
          { role: 'system', content: composeQueryOnlyPrompt(cfg) },
          { role: 'user', content: question },
          ...(first.content.trim()
            ? [{ role: 'assistant', content: first.content }, { role: 'user', content: 'That reply contained no runnable query. Emit ONLY the tools JSON block now.' }]
            : []),
        ],
        // A dedicated budget: this completion is a few hundred tokens of JSON,
        // but a reasoning deployment still spends its reasoning tokens here.
        Math.max(ctx?.maxCompletionTokens ?? 0, QUERY_ONLY_MAX_TOKENS),
      );
      const retryParsed = parseAnswer(retry.content, cfg.sources);
      if (hasRunnableQuery(retryParsed)) {
        // Keep phase 1's prose; take ONLY the runnable tools from the retry.
        parsed = { ...parsed, tools: retryParsed.tools, query: retryParsed.query, sourceUsed: retryParsed.sourceUsed };
        recoveredQuery = true;
      }
    } catch (err) {
      // Recovery stays best-effort — a failed retry still falls through to the
      // honest gate — but the REASON is load-bearing, because it is the whole
      // difference between a model that said nothing and an endpoint we never
      // reached (transport, timeout, quota/429, auth).
      recoveryFailure = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }

  // ── Phase 2: actually RUN each generated query read-only on the real backend ──
  let usage = first.usage;
  let finalAnswer = parsed.answer;
  if (parsed.tools && parsed.tools.length > 0) {
    const groundingBlocks: string[] = [];
    for (const tool of parsed.tools) {
      if (!tool.query) continue;
      // Resolve the typed source for this tool. Precedence matters:
      //   1. exact name match — the model copied the source name, as asked;
      //   2. the ONLY attached source, but ONLY when the tool's declared type
      //      agrees with it (or the tool declared none). The model routinely
      //      writes the schema-qualified TABLE (`casino.fact_session`) where
      //      the source name belongs, and with one source attached that is
      //      unambiguous — throwing a perfectly runnable query away over a name
      //      mismatch is one of the ways #4091 produced "no data". But the type
      //      guard is NOT optional: without it a `kql` tool lands on the single
      //      attached WAREHOUSE, the wrong backend answers `executed:true`, and
      //      the turn reports `grounded:true` for an answer the question was
      //      never asked of. A name mismatch is a naming slip; a TYPE mismatch
      //      means the model was routing somewhere else entirely, and the only
      //      honest response is to fall through to (3) and gate.
      //   3. synthesise from the tool's declared type — last resort ONLY, since
      //      a synthesised source carries none of the real source's typed config
      //      (AI Search index, Graph scope, agent invoke URL, semantic-model id,
      //      lakehouse database name), so preferring it over a real attached
      //      source would silently target the wrong thing.
      const only = cfg.sources.length === 1 ? cfg.sources[0] : undefined;
      const toolType = tool.type?.trim().toLowerCase();
      const src = cfg.sources.find((s) => s.name && tool.source && s.name.toLowerCase() === tool.source.toLowerCase())
        || (only && (!toolType || toolType === only.type.toLowerCase()) ? only : undefined)
        || (tool.type ? { id: tool.source, type: tool.type as DataAgentSource['type'], name: tool.source } : undefined);
      if (!src) { tool.executed = false; tool.gate = 'Source not found on this agent.'; continue; }
      const exec: SourceExecution = await executeSourceQuery(src, tool.query, ctx);
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

  // ── Honest post-condition (issue #4091) ───────────────────────────────────
  // This function used to have NO check that anything was ever executed: a turn
  // that produced no query returned the model's confident narration as a
  // successful answer. Per .claude/rules/no-vaporware.md an ungrounded answer
  // must declare itself. `grounded` is computed from the REAL execution
  // metadata the backend produced, never from the model's prose.
  const grounded = !!parsed.tools?.some((t) => t.executed);
  let groundingGate: string | undefined;
  if (!grounded && cfg.sources.length > 0) {
    const gates = (parsed.tools || []).map((t) => t.gate).filter(Boolean) as string[];
    // Three DISTINCT causes, never collapsed into one another (deploy-integrity
    // R7 — an error must not state as fact something it did not establish):
    //   · a backend refused the query        → report the backend's own reason;
    //   · the recovery call never completed  → report the transport failure and
    //     say plainly that the model's behaviour is UNKNOWN, because we never
    //     reached it. Reporting this as "the model produced no query" is the
    //     exact false-attribution R7 exists to prevent;
    //   · the recovery call DID complete and carried no query → and only then
    //     is the model the established cause.
    groundingGate = gates.length
      ? `No query executed against the attached source(s): ${gates.join(' · ')}`
      : recoveryFailure
        ? `The query-recovery turn did not complete (${recoveryFailure}), so no runnable query was obtained and this answer is NOT grounded in real rows. Whether a runnable query would have been returned is unknown — the deployment was never reached.`
        : 'The model produced no runnable query for the attached source(s), so nothing was executed and this answer is NOT grounded in real rows.';
    // A confident promise of execution that never executed is the exact failure
    // this gate exists to make impossible to mistake for a working answer.
    if (promisesExecution(finalAnswer)) {
      finalAnswer = `[Not grounded] ${groundingGate}\n\n${finalAnswer}`;
    }
  }

  const u = usage || {};
  return {
    ...parsed,
    answer: finalAnswer,
    usage: (u.total_tokens != null)
      ? { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 }
      : undefined,
    model: ctx?.deployment?.trim() || target.deployment,
    sourcesAvailable: cfg.sources.map((s) => s.name).filter(Boolean),
    grounded,
    ...(groundingGate ? { groundingGate } : {}),
    ...(recoveredQuery ? { recoveredQuery: true } : {}),
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
    aiSearch: s.aiSearch || undefined,
    graph: s.graph || undefined,
  }));
}
