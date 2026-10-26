// SMART v2 scope grammar and the ceiling-intersection rule
// (docs/fiab/health/security.md A2, A4). Pure functions, no I/O.
// Invariant: nothing here ever widens a scope. An unparseable scope is dropped.

export type Compartment = 'patient' | 'user' | 'system';
export type GrantType = 'authorization_code' | 'client_credentials';

export const PERM_ORDER = 'cruds';

// FHIR R4 resource types (the set LHDS accepts in a scope).
export const FHIR_R4_TYPES: ReadonlySet<string> = new Set(
  (
    'Account ActivityDefinition AdverseEvent AllergyIntolerance Appointment AppointmentResponse AuditEvent Basic Binary ' +
    'BiologicallyDerivedProduct BodyStructure Bundle CapabilityStatement CarePlan CareTeam CatalogEntry ChargeItem ' +
    'ChargeItemDefinition Claim ClaimResponse ClinicalImpression CodeSystem Communication CommunicationRequest ' +
    'CompartmentDefinition Composition ConceptMap Condition Consent Contract Coverage CoverageEligibilityRequest ' +
    'CoverageEligibilityResponse DetectedIssue Device DeviceDefinition DeviceMetric DeviceRequest DeviceUseStatement ' +
    'DiagnosticReport DocumentManifest DocumentReference EffectEvidenceSynthesis Encounter Endpoint EnrollmentRequest ' +
    'EnrollmentResponse EpisodeOfCare EventDefinition Evidence EvidenceVariable ExampleScenario ExplanationOfBenefit ' +
    'FamilyMemberHistory Flag Goal GraphDefinition Group GuidanceResponse HealthcareService ImagingStudy Immunization ' +
    'ImmunizationEvaluation ImmunizationRecommendation ImplementationGuide InsurancePlan Invoice Library Linkage List ' +
    'Location Measure MeasureReport Media Medication MedicationAdministration MedicationDispense MedicationKnowledge ' +
    'MedicationRequest MedicationStatement MedicinalProduct MedicinalProductAuthorization MedicinalProductContraindication ' +
    'MedicinalProductIndication MedicinalProductIngredient MedicinalProductInteraction MedicinalProductManufactured ' +
    'MedicinalProductPackaged MedicinalProductPharmaceutical MedicinalProductUndesirableEffect MessageDefinition ' +
    'MessageHeader MolecularSequence NamingSystem NutritionOrder Observation ObservationDefinition OperationDefinition ' +
    'OperationOutcome Organization OrganizationAffiliation Parameters Patient PaymentNotice PaymentReconciliation Person ' +
    'PlanDefinition Practitioner PractitionerRole Procedure Provenance Questionnaire QuestionnaireResponse RelatedPerson ' +
    'RequestGroup ResearchDefinition ResearchElementDefinition ResearchStudy ResearchSubject RiskAssessment ' +
    'RiskEvidenceSynthesis Schedule SearchParameter ServiceRequest Slot Specimen SpecimenDefinition StructureDefinition ' +
    'StructureMap Subscription Substance SubstancePolymer SubstanceProtein SubstanceReferenceInformation ' +
    'SubstanceSourceMaterial SubstanceSpecification SubstanceNucleicAcid SupplyDelivery SupplyRequest Task ' +
    'TerminologyCapabilities TestReport TestScript ValueSet VerificationResult VisionPrescription'
  ).split(' '),
);

export const CONTEXT_SCOPES = ['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access'] as const;
export const CONSTRAINED_TYPES: ReadonlySet<string> = new Set(['Observation', 'Condition', 'DocumentReference']);

export interface DataScope {
  compartment: Compartment;
  type: string; // resource type or '*'
  perms: string; // in-order subset of 'cruds'
  constraint?: string; // 'category=<value>'
}

const CONSTRAINT = /^category=([A-Za-z0-9._~:/|%-]{1,200})$/;

function v1Perms(p: string): string | undefined {
  if (p === 'read') return 'rs';
  if (p === 'write') return 'cud';
  if (p === '*') return PERM_ORDER;
  return undefined;
}

/** True only for a non-empty, strictly in-order, non-repeating subset of "cruds". */
export function isValidPerms(p: string): boolean {
  if (p.length === 0) return false;
  let last = -1;
  for (const ch of p) {
    const i = PERM_ORDER.indexOf(ch);
    if (i <= last) return false; // unknown (-1), repeated, or out of order
    last = i;
  }
  return true;
}

export interface ParseOpts {
  /** Tenant v1-compatibility flag (A2): accept .read/.write/.* and rewrite to v2. */
  v1: boolean;
}

/** Parse one data scope; undefined when the grammar rejects it (A2 "Rejected" column). */
export function parseDataScope(raw: string, opts: ParseOpts): DataScope | undefined {
  const m = /^(patient|user|system)\/(\*|[A-Za-z]+)\.([A-Za-z*]+)(?:\?(.*))?$/.exec(raw);
  if (!m) return undefined;
  const compartment = m[1] as Compartment;
  const type = m[2] as string;
  const permRaw = m[3] as string;
  const query = m[4];
  if (type !== '*' && !FHIR_R4_TYPES.has(type)) return undefined;
  let perms: string;
  if (isValidPerms(permRaw)) perms = permRaw;
  else {
    const v1 = opts.v1 ? v1Perms(permRaw) : undefined;
    if (!v1) return undefined;
    perms = v1;
  }
  let constraint: string | undefined;
  if (query !== undefined) {
    const cm = CONSTRAINT.exec(query); // exactly one param, and it must be category
    if (!cm || !CONSTRAINED_TYPES.has(type)) return undefined;
    constraint = `category=${cm[1]}`;
  }
  return constraint ? { compartment, type, perms, constraint } : { compartment, type, perms };
}

export function serializeScope(s: DataScope): string {
  return `${s.compartment}/${s.type}.${s.perms}${s.constraint ? `?${s.constraint}` : ''}`;
}

function permIntersect(a: string, b: string): string {
  let out = '';
  for (const ch of PERM_ORDER) if (a.includes(ch) && b.includes(ch)) out += ch;
  return out;
}

function permUnion(a: string, b: string): string {
  let out = '';
  for (const ch of PERM_ORDER) if (a.includes(ch) || b.includes(ch)) out += ch;
  return out;
}

/**
 * Intersect one requested scope with one ceiling (A4 rules 1-4).
 * Returns undefined when nothing remains.
 */
export function intersectOne(s: DataScope, c: DataScope): DataScope | undefined {
  if (s.compartment !== c.compartment) return undefined;
  if (c.type !== '*' && c.type !== s.type) return undefined;
  const perms = permIntersect(s.perms, c.perms);
  if (perms === '') return undefined;
  if (c.constraint !== undefined && c.constraint !== s.constraint) return undefined;
  const out: DataScope = { compartment: s.compartment, type: s.type, perms };
  if (s.constraint !== undefined) out.constraint = s.constraint;
  return out;
}

/** requested INTERSECT union(ceilings); results of equal (compartment,type,constraint) are merged. */
export function intersectWithCeilings(requested: DataScope[], ceilings: DataScope[]): DataScope[] {
  const merged = new Map<string, DataScope>();
  for (const s of requested) {
    for (const c of ceilings) {
      const r = intersectOne(s, c);
      if (!r) continue;
      const key = `${r.compartment}/${r.type}?${r.constraint ?? ''}`;
      const prev = merged.get(key);
      merged.set(key, prev ? { ...r, perms: permUnion(prev.perms, r.perms) } : r);
    }
  }
  return [...merged.values()];
}

export interface ParsedRequest {
  data: DataScope[];
  context: string[];
  /** v2 serialization -> the raw string the client used (echoed in the token response). */
  echo: Map<string, string>;
  /** Raw scopes the grammar refused. Never granted, never widened. */
  rejected: string[];
}

export function parseRequest(scope: string, opts: ParseOpts): ParsedRequest {
  const out: ParsedRequest = { data: [], context: [], echo: new Map(), rejected: [] };
  const seen = new Set<string>();
  for (const raw of scope.split(/\s+/).filter((x) => x.length > 0)) {
    if ((CONTEXT_SCOPES as readonly string[]).includes(raw)) {
      if (!out.context.includes(raw)) out.context.push(raw);
      continue;
    }
    const p = parseDataScope(raw, opts);
    if (!p) {
      out.rejected.push(raw);
      continue;
    }
    const v2 = serializeScope(p);
    if (!out.echo.has(v2)) out.echo.set(v2, raw);
    if (!seen.has(v2)) {
      seen.add(v2);
      out.data.push(p);
    }
  }
  return out;
}

/** Compartment rule per grant type (A2 row 1): system only for client_credentials. */
export function compartmentAllowed(c: Compartment, g: GrantType): boolean {
  return g === 'client_credentials' ? c === 'system' : c !== 'system';
}
