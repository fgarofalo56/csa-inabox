/**
 * GET/POST /api/governance/labels/library
 *
 * The curated Information Protection label-policy library + one-click enablement.
 *
 *   GET  → { ok, presets, taxonomy, defaultPresetId, enabledSources }
 *          The static preset catalog + label taxonomy, plus which preset
 *          `source`s are already present in this tenant's policy store.
 *
 *   POST { presetId } → materialize the preset into a REAL Loom governance
 *          policy (kind: 'Label') and persist it to the tenant policy store
 *          (Cosmos). Idempotent per preset. Tenant-admin only.
 *
 * No Microsoft Purview / SCC-sidecar / Graph dependency: presets author + save
 * regardless of whether the live Microsoft Information Protection sync is wired
 * (config-only state is allowed per no-vaporware.md). Mirrors the DLP library.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import {
  loadOrSeedPolicies, savePolicies, CosmosNotConfiguredError, type Policy,
} from '@/lib/governance/policy-store';
import {
  LABEL_POLICY_PRESETS, LABEL_TAXONOMY, DEFAULT_LABEL_POLICY_PRESET_ID,
  getLabelPreset, labelPolicyBodyFromPreset,
} from '@/lib/governance/label-policy-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cosmosGate() {
  return apiError(
    'The label-policy library requires Cosmos DB. Set LOOM_COSMOS_ENDPOINT on the Console Container App and grant the Console UAMI the Cosmos DB Built-in Data Contributor role at account scope.',
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
      .filter((p) => p.kind === 'Label' && p.enabled && typeof p.source === 'string' && p.source.startsWith('preset:'))
      .map((p) => p.source!);
  } catch (e) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGate();
    return apiServerError(e);
  }
  return apiOk({
    presets: LABEL_POLICY_PRESETS,
    taxonomy: LABEL_TAXONOMY,
    defaultPresetId: DEFAULT_LABEL_POLICY_PRESET_ID,
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
  const enable = body?.enable !== false; // default true
  const preset = getLabelPreset(presetId);
  if (!preset) return apiError('unknown presetId', 400);
  try {
    const tenantId = s.claims.oid;
    const doc = await loadOrSeedPolicies(tenantId);
    const source = `preset:${preset.id}`;
    const existing = doc.items.find((p) => p.source === source && p.kind === 'Label');
    if (existing) {
      if (existing.enabled !== enable) { existing.enabled = enable; await savePolicies(doc); }
      return apiOk({ presetId, enabled: enable });
    }
    const b = labelPolicyBodyFromPreset(preset);
    const policy: Policy = {
      id: crypto.randomUUID(),
      name: b.name, kind: 'Label', scope: b.scope, rule: b.rule,
      enabled: enable, createdAt: new Date().toISOString(), createdBy: s.claims.oid,
      label: b.label, source: b.source, builtin: b.builtin, category: b.category,
    };
    doc.items.push(policy);
    await savePolicies(doc);
    return apiOk({ presetId, enabled: enable });
  } catch (e) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGate();
    return apiServerError(e);
  }
}
