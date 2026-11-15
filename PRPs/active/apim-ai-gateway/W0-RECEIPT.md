# APIM AI gateway Wave 0 receipt (apim-W00)

Measured 2026-11-14/15 at `origin/main` `fd9f80ebe`. Spec: `apim-W00-prerequisite-measurements.md`. Tracking: #4442, #4460. No template, bicep or console file was edited.
Status: **dispatched and verified for the residual policy question (negative: not measurable by the existing probe); not deployed (no deploy happened).** GCC: supported-in-code, never exercised. IL5 (and DoD): supported-in-code, never exercised, no run has executed a deploy step.

## Receipt table

| # | Measurement | Cloud | Method | Run id / command | Result | What result this instrument could NOT have produced |
|---|---|---|---|---|---|---|
| 1 | Premium classic stood up in-boundary | GCC-High | carried from apigw W0 (`PRPs/active/loom-api-gateway-plane/W0-RECEIPT.md`) | Actions run 40975571002 (2026-10-30) | `apim-csa-loom-usgovvirginia`, Premium x1, Internal, Succeeded | Re-dispatch 2026-11-15 (43675290897) authenticated to Gov and ran the `policies` step against the same gateway; it is not an independent stand-up measurement |
| 1 | same | IL5 | none | none | UNEXERCISED: `deploy-fiab-il5.yml` has no deploy receipt | n/a, nothing ran |
| 1 | same | Commercial | carried + re-run | 43675286242 (in-VNet pool runner) | `apim-csa-loom-centralus` PremiumV2 (per prior receipt; this run's `policies` step executed against it) | It cannot show the Commercial estate pause state; the paused data services (ADX, Synapse pool, AAS, gateway VM) do not feed the `policies` family |
| 2a | `llm-token-limit`, `llm-emit-token-metric`, `trace`, `validate-azure-ad-token`, `rate-limit-by-key`, `quota-by-key` authorable (PUT 201 then GET 200, element read back) | Commercial | existing `apiplane-w0-commercial-probe.yml -f families=policies` | 43675286242 (job executed 16 steps; step `policies` exit 3) | 6 of 6 accepted and read back, positive control passed, cleanup 0 leftovers | A value that PUTs 201 and is later dropped: the read-back (GET) is the verdict, and a 201 alone was never counted |
| 2a | same | GCC-High | existing `apiplane-w0-gov-probe.yml -f families=policies` | 43675290897 (job executed 18 steps; not held at the `gcc-high-deploy` approval; `policies` exit 3) | 6 of 6 accepted and read back, positive control passed, cleanup 0 leftovers. Identical to run 40975571002 | Runtime behaviour: authoring only, no request was sent through the gateway |
| 2b | `include-fragment` inside a fragment, combined fragment, negative control (bogus element) | Commercial, GCC-High | same two runs | 43675286242, 43675290897 | `unknown:tooling-error` x10 per cloud, same signature as before: PUT 201 then GET 404 (async drop). The PUT status is not a verdict. The negative control also reads unknown, so the instrument cannot distinguish a rejected element from a transient drop | A "rejected" verdict for any element: the bogus-element control itself came back 201 then 404, so no 404 can be read as "this element is invalid" |
| 2c | `llm-token-limit` runtime ENFORCEMENT (observed 429) | GCC-High | none possible | not measurable from Actions: the gateway is VNet-internal and the hosted runner cannot reach it (apigw W0 section 6, run 40975571002; unchanged) | NOT MEASURED | Any status code from the gateway: no request was sent |
| 2d | `llm-semantic-cache-lookup/-store`, `llm-content-safety` authoring | Commercial, GCC-High | not measurable with the existing probe: its `ELEMENTS` list (`scripts/measure/apiplane/_w0-policies.mjs`) has none of the three, and `-f families` selects families, not elements | none dispatched | NOT MEASURED. Adding them means editing `_w0-policies.mjs` and its tests, which is outside this wave's declared ownership (only the workflow file is). Needs an owner decision | Any verdict on those three elements |
| 2e | policy authoring | GCC, IL5 | none | none | UNMEASURABLE: no GCC tenant; IL5 never deployed | n/a |
| 3 | Prompt Shields availability | GCC-High, IL5 | curl of Learn pages, grep `gov|sovereign|fedramp|usgov|dod|il[2456]` | see below | **UNVERIFIED** (Learn does not state it) | A positive "available in Azure Government": no page names it. Also not "unavailable": absence of a statement is not a statement |
| 4 | Q5 SKU decision | Commercial/GCC/DMLZ and Premium classic in GCC-High/IL5 | decision record | `REFERENCE.md` 2.4 (answered 2026-10-29) | stay on PremiumV2; Premium classic in GCC-High/IL5 | Not re-measured here; orchestrator to confirm it is recorded on #4442 |
| 5 | #4458 IL5 `/contentsafety` fallback in audit scope | IL5 | `gh issue view 4458` comments (4, latest 2026-10-04) | none | **NO DETERMINATION.** The operator gave none in this session; no comment on #4458 states one | A determination: the comments are leads and a partial fix (#4912), not a decision |
| 6 | `azure-api.net` private-DNS A records | Commercial DMLZ | read-only `az` with `--subscription e093f4fd-5047-4ee4-968d-a56942c665f3` | commands below | one A record: `apim-csa-loom-centralus` -> 10.0.4.4; zone has 2 record sets (SOA + that A), 1 VNet link `link-apim-console` (registration off) to `vnet-csa-loom-hub-centralus` | A record in another resource group or subscription: only `rg-csa-loom-admin-centralus` was listed |

## Task 3 detail (Learn, fetched 2026-11-14)

| Page | ms.date | Names Azure Government for Prompt Shields? |
|---|---|---|
| https://learn.microsoft.com/en-us/azure/ai-services/content-safety/overview | 2026-11-06 | No (0 lines matching azure government / sovereign / fedramp / usgov) |
| https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection | 2026-08-28 | No (0 gov lines; 21 mentions of Prompt Shields) |
| https://learn.microsoft.com/en-us/azure/ai-services/content-safety/region-availability | 2026-09-18 | No (0 gov lines; 10 mentions of Prompt Shields) |
| https://learn.microsoft.com/en-us/azure/azure-government/compare-azure-government-global-azure | 2025-08-21 | No Content Safety row; only Content Moderator features are listed as unavailable |

Positive controls: the region page matches `east us|sweden` (2 lines) so the grep reads a real region table; the Government comparison page returns 108 `azure government|usgov|fedramp` matching lines through the same pipeline. Verdict: **UNVERIFIED** for GCC-High and IL5. The IL5 gap row stays open and `apim-WD-service-families` must not claim the substitute is complete. The audit-scope table (REFERENCE.md 3.4) is separate evidence: `Foundry: Azure AI Content Safety` is blank at IL4/IL5WI/IL6.

## Task 5: what exactly needs deciding (#4458)

Is the IL5 default screening path (the multi-service AIServices account's `/contentsafety` data plane) in DoD IL5 audit scope, given the governing capability row `Foundry: Azure AI Content Safety` is blank at IL4/IL5WI/IL6? Until that is answered: **IL5 must not be deployed**, and `il5.bicepparam` keeps `contentSafetyEnabled = false`.

## Task 6 commands and output

```
SUB=e093f4fd-5047-4ee4-968d-a56942c665f3 ; RG=rg-csa-loom-admin-centralus
az network private-dns zone list --subscription $SUB --query "[?name=='azure-api.net'].{...}"
  -> name=azure-api.net rg=rg-csa-loom-admin-centralus records=2 links=1   (rc 0)
az network private-dns record-set a list --subscription $SUB -g $RG --zone-name azure-api.net
  -> apim-csa-loom-centralus  10.0.4.4                                      (rc 0)
az network private-dns link vnet list --subscription $SUB -g $RG --zone-name azure-api.net
  -> link-apim-console reg=false vnet=.../vnet-csa-loom-hub-centralus       (rc 0)
```

Positive control: the zone query returned the known zone and the record query returned the known `apim-csa-loom-centralus` record through the same command, so the one-row result is not an empty-by-blindness read. Same as 2026-09-11. Consequence unchanged: a linked private zone is authoritative for `*.azure-api.net`, so any second APIM instance or workspace-gateway hostname needs its own A record. The design needs none that is missing today.

## Run ledger

| Run | Workflow | Result |
|---|---|---|
| 43675286242 | `apiplane-w0-commercial-probe` `-f families=policies` | job failure by design (exit 3, 10 unknown cells); precheck 3 steps, probe 16 steps |
| 43675290897 | `apiplane-w0-gov-probe` `-f families=policies` | job failure by design (exit 3, 10 unknown cells); precheck 3 steps, probe 18 steps; no approval wait |

Both red runs gate nothing; the same shape as 40974529572 / 40975571002.

## Open items for the orchestrator or operator

1. #4458 determination (task 5), blocks any IL5 deploy.
2. Decide whether to extend `_w0-policies.mjs` with `llm-semantic-cache-*` and `llm-content-safety` (task 2d); a standalone fragment may fail for missing cache/embeddings backend rather than boundary reasons, so design the fixture first.
3. Record Q5 on #4442 if absent; post the drafted comments (`W0-COMMENT-4442.md`, `W0-COMMENT-4460.md`).
