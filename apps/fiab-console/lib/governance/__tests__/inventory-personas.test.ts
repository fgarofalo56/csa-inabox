/**
 * governance_inventory must be CALLABLE by the personas that can already list
 * workspaces: a tool missing from a persona's toolCatalog is never advertised to
 * the model, so the operator Copilot could not use it at all.
 */
import { describe, it, expect } from 'vitest';
import { PERSONA_REGISTRY } from '@/lib/azure/copilot-personas';
import { buildDefaultRegistry } from '@/lib/azure/copilot-orchestrator';

const advertised = (catalog: string[]) =>
  (buildDefaultRegistry().toAoaiToolsByName(catalog) as Array<{ function: { name: string } }>).map((t) => t.function.name);

describe('governance_inventory persona reachability', () => {
  const withWorkspaceList = Object.entries(PERSONA_REGISTRY).filter(([, p]) => p.toolCatalog.includes('workspace_list'));

  it('the population is non-trivial (a filter that matched nothing would make the loop below vacuous)', () => {
    expect(withWorkspaceList.length).toBeGreaterThanOrEqual(7);
  });

  it.each(withWorkspaceList)('persona %s advertises governance_inventory through the real registry', (_slug, p) => {
    // Break value: a persona whose catalog lacks the name gets it filtered out here.
    expect(p.toolCatalog).toContain('governance_inventory');
    expect(advertised(p.toolCatalog)).toContain('governance_inventory');
  });

  it('is not added where item_list / workspace_list are absent, and the default persona (all tools) still has it', () => {
    for (const [slug, p] of Object.entries(PERSONA_REGISTRY)) {
      if (!p.toolCatalog.includes('workspace_list') && p.toolCatalog.length > 0) {
        expect(p.toolCatalog, slug).not.toContain('governance_inventory');
      }
    }
    expect(PERSONA_REGISTRY.default.toolCatalog).toEqual([]);
    expect(advertised([])).toContain('governance_inventory');
  });

  it('the tool is read-only: only the list-style arguments, no confirm / write parameters', () => {
    const t = buildDefaultRegistry().get('governance_inventory')!;
    expect(Object.keys((t.parameters as any).properties).sort()).toEqual(
      ['cursor', 'itemType', 'pageSize', 'resolverStatus', 'scope', 'workspaceId'],
    );
  });
});
