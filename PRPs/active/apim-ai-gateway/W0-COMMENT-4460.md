DRAFT, not posted. Orchestrator posts.

Wave 0 measurement for #4460 (apim-W00, receipt `PRPs/active/apim-ai-gateway/W0-RECEIPT.md`).

Authoring only, not runtime. Re-dispatched the existing probes with `families=policies`:
- Commercial run 43675286242 and GCC-High run 43675290897: `llm-token-limit` and `llm-emit-token-metric` are accepted and read back (PUT 201, GET 200) on both gateways. This matches apigw W0 (runs 40974529572, 40975571002).
- So `aoaiLlmPoliciesSupported = !isSovereign` has no authoring evidence behind it for these two elements in GCC-High.
- Not measured: `llm-semantic-cache-lookup/-store` and `llm-content-safety` (the probe does not author them), runtime enforcement (no 429 observed; the gateway is VNet-internal and unreachable from Actions), GCC and IL5 (never exercised).
- Caveat: a PUT can return 201 and then 404 on read-back. Ten cells per cloud (combined fragment, include-fragment in a fragment, the negative control) show that, so only the read-back counts.

Merged, not deployed. No bicep changed.
