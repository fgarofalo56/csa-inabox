/**
 * aas-tmsl — PURE TMSL (Tabular Model Scripting Language) builders for the Loom
 * semantic-model "Model view" (relationships + drill hierarchies).
 *
 * Zero runtime imports: these functions are pure JSON serializers so they are
 * trivially unit-testable and carry no @azure/identity / network weight. The
 * I/O write surfaces (XMLA / Fabric REST) live in aas-client.ts, which
 * re-exports everything here.
 *
 * TMSL refs:
 *   relationship object  — https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
 *   hierarchy object     — https://learn.microsoft.com/analysis-services/tmsl/hierarchies-object-tmsl
 *   createOrReplace      — https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 *   alter command        — https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
 */

export type TmslCardinality = 'none' | 'one' | 'many';
export type TmslCrossFilter = 'oneDirection' | 'bothDirections' | 'automatic';

export interface TmslRelationship {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromCardinality: TmslCardinality;
  toCardinality: TmslCardinality;
  crossFilteringBehavior: TmslCrossFilter;
  isActive: boolean;
}

export interface TmslHierarchyLevel {
  ordinal: number;
  /** Display name — can differ from the source column. */
  name: string;
  /** Must reference a column that exists in the parent table. */
  column: string;
}

export interface TmslHierarchy {
  name: string;
  /** Parent table — not part of the TMSL hierarchy body but needed for Alter routing. */
  table: string;
  levels: TmslHierarchyLevel[];
}

export interface TmslColumn {
  name: string;
  /** TMSL dataType — string | int64 | double | decimal | dateTime | boolean. */
  dataType: string;
}

export interface TmslTable {
  name: string;
  columns: TmslColumn[];
  hierarchies?: TmslHierarchy[];
}

function relationshipBody(rel: TmslRelationship): Record<string, unknown> {
  return {
    name: rel.name,
    fromTable: rel.fromTable,
    fromColumn: rel.fromColumn,
    toTable: rel.toTable,
    toColumn: rel.toColumn,
    fromCardinality: rel.fromCardinality,
    toCardinality: rel.toCardinality,
    crossFilteringBehavior: rel.crossFilteringBehavior,
    // TMSL `isActive` defaults to true — emit only when false so an inactive
    // (USERELATIONSHIP) role-playing relationship is honored.
    ...(rel.isActive === false ? { isActive: false } : {}),
  };
}

/**
 * createOrReplace command that upserts a single relationship on the model. Used
 * for both create and the active/inactive toggle (re-emit with isActive flipped).
 */
export function buildCreateOrReplaceRelationshipTmsl(database: string, rel: TmslRelationship): string {
  return JSON.stringify(
    {
      createOrReplace: {
        object: { database, relationship: rel.name },
        relationship: relationshipBody(rel),
      },
    },
    null,
    2,
  );
}

/** delete command that drops a relationship by name. */
export function buildDeleteRelationshipTmsl(database: string, relationshipName: string): string {
  return JSON.stringify(
    {
      delete: {
        object: { database, relationship: relationshipName },
      },
    },
    null,
    2,
  );
}

function hierarchyBody(h: Omit<TmslHierarchy, 'table'>): Record<string, unknown> {
  return {
    name: h.name,
    levels: [...h.levels]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((l) => ({ ordinal: l.ordinal, name: l.name, column: l.column })),
  };
}

/**
 * Alter command that sets a table's `hierarchies` array. Alter (not
 * createOrReplace) is used so only the hierarchies property changes — the
 * table's columns/partitions are left intact.
 */
export function buildAlterTableHierarchyTmsl(
  database: string,
  tableName: string,
  hierarchy: Omit<TmslHierarchy, 'table'>,
): string {
  return JSON.stringify(
    {
      alter: {
        object: { database, table: tableName },
        table: {
          name: tableName,
          hierarchies: [hierarchyBody(hierarchy)],
        },
      },
    },
    null,
    2,
  );
}

/**
 * Build a full `model.bim` TMSL document from the current model state. This is
 * the read-only preview shown in the editor AND the payload the Fabric
 * updateDefinition write overwrites with (it replaces the whole model.bim).
 */
export function buildModelBimTmsl(
  modelName: string,
  tables: TmslTable[],
  relationships: TmslRelationship[],
  hierarchies: TmslHierarchy[],
): string {
  const hierByTable = new Map<string, Omit<TmslHierarchy, 'table'>[]>();
  for (const h of hierarchies) {
    const list = hierByTable.get(h.table) || [];
    list.push({ name: h.name, levels: h.levels });
    hierByTable.set(h.table, list);
  }
  return JSON.stringify(
    {
      name: modelName,
      compatibilityLevel: 1567,
      model: {
        culture: 'en-US',
        tables: tables.map((t) => {
          const hs = hierByTable.get(t.name) || [];
          return {
            name: t.name,
            columns: t.columns.map((c) => ({
              name: c.name,
              dataType: c.dataType,
              sourceColumn: c.name,
            })),
            ...(hs.length ? { hierarchies: hs.map(hierarchyBody) } : {}),
          };
        }),
        relationships: relationships.map(relationshipBody),
      },
    },
    null,
    2,
  );
}

/**
 * Build the TMSL createOrReplace command for a single measure (pure — testable).
 * Used by the Monaco DAX editor's "Save to model (XMLA)" path. Optional format
 * string + display folder are included only when supplied.
 */
export function buildMeasureUpsertTmsl(opts: {
  database: string;
  tableName: string;
  measureName: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
}): object {
  const measure: Record<string, string> = {
    name: opts.measureName,
    expression: opts.expression,
  };
  if (opts.formatString) measure.formatString = opts.formatString;
  if (opts.displayFolder) measure.displayFolder = opts.displayFolder;
  return {
    createOrReplace: {
      object: { database: opts.database, table: opts.tableName, measure: opts.measureName },
      measure,
    },
  };
}

/** Build EVALUATE ROW("value", 'Table'[Measure]) for a single-measure probe. */
export function buildMeasureEvalQuery(tableName: string, measureName: string): string {
  const tbl = "'" + (tableName || '').replace(/'/g, "''") + "'";
  const meas = '[' + (measureName || '').replace(/]/g, '') + ']';
  return 'EVALUATE ROW("value", ' + tbl + meas + ')';
}
