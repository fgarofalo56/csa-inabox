/**
 * /api/items/data-contract/[id]/introspect  (N6)
 *
 * DERIVE the contract's schema from the BOUND TABLE — a real read, never a
 * hand-typed column list. The bound table is the same Azure Data Explorer
 * database/table the contract already validates against (`state.databaseName` /
 * `state.databaseTable`), and the introspection is the real ADX control command
 * `.show table <T> schema as json` (kusto-client.getTableSchema), mapped from
 * Kusto CSL types onto the typed designer's column types.
 *
 *   POST  body { database?, table? }  → { columns: ContractColumn[], source }
 *
 * The route NEVER writes: it returns the derived columns and the editor merges
 * them into the designer (preserving descriptions/classifications the steward
 * already wrote for columns that still exist), so a re-introspect after a
 * source change is a diff, not a wipe.
 *
 * Azure-native (ADX, no Microsoft Fabric). Honest gate when ADX is not wired:
 * a 503 naming the exact env var + the bicep module that deploys the cluster.
 * **IL5**: ADX is in-boundary; introspection runs disconnected.
 */
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { adxConfigGate } from '@/lib/azure/data-quality-client';
import { defaultDatabase, getTableSchema } from '@/lib/azure/kusto-client';
import { CONTRACT_COLUMN_TYPES, type ContractColumn, type ContractColumnType } from '@/lib/dataproducts/contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-contract';

/**
 * Kusto CSL / .NET type → the typed designer's column type. Grounded in the
 * ADX scalar data-type table (`System.*` CLR names are what `.show table schema
 * as json` emits; `CslType` carries the short KQL name).
 */
export function contractTypeFromKusto(cslType: string, clrType?: string): ContractColumnType {
  const t = String(cslType || '').trim().toLowerCase();
  const clr = String(clrType || '').trim().toLowerCase();
  const map: Record<string, ContractColumnType> = {
    string: 'string',
    int: 'integer',
    long: 'bigint',
    real: 'double',
    double: 'double',
    decimal: 'decimal',
    bool: 'boolean',
    boolean: 'boolean',
    datetime: 'timestamp',
    date: 'date',
    timespan: 'string',
    guid: 'string',
    uuid: 'string',
    dynamic: 'variant',
  };
  if (map[t]) return map[t];
  const clrMap: Record<string, ContractColumnType> = {
    'system.string': 'string',
    'system.int32': 'integer',
    'system.int64': 'bigint',
    'system.double': 'double',
    'system.single': 'double',
    'system.data.sqltypes.sqldecimal': 'decimal',
    'system.boolean': 'boolean',
    'system.datetime': 'timestamp',
    'system.timespan': 'string',
    'system.guid': 'string',
    'system.object': 'variant',
  };
  if (clrMap[clr]) return clrMap[clr];
  return (CONTRACT_COLUMN_TYPES as readonly string[]).includes(t) ? (t as ContractColumnType) : 'string';
}

interface KustoSchemaColumn { Name?: string; Type?: string; CslType?: string; DocString?: string }

export const POST = withWorkspaceOwner(ITEM_TYPE, async (req, { item }) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
  const state = (item.state || {}) as Record<string, unknown>;
  const database = String(body.database || state.databaseName || '').trim() || defaultDatabase();
  const table = String(body.table || state.databaseTable || '').trim();

  const gate = adxConfigGate();
  if (gate) {
    return apiError(
      `Azure Data Explorer is not configured in this deployment — set ${gate.missing} on the loom-console container env ` +
      '(deployed by platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep) so the contract can introspect its bound table.',
      503,
      { gate: { missing: gate.missing } },
    );
  }
  if (!table) {
    return apiError('Bind a table on the contract (or pass { database, table }) before deriving its schema.', 400, { gate: { table: true } });
  }

  try {
    const raw = (await getTableSchema(database, table)) as { OrderedColumns?: KustoSchemaColumn[]; Columns?: KustoSchemaColumn[] } | null;
    const cols = (raw?.OrderedColumns || raw?.Columns || []) as KustoSchemaColumn[];
    const columns: ContractColumn[] = cols
      .map((c) => {
        const name = String(c?.Name || '').trim();
        if (!name) return null;
        const col: ContractColumn = { name, type: contractTypeFromKusto(String(c?.CslType || ''), String(c?.Type || '')) };
        const doc = String(c?.DocString || '').trim();
        if (doc) col.description = doc;
        return col;
      })
      .filter((c): c is ContractColumn => c !== null);

    if (!columns.length) {
      return apiError(
        `Azure Data Explorer returned no columns for ${database}.${table} — confirm the table exists and the console identity has Database Viewer on it.`,
        404,
      );
    }
    return apiOk({ database, table, columns, source: `adx:.show table ${table} schema as json` });
  } catch (e) {
    return apiServerError(e, `could not introspect ${database}.${table}`, 'contract_introspect_failed');
  }
});
