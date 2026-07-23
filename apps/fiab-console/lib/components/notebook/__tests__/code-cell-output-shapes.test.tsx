/**
 * CodeCell rich-output rendering — R3 wave-2 #5.
 *
 * Livy statement output.data is a MIME map. Before this fix the cell renderer
 * did `textPlain || JSON.stringify(data)`, so a matplotlib image/png rendered as
 * a base64 dump and text/html rendered as escaped text. These tests lock in:
 *   • output-shape SELECTION is correct (image > html > json; multi-output keeps
 *     stdout alongside a figure) — via the pure `outputRichParts` helper.
 *   • the renderer emits a real <img data:…> for image/png (never a base64 dump)
 *     and a SCRIPTS-DISABLED sandboxed <iframe> for text/html (no in-repo
 *     sanitizer → sandbox="" is the safety boundary).
 *
 * Pure-logic assertions need no DOM; the render assertions mount CodeCell under
 * FluentProvider (jsdom) exactly like the sibling copilot test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

// U3 — CodeCell reads the 'u3-notebook-cell-resize' runtime flag through a
// react-query hook; mock it so these renders need no QueryClientProvider.
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({ useRuntimeFlag: () => true }));

import { CodeCell, outputRichParts } from '../code-cell';
import type { NotebookCell } from '@/lib/types/notebook-cell';

afterEach(() => cleanup());

function cellWithOutput(output: NotebookCell['output']): NotebookCell {
  return { id: 'c1', type: 'code', lang: 'pyspark', source: 'x', output };
}
function renderCell(output: NotebookCell['output']) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <CodeCell cell={cellWithOutput(output)} onChange={vi.fn()} />
    </FluentProvider>,
  );
}

describe('outputRichParts — shape selection', () => {
  it('prefers image/png over the plain-text figure repr', () => {
    const parts = outputRichParts({
      status: 'ok', textPlain: '<Figure size 640x480>',
      data: { 'text/plain': '<Figure size 640x480>', 'image/png': 'BASE64PNG' },
    });
    expect(parts.hasRich).toBe(true);
    expect(parts.images).toHaveLength(1);
    expect(parts.images[0].src).toBe('data:image/png;base64,BASE64PNG');
  });

  it('surfaces text/html', () => {
    const parts = outputRichParts({ status: 'ok', data: { 'text/html': '<table><tr><td>1</td></tr></table>' } });
    expect(parts.hasRich).toBe(true);
    expect(parts.html).toContain('<table>');
  });

  it('keeps stdout alongside a figure for a multi-output (print + df repr) cell', () => {
    const parts = outputRichParts({ status: 'ok', textPlain: 'hello\n', data: { 'image/png': 'PNG' } });
    expect(parts.images).toHaveLength(1);
    expect(parts.text).toBe('hello\n');
  });

  it('renders application/json when there is no visual shape', () => {
    const parts = outputRichParts({ status: 'ok', data: { 'application/json': { a: 1 } } });
    expect(parts.hasRich).toBe(true);
    expect(parts.jsonVal).toEqual({ a: 1 });
  });

  it('encodes an inline SVG as an <img> source (image context disables scripting)', () => {
    const parts = outputRichParts({ status: 'ok', data: { 'image/svg+xml': '<svg></svg>' } });
    expect(parts.images[0].src.startsWith('data:image/svg+xml;utf8,')).toBe(true);
  });

  it('has NO rich shape for a plain-text-only cell', () => {
    const parts = outputRichParts({ status: 'ok', textPlain: 'just text', data: { 'text/plain': 'just text' } });
    expect(parts.hasRich).toBe(false);
  });
});

describe('CodeCell rich-output render', () => {
  it('renders image/png as an <img data:image/png;base64,…> (never a base64 dump)', () => {
    renderCell({ status: 'ok', data: { 'image/png': 'PNGBYTES' } });
    const img = screen.getByAltText('Cell output') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,PNGBYTES');
    // The base64 must NOT leak into text content anywhere.
    expect(document.body.textContent).not.toContain('PNGBYTES');
  });

  it('renders text/html in a scripts-disabled sandboxed iframe', () => {
    renderCell({ status: 'ok', data: { 'text/html': '<b id="x">hi</b>' } });
    const frame = screen.getByTitle('Cell HTML output') as HTMLIFrameElement;
    // sandbox="" removes ALL capabilities (no scripts, no same-origin).
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<b id="x">hi</b>');
  });
});
