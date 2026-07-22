# Functional Audit — RTI Hub + Activator (operator-named broken)

Area: `rti-activator`
Date: 2026-06-26
Auditor: CSA Loom functional auditor (code trace, no live click-through)
Operator report: "Real-Time Intelligence Hub + Real-Time hub are UNUSABLE; Activators
deploy but do not work — cannot edit them, cannot start them, cannot enable triggers,
cannot do anything."

## TL;DR — what is actually broken

The Activator **editor and overview pane are real and well-built** (real Azure Monitor
`scheduledQueryRules` + action groups; env + Monitoring-Contributor write grant are
fully bicep-synced). A net-new activator created in the editor, with a rule added via
"New rule", works end-to-end (create rule → PATCH enable/disable → DELETE → trigger →
history all round-trip to ARM).

**The operator's "deploy but do nothing" is a single architectural gap:** when an
activator is **deployed** (catalog / use-case bundle), the provisioner creates the real
ARM alert rules but **never writes the resulting rule records back onto the Cosmos
item's `state.rules`.** Every editor/pane action keys off `state.rules`, so on a
deployed activator that array is empty (or only a read-only bundle projection that has
no `azureRuleName` and no `query`). The result is exactly the reported symptom set:

- **Start / Stop** iterate `state.rules` → "0 trigger(s) updated" → looks dead.
- **Enable / Disable / Delete** look up the rule by `azureRuleName`/id in `state.rules`
  → 404 "rule not found" → "cannot enable triggers."
- **Trigger now** needs `rule.query` from `state.rules` → not found / no query → 404.
- **Edit** — there is no edit-rule path anywhere (create + delete only).

RTI Hub + Real-Time hub data paths are **real** (Azure Resource Graph + Cosmos, honest
503 gates). "Unusable" is almost certainly an **environmental honest-gate** (Console UAMI
lacks cross-subscription Resource Graph reader, or `LOOM_SUBSCRIPTION_ID` scope is narrow),
not vaporware — but the dependency must be surfaced and verified live.

## Stack traced (UI → BFF → backend)

### Activator editor — `ActivatorEditor`
`apps/fiab-console/lib/editors/phase3-editors.tsx:8839` (registered `registry.ts:87`).
Page: `app/activator/page.tsx` (item list) + `app/activator-hub/page.tsx` → `ActivatorPane`.

| Control | UI | BFF route | Backend | Verdict |
|---|---|---|---|---|
| Create reflex | `createReflex` (dialog) phase3:8947 | `POST /api/items/activator` `route.ts:69` | `createOwnedItem` → Cosmos item `state.content.kind='activator'`, `rules:[]` | Works |
| List reflexes | `loadList` phase3:8906 | `GET /api/items/activator` `route.ts:41` → `listBundleActivators` | Cosmos query `state.content.kind==='activator'` | Works |
| New rule (live) | `addRule` phase3:8965 | `POST .../[id]/rules` `rules/route.ts:99` → `createMonitorActivatorRule` | `activator-monitor.ts:167` → `upsertActionGroup` + `upsertScheduledQueryRule` (`monitor-client.ts:1490,1679`); **persists to `state.rules`** `rules/route.ts:157-160` | Works |
| Start / Stop | ribbon phase3:9166-9167 → `startStop` 9109 | `POST .../[id]/start` / `/stop` | start = count of `state.rules` (`start/route.ts:26`); stop = re-PUT each `state.rules` enabled:false (`stop/route.ts:31-39`) | Works **only if `state.rules` populated** |
| Trigger now | per-row btn phase3:9483 → `triggerNow` 9018 | `POST .../[id]/rules?trigger=` `rules/route.ts:130` | `triggerMonitorActivatorRule(rule.query)` → `queryLogs` | Works only for rules in `state.rules` **with a `query`** |
| Run history | tab → `loadHistory` phase3:9030 | `GET .../[id]/history` | `getActivatorHistory` → `listAlertHistory` (`AlertsManagement/alerts`) | Works |
| Action-group test | `testNotification` phase3:9086 | `POST /api/monitor/action-groups` | real receiver fire | Works |
| Enable/disable a rule | **NOT in editor** — only "Trigger" btn in the rules table (phase3:9482-9484) | (route exists: `PATCH .../rules?ruleId=&enabled=` `rules/route.ts:176`) | `enable/disableMonitorRule` → `patchScheduledQueryRule` | **UI missing in editor** |
| Delete a rule | **NOT in editor** | (route exists: `DELETE .../rules?ruleId=` `rules/route.ts:229`) | `deleteScheduledQueryRule` | **UI missing in editor** |
| Edit a rule | **does not exist anywhere** | — | — | **Missing (parity gap)** |

### Activator overview pane — `ActivatorPane`
`apps/fiab-console/lib/panes/activator.tsx` (the `/activator-hub` page).
This pane **does** have working per-rule Enable/Disable (`toggleRule` :280 → PATCH) and
Delete (`deleteRule` :298 → DELETE), rendered as per-row buttons (`ruleColumns` :340-366).
But it lists `GET .../[id]/rules` → only what's in `state.rules`. So for a **deployed**
activator it shows nothing actionable (empty, or the bundle projection whose
`ruleId='loom:<itemId>'` has no `azureRuleName` → PATCH/DELETE 404).

### Provisioner (the root cause)
`apps/fiab-console/lib/install/provisioners/activator.ts` → `provisionAzureMonitor`
(`:97-179`). It creates real `scheduledQueryRules` (`:135`) and returns
`secondaryIds.rulesCreated` (`:175`) — but it **never returns the `MonitorRuleRecord[]`**,
and `ProvisionResult` (`lib/install/provisioners/types.ts`) **has no `state` field** to
carry rule records back. No install code writes the created rules to `state.rules`.
→ Deployed activators land with `state.rules` empty.

### Bundle projection (the secondary defect)
`activatorRuleFromContent` (`app/api/items/_lib/ai-content-fallback.ts:254`) projects
`state.content.rule` into a UI row but omits **`query`** and **`azureRuleName`**, and
hardcodes `state:'Stopped'`. The GET `/rules` Azure-Monitor path returns this as a
fallback (`rules/route.ts:91-92`). Consequence: even when a bundle row renders, Trigger
404s ("no query", `rules/route.ts:132`) and Enable/Disable/Delete 404 ("rule not found",
`rules/route.ts:205,253`).

### RTI Hub — `RtiHubView`
`lib/components/realtime-hub/rti-hub-view.tsx`; page `app/rti-hub/page.tsx`;
`GET /api/rti-hub` (`app/api/rti-hub/route.ts`) → `listStreamingResourcesViaGraph`
(Azure Resource Graph: Event Hub ns / IoT Hub / ADX) merged with Cosmos Loom items.
Honest 503/`not_configured` gate handled in `load()` (:159-168). `subscribe` (:184),
`makeActivator` (:204), `deleteEventstream` (:248) are real handlers hitting real routes.
**Real backend; B-grade.** "Unusable" ⇒ verify Console UAMI Resource Graph reader +
`LOOM_SUBSCRIPTION_ID` scope live.

### Real-Time hub — `RealTimeHubView`
`lib/components/realtime-hub/realtime-hub-view.tsx`; page `app/realtime-hub/page.tsx`;
`GET /api/realtime-hub/streams` (`streams/route.ts`) lists Loom eventstream/kql/eventhouse
items from Cosmos. Connect-source (`connect-source/route.ts`) creates a real Loom
eventstream item (secrets → Key Vault secretRef). Preview/endpoints/provision routes are
all real. **Real backend; B-grade.**

## Findings (graded)

| # | Surface | Grade | Type | Symptom | Root cause (file:line) | Fix | Pri |
|---|---|---|---|---|---|---|---|
| 1 | Deployed Activator (any catalog/use-case install) | D | broken-pipeline | "deploy but do nothing": Start/Stop say 0 updated, Enable/Trigger/Delete 404 | Provisioner creates ARM rules but never persists `MonitorRuleRecord[]` to `state.rules`; `ProvisionResult` has no `state` channel — `lib/install/provisioners/activator.ts:97-179`; `lib/install/provisioners/types.ts` (ProvisionResult) | Have `provisionAzureMonitor` build full `MonitorRuleRecord[]` (incl. `azureRuleName`,`query`,`actionGroupId`,`state:'Active'`) and persist to the item's `state.rules` — either add a `state`/`statePatch` field to `ProvisionResult` that the install pipeline writes onto the Cosmos item, or have the provisioner upsert `state.rules` directly via `itemsContainer()` after creating each rule | P0 |
| 2 | Bundle rule projection | D | stubbed-data | bundle activator shows a rule that can't be triggered/enabled/deleted | `activatorRuleFromContent` omits `query` + `azureRuleName`, hardcodes `state:'Stopped'` — `app/api/items/_lib/ai-content-fallback.ts:254-268` | Include `query` (run `buildRuleQuery` from `activator-monitor.ts`) and a stable `azureRuleName` (`safeRuleName(displayName, ruleSuffix)`) in the projection; once finding #1 persists real records this fallback should rarely fire, but make it self-consistent so Trigger works on it | P1 |
| 3 | Activator **editor** rules table | C | missing-control | from the item editor a user "cannot enable triggers" — only a "Trigger" button per rule; enable/disable/delete live only on the separate `/activator-hub` pane | `phase3-editors.tsx:9466-9486` rules table renders only `triggerNow`; PATCH/DELETE routes exist but are never called from the editor | Add per-row Enable/Disable + Delete buttons to the editor's rules table calling `PATCH/DELETE .../rules?ruleId=` (mirror `lib/panes/activator.tsx:280-314`), so the editor is self-sufficient | P1 |
| 4 | Edit an existing rule | C | parity-gap | cannot modify a rule's threshold/action after creation (Fabric allows edit) | No edit path: editor exposes create (`addRule` :8965) + the pane exposes delete only | Add an "Edit rule" flow that re-opens the rule wizard pre-filled and `PUT`s the updated rule (extend the rules route with an update branch; `createMonitorActivatorRule` already upserts by name so it can serve update) | P2 |
| 5 | Start (Azure-monitor default) | C | weak-feedback | Start returns "N rules active" with no ARM action; on deployed activator N=0 ⇒ reads as broken | `start/route.ts:24-28` returns a count of `state.rules`, no ARM call (rules are created enabled) | Tie to #1 (populate `state.rules`); additionally have Start re-`enable` each backing rule (idempotent PATCH `enabled:true`) so it is a real, observable action, not a count | P2 |
| 6 | RTI Hub catalog (`/rti-hub`) | B | infra-dependency | operator calls it "unusable" — likely empty/gated, not broken | Real Resource Graph + Cosmos; honest 503 gate `rti-hub/route.ts` + `rti-hub-view.tsx:159-168`. Depends on Console UAMI cross-sub Resource Graph reader + `LOOM_SUBSCRIPTION_ID`/`rtiSubscriptionScope` | Verify live: confirm UAMI has Reader at subscription scope for Resource Graph; confirm `LOOM_SUBSCRIPTION_ID`/`LOOM_EXTRA_SUBSCRIPTIONS` set; if the catalog is empty, the gate copy should name the exact missing grant (it largely does — confirm it renders, not a blank tab) | P1 |
| 7 | Real-Time hub (`/realtime-hub`) | B | functional | streams catalog + connect-source real | `streams/route.ts`, `connect-source/route.ts` real; Key Vault secretRef hardening present | None functional; confirm `/api/loom/workspaces` + items list populate live | P2 |

## Verification owed per no-vaporware.md

For a real receipt this audit could not produce (code-only, no live env):
1. Deploy an activator from a use-case bundle with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET;
   open `/activator-hub` → confirm its rules appear and Enable/Disable/Delete round-trip
   (this is exactly what finding #1 currently breaks).
2. In the Activator editor, create a reflex, add a rule, click Trigger → expect real row
   count from Log Analytics; Start/Stop → expect non-zero "trigger(s) updated".
3. Load `/rti-hub` in the live deployment → confirm the catalog is populated (Resource
   Graph) or shows the precise honest gate, not a blank/erroring tab.

## What is NOT broken (verified real in code)

- Azure-native Activator backend is fully bicep-synced: `LOOM_ALERT_RG`,
  `LOOM_LOG_ANALYTICS_RESOURCE_ID`, `LOOM_ACTIVATOR_BACKEND`, `LOOM_ALERT_LOCATION` wired
  in `platform/fiab/bicep/modules/admin-plane/main.bicep:2388,2609,2913`; Console UAMI
  **Monitoring Contributor** write grant in `monitoring.bicep:192-194`.
- `createMonitorActivatorRule`, enable/disable/delete/trigger, action-group + receiver
  (email/SMS/webhook/Logic App) helpers are real ARM calls (`activator-monitor.ts`,
  `monitor-client.ts`).
- RTI/RT hub routes call real Resource Graph / Cosmos / Event Hubs ARM — no mock arrays,
  honest 503 gates with bicep links.
- The parity doc `docs/fiab/parity/activator.md` rows 6a/6b correctly state enable/disable
  + delete live in `lib/panes/activator.tsx` (true) — but it does **not** disclose that
  these only operate on `state.rules`, which deployed activators never populate (finding #1).
