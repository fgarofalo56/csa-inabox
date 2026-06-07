/**
 * Defender for Cloud remediation helpers — pure generators (no server deps) so
 * the Security tab can render, for EVERY recommendation/severity:
 *   1. Portal step-by-step instructions (from the assessment's remediation text)
 *   2. A copy-runnable PowerShell script to fix it
 *
 * The "Fix via Loom" path (real Azure Policy remediation task) lives in
 * defender-client.ts (`remediateRecommendation`).
 */

export interface RemediationInput {
  name: string;
  severity?: string;
  assessmentName?: string;       // assessment definition name (last id segment)
  resourceId?: string;           // affected resource ARM id
  policyDefinitionId?: string;   // when the assessment is policy-backed
  remediation?: string;          // remediationDescription
  portalLink?: string;           // assessment's azurePortal link (if any)
  subscriptionId?: string;
}

/** A portal deep link to the recommendation (its own link if present, else the Defender recommendations blade). */
export function portalLink(rec: RemediationInput): string {
  if (rec.portalLink) return rec.portalLink;
  if (rec.assessmentName) {
    return `https://portal.azure.com/#blade/Microsoft_Azure_Security/RecommendationsBlade/assessmentKey/${encodeURIComponent(rec.assessmentName)}`;
  }
  return 'https://portal.azure.com/#blade/Microsoft_Azure_Security/SecurityMenuBlade/5'; // Recommendations
}

/** Ordered portal steps. Splits the remediation text into actionable lines. */
export function portalSteps(rec: RemediationInput): string[] {
  const steps: string[] = [
    'Open the Microsoft Defender for Cloud → Recommendations blade (link below).',
    `Find “${rec.name}”${rec.severity ? ` (severity: ${rec.severity})` : ''} and select it.`,
  ];
  const text = (rec.remediation || '').trim();
  if (text) {
    // Many remediationDescriptions embed numbered/▶ steps; normalise to lines.
    const lines = text
      .replace(/\r/g, '')
      .split(/\n+|(?:\s*\d+\.\s+)|(?:\s*▶\s*)|(?:\.\s+(?=[A-Z]))/)
      .map((l) => l.trim())
      .filter((l) => l.length > 3);
    for (const l of lines.slice(0, 8)) steps.push(l.replace(/\.$/, '') + '.');
  } else {
    steps.push('Follow the “Remediation steps” shown on the recommendation, then select the affected resources and apply the Fix.');
  }
  steps.push('Select the unhealthy resource(s) and choose Fix / Remediate, then confirm.');
  return steps;
}

/** A real, copy-runnable PowerShell remediation script tailored to the rec. */
export function powershellScript(rec: RemediationInput): string {
  const sub = rec.subscriptionId || '<subscription-id>';
  const lines: string[] = [
    '# Microsoft Defender for Cloud — remediation',
    `# Recommendation: ${rec.name}`,
    rec.severity ? `# Severity: ${rec.severity}` : '',
    '# Requires: Az PowerShell (Install-Module Az). Sign in + select the subscription:',
    'Connect-AzAccount',
    `Set-AzContext -Subscription "${sub}"`,
    '',
    '# 1) Inspect the assessment + its affected resources:',
    rec.assessmentName
      ? `Get-AzSecurityAssessment | Where-Object { $_.Name -eq "${rec.assessmentName}" } | Format-List *`
      : `Get-AzSecurityAssessment | Where-Object { $_.DisplayName -like "*${rec.name.replace(/"/g, '')}*" } | Format-List *`,
  ].filter(Boolean);

  if (rec.policyDefinitionId) {
    lines.push(
      '',
      '# 2) This recommendation is policy-backed — trigger an Azure Policy remediation:',
      `$def = "${rec.policyDefinitionId}"`,
      '$assignment = Get-AzPolicyAssignment | Where-Object { $_.Properties.PolicyDefinitionId -eq $def -or $_.Properties.PolicyDefinitionId -match "policySetDefinitions" } | Select-Object -First 1',
      'if ($assignment) {',
      '  Start-AzPolicyRemediation -Name ("loom-remediate-" + [guid]::NewGuid().ToString("N").Substring(0,8)) `',
      '    -PolicyAssignmentId $assignment.PolicyAssignmentId `',
      rec.resourceId ? `    -ResourceDiscoveryMode ReEvaluateCompliance -Scope "${rec.resourceId}"` : '    -ResourceDiscoveryMode ReEvaluateCompliance',
      '} else { Write-Warning "No policy assignment found for this definition — apply the portal steps instead." }',
    );
  } else {
    lines.push(
      '',
      '# 2) This recommendation has no auto-remediation policy. Apply the resource-specific',
      '#    fix from the portal steps (e.g. Set-AzStorageAccount / Update-AzSqlServer / az ...).',
      rec.resourceId ? `#    Affected resource: ${rec.resourceId}` : '',
    );
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

/** Can Loom auto-fix this (real Azure Policy remediation task)? */
export function canAutoRemediate(rec: RemediationInput): boolean {
  return !!rec.policyDefinitionId;
}
