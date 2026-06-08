/**
 * Data Product edit-dialog step field maps — PURE, framework-free.
 *
 * The Purview "Edit data product" dialog (and Loom's one-for-one of it) is a
 * 3-step modal — Basic / Business / Custom attributes — where EACH step owns
 * its own Save that fires a PATCH carrying ONLY that step's fields. Keeping the
 * field lists + the `pick*` helpers here (no React, no Cosmos) lets both the
 * client dialog and a unit test agree on exactly which keys a step is allowed
 * to send, so "PATCH for Basic contains only Basic fields" is verifiable
 * deterministically without a browser.
 */

import type { DataProductPatch, DataProductDoc } from './store';

export type EditStep = 'basic' | 'business' | 'custom';

/** The 12 Purview data-product Type enum values (parity with the portal). */
export const DATA_PRODUCT_TYPES = [
  'Analytics model',
  'Business system/Application',
  'Dashboards/Reports',
  'Dataset',
  'Master and reference data',
  'ML training data',
  'ML testing data',
  'Model types',
  'Operational',
  'Semantic model',
  'Transactional data',
] as const;

/** The 8 Purview Audience enum values (parity with the portal multi-select). */
export const DATA_PRODUCT_AUDIENCES = [
  'Business users',
  'Data analysts',
  'Data engineers',
  'Data scientists',
  'Executives',
  'Compliance officers',
  'Partners',
  'External consumers',
] as const;

/** Keys each step is allowed to PATCH — the contract enforced on the client. */
export const STEP_FIELDS: Record<EditStep, ReadonlyArray<keyof DataProductPatch>> = {
  basic: ['name', 'description', 'type', 'audience', 'owners', 'endorsed'],
  business: ['governanceDomainId', 'useCase'],
  custom: ['customAttributes'],
};

/**
 * Build the PATCH body for one step from the full editor state, copying ONLY
 * that step's keys (and only those that are defined). The returned object is
 * exactly what goes on the wire — never any other step's fields.
 */
export function pickStepFields(
  step: EditStep,
  state: Partial<DataProductDoc>,
): DataProductPatch {
  const out: Record<string, unknown> = {};
  for (const key of STEP_FIELDS[step]) {
    const v = (state as Record<string, unknown>)[key as string];
    if (v !== undefined) out[key as string] = v;
  }
  return out as DataProductPatch;
}
