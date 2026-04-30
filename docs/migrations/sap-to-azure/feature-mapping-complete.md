# SAP to Azure: Complete Feature Mapping

**Every SAP component mapped to its Azure equivalent with migration complexity ratings, CSA-in-a-Box integration points, and gap analysis.**

---

## How to read this document

Each table maps SAP capabilities to Azure equivalents with the following ratings:

- **Migration effort:** XS (< 1 week), S (1--4 weeks), M (1--3 months), L (3--6 months), XL (6--12 months)
- **Parity:** Full (feature-complete equivalent), High (90%+ coverage), Medium (70--90%), Low (< 70%), Different (fundamentally different approach)
- **CSA-in-a-Box role:** How the CSA-in-a-Box platform integrates with or enhances the Azure equivalent

---

## 1. SAP HANA database layer

| SAP HANA capability                    | Azure equivalent                                                              | Parity | Effort | CSA-in-a-Box integration                                          | Notes                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- | ------ | ------ | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| HANA in-memory columnar store          | Azure VMs (M-series, Mv2) running SAP HANA                                    | Full   | M      | Fabric Mirroring replicates HANA data to OneLake                  | Same HANA binary, Azure-certified hardware                  |
| HANA scale-up (single node)            | M-series up to 11.4 TB; HLI up to 24 TB                                       | Full   | M      | N/A                                                               | Mv2-series for 6+ TB workloads                              |
| HANA scale-out (multi-node)            | Azure VMs with ANF shared storage                                             | Full   | L      | N/A                                                               | Certified for BW/4HANA scale-out                            |
| HANA System Replication (HSR)          | HSR on Azure VMs (synchronous/asynchronous)                                   | Full   | M      | N/A                                                               | Same HSR, Azure Pacemaker/SLES HA for automation            |
| HANA backup (BACKINT)                  | Azure Backup for SAP HANA (BACKINT-certified)                                 | Full   | S      | N/A                                                               | Streaming backup to Azure Storage, no third-party needed    |
| HANA tenant databases                  | Multi-tenant database containers on Azure VMs                                 | Full   | S      | Each tenant can mirror to separate Fabric workspace               | Same MDC architecture                                       |
| HANA XSA (XS Advanced)                 | SAP HANA XSA on Azure VMs; consider migration to SAP BTP or Azure App Service | Medium | L      | N/A                                                               | XSA applications may need refactoring for BTP or Azure PaaS |
| HANA Smart Data Integration (SDI)      | ADF SAP connectors + Fabric Mirroring                                         | High   | M      | ADF provides SAP Table, BW, HANA, ODP connectors                  | SDI data provisioning maps to ADF + Fabric                  |
| HANA Smart Data Access (SDA)           | Databricks Lakehouse Federation                                               | High   | S      | Unity Catalog federates queries across SAP HANA and other sources | Virtual access pattern preserved                            |
| HANA Predictive Analysis Library (PAL) | Azure ML + Databricks ML                                                      | High   | M      | CSA-in-a-Box AI integration layer                                 | PAL algorithms available in scikit-learn, Spark ML          |
| HANA Spatial Engine                    | Azure SQL (spatial) + Databricks (GeoSpark)                                   | Medium | M      | CSA-in-a-Box GeoAnalytics patterns                                | Spatial queries require code migration                      |
| HANA Graph Engine                      | Azure Cosmos DB (Gremlin) + Neo4j on Azure                                    | Medium | L      | N/A                                                               | Graph workloads require architectural redesign              |
| HANA Text Analysis                     | Azure AI Language + Cognitive Services                                        | High   | M      | Azure AI Foundry integration                                      | Better NLP capabilities than HANA Text                      |

---

## 2. SAP application layer (NetWeaver / S/4HANA)

| SAP capability                        | Azure equivalent                                               | Parity | Effort | CSA-in-a-Box integration                                     | Notes                                                            |
| ------------------------------------- | -------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| SAP NetWeaver ABAP stack              | Azure VMs (E-series, D-series)                                 | Full   | M      | Azure Monitor for SAP Solutions                              | Same SAP kernel, Azure-certified                                 |
| SAP NetWeaver Java stack              | Azure VMs; consider migration to Azure App Service             | Full   | M      | N/A                                                          | Java stack deprecated in S/4HANA; migrate to ABAP                |
| SAP Central Services (ASCS/SCS)       | Azure VMs with Pacemaker/WSFC HA                               | Full   | M      | N/A                                                          | HA cluster using Azure Load Balancer + shared storage            |
| SAP Enqueue Replication Server (ERS)  | ERS on Azure VMs with HA cluster                               | Full   | S      | N/A                                                          | ENSA2 recommended for S/4HANA                                    |
| SAP Web Dispatcher                    | Azure VMs or Azure Application Gateway                         | Full   | S      | N/A                                                          | Application Gateway provides WAF capabilities                    |
| SAP Fiori (UI5)                       | SAP Fiori on Azure VMs; Azure Front Door for CDN               | Full   | S      | Power BI embedded for analytics tiles                        | Fiori launchpad runs unchanged                                   |
| SAP Gateway (OData)                   | SAP Gateway on Azure VMs; API Management for external exposure | Full   | S      | APIM data mesh gateway pattern                               | OData services accessible via APIM                               |
| SAP Batch processing                  | SAP batch on Azure VMs; autoscale dialog instances             | Full   | S      | N/A                                                          | Azure VM autoscale for batch windows                             |
| SAP Transport Management System (TMS) | TMS on Azure VMs; Azure DevOps for CI/CD integration           | Full   | S      | N/A                                                          | Consider SAP Cloud Transport Management for RISE                 |
| SAP Solution Manager (SolMan)         | Azure Monitor for SAP Solutions + Azure DevOps                 | High   | M      | CSA-in-a-Box monitoring integration                          | ACSS replaces most SolMan monitoring; ChaRM maps to Azure DevOps |
| SAP Focused Run                       | Azure Monitor for SAP Solutions                                | High   | M      | N/A                                                          | Focused Run monitoring capabilities in ACSS                      |
| SAP Process Orchestration (PO)        | Azure Integration Services (Logic Apps, APIM, Service Bus)     | High   | L      | ADF for data integration; Logic Apps for process integration | See [Integration Migration](integration-migration.md)            |
| SAP Process Integration (PI)          | Azure Integration Services                                     | High   | L      | N/A                                                          | Same migration path as PI/PO                                     |

---

## 3. SAP analytics and reporting

| SAP capability              | Azure equivalent                              | Parity | Effort | CSA-in-a-Box integration                               | Notes                                                      |
| --------------------------- | --------------------------------------------- | ------ | ------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| SAP BW (Business Warehouse) | Microsoft Fabric Lakehouse + dbt + Databricks | High   | XL     | OneLake as unified data lake; dbt for transformations  | Large BW migrations are multi-year; phase by InfoArea      |
| SAP BW/4HANA                | Microsoft Fabric Lakehouse + Databricks       | High   | L--XL  | Fabric Mirroring for BW/4HANA tables                   | BW/4HANA simplifies migration; fewer legacy objects        |
| SAP BW InfoCubes            | Fabric Lakehouse Delta tables                 | High   | M      | dbt models replace InfoCube load logic                 | Star schema preserved in Delta tables                      |
| SAP BW DSOs/ADSOs           | Fabric Lakehouse Delta tables (staging layer) | High   | M      | dbt incremental models replace DSO activation          | ADSO maps cleanly to incremental Delta tables              |
| SAP BW CompositeProviders   | Fabric SQL endpoint views / Databricks views  | High   | M      | Unity Catalog views for cross-domain access            | Virtual layer maps to SQL views                            |
| SAP BW Open Hub             | ADF SAP BW connector + Fabric pipelines       | Full   | S      | ADF extracts from BW Open Hub Destinations             | Direct replacement for data distribution                   |
| SAP BW Process Chains       | ADF pipelines + Fabric data pipelines         | High   | M      | ADF orchestrates extraction; Fabric handles downstream | Process chain logic decomposes into ADF activities         |
| SAP Analytics Cloud (SAC)   | Power BI Premium + Fabric                     | High   | M      | Direct Lake mode on OneLake; Copilot for Power BI      | SAC planning capabilities require additional consideration |
| SAP BusinessObjects (BO)    | Power BI Premium                              | High   | M--L   | Power BI semantic models replace BO universes          | Universe-to-semantic-model migration                       |
| SAP Crystal Reports         | Power BI paginated reports (SSRS)             | High   | M      | N/A                                                    | Pixel-perfect reports via Power BI Report Builder          |
| SAP Lumira                  | Power BI Desktop                              | Full   | S      | N/A                                                    | Direct replacement for self-service visualization          |
| SAP Analysis for Office     | Power BI Desktop + Excel (Analyze in Excel)   | High   | S      | N/A                                                    | Analyze in Excel provides similar Excel integration        |
| SAP HANA Live views         | Fabric SQL endpoint + Power BI DirectQuery    | High   | M      | Fabric Mirroring provides real-time data access        | Replace HANA Live with Fabric SQL endpoint views           |

---

## 4. SAP integration and middleware

| SAP capability                   | Azure equivalent                                | Parity | Effort | CSA-in-a-Box integration                        | Notes                                            |
| -------------------------------- | ----------------------------------------------- | ------ | ------ | ----------------------------------------------- | ------------------------------------------------ |
| SAP PI/PO (Integration)          | Azure Logic Apps + API Management + Service Bus | High   | L      | APIM data mesh gateway for SAP API exposure     | Interface-by-interface migration                 |
| SAP Cloud Integration (CPI/CI)   | Azure Logic Apps or retain CPI on BTP           | Full   | S--M   | N/A                                             | CPI can coexist with Azure Integration Services  |
| RFC connections                  | SAP .NET Connector + Azure Functions            | Full   | S      | N/A                                             | RFC calls from Azure Functions/Logic Apps        |
| IDoc processing                  | Logic Apps SAP connector (IDoc send/receive)    | Full   | S      | ADF for bulk IDoc extraction                    | Logic Apps native IDoc support                   |
| BAPI calls                       | Logic Apps SAP connector + Azure Functions      | Full   | S      | N/A                                             | Synchronous BAPI calls from Logic Apps           |
| SAP Event Mesh                   | Azure Event Grid + Service Bus                  | High   | M      | Event Hubs for high-volume SAP events           | SAP Business Events map to Event Grid topics     |
| SAP BTP Integration Suite        | Coexist with Azure Integration Services         | Full   | S      | N/A                                             | BTP and Azure integration can run in parallel    |
| SAP Data Intelligence            | Azure Data Factory + Databricks                 | High   | M--L   | Full CSA-in-a-Box data engineering layer        | DI pipelines migrate to ADF + dbt                |
| OData services (SAP Gateway)     | API Management + Azure Functions                | Full   | S      | APIM policies for rate limiting, caching        | OData passthrough or transformation              |
| SAP Master Data Governance (MDG) | Purview + custom MDM on Azure                   | Medium | L      | Purview data catalog for master data governance | MDG business rules require custom implementation |

---

## 5. SAP security and identity

| SAP capability                        | Azure equivalent                                 | Parity | Effort | CSA-in-a-Box integration                     | Notes                                                       |
| ------------------------------------- | ------------------------------------------------ | ------ | ------ | -------------------------------------------- | ----------------------------------------------------------- |
| SAP user authentication               | Microsoft Entra ID (SAML 2.0 SSO)                | Full   | M      | Entra ID as unified identity plane           | SAML SSO for Fiori, Web GUI, HANA Studio                    |
| SAP authorization (roles/profiles)    | SAP roles unchanged; Entra ID for authentication | Full   | S      | N/A                                          | Authorization remains in SAP; authentication moves to Entra |
| SAP GRC Access Control                | Entra ID Governance + PIM                        | High   | L      | Purview data access governance               | GRC access risk analysis maps to Entra PIM                  |
| SAP GRC Process Control               | Microsoft Purview Compliance Manager             | Medium | L      | CSA-in-a-Box compliance control mappings     | Process control rules require re-implementation             |
| SAP GRC Risk Management               | Microsoft Purview + Defender for Cloud           | Medium | L      | N/A                                          | Risk frameworks require custom mapping                      |
| SAP Identity Management (IdM)         | Microsoft Entra ID + SCIM provisioning           | High   | M      | N/A                                          | Entra ID replaces SAP IdM for identity lifecycle            |
| SAP Single Sign-On (SSO)              | Entra ID SAML/OAuth + Conditional Access         | Full   | M      | N/A                                          | Conditional Access adds MFA, device compliance              |
| SAP Cloud Identity Services (IAS/IPS) | Entra ID (identity) + Entra ID Governance        | High   | M      | N/A                                          | IAS/IPS can federate with Entra ID                          |
| SNC (Secure Network Communications)   | Azure Private Link + Private Endpoints           | Full   | M      | N/A                                          | Network-level encryption replaced by Azure networking       |
| SAP HANA encryption (data at rest)    | Azure Key Vault (BYOK/CMK)                       | Full   | S      | N/A                                          | HANA TDE with Azure Key Vault managed keys                  |
| SAP HANA encryption (data in transit) | TLS 1.2/1.3 (Azure enforced)                     | Full   | XS     | N/A                                          | Azure enforces TLS by default                               |
| SAP audit logging                     | Azure Monitor + Log Analytics + Sentinel         | High   | M      | CSA-in-a-Box monitoring and compliance layer | SAP audit logs stream to Log Analytics                      |

---

## 6. SAP monitoring and operations

| SAP capability                   | Azure equivalent                            | Parity | Effort | CSA-in-a-Box integration            | Notes                                                     |
| -------------------------------- | ------------------------------------------- | ------ | ------ | ----------------------------------- | --------------------------------------------------------- |
| SAP Solution Manager monitoring  | Azure Monitor for SAP Solutions (ACSS)      | High   | M      | CSA-in-a-Box monitoring integration | ACSS provides HANA + NetWeaver + OS monitoring            |
| SAP EarlyWatch alerts            | Azure Monitor alerts + ACSS health checks   | High   | S      | N/A                                 | ACSS quality checks replace EarlyWatch for infrastructure |
| SAP CCMS (Computing Center Mgmt) | Azure Monitor + Log Analytics               | High   | M      | N/A                                 | CCMS metrics stream to Azure Monitor                      |
| SAP HANA cockpit                 | HANA cockpit on Azure VMs + ACSS monitoring | Full   | S      | N/A                                 | HANA cockpit runs unchanged; ACSS adds Azure-native view  |
| SAP Landscape Management (LaMa)  | Azure Center for SAP Solutions              | High   | M      | N/A                                 | ACSS provides deployment and lifecycle management         |
| SAPS benchmarking                | Azure VM SAPS ratings (published by SAP)    | Full   | XS     | N/A                                 | SAP certifies and publishes SAPS for each VM family       |
| SAP HANA backup monitoring       | Azure Backup for SAP HANA + ACSS            | Full   | S      | N/A                                 | Backup alerts in Azure Monitor                            |
| SAP transport logging            | Azure DevOps + SAP Cloud TMS                | High   | M      | N/A                                 | CI/CD integration for transport management                |

---

## 7. SAP industry solutions

| SAP capability             | Azure equivalent                   | Parity | Effort | CSA-in-a-Box integration                                              | Notes                                                     |
| -------------------------- | ---------------------------------- | ------ | ------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| SAP S/4HANA Finance        | S/4HANA Finance on Azure VMs       | Full   | M      | Fabric Mirroring for financial data; Power BI for financial reporting | Same application, Azure infrastructure                    |
| SAP S/4HANA Supply Chain   | S/4HANA Supply Chain on Azure VMs  | Full   | M      | Azure AI for demand forecasting on SAP data                           | Same application, Azure infrastructure                    |
| SAP SuccessFactors         | SuccessFactors (SaaS, unchanged)   | Full   | XS     | Fabric Mirroring for HR analytics                                     | Cloud SaaS; no migration needed                           |
| SAP Ariba                  | Ariba (SaaS, unchanged)            | Full   | XS     | Fabric for procurement analytics                                      | Cloud SaaS; no migration needed                           |
| SAP Concur                 | Concur (SaaS, unchanged)           | Full   | XS     | N/A                                                                   | Cloud SaaS; no migration needed                           |
| SAP Fieldglass             | Fieldglass (SaaS, unchanged)       | Full   | XS     | N/A                                                                   | Cloud SaaS; no migration needed                           |
| SAP for Defense & Security | S/4HANA on Azure Government        | Full   | L      | Federal compliance mappings                                           | See [Federal Migration Guide](federal-migration-guide.md) |
| SAP for Public Sector      | S/4HANA on Azure Government        | Full   | L      | Federal compliance mappings                                           | Grants management, funds management on Azure Gov          |
| SAP IS-Utilities           | S/4HANA Utilities on Azure VMs     | Full   | L      | Fabric for utility analytics                                          | Industry-specific modules run unchanged                   |
| SAP IS-Oil & Gas           | S/4HANA for Oil & Gas on Azure VMs | Full   | L      | N/A                                                                   | Industry-specific modules run unchanged                   |

---

## 8. SAP development and extensibility

| SAP capability                             | Azure equivalent                                         | Parity | Effort | CSA-in-a-Box integration                               | Notes                                                 |
| ------------------------------------------ | -------------------------------------------------------- | ------ | ------ | ------------------------------------------------------ | ----------------------------------------------------- |
| ABAP development (SE80, ADT)               | ABAP on Azure VMs (unchanged); ABAP Cloud for clean core | Full   | XS     | N/A                                                    | Same ABAP workbench, Azure infrastructure             |
| SAP BTP (ABAP Environment)                 | SAP BTP (SaaS) alongside Azure                           | Full   | S      | BTP connects to CSA-in-a-Box via Integration Services  | BTP runs independently; integrates with Azure         |
| SAP CAP (Cloud Application Programming)    | SAP CAP on BTP or Azure App Service                      | Full   | S      | N/A                                                    | Node.js/Java CAP apps can deploy to Azure App Service |
| SAP Fiori Elements                         | Fiori Elements on Azure VMs                              | Full   | XS     | N/A                                                    | UI5 apps run unchanged                                |
| SAP Build (low-code)                       | Power Apps + Power Automate                              | High   | M      | Power Platform integrates with CSA-in-a-Box data layer | Power Platform provides broader low-code capabilities |
| SAP HANA XSA applications                  | Migrate to SAP BTP or Azure App Service                  | Medium | L      | N/A                                                    | XSA apps require refactoring                          |
| ABAP RESTful Application Programming (RAP) | RAP on Azure VMs (unchanged)                             | Full   | XS     | N/A                                                    | RAP model runs on same ABAP stack                     |

---

## 9. SAP data formats and protocols

| SAP protocol / format                             | Azure equivalent                                 | Parity | Effort | Notes                                    |
| ------------------------------------------------- | ------------------------------------------------ | ------ | ------ | ---------------------------------------- |
| RFC (Remote Function Call)                        | Logic Apps SAP connector / Azure Functions + NCo | Full   | S      | Synchronous SAP communication            |
| tRFC (transactional RFC)                          | Logic Apps SAP connector (async)                 | Full   | S      | Guaranteed delivery                      |
| qRFC (queued RFC)                                 | Service Bus + Logic Apps SAP connector           | Full   | M      | Ordered processing with Service Bus FIFO |
| IDoc (Intermediate Document)                      | Logic Apps SAP connector (IDoc send/receive)     | Full   | S      | EDI and B2B document exchange            |
| BAPI (Business Application Programming Interface) | Logic Apps SAP connector / Azure Functions + NCo | Full   | S      | Typed SAP business object APIs           |
| OData (SAP Gateway)                               | API Management passthrough / Azure Functions     | Full   | S      | REST-based SAP access                    |
| ABAP CDS views                                    | Fabric SQL endpoint (via Mirroring)              | High   | M      | CDS-based analytical views               |
| SAP HANA MDX                                      | Fabric SQL endpoint (SQL alternative)            | Medium | M      | MDX queries require conversion to SQL    |
| SAP HANA SQL                                      | Fabric SQL endpoint (native)                     | Full   | S      | Standard SQL access to mirrored data     |
| ALE (Application Link Enabling)                   | Logic Apps + Service Bus                         | High   | M      | Master data distribution                 |
| EDI (Electronic Data Interchange)                 | Logic Apps B2B (AS2, EDIFACT, X12)               | Full   | M      | EDI partner integration                  |

---

## 10. SAP cloud services (SaaS) --- no migration needed

These SAP cloud services run independently and do not require migration. CSA-in-a-Box integrates with them for analytics.

| SAP SaaS service                       | Migration action | CSA-in-a-Box integration                          | Notes                                      |
| -------------------------------------- | ---------------- | ------------------------------------------------- | ------------------------------------------ |
| SAP SuccessFactors                     | None (SaaS)      | Fabric Mirroring / ADF connector for HR analytics | HR data to OneLake for workforce analytics |
| SAP Ariba                              | None (SaaS)      | ADF connector for procurement analytics           | Procurement spend analysis in Power BI     |
| SAP Concur                             | None (SaaS)      | ADF connector for T&E analytics                   | Travel and expense reporting               |
| SAP Fieldglass                         | None (SaaS)      | ADF connector for contingent workforce data       | Workforce planning analytics               |
| SAP Customer Experience (C/4HANA)      | None (SaaS)      | ADF connector for CX analytics                    | Customer engagement data                   |
| SAP Integrated Business Planning (IBP) | None (SaaS)      | ADF connector for planning data                   | Demand/supply planning analytics           |
| SAP Business Network                   | None (SaaS)      | Event-driven integration via Event Grid           | Supply chain collaboration                 |
| SAP Qualtrics                          | None (SaaS)      | ADF connector for experience data                 | Experience management analytics            |

---

## 11. SAP Basis and administration tools

| SAP administration tool      | Azure equivalent                                     | Parity | Effort | Notes                                  |
| ---------------------------- | ---------------------------------------------------- | ------ | ------ | -------------------------------------- |
| SAP GUI (Windows/Java)       | SAP GUI (unchanged; connect to Azure VMs)            | Full   | XS     | Same client, Azure-hosted servers      |
| SAP HANA Studio              | SAP HANA Studio (unchanged; connect via Bastion/VPN) | Full   | XS     | Same tool, Azure-hosted HANA           |
| SAP Logon                    | SAP Logon (unchanged; update server entries)         | Full   | XS     | Update connection strings to Azure IPs |
| SAPGUI for HTML (WebGUI)     | SAP WebGUI via Azure Front Door                      | Full   | S      | WebGUI through Azure Front Door WAF    |
| SAP transaction codes        | Unchanged (all t-codes work on Azure)                | Full   | XS     | Same ABAP stack, same t-codes          |
| SAP Note application (SNOTE) | SNOTE on Azure VMs (unchanged)                       | Full   | XS     | SAP Notes apply identically on Azure   |
| SAP Kernel patching          | Kernel on Azure VMs (unchanged)                      | Full   | XS     | Same kernel update process             |
| SAP Support Launchpad        | SAP Support Launchpad (web, unchanged)               | Full   | XS     | No migration needed                    |
| SAP Early Watch Reports      | ACSS health monitoring (enhanced)                    | High   | S      | ACSS provides more granular monitoring |

---

## 12. Migration complexity summary by domain

| SAP domain         | Components                                  | Total effort | Critical path                                 | CSA-in-a-Box value                     |
| ------------------ | ------------------------------------------- | ------------ | --------------------------------------------- | -------------------------------------- |
| **Infrastructure** | VMs, storage, networking, HA/DR             | M--L         | Azure landing zone + HANA deployment          | Infrastructure templates, monitoring   |
| **Database**       | HANA migration (backup/restore, HSR, DMO)   | M--L         | Database migration determines downtime        | Fabric Mirroring after migration       |
| **Application**    | S/4HANA conversion, custom code remediation | L--XL        | Custom code remediation is longest workstream | Analytics continuity during conversion |
| **Integration**    | PI/PO interfaces, RFC/IDoc/BAPI             | L            | Interface-by-interface migration              | APIM data mesh gateway                 |
| **Analytics**      | BW, SAC, BusinessObjects → Fabric, Power BI | L--XL        | BW migration is multi-year for large systems  | Full analytics landing zone            |
| **Security**       | Authentication, GRC, network, encryption    | M--L         | Entra ID SSO + network redesign               | Unified identity + governance          |
| **Identity**       | SAP IdM → Entra ID                          | M            | User provisioning + SSO                       | Entra ID as identity plane             |
| **Monitoring**     | SolMan → Azure Monitor for SAP              | M            | Parallel run then cutover                     | CSA-in-a-Box monitoring integration    |

---

## 13. Gap analysis --- capabilities requiring special attention

| SAP capability                          | Gap description                                           | Recommended approach                                                                     | Effort |
| --------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| SAP BW Planning (BPC/IP)                | No direct equivalent in Fabric/Power BI                   | Retain SAP BPC or evaluate Power BI + Azure AI for planning scenarios                    | L      |
| SAP GRC Process Control (detailed)      | Purview Compliance Manager is not a 1:1 GRC replacement   | Phase migration; retain GRC for complex control monitoring during transition             | XL     |
| SAP MDG (Master Data Governance)        | No direct Azure equivalent for MDG business rules         | Custom MDM solution on Azure + Purview for catalog; evaluate Profisee or other MDM tools | L      |
| SAP HANA Graph Engine (complex)         | Cosmos DB Gremlin is architecturally different            | Redesign graph workloads; evaluate Neo4j on Azure for complex graph analytics            | L      |
| SAP Transportation Management (TM)      | TM runs on S/4HANA; no Azure-native replacement           | Run TM on Azure VMs (same S/4HANA system)                                                | M      |
| SAP Extended Warehouse Management (EWM) | EWM runs on S/4HANA; no Azure-native replacement          | Run EWM on Azure VMs (embedded or decentralized)                                         | M      |
| SAP Treasury Management (TRM)           | TRM runs on S/4HANA; specialized treasury functions       | Run TRM on Azure VMs; integrate with Fabric for treasury analytics                       | M      |
| SAP Environment, Health & Safety (EHS)  | EHS runs on S/4HANA; industry-specific compliance         | Run EHS on Azure VMs; integrate regulatory data with Purview                             | M      |
| SAP Real Estate Management (RE-FX)      | RE-FX runs on S/4HANA; no Azure-native replacement        | Run RE-FX on Azure VMs; property data to Fabric for portfolio analytics                  | M      |
| SAP Variant Configuration (VC/AVC)      | VC runs on S/4HANA; product configuration logic           | Run VC on Azure VMs; no migration of configuration engine                                | S      |
| SAP ABAP dictionary custom tables       | Custom tables migrate with S/4HANA conversion             | No special handling; tables migrate as part of DMO/SUM                                   | XS     |
| SAP user exits / BAdIs / enhancements   | Custom enhancements require S/4HANA compatibility testing | Test with ATC; adapt to new extension points in S/4HANA                                  | M--L   |

---

## 14. Migration effort estimation matrix

Use this matrix to estimate total migration effort for your SAP landscape.

| Dimension                          | Small (500 users)   | Medium (2,000 users) | Large (5,000+ users)  | Notes                                    |
| ---------------------------------- | ------------------- | -------------------- | --------------------- | ---------------------------------------- |
| Infrastructure setup               | 4--6 weeks          | 6--8 weeks           | 8--12 weeks           | VMs, storage, networking, HA             |
| HANA database migration            | 2--4 weeks          | 4--8 weeks           | 8--16 weeks           | Depends on DB size and source            |
| S/4HANA conversion (brownfield)    | 8--12 weeks         | 12--20 weeks         | 20--40 weeks          | Custom code is the variable              |
| Custom code remediation            | 200--500 hours      | 500--2,000 hours     | 2,000--10,000 hours   | Depends on customization level           |
| Integration (PI/PO) migration      | 100--200 interfaces | 200--500 interfaces  | 500--2,000 interfaces | Interface-by-interface                   |
| Analytics (BW) migration           | 3--6 months         | 6--12 months         | 12--24 months         | Phase by InfoArea                        |
| Security migration                 | 4--8 weeks          | 8--12 weeks          | 12--16 weeks          | SSO, GRC, network                        |
| Testing (functional + performance) | 4--6 weeks          | 6--10 weeks          | 10--16 weeks          | Regression testing                       |
| **Total estimated duration**       | **9--15 months**    | **15--24 months**    | **24--36 months**     | Parallel workstreams reduce elapsed time |

---

## 15. SAP to Azure migration priority matrix

Use this priority matrix to sequence your migration workstreams. Higher priority items should be completed first.

| Priority              | Workstream                                       | Rationale                                  | Dependencies                |
| --------------------- | ------------------------------------------------ | ------------------------------------------ | --------------------------- |
| **P0 (Critical)**     | Azure landing zone + infrastructure              | Everything depends on infrastructure       | None                        |
| **P0 (Critical)**     | HANA database migration + S/4HANA conversion     | Core system migration; determines downtime | Infrastructure              |
| **P1 (High)**         | Custom code remediation                          | Blocks S/4HANA conversion                  | Assessment complete         |
| **P1 (High)**         | Entra ID SSO for SAP                             | Security foundation; user authentication   | Infrastructure              |
| **P2 (Medium)**       | Integration (PI/PO → Azure Integration Services) | Interface-by-interface; can phase          | S/4HANA on Azure            |
| **P2 (Medium)**       | Fabric Mirroring for SAP                         | Near-real-time analytics from day one      | HANA on Azure               |
| **P3 (Standard)**     | Power BI dashboards (replace SAC/BO)             | Analytics layer; phased by domain          | Fabric Mirroring            |
| **P3 (Standard)**     | Azure Monitor for SAP                            | Monitoring; can run parallel with SolMan   | Infrastructure              |
| **P4 (Enhancement)**  | Azure AI / OpenAI on SAP data                    | AI-driven insights; post-migration value   | Fabric Mirroring + Power BI |
| **P4 (Enhancement)**  | BW to Fabric migration (full)                    | Multi-year; phase after core migration     | Fabric Mirroring            |
| **P5 (Optimization)** | GRC to Purview + Entra PIM                       | Governance modernization; can phase        | Security migration          |
| **P5 (Optimization)** | SAP IdM to Entra ID (full lifecycle)             | Identity modernization; after SSO          | Entra ID SSO                |

---

## 16. Feature parity assessment: SAP on-premises vs SAP on Azure

This table confirms that SAP functionality is **identical** when running on Azure infrastructure. Azure provides the infrastructure; SAP provides the application.

| Functional area      | On-premises SAP       | SAP on Azure                   | Parity   | Notes                                           |
| -------------------- | --------------------- | ------------------------------ | -------- | ----------------------------------------------- |
| ABAP programs        | All custom ABAP runs  | All custom ABAP runs           | 100%     | Same kernel, same database                      |
| SAP transactions     | All transactions work | All transactions work          | 100%     | No transaction-level changes                    |
| SAP Fiori apps       | Fiori runs on NW      | Fiori runs on NW               | 100%     | Same Fiori; Azure Front Door for CDN            |
| SAP kernel patches   | Apply on-prem         | Apply on Azure VMs             | 100%     | Same patching process                           |
| SAP support packages | Import via SUM        | Import via SUM                 | 100%     | Same upgrade process                            |
| SAP transport system | TMS in landscape      | TMS in landscape               | 100%     | Same transport management                       |
| SAP printing         | On-prem printers      | Azure print services + on-prem | 99%      | Remote printing may need configuration          |
| SAP RFC connectivity | Direct network        | VPN/ExpressRoute + Azure       | 100%     | Network layer changes; RFC semantics unchanged  |
| SAP batch processing | On-prem scheduling    | Azure VM scheduling            | 100%     | Same batch scheduler; optional Azure Automation |
| SAP HANA performance | Bare-metal appliance  | Azure M-series + ANF           | 95--105% | Often **faster** on Azure due to newer hardware |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Azure for SAP](why-azure-for-sap.md) | [TCO Analysis](tco-analysis.md) | [Infrastructure Migration](infrastructure-migration.md)
