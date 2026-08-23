/**
 * LOOM BRAIN — extractor: source imports → `imports` edges.
 *
 * PURE. Takes module source text a caller has already read.
 *
 * ── WHAT THIS PROVENANCE IS FOR ────────────────────────────────────────────
 * PRP §3.1 names the case: `_arm-absence.mjs` was found to be import-reachable
 * but never argv-invoked. That is a shape only an import graph can express —
 * "something imports it" and "anything RUNS it" are different questions, and a
 * module that is imported by exactly one thing which is itself never entered is
 * dead code that every text search says is alive.
 *
 * So `imports` edges answer reachability-from-an-entry-point, and they are kept
 * a distinct provenance from `configured` for the same reason `declared` is: a
 * module with an inbound `imports` edge is REFERENCED, which is not the same as
 * EXECUTED, which is what `observed` would tell you.
 *
 * ── RESOLUTION IS DELIBERATELY LIMITED, AND SAYS SO ────────────────────────
 * Relative specifiers (`./x`, `../y/z`) are resolved against the importing
 * module's directory and are reliable. Bare specifiers (`react`, `@/lib/foo`)
 * are NOT resolved here: doing it properly needs tsconfig `paths`, package
 * `exports` and the node resolution algorithm, and a half-implementation would
 * silently mis-resolve some fraction of them into edges pointing at the wrong
 * module. Bare specifiers are recorded in `skipped` with the specifier verbatim,
 * so the gap is measured rather than assumed away.
 *
 * The `@/` alias IS handled, because this repo pins it in tsconfig to the
 * console root and it is unambiguous.
 */

import type {
  CodeModuleNode,
  ExtractionResult,
  PendingEdge,
  SkippedSubject,
} from '../../types';
import { canonicalPath, codeModuleNodeId } from '../node-id';
import { makePopulation } from '../graph';

/** One source module to scan. */
export interface SourceModuleInput {
  /** Repo-relative path, forward slashes, e.g. 'apps/fiab-console/lib/brain/types.ts'. */
  readonly path: string;
  readonly text: string;
}

export interface SourceImportOptions {
  /**
   * Repo-relative root the `@/` alias maps to, e.g. 'apps/fiab-console'.
   * Omit to record every `@/` specifier as skipped rather than guess.
   */
  readonly aliasRoot?: string;
  /**
   * Extensions tried, in order, when a specifier has none. The resolved target
   * is the first candidate present in `knownPaths`; if none is, the edge is
   * emitted UNRESOLVED rather than pointed at a guess.
   */
  readonly extensions?: readonly string[];
  /**
   * Every module path in scope. Used to pick the right extension and to tell
   * "this import targets a module we did not scan" from "this import targets
   * nothing". Omit and extension resolution falls back to the first candidate.
   */
  readonly knownPaths?: readonly string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx'] as const;

/** `import ... from 'x'`, `export ... from 'x'`, `import('x')`, `require('x')`. */
const SPECIFIER_RES: readonly RegExp[] = [
  /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Resolve `./x` / `../x` against the importing module's directory. */
function resolveRelative(fromPath: string, specifier: string): string {
  const dir = canonicalPath(fromPath).split('/').slice(0, -1);
  const parts = specifier.split('/');
  const out = [...dir];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Line number (1-based) of a character offset. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n += 1;
  return n;
}

export function extractFromSourceImports(
  modules: readonly SourceModuleInput[],
  options: SourceImportOptions = {},
): ExtractionResult {
  const nodes: CodeModuleNode[] = [];
  const edges: PendingEdge[] = [];
  const skipped: SkippedSubject[] = [];
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const known = new Set((options.knownPaths ?? modules.map((m) => m.path)).map((p) => canonicalPath(p)));
  let specifiersSeen = 0;

  for (const m of modules) {
    nodes.push({
      id: codeModuleNodeId(m.path),
      kind: 'code-module',
      displayName: m.path.split('/').pop() ?? m.path,
      source: 'source-imports',
      path: canonicalPath(m.path),
    });
  }

  for (const m of modules) {
    const from = codeModuleNodeId(m.path);
    // Normalize line endings so offsets and line numbers agree regardless of
    // whether git handed us CRLF or LF.
    const text = m.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const seen = new Set<string>();

    for (const re of SPECIFIER_RES) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const specifier = match[1]!;
        const key = `${specifier}@${match.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        specifiersSeen += 1;
        const line = lineAt(text, match.index);

        let base: string | null = null;
        if (specifier.startsWith('.')) {
          base = resolveRelative(m.path, specifier);
        } else if (specifier.startsWith('@/')) {
          if (options.aliasRoot) {
            base = `${canonicalPath(options.aliasRoot)}/${specifier.slice(2)}`;
          } else {
            skipped.push({
              subject: `${m.path}:${line} ${specifier}`,
              reason:
                "'@/' alias specifier and no aliasRoot supplied. NOT resolved — recording the gap " +
                'rather than guessing a root that would produce edges to the wrong modules.',
            });
            continue;
          }
        } else {
          skipped.push({
            subject: `${m.path}:${line} ${specifier}`,
            reason:
              'bare specifier (package or tsconfig path). Resolving it correctly needs tsconfig ' +
              '`paths`, package `exports` and node resolution; a partial implementation would ' +
              'mis-resolve some fraction into edges pointing at the wrong module.',
          });
          continue;
        }

        // Pick the extension that actually exists in scope. Without a match the
        // edge is still emitted, unresolved, so a reference to a module outside
        // the scanned set is visible rather than silently dropped.
        let target = base;
        if (!known.has(base)) {
          const hit = extensions.map((e) => `${base}${e}`).find((c) => known.has(c));
          if (hit) target = hit;
        }

        edges.push({
          provenance: 'imports',
          from,
          targetRef: target,
          emptyValue: false,
          intendedTo: known.has(target) ? codeModuleNodeId(target) : null,
          evidence: {
            artifact: canonicalPath(m.path),
            line,
            symbol: specifier,
            rawValue: specifier,
            extractor: 'source-imports',
          },
        });
      }
    }
  }

  return {
    source: 'source-imports',
    nodes,
    edges,
    population: makePopulation({
      subject: 'edges',
      nodes,
      edges: [],
      scope:
        `${modules.length} module(s); ${specifiersSeen} import specifier(s) examined; ` +
        `${edges.length} imports edge(s) emitted; ${skipped.length} skipped (bare/alias specifiers)`,
    }),
    skipped,
  };
}
