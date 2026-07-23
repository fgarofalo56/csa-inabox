/**
 * lib/azure/dax — the loom-native DAX front end (A1).
 *
 * A pure tokenizer + Pratt parser producing a structural AST. No behavior change
 * to any surface yet: the A2 SQL-fold planner consumes `parseDax` to replace the
 * 3-regex `translateDaxToSql`, and A3 extends the fold. No Power BI / Fabric /
 * AAS dependency (no-fabric-dependency) — this is the Azure-native default path.
 */
export * from './ast';
export { tokenize, DaxLexError, type Token, type TokenType } from './tokenizer';
export { parseDax, parseDaxExpression, DaxParseError, KEYWORDS } from './parser';
