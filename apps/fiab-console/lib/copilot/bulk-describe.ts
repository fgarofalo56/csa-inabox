/**
 * Bulk AI auto-description — shared AOAI batch helpers for generating
 * business-friendly descriptions for the objects of a Loom-native semantic
 * model (measures AND table columns), used by:
 *
 *   • the DAX Copilot `dax_describe_model` tool (lib/copilot/dax-tools.ts), and
 *   • the OneLake catalog bulk action route
 *     (app/api/catalog/describe/route.ts).
 *
 * ONE source of truth for the AOAI plumbing so both surfaces stay in lockstep.
 *
 * Azure-native by default (no Microsoft Fabric / Power BI dependency — see
 * .claude/rules/no-fabric-dependency.md). The model metadata lives on the
 * existing Cosmos `items` container; the descriptions are produced by Azure
 * OpenAI (resolved cloud-aware through the orchestrator's resolveAoaiTarget())
 * and persisted Azure-native. The functions here NEVER call
 * api.fabric.microsoft.com / api.powerbi.com.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential, Default) → cogScope()
 * (cloud-aware: cognitiveservices.azure.us in Gov). The AOAI data-plane target
 * is resolved through resolveAoaiTarget() (env LOOM_AOAI_ENDPOINT/DEPLOYMENT →
 * tenant config → Foundry discovery). Imported dynamically to avoid a static
 * import cycle with copilot-orchestrator.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

import { cogScope } from '@/lib/azure/cloud-endpoints';
import { parseDescribeReply, type DescribeProposal } from '@/lib/copilot/describe-parse';

// ── Public shapes ───────────────────────────────────────────────────────────

export { parseDescribeReply };
export type { DescribeProposal };

export interface MeasureInput {
  name: string;
  expression?: string;
}

export interface ColumnInput {
  table: string;
  name: string;
  dataType?: string;
}

/** Honest infra-gate raised when no Azure OpenAI target can be resolved. */
export class AoaiNotConfiguredError extends Error {
  readonly missing = 'LOOM_AOAI_ENDPOINT';
  readonly detail =
    'Bulk AI descriptions require an Azure OpenAI chat deployment. Set ' +
    'LOOM_AOAI_ENDPOINT (the AOAI account endpoint) and LOOM_AOAI_DEPLOYMENT ' +
    '(a gpt-4o / gpt-4.1 chat deployment) on the Console container app — or ' +
    'select a Copilot account + deployment in Admin → Copilot. The Console ' +
    'UAMI needs the "Cognitive Services OpenAI User" role on the account. No ' +
    'Microsoft Fabric / Power BI workspace is required.';
  constructor(message?: string) {
    super(message || 'Azure OpenAI is not configured for bulk descriptions.');
    this.name = 'AoaiNotConfiguredError';
  }
}

// ── AOAI credential + chat ──────────────────────────────────────────────────

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire an Azure OpenAI token for bulk descriptions.');
  return t.token;
}

interface ResolvedTarget {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

/**
 * Resolve the AOAI chat target for a caller. Loads the tenant's admin-selected
 * Copilot config and feeds it to the orchestrator's resolver, which falls back
 * to env / Foundry discovery. Throws {@link AoaiNotConfiguredError} when nothing
 * resolves so callers can render an honest gate (never a fake success).
 * Dynamic import breaks the static cycle with copilot-orchestrator.
 */
export async function resolveBulkDescribeTarget(userOid: string): Promise<ResolvedTarget> {
  const [{ resolveAoaiTarget }, { loadTenantCopilotConfig }] = await Promise.all([
    import('@/lib/azure/copilot-orchestrator'),
    import('@/lib/azure/copilot-config-store'),
  ]);
  const cfg = await loadTenantCopilotConfig(userOid).catch(() => null);
  const target = await resolveAoaiTarget(cfg).catch(() => null);
  if (!target?.endpoint || !target?.deployment) throw new AoaiNotConfiguredError();
  return { endpoint: target.endpoint, deployment: target.deployment, apiVersion: target.apiVersion };
}

/** One-shot AOAI chat completion (JSON-object mode). Cloud-portable. */
async function aoaiChatJson(
  target: ResolvedTarget,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const token = await aoaiToken();
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const payload: Record<string, unknown> = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };

  const send = (body: Record<string, unknown>) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });

  let res = await send(payload);
  // Newer reasoning models reject non-default temperature — retry without it.
  if (res.status === 400) {
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

// ── Public generators ───────────────────────────────────────────────────────

/**
 * Generate business-friendly descriptions for a batch of DAX measures. Returns
 * [] when there are no measures (caller decides whether that is a no-op).
 */
export async function generateMeasureDescriptions(
  target: ResolvedTarget,
  measures: MeasureInput[],
): Promise<DescribeProposal[]> {
  const list = measures.filter((m) => m.name);
  if (list.length === 0) return [];
  const measuresList = list
    .map((m, i) => `${i + 1}. [${m.name}] = ${(m.expression || '').slice(0, 200)}`)
    .join('\n');
  const raw = await aoaiChatJson(
    target,
    'You are a data catalog writer. For each DAX measure listed, write a concise (1-2 sentence) ' +
      'business-friendly description of what it computes and when a consumer would use it. ' +
      'Respond with a JSON object {"items":[{"name":"<exact measure name>","description":"..."}]} ' +
      'only — no prose, no code fence. Use the EXACT measure names supplied.',
    `Write descriptions for these DAX measures:\n${measuresList}`,
    Math.min(2000, 120 + list.length * 60),
  );
  return parseDescribeReply(raw);
}

/**
 * Generate business-friendly descriptions for a batch of table columns. Each
 * proposal name is "Table.Column" so the caller can route it back to the right
 * column. Returns [] when there are no columns.
 */
export async function generateColumnDescriptions(
  target: ResolvedTarget,
  columns: ColumnInput[],
): Promise<DescribeProposal[]> {
  const list = columns.filter((c) => c.table && c.name);
  if (list.length === 0) return [];
  const columnsList = list
    .map((c, i) => `${i + 1}. ${c.table}.${c.name}${c.dataType ? ` (${c.dataType})` : ''}`)
    .join('\n');
  const raw = await aoaiChatJson(
    target,
    'You are a data catalog writer. For each table column listed (formatted as Table.Column), ' +
      'write a concise (1 sentence) business-friendly description of what the column holds. ' +
      'Respond with a JSON object {"items":[{"name":"<Table.Column>","description":"..."}]} only — ' +
      'no prose, no code fence. Use the EXACT "Table.Column" names supplied as the name.',
    `Write descriptions for these columns:\n${columnsList}`,
    Math.min(3000, 120 + list.length * 40),
  );
  return parseDescribeReply(raw);
}
