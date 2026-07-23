/**
 * parser.ts — the DAX Pratt parser (A1).
 *
 * Turns a token stream (tokenizer.ts) into a structural AST (ast.ts). Pure and
 * dependency-free. It parses the loom-native-relevant surface of DAX:
 *   - Query:   (DEFINE (MEASURE T[N] = e | VAR n = e)+)?  EVALUATE <tableExpr>
 *              (ORDER BY <e> [ASC|DESC] (, ...)*)?
 *   - Scalar expressions with full DAX operator precedence, function calls,
 *     column refs (T[C]), measure/var refs ([X]), table refs (T / 'Q'),
 *     literals (number/string/TRUE/FALSE/BLANK()), unary +/-/NOT, and IN {..}.
 *
 * It is deliberately permissive about WHICH functions exist — any NAME(args) is
 * a FunctionCall; the A2/A3 SQL-fold planner decides what it can fold and errors
 * honestly (unsupportedDaxError) on the rest. No fabricated results here.
 *
 * On a syntax error it throws DaxParseError with the source offset.
 */
import { tokenize, type Token } from './tokenizer';
import type {
  Expr, Query, Definition, MeasureDefinition, VarDefinition, OrderTerm,
  BinaryOp, FunctionCall,
} from './ast';

export class DaxParseError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(message);
    this.name = 'DaxParseError';
  }
}

// Operator binding powers (left binding power). Higher binds tighter.
// DAX precedence (low → high): || , && , comparison/IN , & , +/- , *// , unary , ^
const BINDING: Record<string, number> = {
  '||': 10,
  '&&': 20,
  '=': 30, '<>': 30, '<': 30, '<=': 30, '>': 30, '>=': 30, 'IN': 30,
  '&': 40,
  '+': 50, '-': 50,
  '*': 60, '/': 60,
  '^': 80,   // above unary (70) — right-assoc handled below
};
const RIGHT_ASSOC = new Set(['^']);
const UNARY_BP = 70;

const KEYWORDS = new Set([
  'DEFINE', 'EVALUATE', 'MEASURE', 'VAR', 'RETURN', 'ORDER', 'BY',
  'ASC', 'DESC', 'START', 'AT', 'TRUE', 'FALSE', 'BLANK', 'NOT', 'IN', 'COLUMN', 'TABLE',
]);

class Parser {
  private toks: Token[];
  private p = 0;

  constructor(private readonly src: string) {
    this.toks = tokenize(src);
  }

  private peek(): Token { return this.toks[this.p]; }
  private next(): Token { return this.toks[this.p++]; }
  private atEof(): boolean { return this.peek().type === 'eof'; }

  private isKeyword(t: Token, kw: string): boolean {
    return t.type === 'ident' && t.value.toUpperCase() === kw;
  }
  private peekKeyword(kw: string): boolean {
    return this.isKeyword(this.peek(), kw);
  }
  /** Consume an ident keyword; error if the next token isn't it. */
  private expectKeyword(kw: string): void {
    const t = this.peek();
    if (!this.isKeyword(t, kw)) this.err(`expected ${kw}`, t);
    this.next();
  }
  private expectOp(op: string): void {
    const t = this.peek();
    if (!(t.type === 'op' && t.value === op)) this.err(`expected "${op}"`, t);
    this.next();
  }
  private peekOp(op: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.value === op;
  }
  private err(msg: string, t: Token): never {
    const near = t.type === 'eof' ? 'end of input' : `"${t.value}"`;
    throw new DaxParseError(`DAX parse error: ${msg} (near ${near}).`, t.pos);
  }

  // ----- query -----

  parseQuery(): Query {
    const defines: Definition[] = [];
    if (this.peekKeyword('DEFINE')) {
      this.next();
      while (this.peekKeyword('MEASURE') || this.peekKeyword('VAR')) {
        defines.push(this.peekKeyword('MEASURE') ? this.parseMeasureDef() : this.parseVarDef());
      }
      if (defines.length === 0) this.err('DEFINE requires at least one MEASURE or VAR', this.peek());
    }
    this.expectKeyword('EVALUATE');
    const evaluate = this.parseExpr(0);
    const orderBy: OrderTerm[] = [];
    if (this.peekKeyword('ORDER')) {
      this.next();
      this.expectKeyword('BY');
      do {
        const expression = this.parseExpr(0);
        let direction: 'ASC' | 'DESC' = 'ASC';
        if (this.peekKeyword('ASC')) { this.next(); direction = 'ASC'; }
        else if (this.peekKeyword('DESC')) { this.next(); direction = 'DESC'; }
        orderBy.push({ expression, direction });
      } while (this.consumeComma());
    }
    if (!this.atEof()) this.err('unexpected trailing input after the query', this.peek());
    return { type: 'Query', defines, evaluate, orderBy };
  }

  private parseMeasureDef(): MeasureDefinition {
    this.expectKeyword('MEASURE');
    const { table, column } = this.parseQualifiedColumnHead();
    this.expectOp('=');
    const expression = this.parseExpr(0);
    return { type: 'MeasureDefinition', table, name: column, expression };
  }

  private parseVarDef(): VarDefinition {
    this.expectKeyword('VAR');
    const t = this.peek();
    if (t.type !== 'ident') this.err('expected a VAR name', t);
    this.next();
    this.expectOp('=');
    const expression = this.parseExpr(0);
    return { type: 'VarDefinition', name: t.value, expression };
  }

  /** Parse `Table[Column]` returning both parts (used by MEASURE defs). */
  private parseQualifiedColumnHead(): { table: string; column: string } {
    const t = this.peek();
    let table = '';
    if (t.type === 'ident') { table = t.value; this.next(); }
    else if (t.type === 'quoted') { table = t.value; this.next(); }
    else this.err('expected a table name', t);
    const b = this.peek();
    if (b.type !== 'bracket') this.err('expected [Column]', b);
    this.next();
    return { table, column: b.value };
  }

  // ----- expressions (Pratt) -----

  parseExpr(minBp: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op = this.operatorAt(t);
      if (op === null) break;
      const bp = BINDING[op];
      if (bp === undefined || bp < minBp) break;
      this.next();
      if (op === 'IN') {
        const right = this.parseInSet();
        left = { type: 'Binary', op: 'IN', left, right };
        continue;
      }
      const nextMin = RIGHT_ASSOC.has(op) ? bp : bp + 1;
      const right = this.parseExpr(nextMin);
      left = { type: 'Binary', op: op as BinaryOp, left, right };
    }
    return left;
  }

  /** Return the binary operator at token t, or null if t isn't one. */
  private operatorAt(t: Token): string | null {
    if (t.type === 'op' && BINDING[t.value] !== undefined) return t.value;
    if (this.isKeyword(t, 'IN')) return 'IN';
    return null;
  }

  private parseInSet(): Expr {
    // IN { a, b, c } — modelled as a TABLE-ish function call so the folder can
    // read the members. (IN <table> is also valid; we support the {..} form.)
    if (this.peekOp('{')) {
      this.next();
      const args: Expr[] = [];
      if (!this.peekOp('}')) {
        do { args.push(this.parseExpr(0)); } while (this.consumeComma());
      }
      this.expectOp('}');
      return { type: 'FunctionCall', name: '__SET__', args };
    }
    // IN <tableExpr>
    return this.parseUnary();
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      const operand = this.parseExpr(UNARY_BP);
      return { type: 'Unary', op: t.value as '-' | '+', operand };
    }
    if (this.isKeyword(t, 'NOT')) {
      this.next();
      const operand = this.parseExpr(UNARY_BP);
      return { type: 'Unary', op: 'NOT', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    // ( expr )
    if (this.peekOp('(')) {
      this.next();
      const e = this.parseExpr(0);
      this.expectOp(')');
      return e;
    }

    // number / string
    if (t.type === 'number') { this.next(); return { type: 'NumberLiteral', value: t.num ?? Number(t.value) }; }
    if (t.type === 'string') { this.next(); return { type: 'StringLiteral', value: t.value }; }

    // [Measure] / [Var] — unqualified bracket
    if (t.type === 'bracket') { this.next(); return { type: 'MeasureRef', name: t.value }; }

    // 'Quoted Table' possibly followed by [Column]
    if (t.type === 'quoted') {
      this.next();
      if (this.peek().type === 'bracket') {
        const b = this.next();
        return { type: 'ColumnRef', table: t.value, column: b.value };
      }
      return { type: 'TableRef', name: t.value };
    }

    // bare ident: keyword-literal, function call, column ref, or table ref
    if (t.type === 'ident') {
      const up = t.value.toUpperCase();
      if (up === 'TRUE') { this.next(); return { type: 'BooleanLiteral', value: true }; }
      if (up === 'FALSE') { this.next(); return { type: 'BooleanLiteral', value: false }; }
      if (up === 'BLANK' && this.toks[this.p + 1]?.type === 'op' && this.toks[this.p + 1].value === '(') {
        // BLANK()
        this.next(); this.expectOp('('); this.expectOp(')');
        return { type: 'BlankLiteral' };
      }
      this.next();
      // function call: ident '('
      if (this.peekOp('(')) {
        return this.finishCall(t.value);
      }
      // column ref: ident '[' Column ']'
      if (this.peek().type === 'bracket') {
        const b = this.next();
        return { type: 'ColumnRef', table: t.value, column: b.value };
      }
      // otherwise a bare table reference
      return { type: 'TableRef', name: t.value };
    }

    return this.err('expected an expression', t);
  }

  private finishCall(name: string): FunctionCall {
    this.expectOp('(');
    const args: Expr[] = [];
    if (!this.peekOp(')')) {
      do { args.push(this.parseExpr(0)); } while (this.consumeComma());
    }
    this.expectOp(')');
    return { type: 'FunctionCall', name, args };
  }

  private consumeComma(): boolean {
    if (this.peekOp(',')) { this.next(); return true; }
    return false;
  }

  /** Parse a single scalar/table expression and require it to consume all input. */
  parseWholeExpression(): Expr {
    const e = this.parseExpr(0);
    if (!this.atEof()) this.err('unexpected trailing input after the expression', this.peek());
    return e;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a full DAX query (`[DEFINE …] EVALUATE …`) into a Query AST. Throws on error. */
export function parseDax(text: string): Query {
  return new Parser(text).parseQuery();
}

/** Parse a single DAX scalar/table EXPRESSION (e.g. a measure body) into an Expr. */
export function parseDaxExpression(text: string): Expr {
  return new Parser(text).parseWholeExpression();
}

export { KEYWORDS };
