/**
 * sql-templates — shared T-SQL authoring constants + pure helpers used by the
 * SQL database object navigator ({@link ../components/sqldb/sqldb-tree}) and the
 * Monaco T-SQL query editor ({@link ../editors/components/tsql-monaco}).
 *
 * These mirror the Microsoft Fabric SQL database **query editor** affordances
 * (https://learn.microsoft.com/fabric/database/sql/query-editor):
 *   - the "New SQL query" split-button template menu (CREATE TABLE / VIEW /
 *     PROCEDURE / INDEX / FUNCTION), and
 *   - the inline SQL **code-snippet** list shown when you type `sql` in the
 *     editor body.
 *
 * Everything here is theme-agnostic, Fabric-agnostic, and Azure-native: the
 * templates produce plain T-SQL that runs through the existing Azure SQL TDS
 * query route. No Fabric workspace, capacity, or REST host is required.
 *
 * The helpers ({@link chooseRunText}, {@link parseDottedReference},
 * {@link shouldOfferSnippets}) are pure so they are unit-testable without a
 * Monaco/DOM environment.
 */

export type CreatableGroup = 'table' | 'view' | 'procedure' | 'function' | 'index';

/**
 * The five "New" templates exposed by the Fabric query editor's split button.
 * Each is valid, runnable T-SQL the user edits in place — never a fake form.
 */
export const CREATE_TEMPLATES: Record<CreatableGroup, string> = {
  table:
`-- New table. Edit and run from the Query tab.
CREATE TABLE dbo.NewTable (
    Id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Name      NVARCHAR(200)     NOT NULL,
    CreatedAt DATETIME2         NOT NULL DEFAULT SYSUTCDATETIME()
);`,
  view:
`-- New view. Edit and run from the Query tab.
CREATE VIEW dbo.NewView
AS
SELECT TOP 100 *
FROM dbo.NewTable;`,
  procedure:
`-- New stored procedure. Edit and run from the Query tab.
CREATE PROCEDURE dbo.NewProcedure
    @Id INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM dbo.NewTable WHERE Id = @Id;
END;`,
  function:
`-- New inline table-valued function. Edit and run from the Query tab.
CREATE FUNCTION dbo.NewFunction (@Id INT)
RETURNS TABLE
AS
RETURN (
    SELECT * FROM dbo.NewTable WHERE Id = @Id
);`,
  index:
`-- New index. Edit and run from the Query tab.
CREATE INDEX IX_NewTable_Name
ON dbo.NewTable (Name ASC);`,
};

/** Human label shown in the split-button menu for each template. */
export const CREATE_TEMPLATE_LABELS: Record<CreatableGroup, string> = {
  table: 'Table',
  view: 'View',
  procedure: 'Stored procedure',
  index: 'Index',
  function: 'Function',
};

/**
 * A single SQL code snippet, offered inline when the user types `sql`. `body`
 * uses Monaco snippet syntax (`${1:placeholder}`, `$0` final cursor) so Tab
 * cycles the edit points — matching the Fabric query-editor snippet list.
 */
export interface SqlSnippet {
  /** The token the user types / sees in the completion list (all start `sql`). */
  label: string;
  /** One-line description shown in the completion detail. */
  documentation: string;
  /** Monaco snippet-syntax body inserted on accept. */
  body: string;
}

/**
 * The inline snippet catalog. Labels intentionally start with `sql` so the
 * snippet provider can offer them the moment the user types that prefix — the
 * exact Fabric behavior. Bodies are real, runnable T-SQL.
 */
export const SQL_SNIPPETS: SqlSnippet[] = [
  {
    label: 'sqlSelect',
    documentation: 'SELECT TOP n columns FROM a table with an ORDER BY',
    body: 'SELECT TOP ${1:1000} *\nFROM ${2:dbo.TableName}\nORDER BY ${3:Id} DESC;$0',
  },
  {
    label: 'sqlSelectWhere',
    documentation: 'SELECT … WHERE filter',
    body: 'SELECT ${1:*}\nFROM ${2:dbo.TableName}\nWHERE ${3:Column} = ${4:@value};$0',
  },
  {
    label: 'sqlInsert',
    documentation: 'INSERT INTO … VALUES',
    body: 'INSERT INTO ${1:dbo.TableName} (${2:Column1}, ${3:Column2})\nVALUES (${4:@value1}, ${5:@value2});$0',
  },
  {
    label: 'sqlUpdate',
    documentation: 'UPDATE … SET … WHERE',
    body: 'UPDATE ${1:dbo.TableName}\nSET ${2:Column} = ${3:@value}\nWHERE ${4:Id} = ${5:@id};$0',
  },
  {
    label: 'sqlDelete',
    documentation: 'DELETE FROM … WHERE',
    body: 'DELETE FROM ${1:dbo.TableName}\nWHERE ${2:Id} = ${3:@id};$0',
  },
  {
    label: 'sqlCreateTable',
    documentation: 'CREATE TABLE with identity PK',
    body: CREATE_TEMPLATES.table,
  },
  {
    label: 'sqlCreateView',
    documentation: 'CREATE VIEW',
    body: CREATE_TEMPLATES.view,
  },
  {
    label: 'sqlCreateProcedure',
    documentation: 'CREATE PROCEDURE',
    body: CREATE_TEMPLATES.procedure,
  },
  {
    label: 'sqlCreateFunction',
    documentation: 'CREATE inline table-valued FUNCTION',
    body: CREATE_TEMPLATES.function,
  },
  {
    label: 'sqlCreateIndex',
    documentation: 'CREATE INDEX',
    body: CREATE_TEMPLATES.index,
  },
  {
    label: 'sqlJoin',
    documentation: 'INNER JOIN two tables',
    body: 'SELECT ${1:a.*}\nFROM ${2:dbo.TableA} AS a\nINNER JOIN ${3:dbo.TableB} AS b\n    ON a.${4:Id} = b.${5:AId};$0',
  },
  {
    label: 'sqlGroupBy',
    documentation: 'Aggregate with GROUP BY / HAVING',
    body: 'SELECT ${1:Column}, COUNT(*) AS ${2:Total}\nFROM ${3:dbo.TableName}\nGROUP BY ${1:Column}\nHAVING COUNT(*) > ${4:1};$0',
  },
  {
    label: 'sqlCte',
    documentation: 'Common table expression (WITH …)',
    body: 'WITH ${1:cte} AS (\n    SELECT ${2:*}\n    FROM ${3:dbo.TableName}\n)\nSELECT * FROM ${1:cte};$0',
  },
];

/**
 * Choose what to execute when the user runs a query: the highlighted selection
 * if there is one, otherwise the whole script. This is the Fabric query-editor
 * behavior — highlight a statement and Run executes only that statement.
 *
 * @param fullText      the entire editor contents
 * @param selectedText  the currently-selected text (may be empty/whitespace)
 */
export function chooseRunText(fullText: string, selectedText: string | null | undefined): string {
  const sel = (selectedText ?? '').trim();
  return sel.length > 0 ? sel : fullText;
}

/**
 * Whether the current word prefix should trigger the inline SQL snippet list.
 * Fabric opens the snippet list as soon as `sql` is typed.
 */
export function shouldOfferSnippets(word: string | null | undefined): boolean {
  return !!word && word.toLowerCase().startsWith('sql');
}

/**
 * Parse the trailing `schema.table.` reference (for column IntelliSense) from
 * the text on the current line up to the cursor. Returns the two-part name and
 * an optional trailing partial column, or `null` when the text before the
 * cursor is not a dotted reference.
 *
 * Examples (text ends at the cursor):
 *   "SELECT * FROM dbo.Customers."        → { schema:'dbo', table:'Customers', partial:'' }
 *   "SELECT * FROM [dbo].[Customers].Em"  → { schema:'dbo', table:'Customers', partial:'Em' }
 *   "SELECT Email FROM dbo.Customers"     → null (no trailing dot reference)
 */
export function parseDottedReference(
  lineUpToCursor: string,
): { schema: string; table: string; partial: string } | null {
  // schema.table.  or  schema.table.partial  — brackets optional around each part.
  const m = lineUpToCursor.match(/\[?(\w+)\]?\.\[?(\w+)\]?\.(\w*)$/);
  if (!m) return null;
  return { schema: m[1], table: m[2], partial: m[3] || '' };
}
