# Copilot Studio family — audit H1–H4 remediation

**Branch:** `fix-copilot-studio-family`
**Scope:** `apps/fiab-console` — the Copilot Studio / Power Platform agent family,
the single biggest liability in the June 2026 CSA Loom E2E audit
(`docs/fiab/audit/full-e2e-audit-2026-06.md` §2 H1–H4, §4 vaporware register).

Each fix makes the surface either **real** or **honest** per
`.claude/rules/no-vaporware.md` and `.claude/rules/no-fabric-dependency.md`.
The sin being removed is faking success/data; a precise gate naming what to
provision is the correct outcome where the backend genuinely can't be reached.

## H1 — invented Dataverse schema no longer masquerades as the enablement gate

**Before:** the `rawCall` 404 handler matched only
`msdyn_copilots | msdyn_knowledgesources | msdyn_botcomponents` and mapped them
to a benign "enable Copilot Studio" 503. Channels target `msdyn_botchannels`,
Actions target `msdyn_bot_actions`, and the Agent writes
`msdyn_instructions` / `msdyn_modeldeployment` scalar columns on `msdyn_copilots`
— all likely-nonexistent on a live tenant, so a genuine 404/400 was mis-classified
as the enablement gate, **hiding the bug**.

**After (honest):** the handler now classifies three cases distinctly
(`lib/azure/copilot-studio-client.ts`, `rawCall`):
- A missing **core enablement entity** (`msdyn_copilots`/`msdyn_knowledgesources`/
  `msdyn_botcomponents`) → friendly 503 "enable Copilot Studio" (unchanged, correct).
- A missing **other entity set** (e.g. `msdyn_botchannels`, `msdyn_bot_actions`)
  → honest 502 naming the entity set and pointing at the live-tenant metadata
  query (`EntityDefinitions?$select=LogicalName,EntitySetName`), noting channel
  state lives in Azure Bot Service and actions are modelled by
  `msdyn_plugin`/`msdyn_pluginaction` on current tenants.
- A missing **column** (`Could not find a property named` / `undeclared property`,
  e.g. `msdyn_instructions`) → honest error naming the column.

Live-tenant verification of every `msdyn_*` entity/column **still required** —
the client now tells the truth on failure, but confirming the schema against a
provisioned Dataverse is the outstanding live-estate work.

## H2 — publish-to-channel honest-gates instead of faking success

**Before:** `publishToChannel()` for all 6 channel types inserted an
`msdyn_botchannels` Dataverse row and reported "Published" — but a row does not
reach the destination. Real enablement needs Azure Bot Service channel
registration (Teams / Direct Line / Web Chat) and third-party OAuth
registration (Slack / Facebook).

**After (honest-gate):** `publishToChannel()` returns a `501` with a precise
per-channel remediation (`channelEnablementGate`) naming exactly what to
configure on the Azure Bot resource (`Microsoft.BotService/botServices`,
Direct Line site secret → `LOOM_COPILOT_DIRECTLINE_SECRET`, Slack app
creds/signing secret, Facebook Page token/App secret/verify token). No Dataverse
insert is attempted for gated channels. The combined Teams + Microsoft 365
Copilot channel (`msteams`) used by the data-agent publish orchestration still
writes the row (its downstream M365 admin approval is itself surfaced). The
editor (`ChannelsPanel`) renders the 501 as a per-channel warning, not a generic
error.

## H3 — analytics no longer fabricates zeros

**Before:** `getAnalytics()` swallowed **404 AND 204** into an all-zeros KPI
object, so tiles rendered plausible "0 sessions / — CSAT" telemetry from a
backend that may not exist.

**After (honest):** `getAnalytics()` returns `{ available: false, gateReason }`
on 404/204 **and** on an empty 200 (pipeline present, no data). The gate names
the real backend: Dataverse `msdyn_botsession`/`msdyn_conversationtranscript`
projected with Application Insights. Only a genuine non-empty response yields
`available: true` with measured values. `CopilotAnalyticsEditor` renders an
honest "Analytics backend not available" warning instead of zero KPI tiles.

## H4 — structured topic editor replaces the raw YAML textarea

**Before:** the topic flow was a Monaco **plaintext** AdaptiveDialog-YAML blob
(`language="plaintext"`) — a `ui-parity` miss and a brush against
`loom_no_freeform_config`.

**After (real):** a structured topic canvas
(`lib/editors/copilot-topic-canvas.tsx`) is now the default: Trigger phrases +
an ordered step list of **Message / Question / Condition / Action** nodes, each
with a typed Fluent v9 form, move up/down, and add/delete. It serializes to and
parses from the AdaptiveDialog YAML via `lib/copilot-studio/topic-model.ts`
(hand-rolled, no new npm dep — matching the repo's `dbt-codegen` precedent). A
"Code view" toggle still exposes the raw YAML, and any AdaptiveDialog construct
the structured model can't represent is preserved verbatim as a read-only
"Advanced (YAML)" node so round-tripping is lossless.

## Files

- `apps/fiab-console/lib/azure/copilot-studio-client.ts` — H1 handler, H2 gate, H3 analytics.
- `apps/fiab-console/lib/copilot-studio/topic-model.ts` — H4 parse/serialize (new).
- `apps/fiab-console/lib/editors/copilot-topic-canvas.tsx` — H4 structured editor (new).
- `apps/fiab-console/lib/editors/copilot-studio-editors.tsx` — H2 channel UI, H3 analytics UI, H4 wiring.
- `apps/fiab-console/lib/azure/__tests__/copilot-studio-honest-errors.test.ts` — H1/H2/H3 tests (new).
- `apps/fiab-console/lib/copilot-studio/__tests__/topic-model.test.ts` — H4 round-trip tests (new).
- Specs updated: `copilot-studio-agent/analytics/channel/topic-parity-spec.md`.

## Verification

- `npx vitest run` (the 4 copilot-studio suites): **22 passed** — including
  new tests that the 404 handler no longer masks a non-enablement schema error,
  that channels honest-gate, and that `getAnalytics` does not coerce to zeros.
- `npx tsc --noEmit`: **0 new errors in touched files.** (The repo's tsc emits
  ~1295 pre-existing Griffel "number not assignable" style false-positives and a
  pre-existing `<Option>` children typing error in `EnvironmentPicker`; none are
  introduced by this change and the Next/SWC build does not enforce them.)

## Outstanding (needs a live Dataverse / Copilot Studio estate)

- Confirm which `msdyn_*` entities/columns actually exist on a provisioned tenant
  (H1) — the client now surfaces the truth, but the real schema must be verified
  and, where columns are confirmed absent, the agent write payload migrated
  (e.g. to `msdyn_plugin`/`msdyn_pluginaction` for actions).
- Drive the Azure Bot Service channel registrations end-to-end (H2) once a Bot
  resource + `LOOM_BOTSERVICE_RESOURCE_ID` are available.
- Provision the Dataverse session/transcript + App Insights analytics pipeline
  (H3) to turn the gate into live KPIs.
