# Architecture Diagram Gallery — CSA-in-a-Box Visual Reference

Presentation-ready Mermaid diagrams for architects, engineers, and stakeholders. Every diagram diffs cleanly in git, renders natively in MkDocs Material, and can be customized to match your organization's naming conventions, regions, or service selections. Copy any diagram into a design document, architecture decision record, or slide deck and adjust the labels to fit your context.

---

## Platform Overview

End-to-end CSA-in-a-Box platform from source systems through consumption. Use this when presenting the full solution to executive sponsors or during initial architecture reviews.

```mermaid
flowchart LR
    subgraph Sources[Data Sources]
        OLTP[OLTP DBs]
        SaaS[SaaS APIs]
        Files[Files]
        IoT[IoT]
    end
    subgraph Ingestion[Ingestion]
        ADF[Data Factory]
        EH[Event Hubs]
    end
    subgraph Storage[Storage]
        ADLS[(ADLS Gen2)]
        OneLake[(OneLake)]
    end
    subgraph Processing[Processing]
        DBX[Databricks / dbt]
        FabricSpark[Fabric Spark]
        SA[Stream Analytics]
    end
    subgraph Serving[Serving]
        SynSQL[Synapse SQL]
        Cosmos[(Cosmos DB)]
    end
    subgraph Consumption[Consumption]
        PBI[Power BI]
        APIs[APIs / APIM]
        Portal[Data Portal]
    end
    subgraph CrossCutting[Cross-Cutting]
        Purview[Purview]
        KV[Key Vault]
        Entra[Entra ID]
        Monitor[Monitor]
    end
    Sources --> Ingestion --> Storage --> Processing --> Serving --> Consumption
    CrossCutting -.->|governs| Storage
    CrossCutting -.->|secures| Processing
    CrossCutting -.->|monitors| Serving
    classDef source fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef ingest fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef store fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef process fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef serve fill:#fce4ec,stroke:#c62828,color:#b71c1c
    classDef consume fill:#e0f7fa,stroke:#00838f,color:#006064
    classDef cross fill:#f5f5f5,stroke:#616161,color:#212121
    class OLTP,SaaS,Files,IoT source
    class ADF,EH ingest
    class ADLS,OneLake store
    class DBX,FabricSpark,SA process
    class SynSQL,Cosmos serve
    class PBI,APIs,Portal consume
    class Purview,KV,Entra,Monitor cross
```

## Landing Zone Topology

Management group hierarchy with hub-spoke networking. Use this when presenting your subscription and governance layout to platform teams or during Azure landing zone workshops.

```mermaid
flowchart TB
    subgraph Root[Root Management Group]
        subgraph PlatformMG[Platform MG]
            IdentMG[Identity Sub]
            MgmtMG[Management Sub]
            ConnMG[Connectivity Sub]
        end
        subgraph LZMG[Landing Zone MG]
            DataMG[Data Sub]
            AIMG[AI / ML Sub]
            AppMG[App Sub]
        end
        subgraph SandboxMG[Sandbox MG]
            DevSub[Dev / Experiment Sub]
        end
    end
    subgraph Network[Network]
        HubVNet[Hub 10.0.0.0/16]
        DataSpoke[Data Spoke 10.1.0.0/16]
        AISpoke[AI Spoke 10.2.0.0/16]
        AppSpoke[App Spoke 10.3.0.0/16]
    end
    ConnMG --> HubVNet
    DataMG --> DataSpoke
    AIMG --> AISpoke
    AppMG --> AppSpoke
    HubVNet <-->|peering| DataSpoke
    HubVNet <-->|peering| AISpoke
    HubVNet <-->|peering| AppSpoke
    classDef platform fill:#e8eaf6,stroke:#283593,color:#1a237e
    classDef landing fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef sandbox fill:#fff8e1,stroke:#f9a825,color:#f57f17
    classDef network fill:#fce4ec,stroke:#c62828,color:#b71c1c
    class IdentMG,MgmtMG,ConnMG platform
    class DataMG,AIMG,AppMG landing
    class DevSub sandbox
    class HubVNet,DataSpoke,AISpoke,AppSpoke network
```

## Network Architecture

Hub-spoke network with firewall, gateways, private endpoints, and DNS zones. Use this during network design reviews or when explaining connectivity to security teams.

```mermaid
flowchart TB
    subgraph OnPrem[On-Premises]
        ER[ExpressRoute Circuit]
        VPNSITE[Site-to-Site VPN Backup]
    end
    subgraph Hub[Hub VNet -- 10.0.0.0/16]
        ERGW[ExpressRoute GW]
        VPNGW[VPN Gateway]
        FW[Azure Firewall]
        DNS[Private DNS Zones]
    end
    subgraph DataSpoke[Data Landing Zone -- 10.1.0.0/16]
        PESubnet[PE Subnet /24]
        DBXSubnet[Databricks /22]
        NSG1[NSG: data-nsg]
        ADLS_PE[ADLS PE]
        SYN_PE[Synapse PE]
    end
    subgraph AppSpoke[App Landing Zone -- 10.2.0.0/16]
        WebSubnet[Web Tier /24]
        NSG2[NSG: app-nsg]
    end
    ER --> ERGW --> FW
    VPNSITE --> VPNGW --> FW
    FW --> DataSpoke & AppSpoke
    Hub <-->|peering| DataSpoke
    Hub <-->|peering| AppSpoke
    DNS -.->|resolves| ADLS_PE & SYN_PE
    classDef hub fill:#e8eaf6,stroke:#283593,color:#1a237e
    classDef spoke fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef onprem fill:#efebe9,stroke:#4e342e,color:#3e2723
    class ERGW,VPNGW,FW,DNS hub
    class PESubnet,DBXSubnet,WebSubnet spoke
    class ER,VPNSITE onprem
    class NSG1,NSG2 spoke
```

## Security Zones

Trust boundary model showing traffic flow from the public internet through progressively restricted zones. Use this during threat modeling sessions and security architecture reviews.

```mermaid
flowchart LR
    subgraph Public[Public Internet -- Untrusted]
        User[End User]
        ExtAPI[External API Client]
    end
    subgraph Edge[Edge -- DMZ]
        WAF[WAF on Front Door]
        APIM[API Management]
        CA[Conditional Access]
    end
    subgraph AppTier[App Tier -- Semi-Trusted]
        WebApp[App Service + MI]
        FuncApp[Functions + MI]
    end
    subgraph DataTier[Data Tier -- Isolated]
        PE[Private Endpoints]
        ADLS[(ADLS Gen2)]
        SQL[(Synapse SQL RLS)]
        Cosmos2[(Cosmos DB)]
    end
    subgraph Secrets[Secrets Tier]
        KV2[Key Vault HSM]
        CMK[CMK + Certs]
    end
    subgraph Audit[Audit]
        Sentinel[Sentinel + Defender]
        Purview2[Purview DLP]
    end
    User --> WAF --> CA
    ExtAPI --> APIM --> CA
    CA -->|authenticated| WebApp
    CA -->|authenticated| FuncApp
    WebApp -->|managed identity| PE
    FuncApp -->|managed identity| PE
    PE --> ADLS & SQL & Cosmos2
    WebApp & FuncApp -->|managed identity| KV2
    KV2 --> CMK
    AppTier & DataTier -.->|logs| Audit
    classDef public fill:#ffebee,stroke:#c62828,color:#b71c1c
    classDef edge fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef app fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef data fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef secret fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef audit fill:#f5f5f5,stroke:#616161,color:#212121
    class User,ExtAPI public
    class WAF,APIM,CA edge
    class WebApp,FuncApp app
    class PE,ADLS,SQL,Cosmos2 data
    class KV2,CMK secret
    class Sentinel,Purview2 audit
```

---

## Medallion Data Flow

Bronze-silver-gold architecture with specific Azure services at each layer. Use this to explain the data transformation pipeline to data engineers and business stakeholders.

```mermaid
flowchart LR
    subgraph Sources[Source Systems]
        DB[Relational DBs]
        API[SaaS APIs]
        Stream[Streams]
        FileDrops[Files]
    end
    subgraph Bronze[Bronze -- Raw / Immutable]
        BDelta[(Delta Tables ADLS Gen2)]
        BSchema[Source Schema + Metadata]
    end
    subgraph Silver[Silver -- Cleaned / Conformed]
        SDelta[(Delta Tables SCD2)]
        dbtClean[dbt: Type-cast, Dedupe, Nulls]
        DQ[Great Expectations + dbt Tests]
    end
    subgraph Gold[Gold -- Business-Ready]
        GDelta[(Star Schema Aggregated)]
        dbtGold[dbt: Business Logic]
        Semantic[Semantic Layer / Metrics]
    end
    subgraph Serve[Serving]
        Synapse2[Synapse Serverless]
        PBI2[Power BI DirectLake]
    end
    subgraph Governance[Governance]
        PurviewLin[Purview Lineage + Classification]
    end
    Sources -->|ADF / EH Capture| Bronze -->|dbt run| Silver -->|dbt run| Gold --> Serve
    dbtClean & dbtGold -->|lineage| PurviewLin
    DQ -->|quality metrics| PurviewLin
    classDef source fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef bronze fill:#efebe9,stroke:#4e342e,color:#3e2723
    classDef silver fill:#eceff1,stroke:#546e7a,color:#263238
    classDef gold fill:#fff8e1,stroke:#f9a825,color:#f57f17
    classDef serving fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef gov fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    class DB,API,Stream,FileDrops source
    class BDelta,BSchema bronze
    class SDelta,dbtClean,DQ silver
    class GDelta,dbtGold,Semantic gold
    class Synapse2,PBI2 serving
    class PurviewLin gov
```

---

## AI/ML Pipeline

End-to-end machine learning lifecycle from data preparation to production monitoring. Use this when presenting ML platform architecture to data science teams or reviewing MLOps maturity.

```mermaid
flowchart LR
    subgraph Data[Data Preparation]
        GoldLayer[(Gold Layer)]
        FeatureEng[Feature Engineering]
        FeatureStore[(Feature Store)]
    end
    subgraph Training[Training]
        Notebooks[Notebooks Databricks / Fabric]
        AzureML[Azure ML]
    end
    subgraph Registry[Registry]
        MLflow[MLflow Dev / Staging / Prod]
        Validation[Validation Gates]
    end
    subgraph Deployment[Deployment]
        Managed[Online Endpoints]
        Batch[Batch Endpoints]
    end
    subgraph Monitoring[Monitoring]
        DataDrift[Data Drift]
        ModelPerf[Performance]
        AzMon[Azure Monitor]
        Feedback[Retrain Trigger]
    end
    GoldLayer --> FeatureEng --> FeatureStore
    FeatureStore --> Notebooks & AzureML
    Notebooks & AzureML --> MLflow --> Validation
    Validation --> Managed & Batch
    Managed --> DataDrift
    Batch --> ModelPerf
    DataDrift & ModelPerf --> AzMon --> Feedback -->|retrain| Notebooks
    classDef data fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef train fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef registry fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef deploy fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef monitor fill:#fce4ec,stroke:#c62828,color:#b71c1c
    class GoldLayer,FeatureEng,FeatureStore data
    class Notebooks,AzureML train
    class MLflow,Validation registry
    class Managed,Batch deploy
    class DataDrift,ModelPerf,AzMon,Feedback monitor
```

---

## Real-Time Streaming

Event-driven architecture for near-real-time analytics and alerting. Use this when designing streaming workloads or presenting real-time capabilities to stakeholders.

```mermaid
flowchart LR
    subgraph Producers[Event Producers]
        IoTHub[IoT Hub]
        EHProd[Event Hubs]
    end
    subgraph StreamProc[Stream Processing]
        SA2[Stream Analytics]
        FabricES[Fabric Eventstreams]
        SparkStream[Spark Structured Streaming]
    end
    subgraph HotStore[Hot Store]
        Eventhouse[(Eventhouse KQL)]
        CosmosRT[(Cosmos DB)]
    end
    subgraph RealTimeDash[Real-Time Consumption]
        PBIRT[Power BI Real-Time]
        DataAct[Data Activator]
    end
    IoTHub --> SA2 & FabricES
    EHProd --> FabricES & SparkStream
    SA2 & FabricES --> Eventhouse
    FabricES --> CosmosRT
    SparkStream --> CosmosRT
    Eventhouse --> PBIRT
    CosmosRT --> PBIRT
    DataAct -.->|monitors| Eventhouse
    classDef producer fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef stream fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef hot fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef consume fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    class IoTHub,EHProd producer
    class SA2,FabricES,SparkStream stream
    class Eventhouse,CosmosRT hot
    class PBIRT,DataAct consume
```

---

## Multi-Tenant Isolation

Shared infrastructure with per-tenant data and access boundaries. Use this when designing SaaS-style deployments or explaining tenant isolation to compliance reviewers.

```mermaid
flowchart TB
    subgraph Shared[Shared Infrastructure]
        HubNet[Hub VNet + FW + DNS]
        SharedPurview[Purview Catalog]
        SharedEntra[Entra ID]
    end
    subgraph TenantA[Tenant A -- Contoso]
        RGA[RG rg-contoso-data]
        ROLA[RBAC: Contoso Admins]
        NETA[Spoke A + NSG]
        DATAA[(ADLS contoso/)]
    end
    subgraph TenantB[Tenant B -- Fabrikam]
        RGB[RG rg-fabrikam-data]
        ROLB[RBAC: Fabrikam Admins]
        NETB[Spoke B + NSG]
        DATAB[(ADLS fabrikam/)]
    end
    Shared ---|shared services| TenantA
    Shared ---|shared services| TenantB
    HubNet <-->|peering| NETA
    HubNet <-->|peering| NETB
    SharedPurview -.->|governs| DATAA & DATAB
    SharedEntra -.->|authenticates| ROLA & ROLB
    classDef shared fill:#e8eaf6,stroke:#283593,color:#1a237e
    classDef tenantA fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef tenantB fill:#fff3e0,stroke:#e65100,color:#bf360c
    class HubNet,SharedPurview,SharedEntra shared
    class RGA,ROLA,NETA,DATAA tenantA
    class RGB,ROLB,NETB,DATAB tenantB
```

---

## Data Mesh Federation

Domain-oriented data ownership with federated governance through a global catalog. Use this when presenting a data mesh strategy or explaining how autonomous domain teams share data products.

```mermaid
flowchart TB
    subgraph DomainSales[Sales Domain]
        SalesLH[(Sales Lakehouse)]
        SalesCat[Purview Collection]
        SalesAPI[Data Product API]
    end
    subgraph DomainFinance[Finance Domain]
        FinLH[(Finance Lakehouse)]
        FinCat[Purview Collection]
        FinAPI[Data Product API]
    end
    subgraph DomainOps[Operations Domain]
        OpsLH[(Ops Lakehouse)]
        OpsCat[Purview Collection]
        OpsAPI[Data Product API]
    end
    subgraph FederatedGov[Federated Governance]
        GlobalCat[Purview Global Catalog]
        OneLakeSC[OneLake Shortcuts]
        APIMGateway[APIM Gateway]
    end
    SalesCat & FinCat & OpsCat -->|publishes| GlobalCat
    SalesLH & FinLH & OpsLH <-.->|shortcut| OneLakeSC
    SalesAPI & FinAPI & OpsAPI --> APIMGateway
    classDef sales fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef finance fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef ops fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef gov fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    class SalesLH,SalesCat,SalesAPI sales
    class FinLH,FinCat,FinAPI finance
    class OpsLH,OpsCat,OpsAPI ops
    class GlobalCat,OneLakeSC,APIMGateway gov
```

---

## CI/CD Pipeline

End-to-end deployment pipeline from developer commit through production validation. Use this during DevOps reviews or when onboarding engineers to the deployment process.

```mermaid
flowchart LR
    subgraph Dev[Developer Workflow]
        DevLocal[Local Dev Feature Branch]
        Commit[Git Commit + Push]
    end
    subgraph PR[Pull Request Validation]
        Lint[Lint: Bicep / Python / SQL]
        UnitTest[Unit Tests: pytest / jest]
        SecScan[Security: Trivy + Checkov]
        PRReview[Code Review]
    end
    subgraph Staging[Staging Deploy]
        WhatIf[Bicep What-If]
        StageDeploy[Deploy to Staging]
    end
    subgraph Approval[Approval Gate]
        ManualApproval[Tech Lead Approval]
    end
    subgraph Prod[Production Deploy]
        ProdDeploy[Deploy to Production]
        PostVal[Post-Deploy Validation]
        Rollback[Rollback Plan]
    end
    subgraph Monitor2[Monitoring]
        Alerts[Azure Monitor Alerts]
        Dashboards[Grafana / PBI]
    end
    DevLocal --> Commit --> Lint --> UnitTest --> SecScan --> PRReview
    PRReview -->|merge| WhatIf --> StageDeploy
    StageDeploy --> ManualApproval --> ProdDeploy
    ProdDeploy --> PostVal --> Alerts --> Dashboards
    ProdDeploy -.->|on failure| Rollback
    classDef dev fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef pr fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef stage fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef approve fill:#fff8e1,stroke:#f9a825,color:#f57f17
    classDef prod fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef mon fill:#fce4ec,stroke:#c62828,color:#b71c1c
    class DevLocal,Commit dev
    class Lint,UnitTest,SecScan,PRReview pr
    class WhatIf,StageDeploy stage
    class ManualApproval approve
    class ProdDeploy,PostVal,Rollback prod
    class Alerts,Dashboards mon
```

---

## Disaster Recovery

Active-passive cross-region architecture with RPO/RTO targets. Use this during business continuity planning and DR tabletop exercises.

```mermaid
flowchart LR
    subgraph Primary[Primary -- East US]
        PADLS[(ADLS Gen2)]
        PCosmos[(Cosmos DB)]
        PSQL[(Azure SQL)]
        PCompute[Databricks / Fabric]
    end
    subgraph Replication[Replication]
        GRS[ADLS GRS -- RPO under 15 min]
        CosmosGeo[Cosmos Geo -- RPO under 5 min]
        SQLGeo[SQL Geo -- RPO under 5 sec]
    end
    subgraph Secondary[Secondary -- West US]
        SADLS[(ADLS Replica)]
        SCosmos[(Cosmos Read)]
        SSQL[(SQL Secondary)]
        SCompute[Compute Standby]
    end
    subgraph Failover[Failover]
        TM[Traffic Manager / Front Door]
        RunBook[Automation Runbook]
    end
    PADLS -->|GRS| GRS --> SADLS
    PCosmos -->|multi-region| CosmosGeo --> SCosmos
    PSQL -->|geo-rep| SQLGeo --> SSQL
    TM -.->|health probe| Primary
    TM -.->|failover| Secondary
    RunBook -.->|provisions| SCompute
    classDef primary fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef repl fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef secondary fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef failover fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    class PADLS,PCosmos,PSQL,PCompute primary
    class GRS,CosmosGeo,SQLGeo repl
    class SADLS,SCosmos,SSQL,SCompute secondary
    class TM,RunBook failover
```

---

## Identity & Access Flow

Token-based authentication and authorization from user login through data access. Use this when explaining identity architecture to security reviewers or onboarding developers to the auth model.

```mermaid
flowchart LR
    subgraph UserAccess[User Access]
        User2[End User]
        Admin[Admin]
    end
    subgraph EntraAuth[Entra ID -- Authentication]
        CondAccess[Conditional Access]
        MFA2[MFA]
        PIM2[PIM JIT]
        Token[OAuth2 Token]
    end
    subgraph AppLayer[Application Layer]
        AppSvc[App Service]
        ManagedID[Managed Identity]
    end
    subgraph SecretsMgmt[Secrets]
        KV3[Key Vault]
        ConnStrings[Conn Strings / Keys / Certs]
    end
    subgraph DataAccess[Data Services -- Authorization]
        ADLS2[(ADLS Gen2 RBAC)]
        Synapse3[Synapse RBAC]
        CosmosRBAC[(Cosmos DB)]
    end
    User2 --> CondAccess
    Admin --> PIM2 -->|JIT| CondAccess
    CondAccess --> MFA2 --> Token
    Token --> AppSvc --> ManagedID
    ManagedID --> KV3 --> ConnStrings
    ManagedID --> ADLS2 & Synapse3 & CosmosRBAC
    classDef user fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef auth fill:#fff3e0,stroke:#e65100,color:#bf360c
    classDef appl fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef secrets fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    classDef dataAccess fill:#fce4ec,stroke:#c62828,color:#b71c1c
    class User2,Admin user
    class CondAccess,MFA2,PIM2,Token auth
    class AppSvc,ManagedID appl
    class KV3,ConnStrings secrets
    class ADLS2,Synapse3,CosmosRBAC dataAccess
```

---

## Related

These diagrams correspond to the deep-dive documentation across the CSA-in-a-Box reference library. Use the links below to move from the visual overview to detailed implementation guidance.

| Diagram                | Reference Architecture                                                | Patterns                                                            | Best Practices                                                        |
| ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Platform Overview      | [Fabric vs Synapse vs Databricks](fabric-vs-synapse-vs-databricks.md) |                                                                     |                                                                       |
| Landing Zone Topology  | [Hub-Spoke Topology](hub-spoke-topology.md)                           | [Networking & DNS Strategy](../patterns/networking-dns-strategy.md) |                                                                       |
| Network Architecture   | [Hub-Spoke Topology](hub-spoke-topology.md)                           | [Networking & DNS Strategy](../patterns/networking-dns-strategy.md) | [Security & Compliance](../best-practices/security-compliance.md)     |
| Security Zones         | [Identity & Secrets Flow](identity-secrets-flow.md)                   |                                                                     | [Security & Compliance](../best-practices/security-compliance.md)     |
| Medallion Data Flow    | [Data Flow Medallion](data-flow-medallion.md)                         |                                                                     | [Medallion Architecture](../best-practices/medallion-architecture.md) |
| AI/ML Pipeline         |                                                                       | [LLMOps Evaluation](../patterns/llmops-evaluation.md)               |                                                                       |
| Real-Time Streaming    |                                                                       | [Streaming & CDC](../patterns/streaming-cdc.md)                     |                                                                       |
| Multi-Tenant Isolation |                                                                       |                                                                     | [Security & Compliance](../best-practices/security-compliance.md)     |
| Data Mesh Federation   |                                                                       |                                                                     | [Data Governance](../best-practices/data-governance.md)               |
| CI/CD Pipeline         |                                                                       |                                                                     | [IaC & CI/CD](../best-practices/iac-cicd.md)                          |
| Disaster Recovery      |                                                                       |                                                                     | [Disaster Recovery](../best-practices/disaster-recovery.md)           |
| Identity & Access      | [Identity & Secrets Flow](identity-secrets-flow.md)                   |                                                                     | [Security & Compliance](../best-practices/security-compliance.md)     |
