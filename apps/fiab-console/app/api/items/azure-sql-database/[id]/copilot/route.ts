/**
 * POST /api/items/azure-sql-database/[id]/copilot — SQL editor Copilot.
 *
 * The streaming backend for the SQL editor's Copilot side pane + the Fix /
 * Explain ribbon quick-actions and the NL-comment → T-SQL flow. It is the SQL
 * sibling of /api/copilot/notebook-assist (Spark notebooks) and reuses the
 * SAME Azure OpenAI chat deployment the rest of the Copilot uses — NO Fabric,
 * NO Power BI, NO capacity dependency (per no-fabric-dependency.md). Inline
 * ghost text is handled separately by /api/copilot/complete (lang:'tsql').
 *
 * Three server-validated commands (a FIXED allowlist — no free-form command is
 * injected into the model prompt):
 *   - explain : annotate the snippet with inline `--` comments (business intent)
 *   - fix     : diagnose + return corrected T-SQL so the query runs
 *   - nl2sql  : convert a natural-language prompt into T-SQL using the schema
 *
 * The prompt is grounded in the database's REAL schema: the route reads
 * INFORMATION_SCHEMA.COLUMNS over the live TDS path (executeQuery) so the model
 * references actual table/column names rather than inventing them. The selected
 * text (or the full editor buffer) is the working snippet.
 *
 * AOAI resolution:
 *   1. LOOM_AZURE_OPENAI_ENDPOINT (+ LOOM_AOAI_DEPLOYMENT) — the SQL-Copilot
 *      env var. A bare account name is expanded to the per-cloud host via
 *      getOpenAiSuffix() (openai.azure.com vs openai.azure.us); a full URL is
 *      used verbatim.
 *   2. resolveAoaiTarget() — tenant admin pick → LOOM_AOAI_ENDPOINT env →
 *      Foundry-hub discovery (the path the AI Foundry project wires).
 * When neither resolves, the route returns a 503 `code:'no_aoai'` honest gate
 * naming the exact env var + the Cognitive Services OpenAI User role; the rest
 * of the SQL editor stays fully functional (per no-vaporware.md).
 *
 * Azure-native by default: works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { cogScope, getOpenAiSuffix } from '@/lib/azure/cloud-endpoints';
import { executeQuery } from '@/lib/azure/azure-sql-client';

// ---------- Command allowlist ----------
const COMMANDS = ['fix', 'explain', 'nl2sql'] as const;
type Command = (typeof COMMANDS)[number];

// ---------- Credential (identical pattern to copilot-orchestrator) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Endpoint resolution ----------
// LOOM_AZURE_OPENAI_ENDPOINT may be a full URL
// (https://<account>.openai.azure.com / .azure.us) OR a bare account name. A
// bare name is expanded to the correct sovereign host via getOpenAiSuffix() so
// Gov deployments hit *.openai.azure.us without a separate env var.
function normalizeAoaiEndpoint(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}.${getOpenAiSuffix()}`;
}

const GATE_HINT =
  'Set LOOM_AZURE_OPENAI_ENDPOINT to the Azure OpenAI account endpoint ' +
  '(https://<account>.openai.azure.com for Commercial/GCC, or ' +
  'https://<account>.openai.azure.us for GCC-High/IL5) and a chat model ' +
  'deployment name in LOOM_AOAI_DEPLOYMENT, then grant the console UAMI ' +
  '"Cognitive Services OpenAI User" (roleDefinitionId ' +
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd) on that account. Or deploy the AI ' +
  'Foundry project (agentFoundryEnabled=true in platform/fiab/bicep) which ' +
  'provisions the account, deployment, and role assignment automatically.';

interface ResolvedTarget {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

async function resolveTarget(tenantOid: string): Promise<ResolvedTarget> {
  const apiVersion = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
  const rawEndpoint = process.env.LOOM_AZURE_OPENAI_ENDPOINT || '';
  const deployment = process.env.LOOM_AOAI_DEPLOYMENT || '';
  const endpoint = normalizeAoaiEndpoint(rawEndpoint);
  if (endpoint && deployment) {
    return { endpoint, deployment, apiVersion };
  }
  // Fall back to the shared resolver (tenant admin pick → LOOM_AOAI_ENDPOINT →
  // Foundry discovery). Throws NoAoaiDeploymentError when nothing is wired.
  const cfg = await loadTenantCopilotConfig(tenantOid).catch(() => null);
  const t = await resolveAoaiTarget(cfg);
  return { endpoint: t.endpoint, deployment: t.deployment, apiVersion: t.apiVersion };
}

// ---------- Schema catalog (server-side, capped, soft-fail) ----------
async function loadSchemaCatalog(server: string, database: string): Promise<string> {
  if (!server || !database) return '';
  try {
    const res = await executeQuery(
      server,
      database,
      `SELECT TOP 200 TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    );
    return res.rows
      .map((r) => `${r[0]}.${r[1]}.${r[2]} (${r[3]})`)
      .join('\n');
  } catch {
    // Permission / connectivity issue reading the catalog — proceed without it
    // rather than failing the Copilot turn. The model is told the schema may be
    // partial.
    return '';
  }
}

// ---------- Prompt construction ----------
function systemPrompt(command: Command, schemaCatalog: string): string {
  const schemaSection = schemaCatalog.trim()
    ? `\n\nDatabase schema (use ONLY these real table/column names — never invent any):\n${schemaCatalog}`
    : '\n\n(The database schema could not be read; do not invent table or column names — keep the query structure the user provided.)';
  const base =
    'You are the CSA Loom SQL Copilot, an assistant docked beside an Azure SQL Database T-SQL editor. ' +
    'You only ever work in Transact-SQL (T-SQL) for Azure SQL.';
  switch (command) {
    case 'explain':
      return (
        base +
        ' Given the T-SQL snippet, return the SAME query annotated with a concise inline `--` comment ' +
        'on the line above each non-trivial clause/statement explaining its business intent. Preserve the ' +
        'original SQL exactly — only add comments. Return ONLY the annotated SQL inside a single fenced ' +
        '```sql code block, no prose before or after.' +
        schemaSection
      );
    case 'fix':
      return (
        base +
        ' The T-SQL snippet below contains one or more errors (syntax, wrong object/column names, bad joins, ' +
        'type mismatches). Diagnose them and return a corrected, runnable version inside a single fenced ' +
        '```sql code block. After the code block, add one short sentence per change explaining what you fixed.' +
        schemaSection
      );
    case 'nl2sql':
    default:
      return (
        base +
        ' Convert the natural-language request below into a valid, runnable T-SQL query grounded in the ' +
        'schema. Return ONLY the T-SQL inside a single fenced ```sql code block with no explanation.' +
        schemaSection
      );
  }
}

interface CopilotBody {
  sessionId?: string;
  server?: string;
  database?: string;
  command?: string;
  sql?: string;
  selection?: string;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  await params; // id is part of the route contract; state comes from the body

  let body: CopilotBody = {};
  try {
    body = (await req.json()) as CopilotBody;
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
  const server = String(body.server || '').trim();
  const database = String(body.database || '').trim();
  const selection = String(body.selection || '').trim();
  const sql = String(body.sql || '').trim();
  // The working snippet: explicit selection wins, else the full editor buffer
  // (nl2sql carries the NL prompt in `sql`).
  const snippet = command === 'nl2sql' ? sql : (selection || sql);
  if (!snippet) {
    return NextResponse.json(
      { ok: false, error: command === 'nl2sql' ? 'a natural-language prompt is required' : 'sql is required' },
      { status: 400 },
    );
  }
  if (snippet.length > 65_536) {
    return NextResponse.json({ ok: false, error: 'input too large (>64KB)' }, { status: 413 });
  }

  const sessionId =
    body.sessionId || `sqlcopilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Resolve AOAI — honest gate when nothing is wired.
  let target: ResolvedTarget;
  try {
    target = await resolveTarget(session.claims.oid);
  } catch (e: any) {
    const hint = e instanceof NoAoaiDeploymentError ? `${GATE_HINT} (${e.message})` : GATE_HINT;
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: 'Azure OpenAI is not configured for the SQL Copilot.', hint },
      { status: 503 },
    );
  }

  // Read the live schema catalog for grounding (soft-fail to empty).
  const schemaCatalog = await loadSchemaCatalog(server, database);
  const messages = [
    { role: 'system' as const, content: systemPrompt(command, schemaCatalog) },
    {
      role: 'user' as const,
      content:
        command === 'nl2sql'
          ? `Natural-language request:\n${snippet}`
          : `T-SQL snippet:\n${snippet}`,
    },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send('session', { sessionId });

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
              max_tokens: 4096,
            }),
          });

        let res = await callWithTemperature(0.2);
        if (res.status === 400) {
          const txt = await res.text();
          // Reasoning models (o1/o3/gpt-5/MAI-*) reject non-default temperature.
          if (
            /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(txt) &&
            /temperature|top_p/i.test(txt)
          ) {
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
              /* partial JSON across a chunk boundary — next read completes it */
            }
          }
        }

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
