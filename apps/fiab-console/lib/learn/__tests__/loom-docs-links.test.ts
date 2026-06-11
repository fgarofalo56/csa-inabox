/**
 * Learn-portal link integrity — enforces the "Loom docs PRIMARY, MS Learn
 * SECONDARY" contract and guards against doc drift (audit-T43).
 *
 * Per .claude/rules/no-vaporware.md a card may NOT advertise a Loom doc that
 * doesn't exist. This suite walks every Learn topic the portal renders
 * (`getCoreSurfaceTutorials()` + `getLearnCatalog()`) and asserts:
 *
 *   1. Every `hasLoomDoc: true` primary link resolves to a real published
 *      MkDocs page on disk (`docs/<path>.md` or `docs/<path>/index.md`) — so a
 *      slug added to EDITOR_DOC_SLUGS / a new use-case / tutorial without its
 *      backing doc FAILS the build instead of shipping a 404.
 *   2. A primary link that points INTO the Loom docs site is never mislabelled
 *      "MS Learn" (the regression fixed alongside this test), and a doc-less
 *      card is never mislabelled "Loom guide".
 *   3. Every secondary MS-Learn link is a real absolute https URL (no fabricated
 *      relative links).
 *   4. `loomDocBacklog()` exactly matches the set of doc-less editor guides the
 *      catalog surfaces — keeping the tracked backlog honest, not stale.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getLearnCatalog,
  loomDocBacklog,
  LOOM_DOCS_BASE,
  type LearnTopic,
} from '@/lib/learn/content';
import { getCoreSurfaceTutorials } from '@/lib/components/learn/core-surface-tutorials';

/** Walk up from this file until we find the repo root (the dir with mkdocs.yml). */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, 'mkdocs.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate repo root (mkdocs.yml) from ' + __dirname);
}

const DOCS = path.join(repoRoot(), 'docs');

/** Strip LOOM_DOCS_BASE + slashes → the relative MkDocs path for a primary URL. */
function relFromPrimary(url: string): string {
  return url.replace(LOOM_DOCS_BASE, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** True when a MkDocs dir-URL relative path has a backing source page on disk. */
function docExists(rel: string): boolean {
  return (
    fs.existsSync(path.join(DOCS, `${rel}.md`)) ||
    fs.existsSync(path.join(DOCS, rel, 'index.md'))
  );
}

const allTopics: LearnTopic[] = [...getCoreSurfaceTutorials(), ...getLearnCatalog()];
const loomBackedTopics = allTopics.filter((t) => t.hasLoomDoc);

describe('Learn portal — Loom-docs-first link integrity', () => {
  it('renders a non-trivial catalog', () => {
    expect(allTopics.length).toBeGreaterThan(50);
    expect(loomBackedTopics.length).toBeGreaterThan(0);
  });

  it.each(loomBackedTopics.map((t) => [t.id, t.primaryUrl] as const))(
    'primary Loom doc for %s resolves to a real published page (%s)',
    (_id, primaryUrl) => {
      // hasLoomDoc primaries must live under the Loom docs site…
      expect(primaryUrl.startsWith(LOOM_DOCS_BASE)).toBe(true);
      // …and the backing source page must exist on disk.
      const rel = relFromPrimary(primaryUrl);
      expect(rel.length).toBeGreaterThan(0);
      expect(docExists(rel)).toBe(true);
    },
  );

  it('never mislabels a link (Loom URL ≠ "MS Learn"; doc-less ≠ "Loom guide")', () => {
    for (const t of allTopics) {
      const isLoomUrl = t.primaryUrl.startsWith(LOOM_DOCS_BASE);
      if (isLoomUrl) {
        expect(t.primaryLabel).not.toBe('MS Learn');
      }
      if (!t.hasLoomDoc) {
        expect(t.primaryLabel).not.toBe('Loom guide');
      }
    }
  });

  it('every secondary MS-Learn link is a real absolute https URL', () => {
    for (const t of allTopics) {
      if (t.msLearnUrl) {
        expect(t.msLearnUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it('loomDocBacklog() matches the doc-less editor guides the catalog surfaces', () => {
    const backlog = new Set(loomDocBacklog());
    const docLessEditorSlugs = new Set(
      getLearnCatalog()
        .filter((t) => t.section === 'Editor guides' && !t.hasLoomDoc)
        .map((t) => t.id.replace(/^editor:/, '')),
    );
    expect([...backlog].sort()).toEqual([...docLessEditorSlugs].sort());
  });
});
