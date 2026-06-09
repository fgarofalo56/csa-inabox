/**
 * GET /api/deployment-pipelines/loom/[id]/stages/[stageId]/rules
 *   → { ok, data: { rules: LoomDeployRule[] } }
 * PUT /api/deployment-pipelines/loom/[id]/stages/[stageId]/rules
 *   body: { rules: LoomDeployRule[] } → upserts the per-stage rule set
 *
 * Per-stage deployment rules (parameter / data-source overrides) applied when
 * content is deployed INTO this stage. Azure-native parity for Fabric's
 * deployment rules — Cosmos-backed, real, editable (no portal-only gate).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { allowedKeysForKind, RULE_KINDS, type LoomDeployRule, type LoomRuleKind } from '@/lib/types/loom-pipeline';
import { jok, jerr, loadPipeline, stageWorkspaceId, loadStageRules, saveStageRules } from '../../../../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; stageId: string }> }) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const { id, stageId } = await ctx.params;
  try {
    const pipeline = await loadPipeline(s.claims.oid, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    if (!stageWorkspaceId(pipeline, stageId)) return jerr('stage not found in pipeline', 404, 'not_found');
    const rules = await loadStageRules(id, stageId);
    return jok({ rules });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to load rules');
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; stageId: string }> }) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const { id, stageId } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body?.rules) ? body.rules : null;
  if (!raw) return jerr('rules array required', 400, 'bad_request');

  const rules: LoomDeployRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] || {};
    const itemType = String(r.itemType || '').trim();
    const kind = String(r.kind || '').trim() as LoomRuleKind;
    const key = String(r.key || '').trim();
    const value = String(r.value ?? '');
    const itemDisplayName = r.itemDisplayName ? String(r.itemDisplayName).trim() : undefined;
    if (!itemType) return jerr(`Rule ${i + 1}: itemType required (use '*' for all)`, 400, 'bad_request');
    if (!RULE_KINDS.includes(kind)) return jerr(`Rule ${i + 1}: kind must be one of ${RULE_KINDS.join(', ')}`, 400, 'bad_request');
    if (!allowedKeysForKind(kind).includes(key)) {
      return jerr(`Rule ${i + 1}: key '${key}' is not valid for kind '${kind}' (allowed: ${allowedKeysForKind(kind).join(', ')})`, 400, 'bad_request');
    }
    if (!value) return jerr(`Rule ${i + 1}: value required`, 400, 'bad_request');
    rules.push({ itemType, itemDisplayName, kind, key, value });
  }

  try {
    const pipeline = await loadPipeline(s.claims.oid, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    if (!stageWorkspaceId(pipeline, stageId)) return jerr('stage not found in pipeline', 404, 'not_found');
    const saved = await saveStageRules(id, stageId, rules, s.claims.upn || s.claims.email || s.claims.oid);
    return jok({ rules: saved });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to save rules');
  }
}
