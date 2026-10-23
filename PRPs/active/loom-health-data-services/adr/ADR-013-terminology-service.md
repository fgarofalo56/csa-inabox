# ADR-013 — Terminology service and bundled vocabularies

Status: Proposed. Date: 2026-10-22. Evidence: `../research/terminology-conformance-ops-facts.md` section A (licences, retrieved 2026-10-22).

## Decision
- Engine: the HAPI FHIR terminology module (same engine as ADR-001; CodeSystem /
  ValueSet / ConceptMap, `$lookup`, `$validate-code`, `$expand`, `$translate`,
  `$subsumes`), deployed as a dedicated Deployment per stamp against a
  stamp-level `terminology` database (shared read-only content) plus a
  per-tenant database for customer-loaded content. Snowstorm (SNOMED-specific,
  Apache-2.0, licence text UNVERIFIED in research) is the optional
  SNOMED-grade server a customer may add; not bundled.
- **Bundled (ship in the image feed, with the required notices)**: LOINC
  (licence permits incorporation with the fixed notice), UCUM, HL7 THO and the
  FHIR spec terminology (CC0), ICD-10-CM / ICD-10-PCS, HCPCS Level II, CVX /
  MVX, NDC, MED-RT, RxNorm *Prescribable Content* subset (no licence
  required), HGNC (CC0), NCIt (CC BY 4.0), US Core ValueSets that reference only
  the above.
- **Customer-loaded under their own licence (never bundled)**: SNOMED CT (US
  Edition via NLM, UMLS licence; Affiliate licence for the vendor is Decision
  D8), full RxNorm (UMLS), VSAC value sets (UMLS; the VSAC FHIR API needs the
  customer's API key), CPT (AMA — confirmed not bundleable), ATC/DDD (WHO:
  commercial redistribution not allowed), NUCC taxonomy (licence form for
  commercial products). The loader UI accepts the customer's files/API key;
  the honest gate says exactly which licence is needed.
- Packaging: each vocabulary is a versioned package (FHIR NPM package format
  where one exists) in a Blob feed mirrored per cloud; stamps pull from the
  feed (no egress to Regenstrief/NLM at runtime); a tenant pins versions.
- Attribution: the notices page in the Loom console lists every bundled
  vocabulary with its licence text and version (W4 receipt includes it).

## Consequences
`$expand` of large SNOMED value sets is customer-dependent; the terminology
database per stamp is a few GB and rebuildable.

## Reversal cost
Low.
