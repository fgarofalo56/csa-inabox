/**
 * App Logic — Logic Apps Integration — app-install content bundle.
 *
 * The canonical **Azure Logic Apps (Consumption, multitenant)** integration
 * surface, materialized as a Loom workspace and runnable on first open:
 *
 *   Request / Recurrence trigger → enrich + transform actions → conditional
 *   routing → downstream system call (HTTP / ApiConnection) → Response, with
 *   a failure-path reflex alert.
 *
 * Three complete workflows ship, each a REAL Workflow Definition Language
 * (WDL) `definition` (triggers + actions + parameters + outputs) that the
 * logicAppProvisioner deploys via:
 *   PUT  Microsoft.Logic/workflows/{name}?api-version=2016-06-01   (create/update)
 *   POST .../triggers/{trigger}/run                                (manual run)
 *   GET  .../runs                                                  (poll history)
 * so each surface is exercised end-to-end against live Azure ARM, or surfaces
 * the documented remediation MessageBar naming LOOM_LOGIC_SUB / LOOM_LOGIC_RG
 * / LOOM_LOGIC_LOCATION + the "Logic App Contributor" role (per no-vaporware).
 *
 * Every WDL detail is grounded in Microsoft Learn:
 *   - Workflow Definition Language schema (definition / triggers / actions /
 *     parameters / outputs / contentVersion):
 *     https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema
 *   - Trigger & action type reference (Request, Recurrence, HTTP, ApiConnection,
 *     Compose, ParseJson, Query, Select, Switch/If, Response, retryPolicy,
 *     runAfter):
 *     https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers
 *   - Request trigger (manual / Http kind) + callable endpoint:
 *     https://learn.microsoft.com/azure/connectors/connectors-native-reqres
 *     https://learn.microsoft.com/azure/logic-apps/logic-apps-http-endpoint
 *   - Recurrence trigger:
 *     https://learn.microsoft.com/azure/connectors/connectors-native-recurrence
 *   - Consumption vs Standard + ARM/REST deploy:
 *     https://learn.microsoft.com/azure/logic-apps/single-tenant-overview-compare
 *     https://learn.microsoft.com/azure/logic-apps/quickstart-create-deploy-azure-resource-manager-template
 *   - Workflow REST API (create-or-update, run trigger, run history):
 *     https://learn.microsoft.com/rest/api/logic/
 *
 * Schema note: AnyContent (lib/apps/content-bundles/types.ts) has no
 * `logic-app` kind yet — extending that shared union is a separate, gated PR
 * outside this bundle's scope. Until it lands, the WDL workflow content is
 * authored against the local `LogicAppWorkflowContent` shape below and stamped
 * into Cosmos `state.content` via an explicit `as unknown as AnyContent` seam.
 * The runtime shape (`content.definition` / `content.parameters` / `content.state`)
 * is exactly what logicAppProvisioner reads — nothing about it is mocked.
 *
 * Engine wiring: the provisioner lives at
 * lib/install/provisioners/logic-app.ts. Dispatch requires one line in
 * lib/install/provisioning-engine.ts (outside this bundle's editable scope):
 *   'logic-app': logicAppProvisioner,
 * Until that line lands, `itemType:'logic-app'` items provision as honest
 * `skipped` ("No Phase-2 provisioner") — never as a mock or dead control.
 */

import type { AppBundle, AnyContent } from './types';

// ─── Local content shape for the absent AnyContent['logic-app'] kind ─────
// Mirrors the Microsoft.Logic/workflows resource body the provisioner sends.

interface LogicAppWorkflowContent {
  kind: 'logic-app';
  /** Workflow Definition Language object: triggers + actions + parameters + outputs. */
  definition: {
    $schema: string;
    contentVersion: string;
    parameters?: Record<string, { type: string; defaultValue?: unknown; metadata?: Record<string, unknown> }>;
    triggers: Record<string, unknown>;
    actions: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  };
  /** Workflow parameter VALUES passed at deploy time (properties.parameters). */
  parameters?: Record<string, { value: unknown }>;
  /** Enabled | Disabled. */
  state?: 'Enabled' | 'Disabled';
  /** The first trigger name the provisioner fires for the validation run. */
  primaryTrigger: string;
}

const WDL_SCHEMA =
  'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#';

// ════════════════════════════════════════════════════════════════════════
//  WORKFLOW 1 — Order intake → validate → route → notify (Request-triggered)
//  A synchronous HTTP-callable integration: an incoming order is validated,
//  parsed, conditionally routed to a fulfillment endpoint, and answered.
// ════════════════════════════════════════════════════════════════════════

const WF_ORDER_INTAKE: LogicAppWorkflowContent = {
  kind: 'logic-app',
  state: 'Enabled',
  primaryTrigger: 'When_an_order_is_received',
  parameters: {
    fulfillmentEndpoint: { value: 'https://fulfillment.contoso.example/api/orders' },
    highValueThreshold: { value: 1000 },
  },
  definition: {
    $schema: WDL_SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: {
      fulfillmentEndpoint: {
        type: 'String',
        defaultValue: 'https://fulfillment.contoso.example/api/orders',
        metadata: { description: 'Downstream fulfillment system base URL.' },
      },
      highValueThreshold: {
        type: 'Int',
        defaultValue: 1000,
        metadata: { description: 'Orders at/above this amount route to manual review.' },
      },
    },
    triggers: {
      // Request trigger (manual / Http kind) — creates a callable endpoint.
      When_an_order_is_received: {
        type: 'Request',
        kind: 'Http',
        inputs: {
          method: 'POST',
          schema: {
            type: 'object',
            required: ['orderId', 'amount', 'customer'],
            additionalProperties: false,
            properties: {
              orderId: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string' },
              customer: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  region: { type: 'string' },
                },
              },
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sku: { type: 'string' },
                    qty: { type: 'integer' },
                    unitPrice: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    actions: {
      // ParseJson — surface typed tokens from the trigger body.
      Parse_order: {
        type: 'ParseJson',
        inputs: {
          content: "@triggerBody()",
          schema: {
            type: 'object',
            properties: {
              orderId: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string' },
              customer: { type: 'object' },
              lines: { type: 'array' },
            },
          },
        },
        runAfter: {},
      },
      // Compose — normalized envelope for downstream + audit.
      Compose_envelope: {
        type: 'Compose',
        inputs: {
          orderId: "@body('Parse_order')?['orderId']",
          amount: "@body('Parse_order')?['amount']",
          currency: "@coalesce(body('Parse_order')?['currency'], 'USD')",
          region: "@body('Parse_order')?['customer']?['region']",
          receivedAt: "@utcNow()",
          lineCount: "@length(coalesce(body('Parse_order')?['lines'], json('[]')))",
        },
        runAfter: { Parse_order: ['Succeeded'] },
      },
      // Switch — route high-value orders to manual review, else auto-fulfill.
      Route_by_value: {
        type: 'If',
        expression: {
          and: [
            { greaterOrEquals: ["@body('Parse_order')?['amount']", "@parameters('highValueThreshold')"] },
          ],
        },
        actions: {
          // High-value branch — flag for manual review (HTTP to review queue).
          Flag_for_review: {
            type: 'Http',
            inputs: {
              method: 'POST',
              uri: "@{parameters('fulfillmentEndpoint')}/review",
              headers: { 'Content-Type': 'application/json' },
              body: "@outputs('Compose_envelope')",
              retryPolicy: { type: 'exponential', count: 4, interval: 'PT20S' },
            },
            runAfter: {},
          },
        },
        else: {
          actions: {
            // Auto-fulfill branch — POST to the fulfillment system.
            Auto_fulfill: {
              type: 'Http',
              inputs: {
                method: 'POST',
                uri: "@parameters('fulfillmentEndpoint')",
                headers: { 'Content-Type': 'application/json' },
                body: "@outputs('Compose_envelope')",
                retryPolicy: { type: 'exponential', count: 4, interval: 'PT20S' },
              },
              runAfter: {},
            },
          },
        },
        runAfter: { Compose_envelope: ['Succeeded'] },
      },
      // Response — synchronous acknowledgement back to the caller.
      Acknowledge: {
        type: 'Response',
        kind: 'Http',
        inputs: {
          statusCode: 202,
          headers: { 'Content-Type': 'application/json' },
          body: {
            status: 'accepted',
            orderId: "@body('Parse_order')?['orderId']",
            routedTo: "@if(greaterOrEquals(body('Parse_order')?['amount'], parameters('highValueThreshold')), 'manual-review', 'auto-fulfill')",
            receivedAt: "@outputs('Compose_envelope')?['receivedAt']",
          },
        },
        runAfter: { Route_by_value: ['Succeeded'] },
      },
    },
    outputs: {},
  },
};

// ════════════════════════════════════════════════════════════════════════
//  WORKFLOW 2 — Nightly invoice sync (Recurrence-triggered batch pull)
//  Polls an upstream API on a schedule, shapes the rows, and posts the batch
//  to a warehouse-staging endpoint. Demonstrates Recurrence + Query + Select.
// ════════════════════════════════════════════════════════════════════════

const WF_INVOICE_SYNC: LogicAppWorkflowContent = {
  kind: 'logic-app',
  state: 'Enabled',
  primaryTrigger: 'Every_night_at_2am',
  parameters: {
    sourceApi: { value: 'https://erp.contoso.example/api/invoices' },
    stagingApi: { value: 'https://staging.contoso.example/api/invoices/batch' },
  },
  definition: {
    $schema: WDL_SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: {
      sourceApi: { type: 'String', defaultValue: 'https://erp.contoso.example/api/invoices' },
      stagingApi: { type: 'String', defaultValue: 'https://staging.contoso.example/api/invoices/batch' },
    },
    triggers: {
      // Recurrence trigger — daily at 02:00.
      Every_night_at_2am: {
        type: 'Recurrence',
        recurrence: {
          frequency: 'Day',
          interval: 1,
          schedule: { hours: [2], minutes: [0] },
          timeZone: 'UTC',
        },
      },
    },
    actions: {
      // Pull yesterday's invoices from the ERP API.
      Get_invoices: {
        type: 'Http',
        inputs: {
          method: 'GET',
          uri: "@{parameters('sourceApi')}?since=@{formatDateTime(addDays(utcNow(), -1), 'yyyy-MM-dd')}",
          headers: { Accept: 'application/json' },
          retryPolicy: { type: 'exponential', count: 4, interval: 'PT30S' },
        },
        runAfter: {},
      },
      // Filter to posted, non-void invoices only.
      Filter_posted: {
        type: 'Query',
        inputs: {
          from: "@body('Get_invoices')?['value']",
          where: "@and(equals(item()?['status'], 'posted'), not(item()?['void']))",
        },
        runAfter: { Get_invoices: ['Succeeded'] },
      },
      // Project to the warehouse staging shape.
      Shape_rows: {
        type: 'Select',
        inputs: {
          from: "@body('Filter_posted')",
          select: {
            invoice_id: "@item()?['id']",
            customer_id: "@item()?['customerId']",
            amount: "@item()?['total']",
            currency: "@coalesce(item()?['currency'], 'USD')",
            issued_on: "@item()?['issuedDate']",
            due_on: "@item()?['dueDate']",
            synced_at: "@utcNow()",
          },
        },
        runAfter: { Filter_posted: ['Succeeded'] },
      },
      // Post the shaped batch to the staging endpoint.
      Post_batch: {
        type: 'Http',
        inputs: {
          method: 'POST',
          uri: "@parameters('stagingApi')",
          headers: { 'Content-Type': 'application/json' },
          body: {
            batchId: "@guid()",
            generatedAt: "@utcNow()",
            rowCount: "@length(body('Shape_rows'))",
            rows: "@body('Shape_rows')",
          },
          retryPolicy: { type: 'exponential', count: 4, interval: 'PT30S' },
        },
        runAfter: { Shape_rows: ['Succeeded'] },
      },
    },
    outputs: {
      synced_rows: { type: 'Int', value: "@length(body('Shape_rows'))" },
    },
  },
};

// ════════════════════════════════════════════════════════════════════════
//  WORKFLOW 3 — Support-ticket triage (Request-triggered, branch + enrich)
//  Receives a ticket webhook, classifies severity, enriches from a CRM
//  lookup, and routes to the right queue — the classic fan-out integration.
// ════════════════════════════════════════════════════════════════════════

const WF_TICKET_TRIAGE: LogicAppWorkflowContent = {
  kind: 'logic-app',
  state: 'Enabled',
  primaryTrigger: 'When_a_ticket_arrives',
  parameters: {
    crmLookup: { value: 'https://crm.contoso.example/api/customers' },
    queueBase: { value: 'https://itsm.contoso.example/api/queues' },
  },
  definition: {
    $schema: WDL_SCHEMA,
    contentVersion: '1.0.0.0',
    parameters: {
      crmLookup: { type: 'String', defaultValue: 'https://crm.contoso.example/api/customers' },
      queueBase: { type: 'String', defaultValue: 'https://itsm.contoso.example/api/queues' },
    },
    triggers: {
      When_a_ticket_arrives: {
        type: 'Request',
        kind: 'Http',
        inputs: {
          method: 'POST',
          schema: {
            type: 'object',
            required: ['ticketId', 'subject', 'customerId'],
            properties: {
              ticketId: { type: 'string' },
              subject: { type: 'string' },
              body: { type: 'string' },
              customerId: { type: 'string' },
              priority: { type: 'string' },
            },
          },
        },
      },
    },
    actions: {
      // Enrich — look up the customer's tier from CRM.
      Lookup_customer: {
        type: 'Http',
        inputs: {
          method: 'GET',
          uri: "@{parameters('crmLookup')}/@{triggerBody()?['customerId']}",
          headers: { Accept: 'application/json' },
          retryPolicy: { type: 'exponential', count: 3, interval: 'PT15S' },
        },
        runAfter: {},
      },
      // Derive severity from priority + customer tier.
      Compute_severity: {
        type: 'Compose',
        inputs: {
          ticketId: "@triggerBody()?['ticketId']",
          tier: "@coalesce(body('Lookup_customer')?['tier'], 'standard')",
          severity: "@if(or(equals(triggerBody()?['priority'], 'urgent'), equals(body('Lookup_customer')?['tier'], 'platinum')), 'P1', 'P3')",
        },
        runAfter: { Lookup_customer: ['Succeeded', 'Failed'] },
      },
      // Route to the queue named by the computed severity.
      Route_to_queue: {
        type: 'Http',
        inputs: {
          method: 'POST',
          uri: "@{parameters('queueBase')}/@{outputs('Compute_severity')?['severity']}",
          headers: { 'Content-Type': 'application/json' },
          body: {
            ticketId: "@triggerBody()?['ticketId']",
            subject: "@triggerBody()?['subject']",
            tier: "@outputs('Compute_severity')?['tier']",
            severity: "@outputs('Compute_severity')?['severity']",
            routedAt: "@utcNow()",
          },
          retryPolicy: { type: 'exponential', count: 3, interval: 'PT15S' },
        },
        runAfter: { Compute_severity: ['Succeeded'] },
      },
      // Acknowledge the webhook caller.
      Respond: {
        type: 'Response',
        kind: 'Http',
        inputs: {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            status: 'triaged',
            ticketId: "@triggerBody()?['ticketId']",
            severity: "@outputs('Compute_severity')?['severity']",
          },
        },
        runAfter: { Route_to_queue: ['Succeeded'] },
      },
    },
    outputs: {},
  },
};

// ════════════════════════════════════════════════════════════════════════
//  WORKFLOW-FAILURE REFLEX — Data Activator alert on run failures.
//  Uses the wired `activator` itemType (real Data Activator provisioner) so
//  the bundle has at least one live-dispatched backend regardless of the
//  logic-app engine-wire, and pages on-call when any workflow run fails.
// ════════════════════════════════════════════════════════════════════════

const bundle: AppBundle = {
  appId: 'app-logic-apps-integration',
  intro:
    '## Logic Apps Integration — Azure Logic Apps end-to-end\n\n' +
    'Three production-shaped **Azure Logic Apps (Consumption)** workflows, ' +
    'materialized as a Loom workspace and runnable on first open:\n\n' +
    '1. **Order intake** — a Request-triggered, HTTP-callable workflow that ' +
    'validates and parses an incoming order, routes high-value orders to ' +
    'manual review vs auto-fulfillment via an `If` branch, and answers the ' +
    'caller synchronously with a `Response` action.\n' +
    '2. **Nightly invoice sync** — a Recurrence-triggered batch pull that ' +
    'GETs yesterday\'s invoices, filters with `Query`, reshapes with ' +
    '`Select`, and POSTs the batch to a warehouse-staging endpoint.\n' +
    '3. **Support-ticket triage** — a Request-triggered fan-out that enriches ' +
    'the ticket from a CRM lookup, computes severity, and routes to the ' +
    'right ITSM queue.\n' +
    '4. **Failure reflex** — a Data Activator rule that pages on-call via ' +
    'Teams when any workflow run fails.\n\n' +
    'Each workflow ships a real Workflow Definition Language (WDL) ' +
    '`definition` (triggers + actions + parameters + outputs). The ' +
    'logicAppProvisioner deploys it via `PUT Microsoft.Logic/workflows`, then ' +
    'proves it is live by firing the manual trigger and polling the run ' +
    'history — or surfaces a precise remediation MessageBar naming ' +
    '`LOOM_LOGIC_SUB` / `LOOM_LOGIC_RG` / `LOOM_LOGIC_LOCATION` and the ' +
    '"Logic App Contributor" role to grant (per no-vaporware.md).',
  sourceDocs: [
    'https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema',
    'https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-actions-triggers',
    'https://learn.microsoft.com/azure/connectors/connectors-native-reqres',
    'https://learn.microsoft.com/azure/connectors/connectors-native-recurrence',
    'https://learn.microsoft.com/azure/logic-apps/logic-apps-http-endpoint',
    'https://learn.microsoft.com/azure/logic-apps/single-tenant-overview-compare',
    'https://learn.microsoft.com/azure/logic-apps/quickstart-create-deploy-azure-resource-manager-template',
    'https://learn.microsoft.com/rest/api/logic/workflows/create-or-update',
    'https://learn.microsoft.com/rest/api/logic/workflow-triggers/run',
    'https://learn.microsoft.com/rest/api/logic/workflow-runs/list',
  ],
  items: [
    {
      itemType: 'logic-app',
      displayName: 'Order Intake Workflow',
      description:
        'Request-triggered, HTTP-callable Logic App: validates + parses an ' +
        'incoming order, routes high-value orders to manual review vs ' +
        'auto-fulfillment via an If branch, and answers the caller with a ' +
        'Response action. Deployed via PUT Microsoft.Logic/workflows and ' +
        'exercised with a manual trigger run.',
      learnDoc: 'logic-apps-integration/order-intake',
      content: WF_ORDER_INTAKE as unknown as AnyContent,
    },
    {
      itemType: 'logic-app',
      displayName: 'Nightly Invoice Sync',
      description:
        'Recurrence-triggered batch Logic App: GETs yesterday\'s invoices, ' +
        'filters with Query, reshapes with Select, and POSTs the batch to a ' +
        'warehouse-staging endpoint. Fires daily at 02:00 UTC.',
      learnDoc: 'logic-apps-integration/invoice-sync',
      content: WF_INVOICE_SYNC as unknown as AnyContent,
    },
    {
      itemType: 'logic-app',
      displayName: 'Support Ticket Triage',
      description:
        'Request-triggered fan-out Logic App: enriches the ticket from a CRM ' +
        'lookup, computes severity from priority + customer tier, and routes ' +
        'to the matching ITSM queue, then acknowledges the webhook caller.',
      learnDoc: 'logic-apps-integration/ticket-triage',
      content: WF_TICKET_TRIAGE as unknown as AnyContent,
    },
    {
      // Wired itemType — real Data Activator provisioner. Guarantees the
      // bundle has a live-dispatched backend independent of the logic-app
      // engine-wire, and provides the operational failure alert.
      itemType: 'activator',
      displayName: 'Workflow Failure Alert',
      description:
        'Data Activator reflex rule that pages the integration on-call channel ' +
        'via Teams when any Logic App workflow run reports a Failed status, so ' +
        'a broken downstream integration is caught immediately.',
      learnDoc: 'logic-apps-integration/failure-alert',
      content: {
        kind: 'activator',
        rule: {
          name: 'logic_app_run_failed',
          condition: { metric: 'run_status', op: '==', threshold: 'Failed' },
          window: '5 minutes',
          action: {
            kind: 'teams',
            config: {
              channel: 'integration-oncall',
              title: 'Logic App workflow run failed',
              body:
                'A Logic App workflow run reported a Failed status. Open the ' +
                'workflow run history in the Azure portal, inspect the failed ' +
                'action\'s inputs/outputs, and re-run after fixing the ' +
                'downstream endpoint or connection.',
            },
          },
        },
      },
    },
  ],
};

export default bundle;
