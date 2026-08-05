/**
 * docs-chunker — the two defects this module exists to fix (#2929).
 *
 * These tests are deliberately written against the FAILURE MODES that were
 * measured on the live corpus, not against the implementation's shape:
 *
 *   D1  an oversized section was sliced at a blind character offset, so query
 *       terms were bisected ("retention" -> "etention") and stopped being
 *       matchable by either retrieval backend;
 *   D2  continuation chunks inherited only the bare section heading, which in
 *       docs/fiab/parity/** is a string like "Loom coverage" shared verbatim by
 *       hundreds of sibling files, so the chunk lost all document identity.
 *
 * Both assertions below fail if the old blind-slice behaviour comes back.
 */
import { describe, it, expect } from 'vitest';
import {
  chunkMarkdown,
  breadcrumbHeading,
  documentTitle,
  MAX_CHUNK,
  BREADCRUMB_SEP,
} from '../docs-chunker';

/** A section guaranteed to exceed MAX_CHUNK, built from whole markdown rows. */
function bigTable(rows: number, cell: string): string {
  const out = ['| # | Capability | Notes |', '| --- | --- | --- |'];
  for (let i = 0; i < rows; i++) out.push(`| ${i} | row ${i} | ${cell} |`);
  return out.join('\n');
}

describe('chunkMarkdown — section splitting', () => {
  it('keeps every chunk within MAX_CHUNK', () => {
    const doc = `# Title\n\n## Section\n\n${bigTable(120, 'padding text that makes this row long enough to matter')}`;
    for (const c of chunkMarkdown(doc)) expect(c.content.length).toBeLessThanOrEqual(MAX_CHUNK);
  });

  it('splits an oversized section into more than one chunk', () => {
    const doc = `# Title\n\n## Section\n\n${bigTable(120, 'padding')}`;
    expect(chunkMarkdown(doc).filter((c) => c.heading?.endsWith('Section')).length).toBeGreaterThan(1);
  });

  it('D1: never bisects a word across a chunk boundary', () => {
    // `retention` is the real casualty from docs/fiab/parity/kql-database.md:
    // the blind slicer cut it into "etention", and kql-database eval row 8 asks
    // about exactly that word.
    const doc = `# Policies\n\n## Loom coverage\n\n${bigTable(90, 'retention and caching policy retention')}`;
    const chunks = chunkMarkdown(doc);
    expect(chunks.length).toBeGreaterThan(1);
    // Every non-empty line of every chunk is a COMPLETE line of the source. A
    // mid-line (and therefore possibly mid-word) cut produces a fragment that
    // is not in this set, which is exactly what the blind slicer did.
    const sourceLines = new Set(doc.split('\n').map((l) => l.trim()).filter(Boolean));
    for (const c of chunks) {
      for (const line of c.content.split('\n').map((l) => l.trim()).filter(Boolean)) {
        expect(sourceLines.has(line)).toBe(true);
      }
    }
    // ...and no whole-word occurrence is lost to the split.
    const source = (doc.match(/\bretention\b/g) || []).length;
    const kept = chunks.reduce((n, c) => n + (c.content.match(/\bretention\b/g) || []).length, 0);
    expect(kept).toBe(source);
  });

  it('D1: splits a single over-long LINE on a word boundary, not mid-word', () => {
    const word = 'LOOM_SYNAPSE_WORKSPACE';
    const line = `${word} `.repeat(200).trim(); // one line, far over MAX_CHUNK
    const chunks = chunkMarkdown(`# T\n\n## S\n\n${line}`);
    expect(chunks.length).toBeGreaterThan(1);
    const source = (line.match(/LOOM_SYNAPSE_WORKSPACE/g) || []).length;
    const kept = chunks.reduce((n, c) => n + (c.content.match(/\bLOOM_SYNAPSE_WORKSPACE\b/g) || []).length, 0);
    expect(kept).toBe(source);
  });

  it('keeps whole markdown table rows intact', () => {
    const chunks = chunkMarkdown(`# T\n\n## S\n\n${bigTable(120, 'some reasonably long cell body here')}`);
    for (const c of chunks) {
      for (const line of c.content.split('\n')) {
        if (line.trim().length === 0) continue;
        // A row that starts with '|' must also end with '|' — a mid-row cut breaks this.
        if (line.startsWith('|')) expect(line.endsWith('|')).toBe(true);
      }
    }
  });
});

describe('chunkMarkdown — D2: document identity survives into every chunk', () => {
  it('labels every chunk with a "<title> › <section>" breadcrumb', () => {
    const doc = '# kql-database — parity with ADX\n\n## Loom coverage\n\nbody\n\n## Backend per control\n\nbody';
    const headings = chunkMarkdown(doc).map((c) => c.heading);
    expect(headings).toContain(`kql-database — parity with ADX${BREADCRUMB_SEP}Loom coverage`);
    expect(headings).toContain(`kql-database — parity with ADX${BREADCRUMB_SEP}Backend per control`);
  });

  it('carries the title into CONTINUATION chunks of an oversized section', () => {
    // The measured failure: sub-chunks past the first of "Loom coverage" had a
    // heading of just "Loom coverage" and prose that never repeated the topic
    // word, so nothing in the chunk said which document it came from.
    const doc = `# lakehouse — parity with Fabric Lakehouse\n\n## Loom coverage\n\n${bigTable(120, 'prose that never repeats the topic word')}`;
    const chunks = chunkMarkdown(doc);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.heading).toContain('lakehouse — parity with Fabric Lakehouse');
  });

  it('does not duplicate the title when the section IS the title', () => {
    const [first] = chunkMarkdown('# Only Heading\n\nbody');
    expect(first.heading).toBe('Only Heading');
  });
});

describe('documentTitle', () => {
  it('prefers the first H1', () => {
    expect(documentTitle(['## Early section', '# The Real Title', '## Later'])).toBe('The Real Title');
  });

  it('falls back to the first heading when the document has no H1', () => {
    expect(documentTitle(['## First section', '### Deeper'])).toBe('First section');
  });

  it('is undefined for a document with no headings', () => {
    expect(documentTitle(['just prose', ''])).toBeUndefined();
  });

  it('resolves in a pre-pass, so an H1 after an H2 titles the WHOLE document', () => {
    const doc = '## Preamble\n\nbody\n\n# Real Title\n\n## After\n\nbody';
    for (const c of chunkMarkdown(doc)) expect(c.heading).toContain('Real Title');
  });
});

describe('breadcrumbHeading', () => {
  it('joins title and section', () => {
    expect(breadcrumbHeading('Doc', 'Section')).toBe(`Doc${BREADCRUMB_SEP}Section`);
  });
  it('collapses when they are equal', () => {
    expect(breadcrumbHeading('Doc', 'Doc')).toBe('Doc');
  });
  it('tolerates either side missing', () => {
    expect(breadcrumbHeading(undefined, 'Section')).toBe('Section');
    expect(breadcrumbHeading('Doc', undefined)).toBe('Doc');
    expect(breadcrumbHeading(undefined, undefined)).toBeUndefined();
  });
});
