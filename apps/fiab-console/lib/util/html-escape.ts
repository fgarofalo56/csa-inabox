/**
 * HTML/JS escaping for server-rendered interstitial markup.
 *
 * The auth callback returns a hand-built HTML redirect page that interpolates a
 * URL into two attribute contexts and one inline <script>. One of its callers
 * builds that URL from a raw query parameter, so without escaping a crafted
 * value closes the attribute (or the script block) and the remainder is parsed
 * as markup — a reflected XSS.
 *
 * These live in lib/ rather than in the route because a Next.js `route.ts` may
 * only export route handlers and segment config, so helpers defined there cannot
 * be unit-tested directly.
 */

/**
 * Escape a value for interpolation into a DOUBLE-QUOTED HTML attribute.
 *
 * `&` is escaped FIRST — doing it later would double-escape the entities this
 * function itself introduces (`&lt;` becoming `&amp;lt;`).
 */
export function htmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a value as a JS string literal safe to embed in an inline <script>.
 *
 * `JSON.stringify` alone is NOT sufficient: the HTML parser terminates a script
 * block at the first literal closing-script tag regardless of JavaScript string
 * context, so a value containing one would break out of the script and into
 * markup. Rewriting every less-than sign as its unicode escape keeps the runtime
 * string byte-identical while making that closing tag unrepresentable in the
 * emitted markup.
 */
export function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c');
}
