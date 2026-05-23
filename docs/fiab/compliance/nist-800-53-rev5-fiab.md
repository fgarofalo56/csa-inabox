# NIST 800-53 Rev 5 — CSA Loom extension

This page documents how CSA Loom's deployed controls implement
specific NIST 800-53 Rev 5 control families. Extends parent
[`docs/compliance/nist-800-53-rev5.md`](../../compliance/nist-800-53-rev5.md).

## Control family summary

| Family | Loom contribution |
|---|---|
| AC (Access Control) | Entra ID + PIM + per-workspace Entra groups; OBO throughout Copilot |
| AT (Awareness + Training) | Workshop curricula (PRP-22); customer responsibility |
| AU (Audit + Accountability) | Activity Log + App Insights + LAW + Sentinel (Gov) |
| CA (Assessment + Authorization) | DR drill (quarterly); Defender for Cloud (commercial); manual SOC pipeline (Gov) |
| CM (Configuration Management) | Bicep + Git; release-please for versioning |
| CP (Contingency Planning) | DR pattern; RPO/RTO targets per component |
| IA (Identification + Authentication) | Entra + MFA + PIM + workspace UAMI per workspace |
| IR (Incident Response) | Sentinel rules + runbooks |
| MA (Maintenance) | Patching via container image updates; Bicep module updates via `azd up` |
| MP (Media Protection) | ADLS Gen2 encryption-at-rest; HSM-CMK at IL5; sensitivity label-based DLP |
| PE (Physical Protection) | Azure datacenter physical controls (inherited from Azure) |
| PL (Planning) | This PRD + workshops + runbooks |
| PM (Program Management) | Customer responsibility |
| PS (Personnel Security) | Customer responsibility |
| RA (Risk Assessment) | Customer responsibility; Loom contributes Defender for Cloud + Sentinel data |
| SA (System + Services Acquisition) | Bicep + Git supply-chain controls; SBOM per container image |
| SC (System + Communications Protection) | TLS 1.2+; Private Endpoints; Azure Firewall; egress allow-list |
| SI (System + Information Integrity) | Defender for Cloud (commercial); Sentinel pipeline (Gov); content safety; PII redaction |
| SR (Supply Chain Risk Management) | SBOM per container; signed images |

## Selected control mappings (high-leverage)

### AC-2 Account Management

- Per-workspace Entra groups created by customer
- Loom Console "Admin → Workspaces → Members" surfaces all groups
- PIM-eligible activation for Loom Admins role (recommended)
- Quarterly access reviews via Entra ID

### AC-3 Access Enforcement

- Three-layer enforcement: Storage RBAC + Engine RBAC (UC / Synapse /
  ADX / Power BI) + Console UI filtering
- OBO throughout Copilot → every tool call carries user identity

### AC-4 Information Flow Enforcement

- Azure Firewall app rules per workload
- OAP (Outbound Access Protection) per-workspace
- Cross-DLZ data sharing requires explicit approval flow

### AC-6 Least Privilege

- Loom MCP MI: PIM-eligible Contributor (JIT 2h max); standing Reader
- Workspace UAMI: Storage Blob Data Contributor on workspace path
  only; UC roles or Hive grants for engine access
- Per-pane visibility filtering in Console

### AU-2 Event Logging

- Loom Console logs to App Insights (server + client)
- All MCP tool calls land in Activity Log with correlation IDs
- All engine queries (Databricks, Synapse, ADX, Power BI) audit-log
  to LAW
- All Loom Copilot turns → telemetry → App Insights → Sentinel (Gov)

### AU-9 Protection of Audit Information

- LAW workspace per Admin Plane; RBAC restricts read to audit team
- Sentinel ingests for cross-source correlation
- Retention: 90 days (Commercial), 1 year (GCC-H), 7 years (IL5)

### CM-2 Baseline Configuration

- Bicep `.bicepparam` per-boundary is the baseline
- Git tracks changes
- Drift detection via `azd provision --preview` (shows diff vs deployed)

### IA-2 Identification + Authentication

- Entra ID mandatory; MFA enforced for Loom Admins
- Workspace identities (UAMI) for non-human auth

### IR-4 Incident Handling

- Runbook library at [runbooks section](../runbooks/deploy-failure.md)
- Sentinel automation rules can trigger Logic App responses

### SC-7 Boundary Protection

- Hub-spoke topology + Private Endpoints + Azure Firewall
- `publicNetworkAccess = disabled` on all PaaS

### SC-12 Cryptographic Key Establishment

- Key Vault Premium with HSM-backed keys
- HSM-CMK required at IL5

### SC-28 Protection of Information at Rest

- ADLS Gen2 encryption-at-rest (Microsoft-managed by default;
  HSM-CMK at IL5)
- `requireInfrastructureEncryption = true` at IL5 (double encryption)

### SI-3 Malicious Code Protection

- Defender for Cloud (per-workload plans)
- Defender for Containers (AKS) for container scanning
- ACR Container Registry scanning enabled

### SI-7 Software, Firmware, Integrity

- Container images signed (cosign per release tag)
- Bicep modules versioned in Git
- Diff verification via `azd provision --preview`

## Per-boundary applicability

NIST 800-53 r5 control implementation differs per boundary primarily
in the Defender / Sentinel layer:

| Control | Commercial | GCC-H / IL4 | IL5 |
|---|---|---|---|
| SI-3 Defender for Cloud all plans | ✅ | ✅ except AI TP | ✅ except AI TP |
| AU-2 Audit logging | LAW | LAW + Sentinel | LAW + Sentinel |
| MP-5 Media Sanitization (cryptographic erase) | ✅ | ✅ | ✅ HSM-CMK |
| SC-28 Encryption-at-rest | MSFT-managed | MSFT-managed | HSM-CMK + double |

## Related

- Parent: [NIST 800-53 Rev 5](../../compliance/nist-800-53-rev5.md)
- Defender workaround: [Defender AI workaround](defender-ai-workaround.md)
- [Feature × boundary matrix](feature-boundary-matrix.md)
