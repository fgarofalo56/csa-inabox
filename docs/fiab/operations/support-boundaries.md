# CSA Loom — v1 support boundaries

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.

This page states, plainly, what the CSA Loom **v1** release does and does not
support along two axes that operators ask about first: **language/localization**
and **availability/DR**. It exists so that no one has to infer these limits from
the bicep or discover them in production. Both boundaries are deliberate v1 scope decisions,
not defects, and both are honest per the `no-vaporware`
(`.claude/rules/no-vaporware.md`) rule — we do not claim a capability the
deployment does not ship.

## Language & localization — English (en-US) only

**CSA Loom v1 is English (en-US) only.** The Console and every editor, admin
page, Copilot surface, tutorial, and system message render in US English. There
is **no internationalization (i18n) framework in v1**:

- The Console (`apps/fiab-console`) carries **no i18n dependency** — there is no
  `next-intl`, `react-i18next`, `i18next`, `LinguiJS`, or `formatjs` in the app.
  All user-visible strings are authored inline in English.
- There is **no locale switcher, no translation catalog, and no
  right-to-left (RTL) layout support.** The document language is fixed
  (`<html lang="en">` in `apps/fiab-console/app/layout.tsx`).
- Numbers, dates, and currency render with default (en-US) formatting; they are
  not localized per user locale.

**What this means for operators:** deploy and operate Loom as an English-language
platform. Data you ingest, catalog, and analyze can of course be in any language
— this boundary is about the **product UI chrome**, not your content. Non-English
UI is a candidate for a future release; it is not wired in v1, and adding it
would require introducing an i18n framework and externalizing every string.

## Availability & DR — in-region zone redundancy + redeploy-from-Git

**CSA Loom v1 is a single-region deployment with in-region zone redundancy.**
There is **no multi-region active/passive topology and no automatic cross-region
failover** wired by default. The availability model rests on three real,
verifiable mechanisms:

1. **Zone redundancy inside the region (compute).** The Container Apps
   Environment that hosts every Loom app is provisioned
   `zoneRedundant: true`
   (`platform/fiab/bicep/modules/admin-plane/container-platform.bicep`), so the
   application plane spreads across availability zones and survives a single-zone
   outage.
2. **Zone-redundant storage + point-in-time restore (state).** The data-lake
   storage account is `Standard_ZRS` and the Console's Cosmos account runs
   continuous backup (`Continuous7Days`). The Cosmos accounts are configured
   **single-write-region with `enableAutomaticFailover: false`**
   (`platform/fiab/bicep/modules/landing-zone/cosmos.bicep`) — deliberately, so
   there is no silent, undocumented cross-region behavior.
3. **Redeploy-from-Git (recovery).** Every app is a stateless container built
   from this repository; regional recovery is a Bicep re-deploy + image roll into
   a healthy region, plus a metadata restore — not an always-on hot standby.

Anything stronger than this — cross-region active/passive, geo-redundant (GRS /
RA-GRS) backup, a follower/replica cluster — is an **opt-in** the operator
enables deliberately. The full per-component RPO/RTO breakdown, the redeploy
recovery drill, and the opt-in upgrades live in
[Disaster recovery](disaster-recovery.md).

**What this means for operators:** Loom v1 tolerates a **zone** failure inside
its region transparently; it does **not** provide automatic **region** failover.
For a regional outage, recovery is the documented redeploy-from-Git path with an
RTO measured in the time to re-provision + roll images + restore Cosmos, and an
RPO bounded by the continuous-backup window. If your mission requires
active/passive multi-region, treat it as an explicit design decision on top of
v1 and follow the opt-in guidance in the DR page.

## Summary

| Axis | v1 support boundary | Detail |
|---|---|---|
| Language / localization | **English (en-US) only** — no i18n framework, no locale switcher, no RTL | This page, [`layout.tsx`](https://github.com/fgarofalo56/csa-inabox/blob/main/apps/fiab-console/app/layout.tsx) |
| Availability | **Single region, in-region zone redundancy** — no automatic cross-region failover | [Disaster recovery](disaster-recovery.md) |
| DR model | **Redeploy-from-Git + Cosmos PITR** — stronger topologies are opt-in | [Disaster recovery](disaster-recovery.md), [Cosmos PITR restore](../runbooks/cosmos-pitr-restore.md) |

## Related

- [Disaster recovery](disaster-recovery.md) — full RPO/RTO + opt-in stronger DR
- [Operations index](index.md)
- [Capacity management](capacity-management.md)
