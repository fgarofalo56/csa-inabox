/**
 * seed-plan — the pure selection→seed wiring behind the library picker.
 *
 * Extracted from CreateDomainDialog.createLibrary (#1481) so the multi-library
 * picker (#1483 Wave 1) shares ONE tested implementation of the seeding rules:
 *
 *   1. EXPAND: a picked child pulls in its parent enterprise (a subdomain
 *      cannot be created without its parent).
 *   2. SKIP: nodes whose id already exists as a domain are dropped.
 *   3. ORDER: parents (enterprises) before children, so each POST's parentId
 *      always references an existing (or just-created) domain.
 *
 * The dialog then POSTs each planned node to the real create endpoint
 * (POST /api/admin/domains) via `toDomainSeedPayload` — the library ONLY
 * changes the seed content, never the create path.
 */
import type { DomainLibrary, DomainLibraryNode } from './types';
import { libraryNode } from './types';

/** The POST /api/admin/domains body a library node seeds. */
export interface DomainSeedPayload {
  id: string;
  name: string;
  description: string;
  icon: string;
  themeColor: string;
  parentId?: string;
}

/**
 * Plan which library nodes to create for a picked selection: expand parents,
 * drop already-existing ids, and order parents-first (stable within each
 * group, following pick/expansion order).
 */
export function planLibrarySeed(
  lib: DomainLibrary,
  pickedIds: Iterable<string>,
  existingIds: ReadonlySet<string>,
): DomainLibraryNode[] {
  const ids = Array.from(pickedIds);
  const toCreate = new Set<string>(ids);
  for (const id of ids) {
    const node = libraryNode(lib, id);
    if (node?.parentId) toCreate.add(node.parentId);
  }
  return Array.from(toCreate)
    .map((id) => libraryNode(lib, id))
    .filter((n): n is DomainLibraryNode => !!n && !existingIds.has(n.id))
    .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
}

/** Map a library node to the real create-domain request body. */
export function toDomainSeedPayload(node: DomainLibraryNode): DomainSeedPayload {
  return {
    id: node.id,
    name: node.name,
    description: node.mission,
    icon: node.icon,
    themeColor: node.color,
    parentId: node.parentId || undefined,
  };
}
