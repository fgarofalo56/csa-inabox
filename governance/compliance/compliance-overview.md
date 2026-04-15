# Data Platform Compliance Documentation

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Security / Compliance

## Overview

CSA-in-a-Box is designed to meet enterprise compliance requirements for data platforms
deployed on Microsoft Azure. This document covers data residency, encryption, access
controls, and audit capabilities.

## Data Residency

| Requirement | Implementation |
|-------------|---------------|
| Region Restriction | Azure Policy restricts deployments to approved regions (East US, East US 2, West US 2) |
| Data Sovereignty | All data remains within the configured Azure regions |
| Cross-Region Replication | Disabled by default; opt-in via parameter for DR scenarios |

## Encryption

### At Rest

| Service | Encryption | Key Management |
|---------|-----------|----------------|
| ADLS Gen2 | AES-256 (SSE) | Microsoft-managed keys (default) or CMK via Key Vault |
| Databricks | AES-256 (DBFS) | Microsoft-managed keys; Unity Catalog supports CMK |
| Synapse | TDE enabled | Microsoft-managed keys or CMK |
| Cosmos DB | AES-256 | Microsoft-managed keys or CMK |
| Key Vault | HSM-backed | Platform-managed |

### In Transit

| Requirement | Implementation |
|-------------|---------------|
| TLS Version | Minimum TLS 1.2 enforced via Azure Policy |
| HTTPS Only | Enforced on all storage accounts via Policy |
| Private Endpoints | All services use private endpoints; no public internet transit |
| VNet Encryption | Hub-spoke topology with Azure Firewall inspection |

## Access Controls

### Authentication

| Method | Usage |
|--------|-------|
| Azure AD (Entra ID) | All user and service authentication |
| Managed Identity | Service-to-service authentication (no stored credentials) |
| OIDC Federation | GitHub Actions CI/CD (no stored secrets) |
| Key Vault References | Application secrets via Key Vault integration |

### Authorization

See `governance/rbac/rbac-matrix.json` for the complete RBAC matrix.

Key principles:
- **Least privilege**: Each persona gets only required permissions
- **Role-based**: Azure RBAC roles mapped to job functions
- **Separation of duties**: Platform admins, data engineers, analysts have distinct access
- **No shared accounts**: All access via individual or service identities

## Audit Trail

### Activity Logging

| Source | Destination | Retention |
|--------|------------|-----------|
| Azure Activity Log | Log Analytics Workspace | 90 days (hot) + 365 days (archive) |
| Azure AD Sign-in Logs | Log Analytics Workspace | 90 days |
| Data Access Logs | Log Analytics + Storage | 365 days |
| Purview Audit Logs | Purview built-in | 90 days |

### Data Access Auditing

| Service | Audit Capability |
|---------|-----------------|
| ADLS Gen2 | Storage Analytics logging (read/write/delete operations) |
| Databricks | Unity Catalog audit logs (table access, query history) |
| Synapse | SQL audit logging (query text, caller identity) |
| Key Vault | Diagnostic logs (secret access, key operations) |

## Network Security

- **Zero Trust Architecture**: All data services behind private endpoints
- **Hub-Spoke Topology**: Centralized Azure Firewall for egress filtering
- **Network Segmentation**: Separate subnets per service tier
- **DNS Resolution**: Private DNS zones for all private endpoint FQDNs
- **No Public Endpoints**: Azure Policy enforces private-only access

See `governance/network/validate-network.ps1` for automated validation.

## Incident Response

### Contact Points

| Severity | Response Time | Escalation |
|----------|--------------|------------|
| P1 (Data Breach) | 1 hour | CISO, Legal, Platform Team |
| P2 (Service Outage) | 4 hours | Platform Team |
| P3 (Degradation) | 24 hours | On-call engineer |

### Response Procedures

See `docs/runbooks/security-incident.md` for detailed procedures.

## Review Schedule

| Review | Frequency | Owner |
|--------|-----------|-------|
| Access Review | Quarterly | Governance Officer |
| Policy Compliance | Monthly | Platform Admin |
| Penetration Test | Annually | Security Team |
| Architecture Review | Semi-annually | Architect |
| Disaster Recovery Test | Semi-annually | Platform Team |

---

*Last Updated: 2026-04-09*
*Version: 1.0.0*
*Owner: Platform Team*

---

## Related Documentation

- [Government Service Matrix](../../docs/GOV_SERVICE_MATRIX.md) - Azure Government service availability
- [Environment Protection](../../docs/ENVIRONMENT_PROTECTION.md) - Environment security controls
