/**
 * Tests for the notebook import parser — pins the cell kinds + langs each
 * supported file format must produce. No network, pure function under test.
 */
import { describe, it, expect } from 'vitest';
import { parseNotebookFile, langFromKernel } from '../import-parser';

describe('langFromKernel', () => {
  it('maps python → pyspark, sql → sparksql, scala → spark, r → sparkr', () => {
    expect(langFromKernel('python3')).toBe('pyspark');
    expect(langFromKernel('Python')).toBe('pyspark');
    expect(langFromKernel('pyspark')).toBe('pyspark');
    expect(langFromKernel('sql')).toBe('sparksql');
    expect(langFromKernel('scala')).toBe('spark');
    expect(langFromKernel('R')).toBe('sparkr');
    expect(langFromKernel(undefined)).toBe('pyspark');
  });
});

describe('parseNotebookFile — .ipynb', () => {
  it('parses markdown + code cells and joins source arrays', () => {
    const ipynb = JSON.stringify({
      metadata: { kernelspec: { language: 'python', name: 'python3' } },
      cells: [
        { cell_type: 'markdown', source: ['# Title\n', '\n', 'Some text'] },
        { cell_type: 'code', source: ['df = spark.range(10)\n', 'df.show()'] },
        { cell_type: 'code', source: 'print("oneliner")' },
      ],
    });
    const { cells, defaultLang } = parseNotebookFile(ipynb, 'analysis.ipynb');
    expect(defaultLang).toBe('pyspark');
    expect(cells).toHaveLength(3);

    expect(cells[0].type).toBe('markdown');
    expect(cells[0].source).toBe('# Title\n\nSome text');

    expect(cells[1].type).toBe('code');
    expect(cells[1].lang).toBe('pyspark');
    expect(cells[1].source).toBe('df = spark.range(10)\ndf.show()');

    expect(cells[2].type).toBe('code');
    expect(cells[2].source).toBe('print("oneliner")');
  });

  it('honors a sql kernel language', () => {
    const ipynb = JSON.stringify({
      metadata: { language_info: { name: 'sql' } },
      cells: [{ cell_type: 'code', source: 'SELECT 1' }],
    });
    const { cells, defaultLang } = parseNotebookFile(ipynb, 'q.ipynb');
    expect(defaultLang).toBe('sparksql');
    expect(cells[0].lang).toBe('sparksql');
  });

  it('treats raw cells as markdown and gives every cell an id', () => {
    const ipynb = JSON.stringify({
      metadata: {},
      cells: [{ cell_type: 'raw', source: 'raw block' }],
    });
    const { cells } = parseNotebookFile(ipynb, 'r.ipynb');
    expect(cells[0].type).toBe('markdown');
    expect(cells[0].id).toBeTruthy();
  });
});

describe('parseNotebookFile — Databricks # COMMAND / # MAGIC', () => {
  const dbx = [
    '# Databricks notebook source',
    '# MAGIC %md',
    '# MAGIC # Heading',
    '# MAGIC text here',
    '',
    '# COMMAND ----------',
    '',
    'df = spark.range(5)',
    'df.show()',
    '',
    '# COMMAND ----------',
    '',
    '# MAGIC %sql',
    '# MAGIC SELECT * FROM t',
  ].join('\n');

  it('splits on # COMMAND and maps magic cells to the right kind/lang', () => {
    const { cells, defaultLang } = parseNotebookFile(dbx, 'job.py');
    expect(defaultLang).toBe('pyspark');
    expect(cells).toHaveLength(3);

    // markdown magic cell — directive + MAGIC prefix stripped
    expect(cells[0].type).toBe('markdown');
    expect(cells[0].source).toBe('# Heading\ntext here');

    // plain code cell
    expect(cells[1].type).toBe('code');
    expect(cells[1].lang).toBe('pyspark');
    expect(cells[1].source).toBe('df = spark.range(5)\ndf.show()');

    // sql magic cell
    expect(cells[2].type).toBe('code');
    expect(cells[2].lang).toBe('sparksql');
    expect(cells[2].source).toBe('SELECT * FROM t');
  });

  it('maps %scala → spark and %r → sparkr', () => {
    const src = [
      '# MAGIC %scala',
      '# MAGIC val x = 1',
      '# COMMAND ----------',
      '# MAGIC %r',
      '# MAGIC print("hi")',
    ].join('\n');
    const { cells } = parseNotebookFile(src, 'mixed.py');
    expect(cells[0].lang).toBe('spark');
    expect(cells[0].source).toBe('val x = 1');
    expect(cells[1].lang).toBe('sparkr');
    expect(cells[1].source).toBe('print("hi")');
  });
});

describe('parseNotebookFile — # %% percent format', () => {
  const pct = [
    '# %% [markdown]',
    '# # Notebook title',
    '# explanatory text',
    '# %%',
    'import pandas as pd',
    'x = 1',
    '#%% [markdown]',
    '# trailing note',
  ].join('\n');

  it('maps # %% [markdown] → markdown and # %% → code, stripping markers', () => {
    const { cells, defaultLang } = parseNotebookFile(pct, 'script.py');
    expect(defaultLang).toBe('pyspark');
    expect(cells).toHaveLength(3);

    expect(cells[0].type).toBe('markdown');
    expect(cells[0].source).toBe('# Notebook title\nexplanatory text');

    expect(cells[1].type).toBe('code');
    expect(cells[1].lang).toBe('pyspark');
    expect(cells[1].source).toBe('import pandas as pd\nx = 1');

    expect(cells[2].type).toBe('markdown');
    expect(cells[2].source).toBe('trailing note');
  });

  it('keeps a code preamble before the first marker', () => {
    const src = ['print("preamble")', '# %%', 'print("after")'].join('\n');
    const { cells } = parseNotebookFile(src, 's.py');
    expect(cells).toHaveLength(2);
    expect(cells[0].type).toBe('code');
    expect(cells[0].source).toBe('print("preamble")');
    expect(cells[1].source).toBe('print("after")');
  });
});

describe('parseNotebookFile — single-cell formats', () => {
  it('.sql → one sparksql code cell', () => {
    const { cells, defaultLang } = parseNotebookFile('SELECT 1;\n', 'q.sql');
    expect(defaultLang).toBe('sparksql');
    expect(cells).toHaveLength(1);
    expect(cells[0].type).toBe('code');
    expect(cells[0].lang).toBe('sparksql');
    expect(cells[0].source).toBe('SELECT 1;');
  });

  it('.scala → one spark code cell', () => {
    const { cells, defaultLang } = parseNotebookFile('val x = 1', 'x.scala');
    expect(defaultLang).toBe('spark');
    expect(cells[0].lang).toBe('spark');
  });

  it('.r → one sparkr code cell', () => {
    const { cells, defaultLang } = parseNotebookFile('print("hi")', 'x.r');
    expect(defaultLang).toBe('sparkr');
    expect(cells[0].lang).toBe('sparkr');
  });

  it('a plain .py with no markers → one pyspark code cell', () => {
    const { cells, defaultLang } = parseNotebookFile('a = 1\nb = 2\n', 'plain.py');
    expect(defaultLang).toBe('pyspark');
    expect(cells).toHaveLength(1);
    expect(cells[0].source).toBe('a = 1\nb = 2');
  });
});

describe('parseNotebookFile — byte input', () => {
  it('decodes Uint8Array bytes as UTF-8', () => {
    const bytes = new TextEncoder().encode('SELECT 1');
    const { cells } = parseNotebookFile(bytes, 'q.sql');
    expect(cells[0].source).toBe('SELECT 1');
  });
});
