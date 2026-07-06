/**
 * GET/POST /api/governance/dlp/library
 *
 * The curated DLP policy-library catalog + one-click preset enablement.
 *
 *   GET  → { ok, presets, sensitiveInfoTypes, defaultPresetId, enabledSources }
 *          The static preset catalog + SIT list, plus which preset `source`s are
 *          already present in this tenant's policy store (so the UI shows an
 *          Enabled state). Requires a session; the catalog itself is reference
 *          data, `enabledSources` is scoped to the caller tenant (claims.oid).
 *
 *   POST { presetId } → materialize the preset into a REAL Loom governance
 *          policy (kind: 'DLP') and persist it to the tenant policy store
 *          (Cosmos). Idempotent per preset — a preset already enabled is not
 *          duplicated. Tenant-admin only.
 *
 * No Microsoft Fabric / Power BI dependency and no dependence on the live Graph
 * DLP data-plane: presets author + save regardless of whether the Graph DLP
 * AppRoles are granted (config-only state is allowed per no-vaporware.md).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import {
  loadOrSeedPolicies, savePolicies, CosmosNotConfiguredError, type Policy,
} from '@/lib/governance/policy-store';
import {
  DLP_POLICY_PRESETS, SENSITIVE_INFO_TYPES, DEFAULT_DLP_PRESET_ID,
  getPreset, materializePreset,
} from '@/lib/governance/dlp-policy-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cosmosGate() {
  return apiError(
    'The policy library requires Cosmos DB. Set LOOM_COSMOS_ENDPOINT on the Console Container App and grant the Console UAMI the Cosmos DB Built-in Data Contributor role at account scope.',
    503, { code: 'cosmos_not_configured' },
  );
}

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  let enabledSources: string[] = [];
  try {
    const doc = await loadOrSeedPolicies(s.claims.oid);
    enabledSources = doc.items
      .filter((p) => p.enabled && typeof p.source === 'string' && p.source.startsWith('preset:'))
      .map((p) => p.source!);
  } catch (e) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGate();
    return apiServerError(e);
  }
  return apiOk({
    presets: DLP_POLICY_PRESETS,
    sensitiveInfoTypes: SENSITIVE_INFO_TYPES,
    defaultPresetId: DEFAULT_DLP_PRESET_ID,
    enabledSources,
  });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const presetId = (body?.presetId || '').toString();
  const preset = getPreset(presetId);
  if (!preset) return apiError('unknown presetId', 400);
  try {
    const tenantId = s.claims.oid;
    const doc = await loadOrSeedPolicies(tenantId);
    const source = `preset:${preset.id}`;
    const existing = doc.items.find((p) => p.source === source);
    if (existing) {
      // Idempotent — re-enable if it had been disabled, otherwise no-op.
      if (!existing.enabled) { existing.enabled = true; await savePolicies(doc); }
      return apiOk({ policy: existing, policies: doc.items, alreadyEnabled: existing.enabled });
    }
    const mat = materializePreset(preset);
    const policy: Policy = {
      id: crypto.randomUUID(),
      name: mat.name,
      kind: mat.kind,
      scope: mat.scope,
      rule: mat.rule,
      enabled: mat.enabled,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
      dlp: mat.dlp,
      source: mat.source,
      category: mat.category,
    };
    doc.items.push(policy);
    await savePolicies(doc);
    return apiOk({ policy, policies: doc.items });
  } catch (e) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGate();
    return apiServerError(e);
  }
}
