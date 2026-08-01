/**
 * htmlAttrEscape / jsStringLiteral — the reflected-XSS defence (js/reflected-xss).
 *
 * THE BUG THESE CLOSE: the auth callback's redirect interstitial interpolated a
 * URL straight into `content="…"`, `href="…"` and an inline <script>. The
 * AAD-error branch builds that URL from the raw `?error=` query parameter, so a
 * crafted value closed the attribute and the remainder was parsed as markup.
 *
 * These tests assert the STRUCTURAL property — a quote or an angle bracket can
 * never survive into an attribute, and a closing-script sequence can never
 * survive into a script block — rather than blocklisting particular payloads.
 */
import { describe, it, expect } from 'vitest';
import { htmlAttrEscape, jsStringLiteral } from '../html-escape';

// Built at runtime so this file never contains a literal closing-script tag
// (which would be flagged by scanners and confuse anyone reading the source).
const CLOSE_SCRIPT = `</${'script'}>`;

describe('htmlAttrEscape', () => {
  it('neutralises an attribute break-out', () => {
    // The shape of the real attack: close the href, open a tag.
    const hostile = `/?auth_error=aad_" onerror="x`;
    const out = htmlAttrEscape(hostile);
    expect(out).not.toContain('"');
    expect(out).toContain('&quot;');
  });

  it('escapes every character that can change markup structure', () => {
    expect(htmlAttrEscape('<')).toBe('&lt;');
    expect(htmlAttrEscape('>')).toBe('&gt;');
    expect(htmlAttrEscape('"')).toBe('&quot;');
    expect(htmlAttrEscape("'")).toBe('&#39;');
    expect(htmlAttrEscape('&')).toBe('&amp;');
  });

  it('escapes & FIRST so entities are not double-escaped', () => {
    // If & were escaped last, '<' → '&lt;' → '&amp;lt;' and the page would
    // render the literal text "&lt;" to the user.
    expect(htmlAttrEscape('<')).toBe('&lt;');
    expect(htmlAttrEscape('a&b')).toBe('a&amp;b');
  });

  it('leaves an ordinary redirect target untouched', () => {
    expect(htmlAttrEscape('/?auth_error=aad_invalid_grant')).toBe('/?auth_error=aad_invalid_grant');
    expect(htmlAttrEscape('/auth/sign-in?auth_error=state_mismatch')).toBe('/auth/sign-in?auth_error=state_mismatch');
  });
});

describe('jsStringLiteral', () => {
  it('prevents a script-block break-out', () => {
    // JSON.stringify alone would leave this intact: the HTML parser ends the
    // script at the first literal closing tag regardless of JS string context.
    const hostile = `/x${CLOSE_SCRIPT}<img src=x onerror=alert(1)>`;
    const out = jsStringLiteral(hostile);
    expect(out).not.toContain(CLOSE_SCRIPT);
    expect(out).not.toContain('<');
    expect(out).toContain('\\u003c');
  });

  it('preserves the RUNTIME value exactly (escaping must not corrupt the redirect)', () => {
    const url = '/?auth_error=aad_invalid_grant&next=/items';
    // What the browser's JS engine parses back must equal the original — the
    // escape changes the source bytes, never the resulting string.
    expect(JSON.parse(jsStringLiteral(url))).toBe(url);
    const hostile = `/x${CLOSE_SCRIPT}y`;
    expect(JSON.parse(jsStringLiteral(hostile))).toBe(hostile);
  });

  it('still quotes and escapes like JSON', () => {
    expect(jsStringLiteral('a"b')).toBe('"a\\"b"');
    expect(jsStringLiteral('a\nb')).toBe('"a\\nb"');
  });
});
