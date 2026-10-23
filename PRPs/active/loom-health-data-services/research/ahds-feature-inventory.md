# Azure Health Data Services (AHDS) — cited feature inventory

Retrieved 2026-10-22. Purpose: a MODEL (not a dependency) for a from-scratch, Azure-native health data platform.
Every numeric claim carries a URL. Items that could not be confirmed from a primary source are marked **UNVERIFIED** with the way to verify.
No PHI, no secrets, no real patient data. Microsoft Learn MCP tools were not available in this session; all Learn content was fetched directly (WebFetch) and GitHub metadata via the public REST API (`gh api` was blocked by the microsoft-org SAML gate).

Abbreviations: L = https://learn.microsoft.com/en-us/azure/healthcare-apis

---

## 0. Service shape (what AHDS is)

| Fact | Detail | Source |
|---|---|---|
| Services | FHIR service, DICOM service, De-identification service (MedTech service is listed on the product page but is **deprecated**, see §3) | L/healthcare-apis-overview ; https://azure.microsoft.com/en-us/products/health-data-services/ |
| Container | A **workspace** (`Microsoft.HealthcareApis/workspaces`) holds FHIR + DICOM services; all services in a workspace share its region and cannot be moved; workspace name is 3–24 lowercase alphanumerics, no hyphen | L/workspace-overview (via search snippet) ; L/healthcare-apis-faqs |
| Platform features AHDS has that Azure API for FHIR lacked | private link, customer-managed keys, logging | L/healthcare-apis-overview |
| Legacy | Azure API for FHIR deprecated **2026-09-30** | L/healthcare-apis-overview |
| OSS basis | FHIR service = "fully managed deployment of the open-source FHIR Server" (microsoft/fhir-server) | L/fhir/fhir-features-supported |
| Compliance claim | "HITRUST CSF certified"; HIPAA/GDPR/CCPA language on product page | https://azure.microsoft.com/en-us/products/health-data-services/ |

---

## 1. FHIR service

### 1.1 Versions, REST, limits

| Capability | What it does / value | Source |
|---|---|---|
| FHIR version | Latest `4.0.1` (R4); `3.0.2` (STU3) also supported. **No R4B/R5 listed** | L/fhir/fhir-features-supported |
| REST interactions | read, vread, update (+optimistic locking via If-Match → 412), conditional update, patch (JSON Patch + FHIRPath Patch only; XML Patch not supported), conditional patch, history, create (POST/PUT), conditional create, search (partial), chained + reverse-chained, batch, **transaction (Yes in AHDS; No in Azure API for FHIR)**, paging (`self`,`next` only) | L/fhir/fhir-features-supported ; L/fhir/rest-api-capabilities |
| Request body size | **28 MB** per request (Azure API for FHIR: 2 MB) | L/fhir/fhir-features-supported |
| Bundle size | **500** entries per bundle | L/fhir/fhir-features-supported |
| Bundle execution | Serial by default; header `x-bundle-processing-logic: parallel` enables parallel processing when no overlapping resource IDs. Transaction bundles do **not** support conditional delete, hard delete, `_search` | L/fhir/rest-api-capabilities |
| Storage | Default **4 TB** per FHIR instance; up to **100 TB** via support request ("Service and Subscription limit (quotas)") | https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-health-data-services |
| Quotas | **10** workspaces/subscription, **10** FHIR services/workspace, **10** DICOM services/workspace (defaults; limits enforced independently; raise via support) | same ARM limits page ; L/fhir/fhir-features-supported |
| Throughput / RPS | **No published RPS or concurrency quota** for the AHDS FHIR service. Built-in autoscale (triggers: Average CPU, Max Worker Thread, Average LogWrite, Average data IO; evaluation interval **1 minute**); ramp request rate gradually; persistent 429 → support ticket. (The 100,000 RU default / 1,000,000 RU max and 15×2=30 concurrent connections apply to legacy Azure API for FHIR only.) | L/fhir/fhir-service-autoscale (via search) ; ARM limits page |
| Conditional delete | Default deletes 1; `_count` up to **100** per request | L/fhir/rest-api-capabilities |
| Soft / hard delete | Default DELETE is soft (recoverable via `_history`); `?hardDelete=true` removes resource + history; **no time-based expiry** of history or soft-deleted data | L/fhir/rest-api-capabilities |
| Resource IDs | Server-generated on create; client may supply on update; must not contain PHI/PII | L/fhir/rest-api-capabilities |

### 1.2 Search

| Capability | Detail | Source |
|---|---|---|
| Param types | number, date, string, token, reference, quantity, uri = Yes; composite = partial (pairs: Reference+Token, Token+Date, Token+Number+Number, Token+Quantity, Token+String, Token+Token); special = No | L/fhir/overview-of-search |
| Common params | `_id _lastUpdated _tag _type _security _profile _has` = Yes; `_query _filter _list _text _content` = No | same |
| Modifiers | `:missing :exact :contains :text :type :not :below(uri) :above(uri)` = Yes; `:in :below(token) :above(token) :not-in :identifier` = No; all prefixes supported | same |
| Result params | `_elements _count _include _revinclude _summary` = Yes; `_total` = partial (`none`,`accurate`); `_sort` = partial (single field; strings + dateTime); `_not-referenced` = Yes (AHDS only); `_contained _containedType _score` = No | same |
| `_count` | default **10**, max **1,000** (over 1,000 → 1,000 + warning) | same |
| `_include`/`_revinclude` | `_includesCount` default **1,000**; `:iterate` not supported on Cosmos-backed OSS; response capped at 1,000 included items with a `related` link to continue | same |
| `$lastn` | Not supported | same |
| Lenient vs strict | Default lenient (unknown params ignored); `Prefer: handling=strict` turns warnings into errors | same |
| Custom search params | POST `SearchParameter` (url, code, base, target, type, expression required; xpath ignored); reindex required; `$status` endpoint shows `Pending`/`PendingDelete`/`PendingHardDelete`; test one resource via `GET/POST {res}/{id}/$reindex` + header `x-ms-use-partial-indices: true` | L/fhir/how-to-do-custom-search |
| Selectable search params | `GET/PUT SearchParameter/$status` (filter by `code`, `url`, `resourcetype`); statuses Supported, Enabled, PendingDisable, Disabled, PendingDelete, PendingHardDelete, Deleted; needs **Search Parameter Manager** RBAC role; reindex to activate | L/fhir/selectable-search-parameters |
| `$reindex` | `POST {base}/$reindex`; status at `_operations/reindex/{id}`; cancel via DELETE; `maximumNumberOfResourcesPerWrite` default **1000**, range **1–5000**; targeted reindex by search parameter is **deprecated**; large datasets "can run for days" | L/fhir/how-to-run-a-reindex |

### 1.3 Extended operations

| Operation | Detail | Source |
|---|---|---|
| `$export` | System `/$export`, `/Patient/$export`, `/Group/[id]/$export` (group characteristics not exported). NDJSON to ADLS Gen2 (same subscription only; container must pre-exist if named; new folder per job; no sub-directory targeting). Params: `_outputFormat _since _type _typeFilter _container _till (system only) includeAssociatedData(_history,_deleted)`. ~**5,000** resources per file (subject to change). Stuck-job idle timeout **10 minutes**. Needs managed identity + Storage Blob Data Contributor | L/fhir/export-data |
| De-identified `$export` | System level only; anonymization engine = microsoft/Tools-for-Health-Data-Anonymization; config via ADLS container (`anonymization/anonymizationConfig.json`) or ACR image (`_anonymizationConfigCollectionReference`); params `_anonymizationConfig`, `_anonymizationConfigEtag`; methods in sample: redact, keep, cryptoHash; Microsoft disclaims compliance guarantee | L/fhir/deidentified-export |
| `$import` | Modes `InitialLoad` (blocks writes, no history, no charge) and `IncrementalLoad` (default; concurrent writes OK; preserves `lastUpdated`/`versionId`; non-sequential versions; `allowNegativeVersions`; billed per resource). Limits: **10,000** files per import; **10,000** max files sharing the same `lastUpdated` ms; no `SearchParameter` type; no conditional references. Guidance: files ≥**50 MB** / ≥**20K** resources; batch ≥**100 GB** / ≥**100M** resources. Soft-deleted ingestion via extension `http://azurehealthcareapis.com/data-extensions/deleted-state`. Role: **FHIR Data Importer** | L/fhir/import-data |
| `$convert-data` | Inputs: HL7v2, C-CDA, JSON (sample templates only), FHIR STU3→R4. Liquid templates from microsoft/FHIR-Converter; default images `microsofthealth/fhirconverter:default`, `hl7v2templates`, `ccdatemplates`, `jsontemplates`, `stu3tor4templates`; custom templates hosted in ACR and registered to the service. HL7v2 root templates: ADT_A01…A60, OML_O21, ORU_R01, ORM_O01, VXU_V04, SIU_S12…S26, MDM_T01/T02; C-CDA: CCD, ConsultationNote, DischargeSummary, HistoryandPhysical, OperativeNote, ProcedureNote, ProgressNote, ReferralNote, TransferSummary. Output = batch Bundle. Role: FHIR Data Converter | L/fhir/convert-data-overview |
| `$validate` | `GET {res}/{id}/$validate`, `POST {res}/$validate` (not persisted), `?profile=` canonical; header `x-ms-profile-validation: true` validates on create/update (off by default); only fully-expanded ValueSets uploaded to the server are supported | L/fhir/validation-against-profiles |
| `$patient-everything` | Patient + referenced resources + patient compartment + Devices referencing patient (first **100** devices); params `_type _since start end`; `_count` not supported; follows `seealso` links **one** level; `replaced-by` → warning or 301 with `handling=strict`; 4 response phases | L/fhir/patient-everything |
| `$member-match` | Supported | L/fhir/fhir-features-supported |
| `$purge-history` | `DELETE {res}/{id}/$purge-history` (resource level only) | L/fhir/purge-history |
| `$bulk-delete` / `$bulk-delete-soft-deleted` | System or type level; params `_hardDelete _purgeHistory excludedResourceTypes _remove-references _not-referenced` + any search params incl. `_include`/`_revinclude`; async with polling at `_operations/bulk-delete/{id}`; roles FHIR Data Writer (soft) / Contributor (hard) | L/fhir/fhir-bulk-delete |
| `$bulk-update` | PATCH system/type level; patch types `replace`, `upsert` only; **one** job at a time; excludes SearchParameter/StructureDefinition; roles FHIR Data Bulk Operator / Contributor; polling at `_operations/bulk-update/{id}` | L/fhir/fhir-bulk-update |

### 1.4 Versioning, history, security, platform

| Capability | Detail | Source |
|---|---|---|
| Versioning policy | `versioned` (default), `version-update` (If-Match required), `no-version`; system-wide with per-resource-type override; `_meta-history=false` skips history for metadata-only PUT/PATCH/$bulk-update | L/fhir/fhir-versioning-policy-and-history-management |
| History | `_history` at resource/type/system; params `_count _since _before`; includes deleted | L/fhir/rest-api-capabilities |
| SMART on FHIR | SMART **v1.0.0 and v2.0.0** (not mixed in one app registration); `/.well-known/smart-configuration`; SMART user role = read (`r`) + search (`s`) only, no writes; `$export` needs `system/` scopes; Entra ID requires an orchestration layer (sample `azure-health-data-and-ai-samples/.../smartonfhir-smartnative-v2`); third-party IdPs supported | L/fhir/smart-on-fhir |
| RBAC (data plane) | FHIR Data Reader, Writer, Exporter, Contributor, Converter, **FHIR SMART User**; plus FHIR Data Importer (import page), FHIR Data Bulk Operator (bulk-update page), Search Parameter Manager (selectable search page); DICOM Data Owner, DICOM Data Reader | L/configure-azure-rbac ; L/fhir/import-data ; L/fhir/fhir-bulk-update ; L/fhir/selectable-search-parameters |
| Audit | Resource-log categories **AuditLogs** and **DiagnosticLogs**; audit fields incl. operationName, resultType, callerIpAddress, correlationId, identity claims, uri, `properties.fhirResourceType`; destinations Log Analytics / Storage / Event Hub; table `MicrosoftHealthcareApisAuditLogs` | L/logging ; L/fhir/fhir-bulk-update |
| Events (Event Grid) | System topic; event types `FhirResourceCreated`, `FhirResourceUpdated`, `FhirResourceDeleted` (soft delete), `DicomImageCreated`, `DicomImageDeleted`, `DicomImageUpdated`; only after enabled, no backfill | L/events/events-overview |
| CMK | Key Vault RSA **2048** or **3072**-bit, versioned, same region (cross-sub/tenant OK), vault+key name ≤ **94** chars, soft delete + purge protection required (recovery default **90** days), trusted-services bypass for firewalled vaults; system- or user-assigned identity with **Key Vault Crypto Service Encryption User**; lost key → API 500s. DICOM CMK: **UNVERIFIED** (page covers FHIR only; verify at L/dicom) | L/fhir/configure-customer-managed-keys |
| Private Link | Private endpoint at **workspace** level (`healthcareworkspace` sub-resource) covers all FHIR + DICOM services; two private DNS zones (workspace/FHIR, DICOM); approved endpoint disables public traffic (up to **5 min** to take effect); cannot move resource group/sub while enabled | L/configure-private-link |
| Managed identity | One identity type (system- or user-assigned) per FHIR service; used for export/import storage, ACR, CMK | L/fhir/configure-customer-managed-keys ; L/fhir/import-data |
| Hostname | `https://<workspace>-<fhir>.fhir.azurehealthcareapis.com` | L/fhir/overview-of-search |

---

## 2. DICOM service

| Capability | Detail | Source |
|---|---|---|
| API versions | `v1.0-prerelease`, `v1`, `v2`; version mandatory in URL (`/v2/studies`); OpenAPI at `/v{n}/api.yaml`; headers `api-supported-versions` / `api-deprecated-versions` | L/dicom/api-versioning-dicom-service |
| STOW-RS | POST/PUT `../studies[/{study}]` (PUT = upsert); only explicit-VR transfer syntaxes accepted; **requests limited to 4 GB** total; study-level expiry headers | L/dicom/dicom-services-conformance-statement-v2 |
| WADO-RS | study/series/instance, `/metadata`, `/rendered`, `/frames/{list}`, frame `/rendered`; default transfer syntax `1.2.840.10008.1.2.1`; `transfer-syntax=*` honored; transcoding from: 1.2 (Implicit LE), 1.2.1 (Explicit LE), 1.2.2 (Big Endian), 1.2.4.50 (JPEG Baseline), .57 (JPEG Lossless), .70 (JPEG Lossless SV1), .90 (JPEG 2000 Lossless), .91 (JPEG 2000), 1.2.5 (RLE); `msdicom-request-original: true` retrieves pre-bulk-update original | same ; L/dicom/update-files |
| QIDO-RS | studies/series/instances (+ nested); `limit` **1–200**, default **100**; `offset`; `fuzzymatching` on PatientName; `includefield`; URI max **8,192** chars; study/series metadata "latest wins" | L/dicom/dicom-services-conformance-statement-v2 |
| UPS-RS (worklist) | Push and Pull SOPs; `/workitems` create/retrieve/update/change-state/search/subscribe; search `limit` **1–4000**, default 100; workitems **not** stored in BYO data-lake storage | L/dicom/overview ; conformance v2 ; L/dicom/dicom-data-lake |
| Delete | Non-standard study/series/instance DELETE; not recoverable | conformance v2 |
| Change feed | `GET /changefeed` and `/changefeed/latest`; fields Sequence, UIDs, Action (create/update/delete), Timestamp, State (current/replaced/deleted), Metadata; v2 params `startTime endTime offset limit(1–200, default 100) includeMetadata`; v1 `limit` 1–100 default 10 | L/dicom/change-feed-overview |
| Extended query tags | `POST/GET/DELETE/PATCH ../extendedquerytags[/{tagPath}]`, `/errors`, `/operations/{id}`; up to **128** tags; private tags supported; SQ not supported; supported VRs AE AS CS DA DT FD FL IS LO PN SH SL SS TM UI UL US; async reindex, status Adding/Ready/Deleting, QueryStatus Enabled/Disabled | L/dicom/dicom-extended-query-tags-overview |
| Export | `POST /{version}/export`; source `identifiers` (study[/series[/instance]]) or omitted = export all (not with data-lake storage); destination `azureblob` + `UseManagedIdentity`; output `<opId>/results/<study>/<series>/<sop>.dcm` + `errors.log`; needs system-assigned MI + Storage Blob Data Contributor | L/dicom/export-files |
| Data partitions | Enabled only at creation, cannot be turned off; URI segment `/partitions/{name}` (≤ **64** chars, alnum `. - _`); default `Microsoft.Default`; implicit creation on STOW; no cross-partition query, no update/delete of partitions | L/dicom/data-partitions |
| Bulk update | `POST /{v}/studies/$bulkUpdate`; max **50** studies per op; one op per study at a time; UID changes limited to one study; patient identification/demographic, study, series, instance and UID attributes updatable; originals retained; change feed records updates | L/dicom/update-files |
| Storage layout (BYO ADLS) | Container path `AHDS/{workspace}/dicom/{dicom-service}/{partition}`; health-check file written every **30 s**; needs Storage Blob Data Contributor; hot/cool/cold tiers only (no archive); bulk import not supported; user-added files not indexed | L/dicom/dicom-data-lake |
| Default storage | LRS within region; "petabytes" / "thousands of new studies daily" scale claim; unique database per instance | L/dicom/overview |
| DICOMcast | OSS, self-hosted; injects DICOM metadata into FHIR as ImagingStudy. Mapping tables/deployment: **UNVERIFIED** here (no Learn page found; `raw.githubusercontent.com/microsoft/dicom-server/main/docs/concepts/dicom-cast.md` 404). Verify via `gh api repos/microsoft/dicom-server/contents/docs` (needs SAML-authorized token) or browse https://github.com/microsoft/dicom-server/tree/main/docs | L/dicom/overview |
| RBAC | DICOM Data Owner, DICOM Data Reader; app also needs API permission `https://dicom.healthcareapis.azure.com` | L/configure-azure-rbac ; L/dicom/get-started-with-analytics-dicom |
| Hostname | `https://<workspace>-<dicom>.dicom.azurehealthcareapis.com` | L/dicom/get-started-with-analytics-dicom |

---

## 3. MedTech service (deprecated)

| Fact | Detail | Source |
|---|---|---|
| Status | Deprecation initiated **2025-05-03**; support ends **2028-05-03** in West US2, UK South, West Europe, East US, Australia East, East US 2, Central India, North Europe; OSS continuation = microsoft/iomt-fhir (itself archived, §7) | https://learn.microsoft.com/en-us/previous-versions/azure/healthcare-apis/iot/overview |
| Pipeline | Ingest (Event Hub; IoT Hub via routing) → Normalize (device mapping) → Group (device id, type, period, optional correlation id) → Transform (FHIR destination mapping) → Persist (Observation) | same |
| Device mapping | Root `CollectionContent`; templates `CalculatedContent` (JSONPath, JMESPath, custom functions) and `IotJsonPathContent` (IoT Hub); fields `typeName typeMatchExpression deviceIdExpression timestampExpression patientIdExpression encounterIdExpression correlationIdExpression values[]`; resolution type Create vs Lookup | …/iot/overview-of-device-mapping |
| FHIR destination mapping | Root `CollectionFhir`; only `CodeValueFhir`; `periodInterval` **0 / 60 / 1440**; value types SampledData (`defaultPeriod`, `unit`), Quantity, CodeableConcept, String; components; codes; Device/Patient/Encounter linking by identifier | …/iot/overview-of-fhir-destination-mapping |
| Throughput limits | **UNVERIFIED** — no numeric limit on the archived pages read; verify via L/previous-versions iot pages or the pricing page "FHIR transformations per GB" meter | pricing page |

---

## 4. De-identification service

| Capability | Detail | Source |
|---|---|---|
| Operations | `Tag` (locate PHI), `Redact` (replace with `[type]`, configurable `redactionFormat` 1–16 chars), `Surrogate` (default; realistic pseudonyms, `surrogateLocale` default en-US) | L/deidentification/overview ; https://learn.microsoft.com/en-us/rest/api/health-dataplane/deidentify-text/deidentify-text |
| Endpoints | Synchronous `POST {endpoint}/deid?api-version=2024-11-15` (preview `2025-07-15-preview`); asynchronous batch jobs over Blob Storage with consistent surrogation within a job | same |
| Entity types | **27** PhiCategory values incl. the 18 HIPAA identifiers: Account, Age, BioID, City, CountryOrRegion, Date, Device, Doctor, Email, Fax, HealthPlan, Hospital, IDNum, IPAddress, License, LocationOther, MedicalRecord, Organization, Patient, Phone, Profession, SocialSecurity, State, Street, Url, Username, Vehicle, Zip (+Unknown) | REST ref above ; L/deidentification/overview |
| Compliance claims | "adhering to HIPAA privacy rule" and GDPR unlinked pseudonymization; "27 entities… include the 18 HIPAA PHI identifiers" | L/deidentification/overview |
| Limits | Sync request ≤ **50 KB** (`inputText` maxLength **48,000**); jobs ≤ **10,000** documents; ≤ **2 MB** per document; throttle **1 MB / 5 s** or **100 requests / 5 s** | L/deidentification/overview ; REST ref |
| Pricing | Per **MB** de-identified ("Unstructured De-identification" row, Transformation Operations table); **50 MB/month** free allotment; Blob storage billed separately | L/deidentification/overview ; pricing page |
| Platform | Stateless; private endpoints; managed identity to Blob; RBAC; multi-language (see L/deidentification/languages-supported) | L/deidentification/overview |

---

## 5. Analytics connectors

| Path | Detail | Source |
|---|---|---|
| FHIR → Synapse Sync Agent (OSS) | Azure Function reads FHIR APIs → hierarchical **Parquet** in ADLS near-real-time; script creates Synapse serverless external tables/views; MIT, not under Azure SLA | L/fhir/copy-to-synapse ; https://github.com/microsoft/FHIR-Analytics-Pipelines |
| FHIR → CDM pipeline generator (OSS) | ADF pipeline using `$export` → CSV in CDM folder; user config flattens resources to tables | same |
| `$export` + T-SQL | NDJSON to ADLS Gen2 → `OPENROWSET`/`OPENJSON` (serverless) or `COPY INTO` heap table (dedicated) | L/fhir/copy-to-synapse |
| Fabric healthcare data solutions (model only) | Capabilities: healthcare data foundations (bronze/silver/gold, FHIR), OMOP, DICOM data transformation, **AHDS Data export** (uses `$export` on a schedule → ADLS Gen2 → OneLake shortcut → bronze NDJSON → silver), CMS claims, SDOH, care management, patient outreach. Managed solution support ends **2027-12-31**; downloadable source package from **2026-08-03**; new customers use the package from **2026-10-01** | https://learn.microsoft.com/en-us/industry/healthcare/healthcare-data-solutions/overview ; …/ahds-data-export-overview |
| DICOM metadata analytics | ADF template "Copy DICOM Metadata Changes to ADLS Gen2 in Delta Format" reads the change feed (BatchSize max **200**, ApiVersion ≥ 2, RetentionHours default **720**) into Delta tables `instance/series/study`; Fabric lakehouse shortcuts to tables and (with data-lake DICOM) to files; needs DICOM Data Reader + Storage Blob Data Contributor | L/dicom/get-started-with-analytics-dicom |
| Power BI | Via Synapse serverless/Parquet (above) or Fabric; no native AHDS→Power BI connector documented on pages read | L/fhir/copy-to-synapse |

---

## 6. Platform: portal, pricing, SLA, regions, Azure Government

| Topic | Detail | Source |
|---|---|---|
| Portal UX (what the blade exposes, from pages read) | Workspace: Settings → Networking (private endpoint), Access control (IAM). FHIR service: Versioning Policy Configuration; Encryption (CMK); Identity; Artifacts (ACR registration under "Transform and transfer data"); Diagnostic settings; Metrics. DICOM: Identity → Azure role assignments; create-time "Enable data partitions". **UNVERIFIED** full blade inventory — verify by walking a live workspace | L/fhir/fhir-versioning-policy-and-history-management ; L/fhir/configure-customer-managed-keys ; L/dicom/export-files ; L/dicom/data-partitions ; L/fhir/deidentified-export |
| Pricing dimensions | Structured + BLOB storage per GB/month; API requests per **100,000** (FHIR + DICOM; 429 and ≥500 not charged; batch charged per successful entry, transaction only if whole succeeds; initial-mode import free); FHIR transformations per GB; structured de-id per GB; unstructured de-id per MB; DICOM transcode per GB; export per GB; events per **1,000,000**. Free "Up to" tiers shown: 1 GB storage, 50K API requests, 50 MB unstructured de-id, 0.5 GB transformations, 1 GB export, 100K events (prices not rendered to fetch) | https://azure.microsoft.com/en-us/pricing/details/health-data-services/ |
| SLA | **UNVERIFIED at primary source.** The AHDS SLA link redirects to the consolidated Microsoft Online Services SLA document, which was not readable here. A third-party board (azurecharts.com/sla) lists Health Data Services at 99.9%. Verify by opening the consolidated SLA PDF/doc and searching "Health Data Services" | https://www.microsoft.com/licensing/docs/view/Service-Level-Agreements-SLA-for-Online-Services |
| Regions | Learn points to the Products-by-region page (JS-rendered; not readable here). DICOM "available in any region where AHDS is available" | L/healthcare-apis-faqs ; L/dicom/overview |
| Azure Government | **UNVERIFIED / likely absent.** `compare-azure-government-global-azure` lists no Health Data Services or `azurehealthcareapis.us` endpoint; its Databases "products by region" link includes `azure-api-for-fhir` (legacy) only. No Learn page states AHDS Gov availability. A search snippet claims the pricing page region picker lists US Gov Texas/Virginia — that is a pricing dropdown, not an availability statement. Verify: open the Products-by-region page filtered to `usgov-*` in a browser, or run `az provider show -n Microsoft.HealthcareApis --query "resourceTypes[?resourceType=='workspaces'].locations"` against an AzureUSGovernment login | https://learn.microsoft.com/en-us/azure/azure-government/compare-azure-government-global-azure |

---

## 7. Microsoft OSS repos underlying AHDS (GitHub REST API, 2026-10-22)

| Repo | License | Archived | Last push | Latest release | Stars | Notes |
|---|---|---|---|---|---|---|
| microsoft/fhir-server | MIT | no | 2026-10-22 | `release/5.2.6` (2026-10-18) | 1,389 | Active. Basis of the FHIR service | https://api.github.com/repos/microsoft/fhir-server ; …/releases/latest |
| microsoft/dicom-server | MIT | no | 2026-10-20 | `10.0.838` (2024-03-01) | 517 | Active commits; releases stale | https://api.github.com/repos/microsoft/dicom-server |
| microsoft/FHIR-Converter | MIT | no | 2026-09-23 | `v5.1.0` (2022-11-29) | 530 | Active commits; releases stale | https://api.github.com/repos/microsoft/FHIR-Converter |
| microsoft/iomt-fhir | MIT | **yes** | 2026-05-12 | `5.0.0` "Migrate from .NET 6 to .NET 8" (2024-12-13) | 153 | Archived (MedTech OSS) | https://api.github.com/repos/microsoft/iomt-fhir |
| microsoft/FHIR-Analytics-Pipelines | MIT | **yes** | 2025-01-28 | none fetched | 87 | Archived | https://api.github.com/repos/microsoft/FHIR-Analytics-Pipelines |
| microsoft/fhir-loader | MIT | **yes** | 2025-09-05 | none fetched | 56 | Archived | https://api.github.com/repos/microsoft/fhir-loader |
| microsoft/fhir-proxy | MIT | **yes** | 2023-04-20 | none fetched | 75 | Archived | https://api.github.com/repos/microsoft/fhir-proxy |
| microsoft/healthcare-apis-samples | MIT | **yes** | 2024-04-11 | none fetched | 37 | Archived; successor is Azure-Samples/azure-health-data-and-ai-samples (SAML-gated for `gh`; not fetched) | https://api.github.com/repos/microsoft/healthcare-apis-samples |

Stated scale numbers in repo READMEs: **UNVERIFIED** (READMEs not read this session). Verify via `https://raw.githubusercontent.com/<org>/<repo>/main/README.md`.

---

## 8. Gaps / verification list

1. SLA percentage — open the consolidated Microsoft Online Services SLA and search "Health Data Services".
2. Azure Government availability — Products-by-region page in a browser with `usgov-*` filter, or `az provider show` in a Gov login.
3. DICOMcast FHIR mapping and deployment — browse `microsoft/dicom-server/docs`.
4. DICOM CMK support — check L/dicom for a customer-managed-keys page.
5. MedTech throughput numbers — archived `previous-versions` MedTech pages.
6. Full portal blade inventory — live walk of a workspace.
7. OSS README scale claims — read each README.
