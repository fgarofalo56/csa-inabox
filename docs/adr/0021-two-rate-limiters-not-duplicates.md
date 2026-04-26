---
status: accepted
date: 2026-04-26
deciders: csa-inabox platform team
consulted: security audit, RAG engineering, portal engineering
informed: ops, contributors
---

# ADR 0021 — Two rate limiters are not duplicates

## Context

The deep code review flagged two modules named `rate_limit.py` as a
suspected duplicate token-bucket implementation that should be unified:

- `csa_platform/ai_integration/rag/rate_limit.py` (356 LoC)
- `portal/shared/api/observability/rate_limit.py` (281 LoC)

This ADR records the verdict after reading both modules and confirms
they are intentionally separate.

## Decision

**Keep both modules.  Do not unify.**  They share a noun but solve
different problems.

| Dimension | `csa_platform/.../rag/rate_limit.py` | `portal/.../observability/rate_limit.py` |
|-----------|--------------------------------------|------------------------------------------|
| **Direction** | Outbound (we are the client) | Inbound (we are the server) |
| **Counterparty** | Azure OpenAI control-plane quotas (RPM + TPM) | Untrusted HTTP callers hitting portal routes |
| **Algorithm** | `asyncio.Semaphore` + custom token bucket + tenacity exponential backoff that honours `Retry-After` headers from 429 responses | `slowapi` over `limits` — sliding-window keyed on principal (object-id) with SHA-256 truncation, fallback to remote IP for unauthenticated routes |
| **Backend** | In-process state, single async event loop | In-memory by default, swap-in Redis via `PORTAL_RATE_LIMIT_STORAGE_URI` for multi-replica deployments |
| **Key dimension** | Per Azure OpenAI deployment (one global budget) | Per principal, per route |
| **Failure mode** | Raises `RateLimitExhausted` after N retries -> caller renders a "try again later" message | Returns HTTP 429 from middleware -> client retries |
| **Configuration knobs** | RPM, TPM, retry attempts, backoff multiplier | Per-route env vars: `PORTAL_RATE_LIMIT_<ROUTE>_PER_MINUTE` |
| **Activation** | Always on once the RAG service is constructed | Feature flag `PORTAL_RATE_LIMIT_ENABLED` (off by default for backward compat) |
| **Audit trail (ADR / ticket)** | CSA-0108 (RAG production hardening) | CSA-0030 / ADR 0020 (portal observability + rate limit) |
| **Test surface** | Integration tests with mock 429 responses + tenacity backoff timing | Slowapi unit tests + middleware integration tests |

## Consequences

### Why unifying would be worse

1. **Different libraries.**  `tenacity` is a retry library that fits
   the outbound case where we want exponential backoff with header
   awareness.  `slowapi` is an HTTP middleware that fits FastAPI's
   request lifecycle.  A unified abstraction would either force
   `slowapi` to do retries it was not designed for, or force the RAG
   client to learn about HTTP middleware ergonomics.

2. **Different ownership.**  Outbound limits are owned by the AI team
   responding to Azure OpenAI quota tickets.  Inbound limits are
   owned by the SRE team responding to abuse reports.  Coupling the
   two means every quota change requires both teams to review.

3. **Different scaling story.**  The RAG limiter is single-process by
   design (one async loop owns the bucket).  The portal limiter must
   federate across N replicas via Redis.  A common abstraction would
   either drag the RAG path through Redis or expose the portal to a
   non-shared in-memory limiter.

### What this ADR does NOT preclude

- A future `csa_platform/common/concurrency/` helper for shared
  primitives (e.g. a reusable async semaphore wrapper) is fine.  The
  point is that the *policy* and *integration surface* differ, not
  the underlying primitives.
- If a third use case appears that genuinely matches the RAG
  outbound-with-header-aware-retry pattern (e.g. an Azure AI Search
  client), it should reuse `AzureOpenAIRateLimiter` rather than
  invent a fourth.

## Alternatives considered

- **Unified rate limiter with adapter pattern.**  Rejected — the
  unifying interface ends up with so many optional kwargs that the
  per-call site becomes harder to read than the two specialized
  classes.
- **Drop the RAG limiter and rely on tenacity bare.**  Rejected — we
  need the semaphore to bound concurrency before we ever hit a 429,
  not just to recover from one.
- **Drop the portal limiter and rely on Azure Front Door / APIM
  quotas.**  Rejected — the portal must be deployable without an APIM
  in front (lab/dev).  We also want per-principal limits inside the
  app for fairness, which APIM cannot do without expensive policy
  scripting.

## Status

Accepted.  No code change.  This ADR exists to close a recurring
review-loop question.
