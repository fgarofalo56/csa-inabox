/**
 * POST /api/copilot/notebook-assist — the streaming backend for the Notebook
 * Copilot chat pane (the docked drawer in the notebook editor).
 *
 * This is the chat-drawer sibling of /api/notebook/[id]/assist (single-cell,
 * non-streaming). It powers the slash commands /fix /explain /comments
 * /optimize with FULL conversation context:
 *
 *   - current cell + the prior 5 cells (client-assembled, marked CURRENT CELL)
 *   - the lakehouse datastore schema (Delta column names + types), read straight
 *     from each table's `_delta_log/0.json` metaData.schemaString on ADLS Gen2
 *     — Azure-native, NO Fabric / OneLake dependency (per no-fabric-dependency).
 *
 * It STREAMS the Azure OpenAI response back as Server-Sent Events so the pane
 * renders tokens live (the cross-item /api/copilot/orchestrate route uses the
 * same SSE envelope: `event: <name>\ndata: <json>\n\n`).
 *
 *   event: session  { sessionId }
 *   event: chunk    { delta: string }          // forwarded AOAI token(s)
 *   event: done     { sessionId, content }      // full assembled answer
 *   event: error    { error: string }
 *
 * AOAI resolution reuses resolveAoaiTarget (tenant admin pick → env →
 * Foundry-hub discovery). When no chat deployment is wired the route returns a
 * 503 `code:'no_aoai'` honest gate naming the exact env vars / admin action —
 * the pane surfaces it in a Fluent MessageBar and the rest of the notebook stays
 * fully functional (per no-vaporware).
 *
 * Azure-native by default: works with LOOM_DEFAULT_FABRIC_WORKSPACE unset. No
 * Fabric / Power BI host is contacted on any code path here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
  persistStep,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { cogScope, detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import { buildDatastoreSchema } from '@/lib/azure/delta-schema';
import { NOTEBOOK_PERSONA, type PersonaSystemCtx } from '@/lib/azure/copilot-personas-notebook';
import {
  notebookProfileTableTool,
  notebookPerfInsightsTool,
  notebookGenerateCodeTool,
  notebookSummarizeTool,
  notebookRefactorCellsTool,
} from '@/lib/copilot/notebook-persona-tools';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { assistRuntimeDirective } from '@/lib/copilot/notebook-tools';

// The supported slash commands — a FIXED server-validated allowlist (no
// arbitrary free-form command injected into the model prompt). The first four
// are single-cell helpers; the latter five are the context-aware notebook
// persona tools (summarize / generate / profile / perf / refactor).
const COMMANDS = [
  'fix', 'explain', 'comments', 'optimize',
  'summarize', 'generate', 'profile', 'perf', 'refactor',
] as const;
type Command = (typeof COMMANDS)[number];

/** A minimal ToolContext for the read-only notebook tools (no item mutation). */
const TOOL_CTX = { userOid: 'system', session: { claims: { oid: 'system' } } } as const;

// ---------- Credential (ACA-first UAMI chain — shared helper) ----------
const credential = uamiArmCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Prompt construction ----------
const LANG_LABEL: Record<string, string> = {
  pyspark: 'PySpark (Python)',
  spark: 'Spark (Scala)',
  sparksql: 'Spark SQL',
  sparkr: 'SparkR (R)',
  python: 'Python',
  tsql: 'T-SQL',
};

function systemPrompt(command: Command, langName: string, schema: string, runtime?: string): string {
  const schemaSection = schema.trim()
    ? `\n\nLakehouse datastore schema (ground every reference in these REAL column names + types — never invent table or column names):\n${schema}`
    : '';
  const base =
    `You are the CSA Loom Notebook Copilot, an assistant docked beside a notebook. ` +
    `The notebook language is ${langName}.` +
    assistRuntimeDirective(runtime) +
    ` You are given the prior cells (for context) and the CURRENT CELL ` +
    `the user is working on. Reference the user's ACTUAL variable, DataFrame, and column names from the cells ` +
    `and the schema — do not use generic placeholders.`;
  switch (command) {
    case 'fix':
      return (
        base +
        ` The current cell produced an error. Return the corrected cell as a single fenced code block ` +
        `labelled with the language. Then, after the code block, add one short sentence explaining the fix.` +
        schemaSection
      );
    case 'explain':
      return (
        base +
        ` Explain what the CURRENT CELL does in 3-5 concise sentences. Describe the data flow, transformations, ` +
        `and business intent, referencing the actual variable and column names. Plain prose, no code fences.` +
        schemaSection
      );
    case 'comments':
      return (
        base +
        ` Return the CURRENT CELL's source with a clear inline comment added above or beside every non-trivial ` +
        `line, preserving the exact logic and variable names. Return ONLY the commented code as a single fenced ` +
        `code block labelled with the language.` +
        schemaSection
      );
    case 'optimize':
    default:
      return (
        base +
        ` Rewrite the CURRENT CELL for better Spark performance — e.g. avoid Python UDFs in favour of native/` +
        `vectorized functions, broadcast small DataFrames, push down predicates and column pruning, cache reused ` +
        `DataFrames, and prefer DataFrame ops over collect(). Keep the same output and the user's variable names. ` +
        `Return the optimized cell as a single fenced code block labelled with the language, then one short ` +
        `sentence on what you changed and why.` +
        schemaSection
      );
  }
}

function userMessage(command: Command, cells: NotebookCell[], activeCellId: string, errorText: string): string {
  const activeIdx = cells.findIndex((c) => c.id === activeCellId);
  const lines: string[] = [];
  cells.forEach((c, i) => {
    const marker = c.id === activeCellId ? '# CURRENT CELL' : `# prior cell ${i + 1}`;
    const lang = c.type === 'markdown' ? 'markdown' : c.lang || 'pyspark';
    lines.push(`${marker} (${lang}):\n${c.source || '(empty)'}`);
  });
  let msg = lines.join('\n\n---\n\n');
  if (command === 'fix' && errorText.trim()) {
    msg += `\n\n---\n\nError from running the CURRENT CELL:\n${errorText.trim()}`;
  }
  if (activeIdx < 0) {
    msg = `(No cell marked active — treat the LAST cell as the current cell.)\n\n` + msg;
  }
  return msg;
}

/** Per-command instruction for the persona path. */
function personaInstruction(command: Command, freeText: string): string {
  switch (command) {
    case 'summarize':
      return (
        'Summarize this notebook. For EACH cell give one line: what it does, its key inputs/outputs, ' +
        'and how it feeds the next cell — referencing the actual variable and column names. End with a ' +
        '2-3 sentence overall purpose. Plain prose; do not rewrite the code.'
      );
    case 'generate':
      return (
        `Generate runnable code for this request: "${freeText || '(describe the data task)'}". ` +
        'Use the REAL table and column names from the schema in the system prompt and the ' +
        '[TOOL notebook_generate_code] result. Return the code as a single fenced code block; if the ' +
        'task naturally spans multiple cells, return one fenced block per cell in order. Add a one-line ' +
        'explanation after the code.'
      );
    case 'profile':
      return (
        'Using the [TOOL notebook_profile_table] result, present the table profile in a compact, readable ' +
        'form (size, latest version, last modified, row count). If rowCount is null, state that Synapse ' +
        'Serverless was unavailable so the count is omitted — do NOT fabricate a number. Then suggest 1-2 ' +
        'follow-up actions (e.g. OPTIMIZE/VACUUM, partitioning).'
      );
    case 'perf':
      return (
        'Using the [TOOL notebook_perf_insights] result (Livy session sizing + last-run output), give concrete ' +
        'Spark tuning recommendations: executor count & memory, broadcast-join thresholds, partition pruning, ' +
        'caching of reused DataFrames, and skew mitigation. If telemetry is absent, say so and give general ' +
        'tuning guidance grounded in the cells shown.'
      );
    case 'refactor':
    default:
      return (
        `Refactor the code cells per this instruction: "${freeText || 'improve structure, readability, and reuse'}". ` +
        'Return ONE fenced code block per output cell, in the SAME order as the input cells, preserving the ' +
        "user's variable names and the overall behaviour. The user will review and apply the cells via the diff."
      );
  }
}

interface AttachedSourceLite {
  kind: string;
  displayName: string;
  isDefault?: boolean;
}

interface AssistBody {
  sessionId?: string;
  command?: string;
  cells?: NotebookCell[];
  activeCellId?: string;
  lang?: NotebookCellLang;
  errorText?: string;
  /** Cluster runtime (databricks | synapse-spark | azure-ml) for syntax grounding. */
  runtime?: string;
  /** Free-text argument after a slash command (e.g. `/generate <text>`). */
  text?: string;
  // ---- Notebook persona context (real call-time data) ----
  notebookName?: string;
  workspaceId?: string;
  attachedSources?: AttachedSourceLite[];
  /** Livy session-create receipt from the editor (id, numExecutors, …). */
  sessionReceipt?: Record<string, unknown>;
  /** User session sizing (numExecutors, executorMemoryGb, timeoutMinutes). */
  sessionConfig?: Record<string, unknown>;
  /** textPlain of the last cell run — for /perf telemetry. */
  lastOutput?: string;
  /** `/profile <table>` arg + optional container. */
  profileTable?: string;
  profileContainer?: string;
}

/** Persona commands route through copilot-personas.ts + notebook-tools.ts. */
const PERSONA_COMMANDS = new Set<Command>(['summarize', 'generate', 'profile', 'perf', 'refactor']);

/** Compact, multi-line attached-source list for the persona system prompt. */
function formatAttachedSources(sources?: AttachedSourceLite[]): string {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  return sources
    .map((s) => `${s.kind} "${s.displayName}"${s.isDefault ? ' (default)' : ''}`)
    .join('\n');
}

/** Compact last-run telemetry block (Livy receipt + last output) for /perf. */
function formatLastRunTelemetry(receipt?: Record<string, unknown>, lastOutput?: string): string {
  const parts: string[] = [];
  if (receipt && Object.keys(receipt).length) parts.push(`Livy session: ${JSON.stringify(receipt)}`);
  if (lastOutput && lastOutput.trim()) parts.push(`Last cell output:\n${lastOutput.trim().slice(0, 2000)}`);
  return parts.join('\n');
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  let body: AssistBody = {};
  try {
    body = (await req.json()) as AssistBody;
  } catch {
    /* fall through to validation */
  }

  const command = String(body.command || '').toLowerCase() as Command;
  if (!COMMANDS.includes(command)) {
    return NextResponse.json(
      { ok: false, error: `command must be one of: ${COMMANDS.join(', ')}` },
      { status: 400 },
    );
  }
  const cells = Array.isArray(body.cells) ? body.cells.filter((c) => c && typeof c.source === 'string') : [];
  if (cells.length === 0) {
    return NextResponse.json({ ok: false, error: 'cells is required (current cell + prior context)' }, { status: 400 });
  }
  const activeCellId = String(body.activeCellId || cells[cells.length - 1].id);
  const lang = String(body.lang || cells.find((c) => c.id === activeCellId)?.lang || 'pyspark');
  const errorText = String(body.errorText || '');
  const runtimeKind = String(body.runtime || '');
  const sessionId =
    body.sessionId || `nbcopilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';

  // Resolve AOAI — tenant admin pick → env → Foundry discovery.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  let target;
  try {
    target = await resolveAoaiTarget(tenantConfig);
  } catch (e: any) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a chat ' +
          'deployment under Admin → Tenant settings → Copilot & Agents (deploy the AI Foundry ' +
          'project — platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true).';
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  const langName = LANG_LABEL[lang] || lang;
  const schema = await buildDatastoreSchema(
    Number(process.env.LOOM_NOTEBOOK_PERSONA_CONTEXT_MAX_TABLES) || 30,
  ).catch(() => '');

  let messages: { role: 'system' | 'user'; content: string }[];

  if (PERSONA_COMMANDS.has(command)) {
    // ---- Context-aware notebook persona path (summarize/generate/profile/perf/refactor) ----
    const freeText = String(body.text || '').trim();
    const personaCtx: PersonaSystemCtx = {
      notebookName: String(body.notebookName || 'notebook'),
      cellCount: cells.length,
      defaultLang: lang,
      attachedSources: formatAttachedSources(body.attachedSources),
      schema,
      lastRunTelemetry: formatLastRunTelemetry(body.sessionReceipt, body.lastOutput),
      cloud: detectLoomCloud(),
      runtimeDirective: assistRuntimeDirective(runtimeKind),
    };

    // Inject a REAL tool-result block (read-only tools, no AOAI tool-call round-trip).
    let toolSection = '';
    if (command === 'profile') {
      const tableName = String(body.profileTable || freeText || '').trim();
      const result = await notebookProfileTableTool.handler(
        { tableName, container: body.profileContainer },
        TOOL_CTX,
      );
      toolSection = `\n\n[TOOL notebook_profile_table]\n${JSON.stringify(result, null, 2)}`;
    } else if (command === 'perf') {
      const result = await notebookPerfInsightsTool.handler(
        { sessionReceipt: body.sessionReceipt, lastOutput: body.lastOutput, sessionConfig: body.sessionConfig },
        TOOL_CTX,
      );
      toolSection = `\n\n[TOOL notebook_perf_insights]\n${JSON.stringify(result, null, 2)}`;
    } else if (command === 'generate') {
      const result = await notebookGenerateCodeTool.handler(
        { description: freeText, lang },
        TOOL_CTX,
      );
      toolSection = `\n\n[TOOL notebook_generate_code]\n${JSON.stringify(result, null, 2)}`;
    } else if (command === 'summarize') {
      const result = await notebookSummarizeTool.handler({ cells }, TOOL_CTX);
      toolSection = `\n\n[TOOL notebook_summarize]\n${JSON.stringify(result, null, 2)}`;
    } else if (command === 'refactor') {
      const result = await notebookRefactorCellsTool.handler(
        { cells: cells.filter((c) => c.type === 'code'), instruction: freeText },
        TOOL_CTX,
      );
      toolSection = `\n\n[TOOL notebook_refactor_cells]\n${JSON.stringify(result, null, 2)}`;
    }

    const instruction = personaInstruction(command, freeText);
    const userContent =
      `${instruction}\n\n` +
      `Notebook cells (in order):\n${userMessage('explain', cells, activeCellId, '')}` +
      toolSection;

    messages = [
      { role: 'system', content: NOTEBOOK_PERSONA.systemPrompt(personaCtx) },
      { role: 'user', content: userContent },
    ];
  } else {
    // ---- Single-cell helper path (fix/explain/comments/optimize) ----
    messages = [
      { role: 'system', content: systemPrompt(command, langName, schema, runtimeKind) },
      { role: 'user', content: userMessage(command, cells, activeCellId, errorText) },
    ];
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });

      // Persist the user's turn into the SAME copilot-sessions store, so it
      // shows up in GET /api/copilot/sessions like every other Copilot chat.
      const userPrompt = `/${command} on cell ${activeCellId.slice(0, 8)}`;
      await persistStep(sessionId, userOid, { kind: 'thought', content: userPrompt }, userPrompt);

      let full = '';
      try {
        const token = await aoaiToken();
        const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(
          target.deployment,
        )}/chat/completions?api-version=${target.apiVersion}`;

        const callWithTemperature = (temp?: number) =>
          fetch(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              messages,
              stream: true,
              ...(temp !== undefined ? { temperature: temp } : {}),
              max_completion_tokens: 4096,
            }),
          });

        let res = await callWithTemperature(0.2);
        if (res.status === 400) {
          const txt = await res.text();
          // Reasoning models (o1/o3/gpt-5/MAI-*) reject non-default temperature — retry once.
          if (/unsupported_value|does not support|Only the default \(1\) value is supported/i.test(txt) &&
              /temperature|top_p/i.test(txt)) {
            res = await callWithTemperature(undefined);
          } else {
            send('error', { error: `AOAI 400: ${txt.slice(0, 300)}` });
            send('done', { sessionId, content: '' });
            controller.close();
            return;
          }
        }
        if (!res.ok || !res.body) {
          const txt = res.ok ? 'no response body' : await res.text();
          send('error', { error: `AOAI ${res.status}: ${txt.slice(0, 300)}` });
          send('done', { sessionId, content: '' });
          controller.close();
          return;
        }

        // Forward the AOAI SSE stream: parse `data: {...}` lines, pull
        // choices[0].delta.content, re-emit as our `chunk` events.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const j = JSON.parse(payload);
              const delta: string = j?.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                full += delta;
                send('chunk', { delta });
              }
            } catch {
              /* partial JSON across chunk boundary — ignore, next read completes it */
            }
          }
        }

        await persistStep(sessionId, userOid, { kind: 'final', content: full });
        send('done', { sessionId, content: full });
      } catch (e: any) {
        send('error', { error: e?.message || String(e) });
        send('done', { sessionId, content: full });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
