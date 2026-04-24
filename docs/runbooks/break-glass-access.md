[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Break-Glass Access**

# Break-Glass Access Runbook (CSA-0059)


!!! note
    **Quick Summary**: Emergency administrative access procedure for CSA-in-a-Box — when the primary identity / PIM / normal RBAC path is unavailable (locked-out tenant admin, region outage, active security incident requiring overriding PIM). Covers activation preconditions, the two-person control requirement, PIM / Privileged Access activation, audit trail, deactivation, and mandatory post-incident review.

!!! danger
    **This is not a regular administrative tool.** Break-glass accounts
    exist so that a genuine emergency does not become a platform outage.
    Every activation produces audit evidence reviewable by Security
    within one business day. Unauthorized or unnecessary use is a policy
    violation regardless of intent.

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#-contact-information) table.
- [ ] Create two named break-glass accounts per tenant (A + B — never one).
- [ ] Physically store the break-glass credentials in a sealed
      envelope in a locked safe (or equivalent organization procedure).
      Digital-only storage is forbidden.
- [ ] Confirm the two-person control requirement with your CISO — in
      some organizations this is three-person.
- [ ] Wire the [alerting KQL](#-7-audit--detection-kql) queries into a
      Sentinel analytic rule that pages Security in real time.
- [ ] Confirm the break-glass accounts are exempt from Conditional Access
      policies that could themselves lock them out (e.g. MFA during outage).

## 📑 Table of Contents

- [📋 1. Scope](#-1-scope)
- [🚨 2. Activation Preconditions](#-2-activation-preconditions)
- [👥 3. Two-Person Control](#-3-two-person-control)
- [🚀 4. Activation Steps](#-4-activation-steps)
- [🛡️ 5. Safe Operations While Active](#️-5-safe-operations-while-active)
- [🔚 6. Deactivation Steps](#-6-deactivation-steps)
- [🕵️ 7. Audit & Detection KQL](#️-7-audit--detection-kql)
- [📋 8. Mandatory Post-Incident Review](#-8-mandatory-post-incident-review)
- [📎 9. Contact Information](#-9-contact-information)
- [🗓️ 10. Drill Log](#️-10-drill-log)
- [🔗 11. Related Documentation](#-11-related-documentation)

---

## 📋 1. Scope

Covers activation of the per-tenant break-glass accounts (typically
`breakglass-a@<tenant>.onmicrosoft.com` and
`breakglass-b@<tenant>.onmicrosoft.com`) for emergency administrative
operations on the CSA-in-a-Box control plane. Applies when:

- The normal tenant admin is unavailable (incapacitated, locked out, offline).
- PIM / Privileged Access is degraded (outage, policy corruption).
- A security incident (P1) requires overriding existing RBAC.
- A DR event (§[`dr-drill.md`](./dr-drill.md)) requires credentials the on-call rotation does not hold.

Out of scope: routine privileged operations (use PIM / just-in-time
elevation instead), "I forgot to ask PIM" (file a ticket and wait).

---

## 🚨 2. Activation Preconditions

All of the following must be true before any operator opens the
break-glass envelope:

- [ ] A P1 incident is declared in the ticket system (or a DR drill
      tabletop is in progress, documented in §10).
- [ ] The normal PIM path has been attempted and is unavailable
      — screenshot or audit-log entry proves this.
- [ ] Two people (§3) are on the call / in the room.
- [ ] The activation is timeboxed — state the expected duration up front.
      Default hard cap: 4 hours. Extend only with explicit Security approval.
- [ ] Incident command has named an Incident Commander separate from the
      two break-glass operators.

If any precondition is missing: **do not** open the envelope. Escalate
to the CISO.

---

## 👥 3. Two-Person Control

Activation **requires two people**:

1. **Operator** — executes commands at the keyboard.
2. **Witness** — reads along, records every command + output into the
   incident ticket. The witness is not a passive observer; they have
   authority to pause the operator.

The two people must be **separate individuals with separate Entra ID
identities**. A single person with two accounts does not satisfy
two-person control.

The witness logs a timeline entry for every action:

```text
<time UTC> <operator> <action> <result>
```

---

## 🚀 4. Activation Steps

1. **Retrieve the envelope.** Break the seal in front of the witness.
   Record the envelope ID and the pre-break condition in the ticket.
2. **Sign in** at `https://portal.azure.com` (or `.us` for Gov) using
   the break-glass A account (B is the reserve — do not activate both
   unless A is also unavailable).
3. **Confirm the account is still a Global Administrator** (the
   baseline assignment; break-glass accounts have permanent GA):
   ```bash
   az rest --method get --url "https://graph.microsoft.com/v1.0/me/memberOf"
   ```
4. **Perform the timeboxed remediation.** Stay scoped — break-glass is
   not a blanket license. Every command must be in §5's safe-ops list
   or explicitly approved by the Incident Commander.
5. **Capture evidence** at each step (screenshot, Resource Explorer
   JSON, activity-log export).
6. **Hand off to the witness** before deactivating. The witness verifies
   the incident ticket contains a complete command log, then the
   operator proceeds to §6.

---

## 🛡️ 5. Safe Operations While Active

Use break-glass only for:

- [ ] Restoring access (unlock a locked-out tenant admin, re-enable a
      disabled PIM-eligible role).
- [ ] Rotating compromised credentials (see [`key-rotation.md`](./key-rotation.md) §5).
- [ ] Approving a time-critical RBAC change required to contain an
      incident (security group addition; NEVER direct role assignments
      to human users).
- [ ] Performing DR failover steps requiring Subscription Owner scope
      (see [`dr-drill.md`](./dr-drill.md)).
- [ ] Creating or restoring `governance/contracts/` files as needed
      to re-establish the normal RBAC plane.

**Forbidden while active:**

- Creating new resources (unless explicitly required for incident
  containment, and then only with Incident Commander approval).
- Modifying Audit Log retention (a common attacker move and a common
  accidental mistake — do not touch).
- Adjusting Conditional Access policies.
- Anything that would obscure the audit trail.

---

## 🔚 6. Deactivation Steps

!!! important
    Deactivation is not optional. A break-glass account left active is
    a critical finding in every ATO audit.

1. **Sign out** from every browser session.
2. **Rotate the break-glass account's password** via a privileged
   identity *other than* the break-glass account (use the CISO's
   standing admin or the secondary break-glass account with another
   witness):
   ```bash
   # Executed by the CISO or secondary operator, not the one who signed in
   az ad user update --id breakglass-a@<tenant>.onmicrosoft.com \
     --password '<freshly-generated-password>' --force-change-password-next-sign-in false
   ```
3. **Re-seal the envelope** with the rotated password + a new envelope ID.
   Record the new ID in the ticket.
4. **File the envelope** back in the safe.
5. **Notify Security** that break-glass has been deactivated; include
   the start / end times and the final command log.
6. **Open the mandatory post-incident review** ticket (§8).

---

## 🕵️ 7. Audit & Detection KQL

```kql
// Any sign-in by a break-glass account — should alert in real time
SigninLogs
| where TimeGenerated > ago(7d)
| where UserPrincipalName startswith "breakglass-"
| project TimeGenerated, UserPrincipalName, IPAddress, AppDisplayName, ResultType,
          ConditionalAccessStatus, DeviceDetail = tostring(DeviceDetail)
| order by TimeGenerated desc
```

```kql
// Every privileged operation performed by a break-glass account
AuditLogs
| where TimeGenerated > ago(7d)
| where InitiatedBy.user.userPrincipalName startswith "breakglass-"
| project TimeGenerated, ActivityDisplayName, OperationType,
          TargetResources, Result
| order by TimeGenerated desc
```

```kql
// Correlate with AzureActivity for subscription-scope actions
AzureActivity
| where TimeGenerated > ago(7d)
| where Caller startswith "breakglass-"
| project TimeGenerated, OperationNameValue, ResourceGroup, _ResourceId, ActivityStatusValue
| order by TimeGenerated desc
```

!!! tip
    Wire the first query into a Sentinel analytic rule that pages
    Security **on every sign-in**. A break-glass sign-in is always
    noteworthy, even during a declared incident.

---

## 📋 8. Mandatory Post-Incident Review

Every break-glass activation triggers a mandatory review within 5
business days:

- [ ] File a review ticket (template: "Break-Glass Activation PIR"). The
      ticket summary lists: activation time, deactivation time, operator,
      witness, Incident Commander, preconditions met, scope, outcome.
- [ ] Attach the full command log + evidence captured during activation.
- [ ] Attach the KQL query results for the window.
- [ ] Review with CISO or delegate. Record the reviewer's sign-off.
- [ ] If *any* command went beyond §5's safe ops, file a follow-up
      finding. Recurring out-of-scope use is a governance failure, not
      an ops failure.
- [ ] Update this runbook's Drill Log (§10) and the activation-log tracker.
- [ ] If the activation uncovered a gap (e.g., the PIM path that should
      have worked did not), file a gap-closure task.

---

## 📎 9. Contact Information

!!! warning
    **Action Required:** Populate these before first production use.

| Role              | Contact                                       | Phone                        | Escalation                    |
| ----------------- | --------------------------------------------- | ---------------------------- | ----------------------------- |
| CISO              | *(set via your org's CISO)*                   | *(24/7 on-call)*             | Activation approval           |
| Security Officer  | *(set via your org's security team DL)*       | *(24/7 on-call)*             | Witness + post-incident review|
| Platform Team Lead| *(set via your org's platform team)*          | *(see PagerDuty / OpsGenie)* | Operator (preferred)          |
| Incident Commander| *(named per incident)*                        | *(via IC channel)*           | Timebox + scope decisions     |
| Legal Counsel     | *(set via your org's legal team)*             | *(office hours)*             | If incident has legal impact  |
| Azure Support     | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A | Platform-level outages |

---

## 🗓️ 10. Drill Log

Break-glass must be exercised **at least annually** via tabletop to keep
the envelope procedures and two-person control fresh. A real activation
also counts as a drill.

| Quarter   | Date  | Type (tabletop / real activation) | Scenario exercised | Operator | Witness | Gaps identified | Fixes tracked |
| --------- | ----- | --------------------------------- | ------------------ | -------- | ------- | --------------- | ------------- |
| Q1 — Jan  | _TBD_ | _TBD_                             | _TBD_              | _TBD_    | _TBD_   | _TBD_           | _TBD_         |
| Q2 — Apr  | _TBD_ | _TBD_                             | _TBD_              | _TBD_    | _TBD_   | _TBD_           | _TBD_         |
| Q3 — Jul  | _TBD_ | _TBD_                             | _TBD_              | _TBD_    | _TBD_   | _TBD_           | _TBD_         |
| Q4 — Oct  | _TBD_ | _TBD_                             | _TBD_              | _TBD_    | _TBD_   | _TBD_           | _TBD_         |

---

## 🔗 11. Related Documentation

- [Security Incident](./security-incident.md) — Primary incident response
- [Key Rotation](./key-rotation.md) — Emergency rotation after activation
- [Tenant Onboarding](./tenant-onboarding.md) — Creation of tenant break-glass accounts
- [DR Drill](./dr-drill.md) — DR scenarios that may require break-glass
- [Compliance](../COMPLIANCE.md) — Audit requirements for break-glass use
