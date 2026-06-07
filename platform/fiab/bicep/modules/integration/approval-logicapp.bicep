// CSA Loom - Approval Logic App (Consumption + Office 365 Outlook)
//
// Azure-native parity for Fabric's "Office 365 Outlook -> Send approval email"
// and Power Automate approvals (NO Fabric / Power Automate dependency). Wires:
//   ADF/Synapse WebHook activity  -> Logic App HTTP "manual" trigger
//   Office 365 "Send approval email" (blocks until approver responds)
//   -> POST {StatusCode, Output|Error} back to the ADF callBackUri.
// Approve -> StatusCode 200 (pipeline continues). Reject -> 400 (branch fails).
// This is the only Azure-native way to pause an ADF/Synapse pipeline and
// collect a human decision without a custom app.
//
// Grounded in Microsoft Learn:
//   ADF WebHook activity:
//     https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity
//   Microsoft.Logic/workflows (Consumption, Bicep):
//     https://learn.microsoft.com/azure/templates/microsoft.logic/workflows
//   Office 365 Outlook connector (approval email):
//     https://learn.microsoft.com/connectors/office365/
//   listCallbackUrl (trigger URL):
//     https://learn.microsoft.com/rest/api/logic/workflow-triggers/list-callback-url
//
// DEPLOYMENT NOTE - the O365 connection must be OAuth-authorized post-deploy
// (Bicep cannot perform the interactive consent):
//   1. Open the Logic App in the portal -> Edit.
//   2. On the "Send_approval_email" action, choose Change connection -> Add new.
//   3. Sign in with a LICENSED Office 365 mailbox account.
//   4. For GCC-High / IL5: pick the "AzureUSGovernment" authentication endpoint.
// Until authorized, the action returns 401 and the activity surfaces a clear
// error - see docs/fiab/v3-tenant-bootstrap.md.
//
// Per-cloud status:
//   Commercial : Fully supported. Trigger URL = *.logic.azure.com.
//   GCC        : Azure-Commercial backed (same as Commercial). O365 GCC tenant OK.
//   GCC-High   : Azure Government backed. Trigger URL = *.logic.azure.us. O365
//                connector requires re-auth with the AzureUSGovernment endpoint.
//   IL5        : Consumption Logic Apps are NOT VNet-injectable - use Logic Apps
//                Standard for full IL5 boundary compliance. Consumption is
//                acceptable when approval emails carry no CUI (unclassified
//                coordination only).

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Console UAMI principal ID - granted Logic App Contributor so the BFF can call listCallbackUrl + read workflow status. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants - set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Default approver email pre-filled in the approval email. Individual runs override via the pipeline parameter approverEmail.')
param defaultApproverEmail string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

@description('Workflow name. Defaults to a deterministic DLZ convention so the Console can target it via LOOM_APPROVAL_LOGIC_APP_NAME without a post-deploy patch.')
param workflowName string = 'logic-loom-approval-${location}'

// =====================================================================
// Office 365 Outlook API connection (OAuth - authorized post-deploy)
// =====================================================================

resource o365Connection 'Microsoft.Web/connections@2016-06-01' = {
  name: 'office365-loom-approval'
  location: location
  tags: complianceTags
  properties: {
    displayName: 'Office 365 Outlook - Loom Approvals'
    api: {
      name: 'office365'
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'office365')
      type: 'Microsoft.Web/locations/managedApis'
    }
    // OAuth-only connector - parameterValues is intentionally empty. The
    // operator authorizes the connection post-deploy via the portal connection
    // blade (GCC-High: choose the AzureUSGovernment authentication type).
    parameterValues: {}
  }
}

// =====================================================================
// Consumption Logic App - HTTP trigger + approval workflow
// =====================================================================

resource approvalWorkflow 'Microsoft.Logic/workflows@2019-05-01' = {
  name: workflowName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    // Wire the O365 connection into the workflow's $connections parameter.
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
        // ADF WebHook POSTs here. ADF injects callBackUri alongside the
        // caller-supplied body { pipelineName, runId, approverEmail }. Logic
        // Apps returns HTTP 202 immediately for an async Request trigger; ADF
        // then waits for the callBackUri POST.
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                pipelineName: { type: 'string' }
                runId: { type: 'string' }
                approverEmail: { type: 'string' }
                callBackUri: { type: 'string' }
              }
              required: [ 'callBackUri' ]
            }
          }
        }
      }
      actions: {
        // Step 1 - send the approval email and block until the approver responds.
        // SelectedOption is "Approve" or "Reject".
        Send_approval_email: {
          type: 'ApiConnection'
          inputs: {
            host: {
              connection: {
                name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
              }
            }
            method: 'post'
            path: '/approvalmail/$subscriptions'
            body: {
              NotificationUrl: '@{listCallbackUrl()}'
              Message: {
                To: '@{coalesce(triggerBody()?[\'approverEmail\'], \'${defaultApproverEmail}\')}'
                Subject: '@{concat(\'Approval request - pipeline \', triggerBody()?[\'pipelineName\'])}'
                Options: 'Approve, Reject'
                Body: '<p>Pipeline <b>@{triggerBody()?[\'pipelineName\']}</b><br/>Run ID: @{triggerBody()?[\'runId\']}<br/><br/>Please approve or reject this pipeline run.</p>'
                Importance: 'Normal'
              }
            }
          }
          runAfter: {}
        }
        // Step 2 - branch on the approver's decision and call back to ADF.
        Check_decision: {
          type: 'If'
          expression: {
            and: [
              {
                equals: [
                  '@body(\'Send_approval_email\')?[\'SelectedOption\']'
                  'Approve'
                ]
              }
            ]
          }
          actions: {
            // Approved -> POST StatusCode 200 to ADF callBackUri (pipeline continues).
            Callback_approved: {
              type: 'Http'
              inputs: {
                method: 'POST'
                uri: '@triggerBody()?[\'callBackUri\']'
                headers: { 'Content-Type': 'application/json' }
                body: {
                  StatusCode: '200'
                  Output: {
                    decision: 'Approved'
                    approver: '@body(\'Send_approval_email\')?[\'ResponseAuthor\']?[\'Name\']'
                    respondedAt: '@body(\'Send_approval_email\')?[\'ResponseTime\']'
                  }
                }
              }
            }
          }
          else: {
            actions: {
              // Rejected -> POST StatusCode 400 so ADF marks the activity failed.
              Callback_rejected: {
                type: 'Http'
                inputs: {
                  method: 'POST'
                  uri: '@triggerBody()?[\'callBackUri\']'
                  headers: { 'Content-Type': 'application/json' }
                  body: {
                    StatusCode: '400'
                    Error: {
                      ErrorCode: 'ApprovalRejected'
                      Message: '@{concat(\'Approval rejected by \', body(\'Send_approval_email\')?[\'ResponseAuthor\']?[\'Name\'])}'
                    }
                  }
                }
              }
            }
          }
          runAfter: {
            Send_approval_email: [ 'Succeeded' ]
          }
        }
      }
      outputs: {}
    }
  }
}

// =====================================================================
// RBAC - Console UAMI -> Logic App Contributor on this workflow
// (built-in role 87a39d53-fc1b-424a-814c-f7e04687dc9e). Lets the BFF call
// listCallbackUrl and read workflow status.
// =====================================================================

resource logicContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: approvalWorkflow
  name: guid(approvalWorkflow.id, consolePrincipalId, '87a39d53-fc1b-424a-814c-f7e04687dc9e')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '87a39d53-fc1b-424a-814c-f7e04687dc9e')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output workflowId string = approvalWorkflow.id
output workflowName string = approvalWorkflow.name
output connectionId string = o365Connection.id
