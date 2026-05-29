---
title: CSA Loom - v1 Final Status + v2 Realistic Plan
date: 2026-05-24
---

# CSA Loom - v1 Final Status (live deploy)

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


## Reachability matrix (validated end-to-end with Playwright)

| Path | URL | Status |
|---|---|---|
| Bastion -> jumpbox -> Console (internal FQDN) | `https://loom-console.internal.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io` | works (UAT iter 1) |
| Bastion -> jumpbox -> Console (external FQDN) | `https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io` | works (UAT iter 2 GREEN, 8/8) |
| **Front Door Premium public URL** | `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/` | **HTTP 200, Playwright 8/8 from laptop** |
| **App Gateway public URL** | `http://loom-m56yejezt7bjo.eastus2.cloudapp.azure.com/` | **HTTP 200, Playwright 8/8 from laptop** |
| VPN Gateway (P2S OpenVPN + AAD auth) | provisioning (~30-45 min) | will be ready by ~T+45min |

Console is **publicly reachable on two independent paths** + the private
path. That's the SaaS-feel reach.

## Backend app state

| App | v0.1 | v0.2 (PR #327) | v0.3 (PR #329 - rebuilding) |
|---|---|---|---|
| `loom-console` | Healthy | n/a | n/a |
| `loom-setup-orchestrator` | Healthy | Healthy | building |
| `loom-mcp` | unhealthy | wrong dll name | fixed (azmcp.dll) |
| `loom-activator` | unhealthy (DI) | unhealthy (WORKSPACE_ID throw) | fixed (soft-idle) |
| `loom-direct-lake-shim` | unhealthy | unhealthy (EVENTGRID_QUEUE throw) | fixed (soft-idle) |
| `loom-mirroring` | unhealthy | Kafka unavailable | warns + retries; needs real Event Hubs Kafka |

Once PR #329 + image rebuild (run 26353261632) lands, all 4 problem
workers should reach Healthy on their v0.3 images.

## What's NOT 100%

- **BFF API auth**: `/api/workspaces` etc. return 401. No MSAL token wired. Pane shells render, but data fetches require authenticated session. ~1-2 days of OBO + Entra app reg + token cache work.
- **Worker -> real backing services**: Cosmos / Redis / Service Bus / Event Hubs Kafka exist (DLZ side) but env vars aren't wired per app. v1.1 punch list.
- **Authenticated Playwright UAT**: smoke is unauth'd; need test user / SP-as-user. Tied to BFF auth above.

## What IS 100%

- Infrastructure (admin plane + DLZ + Bastion + ACR + KV + AppInsights + LAW + all PE/DNS plumbing)
- All 6 Container Apps deployed
- 3 access patterns deployed (Front Door Premium + App Gateway v2 + WAF; VPN still provisioning) + WAF + managed certs
- DNS, peering, jumpbox, Playwright UAT plumbing
- 8 Console panes render with active nav highlighting on every pane
- 2 PUBLIC HTTPS URLs working

---

# v2 - honest scope

User asked for "do all of v2". The v2 backlog in `PRPs/v2/README.md`
sizes at **6-9 months of engineering at v1 pace** (14 capabilities, 2
already stubbed):

| # | PRP | Sized |
|---|---|---|
| 26 | Data Marketplace | XL |
| 27 | OneLake Alternative (shortcuts across ADLS / S3 / GCS / Delta) | XL |
| 28 | APIM API Builder for Data Sharing | L |
| 29 | Function API Management | M |
| 30 | AI/ML API Management | L |
| 31 | Complete Dev Portal + Dev Tools (Backstage-like) | XL |
| 32 | Metadata-Driven Data Source Onboarding | L |
| 33 | Domain Management (DDD-style + stewards) | M |
| 34 | New DLZ Deployment + Setup (operator UI) | M |
| 35 | dbt Builder (visual + code) | L |
| 36 | Complete Shortcut Builder (Fabric parity) | M |
| 37 | Data Virtualization Builder + Manager | XL |
| 38 | Complete Telemetry / Monitoring / Performance / Auditing / Data Obs (DMLZ + DLZ) | L |
| 39 | Complete Set of Power BI Reports (mgmt + ops + cost + lineage) | M |
| 40 | Copilot Agent (in-UI, scoped, can-DO) | XL |

XL = 6-12 weeks each. M = 1-3 weeks. L = 3-6 weeks. Sum: **~36-60
engineer-weeks**.

I cannot ship that in this session, or any one session. Pretending
otherwise would mean stubs labeled as "complete" - which would burn
the v1 credibility we just earned.

## What I CAN deliver in subsequent sessions

Per session, I can take **one v2 PRP** from sized to:

1. Full research doc (parity with Fabric / Snowflake / Databricks)
2. Architecture decisions (ADRs)
3. Bicep modules (real, deployable)
4. App scaffold(s) (Next.js panes, FastAPI/worker code)
5. Wired into existing Console (left nav, telemetry, RBAC)
6. UAT plumbing
7. Docs + runbooks

Each session targets **one PRP to "working in dev"**. A working v2
of all 14 capabilities at this fidelity is realistically **12-18
sessions over 3-6 calendar months** if focused 4-6 hours per session.

## Recommended v2 sequencing

Highest leverage first (each one unblocks the next):

1. **PRP-32 Metadata-Driven Source Onboarding** - foundation for marketplace, virtualization, dbt
2. **PRP-33 Domain Management** - the org primitive everything else attaches to
3. **PRP-26 Data Marketplace** - the user-facing product story
4. **PRP-28 APIM API Builder + PRP-29/30 API Mgmt** - how marketplace products get exposed
5. **PRP-36 Shortcut Builder + PRP-37 Data Virt** - how products reach data without copy
6. **PRP-35 dbt Builder** - how products get transformed
7. **PRP-31 Dev Portal** - the operator surface for everything above
8. **PRP-38 Telemetry + PRP-39 Power BI Reports** - observability over the above
9. **PRP-27 OneLake Alternative** - reshape the storage layer
10. **PRP-34 New DLZ Operator UI** - self-service expansion
11. **PRP-40 Copilot Agent** - last, because it needs all the surfaces above to exist before it can drive them

## To start v2 right now

Tell me which v2 PRP you want first. I'll execute it as the next
session's full focus.
