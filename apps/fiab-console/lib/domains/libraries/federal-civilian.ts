/**
 * Federal Civilian library — library #1 in the multi-library domain designer.
 *
 * The DATA is the exact #1481 catalog, re-exported by reference from
 * lib/domains/fedciv-domain-library so the multi-library refactor cannot
 * drift the seed content: `nodes` IS `FEDCIV_DOMAIN_LIBRARY` (same array),
 * `categories` IS `FEDCIV_CATEGORIES`. Zero-regression is asserted by
 * lib/domains/__tests__/domain-libraries.test.ts.
 */
import type { DomainLibrary } from './types';
import { FEDCIV_DOMAIN_LIBRARY, FEDCIV_CATEGORIES } from '../fedciv-domain-library';

export const FEDERAL_CIVILIAN_LIBRARY: DomainLibrary = {
  id: 'federal-civilian',
  name: 'Federal Civilian',
  label: 'Federal agency library',
  description: 'Cabinet departments, independent agencies, and their bureaus.',
  icon: 'building-government',
  color: '#003f7d',
  categories: FEDCIV_CATEGORIES,
  nodes: FEDCIV_DOMAIN_LIBRARY,
  copy: {
    enterpriseNoun: 'departments & independent agencies',
    childNoun: 'sub-agencies',
    drillNoun: 'bureaus',
    itemPlural: 'agencies',
    itemSingular: 'agency',
    searchPlaceholder: 'Search agencies…',
  },
};
