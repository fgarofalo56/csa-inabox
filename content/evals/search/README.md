# Federated-search relevance golden sets (SRCH1)

Golden `query → expectedResults` sets for the **/catalog federated search**
(`lib/azure/catalog-search.ts` `searchCatalog` — governance-catalog / AI-Search
ranking with a Cosmos fallback). Extends the WS-E eval machinery to the search
users type into directly.

- One JSONL per domain (`<domain>.jsonl`); rows follow `_schema.json`.
- `expectedResults` target the **demo-seed showcase items**
  (`scripts/csa-loom/demo-seed.mjs`) so the sets are portable across any estate
  where the demo seed has run. They are matched case-insensitively (substring,
  either direction) against each returned result's display name / qualified name
  / id.
- Scored by the **copilot-evaluator Function**'s `searchRelevance` mode
  (`azure-functions/copilot-evaluator`): **hit-rate@k / MRR / NDCG@k**
  (`scoreSearchRelevance`), against the REAL search results returned by
  `POST /api/internal/copilot/search-probe` (which runs `searchCatalog` as the
  configured eval principal `LOOM_EVAL_SEARCH_PRINCIPAL_OID`).
- Floors live under the `searchFloors` key of `content/evals/eval-floors.json`
  and are enforced by `scripts/csa-loom/check-eval-regression.mjs` (E3 ratchet
  mechanics). Scores surface on the **Search relevance** tab of
  `/admin/copilot-quality` (E5).

Azure-native — no Microsoft Fabric / Power BI dependency; the sets ship in the
console image (`copilot-corpus/evals/search/`) so IL5 needs no external fetch.
