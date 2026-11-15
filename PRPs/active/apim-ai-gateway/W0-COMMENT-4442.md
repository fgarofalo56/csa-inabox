DRAFT, not posted. Orchestrator posts.

Wave 0 status (apim-W00, receipt `PRPs/active/apim-ai-gateway/W0-RECEIPT.md`):

- Task 1: GCC-High has Premium classic (`apim-csa-loom-usgovvirginia`). IL5 unexercised (no deploy run). GCC supported-in-code, never exercised.
- Task 2: authoring of `llm-token-limit`, `llm-emit-token-metric`, `trace`, `validate-azure-ad-token`, `rate-limit-by-key`, `quota-by-key` read back on Commercial (run 43675286242) and GCC-High (run 43675290897). Semantic-cache and content-safety authoring not measurable with the existing probe; runtime 429 on GCC-High not measurable from Actions.
- Task 3: Prompt Shields in Azure Government is UNVERIFIED; four Learn pages (ms.date 2025-08-21 to 2026-11-06) do not name it. IL5 gap stays open.
- Task 4 (Q5): PremiumV2 on Commercial/GCC/DMLZ, Premium classic in GCC-High/IL5 (answered 2026-10-29).
- Task 5: NO DETERMINATION on #4458. IL5 must not be deployed until one exists.
- Task 6: `azure-api.net` private zone, DMLZ: a single A record, `apim-csa-loom-centralus` -> 10.0.4.4, one VNet link. Unchanged since 2026-09-11. Any second APIM or workspace-gateway hostname needs its own record.

Nothing deployed; no template edited.
