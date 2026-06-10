/**
 * Dependency-free parse helper for bulk AI auto-description replies.
 *
 * Kept in its own module (no `@azure/identity` import) so it is unit-testable in
 * isolation — mirrors the dax-probe.ts split. Imported by bulk-describe.ts.
 */

export interface DescribeProposal {
  /** Object name (measure name, or "Table.Column" for a column). */
  name: string;
  /** Generated 1-2 sentence business-friendly description. */
  description: string;
}

/** Parse the model's `{ items: [{ name, description }] }` reply defensively. */
export function parseDescribeReply(raw: string): DescribeProposal[] {
  try {
    const parsed = JSON.parse(raw || '{}');
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed?.items ?? parsed?.measures ?? parsed?.columns ?? parsed?.descriptions ?? []);
    return (Array.isArray(arr) ? arr : [])
      .filter((p: any) => p && typeof p.name === 'string' && typeof p.description === 'string')
      .map((p: any) => ({ name: String(p.name), description: String(p.description).trim() }));
  } catch {
    return [];
  }
}
