/**
 * maintainTableDef -- the Maintain dialog's column list follows the key the
 * Tables pane sets.
 *
 * The Tables pane sets `maintainTable` to a bundle table's name (the seeded
 * Maintain... entry) or to `<schema>/<table>` (the schema-enabled button). The
 * previous lookup matched the name or its leaf only, so `sales/orders` found
 * nothing and the dialog opened with no Z-ORDER column choices.
 *
 * What breaks each case is named at the assertion.
 */
import { describe, it, expect } from 'vitest';
import { maintainTableDef } from '../shared';

const ORDERS_SALES = { name: 'orders', schema: 'sales', ddl: 'CREATE TABLE orders (id INT)' };
const ORDERS_DBO = { name: 'orders', ddl: 'CREATE TABLE orders (order_id INT)' };
const CUSTOMERS = { name: 'Tables/customers', ddl: 'CREATE TABLE customers (id INT)' };

describe('maintainTableDef', () => {
  it('finds a schema table by the `<schema>/<table>` key the schema-enabled button sets', () => {
    // Breaks if the lookup goes back to name/leaf only: 'sales/orders' is
    // neither a table name nor a leaf, so the old find returned undefined.
    expect(maintainTableDef([ORDERS_DBO, ORDERS_SALES], 'sales/orders')).toBe(ORDERS_SALES);
  });

  it('reads a table with no schema as dbo, and does not pick it for another schema', () => {
    // Breaks if the schema default is dropped (a schemaless table never matches 'dbo/...').
    expect(maintainTableDef([ORDERS_DBO], 'dbo/orders')).toBe(ORDERS_DBO);
    // Breaks if the schema half of the key is ignored (this would return ORDERS_DBO).
    expect(maintainTableDef([ORDERS_DBO], 'finance/orders')).toBeUndefined();
  });

  it('matches the schema case-insensitively', () => {
    // Breaks if the schema comparison is case-sensitive ('SALES' vs 'sales').
    expect(maintainTableDef([ORDERS_SALES], 'SALES/orders')).toBe(ORDERS_SALES);
  });

  it('still finds a bundle table by its name or its leaf (the seeded Maintain... entry)', () => {
    // Breaks if the exact-name arm is removed.
    expect(maintainTableDef([CUSTOMERS], 'Tables/customers')).toBe(CUSTOMERS);
    // Breaks if the leaf arm is removed.
    expect(maintainTableDef([CUSTOMERS], 'customers')).toBe(CUSTOMERS);
  });

  it('returns nothing for an empty key or an unknown table', () => {
    // Breaks if an empty key falls through to a match (e.g. a leaf of '').
    expect(maintainTableDef([{ name: '', ddl: '' }], '')).toBeUndefined();
    // Documentation, not coverage: a leading slash yields an empty schema, and
    // no table reads as an empty schema (a missing one reads as 'dbo'), so
    // loosening `slash <= 0` to `slash < 0` returns undefined here as well.
    expect(maintainTableDef([ORDERS_DBO], '/orders')).toBeUndefined();
    // Breaks if the table half is ignored (would return ORDERS_SALES).
    expect(maintainTableDef([ORDERS_SALES], 'sales/returns')).toBeUndefined();
  });
});
