---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security, governance, dev-loop, data platform
informed: all
---

# ADR 0018 — Fabric Real-Time Intelligence adapter (pre-GA, env-gated)

## Context and Problem Statement

ADR-0010 positions Microsoft Fabric as the strategic target for the
CSA-in-a-Box analytics stack. Fabric Real-Time Intelligence (RTI) is
the Fabric equivalent of our current Event Hub + dbt + ADX pipeline —
it unifies Eventstream ingestion, KQL-queryable Eventhouses, and
Reflex-style alerting inside the Fabric SaaS boundary. Commercial
Fabric customers can consume RTI today (preview programme); **Fabric
RTI is not yet GA in Azure Government** and does not have an ATO
pathway that is acceptable for our federal customers.

The streaming spine (CSA-0137) shipped with adapters for Event Hub,
IoT Hub, and Kafka-via-EH. Adding a Fabric RTI adapter at GA time
would be a breaking change across every downstream (dbt jobs, SLO
monitor, marketplace metadata) because the enum of supported source
types would grow. We need a surface that compiles today, ships with
tests, and surfaces a loud actionable error when RTI is not available
in the operator's tenant — without pretending to route traffic through
a service that isn't there.

## Decision Drivers

- **Fabric strategic alignment (ADR-0010)** — code that targets
  Fabric must be expressible in the contract model today so migration
  is a configuration change, not a rewrite.
- **Gov-GA gate** — federal tenants cannot adopt RTI until Microsoft
  declares Fabric RTI Gov GA. The adapter must refuse to run in
  tenants that haven't opted in.
- **Honest failure modes** — silent fallback to "just log and return
  empty stream" is worse than a loud error that points operators at
  documentation.
- **Offline test discipline** — the adapter must not pull Fabric or
  AAD dependencies at import time; the module has to be importable
  and its tests must run with zero network.

## Considered Options

1. **Env-gated adapter surface with a raise-with-pointer when
   disabled (chosen)** — ship `FabricRTISource` as a full
   `SourceAdapter` implementation today. The constructor reads
   `FABRIC_RTI_ENABLED=true` from the environment; if the flag is
   unset the constructor raises `FabricRTINotAvailableError` whose
   message includes the path to this ADR. When enabled, the adapter
   performs REST-based ingestion via `httpx.AsyncClient` against the
   Fabric RTI eventstream API (see References).
2. **Defer entirely — no surface until Gov GA** — matches ADR-0010's
   "don't build what Fabric will provide" principle but forces a
   breaking schema change across every downstream consumer at GA.
3. **Shim that silently returns empty** — code compiles; tenants don't
   see the gap; observability suffers. Rejected as an anti-pattern.
4. **Route Fabric traffic through Event Hub today** — technically
   feasible (RTI ingests from Event Hub) but muddies the contract
   semantics: the source_type on the manifest would lie about the
   real source-of-record.

## Decision Outcome

Chosen: **Option 1 — env-gated adapter surface.** Implemented in
`csa_platform/streaming/sources_fabric.py`. Key behaviours:

- `SourceType` enum extended with `FABRIC_RTI = "fabric_rti"` — the
  contract manifest explicitly declares Fabric as the source.
- `FabricRTISource.__init__` raises `FabricRTINotAvailableError`
  when `FABRIC_RTI_ENABLED` is missing or not equal to `true`. The
  error message includes a pointer to this ADR so operators finding
  it in logs know where to read the rationale.
- When enabled, the adapter performs REST-based ingestion via
  `httpx.AsyncClient`. The endpoint defaults to
  `https://{workspace}.fabric.microsoft.com/eventstreams/{entity}/events`
  but can be overridden with `FABRIC_RTI_ENDPOINT` for Gov-cloud
  preview tenants.
- Auth: supports a static `FABRIC_RTI_TOKEN` env var (useful for
  local CI) and falls back to `DefaultAzureCredential` with the
  Power BI / Fabric AAD audience
  (`https://analysis.windows.net/powerbi/api/.default`).
- `build_source_adapter` dispatches `source_type=fabric_rti` to
  `FabricRTISource` so the rest of the pipeline (bronze writer,
  silver builder, SLO monitor) is unchanged.

When Fabric RTI reaches Gov GA we flip the gate:

1. Update this ADR (new status: `superseded by NNNN` if the adapter
   surface changes, otherwise amend references only).
2. Remove the env-flag check from the constructor.
3. Document tenant onboarding in `docs/DEPLOYMENT.md`.

## Consequences

- Positive: Code that targets Fabric compiles today — any vertical
  that lists `source_type: fabric_rti` fails fast with a documented
  remediation instead of silently succeeding with no data.
- Positive: The contract manifest is truthful — bronze/silver/gold
  consumers see the real source technology.
- Positive: Tests cover the adapter end-to-end with mocked `httpx`,
  so GA enablement is a one-line change (flip the env flag) with an
  already-green test suite.
- Negative: Operators may hit `FabricRTINotAvailableError` without
  context; mitigated by the ADR pointer in the error message.
- Negative: The REST endpoint shape is pre-GA and may change;
  mitigated by `FABRIC_RTI_ENDPOINT` override and a lazy import so
  the adapter can be patched without touching downstream code.
- Neutral: If Fabric RTI's Gov-GA timeline slips, the adapter's
  pre-GA shape stays in the codebase indefinitely; we document the
  review cadence in the Validation section below.

## Pros and Cons of the Options

### Option 1 — Env-gated adapter surface (chosen)

- Pros: Truthful contract manifests; compiles today; tests today;
  one-line flip at GA.
- Cons: Pre-GA REST shape may drift; ADR must be kept current.

### Option 2 — Defer until Gov GA

- Pros: Zero pre-GA maintenance.
- Cons: Breaking schema change at GA; downstream rewrites.

### Option 3 — Silent empty-stream shim

- Pros: No error paths.
- Cons: Observability black hole; operators ship Fabric configs that
  "work" but deliver no data.

### Option 4 — Route via Event Hub today

- Pros: Delivers real data end-to-end.
- Cons: Contract semantics lie; governance lineage misattributes the
  source; migration to RTI at GA still a breaking change.

## Validation

We will know this decision is right if:

- Every Gov tenant attempting to use `source_type: fabric_rti` today
  surfaces `FabricRTINotAvailableError` (not a silent failure) within
  the first five minutes of running the streaming contract CLI.
- When Fabric RTI reaches Gov GA, the adapter delivers events
  end-to-end with only the env-flag removal plus an endpoint update
  — no schema changes propagate to bronze/silver/gold contracts.
- The ADR is reviewed each quarter; the review is captured under
  `csa_platform/streaming/README.md` "Deferred / known gaps" until
  RTI is GA'd.

## References

- Decision tree:
  [Fabric vs. Databricks vs. Synapse](../decisions/fabric-vs-databricks-vs-synapse.md)
- Microsoft Learn — Fabric Real-Time Intelligence overview:
  https://learn.microsoft.com/fabric/real-time-intelligence/overview
- Microsoft Learn — Eventstreams overview:
  https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview
- Microsoft Learn — Custom app / REST ingestion:
  https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-custom-app
- Related code:
  `csa_platform/streaming/sources_fabric.py`,
  `csa_platform/streaming/tests/test_sources_fabric.py`,
  `csa_platform/streaming/models.py` (SourceType enum extension).
- Related ADRs: **0005** (Event Hubs over Kafka — the interim source
  for RTI-bound pipelines), **0010** (Fabric as strategic target),
  **0013** (dbt as canonical transformation — unchanged by Fabric
  RTI adoption).
- Framework controls: NIST 800-53 **CM-2** (baseline configuration —
  pre-GA adapter surface documented here), **CM-6** (configuration
  settings — `FABRIC_RTI_ENABLED` is the documented baseline-breaking
  setting), **SA-8** (security engineering principles — explicit,
  loud failure is preferred over silent degradation). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0137 follow-ons
