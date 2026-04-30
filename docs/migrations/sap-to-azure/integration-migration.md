# SAP Integration Migration to Azure

**Migrating SAP PI/PO, RFC/IDoc/BAPI connectivity, and SAP BTP integration to Azure Integration Services.**

---

## Overview

SAP integration is the connective tissue of enterprise IT. SAP PI (Process Integration) and PO (Process Orchestration) handle thousands of interfaces between SAP and external systems --- EDI partners, banks, government agencies, logistics providers, and internal applications. Migrating this layer requires interface-by-interface analysis, testing, and cutover. This guide covers the migration from SAP PI/PO to Azure Integration Services and the integration patterns for RFC, IDoc, and BAPI connectivity.

---

## 1. SAP PI/PO to Azure Integration Services

### Component mapping

| SAP PI/PO component           | Azure equivalent                              | Notes                                          |
| ----------------------------- | --------------------------------------------- | ---------------------------------------------- |
| Integration Directory (ID)    | Azure API Management + Logic Apps             | Routing and configuration                      |
| Integration Repository (IR)   | Azure DevOps (Git-based source control)       | Interface definitions as code                  |
| Adapter Engine (AE)           | Logic Apps connectors + Azure Functions       | Protocol adapters                              |
| Advanced Adapter Engine (AAE) | Logic Apps + custom connectors                | Java-based adapters migrate to Azure Functions |
| Business Process Engine (BPE) | Logic Apps workflows                          | BPEL processes → Logic Apps stateful workflows |
| Mapping (XSLT, Java, Message) | Logic Apps Liquid templates + Azure Functions | XSLT → Liquid; Java mappings → Azure Functions |
| Alert monitoring              | Azure Monitor + Log Analytics                 | Interface monitoring and alerting              |
| RFC adapter                   | Logic Apps SAP connector                      | RFC calls to/from SAP                          |
| IDoc adapter                  | Logic Apps SAP connector                      | IDoc send and receive                          |
| File adapter                  | Azure Blob Storage trigger + Logic Apps       | File-based integrations                        |
| SOAP adapter                  | Logic Apps HTTP action                        | SOAP web service calls                         |
| REST adapter                  | API Management + Logic Apps HTTP action       | REST API integrations                          |
| JDBC adapter                  | Logic Apps SQL connector + Azure Functions    | Database integrations                          |
| SFTP adapter                  | Logic Apps SFTP-SSH connector                 | Secure file transfer                           |
| AS2 adapter                   | Logic Apps AS2 connector (B2B)                | EDI/AS2 partner integrations                   |
| Mail adapter                  | Logic Apps Office 365 connector               | Email-based integrations                       |

### Migration approach

```
SAP PI/PO Migration Phases
Phase 1: Inventory
├── Export ICO (Integration Configuration Objects) list
├── Categorize interfaces by protocol, frequency, criticality
├── Identify interface owners and SLAs
└── Estimate Azure resource requirements

Phase 2: Design
├── Map each PI/PO channel to Azure equivalent
├── Design Logic Apps workflows for complex orchestrations
├── Configure API Management for external-facing APIs
└── Set up Service Bus for async messaging

Phase 3: Build
├── Implement Logic Apps workflows (interface by interface)
├── Deploy Azure Functions for custom transformations
├── Configure SAP connector for RFC/IDoc/BAPI
└── Set up monitoring and alerting

Phase 4: Test
├── Parallel run (PI/PO and Azure side by side)
├── Validate message content, timing, error handling
├── Load testing for high-volume interfaces
└── DR testing

Phase 5: Cutover
├── Interface-by-interface cutover (not big-bang)
├── Monitor both platforms during transition
├── Decommission PI/PO interfaces after validation
└── Final PI/PO decommission
```

---

## 2. RFC connectivity from Azure

RFC (Remote Function Call) is the primary synchronous communication protocol for SAP. Azure provides native RFC connectivity through the Logic Apps SAP connector and the SAP .NET Connector (NCo).

### Logic Apps SAP connector (RFC)

```json
{
    "type": "ApiConnection",
    "inputs": {
        "host": {
            "connection": {
                "name": "@parameters('$connections')['sap']['connectionId']"
            }
        },
        "method": "post",
        "path": "/CallRfc",
        "body": {
            "RfcName": "BAPI_MATERIAL_GETLIST",
            "RfcGroupFilter": "",
            "Parameters": [
                {
                    "Name": "MATNRSELECTION",
                    "Value": {
                        "item": [
                            {
                                "SIGN": "I",
                                "OPTION": "EQ",
                                "MATNR_LOW": "100-100"
                            }
                        ]
                    }
                }
            ]
        }
    }
}
```

### Azure Functions with SAP .NET Connector

```csharp
// Azure Function calling SAP RFC via NCo
using SAP.Middleware.Connector;

[Function("GetMaterialList")]
public async Task<IActionResult> Run(
    [HttpTrigger(AuthorizationLevel.Function, "get")] HttpRequest req)
{
    RfcDestination destination = RfcDestinationManager.GetDestination("SAP_PRD");
    IRfcFunction function = destination.Repository.CreateFunction("BAPI_MATERIAL_GETLIST");

    IRfcTable matnrSelection = function.GetTable("MATNRSELECTION");
    matnrSelection.Append();
    matnrSelection.SetValue("SIGN", "I");
    matnrSelection.SetValue("OPTION", "CP");
    matnrSelection.SetValue("MATNR_LOW", "100*");

    function.Invoke(destination);

    IRfcTable materialList = function.GetTable("MATNRLIST");
    var materials = new List<object>();

    foreach (IRfcStructure row in materialList)
    {
        materials.Add(new {
            MaterialNumber = row.GetString("MATERIAL"),
            Description = row.GetString("MATL_DESC")
        });
    }

    return new OkObjectResult(materials);
}
```

---

## 3. IDoc processing on Azure

IDocs (Intermediate Documents) are SAP's standard format for asynchronous business document exchange (purchase orders, invoices, delivery notes, master data changes).

### Receiving IDocs from SAP

```
SAP System → tRFC → Logic Apps SAP Connector → Process IDoc → Route to target
```

```json
{
    "definition": {
        "triggers": {
            "When_a_message_is_received_from_SAP": {
                "type": "ApiConnectionNotification",
                "inputs": {
                    "host": {
                        "connection": {
                            "name": "@parameters('$connections')['sap']['connectionId']"
                        }
                    },
                    "path": "/MessageServerTrigger",
                    "body": {
                        "MessageType": "ORDERS05",
                        "SenderPartnerNumber": "*",
                        "SenderPartnerType": "LS"
                    }
                }
            }
        },
        "actions": {
            "Parse_IDoc_XML": {
                "type": "ParseJson",
                "inputs": {
                    "content": "@triggerBody()",
                    "schema": {}
                }
            },
            "Route_to_target": {
                "type": "Switch",
                "expression": "@body('Parse_IDoc_XML')?['IDOCTYP']",
                "cases": {
                    "ORDERS05": {
                        "actions": {
                            "Send_to_ServiceBus": {
                                "type": "ServiceBus",
                                "inputs": {
                                    "body": "@body('Parse_IDoc_XML')",
                                    "path": "/orders-queue/messages"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
```

### Sending IDocs to SAP

```json
{
    "actions": {
        "Send_IDoc_to_SAP": {
            "type": "ApiConnection",
            "inputs": {
                "host": {
                    "connection": {
                        "name": "@parameters('$connections')['sap']['connectionId']"
                    }
                },
                "method": "post",
                "path": "/SendIdoc",
                "body": {
                    "idocType": "MATMAS05",
                    "idocMessage": "<MATMAS05>...</MATMAS05>"
                }
            }
        }
    }
}
```

---

## 4. BAPI calls from Azure

BAPIs (Business Application Programming Interfaces) are SAP's standard APIs for business operations. They provide transactional integrity and are the recommended way to create, update, or read SAP business objects.

### Common BAPIs and their Azure integration patterns

| BAPI                           | Purpose                       | Azure pattern                     |
| ------------------------------ | ----------------------------- | --------------------------------- |
| BAPI_SALESORDER_CREATEFROMDAT2 | Create sales order            | Logic Apps → SAP connector → RFC  |
| BAPI_PO_CREATE1                | Create purchase order         | Azure Function → NCo → RFC        |
| BAPI_ACC_DOCUMENT_POST         | Post accounting document      | Logic Apps → SAP connector → RFC  |
| BAPI_MATERIAL_SAVEDATA         | Create/change material master | Azure Function → NCo → RFC        |
| BAPI_CUSTOMER_GETLIST          | Read customer list            | API Management → Logic Apps → SAP |
| BAPI_COMPANYCODE_GETLIST       | Read company codes            | API Management → Logic Apps → SAP |

### Exposing SAP BAPIs as REST APIs

```
Azure API Management
    │
    ├── GET  /api/sap/materials     → Logic Apps → BAPI_MATERIAL_GETLIST
    ├── POST /api/sap/sales-orders  → Logic Apps → BAPI_SALESORDER_CREATEFROMDAT2
    ├── GET  /api/sap/customers     → Logic Apps → BAPI_CUSTOMER_GETLIST
    └── POST /api/sap/invoices      → Logic Apps → BAPI_ACC_DOCUMENT_POST
```

```xml
<!-- API Management policy for SAP BAPI exposure -->
<policies>
    <inbound>
        <base />
        <set-header name="Content-Type" exists-action="override">
            <value>application/json</value>
        </set-header>
        <rate-limit calls="100" renewal-period="60" />
        <validate-jwt header-name="Authorization"
                      failed-validation-httpcode="401">
            <openid-config
              url="https://login.microsoftonline.com/{tenant}/.well-known/openid-configuration" />
            <required-claims>
                <claim name="roles" match="any">
                    <value>SAP.ReadWrite</value>
                </claim>
            </required-claims>
        </validate-jwt>
    </inbound>
</policies>
```

---

## 5. SAP Event Mesh to Azure Event Grid

SAP Event Mesh enables event-driven architectures by publishing SAP business events (e.g., "sales order created", "material changed") to subscribers.

### Migration pattern

| SAP Event Mesh concept | Azure equivalent                                      |
| ---------------------- | ----------------------------------------------------- |
| Event topics           | Event Grid topics or Service Bus topics               |
| Event subscriptions    | Event Grid subscriptions or Service Bus subscriptions |
| Queue-based consumers  | Service Bus queues                                    |
| Webhook delivery       | Event Grid webhook endpoints                          |

### SAP business events to Azure Event Grid

```bash
# Create Event Grid topic for SAP events
az eventgrid topic create \
  --name sap-business-events \
  --resource-group rg-sap-integration \
  --location eastus2

# Create subscription for sales order events
az eventgrid event-subscription create \
  --name sales-order-subscription \
  --source-resource-id /subscriptions/<sub>/resourceGroups/rg-sap-integration/providers/Microsoft.EventGrid/topics/sap-business-events \
  --endpoint https://func-sap-events.azurewebsites.net/api/SalesOrderHandler
```

---

## 6. SAP BTP integration with Azure

For organizations using RISE with SAP, SAP BTP (Business Technology Platform) coexists with Azure services. Integration between BTP and Azure uses:

| Integration pattern | Technology                                 | Use case                                 |
| ------------------- | ------------------------------------------ | ---------------------------------------- |
| BTP → Azure         | SAP Cloud Connector + Azure API Management | BTP apps accessing Azure services        |
| Azure → BTP         | Azure Logic Apps + BTP API endpoints       | Azure workflows triggering BTP services  |
| Shared identity     | Entra ID federation with SAP IAS           | Single sign-on across Azure and BTP      |
| Data integration    | Fabric Mirroring + BTP Integration Suite   | SAP data in both BTP and Azure analytics |

---

## 7. CSA-in-a-Box integration for SAP data extraction

CSA-in-a-Box uses ADF SAP connectors for batch data extraction and Fabric Mirroring for near-real-time replication.

### ADF SAP connector options

| Connector           | Source                          | Use case                              | Extraction method             |
| ------------------- | ------------------------------- | ------------------------------------- | ----------------------------- |
| SAP Table           | SAP ECC/S/4HANA tables          | Full/incremental table extraction     | Direct table read             |
| SAP BW via Open Hub | SAP BW InfoProviders            | BW data warehouse extraction          | Open Hub Destination          |
| SAP HANA            | SAP HANA database               | Direct HANA table/view extraction     | SQL/MDX queries               |
| SAP ODP             | SAP ECC/S/4HANA (ODP framework) | Delta extraction with change tracking | Operational Data Provisioning |
| SAP CDC             | SAP S/4HANA                     | Real-time change data capture         | SLT-based CDC                 |

```json
{
    "name": "SAPTableExtraction",
    "type": "SapTable",
    "typeProperties": {
        "tableName": "VBAK",
        "sapDataColumnDelimiter": "|",
        "rowCount": 1000000,
        "customRfcReadTableFunctionModule": "/BODS/RFC_READ_TABLE2",
        "partitionOption": "PartitionOnCalendarDate",
        "partitionSettings": {
            "partitionColumnName": "ERDAT",
            "partitionLowerBound": "20200101",
            "partitionUpperBound": "20260430",
            "maxPartitionsNumber": 12
        }
    }
}
```

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Analytics Migration](analytics-migration.md) | [Security Migration](security-migration.md)
