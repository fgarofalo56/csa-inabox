# Tutorial: Logic App editor

> CSA Loom `logic-app` editor — an Azure Logic Apps (Consumption) workflow
> surface: triggers + actions in the WDL designer, parameters, code view, and a
> real **Run trigger**. **No Microsoft Fabric required.**

## What it is

A Logic App is an Azure Logic Apps (Consumption) workflow defined in the
Workflow Definition Language (WDL): a trigger (Request, Recurrence) followed by
actions (HTTP, ApiConnection, Compose, ParseJson, Query, Select, If/Switch,
Response). In Loom it opens fully built-out from the installed definition or
the live `Microsoft.Logic/workflows` resource, and **Run trigger** fires a real
manual run.

## When to use it

- You need event-driven or scheduled integration glue — HTTP calls, JSON
  shaping, conditional routing — without writing a service.
- A Loom content bundle installed a workflow and you want to inspect and run
  it.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Logic App** (Data Factory) or
   open an installed one; the editor opens at `/items/logic-app/<id>`.
2. **Read the designer.** The **Designer** tab shows the trigger followed by
   every action in execution order, including branch sub-actions and `runAfter`
   dependencies.
3. **Inspect parameters.** The **Parameters** tab lists the WDL parameters
   (type, default, description) and the deploy-time parameter values.
4. **Review the WDL.** The **Code view** tab shows the full Workflow Definition
   Language JSON in a Monaco editor.
5. **Run the trigger.** **Run trigger** fires the manual trigger on the bound
   workflow and polls run history, or surfaces an honest gate naming
   `LOOM_LOGIC_SUB` / `LOOM_LOGIC_RG` / `LOOM_LOGIC_LOCATION` + the **Logic App
   Contributor** role.

## The Azure backend it rides on

- **Resource:** `Microsoft.Logic/workflows` (Consumption) ARM REST — trigger
  run + run-history polling.
- **RBAC:** Logic App Contributor for the Console UAMI on the workflow scope.

## No Fabric required

Logic Apps is a first-class Azure service; no Fabric capacity, workspace, or
OneLake is involved.

## Learn more

- Workflow Definition Language:
  <https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema>
