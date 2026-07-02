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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { cosmosIdFromLoomId } from '../../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

// ── Contract shape (mirrors SynonymEntry in synonyms-editor.tsx) ─────────────

type SynObjectType = 'table' | 'column' | 'measure';

interface SynonymEntry {
  objectType: SynObjectType;
  table?: string;
  object: string;
  terms: string[];
  weight?: number;
}

const OBJECT_TYPES: readonly SynObjectType[] = ['table', 'column', 'measure'];

/**
 * Validate + normalize the incoming `synonyms` payload into a clean
 * `SynonymEntry[]`. Throws a plain Error (its message becomes the 400 body) on a
 * malformed shape. Per `no-freeform-config`, the structure is fixed; per
 * `no-vaporware`, we never silently drop a saved object that is missing from the
 * current schema (the editor preserves "orphan" rows on purpose) — "object
 * resolves" is enforced as a non-empty identifier, not schema membership.
 */
function normalizeSynonyms(input: unknown): SynonymEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error('`synonyms` must be an array of synonym entries.');
  }

  const out: SynonymEntry[] = [];
  // De-dupe by (objectType|table|object) so the same object is written once.
  const seen = new Set<string>();

  for (const raw of input) {
    const e = (raw || {}) as Record<string, unknown>;

    const objectType = OBJECT_TYPES.includes(e.objectType as SynObjectType)
      ? (e.objectType as SynObjectType)
      : 'column';

    const object = String(e.object ?? '').trim();
    if (!object) {
      throw new Error('Each synonym entry needs a non-empty `object` (the table, column, or measure name).');
    }

    const table = e.table === undefined || e.table === null ? undefined : String(e.table).trim() || undefined;

    // Terms: trim, drop empties, de-dupe case-insensitively, keep first casing.
    const rawTerms = Array.isArray(e.terms) ? e.terms : [];
    const terms: string[] = [];
    const lower = new Set<string>();
    for (const t of rawTerms) {
      const term = String(t ?? '').trim();
      if (!term) continue;
      const lc = term.toLowerCase();
      if (lower.has(lc)) continue;
      lower.add(lc);
      terms.push(term);
    }
    if (terms.length === 0) {
      throw new Error(`Synonym entry for '${object}' needs at least one non-empty term.`);
    }

    // Weight is an optional match-strength in (0, 1]; drop anything out of range.
    let weight: number | undefined;
    if (e.weight !== undefined && e.weight !== null && e.weight !== '') {
      const n = Number(e.weight);
      if (Number.isFinite(n) && n > 0 && n <= 1) weight = n;
    }

    const key = `${objectType}${table ?? ''}${object}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ objectType, object, ...(table ? { table } : {}), terms, ...(weight !== undefined ? { weight } : {}) });
  }

  return out;
}

/** Read the persisted synonyms off an owned item's `state.model.synonyms`. */
function readSynonyms(item: { state?: unknown }): SynonymEntry[] {
  const model = (item.state as Record<string, unknown> | undefined)?.model as
    | { synonyms?: unknown }
    | undefined;
  const raw = model?.synonyms;
  // Defensive re-normalize so a hand-edited / legacy doc never breaks the GET.
  try {
    return normalizeSynonyms(raw);
  } catch {
    return [];
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tenantId = session.claims.oid;
  const cosmosId = cosmosIdFromLoomId((await ctx.params).id);

  const item = await loadOwnedItem(cosmosId, ITEM_TYPE, tenantId);
  if (!item) {
    // Not a Loom-native owned model (e.g. a live Power BI-only dataset id) —
    // honest 404; the editor starts with an empty linguistic schema.
    return NextResponse.json({ ok: false, error: 'semantic-model not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, synonyms: readSynonyms(item) });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const tenantId = session.claims.oid;
  const cosmosId = cosmosIdFromLoomId((await ctx.params).id);

  const body = (await req.json().catch(() => ({}))) as { synonyms?: unknown };

  let synonyms: SynonymEntry[];
  try {
    synonyms = normalizeSynonyms(body?.synonyms);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'invalid synonyms payload' }, { status: 400 });
  }

  // Load the owned item, then write synonyms onto state.model.synonyms while
  // preserving the rest of `state` AND the rest of `state.model` (relationships,
  // measures, what-if params, calc tables, security roles, …). Azure-native
  // Cosmos only — no Fabric / Power BI.
  const item = await loadOwnedItem(cosmosId, ITEM_TYPE, tenantId);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'semantic-model not found' }, { status: 404 });
  }

  const prevState = (item.state || {}) as Record<string, unknown>;
  const prevModel = (prevState.model || {}) as Record<string, unknown>;
  const nextState = { ...prevState, model: { ...prevModel, synonyms } };

  const updated = await updateOwnedItem(cosmosId, ITEM_TYPE, tenantId, { state: nextState });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist synonyms' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, persisted: true, count: synonyms.length, synonyms });
}
