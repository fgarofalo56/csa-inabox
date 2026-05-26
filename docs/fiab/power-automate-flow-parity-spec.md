# Power Automate Flow Editor — cloud-flow-designer parity spec

> Captured 2026-05-26 by catalog agent from Microsoft Learn (Power Automate cloud-flow designer · triggers + actions reference · Apply-to-each · Switch · trigger conditions) and inspection of `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerAutomateFlowEditor` + `apps/fiab-console/lib/azure/powerplatform-client.ts`. Loom has working Flow admin REST list / get / run / runs (UAT-verified); this spec compares Loom's current surface against the full Power Automate cloud-flow designer authoring UX.

## Overview

A Power Automate **cloud flow** is a serverless workflow triggered by an event (automated), schedule (scheduled), or user action (instant / button). The flow runs a sequence of **actions** drawn from 1000+ connectors plus control nodes (Condition · Switch · Apply-to-each · Do-until · Scope · Parallel branch · Terminate). Every flow has a single trigger, a tree of actions, optional trigger conditions (server-side filter expressions that block runs that don't matter), connection references (named credentials), variables, and a 28-day run history. Cloud flows live in Dataverse (under the `workflow` table when in an env with Dataverse) and are exposed via the Flow management REST API (`api.flow.microsoft.com`). The authoring surface is the cloud-flow designer at `make.powerautomate.com` (current "new designer" + legacy "classic designer"); both produce the same underlying Workflow Definition Language (WDL) JSON — an Azure Logic Apps dialect.

## Power Automate cloud-flow designer UX

### Flow landing
- Header: name · breadcrumb · run history · 28-day chart (success / failure / skipped per day)
- Tabs: **Details** (status, owner, plan, run-only users) · **Run history** (per-run drill-down) · **Edit**

### Designer (top → bottom canvas)
- **Trigger** at top — picked from connector catalog; trigger card displays current configuration (connector + method + parameters + dynamic-content tokens)
- **Add an action** **+** button between every pair of nodes
- **Action catalog** — search across 1000+ connectors; per-connector list of operations; favourites; recent
- **Action card** — connector + operation + parameter fields (with dynamic-content picker + expression editor); collapse/expand; rename; delete; move

### Control nodes
- **Condition** — left/operator/right comparison; If yes / If no branches; multi-condition AND/OR via `+`
- **Switch** — value-to-check + multiple Case branches + Default
- **Apply to each** — iterates over an array; nested actions
- **Do until** — loop with exit condition + count + timeout limits
- **Scope** — group actions, share Try/Catch error handling
- **Parallel branch** — splits flow into concurrent paths after a node
- **Terminate** — end run early with Succeeded / Failed / Cancelled + custom message

### Dynamic content + expressions
- **Dynamic content** flyout — pick outputs of any prior action / trigger / variable as input to current field
- **Expression** tab — write Workflow Definition Language expressions (`triggerOutputs()`, `body('Get_items')?['value']`, `addDays(utcNow(), 7)`, `if(equals(...),...,...)`)
- **Copilot expression assistant** — natural-language → WDL expression (preview)

### Variables
- **Initialize variable** (typed: Boolean / Integer / Float / String / Object / Array) as the first set of actions
- **Set variable**, **Increment variable**, **Decrement variable**, **Append to string/array variable**

### Settings (per action / trigger)
- **Trigger conditions** — server-side filter expressions (every condition must start with `@`); reduces flow runs and consumption
- **Retry policy** — None / Default / Fixed-interval / Exponential
- **Timeout** — ISO-8601 duration
- **Concurrency control** — single-run vs parallel runs (1–50)
- **Pagination** — for connectors that return paged data
- **Secure inputs / Secure outputs** — strip from run history (GDPR + secrets)
- **Asynchronous pattern** — required for long-running AI Builder, Send Approval, etc.

### Connection references
- Per-flow list of named connection references (e.g., `shared_office365_1`)
- Per-reference status: green checkmark / broken (re-auth needed)
- Replace connection (used post env-move)

### Test + run
- **Test** — Manually (interactive) / Automatically (using past run) / Using sample trigger data
- **Run history** — list of last 28 days, per-run: start · end · duration · status (Succeeded / Failed / Cancelled / Running) · trigger output · per-action input + output + error
- **Resubmit** failed run
- **Cancel** running run
- **Analytics** — usage chart + error categorisation

### Save / publish / share
- **Save** — first save creates the workflow; subsequent saves version
- **Turn on / Turn off** — activate or pause
- **Share** — owner / co-owner / run-only user; per-connection auth choice (use ours / sign in your own)
- **Export** — package (.zip with the WDL JSON), Logic Apps template
- **Solutions membership** — included solutions in the env

### Copilot
- Natural-language flow creation: "When a new tweet mentions Contoso, send email" → Copilot picks trigger + actions
- Copilot expression assistant inside expression editor

## What Loom has today

From `apps/fiab-console/lib/editors/powerplatform-editors.tsx::PowerAutomateFlowEditor` and `apps/fiab-console/lib/azure/powerplatform-client.ts`:

- **Environment picker** (shared)
- **List flows** — `GET https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/scopes/admin/environments/{envId}/flows?api-version=2016-11-01` (admin REST, UAMI auth)
- **Flows table** — Name (clickable) · State badge (Started / Stopped / Suspended) · Trigger type · Modified
- **Click a flow** → detail view
- **Get flow** — `GET .../flows/{name}` returns `definitionSummary` (trigger + first-level action types)
- **Detail metadata grid** — Display name · Name · State · Trigger · Created · Modified
- **Run flow** button — `POST .../flows/{name}/triggers/manual/run?api-version=2016-11-01` (only works for flows with a `manual` trigger)
- **Runs table** — last 50: Run name · Status badge (Succeeded / Failed / other) · Started · Ended · Error message
- Reload button (refreshes flows + runs)
- Success / error MessageBar after `Run flow`
- Ribbon stub: Reload · Open in Power Platform (labels only)

## Gaps for parity

1. **No `+ New flow` create flow** — can't pick Automated / Scheduled / Instant / Desktop / Process-mining and instantiate a workflow
2. **No designer / canvas authoring** — Loom can't edit the trigger + action tree; no connector picker, no per-action parameter form, no dynamic-content picker
3. **No WDL JSON editor** — Loom can't show or edit `definition.json` even in raw form
4. **No trigger configuration** — Loom can't change the trigger (e.g., swap a manual trigger for a Dataverse `When a row is added` trigger) or edit trigger parameters
5. **No control nodes** — Condition / Switch / Apply-to-each / Do-until / Scope / Parallel branch / Terminate not surfaced
6. **No dynamic content picker / expression editor** — Loom has no way to author `@triggerOutputs()?['body/email']` style expressions
7. **No variables** — Initialize / Set / Increment / Append not surfaced
8. **No action settings** — trigger conditions · retry policy · timeout · concurrency · pagination · secure inputs/outputs · async pattern all hidden
9. **No connection references panel** — Loom can't list the connectors a flow needs, can't show broken connections after env-move, can't re-bind
10. **Run flow restricted** — only `manual` triggers work; no "Test with sample data", no "Test with last run", no Resubmit-failed-run, no Cancel-running-run
11. **Per-run drilldown** — Loom shows status + error message only; no per-action input / output / error, no payload inspector, no replay
12. **No Turn on / Turn off** — `state` is read-only; can't activate or pause a flow from Loom
13. **No share / owner / run-only-user** — share grid not surfaced
14. **No solutions membership** — can't show which solution contains the flow
15. **No export / import** — can't download `.zip` package, can't import an exported flow
16. **No Copilot natural-language authoring** — no "describe what you want" → flow generation
17. **No Logic Apps Standard hand-off** — for sovereign / disconnected deployments, no path to materialize the same WDL as a Logic Apps Standard workflow (this is the Loom escape hatch from earlier Fabric specs and should be reusable here)
18. **No 28-day analytics chart** — daily success / failure aggregation chart not rendered
19. **No "save / version" history** — can't restore a previous flow version

## Backend mapping

Live Flow admin REST is the canonical path (Loom has list / get / run / runs working):
- **List flows** — `GET https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/scopes/admin/environments/{envId}/flows?api-version=2016-11-01`
- **Get flow** — `GET .../flows/{name}` (admin scope returns metadata; `definition` lives in the per-owner scope `https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/{envId}/flows/{name}?$expand=definition`)
- **Create flow** — `POST https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/{envId}/flows` with body `{ properties: { displayName, definition: { $schema, contentVersion, triggers, actions, parameters, outputs }, connectionReferences } }`
- **Update flow** — `PATCH .../flows/{name}` with new `definition`
- **Delete flow** — `DELETE .../flows/{name}`
- **Turn on / off** — `POST .../flows/{name}/start` and `.../flows/{name}/stop`
- **Run flow (manual)** — `POST .../flows/{name}/triggers/manual/run?api-version=2016-11-01` with input body
- **List runs** — `GET .../flows/{name}/runs?$top=50`
- **Get run + actions** — `GET .../flows/{name}/runs/{runId}?$expand=actions` returns per-action input/output/error
- **Resubmit / Cancel run** — `POST .../flows/{name}/runs/{runId}/resubmit` / `.../cancel`
- **Share** — `POST .../flows/{name}/modifyPermissions`
- **Solutions membership** — Dataverse `workflows` table query
- **Logic Apps Standard equivalent** — Microsoft.Web/sites kind `workflowapp` + `workflow.json` (same WDL schema) — Loom can target this in sovereign envs
- **Designer surface** — `make.powerautomate.com/manage/environments/{envId}/flows/{name}/details` (deep-link out for full authoring)

## Required Azure resources / tenant settings

- UAMI SP added to `Service principals can use Power Platform APIs` allow group
- Per-user Power Automate license (per-user OR per-flow) to own a flow; SP can manage but not own
- Premium connectors require premium license per user
- HTTP / Custom connectors live in the env
- For Dataverse triggers: MSAL Web App SP as Application User on the env with at least `Read` privilege on every triggering table
- For sovereign / Logic Apps Standard hand-off path: Azure subscription + `Microsoft.Web` resource provider, App Service Plan, storage account (Logic Apps Standard state)

## Estimated effort

4 sessions. Turn on / off + delete + share + per-run drilldown (action input/output/error) + Resubmit / Cancel is ~1 session (all REST already-accessible). Connection-references panel + solutions membership + 28-day analytics chart is ~0.5 session. Definition viewer (read-only WDL JSON pretty-print) + trigger-conditions form + retry / timeout / concurrency settings is ~1 session. Full designer authoring (trigger picker + connector catalog + action card per parameter + dynamic-content picker + expression editor + Condition/Switch/Apply-to-each rendering) is **not feasible** in Loom — recommend deep-link out to `make.powerautomate.com/.../flows/{name}` for authoring and focus Loom on operations + governance. Logic Apps Standard hand-off (export WDL, generate `host.json` + `workflow.json`, bicep up a Standard app) is a separate ~1.5-session track.
