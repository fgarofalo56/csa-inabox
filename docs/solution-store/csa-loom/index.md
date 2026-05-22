# CSA Loom — Solution Store Accelerator

![CSA Loom — Microsoft Fabric parity in Azure Government](../../assets/images/hero/fiab/index.svg){ .architecture-hero loading="eager" }

CSA Loom is a productized Microsoft Fabric parity layer that deploys
into any Azure tenant where Fabric isn't yet generally available.
Federal, DoD, intelligence community, state + local, defense
industrial base, and regulated commercial verticals.

## What you get

- **Loom Console** — Next.js + Fluent UI v9 SaaS UI that mirrors the
  Microsoft Fabric workspace experience
- **Loom Setup Wizard** — conversational deploy with live `.bicepparam`
  preview backed by self-hosted Azure MCP
- **Parity services** that fill Fabric-only gaps (Direct-Lake Shim,
  Activator Engine, Mirroring Engine, Data Agents)
- **Two-tier deployment** — `azd up` CLI or "Deploy to Azure" button
- **Forward-migration tooling** — to Microsoft Fabric when your
  boundary reaches GA

## Quickstart

[60-minute Quick Start →](../../fiab/deployment/quickstart.md)

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox/platform/fiab/azd
azd init -t .
azd up
```

## Architecture

[Reference Architecture →](../../fiab/architecture.md)

## Per-boundary support

| Boundary | v1 (now) | v1.1 (+3 mo) |
|---|---|---|
| Azure Commercial | ✅ | — |
| GCC | ✅ | — |
| GCC-High / IL4 | ✅ | — |
| DoD IL5 | — | ✅ |

## Cost

CSA Loom IP is **free in v1**. You pay only for Azure consumption
underneath:
- Sample F8 Commercial deployment: ~$3-5K/month
- Sample F8 GCC-High deployment: ~$4-6K/month

[Detailed cost breakdown →](../../fiab/operations/cost.md)

> **Marketplace listing + pricing model deferred to backlog.**
> See [`docs/fiab/deployment/marketplace.md`](../../fiab/deployment/marketplace.md)
> for the future pricing roadmap placeholder.

## Resources

- [Documentation pillar](../../fiab/index.md)
- [Source code on GitHub](https://github.com/fgarofalo56/csa-inabox)
- [Epic / build roadmap](https://github.com/fgarofalo56/csa-inabox/issues/279)
- [5-day Cloud CoE workshops](../../fiab/workshops/index.md)
- [Marketing kit](../../fiab/marketing/pitch-deck.md)

## How CSA Loom relates to other CSA accelerators

The [API-First Data Strategy accelerator](../api-first/index.md)
covers the integration layer (APIM + Dataverse + cross-platform
APIs). CSA Loom covers the analytics + lakehouse + BI layer for
audit-boundary-blocked customers.

Both pillars share the csa-inabox foundation (Bicep, Copilot
backend, MkDocs Material).

## Forward migration

CSA Loom forward-migrates 1:1 to Microsoft Fabric when Fabric
reaches your audit boundary. Delta tables via OneLake shortcut
(zero data movement); dbt + KQL port unchanged; semantic models
re-author for Direct Lake on OneLake. See
[forward-migration runbook](../../fiab/runbooks/forward-migrate-to-fabric.md).
