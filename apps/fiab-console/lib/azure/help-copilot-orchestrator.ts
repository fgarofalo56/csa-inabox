/**
 * Help Copilot orchestrator — docs-grounded RAG assistant for CSA Loom.
 *
 * Distinct from the cross-item `copilot-orchestrator.ts` which ACTS on
 * Azure services. This one answers HOW-TOs: "what is Loom", "how do I
 * deploy", "what's a data product". It has 5 tools:
 *
 *   - searchDocs(query, top_k)          — docs RAG
 *   - searchRepo(query, language?, top_k) — code summaries RAG
 *   - openLoomPage(slug)                — frontend instruction
 *   - runDiagnostic(check)              — surfaces live config state
 *   - logIssue(title, body, labels[])   — opens GitHub issue
 *
 * Reuses `resolveAoaiTarget()` from the cross-item orchestrator so we
 * use the same AOAI deployment. Persists history in a separate Cosmos
 * container `copilot-help-sessions` (PK /userId).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type { Container } from '@azure/cosmos';
import crypto from 'node:crypto';

import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
  type AoaiTarget,
} from './copilot-orchestrator';
import { copilotSessionsContainer } from './cosmos-client';
import {
  searchDocs as ragSearchDocs,
  isSearchConfigured,
  type DocHit,
} from './loom-docs-index';
import type { TenantCopilotConfig } from '../types/copilot-config';

// ---------- Credential (for AOAI scope) ----------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Types ----------

export interface Citation {
  /** e.g. "docs/fiab/architecture.md#Topology" */
  id: string;
  /** Filesystem-relative path */
  path: string;
  /** docs / repo / prp / adr */
  kind: string;
  /** Optional H1/H2 heading the chunk sits under */
  heading?: string;
  /** Public URL for `docs/...` chunks. Otherwise undefined; renderer
   *  shows a "view in repo" GitHub deep-link instead. */
  url?: string;
  /** First ~200 chars of the chunk for inline preview */
  preview: string;
}

export type HelpStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'citation'; citations: Citation[] }
  | { kind: 'handoff'; reason: string; deepLink: string; suggestedPrompt: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string };

export interface HelpOrchestrateOptions {
  prompt: string;
  sessionId: string;
  userId: string;
  /** Optional override; default 6 (tighter than the cross-item orchestrator) */
  maxIterations?: number;
  /** Tenant admin-selected Copilot config. The help agent prefers
   *  helpAgentDeployment, then copilotChatDeployment, then env. */
  tenantConfig?: TenantCopilotConfig | null;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

// ---------- System prompt ----------

const SYSTEM_PROMPT = `You are the CSA Loom Help Copilot — a docs-grounded assistant inside the Loom Console (a Microsoft Fabric workspace experience for Azure tenants without Fabric).

Your job: answer questions about CSA Loom (what it is, how to set it up, how to do anything). You ALWAYS:
1. Ground answers in the docs + repo via the searchDocs / searchRepo tools. Never fabricate doc content.
2. Cite every claim. Each tool_result you reason over MUST become a citation in your final answer.
3. Keep answers concise and concrete. Lead with the answer, then 1-3 short bullets of context, then "Sources:" with citation chips.
4. If the user asks for an ACT (create a workspace, run a pipeline, deploy a notebook, etc.), do NOT try to do it — call the runDiagnostic tool to confirm what's wired, then suggest they switch to the Loom Copilot at /copilot which has the full tool registry. Use the handoff format described below.
5. If a question is ambiguous, ask one clarifying question.
6. If runDiagnostic returns "not_configured" for something the user is asking about, surface that gap honestly — don't pretend it works.
7. For "open this page" requests, call openLoomPage with the slug.
8. For bug reports or feature requests, offer to file via logIssue — confirm title + body with the user before calling.

Tools at your disposal:
- searchDocs(query, top_k=5, kind?): RAG over docs/fiab/, docs/, PRPs/active/csa-loom, docs/fiab/adr
- searchRepo(query, language?, top_k=5): RAG over apps/fiab-console/lib/{azure,editors,components} source summaries
- openLoomPage(slug): tell the frontend to router.push(slug)
- runDiagnostic(check): returns live config state. checks = "aoai" | "ai-search" | "cosmos" | "version" | "tenant" | "all"
- logIssue(title, body, labels): files a GitHub issue (asks user to confirm first)

Handoff format (when user asks for an ACT):
Final message ends with a fenced block:
\`\`\`handoff
reason: <one line why this is an act, not a how-to>
deepLink: /copilot?prompt=<URL-encoded-prefilled-prompt>
suggestedPrompt: <plain text of the prefilled prompt>
\`\`\`

You are NOT the action orchestrator. Stay in your lane.`;

// ---------- Tool definitions ----------

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any) => Promise<{ result: unknown; citations?: Citation[] }>;
}

function citationFromHit(hit: DocHit): Citation {
  return {
    id: hit.id,
    path: hit.path,
    kind: hit.kind,
    heading: hit.heading,
    url: hit.url,
    preview: hit.content.slice(0, 200).replace(/\s+/g, ' ').trim(),
  };
}

function buildTools(deps: {
  recordCitations: (cs: Citation[]) => void;
  upstreamRepo: { owner: string; name: string };
  githubToken?: string;
}): ToolDef[] {
  return [
    {
      name: 'searchDocs',
      description: 'Search the CSA Loom docs corpus (docs/fiab, PRPs, ADRs). Returns top_k matching chunks with path, heading, and content preview. Use this for every how-to question.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '2-5 keyword phrase' },
          top_k: { type: 'number', description: 'Max results (default 5, max 10)' },
          kind: { type: 'string', enum: ['docs', 'prp', 'adr'], description: 'Optional filter' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async ({ query, top_k, kind }) => {
        const top = Math.min(Math.max(top_k || 5, 1), 10);
        const { hits, backend } = await ragSearchDocs(query, top, kind);
        const citations = hits.map(citationFromHit);
        deps.recordCitations(citations);
        return {
          result: {
            backend,
            count: hits.length,
            hits: hits.map((h) => ({
              path: h.path,
              heading: h.heading,
              url: h.url,
              score: Number(h.score.toFixed(3)),
              content: h.content,
            })),
          },
          citations,
        };
      },
    },
    {
      name: 'searchRepo',
      description: 'Search the apps/fiab-console source for module summaries (exports, HTTP routes, banner comments). Use this when the user asks "where does X live in code".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          language: { type: 'string', enum: ['ts', 'tsx'], description: 'Reserved for future filtering' },
          top_k: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async ({ query, top_k }) => {
        const top = Math.min(Math.max(top_k || 5, 1), 10);
        const { hits, backend } = await ragSearchDocs(query, top, 'repo');
        const citations = hits.map(citationFromHit);
        deps.recordCitations(citations);
        return {
          result: {
            backend,
            count: hits.length,
            hits: hits.map((h) => ({ path: h.path, score: Number(h.score.toFixed(3)), summary: h.content })),
          },
          citations,
        };
      },
    },
    {
      name: 'openLoomPage',
      description: 'Tell the frontend to router.push to a Loom page. Use for "open the workspaces page", "take me to the data agent". Returns the slug the UI should navigate to.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Page path, e.g. /workspaces, /copilot, /admin, /learn' },
        },
        required: ['slug'],
        additionalProperties: false,
      },
      handler: async ({ slug }) => {
        const safe = String(slug || '').trim();
        if (!safe.startsWith('/')) return { result: { ok: false, error: 'slug must start with /' } };
        // Confine to known prefixes
        const allowed = ['/workspaces', '/browse', '/onelake', '/governance', '/monitor', '/admin',
          '/setup', '/apps', '/workloads', '/learn', '/copilot', '/data-agent', '/realtime-hub',
          '/api-marketplace', '/workload-hub', '/deployment-pipelines', '/items', '/'];
        if (!allowed.some((p) => safe === p || safe.startsWith(`${p}/`))) {
          return { result: { ok: false, error: `slug ${safe} not in allow-list` } };
        }
        return { result: { ok: true, slug: safe, action: 'navigate' } };
      },
    },
    {
      name: 'runDiagnostic',
      description: 'Probe live Loom config. Useful when the user asks "is X wired?" or to understand why a feature is missing. check = aoai | ai-search | cosmos | version | tenant | all',
      parameters: {
        type: 'object',
        properties: {
          check: { type: 'string', enum: ['aoai', 'ai-search', 'cosmos', 'version', 'tenant', 'all'] },
        },
        required: ['check'],
        additionalProperties: false,
      },
      handler: async ({ check }) => {
        const all = check === 'all';
        const out: Record<string, unknown> = {};

        if (all || check === 'aoai') {
          try {
            const t = await resolveAoaiTarget();
            out.aoai = { configured: true, endpoint: t.endpoint, deployment: t.deployment };
          } catch (e: any) {
            const msg = e instanceof NoAoaiDeploymentError ? e.message : (e?.message || String(e));
            out.aoai = { configured: false, error: msg, fix: 'Deploy a gpt-4o chat-completions model on the Foundry hub' };
          }
        }
        if (all || check === 'ai-search') {
          out.aiSearch = {
            configured: isSearchConfigured(),
            service: process.env.LOOM_AI_SEARCH_SERVICE || null,
            fix: isSearchConfigured() ? null : 'Set LOOM_AI_SEARCH_SERVICE in the Loom Console env (see platform/fiab/bicep/modules/admin-plane/main.bicep)',
          };
        }
        if (all || check === 'cosmos') {
          const ep = process.env.LOOM_COSMOS_ENDPOINT || null;
          out.cosmos = {
            configured: !!ep,
            endpoint: ep,
            database: process.env.LOOM_COSMOS_DATABASE || 'loom',
          };
        }
        if (all || check === 'version') {
          out.version = {
            current: process.env.LOOM_VERSION || process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev',
          };
        }
        if (all || check === 'tenant') {
          out.tenant = {
            tenantId: process.env.AZURE_TENANT_ID || null,
            cloud: process.env.AZURE_CLOUD || 'AzureCloud',
            subscriptionId: process.env.LOOM_SUBSCRIPTION_ID || null,
          };
        }
        return { result: out };
      },
    },
    {
      name: 'logIssue',
      description: 'File a GitHub issue against the upstream csa-inabox repo. Only call after confirming title + body with the user. Returns issue URL on success, deep-link to issue/new if no token.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'body'],
        additionalProperties: false,
      },
      handler: async ({ title, body, labels }) => {
        const t = String(title || '').slice(0, 120);
        const b = String(body || '').slice(0, 4000);
        const ls = Array.isArray(labels) ? labels.slice(0, 10).map((x) => String(x)) : ['help-copilot'];
        if (!t || !b) return { result: { ok: false, error: 'title and body required' } };
        if (!deps.githubToken) {
          const url = `https://github.com/${deps.upstreamRepo.owner}/${deps.upstreamRepo.name}/issues/new?title=${encodeURIComponent(t)}&body=${encodeURIComponent(b)}&labels=${encodeURIComponent(ls.join(','))}`;
          return { result: { ok: true, mode: 'deep-link', url, note: 'LOOM_FEEDBACK_GITHUB_TOKEN not set; returning issue/new URL the user can click.' } };
        }
        try {
          const r = await fetch(`https://api.github.com/repos/${deps.upstreamRepo.owner}/${deps.upstreamRepo.name}/issues`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${deps.githubToken}`,
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
            },
            body: JSON.stringify({ title: t, body: b, labels: ls }),
          });
          if (!r.ok) {
            const text = await r.text();
            return { result: { ok: false, error: `GitHub ${r.status}: ${text.slice(0, 200)}` } };
          }
          const j = await r.json() as { number?: number; html_url?: string };
          return { result: { ok: true, mode: 'created', issueNumber: j.number, url: j.html_url } };
        } catch (e: any) {
          return { result: { ok: false, error: e?.message || String(e) } };
        }
      },
    },
  ];
}

function toolsForAoai(defs: ToolDef[]): unknown[] {
  return defs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ---------- Persistence ----------

const COSMOS_CONTAINER_ID = 'copilot-help-sessions';

async function helpSessionsContainer(): Promise<Container> {
  const cs = await copilotSessionsContainer();
  const db = (cs as any).database;
  const { container } = await db.containers.createIfNotExists({
    id: COSMOS_CONTAINER_ID,
    partitionKey: { paths: ['/userId'] },
  });
  return container;
}

async function persistTurn(sessionId: string, userId: string, role: string, content: string, citations?: Citation[]) {
  try {
    const c = await helpSessionsContainer();
    const existing = await c.item(sessionId, userId).read<any>().catch(() => ({ resource: null }));
    const now = new Date().toISOString();
    if (!existing.resource) {
      await c.items.create({
        id: sessionId,
        sessionId,
        userId,
        turns: [{ role, content, citations, ts: now }],
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const doc = existing.resource;
      doc.turns = [...(doc.turns || []), { role, content, citations, ts: now }];
      doc.updatedAt = now;
      await c.item(sessionId, userId).replace(doc);
    }
  } catch {
    // Persistence failure must not break the stream
  }
}

export async function listHelpSessions(userId: string, limit = 50): Promise<Array<{
  id: string; sessionId: string; createdAt: string; updatedAt: string; firstPrompt?: string; turnCount: number;
}>> {
  const c = await helpSessionsContainer();
  const q = {
    query: 'SELECT TOP @n c.id, c.sessionId, c.createdAt, c.updatedAt, ARRAY_LENGTH(c.turns) AS turnCount, c.turns[0].content AS firstPrompt FROM c WHERE c.userId = @u ORDER BY c.updatedAt DESC',
    parameters: [{ name: '@n', value: limit }, { name: '@u', value: userId }],
  };
  const { resources } = await c.items.query(q, { partitionKey: userId }).fetchAll();
  return resources as any;
}

export async function getHelpSession(sessionId: string, userId: string): Promise<any | null> {
  const c = await helpSessionsContainer();
  const r = await c.item(sessionId, userId).read<any>().catch(() => ({ resource: null }));
  return r.resource;
}

// ---------- AOAI plumbing ----------

/** Newer reasoning models (o1/o3/gpt-5/MAI-*) reject any non-default
 *  temperature/top_p; detect that 400 so we can retry without it. */
function isUnsupportedSamplingParam(body: string): boolean {
  return /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(body)
    && /temperature|top_p/i.test(body);
}

async function callAoai(target: AoaiTarget, messages: ChatMessage[], tools: unknown[]): Promise<any> {
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const base: Record<string, unknown> = { messages, tools, tool_choice: 'auto' };
  const send = async (withTemperature: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(withTemperature ? { ...base, temperature: 0.2 } : base),
    });
  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (isUnsupportedSamplingParam(t)) res = await send(false);
    else throw new Error(`AOAI chat-completions failed 400: ${t.slice(0, 400)}`);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI chat-completions failed ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.json();
}

// ---------- Handoff parser ----------

const HANDOFF_RE = /```handoff\s+([\s\S]*?)```/i;

function parseHandoff(finalContent: string): { handoff?: { reason: string; deepLink: string; suggestedPrompt: string }; stripped: string } {
  const m = finalContent.match(HANDOFF_RE);
  if (!m) return { stripped: finalContent };
  const block = m[1];
  const reason = (block.match(/reason:\s*(.+)/i)?.[1] || '').trim();
  const deepLink = (block.match(/deepLink:\s*(.+)/i)?.[1] || '').trim();
  const suggestedPrompt = (block.match(/suggestedPrompt:\s*(.+)/i)?.[1] || '').trim();
  if (!deepLink) return { stripped: finalContent };
  return {
    handoff: { reason, deepLink, suggestedPrompt },
    stripped: finalContent.replace(HANDOFF_RE, '').trim(),
  };
}

// ---------- Public orchestration ----------

export async function* orchestrateHelp(opts: HelpOrchestrateOptions): AsyncIterable<HelpStep> {
  const { prompt, sessionId, userId } = opts;
  const maxIter = opts.maxIterations ?? 6;

  let target: AoaiTarget;
  try {
    // The help agent prefers its own model deployment; map it onto the chat
    // deployment field resolveAoaiTarget understands.
    const cfg = opts.tenantConfig
      ? {
          ...opts.tenantConfig,
          copilotChatDeployment:
            opts.tenantConfig.helpAgentDeployment || opts.tenantConfig.copilotChatDeployment,
        }
      : null;
    target = await resolveAoaiTarget(cfg);
  } catch (e: any) {
    yield {
      kind: 'error',
      error: e instanceof NoAoaiDeploymentError
        ? e.message
        : `AOAI resolution failed: ${e?.message || e}`,
    };
    return;
  }

  const allCitations: Citation[] = [];
  const tools = buildTools({
    recordCitations: (cs) => { for (const c of cs) if (!allCitations.find((x) => x.id === c.id)) allCitations.push(c); },
    upstreamRepo: {
      owner: process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56',
      name: process.env.LOOM_FEEDBACK_REPO_NAME || 'csa-inabox',
    },
    githubToken: process.env.LOOM_FEEDBACK_GITHUB_TOKEN,
  });
  const toolDefs = toolsForAoai(tools);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  await persistTurn(sessionId, userId, 'user', prompt);

  for (let i = 0; i < maxIter; i++) {
    let resp: any;
    try {
      resp = await callAoai(target, messages, toolDefs);
    } catch (e: any) {
      yield { kind: 'error', error: e?.message || String(e) };
      return;
    }

    const choice = resp?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      yield { kind: 'error', error: 'AOAI returned no choices' };
      return;
    }

    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    const toolCalls = msg.tool_calls as ChatMessage['tool_calls'];
    if (!toolCalls || toolCalls.length === 0) {
      const final = msg.content || '';
      const { handoff, stripped } = parseHandoff(final);
      if (allCitations.length > 0) {
        yield { kind: 'citation', citations: allCitations };
      }
      if (handoff) {
        yield { kind: 'handoff', reason: handoff.reason, deepLink: handoff.deepLink, suggestedPrompt: handoff.suggestedPrompt };
      }
      yield { kind: 'final', content: stripped };
      await persistTurn(sessionId, userId, 'assistant', stripped, allCitations);
      return;
    }

    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try { parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}

      yield { kind: 'tool_call', name: tc.function.name, args: parsedArgs, callId: tc.id };

      const tool = tools.find((t) => t.name === tc.function.name);
      const started = Date.now();
      if (!tool) {
        const errMsg = `Unknown tool: ${tc.function.name}`;
        yield { kind: 'tool_result', name: tc.function.name, callId: tc.id, durationMs: 0, error: errMsg };
        messages.push({
          role: 'tool', tool_call_id: tc.id, name: tc.function.name,
          content: JSON.stringify({ error: errMsg }),
        });
        continue;
      }

      try {
        const { result } = await tool.handler(parsedArgs as any);
        const serialized = JSON.stringify(result);
        const truncated = serialized.length > 16_000 ? serialized.slice(0, 16_000) + '...[truncated]' : serialized;
        yield {
          kind: 'tool_result',
          name: tc.function.name,
          callId: tc.id,
          durationMs: Date.now() - started,
          result,
        };
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: truncated });
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        yield { kind: 'tool_result', name: tc.function.name, callId: tc.id, durationMs: Date.now() - started, error: errMsg };
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ error: errMsg }) });
      }
    }
  }

  yield { kind: 'error', error: `Max iterations (${maxIter}) reached without a final answer.` };
}

// ---------- Utility for tests ----------

export const __internal = {
  parseHandoff,
  buildTools,
  SYSTEM_PROMPT,
};

export function newSessionId(): string {
  return `help-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}
