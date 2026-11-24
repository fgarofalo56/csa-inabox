// SMART `fhirUser` resolution (#5454 A3/A4). An operator maps an Entra oid to
// the FHIR resource that user is (Practitioner, Patient, RelatedPerson or
// Person) per tenant; sign-in reads that mapping. SMART App Launch requires
// the claim to be a URL, so the stored relative reference is returned as an
// absolute URL on the tenant's FHIR base. One value feeds both the id_token
// and the access token, so the two claims cannot disagree.

import type { FhirUserDoc, FhirUserStore } from './types.js';

/** The four resource types SMART App Launch allows as `fhirUser`, followed by an id under the FHIR id rule. */
export const FHIR_USER_RESOURCE = /^(Practitioner|Patient|RelatedPerson|Person)\/[A-Za-z0-9.-]{1,64}$/;

/** Deterministic id, keyed on BOTH tenant and oid: one user can be a different resource in each tenant. */
export const fhirUserDocId = (tenant: string, oid: string): string => `fhiruser-${tenant}-${oid.toLowerCase()}`;

export type FhirUserResolver = (oid: string, tenant: string) => Promise<string | undefined>;

/**
 * Store-backed resolver. No mapping => undefined, so grant.ts drops the `fhirUser` scope. A store failure
 * THROWS: the caller fails the sign-in closed rather than issuing a session that silently lost fhirUser.
 */
export function createFhirUserResolver(store: FhirUserStore, fhirBaseFor: (tenant: string) => string): FhirUserResolver {
  return async (oid, tenant) => {
    const doc: FhirUserDoc | undefined = await store.get(fhirUserDocId(tenant, oid));
    // The id already binds the tenant; the field check is defence in depth against a mis-keyed write.
    if (!doc || doc.kind !== 'fhiruser' || doc.tenant !== tenant || !FHIR_USER_RESOURCE.test(doc.resource)) return undefined;
    return `${fhirBaseFor(tenant)}/${doc.resource}`;
  };
}
