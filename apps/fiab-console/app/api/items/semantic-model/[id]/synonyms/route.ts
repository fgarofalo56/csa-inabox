/**
 * /api/items/semantic-model/[id]/synonyms — the Loom-native parity of the
 * Power BI / Fabric "Q&A → Synonyms" (linguistic schema) surface. It is the BFF
 * backing `lib/editors/components/synonyms-editor.tsx` (the Model view's
 * Synonyms tab).
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): this is the
 * DEFAULT, Azure-native path. Synonyms persist to the OWNED Cosmos item under
 * `item.state.model.synonyms` — NO Power BI / Fabric / AAS workspace required,
 * no `fabricWorkspaceId` read, no `api.fabric.microsoft.com` / `api.powerbi.com`
 * call. The persisted linguistic schema drives the Loom-native Q&A AI visual +
 * Copilot, and is emitted into TMSL `linguisticMetadata` only when the model is
 * OPT-IN provisioned to a tabular engine (a separate, provision-time path).
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md): GET reads the real persisted
 * entries; PUT validates then writes them to the real Cosmos item via the same
 * owned-item store (`loadOwnedItem` / `updateOwnedItem`) that `model-store.ts`
 * uses for relationships + measures — preserving the rest of `state` AND the
 * rest of `state.model`. No mock arrays, no dead controls, no fake "saved".
 *
 * loom_no_freeform_config: the body is a STRUCTURED `SynonymEntry[]` (discrete
 * objectType/table/object/terms/weight), authored as tags + a preset weight
 * Dropdown in the editor — never a JSON / free-form box.
 *
 *   GET → { ok:true, synonyms: SynonymEntry[] }
 *         | 404 { ok:false, error } when the id is not an owned Loom-native
 *           semantic-model item (the editor treats 404 as "start empty").
 *   PUT  body { synonyms: SynonymEntry[] }
 *        → validate (object resolves to a non-empty identifier, terms non-empty)
 *          → persist to item.state.model.synonyms
 *        → { ok:true, persisted:true, count, synonyms }
 *        | 400 on invalid shape | 404 when no owned item resolves.
 *
 * The synthetic bundle-template id (`loom:<cosmosItemId>`, per
 * `_lib/pbi-content-fallback.ts`) is resolved to the underlying Cosmos item id
 * so the editor's auto-picked Loom-native model persists correctly; a bare
 * Cosmos item id passes through unchanged.
 *
 * WIRING (OPEN-REGISTER P1-8a): validation/normalization + Cosmos read/write
 * delegate to `lib/azure/linguistic-schema.ts` (`validateSynonyms` /
 * `readSynonyms` / `writeSynonyms`) — the SAME single source of truth the
 * report Q&A grounding (`/api/items/report/[id]/ai-visual`) projects via
 * `buildLinguisticSchema`. This route no longer inlines its own normalizer or
 * owned-item Cosmos calls.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cosmosIdFromLoomId } from '../../../_lib/pbi-content-fallback';
import {
  validateSynonyms,
  readSynonyms,
  writeSynonyms,
  type SynonymEntry,
} from '@/lib/azure/linguistic-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tenantId = session.claims.oid;
  const cosmosId = cosmosIdFromLoomId((await ctx.params).id);

  const { synonyms, itemFound } = await readSynonyms(cosmosId, ITEM_TYPE, tenantId);
  if (!itemFound) {
    // Not a Loom-native owned model (e.g. a live Power BI-only dataset id) —
    // honest 404; the editor starts with an empty linguistic schema.
    return NextResponse.json({ ok: false, error: 'semantic-model not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, synonyms });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tenantId = session.claims.oid;
  const cosmosId = cosmosIdFromLoomId((await ctx.params).id);

  const body = (await req.json().catch(() => ({}))) as { synonyms?: unknown };

  let synonyms: SynonymEntry[];
  try {
    synonyms = validateSynonyms(body?.synonyms);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'invalid synonyms payload' }, { status: 400 });
  }

  // Persist onto state.model.synonyms — `writeSynonyms` preserves the rest of
  // `state` AND the rest of `state.model` (relationships, measures, what-if
  // params, calc tables, security roles, …). Azure-native Cosmos only — no
  // Fabric / Power BI.
  const persisted = await writeSynonyms(cosmosId, ITEM_TYPE, tenantId, synonyms);
  if (!persisted) {
    return NextResponse.json({ ok: false, error: 'semantic-model not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, persisted: true, count: synonyms.length, synonyms });
}
