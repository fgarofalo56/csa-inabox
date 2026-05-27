# Parity-gap — `app-rag-builder` (RAG Builder)

**Grade: F (Vaporware)** — See `apps-catalog-rollup.md` for shared root cause.

Surface: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/apps/app-rag-builder`
Validated: 2026-05-26
Screenshot: `temp/parity/apps/app-rag-builder.png`

## What the card claims

Description: "Stand up a Retrieval-Augmented Generation pipeline. Builds an AI Search
index, wires Foundry prompt-flow, deploys an evaluation suite."

Designed bundle: `ai-search-index` + `prompt-flow` + `evaluation` items.

## What actually happens

- Detail page renders, Category=AI, by CSA
- `Bundled items (0)` + "This app doesn't bundle any items yet."
- Install button **disabled**
- Direct API install returns `200 { installed: [] }`

## Verdict

F — promises a three-step RAG provisioning workflow (index, prompt-flow, eval),
delivers nothing. The AI Search + Foundry endpoints those items would call also are
unverified (Foundry endpoint is documented as 501 unless `LOOM_FOUNDRY_PROJECT_ENDPOINT`
is set per existing memory).
