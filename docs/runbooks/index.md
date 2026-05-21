# Runbooks

Operational playbooks for responding to incidents and routine maintenance on the CSA-in-a-Box platform. Each runbook is structured for first-responder use: detection signals, triage steps, mitigation, root-cause analysis, and links to the relevant ADRs and code.

## Incident response

| Runbook                                                             | When to use                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Break-Glass Access](break-glass-access.md)                         | Emergency elevation when normal access paths are unavailable                      |
| [Security Incident](security-incident.md)                           | Suspected breach, credential exposure, or anomalous activity                      |
| [Data Pipeline Failure](data-pipeline-failure.md)                   | ADF/Databricks pipeline failures, retry exhaustion, dead-letter overflow          |
| [Dead Letter Queue](dead-letter.md)                                 | Drop-event triage from streaming and batch pipelines                              |
| [DR Drill](dr-drill.md)                                             | Quarterly disaster-recovery exercises and the live failover playbook              |
| [Purview Scan Failure](purview-scan-failure.md)                     | Catalog scans not completing or returning unexpected results                      |
| [Azure OpenAI Throttling](openai-throttling.md)                     | 429s from Azure OpenAI; capacity reallocation                                     |
| [Databricks Cost Runaway](databricks-cost-runaway.md)               | Spend anomaly response for Databricks clusters                                    |
| [Cost Alert Response](cost-alert-response.md)                       | Budget threshold response across the platform                                     |

## Routine operations

| Runbook                                                             | When to use                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Certificate Expiration](certificate-expiration.md)                 | Pre-emptive cert rotation and last-minute renewal                                 |
| [Key Rotation](key-rotation.md)                                     | Scheduled rotation of Key Vault keys and secrets                                  |
| [Azure Deployment Service Principal](azure-deployment-principal.md) | Managing the `limitlessdata_deploy` SP used by CI/CD                              |
| [Copilot Studio Agent Rotation](copilot-studio-agent-rotation.md)   | Refreshing Copilot Studio agent registrations                                     |
| [Fabric Capacity Management](fabric-capacity-management.md)         | Scaling Fabric SKUs up/down based on workload                                     |
| [Tenant Onboarding](tenant-onboarding.md)                           | Adding a new tenant to multi-tenant landing zones                                 |
| [Portal Rollout Strategy](portal-rollout-strategy.md)               | Staged portal release process                                                     |
| [dbt CI](dbt-ci.md)                                                 | dbt pipeline CI workflow, hotfixes, and rerun playbook                            |
| [Release-Please Status Bypass](release-please-bypass.md)            | Working around release-please CI status when it stalls                            |

## Related

- [Disaster Recovery](../DR.md) — strategy and RTO/RPO targets
- [Multi-Region](../MULTI_REGION.md) — failover topology
- [Production Checklist](../PRODUCTION_CHECKLIST.md) — pre-cutover validation
- [Troubleshooting](../TROUBLESHOOTING.md) — diagnostic flowcharts
