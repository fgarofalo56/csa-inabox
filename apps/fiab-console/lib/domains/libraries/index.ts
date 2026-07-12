/**
 * Domain-library registry — the selectable set of curated libraries offered by
 * the "Create new domain" picker (issue #1483, Wave 1).
 *
 * Federal Civilian (#1481) is library #1 and the DEFAULT — its content and
 * behavior are unchanged. Wave 2+ adds a library by creating a module in this
 * folder and appending it to DOMAIN_LIBRARIES; the picker, seeding, and tests
 * pick it up automatically.
 */
import type { DomainLibrary } from './types';
import { FEDERAL_CIVILIAN_LIBRARY } from './federal-civilian';
import { DEFENSE_INTEL_LIBRARY } from './defense-intelligence';
import { STATE_LOCAL_LIBRARY } from './state-local';
import { COMMERCIAL_LIBRARY } from './commercial';

export type {
  DomainLibrary, DomainLibraryNode, DomainLibraryCopy, DomainLibraryStats,
} from './types';
export {
  libraryEnterprises, libraryChildren, libraryNode, libraryStats,
} from './types';
export { planLibrarySeed, toDomainSeedPayload, type DomainSeedPayload } from './seed-plan';
export { FEDERAL_CIVILIAN_LIBRARY } from './federal-civilian';
export { DEFENSE_INTEL_LIBRARY } from './defense-intelligence';
export { STATE_LOCAL_LIBRARY } from './state-local';
export { COMMERCIAL_LIBRARY } from './commercial';

/** All curated libraries, in picker order. Federal Civilian stays #1. */
export const DOMAIN_LIBRARIES: readonly DomainLibrary[] = [
  FEDERAL_CIVILIAN_LIBRARY,
  DEFENSE_INTEL_LIBRARY,
  STATE_LOCAL_LIBRARY,
  COMMERCIAL_LIBRARY,
];

/** The default library the picker opens on (zero-regression vs #1481). */
export const DEFAULT_DOMAIN_LIBRARY_ID = FEDERAL_CIVILIAN_LIBRARY.id;

/** Look up a library by id, falling back to the default. */
export function getDomainLibrary(id?: string | null): DomainLibrary {
  return DOMAIN_LIBRARIES.find((l) => l.id === id) || FEDERAL_CIVILIAN_LIBRARY;
}
