// ============================================================
// kql-tools — KQL Copilot tool registry.
//
// Exports:
//   KQL_TOOL_NAMES          — const tuple of the four KQL tool names
//   buildKqlToolRegistry()  — LoomToolRegistry scoped to ADX/KQL ops
//   buildSchemaContext(db)  — schema-grounding string (soft-fail, 8 000 cap)
//
// Every tool calls a kusto-client function directly — no new Azure SDK
// surface beyond what kusto-client already uses. Auth (UAMI
// AllDatabasesAdmin via ChainedTokenCredential) is handled inside
// kusto-client. No mocks: each call hits the real ADX cluster via
// `/v1/rest/query` + `/v1/rest/mgmt`.
//
// The persona's allowedTools list (lib/azure/copilot-personas.ts,
// KQL_COPILOT_PERSONA.allowedTools) MUST stay in sync with
// KQL_TOOL_NAMES — copilot-personas.test.ts asserts this.
// ============================================================

import { LoomToolRegistry, type ToolDef } from '@/lib/azure/copilot-orchestrator';
import {
  executeQuery,
  executeMgmtCommand,
  listDatabases,
  listTables,
  getDatabaseSchemaJson,
  kustoConfigGate,
} from '@/lib/azure/kusto-client';

const S_STRING = { type: 'string' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

export const KQL_TOOL_NAMES = [
  'kql_list_databases',
  'kql_list_tables',
  'kql_get_schema',
  'kql_execute',
] as const;

export type KqlToolName = (typeof KQL_TOOL_NAMES)[number];

/**
 * Build the KQL Copilot tool registry (scoped to ADX / KQL operations).
 *
 * Each tool wraps the matching kusto-client function. The config gate is
 * checked SOFT — when `LOOM_KUSTO_CLUSTER_URI` is unset the tool returns a
 * `{ gated, missing }` shape rather than throwing, so the orchestrator can
 * surface the honest gate to the user without crashing the tool loop
 * (per no-vaporware.md).
 */
export function buildKqlToolRegistry(): LoomToolRegistry {
  const r = new LoomToolRegistry();

  const gate = () => kustoConfigGate();

  const tools: ToolDef[] = [
    {
      name: 'kql_list_databases',
      service: 'ADX',
      description:
        'List databases on the Loom ADX cluster. Returns [{name, prettyName, persistentStorage}]. ' +
        'Use to discover which database to target before generating KQL.',
      parameters: obj({}),
      handler: async () => {
        const g = gate();
        if (g) return { gated: true, missing: g.missing };
        return listDatabases();
      },
    },
    {
      name: 'kql_list_tables',
      service: 'ADX',
      description:
        'List tables in an ADX database. Returns [{name, folder, docString}]. ' +
        'Use before kql_get_schema to confirm which tables exist.',
      parameters: obj({ database: { ...S_STRING, description: 'ADX database name' } }, ['database']),
      handler: async ({ database }: { database: string }) => {
        const g = gate();
        if (g) return { gated: true, missing: g.missing };
        return listTables(String(database));
      },
    },
    {
      name: 'kql_get_schema',
      service: 'ADX',
      description:
        'Get the full schema for an ADX database as JSON (tables, columns, column types). ' +
        'ALWAYS call this before generating any KQL so column names are real and correct. ' +
        'Returns the parsed schema from `.show database <db> schema as json`.',
      parameters: obj({ database: { ...S_STRING, description: 'ADX database name' } }, ['database']),
      handler: async ({ database }: { database: string }) => {
        const g = gate();
        if (g) return { gated: true, missing: g.missing };
        return getDatabaseSchemaJson(String(database));
      },
    },
    {
      name: 'kql_execute',
      service: 'ADX',
      description:
        'Execute a KQL query or management command against an ADX database. Queries (no ' +
        'leading dot) run via /v1/rest/query; commands starting with "." run via /v1/rest/mgmt. ' +
        'Returns {columns, columnTypes, rows, rowCount, ...}. Use this to validate that ' +
        'generated KQL returns real rows.',
      parameters: obj(
        {
          database: { ...S_STRING, description: 'ADX database name' },
          kql: { ...S_STRING, description: 'KQL query or management command to execute' },
        },
        ['database', 'kql'],
      ),
      handler: async ({ database, kql }: { database: string; kql: string }) => {
        const g = gate();
        if (g) return { gated: true, missing: g.missing };
        const text = String(kql);
        const isMgmt = text.trimStart().startsWith('.');
        return isMgmt
          ? executeMgmtCommand(String(database), text)
          : executeQuery(String(database), text);
      },
    },
  ];

  for (const t of tools) r.register(t);
  return r;
}

/**
 * Build the schema-context string for a persona system prompt.
 *
 * Issues `.show database <db> schema as json` against the live cluster
 * (via getDatabaseSchemaJson) and stringifies the result. Soft-fails to an
 * empty string when the cluster is cold / the database is not provisioned —
 * the persona then continues WITHOUT grounding rather than blocking the chat.
 * Caps at 8 000 chars to stay within the AOAI context budget.
 */
export async function buildSchemaContext(database: string): Promise<string> {
  try {
    const schema = await getDatabaseSchemaJson(database);
    if (!schema) return '';
    const str = typeof schema === 'string' ? schema : JSON.stringify(schema);
    return str.length > 8_000 ? `${str.slice(0, 8_000)}\n…(schema truncated)` : str;
  } catch {
    return '';
  }
}
