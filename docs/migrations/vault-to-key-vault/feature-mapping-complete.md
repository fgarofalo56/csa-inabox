# Complete Feature Mapping: HashiCorp Vault to Azure Key Vault

**Status:** Authored 2026-04-30
**Audience:** Platform Engineers, Security Architects, DevOps Engineers
**Purpose:** Comprehensive feature-by-feature mapping of HashiCorp Vault capabilities to Azure Key Vault equivalents

---

## How to read this guide

Each section maps a Vault capability to its Azure Key Vault equivalent. Mappings use the following confidence indicators:

| Indicator         | Meaning                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Direct**        | Key Vault provides equivalent or superior native functionality                                                                  |
| **Pattern**       | Key Vault achieves the same outcome through a different architectural pattern (e.g., managed identity replaces dynamic secrets) |
| **Partial**       | Key Vault provides some but not all of the Vault capability; mitigation strategies are documented                               |
| **No equivalent** | No direct Key Vault equivalent exists; alternative Azure services or patterns are suggested                                     |

---

## 1. Secrets engines

### KV secrets engine (v1 and v2)

| Vault feature                                               | Key Vault equivalent                                                        | Mapping |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- | ------- |
| KV v1 (unversioned key-value)                               | Key Vault secrets (versioning can be ignored)                               | Direct  |
| KV v2 (versioned key-value)                                 | Key Vault secrets with version history                                      | Direct  |
| Secret versioning (up to configurable max)                  | Key Vault secret versions (unlimited, old versions retained until purged)   | Direct  |
| Secret metadata (custom_metadata)                           | Key Vault secret tags (key-value pairs on each secret)                      | Direct  |
| Soft-delete (v2 delete/undelete)                            | Key Vault soft-delete (enabled by default, 7-90 day retention)              | Direct  |
| Check-and-set (CAS) for concurrent writes                   | Not available; use Azure Resource locks or application-level concurrency    | Partial |
| Mount path isolation (e.g., `secret/app1/`, `secret/app2/`) | Separate Key Vault instances per application or environment                 | Direct  |
| Secret size limit (unlimited in Vault)                      | 25 KB per secret value (for larger payloads, store reference to Azure Blob) | Partial |
| JSON secret values (structured data in single entry)        | Store as JSON string in secret value; parse in application code             | Direct  |
| List secrets (enumerate keys without values)                | Key Vault list operation (returns secret names and metadata, not values)    | Direct  |

### Transit secrets engine

| Vault feature                                         | Key Vault equivalent                                                                               | Mapping       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------- |
| Encrypt/decrypt                                       | Key Vault keys encrypt/decrypt operations                                                          | Direct        |
| Rewrap (re-encrypt with latest key version)           | Application-level: decrypt with old version, encrypt with new version                              | Pattern       |
| Sign/verify                                           | Key Vault keys sign/verify operations                                                              | Direct        |
| Generate HMAC                                         | Key Vault keys sign operation with HMAC algorithms                                                 | Direct        |
| Generate random bytes                                 | Not available in Key Vault; use application-level `System.Security.Cryptography` or `os.urandom()` | No equivalent |
| Key types: AES-128-GCM, AES-256-GCM                   | Managed HSM supports AES-128/192/256; Key Vault Standard/Premium do not support symmetric AES keys | Partial       |
| Key types: RSA-2048, RSA-3072, RSA-4096               | Key Vault keys RSA-2048/3072/4096                                                                  | Direct        |
| Key types: ECDSA P-256, P-384, P-521                  | Key Vault keys EC P-256/P-384/P-521                                                                | Direct        |
| Key types: Ed25519                                    | Not supported in Key Vault                                                                         | No equivalent |
| Convergent encryption                                 | Not available natively; implement at application level                                             | No equivalent |
| Batch encrypt/decrypt (multiple items in one request) | Not available natively; parallelize calls or use client-side batching                              | Partial       |
| Key rotation (automatic on schedule)                  | Key Vault key rotation policy (automatic, configurable interval)                                   | Direct        |
| Minimum decryption version enforcement                | Use key versioning + disable older key versions                                                    | Pattern       |
| Data key generation (envelope encryption)             | Key Vault wrap/unwrap operations for envelope encryption pattern                                   | Direct        |
| Transit key export (for offline processing)           | Key Vault key export (only for exportable keys; HSM keys cannot be exported)                       | Partial       |

### PKI secrets engine

| Vault feature                               | Key Vault equivalent                                                                       | Mapping |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| Root CA generation                          | Key Vault certificates (self-signed CA or import existing root)                            | Direct  |
| Intermediate CA generation and signing      | Key Vault certificates (CSR generation, import signed certificate)                         | Direct  |
| Certificate issuance (leaf certs)           | Key Vault certificates with issuance policy                                                | Direct  |
| Certificate templates (roles in Vault)      | Key Vault certificate policies (key type, subject, validity, renewal)                      | Direct  |
| CRL generation and distribution             | Key Vault does not generate CRLs; use DigiCert/GlobalSign CA integration for CRL           | Partial |
| OCSP responder                              | Not built into Key Vault; use integrated CA's OCSP infrastructure                          | Partial |
| Certificate auto-renewal                    | Key Vault certificate auto-renewal (configurable days before expiry)                       | Direct  |
| ACME protocol support                       | Key Vault supports ACME for certificate issuance (public CAs)                              | Direct  |
| Certificate revocation                      | Key Vault certificate disable/delete; CRL via integrated CA                                | Partial |
| SAN (Subject Alternative Name) support      | Key Vault certificate SAN configuration in issuance policy                                 | Direct  |
| Wildcard certificates                       | Supported in Key Vault certificate issuance                                                | Direct  |
| CA integration (DigiCert, GlobalSign)       | Key Vault native integration with DigiCert and GlobalSign                                  | Direct  |
| Short-lived certificates (minutes to hours) | Key Vault minimum validity is 1 month; for short-lived, use Managed HSM or custom issuance | Partial |

### Database secrets engine

| Vault feature                   | Key Vault equivalent                                                                          | Mapping |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| Dynamic PostgreSQL credentials  | Managed identity for Azure Database for PostgreSQL Flexible Server (no password)              | Pattern |
| Dynamic MySQL credentials       | Managed identity for Azure Database for MySQL Flexible Server (no password)                   | Pattern |
| Dynamic MSSQL credentials       | Managed identity for Azure SQL Database / Managed Instance (no password)                      | Pattern |
| Dynamic MongoDB credentials     | Managed identity for Azure Cosmos DB (MongoDB API) (no password)                              | Pattern |
| Dynamic Cassandra credentials   | Key Vault secret with Event Grid rotation (Cosmos DB Cassandra API supports managed identity) | Pattern |
| Dynamic Oracle credentials      | Key Vault secret with automated rotation via Azure Function                                   | Pattern |
| Static role rotation            | Key Vault secret rotation policy with Event Grid trigger                                      | Pattern |
| Root credential rotation        | Not applicable with managed identity; for non-Azure DBs, use Key Vault rotation               | Pattern |
| Custom database plugins         | Azure Function for custom rotation logic + Key Vault secret rotation                          | Pattern |
| TTL-based credential expiration | Managed identity tokens auto-expire (1-hour default TTL, transparent refresh)                 | Pattern |
| Credential lease management     | Not needed with managed identity (no credentials to lease)                                    | Pattern |

### AWS secrets engine

| Vault feature               | Key Vault equivalent                                                   | Mapping |
| --------------------------- | ---------------------------------------------------------------------- | ------- |
| Dynamic AWS IAM credentials | Workload identity federation (Azure to AWS without stored credentials) | Pattern |
| AWS STS assumed roles       | Workload identity federation with AWS IAM role trust policy            | Pattern |
| Root credential rotation    | Not applicable (workload identity federation is credential-less)       | Pattern |

### Azure secrets engine

| Vault feature                               | Key Vault equivalent                                                         | Mapping |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| Dynamic Azure service principal credentials | Managed identity (system-assigned or user-assigned) -- no credentials needed | Pattern |
| Dynamic role assignments                    | Managed identity with pre-assigned RBAC roles                                | Pattern |

### GCP secrets engine

| Vault feature                    | Key Vault equivalent                                                   | Mapping |
| -------------------------------- | ---------------------------------------------------------------------- | ------- |
| Dynamic GCP service account keys | Workload identity federation (Azure to GCP without stored credentials) | Pattern |
| GCP OAuth tokens                 | Workload identity federation with GCP workload identity pools          | Pattern |

### SSH secrets engine

| Vault feature               | Key Vault equivalent                                                      | Mapping |
| --------------------------- | ------------------------------------------------------------------------- | ------- |
| SSH signed certificates     | Azure Bastion (eliminates SSH key management entirely)                    | Pattern |
| SSH OTP (one-time password) | Azure Bastion or Microsoft Entra SSH login                                | Pattern |
| SSH CA signing              | Key Vault certificate for SSH CA; or use Entra ID SSH login for Linux VMs | Pattern |

### TOTP secrets engine

| Vault feature        | Key Vault equivalent                                    | Mapping |
| -------------------- | ------------------------------------------------------- | ------- |
| TOTP code generation | Entra ID MFA (built-in TOTP, push notifications, FIDO2) | Pattern |
| TOTP validation      | Entra ID MFA validation                                 | Pattern |

### Transform secrets engine

| Vault feature                      | Key Vault equivalent                                                                               | Mapping       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------- |
| Format-preserving encryption (FPE) | Not available in Key Vault; consider Azure SQL Always Encrypted or application-level FPE libraries | No equivalent |
| Tokenization                       | Not available in Key Vault; consider Azure Purview data masking or application-level tokenization  | No equivalent |
| Data masking                       | Microsoft Purview data masking, Azure SQL dynamic data masking                                     | Pattern       |

---

## 2. Auth methods

| Vault auth method            | Azure Key Vault equivalent                                                   | Mapping |
| ---------------------------- | ---------------------------------------------------------------------------- | ------- |
| AppRole                      | Entra ID service principal with client credentials                           | Direct  |
| Kubernetes                   | AKS workload identity (OIDC federation to Entra ID)                          | Direct  |
| LDAP                         | Entra ID (with LDAP sync via Entra Connect if needed)                        | Direct  |
| OIDC / JWT                   | Entra ID (native OIDC provider)                                              | Direct  |
| AWS IAM                      | Workload identity federation (AWS IAM role to Entra ID federated credential) | Direct  |
| Azure (Vault's Azure auth)   | Managed identity (native, no configuration needed)                           | Direct  |
| GCP IAM                      | Workload identity federation (GCP to Entra ID federated credential)          | Direct  |
| TLS certificates (cert auth) | Entra ID certificate-based authentication                                    | Direct  |
| GitHub                       | Entra ID workload identity federation for GitHub Actions (OIDC)              | Direct  |
| Token                        | Entra ID access tokens (OAuth2 bearer tokens)                                | Direct  |
| Userpass                     | Entra ID username/password authentication (with MFA enforcement)             | Direct  |
| RADIUS                       | Entra ID MFA with RADIUS integration via NPS extension                       | Direct  |
| Kerberos                     | Entra ID Kerberos authentication (hybrid join, Windows authentication)       | Direct  |
| SAML                         | Entra ID SAML federation                                                     | Direct  |

---

## 3. Policies and governance

| Vault feature                                   | Azure Key Vault equivalent                                                 | Mapping |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| ACL policies (path-based)                       | Azure RBAC role assignments (scope: vault, secret, key, or certificate)    | Direct  |
| Sentinel policies (policy-as-code, Enterprise)  | Azure Policy for Key Vault (built-in and custom policy definitions)        | Direct  |
| Namespaces (Enterprise, multi-tenant isolation) | Separate Key Vault instances per tenant/team/environment                   | Pattern |
| Entity and entity aliases (identity mapping)    | Entra ID users, groups, service principals, managed identities             | Direct  |
| Identity groups (for policy assignment)         | Entra ID groups (security groups, role-assignable groups)                  | Direct  |
| MFA enforcement on specific paths               | Entra ID Conditional Access policies (require MFA for Key Vault access)    | Direct  |
| Control groups (multi-approval)                 | Entra PIM approval workflows for privileged Key Vault roles                | Direct  |
| Root token (emergency access)                   | Break-glass accounts in Entra ID with Conditional Access exclusion         | Pattern |
| Response wrapping (single-use secret delivery)  | Not available natively; implement with Event Grid + short-lived SAS tokens | Partial |
| Path templating (dynamic policy paths)          | Azure RBAC conditions (ABAC) for attribute-based access control            | Direct  |
| Lease management (TTL enforcement)              | Key Vault secret expiration dates + rotation policies                      | Pattern |

---

## 4. Audit and monitoring

| Vault feature                  | Azure Key Vault equivalent                                                   | Mapping |
| ------------------------------ | ---------------------------------------------------------------------------- | ------- |
| Audit device (file backend)    | Azure Monitor diagnostic settings (Log Analytics workspace)                  | Direct  |
| Audit device (syslog backend)  | Azure Monitor with syslog forwarding (or direct to SIEM)                     | Direct  |
| Audit device (socket backend)  | Azure Event Hubs for streaming audit events                                  | Direct  |
| HMAC-protected audit logs      | Azure Monitor logs (tamper-evident, immutable retention policies)            | Direct  |
| Request/response audit logging | Key Vault diagnostic logs capture all data-plane operations                  | Direct  |
| Audit log filtering            | Kusto (KQL) queries in Log Analytics for filtering and alerting              | Direct  |
| Audit log format (JSON)        | Azure Monitor JSON format (AzureDiagnostics table, resource-specific tables) | Direct  |
| Metrics (Prometheus/StatsD)    | Azure Monitor metrics for Key Vault (API latency, availability, saturation)  | Direct  |
| Health check endpoint          | Azure Resource Health for Key Vault                                          | Direct  |
| Telemetry (OpenTelemetry)      | Azure Monitor OpenTelemetry integration; Key Vault SDK emits OTel spans      | Direct  |

---

## 5. High availability and disaster recovery

| Vault feature                        | Azure Key Vault equivalent                                              | Mapping |
| ------------------------------------ | ----------------------------------------------------------------------- | ------- |
| HA mode (integrated storage Raft)    | Built-in HA (managed, no configuration)                                 | Direct  |
| Performance standby nodes            | Not applicable (Key Vault scales automatically)                         | Direct  |
| DR replication (Enterprise)          | Geo-replication (Premium tier, automatic read replicas)                 | Direct  |
| Performance replication (Enterprise) | Multiple Key Vault instances with Azure Traffic Manager                 | Pattern |
| Snapshot backup                      | Key Vault backup/restore (per-secret, per-key, per-certificate)         | Direct  |
| Full vault snapshot (Enterprise)     | Azure Backup for Key Vault (preview); or scripted backup of all objects | Partial |
| Seal/unseal process                  | Not applicable (Key Vault is always available, no seal concept)         | Direct  |
| Auto-unseal (HSM/cloud KMS)          | Not applicable (no seal concept)                                        | Direct  |
| Multi-region deployment              | Managed HSM multi-region HA (3+ HSM units across regions)               | Direct  |
| Cross-region failover                | Automatic failover with geo-replication (Premium)                       | Direct  |

---

## 6. Operational features

| Vault feature                                | Azure Key Vault equivalent                                                        | Mapping       |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ------------- |
| UI (web interface)                           | Azure portal Key Vault blade                                                      | Direct        |
| CLI (`vault` command)                        | Azure CLI (`az keyvault`) and Azure PowerShell (`Az.KeyVault`)                    | Direct        |
| HTTP API (REST)                              | Key Vault REST API (data plane and management plane)                              | Direct        |
| Client SDKs (Go, Python, Java, .NET, Ruby)   | Azure SDK (Python, .NET, Java, JavaScript, Go, C++)                               | Direct        |
| Terraform provider                           | Azure Terraform provider (`azurerm_key_vault`, `azurerm_key_vault_secret`, etc.)  | Direct        |
| Bicep / ARM templates                        | Native Bicep resource (`Microsoft.KeyVault/vaults`)                               | Direct        |
| Agent sidecar (Vault Agent)                  | AKS CSI Secret Store Driver, App Configuration Key Vault references               | Pattern       |
| Agent template rendering                     | Not available; use CSI volumes or environment variable injection                  | Partial       |
| Vault Agent auto-auth                        | Managed identity auto-authentication (transparent, no configuration)              | Direct        |
| Plugin architecture (custom secrets engines) | Azure Functions for custom rotation; no custom secrets engine plugin architecture | Partial       |
| Rate limiting                                | Key Vault throttling (4,000 ops/sec per vault); configurable with multiple vaults | Direct        |
| Request size limits                          | 25 KB per secret value; 4 KB RSA key operations                                   | Partial       |
| CORS configuration                           | Key Vault does not support CORS (use API Management or application proxy)         | No equivalent |
| Event notifications                          | Azure Event Grid events for secret/key/certificate lifecycle events               | Direct        |

---

## 7. Networking and access control

| Vault feature                       | Azure Key Vault equivalent                                         | Mapping       |
| ----------------------------------- | ------------------------------------------------------------------ | ------------- |
| Listener TLS configuration          | Managed TLS (Microsoft-managed certificate for Key Vault endpoint) | Direct        |
| Network binding (IP/port)           | Key Vault firewall rules (allowed IP ranges)                       | Direct        |
| TCP load balancer (HA)              | Not applicable (managed service with built-in load balancing)      | Direct        |
| mTLS for cluster communication      | Not applicable (managed service)                                   | Direct        |
| Private network access              | Azure Private Endpoint for Key Vault                               | Direct        |
| Service endpoint (VNet integration) | Key Vault VNet service endpoints                                   | Direct        |
| Proxy protocol support              | Not applicable                                                     | No equivalent |

---

## 8. CSA-in-a-Box integration mapping

This section maps how Vault integrations with CSA-in-a-Box components translate to Key Vault native integrations.

| CSA-in-a-Box component | Vault integration pattern                                                                               | Key Vault native integration                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Databricks**         | Vault Agent sidecar in Databricks cluster; or Vault-backed secret scope (requires Vault network access) | Key Vault-backed secret scope (native, no sidecar); `dbutils.secrets.get(scope, key)`  |
| **Azure Data Factory** | Custom activity calling Vault API; or Azure Function wrapper                                            | ADF linked services reference Key Vault directly; managed identity authentication      |
| **Microsoft Fabric**   | No native integration; manual credential management                                                     | Key Vault references in Fabric connection configuration                                |
| **Purview**            | No native integration; store scan credentials manually                                                  | Purview data source scans use Key Vault credentials or managed identity                |
| **Azure OpenAI**       | Store API key in Vault KV; application retrieves via Vault SDK                                          | Store API key in Key Vault; application retrieves via managed identity + Key Vault SDK |
| **Power BI**           | No native integration                                                                                   | Service principal credentials in Key Vault for automated refresh                       |
| **Azure Monitor**      | Vault audit backend to syslog/file; separate monitoring stack                                           | Key Vault diagnostic settings direct to Log Analytics (native, zero configuration)     |
| **Event Hubs**         | Vault-stored connection strings or SAS tokens                                                           | Managed identity (no connection string); or Key Vault-stored connection string         |
| **Azure SQL**          | Vault database engine for dynamic credentials                                                           | Managed identity (no credentials); or Key Vault-stored connection string for legacy    |

---

## Summary statistics

| Category                | Total features mapped | Direct       | Pattern      | Partial      | No equivalent |
| ----------------------- | --------------------- | ------------ | ------------ | ------------ | ------------- |
| Secrets engines         | 58                    | 22           | 25           | 7            | 4             |
| Auth methods            | 14                    | 14           | 0            | 0            | 0             |
| Policies and governance | 11                    | 7            | 3            | 1            | 0             |
| Audit and monitoring    | 10                    | 10           | 0            | 0            | 0             |
| HA and DR               | 10                    | 8            | 1            | 1            | 0             |
| Operational features    | 15                    | 9            | 2            | 3            | 1             |
| Networking              | 7                     | 5            | 0            | 0            | 2             |
| **Total**               | **125**               | **75 (60%)** | **31 (25%)** | **12 (10%)** | **7 (5%)**    |

85% of Vault features have a direct or pattern-equivalent in Azure Key Vault. The 5% with no equivalent (Ed25519 keys, convergent encryption, format-preserving encryption, random byte generation, agent template rendering, CORS, proxy protocol) are specialized capabilities that affect a small subset of deployments.

---

## Related resources

- **Executive brief:** [Why Key Vault over Vault](why-key-vault-over-vault.md)
- **TCO analysis:** [Total Cost of Ownership](tco-analysis.md)
- **Migration playbook:** [Vault to Key Vault](../vault-to-key-vault.md)
- **Secrets migration:** [Secrets Migration Guide](secrets-migration.md)
- **Encryption migration:** [Transit to Key Vault Keys](encryption-migration.md)

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
