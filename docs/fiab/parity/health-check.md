# health-check — parity with health/observability check (Foundry Health Checks / Azure Monitor)

Source UI:
- Palantir Foundry Health Checks / Data Health — https://www.palantir.com/docs/foundry/health-checks/overview, https://www.palantir.com/docs/foundry/health-checks/checks-reference, https://www.palantir.com/docs/foundry/observability/data-health, https://www.palantir.com/docs/foundry/monitoring-views/overview, https://www.palantir.com/docs/foundry/health-checks/notifications
- Azure Monitor log-search alert rule editor — https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule, https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#log-alerts, https://learn.microsoft.com/azure/azure-monitor/alerts/action-groups

Azure-native default backend (no Microsoft Fabric / no Reflex on the default path,
per `.claude/rules/no-fabric-dependency.md`): **Azure Monitor `scheduledQueryRules`**
over Log Analytics / ADX, **action groups** (email/SMS/webhook/Logic App) for
notification, **alert history** (`Alerts` / `alertsmanagement`) for run/fired
history, and **`listResourceHealth` / `fetchMetrics`** for the status dashboard.
Fabric Reflex remains opt-in only via `LOOM_ACTIVATOR_BACKEND=fabric`.

**Last verified: 2026-07-01 against current code**
(`apps/fiab-console/lib/editors/palantir-editors.tsx` health-check editor +
`app/api/items/health-check/[id]/{rule,rule/[ruleId],run,history}`). The editor
is now a **4-tab shell** (Checks · Status · History · Settings — no Notifications
tab yet); the status dashboard (G), fired-alert history (H), and per-rule
lifecycle (K) have shipped and flip ❌→✅ below.

---

## Real feature inventory

### A. Check definition library (Foundry checks-reference — ~30 check types in 5 families)
1. **Status checks** — Schedule status, Build status, Job status, Sync status (each: Severity, Escalate, Notes, Issues toggle; Sync adds a destination).
2. **Time checks** — Data freshness (column + freshness range), Sync freshness, Build duration, Sync duration, Time since last updated (+ ignore-empty-transactions, custom schedule), Time since sync last updated. All support **Median deviation** (MAD → approx σ over N recent builds).
3. **Size checks** — Dataset file count, Dataset partition (auto logic), Row count (operators Between/≥/≤/=, compare-to-last-successful mode), Transaction file count, Transaction file size.
4. **Content checks** — Allowed column values, Approximate unique %, Column regex, Approximate column relation, Date range, Null %, Numeric mean, Numeric median, Numeric range, Primary key.
5. **Schema checks** — Column (present + type), Column count, Schema (EXACT_MATCH_ORDERED / _UNORDERED / COLUMN_ADDITIONS_ALLOWED / _STRICT).
Each check exposes: **Severity** (Moderate / Critical), **Escalate** toggle, **Notes**, **Issues** (auto-create-issue-on-fail) toggle, optional **Median deviation** and **Schedule** (Automatic / Custom).

### B. Target / scope picker
- Foundry checks bind to a **dataset / pipeline / schedule / job / sync destination**.
- Azure Monitor binds a rule to a **target resource scope** (single resource, Log Analytics workspace, resource group, or subscription) + a **table / KQL query**, plus **Split by alert dimensions**.

### C. Alert logic / threshold editor (Azure Monitor)
- Measurement (table/result count vs metric measurement), **Operator** (>, <, between, dynamic upper/lower), **Static or Dynamic threshold** (+ sensitivity High/Med/Low), **Aggregation granularity / Period (window)**, **Frequency of evaluation** (1 min – 24 h), **number of breaches / consecutive breaches**, KQL preview with sample data.

### D. Schedule
- Evaluation frequency + look-back window; Foundry "Automatic vs Custom Schedule"; Azure "Enable upon creation", **stateful / auto-resolve** alerts.

### E. Severity & escalation
- Azure severity 0–4; Foundry Moderate/Critical + Escalate. Warning→Critical escalation ladder.

### F. Actions / notifications (action groups)
- Email, SMS, Voice, Push, Webhook, Logic App, Azure Function, ITSM; Foundry adds Slack / PagerDuty / email + in-platform watcher notifications. **Custom email subject**, **custom webhook JSON payload**, **test notification**.

### G. Run / status dashboard
- Foundry Data Health app: per-dataset health status (green/yellow/red), Data-Lineage coloring, **historical health timeline**, filter/sort by status. Azure: **Alerts** blade — fired/resolved counts by severity, alert timeline.

### H. Run history / fired-alert log
- Per-check history of pass/fail evaluations; Azure fired-alert history (fired time, resolved time, severity, fired value).

### I. Issues / incident management
- Auto-create + auto-close **Issues** on fail/recover; integrate to external incident systems; watcher assignment & severity.

### J. Monitoring Views (scale)
- Collections of checks/rules that auto-apply to resources matching a scope as new resources are added (recommended over ad-hoc check groups).

### K. Per-rule lifecycle actions
- Enable / disable, edit, delete, **test-fire / trigger**, view in portal, duplicate.

### L. Remediation
- Suggested fix on breach; link to runbook / Logic App auto-remediation; re-run pipeline.

---

## Loom coverage (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Capability | Status | Backend today |
|---|---|---|---|
| A | Check-type library (5 families, ~30 types) | ❌ — only `freshness` / `rowcount` / `custom KQL` | `buildQuery()` in `[id]/rule/route.ts` |
| B | Target / scope picker | ❌ — free-text "Table" input only | none |
| C | Threshold/operator + dynamic threshold + preview | ⚠️ — static threshold value inputs built (`thresholdMinutes`/`minRows`); operator hard-coded, no dynamic threshold, no KQL preview | `ScheduledQueryRuleInput` |
| D | Schedule (freq + window) | ✅ — `evalFreq` + `windowSize` dropdowns | `createMonitorActivatorRule({evaluationFrequency, windowSize})` |
| E | Severity & escalation | ⚠️ — severity `Dropdown` (0–4) wired + rendered as badge; **escalation chains missing** | `createMonitorActivatorRule({severity})` |
| F | Action groups / channels + test-fire | ❌ — single email input only; `upsertActionGroup`/`sendActionGroupTestNotification` exist but UI never calls them | (clients unused) |
| G | Status dashboard | ✅ — Status tab, 4 stat tiles (Total/Healthy/Firing/Disabled) from rule state + fired alerts | `getActivatorHistory` + `listScheduledQueryRules` |
| H | Run / fired-alert history | ✅ — History tab `Table` of fired/resolved events (time, severity, state) | `getActivatorHistory` (`[id]/history`) |
| I | Issues / incident management | ❌ | none |
| J | Monitoring Views (scoped groups) | ❌ | `listScheduledQueryRules` exists |
| K | Per-rule enable/disable/delete/test | ✅ — row Run/Enable/Disable/Delete buttons wired | `triggerMonitorActivatorRule` (`[id]/run`) + `enable`/`disable`/`deleteMonitorActivatorRule` (`[id]/rule/[ruleId]`) |
| L | Remediation | ❌ | Logic App receiver in action groups |

Current grade: **C (functional but incomplete)** — a real 4-tab shell with an
end-to-end check lifecycle (create rule, per-rule Run/Enable/Disable/Delete, a
derived status dashboard, and fired-alert history), all wired to real Azure
Monitor `scheduledQueryRules`. The "ignored clients" critique is now accurate
only for **action groups** (`upsertActionGroup` / `sendActionGroupTestNotification`),
`listResourceHealth`, and `fetchMetrics`. Still missing: the Foundry check-type
library, scope picker, operator/dynamic-threshold/KQL-preview, action-group
channel management + test-fire, a Notifications tab, and incident /
Monitoring-Views / remediation.

---

## Build plan (prioritized)

### P0 — make it a real monitor, not a form
1. **Tabbed editor shell** (`ItemEditorChrome` + Fluent `TabList`): **Checks · Status · History · Notifications · Settings**. Replaces the single scroll form.
2. **Status dashboard tab** — `TileGrid` of stat tiles (Healthy / Warning / Critical / Disabled counts) from `listAlertHistory` + per-rule current state; severity-colored `Badge`s; `EmptyState` when no checks. Backend: `listAlertHistory` + `listScheduledQueryRules`.
3. **Per-rule lifecycle actions** — row `Menu` (Enable, Disable, Delete, Test-fire, Open in portal) wired to `patchScheduledQueryRule` / `deleteScheduledQueryRule` / `triggerMonitorActivatorRule`. New routes `PATCH`/`DELETE` on `/api/items/health-check/[id]/rule/[ruleId]`.
4. **Run / fired-alert history tab** — `DataGrid` of fired/resolved events (time, severity, fired value, state) from `getActivatorHistory` / `listAlertHistory`.

### P1 — check library + notifications + severity
5. **Check-type gallery** — `TileGrid` of check categories (Status / Time / Size / Content / Schema) each opening a typed wizard `Dialog`; build at least Time (freshness, time-since-updated, build/sync duration) + Size (row count, file count) + Content (null %, regex, allowed values, numeric range) against KQL templates. Extend `buildQuery()` per type.
6. **Severity + escalation controls** — `Dropdown` severity 0–4 (Moderate/Critical mapped), Escalate `Switch`, Notes `Textarea`, "auto-resolve / stateful" `Switch`. Wire `severity` + `autoMitigate` into `ScheduledQueryRuleInput`.
7. **Notifications tab (action groups)** — manage channels: Email / SMS / Webhook / Logic App rows via `ActionGroupInput`; **Test** button → `sendActionGroupTestNotification`; custom email subject. Backend: `upsertActionGroup` / `listActionGroups`.
8. **Threshold/operator editor** — operator `Dropdown` (>, <, between, =), static/dynamic threshold toggle + sensitivity, **KQL preview** running the built query via `queryLogs` against the look-back window.

### P2 — scale + remediation + issues
9. **Monitoring Views** — scope-based group (resource-type / tag filter) that bulk-creates rules; persisted on `state.views`; list + apply.
10. **Issues / incident panel** — auto-open an audit-log incident on fail; show open/closed issues; assign watcher. Backend: existing audit-log + Cosmos `state.issues`.
11. **Remediation** — per-check optional Logic App receiver as auto-remediation; "Re-run pipeline" link to the bound data-pipeline item.
12. **Target/scope picker** — `Dropdown` of Loom items / Log Analytics tables / ADX clusters as the rule scope, replacing the free-text Table input.

Per `web3-ui.md` / `loom_design_standards`: all surfaces use Loom tokens,
`TileGrid` for the gallery & status tiles, `EmptyState` for empty panes, Fluent
icons per section, elevated cards, severity `Badge`s — no freeform config beyond
the KQL expression box (allowed, 1:1 with Azure's query editor).
