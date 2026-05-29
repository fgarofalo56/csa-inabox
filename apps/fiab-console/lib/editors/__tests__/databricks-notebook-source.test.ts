/**
 * Tests for the Databricks SOURCE <-> cell codec used by the cell-based
 * Databricks notebook editor. Verifies the real Databricks wire format:
 *   # COMMAND ---------- separators, # MAGIC %lang non-default cells,
 *   markdown %md cells, and round-trip stability.
 */
import { describe, it, expect } from 'vitest';
import { parseSource, serializeCells, cellLangToCommandLanguage } from '../databricks-notebook-source';
import type { NotebookCell } from '@/lib/types/notebook-cell';

describe('parseSource (PYTHON base)', () => {
  it('splits cells on the # COMMAND separator', () => {
    const src = [
      '# Databricks notebook source',
      'print("a")',
      '',
      '# COMMAND ----------',
      '',
      'print("b")',
    ].join('\n');
    const cells = parseSource(src, 'PYTHON');
    expect(cells).toHaveLength(2);
    expect(cells[0].source).toBe('print("a")');
    expect(cells[1].source).toBe('print("b")');
    expect(cells[0].lang).toBe('python');
  });

  it('parses a # MAGIC %sql cell into a sparksql code cell', () => {
    const src = [
      '# Databricks notebook source',
      'print("py")',
      '',
      '# COMMAND ----------',
      '',
      '# MAGIC %sql',
      '# MAGIC SELECT 1',
    ].join('\n');
    const cells = parseSource(src, 'PYTHON');
    expect(cells).toHaveLength(2);
    expect(cells[1].type).toBe('code');
    expect(cells[1].lang).toBe('sparksql');
    expect(cells[1].source).toBe('SELECT 1');
  });

  it('parses a # MAGIC %md cell into a markdown cell', () => {
    const src = [
      '# Databricks notebook source',
      '# MAGIC %md',
      '# MAGIC # Title',
      '# MAGIC body',
    ].join('\n');
    const cells = parseSource(src, 'PYTHON');
    expect(cells).toHaveLength(1);
    expect(cells[0].type).toBe('markdown');
    expect(cells[0].source).toBe('# Title\nbody');
  });

  it('treats a plain file with no separators as one cell', () => {
    const cells = parseSource('x = 1\ny = 2', 'PYTHON');
    expect(cells).toHaveLength(1);
    expect(cells[0].source).toBe('x = 1\ny = 2');
  });
});

describe('parseSource (SQL base)', () => {
  it('uses the -- COMMAND separator and -- MAGIC prefix', () => {
    const src = [
      '-- Databricks notebook source',
      'SELECT 1',
      '',
      '-- COMMAND ----------',
      '',
      '-- MAGIC %python',
      '-- MAGIC print("hi")',
    ].join('\n');
    const cells = parseSource(src, 'SQL');
    expect(cells).toHaveLength(2);
    expect(cells[0].lang).toBe('sparksql');
    expect(cells[0].source).toBe('SELECT 1');
    expect(cells[1].lang).toBe('python');
    expect(cells[1].source).toBe('print("hi")');
  });
});

describe('serializeCells', () => {
  it('emits base-language cells bare and others as MAGIC lines', () => {
    const cells: NotebookCell[] = [
      { id: '1', type: 'code', lang: 'python', source: 'print("a")' },
      { id: '2', type: 'code', lang: 'sparksql', source: 'SELECT 1' },
      { id: '3', type: 'markdown', source: '# Heading' },
    ];
    const out = serializeCells(cells, 'PYTHON');
    expect(out).toContain('# Databricks notebook source');
    expect(out).toContain('# COMMAND ----------');
    expect(out).toContain('print("a")');
    expect(out).toContain('# MAGIC %sql');
    expect(out).toContain('# MAGIC SELECT 1');
    expect(out).toContain('# MAGIC %md');
    expect(out).toContain('# MAGIC # Heading');
  });
});

describe('round-trip', () => {
  it('parse(serialize(cells)) preserves languages and source', () => {
    const cells: NotebookCell[] = [
      { id: 'a', type: 'code', lang: 'python', source: 'x = 1' },
      { id: 'b', type: 'code', lang: 'sparksql', source: 'SELECT * FROM t' },
      { id: 'c', type: 'code', lang: 'spark', source: 'val y = 2' },
      { id: 'd', type: 'markdown', source: '## notes' },
    ];
    const src = serializeCells(cells, 'PYTHON');
    const back = parseSource(src, 'PYTHON');
    expect(back.map((c) => c.type)).toEqual(['code', 'code', 'code', 'markdown']);
    expect(back.map((c) => c.lang)).toEqual(['python', 'sparksql', 'spark', undefined]);
    expect(back.map((c) => c.source)).toEqual(['x = 1', 'SELECT * FROM t', 'val y = 2', '## notes']);
  });
});

describe('cellLangToCommandLanguage', () => {
  it('maps notebook cell langs to api/1.2 command languages', () => {
    expect(cellLangToCommandLanguage('python')).toBe('python');
    expect(cellLangToCommandLanguage('pyspark')).toBe('python');
    expect(cellLangToCommandLanguage('sparksql')).toBe('sql');
    expect(cellLangToCommandLanguage('tsql')).toBe('sql');
    expect(cellLangToCommandLanguage('spark')).toBe('scala');
    expect(cellLangToCommandLanguage('sparkr')).toBe('r');
  });
});
