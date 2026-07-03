# CSA Loom — Operations

Day-2 operations for CSA Loom: capacity management, monitoring, cost,
DR, upgrades, forward migration. Customer ops teams can run Loom in
production using this section + the [runbooks](../runbooks/deploy-failure.md).

## Topics

<div class="grid cards" markdown>

-   :material-speedometer: [**Capacity management**](capacity-management.md)

    The CU-equivalent model + per-service scaling. Pause/resume
    patterns. Monitoring capacity-overrun risks.

-   :material-chart-areaspline: [**Monitoring & observability**](monitoring.md)

    Monitoring Hub deep-dive. Pre-built KQL queries. Per-engine
    telemetry sources.

-   :material-cash: [**Cost management**](cost.md)

    Cost-optimization patterns. Pause/resume. ADX hot/cold tiering.
    Power BI smoothing. AOAI provisioned vs PAYG.

-   :material-shield-refresh: [**Disaster recovery**](disaster-recovery.md)

    Per-component DR + RPO/RTO targets. Region pairs. Failover drills.

-   :material-update: [**Upgrade & migration**](upgrade-migration.md)

    Upgrade lifecycle (`azd up` re-run + Console "Updates" pane);
    single-sub → multi-sub conversion; boundary promotion.

-   :material-rocket-launch: [**Forward migration to Microsoft Fabric**](forward-to-fabric.md)

    The strategic anchor: when Fabric reaches your boundary, migrate
    forward 1:1 via OneLake shortcut + per-artifact mapping.

-   :material-broom: [**Clean tenant — purge test/tutorial debris**](clean-tenant.md)

    Sweep `uat-app-*` / `tut-*` / `supercharge-*` workspace debris left by
    UAT/tutorial runs. Cross-partition Cosmos purge, dry-run by default.

</div>

## Day-2 responsibilities (split between Loom + customer)

| Responsibility | Who |
|---|---|
| Container image patching | Loom (push to ACR; customer pulls via Console "Updates") |
| Bicep module updates | Loom (via release tags; customer `azd up` re-runs) |
| Azure resource patching (Databricks runtime, ADX engine, etc.) | Microsoft (managed services) |
| Capacity scaling decisions | Customer (Console "Admin → Capacity") |
| Workspace creation + lifecycle | Customer (Console "Workspaces" pane) |
| Per-workspace member management | Customer (Entra groups) |
| Incident response for customer-data issues | Customer (with Loom runbooks as reference) |
| Loom Console / parity service incidents | Customer first; escalate via GitHub Issues if blocked |

## Runbook index

The full runbook library is at [runbooks section](../runbooks/deploy-failure.md).
Common patterns:

| Runbook | When to use |
|---|---|
| [Deploy failure](../runbooks/deploy-failure.md) | Initial `azd up` or DLZ-add fails |
| [Direct-Lake-Shim stuck](../runbooks/direct-lake-shim-stuck.md) | Power BI semantic model not refreshing |
| [Activator rules not firing](../runbooks/activator-rules-not-firing.md) | Expected Activator action didn't dispatch |
| [Mirroring CDC lag](../runbooks/mirroring-cdc-lag.md) | Mirror is more than N minutes behind source |
| [Copilot throttling](../runbooks/loom-copilot-throttling.md) | AOAI 429s in Console |
| [Capacity overrun](../runbooks/capacity-overrun.md) | CU-equivalent exceeds threshold |
| [DLZ onboard new domain](../runbooks/dlz-onboard-new-domain.md) | Adding agency / mission domain |
| [Forward migrate to Fabric](../runbooks/forward-migrate-to-fabric.md) | Fabric GA in your boundary |
| [Boundary promotion](../runbooks/boundary-promotion.md) | GCC-H → IL5 promotion |
| [Defender AI equivalent SOC](../runbooks/defender-ai-equivalent-soc.md) | Sentinel pipeline health check |
| [MCP troubleshooting](../runbooks/mcp-troubleshooting.md) | MCP server / wizard issues |
| [Purview scan stuck](../runbooks/purview-scan-stuck.md) | Catalog scan stalls |

## SLAs (operational targets)

| Metric | Target |
|---|---|
| Loom Console availability | 99.5% / month |
| Loom Setup Wizard deploy success rate | > 95% |
| Direct-Lake-Shim refresh latency (partition) | p50 < 30 s; p95 < 60 s |
| Activator end-to-end latency | 5-30 s |
| Mirroring CDC steady-state lag | < 60 s |
| Loom Copilot response time | p50 < 3 s; p95 < 10 s |
