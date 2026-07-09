/**
 * prep-for-ai-store.ts — Cosmos persistence + data-agent consumption wiring for
 * the semantic-model "Prep for AI" surface (Fabric-parity G5).
 *
 * The three curation fields (AI instructions / AI data schema / Verified
 * Answers) live Azure-native on the existing Cosmos item under
 * `item.state.prepForAi` — NO new container, NO new env var, NO Power BI /
 * Fabric dependency. All reads/writes are owner-scoped via loadOwnedItem /
 * updateOwnedItem (the caller's oid is `tenantId`), so a caller can only touch a
 * model they own — never gated on getSession alone.
 *
 * Consumption: `enrichSemanticModelSources` loads a bound model's Verified
 * Answers into a data-agent semantic-model source's few-shot `examples` and
 * layers the AI instructions + exposed-schema guidance onto its grounding — so
 * the curated NL→DAX pairs are actually surfaced to the model at run time
 * (composeSystemPrompt already renders `examples` for every source type).
 */

import { loadOwnedItem, updateOwnedItem } from '../../_lib/item-crud';
import {
  normalizePrepForAi,
  composeSourceGrounding,
  verifiedAnswersToExamples,
  type PrepForAiState,
} from './prep-for-ai-model';

const ITEM_TYPE = 'semantic-model';

/** Read the persisted Prep-for-AI sub-state for an owned model (empty when absent). */
export async function readPrepForAi(
  itemId: string,
  tenantId: string,
): Promise<{ state: PrepForAiState; itemFound: boolean }> {
  const item = await loadOwnedItem(itemId, ITEM_TYPE, tenantId);
  if (!item) return { state: normalizePrepForAi(undefined), itemFound: false };
  const raw = (item.state as Record<string, unknown> | undefined)?.prepForAi;
  return { state: normalizePrepForAi(raw), itemFound: true };
}

/** Replace the Prep-for-AI sub-state on an owned model, preserving the rest of `state`. */
export async function writePrepForAi(
  itemId: string,
  tenantId: string,
  prep: PrepForAiState,
): Promise<boolean> {
  const item = await loadOwnedItem(itemId, ITEM_TYPE, tenantId);
  if (!item) return false;
  const nextState = { ...(item.state || {}), prepForAi: prep };
  const updated = await updateOwnedItem(itemId, ITEM_TYPE, tenantId, { state: nextState });
  return !!updated;
}

/** Parse the model item id out of a data-agent source id (`semantic-model:<id>:<ts>`). */
export function modelIdFromSourceId(sourceId: string): string | null {
  const m = /^semantic-model:([^:]+):/.exec(String(sourceId || ''));
  return m ? m[1] : null;
}

interface EnrichableSource {
  id: string;
  type: string;
  name: string;
  instructions?: string;
  examples?: { question: string; query: string }[];
}

/**
 * For every `semantic-model` source, load the bound model's Verified Answers +
 * AI instructions + exposed-schema and merge them into the source's grounding.
 * Owner-scoped (uses the caller's oid). Non-semantic sources pass through
 * untouched; a model that can't be loaded (deleted / not owned) is a graceful
 * no-op that preserves any hand-authored examples on the source.
 */
export async function enrichSemanticModelSources<T extends EnrichableSource>(
  sources: T[],
  tenantId: string,
): Promise<T[]> {
  if (!Array.isArray(sources) || sources.length === 0) return sources;
  return Promise.all(
    sources.map(async (src) => {
      if (src.type !== 'semantic-model') return src;
      const modelId = modelIdFromSourceId(src.id) || src.id;
      let prep: PrepForAiState;
      try {
        const { state, itemFound } = await readPrepForAi(modelId, tenantId);
        if (!itemFound) return src;
        prep = state;
      } catch {
        return src; // never break the agent run on a lookup error
      }
      // Merge curated Verified Answers into few-shot examples (dedup by question).
      const curated = verifiedAnswersToExamples(prep.verifiedAnswers);
      const existing = Array.isArray(src.examples) ? src.examples : [];
      const seen = new Set(existing.map((e) => e.question.trim().toLowerCase()));
      const mergedExamples = [
        ...existing,
        ...curated.filter((e) => !seen.has(e.question.trim().toLowerCase())),
      ];
      const grounding = composeSourceGrounding(src.instructions || '', prep);
      return {
        ...src,
        instructions: grounding || src.instructions,
        examples: mergedExamples.length ? mergedExamples : src.examples,
      };
    }),
  );
}
