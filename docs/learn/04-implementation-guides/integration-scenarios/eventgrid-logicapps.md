# Event Grid Integration with Logic Apps

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __EventGrid + Logic Apps__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Beginner-green?style=flat-square)

Build automated workflows triggered by Azure events using Logic Apps.

---

## Overview

Event Grid + Logic Apps enables:

- No-code/low-code workflow automation
- Rich connector ecosystem (400+ connectors)
- Built-in retry and error handling
- Visual workflow designer

---

## Implementation

### Step 1: Create Logic App with Event Grid Trigger

```json
{
    "definition": {
        "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
        "contentVersion": "1.0.0.0",
        "triggers": {
            "When_a_resource_event_occurs": {
                "type": "ApiConnectionWebhook",
                "inputs": {
                    "host": {
                        "connection": {
                            "name": "@parameters('$connections')['azureeventgrid']['connectionId']"
                        }
                    },
                    "body": {
                        "properties": {
                            "topic": "/subscriptions/{sub}/resourceGroups/rg-analytics/providers/Microsoft.Storage/storageAccounts/datalake",
                            "destination": {
                                "endpointType": "webhook",
                                "properties": {
                                    "endpointUrl": "@{listCallbackUrl()}"
                                }
                            },
                            "filter": {
                                "includedEventTypes": ["Microsoft.Storage.BlobCreated"]
                            }
                        }
                    },
                    "path": "/subscriptions/{sub}/providers/Microsoft.EventGrid/eventSubscriptions"
                }
            }
        }
    }
}
```

### Step 2: Data Pipeline Trigger Workflow

```json
{
    "definition": {
        "triggers": {
            "When_blob_created": {
                "type": "ApiConnectionWebhook",
                "inputs": {
                    "body": {
                        "properties": {
                            "filter": {
                                "subjectEndsWith": ".parquet",
                                "includedEventTypes": ["Microsoft.Storage.BlobCreated"]
                            }
                        }
                    }
                }
            }
        },
        "actions": {
            "Parse_Event": {
                "type": "ParseJson",
                "inputs": {
                    "content": "@triggerBody()",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "subject": { "type": "string" },
                            "data": {
                                "type": "object",
                                "properties": {
                                    "url": { "type": "string" },
                                    "contentLength": { "type": "integer" }
                                }
                            }
                        }
                    }
                }
            },
            "Trigger_Data_Factory_Pipeline": {
                "type": "ApiConnection",
                "runAfter": { "Parse_Event": ["Succeeded"] },
                "inputs": {
                    "host": {
                        "connection": {
                            "name": "@parameters('$connections')['azuredatafactory']['connectionId']"
                        }
                    },
                    "method": "post",
                    "path": "/subscriptions/{sub}/resourcegroups/rg-analytics/providers/Microsoft.DataFactory/factories/adf-analytics/pipelines/process_new_file/createRun",
                    "body": {
                        "blob_path": "@body('Parse_Event')?['data']?['url']"
                    }
                }
            },
            "Wait_For_Pipeline": {
                "type": "ApiConnection",
                "runAfter": { "Trigger_Data_Factory_Pipeline": ["Succeeded"] },
                "inputs": {
                    "method": "get",
                    "path": "/subscriptions/{sub}/resourcegroups/rg-analytics/providers/Microsoft.DataFactory/factories/adf-analytics/pipelineruns/@{body('Trigger_Data_Factory_Pipeline')?['runId']}"
                },
                "until": {
                    "equals": ["@body('Wait_For_Pipeline')?['status']", "Succeeded"]
                }
            },
            "Send_Completion_Email": {
                "type": "ApiConnection",
                "runAfter": { "Wait_For_Pipeline": ["Succeeded"] },
                "inputs": {
                    "host": {
                        "connection": {
                            "name": "@parameters('$connections')['office365']['connectionId']"
                        }
                    },
                    "method": "post",
                    "path": "/v2/Mail",
                    "body": {
                        "To": "data-team@company.com",
                        "Subject": "Pipeline Completed: @{body('Parse_Event')?['subject']}",
                        "Body": "File processed successfully"
                    }
                }
            }
        }
    }
}
```

### Step 3: Approval Workflow for Data Changes

```json
{
    "definition": {
        "triggers": {
            "When_sensitive_data_modified": {
                "type": "ApiConnectionWebhook",
                "inputs": {
                    "body": {
                        "properties": {
                            "filter": {
                                "subjectBeginsWith": "/blobServices/default/containers/sensitive/"
                            }
                        }
                    }
                }
            }
        },
        "actions": {
            "Send_Approval_Email": {
                "type": "ApiConnectionWebhook",
                "inputs": {
                    "host": {
                        "connection": {
                            "name": "@parameters('$connections')['office365']['connectionId']"
                        }
                    },
                    "body": {
                        "NotificationUrl": "@{listCallbackUrl()}",
                        "Message": {
                            "To": "data-steward@company.com",
                            "Subject": "Approval Required: Sensitive Data Modified",
                            "Options": "Approve, Reject",
                            "Body": "A file in the sensitive data container was modified:\n\nFile: @{triggerBody()?['subject']}\nTime: @{triggerBody()?['eventTime']}"
                        }
                    },
                    "path": "/approvalmail/$subscriptions"
                }
            },
            "Check_Approval": {
                "type": "If",
                "runAfter": { "Send_Approval_Email": ["Succeeded"] },
                "expression": {
                    "equals": ["@body('Send_Approval_Email')?['SelectedOption']", "Approve"]
                },
                "actions": {
                    "Log_Approved_Change": {
                        "type": "ApiConnection",
                        "inputs": {
                            "host": {
                                "connection": {
                                    "name": "@parameters('$connections')['azureloganalytics']['connectionId']"
                                }
                            },
                            "method": "post",
                            "body": {
                                "action": "approved",
                                "file": "@triggerBody()?['subject']",
                                "approver": "@body('Send_Approval_Email')?['UserEmailAddress']"
                            }
                        }
                    }
                },
                "else": {
                    "actions": {
                        "Revert_Change": {
                            "type": "ApiConnection",
                            "inputs": {
                                "method": "delete",
                                "path": "@triggerBody()?['data']?['url']"
                            }
                        },
                        "Log_Rejected_Change": {
                            "type": "ApiConnection"
                        }
                    }
                }
            }
        }
    }
}
```

### Step 4: Multi-Service Orchestration

```json
{
    "actions": {
        "Parallel_Processing": {
            "type": "Parallel",
            "branches": [
                {
                    "actions": {
                        "Index_In_Cognitive_Search": {
                            "type": "Http",
                            "inputs": {
                                "method": "POST",
                                "uri": "https://search.windows.net/indexers/blob-indexer/run",
                                "headers": {
                                    "api-key": "@parameters('searchApiKey')"
                                }
                            }
                        }
                    }
                },
                {
                    "actions": {
                        "Update_Purview_Catalog": {
                            "type": "Http",
                            "inputs": {
                                "method": "POST",
                                "uri": "https://purview.purview.azure.com/catalog/api/atlas/v2/entity"
                            }
                        }
                    }
                },
                {
                    "actions": {
                        "Send_Teams_Notification": {
                            "type": "ApiConnection",
                            "inputs": {
                                "host": {
                                    "connection": {
                                        "name": "@parameters('$connections')['teams']['connectionId']"
                                    }
                                },
                                "method": "post",
                                "path": "/v3/beta/teams/{teamId}/channels/{channelId}/messages"
                            }
                        }
                    }
                }
            ]
        }
    }
}
```

---

## Common Patterns

### Error Handling

```json
{
    "Configure_Run_After": {
        "runAfter": {
            "Previous_Action": ["Succeeded", "Failed", "TimedOut"]
        }
    },
    "Scope_With_Catch": {
        "type": "Scope",
        "actions": {
            "Try_Action": {}
        }
    },
    "Catch_Errors": {
        "type": "Scope",
        "runAfter": { "Scope_With_Catch": ["Failed"] },
        "actions": {
            "Send_Error_Alert": {}
        }
    }
}
```

---

## Related Documentation

- [EventGrid + Functions](eventgrid-functions.md)
- [EventGrid + EventHubs](eventgrid-eventhubs.md)
- [Integration Patterns](../../03-architecture-patterns/integration-patterns/README.md)

---

*Last Updated: January 2025*
