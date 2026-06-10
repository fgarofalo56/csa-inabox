/**
 * Shared AI auto-description helpers for the Loom-native tabular layer.
 *
 * Two consumers use this module:
 *   1. The DAX Copilot tools (lib/copilot/dax-tools.ts) — the conversational
 *      `dax_describe_model` / `dax_save_descriptions` tools.
 *   2. The Model-view catalog action (the "Generate descriptions" button in
 *      ModelViewPanel, served by the warehouse / synapse / databricks `…/model`
 *      BFF routes via `?kind=describe-all`).
 *
 * Both call the SAME real Azure OpenAI backend (no mocks, no return []), so the
 * per-measure Copilot experience and the bulk catalog action are byte-for-byte
 * consistent. Every call uses the orchestrator's cloud-aware AOAI target
 * resolver (env LOOM_AOAI_ENDPOINT/DEPLOYMENT → tenant config → Foundry
 * discovery) and the cloud-portable cognitive-services token scope — ZERO
 * Power BI / Fabric REST calls (no-fabric-dependency.md).
 *
 * The pure JSON-parsing helpers (parseDescribeJson) are dependency-free so the
 * proposal-extraction logic is unit-testable without Azure SDK / network.
 *
 * Env deps (all existing — no new infra, no new env var):
 *   LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT — AOAI chat target
 *   LOOM_UAMI_CLIENT_ID — Console UAMI client id (token via ManagedIdentity)
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

import { cogScope } from '@/lib/azure/cloud-endpoints';
import type { AoaiTarget } from '@/lib/azure/copilot-orchestrator';

// ---------- AOAI credential (mirrors copilot-orchestrator.ts / dax-tools.ts) ----------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire an Azure OpenAI token for AI descriptions.');
  return t.token;
}

/**
 * Resolve the AOAI chat target for a caller. Loads the tenant's admin-selected
 * Copilot config (account + deployment) and feeds it to the orchestrator's
 * resolver, which falls back to env / Foundry discovery. Dynamic import breaks
 * the static cycle with copilot-orchestrator.
 */
async function getAoaiTarget(userOid: string): Promise<AoaiTarget> {
  const [{ resolveAoaiTarget }, { loadTenantCopilotConfig }] = await Promise.all([
    import('@/lib/azure/copilot-orchestrator'),
    import('@/lib/azure/copilot-config-store'),
  ]);
  const cfg = await loadTenantCopilotConfig(userOid).catch(() => null);
  return resolveAoaiTarget(cfg);
}

/** One-shot AOAI chat completion (no tools). Cloud-portable via getAoaiTarget. */
export async function aoaiChat(
  userOid: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number; jsonObject?: boolean } = {},
): Promise<string> {
  const target = await getAoaiTarget(userOid);
  const token = await aoaiToken();
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const payload: Record<string, unknown> = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: opts.maxTokens ?? 400,
  };
  if (opts.temperature !== undefined) payload.temperature = opts.temperature;
  if (opts.jsonObject) payload.response_format = { type: 'json_object' };

  const send = (body: Record<string, unknown>) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });

  let res = await send(payload);
  // Newer reasoning models reject non-default temperature — retry without it.
  if (res.status === 400 && opts.temperature !== undefined) {
    const t = await res.text();
    if (/temperature|top_p|unsupported_value|does not support/i.test(t)) {
      const { temperature, ...rest } = payload;
      res = await send(rest);
    } else {
      throw new Error(`AOAI chat failed 400: ${t.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI chat failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const body = await res.json();
  return String(body?.choices?.[0]?.message?.content ?? '').trim();
}

// ---------- pure parsing (dependency-free, unit-tested) ----------

export interface DescribeProposal {
  /** The measure or table identity the description applies to. */
  name: string;
  description: string;
}

/**
 * Parse an AOAI JSON response into a clean list of { name, description }
 * proposals. Tolerant of the model wrapping the array under `measures`,
 * `tables`, or `items`, of a bare array, and of stray code fences. Never throws
 * — returns [] on malformed output so the caller surfaces an honest note rather
 * than a 500.
 */
export function parseDescribeJson(raw: string): DescribeProposal[] {
  if (!raw) return [];
  let text = raw.trim();
  // Strip a leading/trailing code fence the model sometimes adds despite the
  // response_format request.
  text = text.replace(/^```[a-zA-Z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : ((parsed as any)?.measures ?? (parsed as any)?.tables ?? (parsed as any)?.items ?? []);
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: DescribeProposal[] = [];
  for (const p of arr) {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    const description = typeof p?.description === 'string' ? p.description.trim() : '';
    if (!name || !description) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description });
  }
  return out;
}

// ---------- describe orchestration (real AOAI backend) ----------

export interface DescribeMeasureInput {
  name: string;
  expression?: string;
  /** Existing description, so the prompt can skip / improve as appropriate. */
  description?: string;
}

export interface DescribeTableInput {
  /** The table identity used as the proposal key (e.g. `schema.table`). */
  id: string;
  name: string;
  columns?: Array<{ name: string; type?: string }>;
  description?: string;
}

const MEASURE_SYSTEM =
  'You are a data catalog writer. For each DAX/SQL measure listed, write a concise (1-2 sentence) ' +
  'business-friendly description of what the measure represents and when an analyst would use it. ' +
  'Do not restate the formula verbatim. Respond with a JSON object {"measures":[{"name":"...","description":"..."}]} ' +
  'only — no prose, no code fence. Use the EXACT measure name as the "name".';

const TABLE_SYSTEM =
  'You are a data catalog writer. For each table listed (with its columns), write a concise (1-2 sentence) ' +
  'business-friendly description of what the table contains and its grain. ' +
  'Respond with a JSON object {"tables":[{"name":"...","description":"..."}]} only — no prose, no code fence. ' +
  'Use the EXACT table identity given in brackets as the "name".';

/**
 * Generate proposed descriptions for a set of measures via the real AOAI
 * backend. Returns [] for an empty input (no AOAI call). Throws only on a real
 * AOAI / auth failure so the caller can surface a precise error.
 */
export async function proposeMeasureDescriptions(
  measures: DescribeMeasureInput[],
  userOid: string,
): Promise<DescribeProposal[]> {
  if (!measures.length) return [];
  const list = measures
    .map((m, i) => `${i + 1}. [${m.name}] = ${(m.expression || '').replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');
  const raw = await aoaiChat(userOid, MEASURE_SYSTEM, `Write descriptions for these measures:\n${list}`, {
    maxTokens: Math.min(2000, 120 + measures.length * 60),
    temperature: 0.3,
    jsonObject: true,
  });
  return parseDescribeJson(raw);
}

/**
 * Generate proposed descriptions for a set of tables via the real AOAI backend.
 * The proposal `name` is the table id (so the caller can match unambiguously).
 */
export async function proposeTableDescriptions(
  tables: DescribeTableInput[],
  userOid: string,
): Promise<DescribeProposal[]> {
  if (!tables.length) return [];
  const list = tables
    .map((t, i) => {
      const cols = (t.columns || [])
        .slice(0, 24)
        .map((c) => (c.type ? `${c.name}:${c.type}` : c.name))
        .join(', ');
      return `${i + 1}. [${t.id}] (${t.name}) columns: ${cols || '(unknown)'}`;
    })
    .join('\n');
  const raw = await aoaiChat(userOid, TABLE_SYSTEM, `Write descriptions for these tables:\n${list}`, {
    maxTokens: Math.min(2000, 120 + tables.length * 70),
    temperature: 0.3,
    jsonObject: true,
  });
  return parseDescribeJson(raw);
}
