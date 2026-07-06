/**
 * DLP policy library — curated, best-practice Data Loss Prevention presets +
 * the sensitive-information-type (SIT) catalog the custom-policy wizard offers.
 *
 * These are Loom-native governance policies persisted to Cosmos (see
 * lib/governance/policy-store.ts) — NOT a Microsoft Fabric / Power BI object and
 * NOT dependent on a live Microsoft Graph DLP segment. When the Graph DLP
 * data-plane (violations via /v1.0/security/alerts_v2) IS wired, these policies
 * are the authoring surface; when it isn't, the presets still author + save and
 * downstream enforcement (Synapse SQL / lakehouse query gate / restrict-access)
 * reads them.
 *
 * Every preset maps 1:1 to a REAL Microsoft Purview DLP policy template — the
 * sensitive-information types + default action are taken from the published
 * templates, so "PII protection" is the same rule shape you would build in the
 * Purview portal, not a label. Grounded in Microsoft Learn:
 *   - Default Office 365 DLP policy (Credit Card Number, block on external share)
 *       https://learn.microsoft.com/purview/dlp-o365-default-policy
 *   - What the DLP policy templates include (PII / Financial / PCI / HIPAA / GLBA / Patriot / GDPR)
 *       https://learn.microsoft.com/purview/dlp-policy-templates-include
 *   - Sensitive information type entity definitions
 *       https://learn.microsoft.com/purview/sit-sensitive-information-type-entity-definitions
 *   - Endpoint DLP best practice (block sensitive content leaving the boundary)
 *       https://learn.microsoft.com/purview/endpoint-dlp-learn-about#best-practice-for-endpoint-dlp-policies
 */

/** The action Loom takes when a rule matches — mirrors the Purview portal set. */
export type DlpAction = 'Audit' | 'Block' | 'Notify' | 'Quarantine';

/** Who the content is shared with when the rule triggers (the template condition). */
export type DlpSharedWith = 'external' | 'any';

/** A single sensitive-information type the wizard + presets reference. */
export interface SensitiveInfoType {
  /** Stable id used in stored policies (kebab of the Purview SIT name). */
  id: string;
  /** Display name, verbatim from the Purview SIT catalog. */
  name: string;
  /** Grouping used to organize the multi-select picker. */
  category: 'Financial' | 'Identity' | 'Health' | 'Credentials' | 'General';
}

/**
 * Curated subset of the Microsoft Purview built-in sensitive-information types
 * most relevant to a data-platform egress policy. Names match the Purview SIT
 * catalog exactly so an operator who later opens the Purview portal sees the
 * same type. (Purview ships 300+ SITs; the custom wizard exposes this working
 * set, which covers every preset below.)
 */
export const SENSITIVE_INFO_TYPES: SensitiveInfoType[] = [
  // Financial
  { id: 'credit-card-number', name: 'Credit Card Number', category: 'Financial' },
  { id: 'us-bank-account-number', name: 'U.S. Bank Account Number', category: 'Financial' },
  { id: 'aba-routing-number', name: 'ABA Routing Number', category: 'Financial' },
  { id: 'iban', name: 'International Banking Account Number (IBAN)', category: 'Financial' },
  { id: 'swift-code', name: 'SWIFT Code', category: 'Financial' },
  { id: 'eu-debit-card-number', name: 'EU Debit Card Number', category: 'Financial' },
  // Identity / PII
  { id: 'us-ssn', name: 'U.S. Social Security Number (SSN)', category: 'Identity' },
  { id: 'us-itin', name: 'U.S. Individual Taxpayer Identification Number (ITIN)', category: 'Identity' },
  { id: 'us-uk-passport', name: 'U.S. / U.K. Passport Number', category: 'Identity' },
  { id: 'us-drivers-license', name: "U.S. Driver's License Number", category: 'Identity' },
  { id: 'us-physical-address', name: 'U.S. Physical Addresses', category: 'Identity' },
  { id: 'eu-physical-address', name: 'EU Physical Addresses', category: 'Identity' },
  { id: 'eu-national-id', name: 'EU National Identification Number', category: 'Identity' },
  { id: 'all-full-names', name: 'All Full Names', category: 'Identity' },
  // Health
  { id: 'dea-number', name: 'Drug Enforcement Agency (DEA) Number', category: 'Health' },
  { id: 'icd-9-cm', name: 'International Classification of Diseases (ICD-9-CM)', category: 'Health' },
  { id: 'icd-10-cm', name: 'International Classification of Diseases (ICD-10-CM)', category: 'Health' },
  { id: 'medical-terms', name: 'All Medical Terms And Conditions', category: 'Health' },
  // Credentials / secrets
  { id: 'azure-storage-account-key', name: 'Azure Storage Account Key', category: 'Credentials' },
  { id: 'azure-sas', name: 'Azure Storage Account Shared Access Signature', category: 'Credentials' },
  { id: 'azure-connection-string', name: 'Azure IoT / connection string', category: 'Credentials' },
  { id: 'client-secret-api-key', name: 'Client secret / API key', category: 'Credentials' },
  { id: 'general-password', name: 'General password', category: 'Credentials' },
  { id: 'sql-connection-string', name: 'SQL Server Connection String', category: 'Credentials' },
  { id: 'x509-private-key', name: 'X.509 certificate private key', category: 'Credentials' },
  { id: 'user-login-credentials', name: 'User login credentials', category: 'Credentials' },
  // General
  { id: 'email-address', name: 'Email address', category: 'General' },
  { id: 'ip-address', name: 'IP address', category: 'General' },
];

const SIT_BY_ID = new Map(SENSITIVE_INFO_TYPES.map((s) => [s.id, s]));

/** Resolve a list of SIT ids to their display names (unknown ids dropped). */
export function sitNames(ids: string[]): string[] {
  return ids.map((id) => SIT_BY_ID.get(id)?.name).filter((n): n is string => !!n);
}

export type DlpPresetCategory = 'Privacy' | 'Financial' | 'Healthcare' | 'Security' | 'Regulatory';

/** A curated, one-click-enable DLP policy preset (a real Purview template shape). */
export interface DlpPolicyPreset {
  id: string;
  name: string;
  description: string;
  category: DlpPresetCategory;
  /** Icon key mapped to a Fluent icon in the UI (kept string so the store/route stays icon-free). */
  icon: string;
  /** Regulation / template this maps to, for the card subtitle. */
  regulation?: string;
  /** SIT ids this policy detects (reference SENSITIVE_INFO_TYPES). */
  sensitiveInfoTypes: string[];
  /** Default action when the rule matches. */
  action: DlpAction;
  /** Condition: content shared externally (template default) or any location. */
  sharedWith: DlpSharedWith;
  /** Microsoft Learn source for the template. */
  learnUrl: string;
}

/**
 * The curated preset catalog. Each entry is a real Purview DLP policy template
 * reduced to its sensitive-information-type set + default action. Enabling one
 * writes a genuine Loom governance policy (kind: 'DLP') to the tenant store.
 */
export const DLP_POLICY_PRESETS: DlpPolicyPreset[] = [
  {
    id: 'loom-baseline',
    name: 'Loom Baseline Data Protection',
    description:
      'Best-practice starting point — blocks credit-card numbers, U.S. SSNs, bank accounts and leaked secrets/credentials from being shared outside the organization. Enabled by default; broadens Microsoft’s default Office 365 policy (credit-card only) to cover PII and secrets egress.',
    category: 'Security',
    icon: 'shield',
    regulation: 'Loom best practice (extends Microsoft default DLP policy)',
    sensitiveInfoTypes: [
      'credit-card-number', 'us-ssn', 'us-bank-account-number',
      'azure-storage-account-key', 'client-secret-api-key', 'general-password',
    ],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-o365-default-policy',
  },
  {
    id: 'us-pii',
    name: 'U.S. PII Protection',
    description:
      'Detects personally identifiable information for the United States — SSN, ITIN, passport, driver’s license and physical address — and blocks it when shared externally. Maps to the Purview "U.S. PII Data Enhanced" template.',
    category: 'Privacy',
    icon: 'person',
    regulation: 'U.S. Personally Identifiable Information (PII) Data Enhanced',
    sensitiveInfoTypes: ['us-ssn', 'us-itin', 'us-uk-passport', 'us-drivers-license', 'us-physical-address'],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-policy-templates-include#us-personally-identifiable-information-pii-data-enhanced',
  },
  {
    id: 'financial-data',
    name: 'Financial Data',
    description:
      'Protects financial account data — credit-card numbers, U.S. bank account numbers and ABA routing numbers — from external sharing. Maps to the Purview "U.S. Financial Data" template.',
    category: 'Financial',
    icon: 'money',
    regulation: 'U.S. Financial Data',
    sensitiveInfoTypes: ['credit-card-number', 'us-bank-account-number', 'aba-routing-number'],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-policy-templates-include#us-financial-data',
  },
  {
    id: 'pci-dss',
    name: 'PCI DSS (Payment Cards)',
    description:
      'Payment Card Industry Data Security Standard — detects credit-card numbers and blocks them from being shared outside the organization. Maps to the Purview "PCI DSS" template.',
    category: 'Regulatory',
    icon: 'card',
    regulation: 'PCI Data Security Standard (PCI DSS)',
    sensitiveInfoTypes: ['credit-card-number'],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-policy-templates-include#pci-data-security-standard-pci-dss',
  },
  {
    id: 'hipaa',
    name: 'Healthcare / HIPAA',
    description:
      'U.S. Health Insurance Portability and Accountability Act — detects SSNs, DEA numbers, addresses, full names and medical (ICD-9/ICD-10) terms, blocking protected health information from external sharing. Maps to the Purview "U.S. HIPAA Enhanced" template.',
    category: 'Healthcare',
    icon: 'health',
    regulation: 'U.S. Health Insurance Act (HIPAA) Enhanced',
    sensitiveInfoTypes: ['us-ssn', 'dea-number', 'us-physical-address', 'all-full-names', 'icd-9-cm', 'icd-10-cm', 'medical-terms'],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-policy-templates-include#us-health-insurance-act-hipaa-enhanced',
  },
  {
    id: 'glba',
    name: 'Financial Services / GLBA',
    description:
      'Gramm-Leach-Bliley Act — protects customer financial records by detecting credit-card, bank-account, ITIN, SSN, driver’s license, passport and address data. Maps to the Purview "U.S. GLBA Enhanced" template.',
    category: 'Regulatory',
    icon: 'bank',
    regulation: 'U.S. Gramm-Leach-Bliley Act (GLBA) Enhanced',
    sensitiveInfoTypes: ['credit-card-number', 'us-bank-account-number', 'us-itin', 'us-ssn', 'us-drivers-license', 'us-uk-passport', 'us-physical-address'],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-policy-templates-include#us-gramm-leach-bliley-act-glba-enhanced',
  },
  {
    id: 'gdpr',
    name: 'EU Privacy / GDPR',
    description:
      'General Data Protection Regulation — detects personal data for EU individuals (full names, EU addresses, passport and national-ID numbers) and notifies on external sharing. Maps to the Purview "GDPR Enhanced" template.',
    category: 'Privacy',
    icon: 'globe',
    regulation: 'General Data Protection Regulation (GDPR) Enhanced',
    sensitiveInfoTypes: ['all-full-names', 'eu-physical-address', 'us-uk-passport', 'eu-national-id', 'eu-debit-card-number'],
    action: 'Notify',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/sit-named-entities-learn#examples-of-enhanced-dlp-policies',
  },
  {
    id: 'secrets-credentials',
    name: 'Secrets & Credentials',
    description:
      'Stops keys and credentials from leaking — detects Azure storage keys, SAS tokens, connection strings, client secrets/API keys, passwords, SQL connection strings and private keys, and blocks them from egress. Built on Purview credential sensitive-information types.',
    category: 'Security',
    icon: 'key',
    regulation: 'Credential sensitive information types',
    sensitiveInfoTypes: ['azure-storage-account-key', 'azure-sas', 'azure-connection-string', 'client-secret-api-key', 'general-password', 'sql-connection-string', 'x509-private-key', 'user-login-credentials'],
    action: 'Block',
    sharedWith: 'any',
    learnUrl: 'https://learn.microsoft.com/purview/sit-sensitive-information-type-entity-definitions',
  },
  {
    id: 'data-residency',
    name: 'Regulated Data Residency',
    description:
      'Keeps regulated data inside the boundary — blocks credit-card, SSN, bank-account, IBAN and SWIFT data from being shared outside the organization, supporting data-sovereignty and breach-notification obligations.',
    category: 'Regulatory',
    icon: 'lock',
    regulation: 'U.S. State Breach Notification / data-sovereignty',
    sensitiveInfoTypes: ['credit-card-number', 'us-ssn', 'us-bank-account-number', 'iban', 'swift-code'],
    action: 'Block',
    sharedWith: 'external',
    learnUrl: 'https://learn.microsoft.com/purview/dlp-policy-templates-include#us-state-social-security-number-confidentiality-laws',
  },
];

/** The preset seeded + enabled out-of-box as the best-practice default policy. */
export const DEFAULT_DLP_PRESET_ID = 'loom-baseline';

const PRESET_BY_ID = new Map(DLP_POLICY_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): DlpPolicyPreset | undefined {
  return PRESET_BY_ID.get(id);
}

/** Human-readable rule string stored on the policy (shown in the Rule column). */
export function presetRuleString(preset: DlpPolicyPreset): string {
  const names = sitNames(preset.sensitiveInfoTypes);
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` +${names.length - 2}` : '';
  const where = preset.sharedWith === 'external' ? 'shared externally' : 'any location';
  return `detect ${shown}${more} → ${preset.action} (${where})`;
}

/** Build a rule string for a custom (wizard-authored) DLP policy. */
export function customDlpRuleString(sitIds: string[], action: string, sharedWith: DlpSharedWith): string {
  const names = sitNames(sitIds);
  const shown = names.slice(0, 3).join(', ') || '<no types>';
  const more = names.length > 3 ? ` +${names.length - 3}` : '';
  const where = sharedWith === 'external' ? 'shared externally' : 'any location';
  return `detect ${shown}${more} → ${action} (${where})`;
}

/** The structured DLP fields persisted on a policy (real rule shape, not a label). */
export interface DlpPolicyRule {
  sensitiveInfoTypes: string[];
  action: DlpAction;
  sharedWith: DlpSharedWith;
}

/** The body a preset materializes into when written to the policy store. */
export interface MaterializedPreset {
  name: string;
  kind: 'DLP';
  scope: string;
  rule: string;
  enabled: boolean;
  category: DlpPresetCategory;
  source: string;
  builtin: boolean;
  dlp: DlpPolicyRule;
}

/** Turn a preset into a store-ready policy body. */
export function materializePreset(preset: DlpPolicyPreset, opts?: { builtin?: boolean; enabled?: boolean }): MaterializedPreset {
  return {
    name: preset.name,
    kind: 'DLP',
    scope: 'tenant',
    rule: presetRuleString(preset),
    enabled: opts?.enabled ?? true,
    category: preset.category,
    source: `preset:${preset.id}`,
    builtin: opts?.builtin ?? false,
    dlp: {
      sensitiveInfoTypes: preset.sensitiveInfoTypes,
      action: preset.action,
      sharedWith: preset.sharedWith,
    },
  };
}

/** The default best-practice policy body seeded into a new tenant policy doc. */
export function defaultDlpPolicyBody(): MaterializedPreset {
  const preset = getPreset(DEFAULT_DLP_PRESET_ID)!;
  return materializePreset(preset, { builtin: true, enabled: true });
}
