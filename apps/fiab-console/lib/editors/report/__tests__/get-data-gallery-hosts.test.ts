/**
 * Host wiring for the shared Get Data gallery — each editor that opens it names
 * ITSELF as the host, so an upload is stored with, and authorized against, the
 * item the user is editing.
 *
 * This is a SOURCE-STRUCTURE pin: it reads the `<GetDataGallery … />` element in
 * each editor and asserts its host props. Mounting the full semantic-model /
 * paginated-report editors to observe one prop is disproportionate; the upload
 * behaviour those props drive is exercised by get-data-gallery.test.tsx.
 * What breaks it: deleting `reportId={…}` or `hostItemType="…"` from either
 * element, or pointing it at another type. A comment inside the element could
 * satisfy it, which is why only the element's own attribute list is read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

function galleryElements(rel: string): string[] {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const out: string[] = [];
  const re = /<GetDataGallery\b([\s\S]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe('Get Data gallery host wiring', () => {
  it.each([
    ['phase3/semantic-model-editor.tsx', 'semantic-model', /reportId=\{id\}/],
    ['phase3/paginated-report-editor.tsx', 'paginated-report', /reportId=\{itemId\}/],
  ])('%s opens the gallery as a %s host with its own id', (rel, type, idAttr) => {
    const els = galleryElements(rel);
    // Positive control: the element is found (breaks if the extractor matches nothing).
    expect(els).toHaveLength(1);
    expect(els[0]).toMatch(idAttr);
    expect(els[0]).toContain(`hostItemType="${type}"`);
  });

  it('the paginated report passes its own id into the data-source dialog', () => {
    const src = readFileSync(join(ROOT, 'phase3/paginated-report-editor.tsx'), 'utf8');
    const dialog = /<DataSourceDialog\b([\s\S]*?)\/>/.exec(src);
    expect(dialog).not.toBeNull();
    expect(dialog![1]).toMatch(/itemId=\{id\}/);
  });
});
