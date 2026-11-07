# ADR-003 — Policy XML is never stored or rendered; `loom-*` fragments are the write boundary

**Status:** Proposed 2026-10-28; accepted when W1 (facets) and W2 (fragments) ship. W0 (2026-10-29): the element set the renderers need is authorable on Commercial and GCC-High (`llm-token-limit`, `llm-emit-token-metric`, `trace` with metadata, `validate-azure-ad-token`, `rate-limit-by-key`, `quota-by-key`); `include-fragment` is API-scope only; a fragment PUT answers 201 even for an invalid fragment, which then disappears (GET 404), so apply must verify by read-back (`W0-RECEIPT.md` section 2).
**Mosaic lineage:** ADR 0004 (policy abstraction, fragments as the future write
boundary), 0010 (thin `include-fragment` API policy), 0018 (key headers set in
the fragment).

## Context

Policy documents frequently embed backend URLs with function keys or SAS
tokens, and administrators without APIM expertise should see who may call
which model at what limit, not markup. Loom's Policies pane
(`lib/components/admin/apim-policies-pane.tsx`) is an XML editor because the
Azure portal has one (`ui-parity.md`); that is correct for customer-authored
policies and wrong as the plane's own representation.

## Decision

1. The plane fetches policies, parses them in memory and keeps a SHA-256
   digest plus redacted semantic facets (limits, auth method, backend host
   without query or fragment, included fragment IDs, counted externally
   authored elements). The XML is never persisted in Cosmos, never logged,
   never sent to the browser. Drift detection uses the digest.
2. The plane's enforcement lives in policy fragments named `loom-pub-<slug>`,
   `loom-mcp-<slug>`, `loom-pool-<slug>`; the API policy the plane writes is a
   thin `<include-fragment>` plus the backend/outbound sections that cannot
   live in a fragment (`forward-request` inside `retry`).
3. Renderers are pure functions `render(spec) → { xml, facets, sha256 }`
   covered by snapshot and mutation tests; the XML output is used for the ARM
   write and discarded.
4. The plane never rewrites a customer-authored policy document and never
   takes over a fragment it did not create. Onboarding inventories existing
   fragments and flags `loom-`-shaped ones that are not recorded as
   plane-owned.
5. The existing XML Policies pane remains for customer-authored policies on
   managed gateways; plane-owned fragments render there as read-only with a
   link to the owning publication.
6. Trace metadata values are written as `-` when absent, because APIM fails a
   call with 500 on an empty metadata value (Mosaic amendment 2026-10-01).

## Consequences

- Parser coverage becomes a visible product metric; unrecognised policy is
  shown as "externally authored", never hidden.
- Features that need the original text re-read it from Azure.
- A customer policy that references a plane named value blocks its deletion;
  unpublish reports that step as failed.

## Alternatives rejected

- Storing XML for recovery (Mosaic uses typed applied snapshots instead);
  whole-document rewrites; putting enforcement in the API policy body
  (customers could not include it in their own policies).

## Verification

`renderPublicationFragment` / `renderMcpFragment` mutation receipts; a Cosmos
scan of `apiplane-*` containers for `<policies>` or `<inbound>` returns zero
documents (paired with a positive: facets present on every `policyAnalysis`).
