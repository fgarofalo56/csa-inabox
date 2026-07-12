/**
 * Domain-library types — the multi-library shape behind the "Create new
 * domain" picker (issue #1483, Wave 1).
 *
 * A DomainLibrary is a curated, two-level Enterprise → sub-organization tree
 * that seeds Loom domains: picking an enterprise creates a ROOT domain,
 * picking a child creates a SUBDOMAIN under that enterprise (parentId set).
 * The Federal Civilian library (#1481) is library #1; Defense & Intelligence,
 * State & Local Government, and Commercial join it in Wave 1. Wave 2+ adds
 * more libraries by dropping a module into lib/domains/libraries and
 * registering it in index.ts — nothing else changes.
 *
 * Each node carries a Fluent icon NAME (resolved by lib/domains/domain-icons)
 * and a brand-ish hex color. NO copyrighted material: generic Fluent icons +
 * colors as a creative representation — never an official seal or logo.
 */

export interface DomainLibraryNode {
  /** Stable domain id (lowercase, hyphens) — becomes the Loom domain id. */
  id: string;
  /** Display name. */
  name: string;
  /** Common abbreviation / acronym. */
  abbrev: string;
  /** Fluent icon name (see lib/domains/domain-icons DOMAIN_ICONS). */
  icon: string;
  /** Brand-ish theme color (hex). */
  color: string;
  /** Browse-filter category (one of the library's `categories`). */
  category: string;
  /** One-line mission statement (paraphrased; informational). */
  mission: string;
  /** Parent Enterprise id when this is a sub-organization. */
  parentId?: string;
}

/**
 * Per-library UI copy so each library reads naturally in the picker (the
 * Federal library says "agencies"/"bureaus", the Commercial library says
 * "functions"/"capabilities", …) without forking the picker component.
 */
export interface DomainLibraryCopy {
  /** Plural noun for top-level entries, e.g. "departments & independent agencies". */
  enterpriseNoun: string;
  /** Plural noun for child entries, e.g. "sub-agencies". */
  childNoun: string;
  /** Plural noun used in the drill-in hint, e.g. "bureaus". */
  drillNoun: string;
  /** Plural noun for search / validation copy, e.g. "agencies". */
  itemPlural: string;
  /** Singular noun for validation copy, e.g. "agency". */
  itemSingular: string;
  /** SearchBox placeholder, e.g. "Search agencies…". */
  searchPlaceholder: string;
}

export interface DomainLibrary {
  /** Stable library id (lowercase, hyphens). */
  id: string;
  /** Display name shown on the library selector card, e.g. "Federal Civilian". */
  name: string;
  /**
   * Label used in result copy — "Created 3 domains from the {label}."
   * e.g. "Federal agency library".
   */
  label: string;
  /** One-line description shown on the library selector card. */
  description: string;
  /** Fluent icon name for the library selector card glyph. */
  icon: string;
  /** Theme color for the library selector card glyph (hex). */
  color: string;
  /** Ordered browse-filter categories. Every node.category must be listed. */
  categories: readonly string[];
  /** The curated tree (enterprises have no parentId; children reference one). */
  nodes: readonly DomainLibraryNode[];
  copy: DomainLibraryCopy;
}

export interface DomainLibraryStats {
  enterprises: number;
  children: number;
  total: number;
}

/** Top-level enterprises of a library (no parentId), in library order. */
export function libraryEnterprises(lib: DomainLibrary): DomainLibraryNode[] {
  return lib.nodes.filter((n) => !n.parentId);
}

/** Children of a given enterprise id, in library order. */
export function libraryChildren(lib: DomainLibrary, parentId: string): DomainLibraryNode[] {
  return lib.nodes.filter((n) => n.parentId === parentId);
}

/** Look up a node by id within a library. */
export function libraryNode(lib: DomainLibrary, id: string): DomainLibraryNode | undefined {
  return lib.nodes.find((n) => n.id === id);
}

/** Enterprise / child / total counts (for picker copy). */
export function libraryStats(lib: DomainLibrary): DomainLibraryStats {
  const enterprises = lib.nodes.filter((n) => !n.parentId).length;
  return { enterprises, children: lib.nodes.length - enterprises, total: lib.nodes.length };
}
