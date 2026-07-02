import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../render-markdown';

describe('renderMarkdown — GFM subset', () => {
  it('renders a GFM table as a real <table> (the bug: tables did not render)', () => {
    const md = [
      '| Name | Rows |',
      '| --- | ---: |',
      '| Orders | 1,200 |',
      '| Customers | 340 |',
    ].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('text-align:right'); // ---: right-aligns the Rows column
    expect(html).toContain('<td>Orders</td>');
    expect(html).toContain('<td style="text-align:right">1,200</td>');
    expect(html).toContain('<td>Customers</td>');
  });

  it('renders headings, bold, italic, inline code, links', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *italic* and `code` and [a](https://x.com).');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://x.com" target="_blank" rel="noreferrer">a</a>');
  });

  it('renders fenced code blocks without mangling their contents', () => {
    const html = renderMarkdown('```python\ndf = spark.read.csv(path)\n# **not bold** inside code\n```');
    expect(html).toContain('<pre class="md-code"><code>');
    expect(html).toContain('df = spark.read.csv(path)');
    // emphasis markers inside the fence stay literal (not converted)
    expect(html).toContain('# **not bold** inside code');
  });

  it('renders ordered + unordered lists and blockquotes', () => {
    const ol = renderMarkdown('1. one\n2. two');
    expect(ol).toContain('<ol>');
    expect(ol).toContain('<li>one</li>');
    expect(ol).toContain('<li>two</li>');
    expect(ol).toContain('</ol>');
    const ul = renderMarkdown('- a\n- b');
    expect(ul).toContain('<ul>');
    expect(ul).toContain('<li>a</li>');
    expect(renderMarkdown('> quoted')).toContain('<blockquote>quoted</blockquote>');
  });

  it('renders a horizontal rule', () => {
    expect(renderMarkdown('above\n\n---\n\nbelow')).toContain('<hr/>');
  });

  it('escapes HTML so author markup cannot inject elements', () => {
    const html = renderMarkdown('<script>alert(1)</script> and <b>x</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
