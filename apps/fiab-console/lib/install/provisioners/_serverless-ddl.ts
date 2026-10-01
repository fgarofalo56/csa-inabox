/**
 * Synapse serverless DDL the install provisioners run (lakehouse.ts,
 * synapse-serverless-sql-pool.ts).
 *
 * Values in nested dynamic SQL are escaped for each literal level: a value in
 * `EXEC('… ''<value>'' …')` sits inside two literals and goes through
 * `sqlLiteralAt(value, 2)`; a name in `EXEC('… <name> …')` or `N'<name>'` sits
 * inside one. A bracketed identifier inside a literal doubles `]` for the
 * identifier and then each quote per literal level (`bracketAt`).
 */
import { bracket, bracketAt, sqlLiteralAt } from '@/lib/sql/quoting';

/** The fixed OPENROWSET options for a shortcut dataset file, written for their place inside `EXEC('…')`. */
const FILE_FORMAT_CLAUSE: Record<'csv' | 'json', string> = {
  json: `FORMAT = ''CSV'', FIELDTERMINATOR = ''0x0b'', FIELDQUOTE = ''0x0b''`,
  csv: `FORMAT = ''CSV'', PARSER_VERSION = ''2.0'', HEADER_ROW = TRUE`,
};

/**
 * (Re)create the view `obj` over one uploaded file. `obj` is the two-part name
 * the provisioner reports (`lakehouse.<leaf>`, restricted to `[A-Za-z0-9_.]`),
 * used unbracketed as before.
 */
export function shortcutFileViewDdl(obj: string, httpsUrl: string, fmt: 'csv' | 'json'): string {
  return (
    `IF SCHEMA_ID('lakehouse') IS NULL EXEC('CREATE SCHEMA lakehouse');\n` +
    `IF OBJECT_ID('${sqlLiteralAt(obj, 1)}','V') IS NOT NULL DROP VIEW ${obj};\n` +
    `EXEC('CREATE VIEW ${sqlLiteralAt(obj, 1)} AS SELECT * FROM OPENROWSET(BULK ''${sqlLiteralAt(httpsUrl, 2)}'', ` +
    `${FILE_FORMAT_CLAUSE[fmt]}) AS r');`
  );
}

/**
 * (Re)create the view `[schema].[leaf]` over a Delta table directory.
 * `SCHEMA_ID()` takes the schema NAME as a string; `OBJECT_ID()` parses a
 * multi-part name, so it gets the bracketed form.
 */
export function deltaTableViewDdl(schema: string, leaf: string, httpsUrl: string): string {
  const objInLiteral = `${bracketAt(schema, 1)}.${bracketAt(leaf, 1)}`;
  return (
    `IF SCHEMA_ID('${sqlLiteralAt(schema, 1)}') IS NULL EXEC('CREATE SCHEMA ${bracketAt(schema, 1)}');\n` +
    `IF OBJECT_ID('${objInLiteral}','V') IS NOT NULL DROP VIEW ${bracket(schema)}.${bracket(leaf)};\n` +
    `EXEC('CREATE VIEW ${objInLiteral} AS SELECT * FROM OPENROWSET(BULK ''${sqlLiteralAt(httpsUrl, 2)}'', ` +
    `FORMAT = ''DELTA'') AS r');`
  );
}

/** (Re)create the external data source `name` over `location` with the workspace-identity credential. */
export function externalDataSourceDdl(name: string, location: string): string {
  return (
    `IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'${sqlLiteralAt(name, 1)}')\n` +
    `  EXEC('DROP EXTERNAL DATA SOURCE ${bracketAt(name, 1)}');\n` +
    `EXEC('CREATE EXTERNAL DATA SOURCE ${bracketAt(name, 1)} WITH (LOCATION = ''${sqlLiteralAt(location, 2)}'', ` +
    `CREDENTIAL = [WorkspaceIdentity])');`
  );
}
