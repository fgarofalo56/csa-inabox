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

import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
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
import { isSafetyConfigured, shieldPrompt, moderateContent } from './foundry-client';
import {
  searchDocs as ragSearchDocs,
  isSearchConfigured,
  type DocHit,
} from './loom-docs-index';
import { gatherReceipts, type ReceiptSource } from './help-receipts';
import {
  PROPOSED_CHANGE_KEY,
  extractProposedChange,
} from '../copilot/proposed-change';
import type { TenantCopilotConfig } from '../types/copilot-config';

// ---------- Credential (for AOAI scope) ----------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
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
  | { kind: 'proposed_change'; target: string; before: string; after: string; lang?: string; summary?: string; callId?: string }
  | { kind: 'handoff'; reason: string; deepLink: string; suggestedPrompt: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string; code?: string };

/** Where the user is in an in-app tutorial, so the agent can diagnose against
 *  THIS step's expected outcome rather than answering generically. */
export interface TutorialContext {
  /** Tutorial id, e.g. "editor:lakehouse" or "tutorial:02-first-lakehouse". */
  id: string;
  /** 0-based index of the active step. */
  stepIndex: number;
  stepTitle?: string;
  stepBody?: string;
  totalSteps?: number;
}

/** The item whose run/provision receipts the agent may read for auto-error
 *  detection. Derived from the open editor route. */
export interface ReceiptScope {
  itemId?: string;
  itemType?: string;
  workspaceId?: string;
}

export interface HelpOrchestrateOptions {
  prompt: string;
  sessionId: string;
  userId: string;
  /** Optional override; default 6 (tighter than the cross-item orchestrator) */
  maxIterations?: number;
  /** Tenant admin-selected Copilot config. The help agent prefers
   *  helpAgentDeployment, then copilotChatDeployment, then env. */
  tenantConfig?: TenantCopilotConfig | null;
  /** Screen-awareness: where the user currently is in the console, so the
   *  agent can answer "what's on this screen / help me with this" in context.
   *  `tutorial` adds per-step awareness; `receiptScope` lets the agent read the
   *  open item's run/provision receipts for auto-error detection + fixes. */
  pageContext?: {
    path?: string;
    label?: string;
    itemType?: string;
    itemId?: string;
    tutorial?: TutorialContext;
    receiptScope?: ReceiptScope;
  };
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

const SYSTEM_PROMPT = `You are the CSA Loom Help Copilot — a docs-grounded assistant inside the CSA Loom Console (a self-contained data + AI platform on Azure). CSA Loom is its OWN product, NOT Microsoft Fabric — always describe features as CSA Loom features (e.g. "the CSA Loom Real-Time hub"), never "in Microsoft Fabric". You may name the underlying Azure services (Synapse, ADX, Event Hubs, AI Foundry, ADLS) since those are the real backends.

Your job: answer questions about CSA Loom (what it is, how to set it up, how to do anything). You ALWAYS:
1. Ground answers in the docs + repo via the searchDocs / searchRepo tools. Never fabricate doc content.
2. Cite every claim. Each tool_result you reason over MUST become a citation in your final answer.
3. Keep answers concise and concrete. Lead with the answer, then 1-3 short bullets of context, then "Sources:" with citation chips.
4. If the user asks for an ACT (create a workspace, run a pipeline, deploy a notebook, etc.), do NOT try to do it — call the runDiagnostic tool to confirm what's wired, then suggest they switch to the Loom Copilot at /copilot which has the full tool registry. Use the handoff format described below.
5. If a question is ambiguous, ask one clarifying question.
6. If runDiagnostic returns "not_configured" for something the user is asking about, surface that gap honestly — don't pretend it works.
7. For "open this page" requests, call openLoomPage with the slug.
8. For bug reports or feature requests, offer to file via logIssue — confirm title + body with the user before calling.
9. TUTORIAL STEP AWARENESS: when a tutorial-step context is provided, answer for THAT step's expected outcome first. If the user reports a failure, says "it didn't work", "I got an error", "this is stuck", or a step receipt shows a problem, call readReceipts FIRST (before guessing). Lead with the detected error and the EXACT remediation from the receipt's gate.remediation, then how it maps to the current step.
10. APPLY A FIX (approval-gated): when the right fix is an edit to the code in an OPEN notebook code cell, call proposeFix with the deterministic target ("notebook-cell:<cellId>"), the current text (before), and your corrected text (after). This renders a Keep/Undo diff the USER must approve — you do NOT apply it yourself, and you must NOT claim it is applied. proposeFix can ONLY apply to a notebook code cell today; for a fix to a query/SQL/KQL editor or anything that needs an ACTION (re-provision, re-run a pipeline, set an env var, grant a role), do NOT call proposeFix — explain the corrected text inline and use the handoff to /copilot instead.

Tools at your disposal:
- searchDocs(query, top_k=5, kind?): RAG over docs/fiab/, docs/, PRPs/active/csa-loom, docs/fiab/adr
- searchRepo(query, language?, top_k=5): RAG over apps/fiab-console/lib/{azure,editors,components} source summaries
- openLoomPage(slug): tell the frontend to router.push(slug)
- runDiagnostic(check): returns live config state. checks = "aoai" | "ai-search" | "cosmos" | "version" | "tenant" | "all"
- readReceipts(itemId?, itemType?, source?): reads the open item's run/provision receipts for auto-error detection. source = "provisioning" | "audit" | "runs" | "all". provisioning carries the install status + gate.remediation; runs carries failed Azure Data Factory pipeline/activity status + the real error; audit carries the recent action history. itemId/itemType default to the open item.
- proposeFix(target, before, after, lang?, summary?): propose an approval-gated edit to an OPEN notebook code cell. target MUST be "notebook-cell:<cellId>". Renders a Keep/Undo Monaco diff. Never applied without the user's Keep. (Query/SQL/KQL editors are not yet wired for in-place apply — for those, explain the fix inline and hand off to /copilot.)
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
  /** The open item, so readReceipts/proposeFix default to it without the
   *  model having to restate ids it can't see. */
  receiptScope?: ReceiptScope;
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
      name: 'readReceipts',
      description: 'Read the open item\'s run/provision receipts to auto-detect why a step failed. source="provisioning" returns the install status + gate.remediation (the exact env var/role/portal step to unblock); source="runs" returns failed Azure Data Factory pipeline + activity runs with the real error; source="audit" returns the recent action history; source="all" returns everything. Call this FIRST when the user reports a failure or asks why a tutorial step did not work.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: 'Item id; defaults to the open item.' },
          itemType: { type: 'string', description: 'Item type slug; defaults to the open item.' },
          source: { type: 'string', enum: ['provisioning', 'audit', 'runs', 'all'], description: 'Which receipt source (default all).' },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async ({ itemId, itemType, source }) => {
        const id = String(itemId || deps.receiptScope?.itemId || '').trim();
        const type = String(itemType || deps.receiptScope?.itemType || '').trim() || undefined;
        if (!id) {
          return {
            result: {
              ok: false,
              error: 'No item in context. Open an item editor (or pass itemId) so I can read its receipts.',
            },
          };
        }
        const receipts = await gatherReceipts({ itemId: id, itemType: type, source: (source as ReceiptSource) || 'all' });
        // Each receipt the agent reasons over becomes a citation so the answer
        // cites the exact receipt that detected the error.
        const citations: Citation[] = [];
        if (receipts.provisioning?.found) {
          const p = receipts.provisioning;
          citations.push({
            id: `receipt:provisioning:${id}`,
            path: `cosmos://items/${id}#state.provisioning`,
            kind: 'receipt',
            heading: 'Provisioning receipt',
            preview: `status=${p.status ?? 'unknown'}${p.gate?.reason ? `; ${p.gate.reason}` : ''}${p.error ? `; ${p.error}` : ''}`.slice(0, 200),
          });
        }
        if (receipts.runs && (receipts.runs.failedRuns?.length || receipts.runs.error || receipts.runs.gate)) {
          const r = receipts.runs;
          const prev = r.gate
            ? `not configured: set ${r.gate.missing}`
            : r.error
              ? `run query error: ${r.error}`
              : `${r.failedRuns?.length || 0} failed run(s)${r.failedActivities?.[0]?.message ? `; ${r.failedActivities[0].message}` : ''}`;
          citations.push({
            id: `receipt:runs:${id}`,
            path: `adf://pipelineRuns/${r.pipelineName ?? id}`,
            kind: 'receipt',
            heading: 'Pipeline run receipt',
            preview: prev.slice(0, 200),
          });
        }
        if (receipts.audit && receipts.audit.length > 0) {
          citations.push({
            id: `receipt:audit:${id}`,
            path: `cosmos://audit-log?itemId=${id}`,
            kind: 'receipt',
            heading: 'Audit log',
            preview: receipts.audit.slice(0, 3).map((a) => `${a.action}: ${a.summary ?? ''}`).join(' | ').slice(0, 200),
          });
        }
        if (citations.length) deps.recordCitations(citations);
        return { result: receipts, citations };
      },
    },
    {
      name: 'proposeFix',
      description: 'Propose an approval-gated edit to an OPEN notebook code cell. Renders a Keep/Undo Monaco diff the USER must approve — the change is NEVER applied automatically and you must not say it is applied. Use ONLY for a notebook code cell (target "notebook-cell:<cellId>"); query/SQL/KQL editors are not yet wired for in-place apply, so for those — and for fixes that need an action (re-provision, re-run, set env var) — explain the fix inline and use the handoff to /copilot instead.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Deterministic editor key: "notebook-cell:<cellId>".' },
          before: { type: 'string', description: 'The current text of the cell/query, verbatim.' },
          after: { type: 'string', description: 'Your corrected text.' },
          lang: { type: 'string', description: 'Language hint (python, sql, kql, scala, r, ...).' },
          summary: { type: 'string', description: 'One-line rationale for the fix.' },
        },
        required: ['target', 'before', 'after'],
        additionalProperties: false,
      },
      handler: async ({ target, before, after, lang, summary }) => {
        const t = String(target || '').trim();
        if (!/^notebook-cell:.+/.test(t)) {
          return {
            result: {
              ok: false,
              error: 'target must be "notebook-cell:<cellId>". Query/SQL/KQL editors are not yet wired for in-place apply — explain the fix inline and hand off to /copilot instead.',
            },
          };
        }
        const rationale = summary ? String(summary) : 'Proposed fix — awaiting your Keep/Undo decision.';
        return {
          result: {
            ok: true,
            message: 'Proposed an edit. Awaiting the user\'s Keep/Undo decision; the change is NOT yet applied.',
            rationale,
            [PROPOSED_CHANGE_KEY]: {
              target: t,
              before: String(before ?? ''),
              after: String(after ?? ''),
              lang: lang ? String(lang) : undefined,
              summary: rationale,
            },
          },
        };
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
          const r = await fetchWithTimeout(`https://api.github.com/repos/${deps.upstreamRepo.owner}/${deps.upstreamRepo.name}/issues`, {
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
    fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(withTemperature ? { ...base, temperature: 0.2 } : base),
    }, LLM_FETCH_TIMEOUT_MS);
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
    receiptScope:
      opts.pageContext?.receiptScope ||
      (opts.pageContext?.itemId
        ? { itemId: opts.pageContext.itemId, itemType: opts.pageContext.itemType }
        : undefined),
  });
  const toolDefs = toolsForAoai(tools);

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  // Screen-awareness: tell the agent where the user is so "what's on this
  // screen / help me here" is answered in context (without the user retyping it).
  const pc = opts.pageContext;
  if (pc && (pc.label || pc.path)) {
    const parts = [`The user is currently on the "${pc.label || pc.path}" screen of CSA Loom (route: ${pc.path || 'unknown'}).`];
    if (pc.itemType) parts.push(`They are viewing a ${pc.itemType} item${pc.itemId ? ` (id: ${pc.itemId})` : ''}.`);
    parts.push('When their question is about "this", "this screen", "here", or "what I\'m looking at", answer for THIS surface first. You can help with anything in Loom regardless of where they are.');
    messages.splice(1, 0, { role: 'system', content: parts.join(' ') });
  }

  // Tutorial-step awareness: inject the active step so the agent diagnoses
  // against THIS step's expected outcome and can read receipts on failure.
  const tut = pc?.tutorial;
  if (tut && tut.id) {
    const total = tut.totalSteps ? `/${tut.totalSteps}` : '';
    const tParts = [
      `The user is on step ${tut.stepIndex + 1}${total} of tutorial "${tut.id}"${tut.stepTitle ? `: "${tut.stepTitle}"` : ''}.`,
    ];
    if (tut.stepBody) tParts.push(`Step instructions: ${tut.stepBody}`);
    tParts.push('Answer for THIS step. If the user reports a failure or a receipt shows status "failed"/"remediation", call readReceipts first, then lead with the detected error and the exact remediation, mapped back to this step.');
    messages.splice(1, 0, { role: 'system', content: tParts.join(' ') });
  }

  await persistTurn(sessionId, userId, 'user', prompt);

  // --- Content-safety INPUT check (every persona): Prompt Shields +
  // harm-category moderation on the user prompt. No-op when Content Safety is
  // not configured (helpers fail open; isSafetyConfigured() false). ---
  if (isSafetyConfigured()) {
    const [shieldResult, inputResult] = await Promise.all([
      shieldPrompt(prompt),
      moderateContent(prompt),
    ]);
    const blocked = shieldResult.blocked ? shieldResult : inputResult.blocked ? inputResult : null;
    if (blocked) {
      yield { kind: 'error', error: blocked.reason, code: 'content_safety_input' };
      return;
    }
  }

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
      // --- Content-safety OUTPUT check: moderate the help answer text. ---
      if (isSafetyConfigured()) {
        const outputResult = await moderateContent(stripped);
        if (outputResult.blocked) {
          yield { kind: 'error', error: outputResult.reason, code: 'content_safety_output' };
          return;
        }
      }
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
        // Peel any approval-gated change off BEFORE serializing — the model
        // must never see internal plumbing, and the diff is gated behind an
        // explicit Keep (never applied server-side).
        const { publicResult, proposed } = extractProposedChange(result);
        const serialized = JSON.stringify(publicResult);
        const truncated = serialized.length > 16_000 ? serialized.slice(0, 16_000) + '...[truncated]' : serialized;
        yield {
          kind: 'tool_result',
          name: tc.function.name,
          callId: tc.id,
          durationMs: Date.now() - started,
          result: publicResult,
        };
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: truncated });
        // Surface the approval-gated diff as its own step so the widget can open
        // the Keep/Undo modal. Nothing mutates server-side.
        if (proposed) {
          yield {
            kind: 'proposed_change',
            target: proposed.target,
            before: proposed.before,
            after: proposed.after,
            lang: proposed.lang,
            summary: proposed.summary,
            callId: tc.id,
          };
        }
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
