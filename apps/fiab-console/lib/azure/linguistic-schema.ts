/**
 * linguistic-schema — Azure-native persistence + projection for the Loom Model
 * view "Synonyms / linguistic schema" surface (the one-for-one parity of the
 * Power BI / Fabric Q&A → Synonyms editor; see `lib/editors/components/
 * synonyms-editor.tsx`).
 *
 * NO-FABRIC-DEPENDENCY (`.claude/rules/no-fabric-dependency.md`): the linguistic
 * schema is the DEFAULT, Azure-native authoring slot. Synonyms persist onto the
 * OWNED Cosmos item under `item.state.model.synonyms` — the SAME `LoomModelState`
 * slot that `app/api/items/_lib/model-store.ts`, `lib/copilot/dax-tools.ts`, and
 * the measures/query path already read/write. NO Power BI / Fabric / AAS
 * workspace is required to read, write, or use these terms. They are emitted into
 * TMSL `linguisticMetadata` ONLY when the model is OPT-IN provisioned to a tabular
 * engine (aas-tmsl, not this module).
 *
 * GROUNDING PROJECTION — HONEST WIRING STATE (`.claude/rules/no-vaporware.md`):
 * `buildLinguisticSchema` is a PURE projection that turns the persisted synonyms
 * into a grounding-ready `LinguisticSchema` (entity list + term→candidate index)
 * for a Loom-native Q&A / Copilot grounding path. It is NOT yet wired into a
 * caller: the report Q&A AI visual (`/api/items/report/[id]/ai-visual`) currently
 * grounds on the bound model's field list (`body.fields`), NOT on
 * `state.model.synonyms`, and the synonyms BFF route
 * (`app/api/items/semantic-model/[id]/synonyms/route.ts`) inlines its own
 * normalizer rather than importing this module. Wiring this projection into that
 * route (and the report Copilot's grounding block) — or having the synonyms route
 * reuse `validateSynonyms` — is the remaining step. Until then this header
 * describes the projection this module OFFERS, not one a route already consumes;
 * it does not claim synonyms currently back Q&A.
 *
 * NO-VAPORWARE (`.claude/rules/no-vaporware.md`): real Cosmos reads/writes via
 * the shared `loadOwnedItem` / `updateOwnedItem` item-crud helpers — no mocks,
 * no `return []` placeholder. `writeSynonyms` preserves the rest of `state` AND
 * the rest of `state.model` (relationships, measures, what-if params, …) so it
 * never clobbers sibling Wave-3 modeling objects. `validateSynonyms` rejects a
 * malformed payload with a plain Error whose message the BFF route returns as a
 * 400 body.
 *
 * loom_no_freeform_config (`.claude/rules/loom-no-freeform-config.md`): authoring
 * is fully structured upstream (discrete synonym tags + a preset weight Dropdown
 * in the editor). This module only validates + normalizes that structured shape;
 * there is no JSON / free-form config surface here.
 *
 * Pure-ish + server-only: the only Azure dependency is the existing item-crud
 * Cosmos helpers (no new SDK import, no new container, no new env var). The
 * type, the validator, and `buildLinguisticSchema` are pure and unit-testable.
 *
 * Underscore-free, lib/azure home — but still server-only (item-crud pulls in
 * `next/server`); the client editor talks to the BFF route via `clientFetch`
 * and never imports this module.
 */

import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import type { LoomModelState } from '@/app/api/items/_lib/model-store';

// ── Contract type (SHARED CONTRACT §A — mirrored verbatim by the editor) ──────

export type SynObjectType = 'table' | 'column' | 'measure';

/**
 * A single linguistic-schema row: the natural-language SYNONYM terms a business
 * user types for one model object (table / column / measure), with an optional
 * match weight. Persisted Azure-native at `item.state.model.synonyms[]`.
 */
export interface SynonymEntry {
  objectType: SynObjectType;
  /** Home table for a column/measure (omitted for a table row, or a model-level measure). */
  table?: string;
  /** The object's own name (the table name for a `table` row). */
  object: string;
  /** Natural-language terms ("revenue", "turnover" → [Sales Amount]). De-duped, non-empty. */
  terms: string[];
  /** NL match weight in [0,1]; higher wins an ambiguous resolution. Omitted = engine default. */
  weight?: number;
}

const OBJECT_TYPES: readonly SynObjectType[] = ['table', 'column', 'measure'] as const;

/** Default match weight assumed by the projection when a row leaves `weight` unset. */
export const DEFAULT_SYNONYM_WEIGHT = 0.5;

// Defensive caps — a structured editor never approaches these, but a hand-rolled
// PUT shouldn't be able to wedge the item doc with a pathological payload.
const MAX_ENTRIES = 5_000;
const MAX_TERMS_PER_ENTRY = 200;
const MAX_TERM_LEN = 200;

// ── Validation / normalization (throws plain Error → 400 in the route) ────────

/**
 * Validate + normalize an incoming `{ synonyms: SynonymEntry[] }` payload from
 * the Synonyms editor's PUT. Returns a clean, de-duped `SynonymEntry[]`. Throws
 * a plain Error (its `.message` becomes the route's 400 body) on a malformed
 * shape. Rows are normalized — trimmed object/table, case-insensitively de-duped
 * non-empty terms (original order + casing preserved), weight clamped to [0,1].
 *
 * Entries that normalize to ZERO terms are dropped silently (the editor only
 * sends objects with ≥1 term; a stray empty row is not an error). A row that is
 * structurally invalid (bad objectType, missing object name, non-string terms,
 * non-numeric weight) throws.
 */
export function validateSynonyms(input: unknown): SynonymEntry[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error('synonyms must be an array of { objectType, object, terms } entries');
  }
  if (input.length > MAX_ENTRIES) {
    throw new Error(`too many synonym entries (max ${MAX_ENTRIES})`);
  }

  const out: SynonymEntry[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== 'object') {
      throw new Error(`synonym entry #${i + 1} must be an object`);
    }
    const e = raw as Record<string, unknown>;

    const objectType = e.objectType as SynObjectType;
    if (!OBJECT_TYPES.includes(objectType)) {
      throw new Error(`synonym entry #${i + 1} has an invalid objectType (expected table | column | measure)`);
    }

    const object = String(e.object ?? '').trim();
    if (!object) {
      throw new Error(`synonym entry #${i + 1} (${objectType}) is missing an object name`);
    }

    const tableRaw = e.table === undefined || e.table === null ? '' : String(e.table).trim();
    const table = tableRaw || undefined;

    if (!Array.isArray(e.terms)) {
      throw new Error(`synonym entry for ${table ? `${table}.` : ''}${object} must have a terms array`);
    }
    if (e.terms.length > MAX_TERMS_PER_ENTRY) {
      throw new Error(`synonym entry for ${object} has too many terms (max ${MAX_TERMS_PER_ENTRY})`);
    }

    // Normalize + de-dupe terms (case-insensitive), preserving original order/casing.
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const t of e.terms as unknown[]) {
      if (typeof t !== 'string') {
        throw new Error(`synonym entry for ${object} contains a non-string term`);
      }
      const term = t.trim();
      if (!term) continue;
      if (term.length > MAX_TERM_LEN) {
        throw new Error(`a synonym term for ${object} exceeds ${MAX_TERM_LEN} characters`);
      }
      const lower = term.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      terms.push(term);
    }
    // A row with no usable terms carries no signal — drop it (not an error).
    if (terms.length === 0) continue;

    const entry: SynonymEntry = { objectType, object, terms };
    if (table) entry.table = table;

    if (e.weight !== undefined && e.weight !== null) {
      const w = Number(e.weight);
      if (!Number.isFinite(w)) {
        throw new Error(`synonym entry for ${object} has a non-numeric weight`);
      }
      // Clamp to the [0,1] band the editor's preset Dropdown emits.
      entry.weight = Math.min(1, Math.max(0, w));
    }

    out.push(entry);
  }
  return out;
}

// ── Cosmos persistence (wraps the shared item-crud helpers) ───────────────────

/** What a `state.model` blob can carry — only the slot this module touches. */
type ModelWithSynonyms = Partial<LoomModelState> & { synonyms?: unknown };

/**
 * Read the persisted synonym list for an owned item (Azure-native, Cosmos).
 * Mirrors `model-store.readModelState`'s `{ …, itemFound }` shape so the GET
 * route can 404 a missing item vs. return an empty list for an item with no
 * synonyms yet. Never throws on absence.
 */
export async function readSynonyms(
  itemId: string,
  itemType: string,
  tenantId: string,
): Promise<{ synonyms: SynonymEntry[]; itemFound: boolean }> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return { synonyms: [], itemFound: false };
  const model = (item.state as Record<string, unknown> | undefined)?.model as ModelWithSynonyms | undefined;
  const raw = Array.isArray(model?.synonyms) ? (model!.synonyms as unknown[]) : [];
  // Re-validate on read so a hand-edited / legacy doc projects a clean list and
  // never crashes a consumer. A malformed legacy blob degrades to [] rather than
  // throwing on a GET.
  let synonyms: SynonymEntry[];
  try {
    synonyms = validateSynonyms(raw);
  } catch {
    synonyms = [];
  }
  return { synonyms, itemFound: true };
}

/**
 * Persist the synonym list onto `item.state.model.synonyms`, preserving the rest
 * of `state` AND the rest of `state.model` (relationships, measures, what-if
 * parameters, calculated tables, date-table marks, security roles, …). Returns
 * false when the item is not found / not owned by the tenant. Real Cosmos write.
 *
 * The caller is expected to pass an already-validated list (`validateSynonyms`);
 * this re-stores it verbatim.
 */
export async function writeSynonyms(
  itemId: string,
  itemType: string,
  tenantId: string,
  synonyms: SynonymEntry[],
): Promise<boolean> {
  const item = await loadOwnedItem(itemId, itemType, tenantId);
  if (!item) return false;
  const prevState = (item.state as Record<string, unknown> | undefined) ?? {};
  const prevModel = (prevState.model as Record<string, unknown> | undefined) ?? {};
  const nextState = { ...prevState, model: { ...prevModel, synonyms } };
  const updated = await updateOwnedItem(itemId, itemType, tenantId, { state: nextState });
  return !!updated;
}

// ── Grounding projection (Q&A / Copilot) — produced here, not yet consumed ────

/** One resolved object in the projected linguistic schema. */
export interface LinguisticEntity {
  objectType: SynObjectType;
  table?: string;
  object: string;
  /** Canonical reference: `'<table>'[<col>]` for a column, `[<measure>]` for a
   *  measure, the bare table name for a table. What grounding text cites. */
  reference: string;
  terms: string[];
  /** Resolved weight (DEFAULT_SYNONYM_WEIGHT when the row left it unset). */
  weight: number;
}

/** A ranked candidate for one natural-language term. */
export interface LinguisticTermCandidate {
  reference: string;
  objectType: SynObjectType;
  object: string;
  table?: string;
  weight: number;
}

/**
 * The JSON grounding shape `buildLinguisticSchema` produces for a Loom-native Q&A
 * / Copilot grounding path (see the header's wiring note — produced here, not yet
 * consumed by a route). Carries both a flat `entities` list (for a compact
 * grounding block) and a lower-cased `termIndex` (term → weight-ranked candidate
 * objects) for fast NL resolution.
 */
export interface LinguisticSchema {
  version: '1.0';
  generatedAt: string;
  entityCount: number;
  /** Distinct lower-cased terms across all entities. */
  termCount: number;
  entities: LinguisticEntity[];
  termIndex: Record<string, LinguisticTermCandidate[]>;
}

/** Build the canonical reference string a grounding prompt / Q&A engine cites. */
function referenceFor(objectType: SynObjectType, table: string | undefined, object: string): string {
  if (objectType === 'column') return table ? `'${table}'[${object}]` : `[${object}]`;
  if (objectType === 'measure') return `[${object}]`;
  return object; // table
}

/**
 * Project a validated `SynonymEntry[]` into a grounding-ready `LinguisticSchema`
 * for a Loom-native Q&A / Copilot grounding path — a flat entity list plus a
 * term → ranked-candidate index. (Available for that path but not yet wired into
 * a caller; see the header's honest wiring note.) Pure: deterministic for a given
 * input, no I/O. Input that is not yet validated is tolerated (re-validated
 * defensively) so callers can hand it the raw persisted blob.
 */
export function buildLinguisticSchema(entries: SynonymEntry[] | unknown): LinguisticSchema {
  const clean = Array.isArray(entries) && entries.every(isSynonymEntryish)
    ? (entries as SynonymEntry[])
    : safeValidate(entries);

  const entities: LinguisticEntity[] = [];
  const termIndex: Record<string, LinguisticTermCandidate[]> = {};

  for (const e of clean) {
    const weight = typeof e.weight === 'number' ? e.weight : DEFAULT_SYNONYM_WEIGHT;
    const reference = referenceFor(e.objectType, e.table, e.object);
    const terms = Array.isArray(e.terms) ? e.terms.filter((t) => typeof t === 'string' && t.trim()) : [];
    if (terms.length === 0) continue;

    entities.push({
      objectType: e.objectType,
      ...(e.table ? { table: e.table } : {}),
      object: e.object,
      reference,
      terms,
      weight,
    });

    for (const term of terms) {
      const key = term.toLowerCase();
      const bucket = termIndex[key] ?? (termIndex[key] = []);
      // Avoid duplicate candidates for the same reference under one term.
      if (bucket.some((c) => c.reference === reference)) continue;
      bucket.push({
        reference,
        objectType: e.objectType,
        object: e.object,
        ...(e.table ? { table: e.table } : {}),
        weight,
      });
    }
  }

  // Rank each term's candidates by descending weight (stable on ties).
  for (const key of Object.keys(termIndex)) {
    termIndex[key].sort((a, b) => b.weight - a.weight);
  }

  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    entityCount: entities.length,
    termCount: Object.keys(termIndex).length,
    entities,
    termIndex,
  };
}

/** Loose runtime guard so `buildLinguisticSchema` can skip re-validation on the
 *  already-clean path without importing the validator's throwing behavior. */
function isSynonymEntryish(v: unknown): v is SynonymEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return OBJECT_TYPES.includes(e.objectType as SynObjectType)
    && typeof e.object === 'string'
    && Array.isArray(e.terms);
}

/** Validate without throwing (projection should degrade, never crash a render). */
function safeValidate(input: unknown): SynonymEntry[] {
  try {
    return validateSynonyms(input);
  } catch {
    return [];
  }
}
