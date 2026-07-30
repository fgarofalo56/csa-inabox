/**
 * bicep-literal — render a runtime value as a single-quoted Bicep string.
 *
 * Escapes the backslash FIRST (CodeQL js/incomplete-sanitization: escaping
 * only the quote lets a value ending in `\` re-arm the closing quote of the
 * generated literal), then the quote, then `${` (otherwise a form value
 * becomes a live interpolation EXPRESSION — e.g. `${listKeys(...)}` — in the
 * generated template), then CR/LF/TAB.
 *
 * Ref: learn.microsoft.com/azure/azure-resource-manager/bicep/data-types#strings
 */
export function bicepStringLiteral(v: unknown): string {
  const s = String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$\{/g, '\\${')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `'${s}'`;
}
