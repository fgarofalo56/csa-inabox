/**
 * GET  /api/admin/copilot-config — current tenant-wide Copilot & Agents config
 *   → { ok, config, accounts, defaultAccount, envDefaults, accountsError? }
 *     (accounts is the live list of model-hosting Cognitive Services accounts so
 *      the picker can render even on first load. envDefaults surfaces the
 *      deployment-level env-var fallbacks — LOOM_AOAI_ENDPOINT /
 *      LOOM_AOAI_DEPLOYMENT / LOOM_FOUNDRY_PROJECT_ENDPOINT|ID — that the chat
 *      backends already use when no tenant doc is saved, so the UI can show
 *      "linked + working day-one" instead of blank fields.)
 * PUT  /api/admin/copilot-config — body: { config: TenantCopilotConfig }
 *   Persists to the `copilot-config` Cosmos container (one doc per tenant) and
 *   emits an audit-log entry. Returns { ok, config }.
 *
 * Real persistence + real ARM listing — no mocks. When no Foundry account is
 * resolvable the route still returns ok:true with accounts:[] and an
 * accountsError hint so the UI can render the honest infra-gate.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  loadTenantCopilotConfig,
  saveTenantCopilotConfig,
} from '@/lib/azure/copilot-config-store';
import { listAccountsDetailed, resolveAccount, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';
import {
  MODEL_TIERS, TASK_CLASSES, type ModelTier, type TaskClass, type TierDeployments,
} from '@/lib/foundry/model-tier-router';
import { withTenantAdmin } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



/** Whitelist of persistable STRING keys — never trust the client to send extras. */
const KEYS: (keyof TenantCopilotConfig)[] = [
  'foundryAccount', 'foundryAccountRg', 'foundryAccountSub', 'foundryProjectEndpoint', 'foundryProjectId',
  'aoaiEndpoint', 'copilotChatDeployment', 'helpAgentDeployment', 'routerDeployment', 'embeddingDeployment',
  'groundingSearchService', 'groundingSearchIndex', 'fabricCopilotWorkspaceId',
];

function sanitize(input: any): TenantCopilotConfig {
  const out: TenantCopilotConfig = {};
  for (const k of KEYS) {
    const v = input?.[k];
    if (typeof v === 'string') {
      const t = v.trim();
      (out as any)[k] = t === '' ? undefined : t;
    }
  }
  // Opt-in Fabric Copilot backend flag (boolean). Only `true` is persisted;
  // anything else clears it so the Azure-native path stays the silent default.
  out.fabricCopilotBackend = input?.fabricCopilotBackend === true ? true : undefined;

  // AIF-12 tier router. DEFAULT-ON: persist `false` to opt out; anything else
  // (incl. undefined) leaves it enabled by omission.
  out.modelTierRoutingEnabled = input?.modelTierRoutingEnabled === false ? false : undefined;
  // Per-tier deployment names — validated to the known tiers, string-only.
  const tiersIn = input?.modelTiers;
  if (tiersIn && typeof tiersIn === 'object') {
    const tiers: TierDeployments = {};
    for (const tier of MODEL_TIERS) {
      const v = tiersIn[tier];
      if (typeof v === 'string' && v.trim()) tiers[tier] = v.trim();
    }
    if (Object.keys(tiers).length) out.modelTiers = tiers;
  }
  // task-class → tier mapping — both keys and values validated to the enums.
  const mapIn = input?.modelTierTaskMap;
  if (mapIn && typeof mapIn === 'object') {
    const map: Partial<Record<TaskClass, ModelTier>> = {};
    for (const tc of TASK_CLASSES) {
      const v = mapIn[tc];
      if (typeof v === 'string' && (MODEL_TIERS as readonly string[]).includes(v)) {
        map[tc] = v as ModelTier;
      }
    }
    if (Object.keys(map).length) out.modelTierTaskMap = map;
  }
  return out;
}

export const GET = withTenantAdmin(async (_req, { session: s }) => {
  const tenantId = s.claims.oid;
  try {
    const config = (await loadTenantCopilotConfig(tenantId)) || {};
    // Best-effort live account list so the picker renders immediately.
    let accounts: Array<{ name: string; rg: string; sub?: string; location?: string; kind?: string; endpoint?: string }> = [];
    let defaultAccount: string | undefined;
    let accountsError: { error: string; hint?: string } | undefined;
    try {
      // listAccountsDetailed (not listAccounts): per-subscription failures are
      // tolerated inside the client so one bad subscription can't blank the
      // picker, but they must NOT vanish. #4432 — a swallowed 403/429 rendered
      // identically to "this tenant has no Foundry accounts": an empty dropdown
      // with no MessageBar, i.e. a claim of absence never established (R7).
      const detailed = await listAccountsDetailed();
      accounts = detailed.accounts.map((a) => ({
        name: a.name, rg: a.rg, sub: a.subscriptionId, location: a.location, kind: a.kind, endpoint: a.endpoint,
      }));
      if (accounts.length === 0 && detailed.failures.length > 0) {
        const f = detailed.failures[0];
        accountsError = {
          error:
            `Could not list Azure AI Foundry accounts: ARM returned ` +
            `${f.status ? `HTTP ${f.status}` : 'an error'} for subscription ${f.subscriptionId}` +
            `${detailed.failures.length > 1 ? ` (and ${detailed.failures.length - 1} more)` : ''}. ` +
            `${f.message}`,
          hint:
            `This is NOT a statement that no accounts exist — the list could not be read. ` +
            `Grant the Console managed identity "Cognitive Services Contributor" (or at least Reader) ` +
            `on the subscription or resource group holding your AIServices/OpenAI account, then reload.`,
        };
      }
      try { defaultAccount = (await resolveAccount()).name; } catch { /* no default */ }
    } catch (e: any) {
      accountsError = e instanceof CsNotConfiguredError
        ? { error: e.message, hint: e.hint }
        : { error: e?.message || String(e) };
    }
    // Env-var fallbacks the chat backends already honor (copilot-orchestrator
    // resolveAoaiTarget → LOOM_AOAI_ENDPOINT/_DEPLOYMENT; foundry-agent-client →
    // LOOM_FOUNDRY_PROJECT_ENDPOINT/_ID). Surfaced so the UI shows Copilot is
    // linked + working on a fresh deploy even before any admin save. Non-secret
    // (endpoint hosts + deployment NAMES only — never keys/tokens).
    const envDefaults = {
      aoaiEndpoint: process.env.LOOM_AOAI_ENDPOINT || undefined,
      copilotChatDeployment: process.env.LOOM_AOAI_DEPLOYMENT || undefined,
      foundryProjectEndpoint: process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT || undefined,
      foundryProjectId: process.env.LOOM_FOUNDRY_PROJECT_ID || undefined,
    };
    return NextResponse.json({ ok: true, config, accounts, defaultAccount, envDefaults, accountsError });
  } catch (e: any) {
    return apiServerError(e);
  }
});

export const PUT = withTenantAdmin(async (req: NextRequest, { session: s }) => {
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const incoming = body?.config;
  if (!incoming || typeof incoming !== 'object') return apiError('config (object) required', 400);

  const who = s.claims.upn || s.claims.email || tenantId;
  try {
    const before = (await loadTenantCopilotConfig(tenantId)) || {};
    const patch = sanitize(incoming);
    const doc = await saveTenantCopilotConfig(tenantId, who, patch);

    // Audit: one entry capturing the changed keys.
    try {
      const changed = KEYS.filter((k) => (before as any)[k] !== (patch as any)[k]);
      if (changed.length > 0) {
        const audit = await auditLogContainer();
        await audit.items.create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `copilot-config:${tenantId}`,
          tenantId,
          who,
          at: doc.updatedAt,
          kind: 'copilot-config.update',
          changedKeys: changed,
        }).catch(() => {});
      }
    } catch { /* audit failures are non-blocking */ }

    const { id: _i, tenantId: _t, updatedAt, updatedBy, ...config } = doc;
    return NextResponse.json({ ok: true, config, updatedAt, updatedBy });
  } catch (e: any) {
    return apiServerError(e);
  }
});
