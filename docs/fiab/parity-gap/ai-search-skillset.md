# ai-search-skillset — parity gap (validator v2, 2026-05-26)

**Status**: **NOT IN REGISTRY**

The validator prompt called this out as expected — `ai-search-skillset` is not in `apps/fiab-console/lib/editors/registry.ts`.

## Confirmation

```
$ grep "ai-search-skillset" apps/fiab-console/lib/editors/registry.ts
# (no matches)
```

The fabric item types catalog (`apps/fiab-console/lib/catalog/fabric-item-types.ts`) may or may not declare a `ai-search-skillset` slug — but regardless, no editor component is mapped, so the URL `/items/ai-search-skillset/new` would either 404 or render the generic empty-state shell.

## What Fabric/Portal has

The Azure Portal "Skillsets" surface for AI Search includes:
- Cognitive Services attach (vision / language / OCR / sentiment / entity-recognition / KPE / translation)
- Custom skill (Azure Function / Web API) wizard with input/output schema
- Indexer wiring (data source + index + schedule + field mapping)
- Skill output cache + debug session UI
- Sample skillset templates (RAG, document cracker, OCR-then-translate)

## Grade — **F — not built**

Missing editor entirely. **Grade F (vaporware by omission)** — but the prompt anticipated this, so it's not a regression; it's a known gap to backlog.
