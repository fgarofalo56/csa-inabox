# Federal Migration Guide --- Jenkins to GitHub Actions / Azure DevOps in Government

**Audience:** Federal Technology Director, ISSM, DevSecOps Engineer
**Reading time:** 10 minutes
**Last updated:** 2026-04-30

---

## Overview

Federal agencies migrating CI/CD from Jenkins to modern platforms must satisfy FedRAMP, DoD IL4/IL5, CMMC, and EO 14028 (software supply-chain security) requirements. This guide covers the authorized CI/CD platforms for federal environments, self-hosted runner deployment in Azure Government regions, SBOM generation, SLSA build provenance, and compliance evidence patterns.

---

## 1. Authorized CI/CD platforms for federal workloads

| Platform                     | Authorization level                         | Deployment model                      | Best for                                                      |
| ---------------------------- | ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| **GitHub Enterprise Cloud**  | FedRAMP Moderate (data residency available) | SaaS (GitHub.com with data residency) | IL2 workloads, commercial agencies, development CI/CD         |
| **GitHub Enterprise Server** | Customer-managed ATO                        | On-premises or Azure Government VM    | IL4 workloads, agencies requiring full infrastructure control |
| **Azure DevOps Services**    | FedRAMP High (Azure Government)             | SaaS (dev.azure.com in Gov cloud)     | IL2--IL4 workloads, agencies with ADO investment              |
| **Azure DevOps Server**      | Customer-managed ATO                        | On-premises or Azure Government VM    | IL4/IL5 workloads, air-gapped environments                    |
| **Jenkins** (current)        | Customer-managed ATO                        | Self-hosted                           | Any IL level (customer-controlled)                            |

### Choosing the right platform by impact level

| Impact level                           | Recommended CI/CD platform                                                  | Rationale                                               |
| -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| **IL2** (public, non-CUI)              | GitHub Enterprise Cloud or Azure DevOps Services                            | SaaS platforms authorized for IL2                       |
| **IL4** (CUI)                          | GHEC with data residency, Azure DevOps Services (Gov), or GHES on Azure Gov | Data residency ensures CUI stays in authorized boundary |
| **IL5** (higher CUI, mission-critical) | Azure DevOps Server (on-prem in Gov), or GHES on Azure Gov                  | On-premises deployment in approved Gov region           |
| **IL6** (classified)                   | Azure DevOps Server or Jenkins (on-prem in classified enclave)              | Air-gapped; no SaaS option                              |

---

## 2. GitHub Enterprise Cloud with data residency

GitHub Enterprise Cloud (GHEC) with data residency stores all repository data, metadata, and workflow logs in a specified geographic region. For federal agencies, this ensures data remains within US-controlled infrastructure.

### Key features for federal use

- **Data residency:** All data stored in US data centers
- **SSO with Entra ID:** SAML SSO integration with Azure Government Entra ID tenant
- **Audit log streaming:** Stream audit logs to Azure Monitor, Splunk, or SIEM
- **IP allow listing:** Restrict access to agency-approved IP ranges
- **EMU (Enterprise Managed Users):** Users provisioned and managed entirely by the agency's IdP
- **Advanced Security:** CodeQL, secret scanning, Dependabot included in Enterprise
- **SCIM provisioning:** Automated user lifecycle management via Entra ID

### Limitations

- Workflow execution on GitHub-hosted runners occurs in GitHub's infrastructure (not Azure Government). For IL4+ workloads, use self-hosted runners in Azure Government.
- GitHub Enterprise Cloud is FedRAMP Moderate, not FedRAMP High. Agencies requiring FedRAMP High should evaluate Azure DevOps Services in Azure Government or self-hosted options.

---

## 3. Self-hosted runners in Azure Government

For IL4/IL5 workloads, deploy self-hosted runners in Azure Government regions to ensure build compute resides within the authorized boundary.

### Architecture

```
Azure Government (US Gov Virginia / US Gov Arizona)
├── VNet: vnet-cicd-gov
│   ├── Subnet: snet-runners
│   │   ├── VM: runner-gov-01 (Ubuntu, self-hosted GH runner)
│   │   ├── VM: runner-gov-02 (Ubuntu, self-hosted GH runner)
│   │   └── AKS: aks-arc-gov (ARC runner scale set)
│   └── Subnet: snet-private-endpoints
│       ├── Private endpoint: pe-acr (Azure Container Registry)
│       ├── Private endpoint: pe-kv (Key Vault)
│       └── Private endpoint: pe-storage (ADLS Gen2)
└── NSG: nsg-runners
    ├── Outbound: Allow 443 to github.com (runner communication)
    └── Outbound: Allow 443 to *.actions.githubusercontent.com
```

### Deploying runners in Azure Government via Bicep

```bicep
// infra/modules/github-runner.bicep
param location string = 'usgovvirginia'
param vmSize string = 'Standard_D4s_v5'
param adminUsername string = 'runner'

resource runnerVm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: 'runner-gov-01'
  location: location
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: 'runner-gov-01'
      adminUsername: adminUsername
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
    }
    networkProfile: {
      networkInterfaces: [
        { id: nic.id }
      ]
    }
  }
}
```

### Network requirements

Self-hosted runners initiate outbound HTTPS connections. No inbound ports are required.

| Destination                               | Port | Required               | Purpose                        |
| ----------------------------------------- | ---- | ---------------------- | ------------------------------ |
| `github.com`                              | 443  | Yes                    | API and runner registration    |
| `api.github.com`                          | 443  | Yes                    | REST API                       |
| `*.actions.githubusercontent.com`         | 443  | Yes                    | Workflow artifacts and actions |
| `ghcr.io`                                 | 443  | Yes                    | Container image downloads      |
| `pipelines.actions.githubusercontent.com` | 443  | Yes                    | Runner communication           |
| `*.blob.core.usgovcloudapi.net`           | 443  | If using Azure storage | Artifact storage               |

For air-gapped environments where `github.com` is not accessible, use GitHub Enterprise Server deployed within the government network boundary.

---

## 4. Azure DevOps Server for IL4/IL5

Azure DevOps Server (formerly TFS) is the on-premises version of Azure DevOps, providing full CI/CD capabilities without SaaS dependency.

### Deployment in Azure Government

```
Azure Government
├── VNet: vnet-ado-gov
│   ├── Subnet: snet-ado-app
│   │   └── VM: ado-server-01 (Azure DevOps Server 2022)
│   ├── Subnet: snet-ado-db
│   │   └── SQL MI: sqlmi-ado-gov (Azure SQL Managed Instance)
│   └── Subnet: snet-ado-agents
│       ├── VM: agent-01 (build agent)
│       └── VM: agent-02 (build agent)
```

### When to use Azure DevOps Server

- **IL5 workloads** that cannot tolerate any data in SaaS infrastructure
- **Air-gapped networks** with no internet connectivity
- **Classified environments** (IL6) where all infrastructure must be on-premises
- **Agencies with existing TFS/ADO Server** investment

---

## 5. SBOM generation --- EO 14028 compliance

Executive Order 14028 requires software producers to provide Software Bills of Materials (SBOMs) for software sold to the federal government. Both GitHub Actions and Azure DevOps support SBOM generation.

### SBOM generation in GitHub Actions

```yaml
- name: Generate SBOM
  uses: anchore/sbom-action@v0
  with:
      image: ${{ env.DOCKER_REGISTRY }}/${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }}
      artifact-name: sbom-${{ github.run_number }}.spdx.json
      output-file: sbom.spdx.json
      format: spdx-json

- name: Upload SBOM as artifact
  uses: actions/upload-artifact@v4
  with:
      name: sbom
      path: sbom.spdx.json
      retention-days: 365 # Retain for compliance audit
```

### Microsoft SBOM Tool

```yaml
- name: Generate SBOM (Microsoft)
  uses: microsoft/sbom-action@v0.3
  with:
      packageName: csa-data-api
      packageVersion: ${{ github.run_number }}
      buildSourcePath: .
      buildDropPath: dist/
```

### SBOM formats

| Format                    | Standard          | Federal acceptance     |
| ------------------------- | ----------------- | ---------------------- |
| SPDX (JSON/RDF/tag-value) | ISO/IEC 5962:2021 | Accepted by CISA, NTIA |
| CycloneDX (JSON/XML)      | OWASP standard    | Accepted by DoD        |

---

## 6. SLSA build provenance --- Supply-chain security

SLSA (Supply-chain Levels for Software Artifacts) provenance attestations prove that a specific artifact was built by a specific workflow. GitHub Actions supports SLSA Level 3 provenance natively.

### Generating SLSA provenance

```yaml
- name: Generate build provenance
  uses: actions/attest-build-provenance@v1
  with:
      subject-path: dist/csa-data-api.tar.gz

- name: Generate container provenance
  uses: actions/attest-build-provenance@v1
  with:
      subject-name: ${{ env.DOCKER_REGISTRY }}/${{ env.IMAGE_NAME }}
      subject-digest: sha256:${{ steps.build.outputs.digest }}
      push-to-registry: true
```

### SLSA levels

| Level  | Requirement                                                   | GitHub Actions support            |
| ------ | ------------------------------------------------------------- | --------------------------------- |
| SLSA 1 | Documented build process                                      | Workflow YAML is documentation    |
| SLSA 2 | Version-controlled build definition, hosted build service     | GitHub-hosted runners             |
| SLSA 3 | Hardened builds (non-falsifiable provenance, isolated builds) | `actions/attest-build-provenance` |
| SLSA 4 | Two-person review, hermetic builds                            | Requires additional controls      |

---

## 7. Compliance evidence patterns for CSA-in-a-Box

CSA-in-a-Box CI/CD workflows generate compliance evidence as part of the pipeline:

### NIST 800-53 CI/CD controls

| Control                                 | CI/CD evidence                     | GitHub Actions implementation                            |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| **SA-11** (Developer Testing)           | Test results, coverage reports     | JUnit reports, coverage artifacts                        |
| **SA-15** (Development Process)         | Pipeline-as-code, code review      | Workflow YAML in repo, PR reviews                        |
| **SI-7** (Software Integrity)           | SBOM, SLSA provenance              | `anchore/sbom-action`, `actions/attest-build-provenance` |
| **CM-3** (Configuration Change Control) | Deployment approval gates          | Environment protection rules                             |
| **AU-6** (Audit Review)                 | Pipeline logs, audit log           | Workflow run logs, GitHub audit log                      |
| **RA-5** (Vulnerability Scanning)       | Dependency scanning, code scanning | Dependabot, CodeQL                                       |
| **CM-14** (Signed Components)           | Container image signing            | `sigstore/cosign-installer` + signing                    |

### Compliance workflow example

```yaml
name: Compliance Evidence
on:
    schedule:
        - cron: "0 6 * * 1" # Weekly Monday 6 AM UTC
    workflow_dispatch:

permissions:
    contents: read
    security-events: read

jobs:
    compliance-check:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4

            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

            - name: Check Azure Policy compliance
              run: |
                  az policy state summarize \
                    --resource-group rg-csa-prod \
                    --output json > compliance-summary.json

            - name: Run Checkov on Bicep
              uses: bridgecrewio/checkov-action@v12
              with:
                  directory: infra/
                  framework: bicep
                  output_format: json
                  output_file_path: checkov-results.json

            - name: Generate SBOM
              uses: anchore/sbom-action@v0
              with:
                  output-file: sbom.spdx.json

            - name: Upload compliance artifacts
              uses: actions/upload-artifact@v4
              with:
                  name: compliance-evidence-${{ github.run_number }}
                  path: |
                      compliance-summary.json
                      checkov-results.json
                      sbom.spdx.json
                  retention-days: 365
```

---

## 8. Container image signing

For federal supply-chain requirements, sign container images with Sigstore Cosign:

```yaml
- uses: sigstore/cosign-installer@v3

- name: Sign container image
  run: |
      cosign sign --yes \
        ${{ env.DOCKER_REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
  env:
      COSIGN_EXPERIMENTAL: 1
```

---

## 9. Migration recommendations by agency type

| Agency type               | Current CI/CD                 | Recommended target                      | Key considerations                         |
| ------------------------- | ----------------------------- | --------------------------------------- | ------------------------------------------ |
| **Civilian agency (IL2)** | Jenkins on-prem               | GHEC with data residency                | Fastest migration path; hosted runners     |
| **DoD (IL4)**             | Jenkins on-prem               | GHEC + self-hosted runners in Azure Gov | OIDC federation; runners in Gov regions    |
| **DoD (IL5)**             | Jenkins in classified network | GHES on Azure Gov or ADO Server         | On-prem deployment; air-gap capable        |
| **IC (IL6)**              | Jenkins in SCIF               | ADO Server or Jenkins (stay)            | Recommend staying on Jenkins or ADO Server |
| **DIB (CMMC L2)**         | Jenkins or none               | GHEC with data residency                | Advanced Security for code scanning        |

---

## 10. Procurement guidance

### GitHub Enterprise Cloud

- Available through Microsoft Enterprise Agreement (EA)
- Available through AWS Marketplace (for agencies using AWS procurement)
- Available through GitHub direct sales
- Include Advanced Security add-on for CodeQL and secret scanning

### Azure DevOps

- Included in Azure subscription (Basic plan)
- Premium features through Visual Studio Enterprise subscription
- Azure DevOps Server licensed per server + CALs

### Cost comparison for federal (100 developers)

| Platform                        | Annual cost (estimate)          | Includes                               |
| ------------------------------- | ------------------------------- | -------------------------------------- |
| GHEC + Advanced Security        | ~$300,000                       | Enterprise license + Advanced Security |
| GHES on Azure Gov (self-hosted) | ~$250,000 + infrastructure      | License + 3 VMs for HA                 |
| Azure DevOps Services           | ~$72,000                        | Basic plan + parallel jobs             |
| Azure DevOps Server             | ~$50,000 + infrastructure       | License + SQL Server + VMs             |
| Jenkins (current)               | $0 + infrastructure + admin FTE | Infrastructure + $160K admin           |

---

## Next steps

1. **Assess your impact level** --- Determine IL2/IL4/IL5 requirements for CI/CD data.
2. **Choose the target platform** --- Use the decision matrix above.
3. **Engage procurement** --- Start the acquisition process for GitHub Enterprise or Azure DevOps.
4. **Plan network architecture** --- Design self-hosted runner network for Azure Government.
5. **Implement SBOM and provenance** --- Address EO 14028 requirements in your CI/CD pipeline.
