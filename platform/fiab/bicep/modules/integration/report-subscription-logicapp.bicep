// CSA Loom - Report-subscription delivery Logic App (Consumption + Office 365
// Outlook "Send an email (V2)" with a base64 attachment).
//
// Azure-native parity for Fabric / Power BI report SUBSCRIPTIONS email delivery
// (NO Fabric / Power Automate dependency). The fiab-report-subscriptions timer
// Function renders a report via the Power BI ExportTo REST job, then POSTs the
// rendered bytes (base64) to this Logic App's HTTP trigger; the Logic App emails
// the file as an attachment via the Office 365 Outlook connector.
//
// Why a Logic App (not an Action Group): Action Group email receivers send
// plain-text notifications only and CANNOT carry a file attachment. Delivering
// the actual PDF/PPTX/PNG requires the Office 365 "Send an email (V2)" action.
//
// Grounded in Microsoft Learn:
//   Microsoft.Logic/workflows (Consumption, Bicep):
//     https://learn.microsoft.com/azure/templates/microsoft.logic/workflows
//   Office 365 Outlook connector (Send an email V2 + attachments):
//     https://learn.microsoft.com/connectors/office365/
//   Request trigger / Response:
//     https://learn.microsoft.com/azure/logic-apps/logic-apps-http-endpoint
//
// DEPLOYMENT NOTE - the O365 connection must be OAuth-authorized post-deploy
// (Bicep cannot perform the interactive consent):
//   1. Open the Logic App in the portal -> Edit.
//   2. On the "Send_report_email" action, choose Change connection -> Add new.
//   3. Sign in with a LICENSED Office 365 mailbox account.
//   4. For GCC-High / IL5: pick the "AzureUSGovernment" authentication endpoint.
// Until authorized, the action returns 401 and the timer Function records the
// failure in the report-delivery-log - see docs/fiab/v3-tenant-bootstrap.md.
//
// Per-cloud status:
//   Commercial : Fully supported. Trigger URL = *.logic.azure.com.
//   GCC        : Azure-Commercial backed (same as Commercial). O365 GCC tenant OK.
//   GCC-High   : Azure Government backed. Trigger URL = *.logic.azure.us. O365
//                connector requires re-auth with the AzureUSGovernment endpoint.
//                Power BI export is unavailable in GCC-High (no Premium in Gov);
//                the export step itself honest-fails and is logged.
//   IL5        : Consumption Logic Apps are NOT VNet-injectable - use Logic Apps
//                Standard for full IL5 boundary compliance when attachments
//                carry CUI.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('report-subscriptions Function MI principal ID - granted Logic App Contributor so the Function can call listCallbackUrl. Empty skips the grant.')
param subscriptionPrincipalId string = ''

@description('Loom Console UAMI principal ID - also granted Logic App Contributor so the BFF can surface delivery status. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants - set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

@description('Workflow name. Defaults to a deterministic DLZ convention so the Function/Console can target it via LOOM_SUBSCRIPTION_LOGIC_APP_NAME without a post-deploy patch.')
param workflowName string = 'logic-loom-report-subs-${location}'

// Logic App Contributor built-in role.
var logicAppContributorRoleId = '87a39d53-fc1b-424a-814c-f7e04687dc9e'

// =====================================================================
// Office 365 Outlook API connection (OAuth - authorized post-deploy)
// =====================================================================

resource o365Connection 'Microsoft.Web/connections@2016-06-01' = {
  name: 'office365-loom-report-subs'
  location: location
  tags: complianceTags
  properties: {
    displayName: 'Office 365 Outlook - Loom Report Subscriptions'
    api: {
      name: 'office365'
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'office365')
      type: 'Microsoft.Web/locations/managedApis'
    }
    // OAuth-only connector - parameterValues intentionally empty; authorized
    // post-deploy via the portal connection blade (GCC-High: AzureUSGovernment).
    parameterValues: {}
  }
}

// =====================================================================
// Consumption Logic App - HTTP trigger + Send email (V2) with attachment
// =====================================================================

resource subscriptionWorkflow 'Microsoft.Logic/workflows@2019-05-01' = {
  name: workflowName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    parameters: {
      '$connections': {
        value: {
          office365: {
            id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'office365')
            connectionId: o365Connection.id
            connectionName: o365Connection.name
          }
        }
      }
    }
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        '$connections': {
          defaultValue: {}
          type: 'Object'
        }
      }
      triggers: {
        // The timer Function POSTs here with the rendered report (base64).
        // recipients is a ';'-separated address list (To accepts that form).
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                recipients: { type: 'string' }
                subject: { type: 'string' }
                reportName: { type: 'string' }
                attachmentName: { type: 'string' }
                attachmentContentType: { type: 'string' }
                attachmentBase64: { type: 'string' }
              }
              required: [ 'recipients', 'subject', 'attachmentName', 'attachmentBase64' ]
            }
          }
        }
      }
      actions: {
        // Send the scheduled report as an email attachment. ContentBytes takes
        // the base64 string directly (the connector decodes it).
        Send_report_email: {
          type: 'ApiConnection'
          inputs: {
            host: {
              connection: {
                name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
              }
            }
            method: 'post'
            path: '/v2/Mail'
            body: {
              To: '@triggerBody()?[\'recipients\']'
              Subject: '@triggerBody()?[\'subject\']'
              Body: '<p>Your scheduled Loom report <b>@{triggerBody()?[\'reportName\']}</b> is attached.</p>'
              Importance: 'Normal'
              Attachments: [
                {
                  Name: '@triggerBody()?[\'attachmentName\']'
                  ContentBytes: '@triggerBody()?[\'attachmentBase64\']'
                }
              ]
            }
          }
          runAfter: {}
        }
        // Acknowledge to the Function so it can record success/failure.
        Respond: {
          type: 'Response'
          kind: 'Http'
          inputs: {
            statusCode: 200
            body: {
              ok: true
              sentTo: '@triggerBody()?[\'recipients\']'
            }
          }
          runAfter: {
            Send_report_email: [ 'Succeeded' ]
          }
        }
      }
      outputs: {}
    }
  }
}

// =====================================================================
// RBAC - report-subscriptions Function MI -> Logic App Contributor
// (lets the Function call listCallbackUrl to resolve the trigger URL).
// =====================================================================

resource functionContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(subscriptionPrincipalId) && !skipRoleGrants) {
  scope: subscriptionWorkflow
  name: guid(subscriptionWorkflow.id, subscriptionPrincipalId, logicAppContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logicAppContributorRoleId)
    principalId: subscriptionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource consoleContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: subscriptionWorkflow
  name: guid(subscriptionWorkflow.id, consolePrincipalId, logicAppContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logicAppContributorRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output workflowId string = subscriptionWorkflow.id
output workflowName string = subscriptionWorkflow.name
output connectionId string = o365Connection.id
