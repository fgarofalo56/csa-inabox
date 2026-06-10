/**
 * Pure, dependency-free merge helpers for the data-agent config copilot.
 *
 * Shared by the server tool (`lib/copilot/agent-config-tools.ts`) and the
 * editor panel (`lib/editors/data-agent-config-copilot.tsx`) so the persisted
 * merge and the optimistic local-state merge use the SAME logic (no drift).
 * No Azure SDK imports — safe to bundle client-side.
 */

const DESC_START = '<!-- loom:field-descriptions:start -->';
const DESC_END = '<!-- loom:field-descriptions:end -->';

export interface DaSuggestion {
  examples: { question: string; query: string }[];
  descriptions: Record<string, Record<string, string>>;
}

/** Render a descriptions map into a markdown block (idempotently re-mergeable). */
export function descriptionsToBlock(descriptions: Record<string, Record<string, string>>): string {
  const lines: string[] = [DESC_START];
  for (const [table, cols] of Object.entries(descriptions)) {
    lines.push(`### ${table}`);
    for (const [col, desc] of Object.entries(cols)) lines.push(`- ${col}: ${desc}`);
  }
  lines.push(DESC_END);
  return lines.join('\n');
}

/** Merge a field-descriptions block into existing source instructions (replace prior block if present). */
export function mergeInstructions(existing: string, descriptions: Record<string, Record<string, string>>): string {
  if (!descriptions || !Object.keys(descriptions).length) return existing;
  const block = descriptionsToBlock(descriptions);
  const base = (existing || '').trim();
  const startIdx = base.indexOf(DESC_START);
  if (startIdx >= 0) {
    const endIdx = base.indexOf(DESC_END);
    if (endIdx > startIdx) {
      return (base.slice(0, startIdx) + block + base.slice(endIdx + DESC_END.length)).trim();
    }
  }
  return base ? `${base}\n\n${block}` : block;
}

/**
 * Produce the next `sources` array with the approved suggestion applied to the
 * source whose id matches `sourceId`. Examples replace the source's example
 * pairs; descriptions are written into the source's instructions (and a
 * structured `fieldDescriptions` map for verification).
 */
export function mergeSuggestionIntoSources<T extends Record<string, unknown>>(
  sources: T[],
  sourceId: string,
  approved: Partial<DaSuggestion>,
): T[] {
  return sources.map((s) => {
    if (String((s as any).id) !== String(sourceId)) return s;
    const next: Record<string, unknown> = { ...s };
    if (Array.isArray(approved.examples)) {
      next.examples = approved.examples
        .map((e) => ({ question: String(e?.question ?? '').trim(), query: String(e?.query ?? '').trim() }))
        .filter((e) => e.question && e.query);
    }
    if (approved.descriptions && Object.keys(approved.descriptions).length) {
      next.instructions = mergeInstructions(String((s as any).instructions || ''), approved.descriptions);
      next.fieldDescriptions = approved.descriptions;
    }
    return next as T;
  });
}
