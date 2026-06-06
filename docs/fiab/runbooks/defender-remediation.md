# Monitor → Security — Defender for Cloud remediation

The **Monitor → Security** tab lists live Microsoft Defender for Cloud
recommendations (secure score, action-required items, alerts). Every unhealthy
recommendation — **at any severity** — has a **Remediate** button that opens a
drawer with three resolution paths:

1. **Portal steps** — ordered, copy-friendly steps derived from the assessment's
   `remediationDescription`, plus a deep link to the recommendation in the
   Defender portal.
2. **PowerShell** — a real, copy-runnable Az PowerShell script: `Connect-AzAccount`
   → `Set-AzContext` → `Get-AzSecurityAssessment` to inspect, then either
   `Start-AzPolicyRemediation` (policy-backed recommendations) or the
   resource-specific fix hint.
3. **Fix via Loom** — for **policy-backed** recommendations, one click starts a
   **real Azure Policy remediation task** (`Microsoft.PolicyInsights/remediations`)
   scoped to the affected resource: Loom resolves the policy assignment behind
   the assessment and PUTs the remediation with `ReEvaluateCompliance`.
   Recommendations with no auto-remediation policy honestly say so and point at
   the Portal/PowerShell paths (no fake fix, per `no-vaporware.md`).

## Backend

- `lib/azure/defender-client.ts` — `getDefenderSummary` (enriched with
  `assessmentName` / `resourceId` / `policyDefinitionId` / `portalLink` /
  effort+impact) and `remediateRecommendation` (the Policy remediation task).
- `lib/azure/defender-remediation.ts` — pure `portalSteps` / `powershellScript` /
  `portalLink` / `canAutoRemediate` generators.
- `app/api/monitor/defender/remediate` — POST → `remediateRecommendation`.

## RBAC (Console UAMI)

| To… | Grant on the subscription |
|---|---|
| Read recommendations / score / alerts | **Security Reader** |
| One-click **Fix via Loom** (create policy remediations) | **Resource Policy Contributor** |

A 401/403 on Fix via Loom surfaces an honest gate naming Resource Policy
Contributor; the Portal steps + PowerShell still fully resolve the item.
