# On-call — unified alerting, escalation, and ack (O1)

**Scope:** every programmatic CSA Loom alert. One convention, one action
group, three severity bands. Code side: `apps/fiab-console/lib/azure/
alert-dispatch.ts` (`dispatchAlert`). Infra side:
`platform/fiab/bicep/modules/admin-plane/monitoring-default-alerts.bicep`
(`loom-default-alerts` action group + the default LogAlert rules).
This runbook is the HUMAN side of that contract: who is notified, on which
channel, how to escalate, and what "ack" means.

## 1. The one alerting path

```
emitter (S1 secret-expiry Function · V1 synthetic monitor · default LogAlert
rules · later DR4 / C3 cost anomaly / SLO1 burn-rate)
   │  dispatchAlert({source, severity: P1|P2|P3, title, body, dedupKey})
   ▼
loom-default-alerts action group  (ARM id in LOOM_ALERT_ACTION_GROUP_ID —
derived by bicep on every push-button deploy; never hand-set)
   ├─ email receiver         (alertEmail param, when supplied)
   ├─ ARM-role receiver      (every subscription Owner — the admin group)
   └─ oncall-webhook         (OPTIONAL — Teams workflow / PagerDuty / bridge;
                              wired per §5, P1/P2 only)
   plus, per alert:
   ├─ direct webhook POST    (loom-alert/v1 JSON with the alert's own
   │                          title/body/dedupKey — P1/P2 only)
   └─ dedup GitHub issue     (durable text channel; open-issue-else-comment
                              on the dedupKey title)
```

No per-item action groups. No parallel Logic App channels. A new alert
consumer that cannot call the TS module (bash workflows, Functions in other
packages) mirrors the same convention against the same group — see
`.github/workflows/loom-synthetic-monitor.yml` (V1) and
`azure-functions/secret-expiry-monitor` (S1) for the two reference refits.

**Channel honesty:** on a day-one push-button deploy the receivers that exist
are **email (when `alertEmail` was supplied) + subscription-Owner ARM-role**.
The webhook page channel exists ONLY after §5 is done. Nothing in this
runbook or any acceptance text may claim a channel that is not wired.

## 2. Severity bands — who is notified, how fast

| Band | Meaning | Channels | Response expectation |
|------|---------|----------|----------------------|
| **P1 — page** | User-facing outage: sign-in down (the 2026-07-19 AADSTS7000215 class), synthetic journeys failing, console heartbeat absent, expired/`<7d` credential | ALL receivers: email + Owner ARM-role + on-call webhook (when wired) + direct webhook POST + dedup issue | Acknowledge **within 1 hour** during business hours, next morning otherwise (no 24×7 rotation is staffed today — §6) |
| **P2 — urgent** | Degraded but up: elevated 5xx, replica crash-loop, credential `<30d`, DR-drill failure | Same channel set as P1 | Acknowledge **same business day** |
| **P3 — email** | Informational / trending: credential `<60d`, cost trending over budget, eval-floor drift | Email + Owner ARM-role ONLY — `dispatchAlert` drops webhook/Logic App receivers so P3 never pages | Review **within the week** (triage queue) |

ARM `severity` ↔ P-band on scheduledQueryRules: 0–1 → P1, 2 → P2, 3–4 → P3.
Every default rule carries its band as the `loom-severity` tag
(`monitoring-default-alerts.bicep`); new rules MUST tag one of the three.

## 3. Who is paged

1. **Primary: the deployment admin group** — every subscription **Owner**
   receives every P1/P2/P3 via the ARM-role receiver. On the Loom estates the
   Owner set IS the platform admin group (`adminEntraGroupId`).
2. **`alertEmail`** (when the deploy supplied one) — a single ops mailbox.
3. **On-call webhook** (when §5 is wired) — the paging bridge (Teams channel
   workflow or PagerDuty service). Whoever holds that rotation owns first
   response for P1/P2.

There is intentionally NO person-name list in this file — membership is the
Entra admin group, managed in Entra, so the page list can never drift from
reality in a doc.

## 4. Acknowledge + triage (what "ack" means)

1. **Ack = comment on the dedup GitHub issue** the alert opened/updated
   (`[P1] <dedupKey>` title convention) stating you own it. If no issue
   exists (pure-email alert), reply-all on the alert email.
2. Triage from the alert's own links:
   - Synthetic journeys → `/admin/health` Journeys tab +
     `docs/fiab/runbooks/synthetic-journeys.md`.
   - Secret expiry/drift → `/admin/health` Secret & credential health +
     `docs/fiab/runbooks/secret-rotation.md` (rotate BEFORE expiry; long-term:
     `msal-credential-strategy.md` FIC migration).
   - Console availability / 5xx / crash-loop → `/monitor` Alerts + Log
     Analytics `ContainerAppConsoleLogs_CL` / `ContainerAppSystemLogs_CL`;
     rollback via the `bicep-rollback` DR scenario
     (`docs/runbooks/dr-drill.md`).
3. **Resolve = the emitter goes green** (the V1 workflow auto-closes its
   issues on the next green run; S1 re-arms on de-escalation). Never
   hand-close a dedup issue while the signal is still red.
4. **Escalate** when: a P1 is unacked past its window, or triage implicates
   sign-in / data loss → open a repo issue tagged `csa-loom` + `incident`,
   page the admin group directly (Teams/phone — out-of-band), and follow
   `docs/DR.md` if DR applies.

## 5. Wiring the on-call webhook (one-time, optional — the ONLY setup step)

Day-one alerting works with zero setup (email + Owner receivers). To add a
page channel:

1. Create the incoming webhook: a **Teams workflow** ("Post to a channel when
   a webhook request is received") or a **PagerDuty Events API v2** endpoint,
   or any bridge URL. Gov: the Teams workflow must live in the `.us` tenant.
2. Store it in the Loom Key Vault (the URL embeds a bearer token — treat it
   as a secret, never a params-file literal):

   ```bash
   az keyvault secret set --vault-name <kv-loom-…> \
     --name loom-alert-webhook-url --value 'https://…'
   ```

3. Opt in on the next deploy — the admin-plane `observabilityConfig` bag
   (never a new top-level param):

   ```bicep
   observabilityConfig: { alertWebhookEnabled: true }
   // optional: alertWebhookSecretName: '<non-default-secret-name>'
   ```

   The Console then reads `LOOM_ALERT_WEBHOOK_URL` via Key Vault secretRef and
   `dispatchAlert` pages it on every P1/P2 (mirrored into the action-group
   notification AND POSTed the full `loom-alert/v1` payload).
4. *(Optional)* Persist the receiver ON the action group so the default
   LogAlert rules page it too — either once in the `/monitor` Alerts editor
   (add a webhook receiver named `oncall-webhook` to `loom-default-alerts`),
   or pass the module's secure param from a `.bicepparam`:
   `alertWebhookUrl: az.getSecret(<sub>, <rg>, <kv>, 'loom-alert-webhook-url')`.
5. Verify (receipt): `/monitor` → Alerts → action group `loom-default-alerts`
   → **Test**, or force a P1 (point `SYNTHETIC_LOGIN_SECRET` at a stale
   secret in a scratch run — the V1 acceptance drill) and confirm webhook
   delivery + email.

## 6. Per-cloud

- **Commercial:** as above.
- **Gov (GCC-High):** identical convention; the action group + LAW live in
  the `.us` estate, `dispatchAlert` targets ARM `management.usgovcloudapi.net`
  automatically (cloud-endpoints), and the `gov-console-roll.yml` /
  gov synthetic lane mirror the same P1 convention. Webhook target must be
  reachable from the Gov boundary (a `.us`-tenant Teams workflow).
- **IL5 / air-gapped (design):** **in-tenant sinks only** — do NOT set
  `LOOM_ALERT_WEBHOOK_URL` to an external bridge. Alerting stays on the
  in-boundary action group (email via in-boundary relay + ARM-role); GitHub
  dedup is replaced by the in-boundary store per the V1 IL5 note.
- **24×7:** no formal 24×7 rotation is staffed today; the response
  expectations in §2 say so honestly. When one exists, this file (and only
  this file) changes.

## 7. Cost

~$0/mo — the action group, receivers, and tags are free; email/webhook
notifications carry no meaningful charge at Loom alert volumes.
