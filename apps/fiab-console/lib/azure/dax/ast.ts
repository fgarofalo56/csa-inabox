/**
 * ast.ts — the DAX Abstract Syntax Tree (A1).
 *
 * A structural (NOT semantic) tree: the parser produces these nodes; the A2/A3
 * SQL-fold planner interprets specific function names. Pure types + light
 * constructors/guards, zero runtime deps.
 *
 * No Power BI / Fabric / AAS anywhere — this is the loom-native DAX front end.
 */

export type NodeType =
  | 'NumberLiteral'
  | 'StringLiteral'
  | 'BooleanLiteral'
  | 'BlankLiteral'
  | 'ColumnRef'
  | 'MeasureRef'
  | 'TableRef'
  | 'FunctionCall'
  | 'Unary'
  | 'Binary';

export interface NumberLiteral { type: 'NumberLiteral'; value: number; }
export interface StringLiteral { type: 'StringLiteral'; value: string; }
export interface BooleanLiteral { type: 'BooleanLiteral'; value: boolean; }
export interface BlankLiteral { type: 'BlankLiteral'; }

/** `Table[Column]` — a fully-qualified column reference. */
export interface ColumnRef { type: 'ColumnRef'; table: string; column: string; }
/** `[Measure]` — an unqualified bracketed reference (a measure or a step VAR). */
export interface MeasureRef { type: 'MeasureRef'; name: string; }
/** `Table` or `'Quoted Table'` — a bare table reference. */
export interface TableRef { type: 'TableRef'; name: string; }

export interface FunctionCall { type: 'FunctionCall'; name: string; args: Expr[]; }

export type UnaryOp = '-' | '+' | 'NOT';
export interface Unary { type: 'Unary'; op: UnaryOp; operand: Expr; }

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '^'      // arithmetic
  | '&'                               // string concat
  | '=' | '<>' | '<' | '<=' | '>' | '>='  // comparison
  | '&&' | '||'                       // logical
  | 'IN';                             // membership (x IN {..})

export interface Binary { type: 'Binary'; op: BinaryOp; left: Expr; right: Expr; }

export type Expr =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | BlankLiteral
  | ColumnRef
  | MeasureRef
  | TableRef
  | FunctionCall
  | Unary
  | Binary;

// ---------------------------------------------------------------------------
// Query-level nodes
// ---------------------------------------------------------------------------

/** `MEASURE Table[Name] = <expr>` inside a DEFINE block. */
export interface MeasureDefinition {
  type: 'MeasureDefinition';
  table: string;
  name: string;
  expression: Expr;
}

/** `VAR name = <expr>` inside a DEFINE block (query-scoped). */
export interface VarDefinition {
  type: 'VarDefinition';
  name: string;
  expression: Expr;
}

export type Definition = MeasureDefinition | VarDefinition;

export interface OrderTerm { expression: Expr; direction: 'ASC' | 'DESC'; }

/**
 * A whole DAX query: an optional DEFINE block, exactly one EVALUATE table
 * expression, and an optional ORDER BY. (One EVALUATE — the multi-EVALUATE batch
 * form is out of scope for the loom-native fold.)
 */
export interface Query {
  type: 'Query';
  defines: Definition[];
  evaluate: Expr;
  orderBy: OrderTerm[];
}

// ---------------------------------------------------------------------------
// Guards / helpers (used by the A2/A3 folder + tests)
// ---------------------------------------------------------------------------

export function isFunctionCall(n: Expr, name?: string): n is FunctionCall {
  return n.type === 'FunctionCall' && (name === undefined || n.name.toUpperCase() === name.toUpperCase());
}

export function isColumnRef(n: Expr): n is ColumnRef {
  return n.type === 'ColumnRef';
}

export function isTableRef(n: Expr): n is TableRef {
  return n.type === 'TableRef';
}

/** Collect every ColumnRef appearing anywhere in a subtree (fold helper). */
export function collectColumnRefs(n: Expr, out: ColumnRef[] = []): ColumnRef[] {
  switch (n.type) {
    case 'ColumnRef':
      out.push(n);
      break;
    case 'Unary':
      collectColumnRefs(n.operand, out);
      break;
    case 'Binary':
      collectColumnRefs(n.left, out);
      collectColumnRefs(n.right, out);
      break;
    case 'FunctionCall':
      for (const a of n.args) collectColumnRefs(a, out);
      break;
    default:
      break;
  }
  return out;
}
