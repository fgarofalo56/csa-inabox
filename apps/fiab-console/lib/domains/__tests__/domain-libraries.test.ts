/**
 * Domain-library registry + seed-plan specs (#1483 Wave 1).
 *
 * Covers:
 *   1. Registry integrity — all curated libraries load, are well-typed, have
 *      non-empty trees, unique node ids, resolvable parents, declared
 *      categories, real Fluent icon names, and valid hex colors.
 *   2. Federal Civilian ZERO-REGRESSION — library #1's nodes/categories are
 *      the EXACT #1481 constants (same array references), so the multi-library
 *      refactor cannot have drifted the original seed content.
 *   3. Seed-plan (the picker's selection→seed wiring) — parent expansion,
 *      existing-id skip, parents-first ordering, and the exact request body
 *      each node POSTs to /api/admin/domains.
 */
import { describe, it, expect } from 'vitest';
import {
  DOMAIN_LIBRARIES, DEFAULT_DOMAIN_LIBRARY_ID, getDomainLibrary,
  FEDERAL_CIVILIAN_LIBRARY, DEFENSE_INTEL_LIBRARY, STATE_LOCAL_LIBRARY, COMMERCIAL_LIBRARY,
  libraryEnterprises, libraryChildren, libraryNode, libraryStats,
  planLibrarySeed, toDomainSeedPayload,
} from '../libraries';
import { FEDCIV_DOMAIN_LIBRARY, FEDCIV_CATEGORIES, FEDCIV_LIBRARY_STATS } from '../fedciv-domain-library';
import { DOMAIN_ICONS } from '../domain-icons';

const HEX_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

describe('domain-library registry (#1483 Wave 1)', () => {
  it('registers the four Wave-1 libraries, Federal Civilian first and default', () => {
    expect(DOMAIN_LIBRARIES.map((l) => l.id)).toEqual([
      'federal-civilian', 'defense-intelligence', 'state-local', 'commercial',
    ]);
    expect(DOMAIN_LIBRARIES[0]).toBe(FEDERAL_CIVILIAN_LIBRARY);
    expect(DEFAULT_DOMAIN_LIBRARY_ID).toBe('federal-civilian');
    // Unknown / missing ids fall back to the default library (never crash).
    expect(getDomainLibrary('nope').id).toBe('federal-civilian');
    expect(getDomainLibrary(null).id).toBe('federal-civilian');
    expect(getDomainLibrary('state-local')).toBe(STATE_LOCAL_LIBRARY);
  });

  for (const lib of DOMAIN_LIBRARIES) {
    describe(`library "${lib.id}"`, () => {
      it('has picker metadata and a real Fluent glyph', () => {
        expect(lib.name.length).toBeGreaterThan(0);
        expect(lib.label.length).toBeGreaterThan(0);
        expect(lib.description.length).toBeGreaterThan(0);
        expect(DOMAIN_ICONS[lib.icon], `library icon "${lib.icon}"`).toBeDefined();
        expect(lib.color).toMatch(HEX_RE);
        for (const key of [
          'enterpriseNoun', 'childNoun', 'drillNoun', 'itemPlural', 'itemSingular', 'searchPlaceholder',
        ] as const) {
          expect(lib.copy[key].length, `copy.${key}`).toBeGreaterThan(0);
        }
      });

      it('has a populated, well-formed tree (no empty trees, no dangling parents)', () => {
        const enterprises = libraryEnterprises(lib);
        const stats = libraryStats(lib);
        expect(enterprises.length).toBeGreaterThan(0);
        expect(stats.children).toBeGreaterThan(0);
        expect(stats.total).toBe(lib.nodes.length);

        const ids = lib.nodes.map((n) => n.id);
        expect(new Set(ids).size, 'node ids unique within library').toBe(ids.length);

        const enterpriseIds = new Set(enterprises.map((n) => n.id));
        for (const n of lib.nodes) {
          expect(n.id, `id "${n.id}"`).toMatch(ID_RE);
          expect(n.name.length).toBeGreaterThan(0);
          expect(n.abbrev.length).toBeGreaterThan(0);
          expect(n.mission.length).toBeGreaterThan(0);
          expect(n.color, `color of ${n.id}`).toMatch(HEX_RE);
          expect(DOMAIN_ICONS[n.icon], `icon "${n.icon}" of ${n.id}`).toBeDefined();
          expect(lib.categories, `category "${n.category}" of ${n.id}`).toContain(n.category);
          if (n.parentId) {
            expect(enterpriseIds.has(n.parentId), `parent "${n.parentId}" of ${n.id} is an enterprise`).toBe(true);
          }
        }

        // Every enterprise with children is reachable via libraryChildren.
        const withChildren = enterprises.filter((e) => libraryChildren(lib, e.id).length > 0);
        expect(withChildren.length).toBeGreaterThan(0);
      });
    });
  }

  it('the three NEW libraries each carry a substantial curated taxonomy', () => {
    expect(libraryStats(DEFENSE_INTEL_LIBRARY).total).toBeGreaterThanOrEqual(50);
    expect(libraryStats(STATE_LOCAL_LIBRARY).total).toBeGreaterThanOrEqual(40);
    expect(libraryStats(COMMERCIAL_LIBRARY).total).toBeGreaterThanOrEqual(40);
    // Spot-check grounded content.
    expect(libraryNode(DEFENSE_INTEL_LIBRARY, 'cybercom')?.parentId).toBe('cocom');
    expect(libraryNode(DEFENSE_INTEL_LIBRARY, 'nsa')?.parentId).toBe('intel-community');
    expect(libraryNode(STATE_LOCAL_LIBRARY, 'sled-dmv')?.parentId).toBe('sled-transportation');
    expect(libraryNode(COMMERCIAL_LIBRARY, 'fn-customer-insights')?.parentId).toBe('fn-customer-360');
  });
});

describe('Federal Civilian zero-regression vs #1481', () => {
  it('nodes and categories ARE the prior constants (same references — content cannot drift)', () => {
    expect(FEDERAL_CIVILIAN_LIBRARY.nodes).toBe(FEDCIV_DOMAIN_LIBRARY);
    expect(FEDERAL_CIVILIAN_LIBRARY.categories).toBe(FEDCIV_CATEGORIES);
  });

  it('stats match the prior FEDCIV_LIBRARY_STATS', () => {
    const stats = libraryStats(FEDERAL_CIVILIAN_LIBRARY);
    expect(stats.enterprises).toBe(FEDCIV_LIBRARY_STATS.enterprises);
    expect(stats.children).toBe(FEDCIV_LIBRARY_STATS.subAgencies);
    expect(stats.total).toBe(FEDCIV_LIBRARY_STATS.total);
  });

  it('helpers reproduce the prior fedCiv* behavior (DHS drill-in example)', () => {
    const dhs = libraryNode(FEDERAL_CIVILIAN_LIBRARY, 'dhs');
    expect(dhs?.abbrev).toBe('DHS');
    const kids = libraryChildren(FEDERAL_CIVILIAN_LIBRARY, 'dhs').map((n) => n.id);
    expect(kids).toContain('cisa');
    expect(kids).toContain('fema');
    expect(libraryEnterprises(FEDERAL_CIVILIAN_LIBRARY).every((n) => !n.parentId)).toBe(true);
  });
});

describe('seed-plan (selection → create-domain wiring)', () => {
  const lib = FEDERAL_CIVILIAN_LIBRARY;
  const none = new Set<string>();

  it('picking a child auto-includes its parent enterprise, ordered parent-first', () => {
    const plan = planLibrarySeed(lib, ['cisa'], none);
    expect(plan.map((n) => n.id)).toEqual(['dhs', 'cisa']);
  });

  it('skips ids that already exist as domains', () => {
    const plan = planLibrarySeed(lib, ['cisa', 'fema'], new Set(['dhs', 'cisa']));
    expect(plan.map((n) => n.id)).toEqual(['fema']);
  });

  it('unknown ids are ignored; empty selection plans nothing', () => {
    expect(planLibrarySeed(lib, ['not-a-node'], none)).toEqual([]);
    expect(planLibrarySeed(lib, [], none)).toEqual([]);
  });

  it('always orders ALL enterprises before ALL children (mixed multi-pick)', () => {
    const plan = planLibrarySeed(lib, ['fema', 'nasa', 'cdc', 'dhs'], none);
    const firstChildIdx = plan.findIndex((n) => !!n.parentId);
    const lastParentIdx = plan.map((n) => !n.parentId).lastIndexOf(true);
    expect(lastParentIdx).toBeLessThan(firstChildIdx === -1 ? plan.length : firstChildIdx + 1);
    expect(plan.filter((n) => !n.parentId).map((n) => n.id).sort()).toEqual(['dhs', 'hhs', 'nasa']);
  });

  it('works identically for the new libraries (Defense & Intelligence example)', () => {
    const plan = planLibrarySeed(DEFENSE_INTEL_LIBRARY, ['nsa', 'dia'], none);
    expect(plan[0].id).toBe('intel-community');
    expect(plan.map((n) => n.id).slice(1).sort()).toEqual(['dia', 'nsa']);
  });

  it('toDomainSeedPayload maps a node to the exact POST /api/admin/domains body', () => {
    const cisa = libraryNode(lib, 'cisa')!;
    expect(toDomainSeedPayload(cisa)).toEqual({
      id: 'cisa',
      name: 'Cybersecurity & Infrastructure Security Agency',
      description: cisa.mission,
      icon: cisa.icon,
      themeColor: cisa.color,
      parentId: 'dhs',
    });
    const dhs = libraryNode(lib, 'dhs')!;
    expect(toDomainSeedPayload(dhs).parentId).toBeUndefined();
  });
});
