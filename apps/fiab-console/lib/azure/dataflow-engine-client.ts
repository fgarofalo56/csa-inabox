/**
 * dataflow-engine-client — server-side engine behind the Dataflow Gen2 Copilot.
 *
 * Turns natural-language asks into REAL Power Query (M) using Azure OpenAI, then
 * VALIDATES every result structurally with the same balanced-delimiter M parser
 * that backs the Applied Steps pane (`m-script.ts`). There is no separate M
 * interpreter and no fabricated step list: a generated step only becomes an
 * Applied Step after it parses cleanly here and the user approves the diff in
 * the editor.
 *
 * Azure-native by default (per no-fabric-dependency): the only external call is
 * to the tenant's Azure OpenAI chat deployment, acquired via the Console's
 * managed identity over the cloud-correct cognitive-services scope. No Fabric /
 * Power BI / OneLake host is contacted on any path here. "Validate + preview"
 * means: AOAI emits M → `parseLetBody` confirms it is a well-formed step → the
 * editor appends it to the real Applied Steps list → live data preview comes
 * from a real ADF WranglingDataFlow run (Save & Run), exactly like a ribbon step.
 */

import { cogScope } from './cloud-endpoints';
import type { AoaiTarget } from './copilot-orchestrator';
import { DATAFLOW_COPILOT_PERSONA } from './copilot-personas-dataflow';
import {
  parseSharedQueries,
  parseLetBody,
  buildLetBody,
  setQueryBody,
  appendStep,
} from '@/lib/components/pipeline/dataflow/m-script';

// Re-export the M helpers so callers can import the whole dataflow-engine
// surface from one module.
export {
  parseSharedQueries,
  parseLetBody,
  buildLetBody,
  setQueryBody,
  appendStep,
};

/** Thrown when AOAI output is unusable; carries a user-facing remediation. */
export class DataflowCopilotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataflowCopilotError';
  }
}

export interface GeneratedTransformStep {
  /** Applied-step name, e.g. "Filtered Rows". */
  stepName: string;
  /** A single M expression referencing the prior step name. */
  stepExpr: string;
}

export interface GeneratedQuery {
  /** New query (declaration) name, de-duplicated against existing names. */
  queryName: string;
  /** Complete `let … in …` body suitable for setQueryBody(). */
  mBody: string;
}

export interface ValidationResult {
  ok: boolean;
  queries: Array<{ name: string; stepCount: number }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Structural validation — pure, no network. Shared with the editor.
// ---------------------------------------------------------------------------

/**
 * Structurally validate an M section (or a single query body) using the same
 * parser the Applied Steps pane uses. No ADF call, no AOAI — just confirms the
 * mashup parses into named queries + steps. Usable from both server and client.
 */
export function validateMScript(m: string): ValidationResult {
  const text = (m || '').trim();
  if (!text) return { ok: false, queries: [], error: 'Empty M script.' };
  try {
    let queries = parseSharedQueries(text);
    // A bare `let … in …` body (no `shared`/`section`) is a single query.
    if (queries.length === 0 && /\blet\b[\s\S]*\bin\b/.test(text)) {
      queries = [{ name: 'Query1', body: text }];
    }
    if (queries.length === 0) {
      return { ok: false, queries: [], error: 'No Power Query declarations found.' };
    }
    const out = queries.map((q) => {
      const { steps } = parseLetBody(q.body);
      return { name: q.name, stepCount: steps.length };
    });
    if (out.some((q) => q.stepCount === 0)) {
      return { ok: false, queries: out, error: 'A query has no applied steps.' };
    }
    return { ok: true, queries: out };
  } catch (e: any) {
    return { ok: false, queries: [], error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// AOAI plumbing — managed-identity bearer + temperature-retry chat completion.
// ---------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;

// Lazily constructed so importing this module (for the pure M helpers / tool
// registry) does not eagerly load @azure/identity — only an actual AOAI call
// pays that cost. Cached after first build.
let _credential: { getToken: (scope: string) => Promise<{ token: string } | null> } | null = null;
async function getCredential() {
  if (_credential) return _credential;
  const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import('@azure/identity');
  _credential = uamiClientId
    ? new ChainedTokenCredential(
        new ManagedIdentityCredential({ clientId: uamiClientId }),
        new DefaultAzureCredential(),
      )
    : new DefaultAzureCredential();
  return _credential;
}

async function aoaiToken(): Promise<string> {
  const credential = await getCredential();
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new DataflowCopilotError('Failed to acquire an Azure OpenAI access token.');
  return t.token;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Non-streaming chat completion. First call sends temperature for determinism;
 * if the model rejects sampling params (reasoning models), retry once without.
 * Returns the assistant message content string.
 */
async function chat(target: AoaiTarget, messages: ChatMessage[], jsonObject: boolean): Promise<string> {
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(
    target.deployment,
  )}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const base: Record<string, unknown> = { messages, max_tokens: 2048 };
  if (jsonObject) base.response_format = { type: 'json_object' };

  const send = (withTemperature: boolean, withJson: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...base,
        ...(withJson ? {} : { response_format: undefined }),
        ...(withTemperature ? { temperature: 0.1 } : {}),
      }),
    });

  let res = await send(true, jsonObject);
  if (res.status === 400) {
    const txt = await res.text();
    // Reasoning models reject non-default temperature and/or response_format.
    if (/temperature|top_p|sampling|response_format|json_object/i.test(txt)) {
      res = await send(false, false);
    } else {
      throw new DataflowCopilotError(`Azure OpenAI rejected the request (400): ${txt.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new DataflowCopilotError(`Azure OpenAI call failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  const j: any = await res.json();
  const content: string = j?.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) throw new DataflowCopilotError('Azure OpenAI returned an empty response.');
  return content;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sys(): ChatMessage {
  return { role: 'system', content: DATAFLOW_COPILOT_PERSONA.systemPrompt };
}

/** Extract the first balanced {...} JSON object from a model response. */
function extractJsonObject(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace scan */
  }
  const start = trimmed.indexOf('{');
  if (start < 0) throw new DataflowCopilotError('Model did not return a JSON object.');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inStr) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch (e: any) {
          throw new DataflowCopilotError(`Model JSON was malformed: ${e?.message || e}`);
        }
      }
    }
  }
  throw new DataflowCopilotError('Model JSON object was not terminated.');
}

/** Strip an accidental `shared Name =` / trailing `;` wrapper from a body. */
function unwrapBody(raw: string): string {
  let body = String(raw || '').trim();
  body = body.replace(/^```(?:m|pq|powerquery)?\s*/i, '').replace(/```\s*$/, '').trim();
  const shared = body.match(/^shared\s+#?"?[^=]+"?\s*=\s*([\s\S]*?);?\s*$/i);
  if (shared) body = shared[1].trim();
  return body.replace(/;\s*$/, '').trim();
}

/** Ensure a generated query name does not collide with existing ones. */
function dedupeName(name: string, existing: string[]): string {
  const taken = new Set(existing);
  let candidate = (name || 'Query').trim() || 'Query';
  let n = 1;
  while (taken.has(candidate)) { n += 1; candidate = `${name} ${n}`; }
  return candidate;
}

// ---------------------------------------------------------------------------
// The five capabilities.
// ---------------------------------------------------------------------------

/** Generate a new Power Query (M) query from a natural-language description. */
export async function generateQueryFromNL(
  userPrompt: string,
  existingQueryNames: string[],
  target: AoaiTarget,
): Promise<GeneratedQuery> {
  const content = await chat(
    target,
    [
      sys(),
      {
        role: 'user',
        content:
          `Create a new Power Query from this request: "${userPrompt}".\n` +
          (existingQueryNames.length
            ? `Existing query names (avoid duplicates): ${existingQueryNames.join(', ')}.\n`
            : '') +
          `If the request implies static/sample rows, build them with an M #table(...) literal in the Source step.\n` +
          `Respond ONLY as JSON: {"queryName": string, "mBody": "let ... in ..."}. ` +
          `mBody MUST be a complete let..in block with at least one named step.`,
      },
    ],
    true,
  );
  const j = extractJsonObject(content);
  const mBody = unwrapBody(j.mBody || j.body || '');
  const v = validateMScript(mBody);
  if (!v.ok) {
    throw new DataflowCopilotError(`Generated query did not parse as valid M: ${v.error}`);
  }
  return { queryName: dedupeName(String(j.queryName || 'Query'), existingQueryNames), mBody };
}

/** Generate a new query that references (reads from) an existing query. */
export async function generateReferenceQuery(
  userPrompt: string,
  sourceQueryName: string,
  sourceBody: string,
  existingQueryNames: string[],
  target: AoaiTarget,
): Promise<GeneratedQuery> {
  if (!sourceQueryName) throw new DataflowCopilotError('A source query is required to generate a reference query.');
  const cols = sourceBody ? `\nThe source query's M is:\n${sourceBody.slice(0, 1500)}` : '';
  const content = await chat(
    target,
    [
      sys(),
      {
        role: 'user',
        content:
          `Create a new Power Query that REFERENCES the existing query named "${sourceQueryName}" ` +
          `and then: "${userPrompt}".${cols}\n` +
          `The new query's first step MUST be: Source = ${sourceQueryName}. Chain further steps off Source.\n` +
          (existingQueryNames.length
            ? `Existing query names (avoid duplicates): ${existingQueryNames.join(', ')}.\n`
            : '') +
          `Respond ONLY as JSON: {"queryName": string, "mBody": "let Source = ${sourceQueryName}, ... in ..."}.`,
      },
    ],
    true,
  );
  const j = extractJsonObject(content);
  const mBody = unwrapBody(j.mBody || j.body || '');
  const v = validateMScript(mBody);
  if (!v.ok) throw new DataflowCopilotError(`Generated reference query did not parse as valid M: ${v.error}`);
  // Confirm it actually references the source query.
  const esc = sourceQueryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(=\\s*|\\b)#?"?${esc}"?\\b`).test(mBody)) {
    throw new DataflowCopilotError(
      `Generated query does not reference "${sourceQueryName}". Try rephrasing the request.`,
    );
  }
  return { queryName: dedupeName(String(j.queryName || `${sourceQueryName} ref`), existingQueryNames), mBody };
}

/** Explain the active query and its applied steps in plain English. */
export async function explainQuery(
  queryName: string,
  body: string,
  target: AoaiTarget,
): Promise<string> {
  const { steps } = parseLetBody(body || '');
  if (steps.length === 0) {
    throw new DataflowCopilotError('This query has no applied steps to explain.');
  }
  const stepList = steps.map((st, i) => `${i + 1}. ${st.name} = ${st.expr}`).join('\n');
  const content = await chat(
    target,
    [
      sys(),
      {
        role: 'user',
        content:
          `Explain the query "${queryName}" and each of its applied steps in plain English. ` +
          `Write one short sentence per step, in order, referencing the real step names and what each does. ` +
          `No code fences.\n\nApplied steps:\n${stepList}`,
      },
    ],
    false,
  );
  return content.trim();
}

/** Generate a single new transformation step to append to the active query. */
export async function generateTransformStep(
  userPrompt: string,
  activeQueryName: string,
  currentBody: string,
  target: AoaiTarget,
): Promise<GeneratedTransformStep> {
  const { steps } = parseLetBody(currentBody || '');
  const prevStep = steps.length ? steps[steps.length - 1].name : 'Source';
  const stepNames = steps.map((s) => s.name).join(', ') || '(none)';
  const content = await chat(
    target,
    [
      sys(),
      {
        role: 'user',
        content:
          `Add ONE transformation step to the active query "${activeQueryName}" for this request: "${userPrompt}".\n` +
          `The new step must reference the previous step by its exact name: ${prevStep}.\n` +
          `Existing step names: ${stepNames}.\n` +
          `Current query M (for column context):\n${(currentBody || '').slice(0, 1800)}\n\n` +
          `Respond ONLY as JSON: {"stepName": string, "stepExpr": "M expression referencing ${prevStep}"}.`,
      },
    ],
    true,
  );
  const j = extractJsonObject(content);
  const stepName = String(j.stepName || '').trim();
  let stepExpr = unwrapBody(String(j.stepExpr || j.expr || ''));
  if (!stepName || !stepExpr) {
    throw new DataflowCopilotError('Model did not return a stepName and stepExpr.');
  }
  // Validate by appending the step and re-parsing the whole body.
  const candidateBody = appendStep(currentBody || `let\n    Source = ${prevStep}\nin\n    ${prevStep}`, {
    key: 'copilot', label: stepName, tab: 'transform', stepName, expr: () => stepExpr,
  });
  const v = validateMScript(candidateBody);
  if (!v.ok) {
    throw new DataflowCopilotError(`Generated step did not parse as valid M: ${v.error}`);
  }
  return { stepName, stepExpr };
}
