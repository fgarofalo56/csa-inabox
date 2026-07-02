/**
 * purview-system-classifications — STATIC reference catalog of Microsoft
 * Purview BUILT-IN ("system") classifications.
 *
 * WHY THIS IS STATIC (not a live call):
 *   Purview ships 200+ system classifications (sensitive-information types) that
 *   its scanner auto-detects — U.S. SSN, Credit Card, Email, IP Address,
 *   Physical Address, Passport, etc. They are a FIXED Microsoft-defined catalog.
 *   They are NOT returned by the scan-plane classification-RULES API
 *   (`/scan/classificationrules` returns only the tenant's CUSTOM rules), so the
 *   admin Classifications page came back EMPTY when it tried to derive the
 *   built-ins from that endpoint — and the live call also timed out (>6s). This
 *   module is the canonical reference list the page renders instead: no Purview
 *   call, no timeout, available whether or not LOOM_PURVIEW_ACCOUNT is set.
 *
 * SOURCE OF TRUTH (reference data — display names are verbatim from Learn):
 *   https://learn.microsoft.com/purview/data-map-classification-supported-list
 *   Qualified names follow Microsoft's documented system-classification
 *   convention `MICROSOFT.<FAMILY>.<COUNTRY?>.<TYPE>` (e.g. the docs cite
 *   `MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER`):
 *   https://learn.microsoft.com/purview/data-map-classification-custom
 *
 * This is a representative, accurate SUBSET (not all 200) covering the
 * Government-ID / Financial / PII / Security-credential / Health families — the
 * types operators most commonly tag catalog assets with. It is read-only.
 */

export type SystemClassificationGroupId =
  | 'government'
  | 'financial'
  | 'pii'
  | 'security'
  | 'health';

export interface SystemClassification {
  /** Fully-qualified Purview system-classification name (MICROSOFT.*). Stable id. */
  name: string;
  /** Same as `name` — mirrors the live classification-rules shape so callers/UI are uniform. */
  classificationName: string;
  /** Verbatim Microsoft Learn display name. */
  displayName: string;
  /** Short factual description of what the type detects. */
  description: string;
  /** Operator-friendly bucket. */
  group: SystemClassificationGroupId;
}

export interface SystemClassificationGroup {
  id: SystemClassificationGroupId;
  label: string;
  description: string;
  classifications: Array<Pick<SystemClassification, 'name' | 'classificationName' | 'displayName' | 'description'>>;
}

/** Group metadata + render order. Mirrors the Purview governance-portal buckets. */
const GROUP_META: { id: SystemClassificationGroupId; label: string; description: string }[] = [
  { id: 'government', label: 'Government IDs', description: 'Passport, driver licence, national / tax IDs and social-security numbers.' },
  { id: 'financial', label: 'Financial', description: 'Credit-card, bank-account, SWIFT/IBAN and other financial identifiers.' },
  { id: 'pii', label: 'PII / Personal', description: 'Names, addresses, phone numbers, email and other personal data.' },
  { id: 'security', label: 'Security & credentials', description: 'Keys, secrets, connection strings and access tokens.' },
  { id: 'health', label: 'Health', description: 'Health-service and medical identifiers.' },
];

/**
 * The catalog. Each entry is a REAL Microsoft Purview built-in classification —
 * display names are taken verbatim from the Learn supported-list; qualified
 * names follow the documented `MICROSOFT.` system-classification convention.
 */
export const SYSTEM_CLASSIFICATIONS: SystemClassification[] = [
  // ── Government IDs ────────────────────────────────────────────────────────
  { name: 'MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER', displayName: 'U.S. social security number (SSN)', description: 'Nine-digit U.S. Social Security Number, formatted (ddd-dd-dddd) or unformatted.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.US.DRIVERS_LICENSE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.US.DRIVERS_LICENSE_NUMBER', displayName: "U.S. driver's license number", description: "U.S. state-issued driver's license number.", group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.US.PASSPORT_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.US.PASSPORT_NUMBER', displayName: 'U.S. / U.K. passport number', description: 'U.S. or U.K. passport number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.US.INDIVIDUAL_TAXPAYER_IDENTIFICATION', classificationName: 'MICROSOFT.GOVERNMENT.US.INDIVIDUAL_TAXPAYER_IDENTIFICATION', displayName: 'U.S. individual taxpayer identification number (ITIN)', description: 'U.S. IRS Individual Taxpayer Identification Number (9xx-xx-xxxx).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.UK.DRIVERS_LICENSE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.UK.DRIVERS_LICENSE_NUMBER', displayName: "U.K. driver's license number", description: "U.K. driver's license number.", group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.UK.NATIONAL_INSURANCE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.UK.NATIONAL_INSURANCE_NUMBER', displayName: 'U.K. national insurance number (NINO)', description: 'U.K. National Insurance Number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.UK.UNIQUE_TAXPAYER_REFERENCE', classificationName: 'MICROSOFT.GOVERNMENT.UK.UNIQUE_TAXPAYER_REFERENCE', displayName: 'U.K. Unique Taxpayer Reference Number', description: 'U.K. HMRC Unique Taxpayer Reference (10 digits).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.AUSTRALIA.DRIVERS_LICENSE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.AUSTRALIA.DRIVERS_LICENSE_NUMBER', displayName: "Australia driver's license number", description: "Australian state-issued driver's license number.", group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.AUSTRALIA.PASSPORT_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.AUSTRALIA.PASSPORT_NUMBER', displayName: 'Australia passport number', description: 'Australian passport number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.AUSTRALIA.TAX_FILE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.AUSTRALIA.TAX_FILE_NUMBER', displayName: 'Australia tax file number', description: 'Australian Tax File Number (TFN).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.CANADA.SOCIAL_INSURANCE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.CANADA.SOCIAL_INSURANCE_NUMBER', displayName: 'Canada social insurance number', description: 'Canadian Social Insurance Number (SIN).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.CANADA.PASSPORT_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.CANADA.PASSPORT_NUMBER', displayName: 'Canada passport number', description: 'Canadian passport number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.CANADA.DRIVERS_LICENSE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.CANADA.DRIVERS_LICENSE_NUMBER', displayName: "Canada driver's license number", description: "Canadian province-issued driver's license number.", group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.GERMANY.IDENTITY_CARD_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.GERMANY.IDENTITY_CARD_NUMBER', displayName: 'Germany identity card number', description: 'German national identity card number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.GERMANY.PASSPORT_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.GERMANY.PASSPORT_NUMBER', displayName: 'Germany passport number', description: 'German passport number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.FRANCE.NATIONAL_ID_CARD', classificationName: 'MICROSOFT.GOVERNMENT.FRANCE.NATIONAL_ID_CARD', displayName: 'France national id card (CNI)', description: 'French national identity card (CNI) number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.FRANCE.SOCIAL_SECURITY_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.FRANCE.SOCIAL_SECURITY_NUMBER', displayName: 'France social security number (INSEE)', description: 'French INSEE social-security number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.INDIA.PERMANENT_ACCOUNT_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.INDIA.PERMANENT_ACCOUNT_NUMBER', displayName: 'India permanent account number (PAN)', description: 'Indian income-tax Permanent Account Number (PAN).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.INDIA.UNIQUE_IDENTIFICATION_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.INDIA.UNIQUE_IDENTIFICATION_NUMBER', displayName: 'India unique identification (Aadhaar) number', description: 'Indian Aadhaar unique identification number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.JAPAN.MY_NUMBER_PERSONAL', classificationName: 'MICROSOFT.GOVERNMENT.JAPAN.MY_NUMBER_PERSONAL', displayName: 'Japan My Number - Personal', description: 'Japanese personal Individual Number (My Number).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.SPAIN.DNI', classificationName: 'MICROSOFT.GOVERNMENT.SPAIN.DNI', displayName: 'Spain DNI', description: 'Spanish DNI national identity number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.CHINA.RESIDENT_IDENTITY_CARD_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.CHINA.RESIDENT_IDENTITY_CARD_NUMBER', displayName: 'China resident identity card (PRC) number', description: 'PRC resident identity card number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.SAUDI_ARABIA.NATIONAL_ID', classificationName: 'MICROSOFT.GOVERNMENT.SAUDI_ARABIA.NATIONAL_ID', displayName: 'Saudi Arabia National ID', description: 'Saudi Arabian national identity number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.SINGAPORE.NATIONAL_REGISTRATION_IDENTITY_CARD', classificationName: 'MICROSOFT.GOVERNMENT.SINGAPORE.NATIONAL_REGISTRATION_IDENTITY_CARD', displayName: 'Singapore national registration identity card (NRIC) number', description: 'Singapore NRIC number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.SOUTH_KOREA.RESIDENT_REGISTRATION_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.SOUTH_KOREA.RESIDENT_REGISTRATION_NUMBER', displayName: 'South Korea resident registration number', description: 'South Korean resident registration number (RRN).', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.EU.DRIVERS_LICENSE_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.EU.DRIVERS_LICENSE_NUMBER', displayName: "EU driver's license number", description: "EU member-state driver's license number.", group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.EU.PASSPORT_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.EU.PASSPORT_NUMBER', displayName: 'EU passport number', description: 'EU member-state passport number.', group: 'government' },
  { name: 'MICROSOFT.GOVERNMENT.EU.NATIONAL_IDENTIFICATION_NUMBER', classificationName: 'MICROSOFT.GOVERNMENT.EU.NATIONAL_IDENTIFICATION_NUMBER', displayName: 'EU national identification number', description: 'EU member-state national identification number.', group: 'government' },

  // ── Financial ─────────────────────────────────────────────────────────────
  { name: 'MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER', displayName: 'Credit card number', description: 'Major-brand credit-card number (Luhn-validated).', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.US.BANK_ACCOUNT_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.US.BANK_ACCOUNT_NUMBER', displayName: 'U.S. bank account number', description: 'U.S. bank account number.', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.ABA_ROUTING_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.ABA_ROUTING_NUMBER', displayName: 'ABA routing number', description: 'U.S. ABA bank routing / transit number (9 digits).', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.SWIFT_CODE', classificationName: 'MICROSOFT.FINANCIAL.SWIFT_CODE', displayName: 'SWIFT code', description: 'SWIFT/BIC bank identifier code.', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.INTERNATIONAL_BANKING_ACCOUNT_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.INTERNATIONAL_BANKING_ACCOUNT_NUMBER', displayName: 'International banking account number (IBAN)', description: 'International Bank Account Number (IBAN).', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.EU.DEBIT_CARD_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.EU.DEBIT_CARD_NUMBER', displayName: 'EU debit card number', description: 'EU debit-card number.', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.AUSTRALIA.BANK_ACCOUNT_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.AUSTRALIA.BANK_ACCOUNT_NUMBER', displayName: 'Australia bank account number', description: 'Australian bank account number.', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.CANADA.BANK_ACCOUNT_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.CANADA.BANK_ACCOUNT_NUMBER', displayName: 'Canada bank account number', description: 'Canadian bank account number.', group: 'financial' },
  { name: 'MICROSOFT.FINANCIAL.ISRAEL.BANK_ACCOUNT_NUMBER', classificationName: 'MICROSOFT.FINANCIAL.ISRAEL.BANK_ACCOUNT_NUMBER', displayName: 'Israel bank account number', description: 'Israeli bank account number.', group: 'financial' },

  // ── PII / Personal ────────────────────────────────────────────────────────
  { name: 'MICROSOFT.PERSONAL.EMAIL', classificationName: 'MICROSOFT.PERSONAL.EMAIL', displayName: 'Email', description: 'Email address.', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.IPADDRESS', classificationName: 'MICROSOFT.PERSONAL.IPADDRESS', displayName: 'IP address', description: 'IPv4 or IPv6 address.', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.NAME', classificationName: 'MICROSOFT.PERSONAL.NAME', displayName: "Person's Name", description: "A person's full name (ML-detected).", group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.PHYSICAL_ADDRESS', classificationName: 'MICROSOFT.PERSONAL.PHYSICAL_ADDRESS', displayName: "Person's Address", description: 'Full physical/postal address (house number, street, city, state, zip).', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.US.PHONE_NUMBER', classificationName: 'MICROSOFT.PERSONAL.US.PHONE_NUMBER', displayName: 'U.S. phone number', description: 'U.S. 10-digit telephone number.', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.DATE_OF_BIRTH', classificationName: 'MICROSOFT.PERSONAL.DATE_OF_BIRTH', displayName: 'Date Of Birth', description: 'A date of birth.', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.AGE', classificationName: 'MICROSOFT.PERSONAL.AGE', displayName: "Person's Age", description: 'Age of an individual (ML-detected).', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.GENDER', classificationName: 'MICROSOFT.PERSONAL.GENDER', displayName: "Person's Gender", description: 'Gender of an individual (ML-detected).', group: 'pii' },
  { name: 'MICROSOFT.PERSONAL.ETHNIC_GROUP', classificationName: 'MICROSOFT.PERSONAL.ETHNIC_GROUP', displayName: 'Ethnic groups', description: 'Ethnic-group identifier.', group: 'pii' },

  // ── Security & credentials (Microsoft built-in credential SITs) ────────────
  { name: 'MICROSOFT.SECURITY.AZURE_STORAGE_ACCOUNT_KEY', classificationName: 'MICROSOFT.SECURITY.AZURE_STORAGE_ACCOUNT_KEY', displayName: 'Azure Storage account key', description: 'Azure Storage account access key.', group: 'security' },
  { name: 'MICROSOFT.SECURITY.AZURE_SQL_CONNECTION_STRING', classificationName: 'MICROSOFT.SECURITY.AZURE_SQL_CONNECTION_STRING', displayName: 'Azure SQL connection string', description: 'Azure SQL Database connection string with embedded credentials.', group: 'security' },
  { name: 'MICROSOFT.SECURITY.AZURE_SERVICE_BUS_CONNECTION_STRING', classificationName: 'MICROSOFT.SECURITY.AZURE_SERVICE_BUS_CONNECTION_STRING', displayName: 'Azure Service Bus connection string', description: 'Azure Service Bus shared-access connection string.', group: 'security' },
  { name: 'MICROSOFT.SECURITY.AMAZON_S3_ACCESS_KEY', classificationName: 'MICROSOFT.SECURITY.AMAZON_S3_ACCESS_KEY', displayName: 'Amazon S3 access key', description: 'Amazon S3 / AWS access key id.', group: 'security' },
  { name: 'MICROSOFT.SECURITY.GOOGLE_API_KEY', classificationName: 'MICROSOFT.SECURITY.GOOGLE_API_KEY', displayName: 'Google API key', description: 'Google Cloud / API key.', group: 'security' },
  { name: 'MICROSOFT.SECURITY.GITHUB_PERSONAL_ACCESS_TOKEN', classificationName: 'MICROSOFT.SECURITY.GITHUB_PERSONAL_ACCESS_TOKEN', displayName: 'GitHub personal access token', description: 'GitHub personal access token (PAT).', group: 'security' },
  { name: 'MICROSOFT.SECURITY.GENERAL_SYMMETRIC_KEY', classificationName: 'MICROSOFT.SECURITY.GENERAL_SYMMETRIC_KEY', displayName: 'General Symmetric Key', description: 'High-entropy base64/hex symmetric key or secret.', group: 'security' },
  { name: 'MICROSOFT.SECURITY.GENERAL_PASSWORD', classificationName: 'MICROSOFT.SECURITY.GENERAL_PASSWORD', displayName: 'General password', description: 'Password near a password-like keyword.', group: 'security' },

  // ── Health ────────────────────────────────────────────────────────────────
  { name: 'MICROSOFT.HEALTH.UK.NATIONAL_HEALTH_SERVICE_NUMBER', classificationName: 'MICROSOFT.HEALTH.UK.NATIONAL_HEALTH_SERVICE_NUMBER', displayName: 'U.K. national health service number', description: 'U.K. NHS patient number.', group: 'health' },
  { name: 'MICROSOFT.HEALTH.CANADA.HEALTH_SERVICE_NUMBER', classificationName: 'MICROSOFT.HEALTH.CANADA.HEALTH_SERVICE_NUMBER', displayName: 'Canada health service number', description: 'Canadian provincial health-service number.', group: 'health' },
  { name: 'MICROSOFT.HEALTH.CANADA.PERSONAL_HEALTH_IDENTIFICATION_NUMBER', classificationName: 'MICROSOFT.HEALTH.CANADA.PERSONAL_HEALTH_IDENTIFICATION_NUMBER', displayName: 'Canada personal health identification number (PHIN)', description: 'Canadian Personal Health Identification Number.', group: 'health' },
  { name: 'MICROSOFT.HEALTH.NEW_ZEALAND.MINISTRY_OF_HEALTH_NUMBER', classificationName: 'MICROSOFT.HEALTH.NEW_ZEALAND.MINISTRY_OF_HEALTH_NUMBER', displayName: 'New Zealand ministry of health number', description: 'New Zealand Ministry of Health NHI number.', group: 'health' },
  { name: 'MICROSOFT.HEALTH.US.DRUG_ENFORCEMENT_AGENCY_NUMBER', classificationName: 'MICROSOFT.HEALTH.US.DRUG_ENFORCEMENT_AGENCY_NUMBER', displayName: 'Drug Enforcement Agency (DEA) number', description: 'U.S. DEA registration number.', group: 'health' },
];

/** Total number of built-in classifications in the catalog. */
export const SYSTEM_CLASSIFICATION_COUNT = SYSTEM_CLASSIFICATIONS.length;

/**
 * The catalog grouped into operator-friendly buckets, in display order, with
 * empty groups dropped and each group's classifications sorted by display name.
 * Shape matches the live classification-rules grouping the page consumes.
 */
export function buildSystemClassificationGroups(): SystemClassificationGroup[] {
  return GROUP_META.map((meta) => ({
    id: meta.id,
    label: meta.label,
    description: meta.description,
    classifications: SYSTEM_CLASSIFICATIONS
      .filter((c) => c.group === meta.id)
      .map(({ name, classificationName, displayName, description }) => ({ name, classificationName, displayName, description }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  })).filter((g) => g.classifications.length > 0);
}
