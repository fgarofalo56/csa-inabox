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

/** Depth of a node in the library tree (root = 1), cycle-guarded. */
function nodeDepth(lib: DomainLibrary, id: string): number {
  const seen = new Set<string>();
  let depth = 1;
  let cur = libraryNode(lib, id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = libraryNode(lib, cur.parentId);
    if (!cur) break;
    depth += 1;
  }
  return depth;
}

/**
 * Plan which library nodes to create for a picked selection: expand the FULL
 * ancestor chain of each pick (a deep node cannot be created without every
 * ancestor above it — #1483 Wave 2 arbitrary depth), drop already-existing ids,
 * and order shallowest-first so each POST's parentId always references an
 * already-created (or pre-existing) domain.
 */
export function planLibrarySeed(
  lib: DomainLibrary,
  pickedIds: Iterable<string>,
  existingIds: ReadonlySet<string>,
): DomainLibraryNode[] {
  const toCreate = new Set<string>();
  for (const id of pickedIds) {
    // Walk up from the pick, adding every ancestor (cycle-guarded).
    const seen = new Set<string>();
    let cur = libraryNode(lib, id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      toCreate.add(cur.id);
      cur = cur.parentId ? libraryNode(lib, cur.parentId) : undefined;
    }
  }
  return Array.from(toCreate)
    .map((id) => libraryNode(lib, id))
    .filter((n): n is DomainLibraryNode => !!n && !existingIds.has(n.id))
    .sort((a, b) => nodeDepth(lib, a.id) - nodeDepth(lib, b.id));
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
