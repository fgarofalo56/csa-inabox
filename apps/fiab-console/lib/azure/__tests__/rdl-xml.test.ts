import { describe, it, expect } from 'vitest';
import { parseXml, toArray, textOf, decodeXmlEntities, findFirst } from '../rdl-xml';

describe('rdl-xml — decodeXmlEntities', () => {
  it('decodes predefined + numeric entities', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe('a & b <c> "d" \'e\'');
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB');
  });
  it('passes through strings with no entities unchanged', () => {
    expect(decodeXmlEntities('plain text')).toBe('plain text');
  });
});

describe('rdl-xml — parseXml', () => {
  it('returns a { rootTag: value } object', () => {
    const o = parseXml('<Report><Body><ReportItems/></Body></Report>');
    expect(Object.keys(o)).toEqual(['Report']);
    const report = o.Report as any;
    expect(report.Body.ReportItems).toBe('');
  });

  it('parses attributes under @_ prefix', () => {
    const o = parseXml('<Report><DataSource Name="DS1" Extension="SQL"/></Report>') as any;
    expect(o.Report.DataSource['@_Name']).toBe('DS1');
    expect(o.Report.DataSource['@_Extension']).toBe('SQL');
  });

  it('text-only elements become the string value', () => {
    const o = parseXml('<Report><DataType>String</DataType></Report>') as any;
    expect(o.Report.DataType).toBe('String');
  });

  it('repeated elements become an array', () => {
    const o = parseXml('<Vals><V>a</V><V>b</V><V>c</V></Vals>') as any;
    expect(Array.isArray(o.Vals.V)).toBe(true);
    expect(o.Vals.V).toEqual(['a', 'b', 'c']);
  });

  it('handles XML declaration, comments and CDATA', () => {
    const o = parseXml('<?xml version="1.0"?><Report><!-- c --><Q><![CDATA[SELECT * FROM t WHERE x < 5]]></Q></Report>') as any;
    expect(o.Report.Q).toBe('SELECT * FROM t WHERE x < 5');
  });

  it('decodes entities in text content', () => {
    const o = parseXml('<Report><T>a &amp; b</T></Report>') as any;
    expect(o.Report.T).toBe('a & b');
  });

  it('returns {} for empty input', () => {
    expect(parseXml('')).toEqual({});
  });
});

describe('rdl-xml — helpers', () => {
  it('toArray normalises object/array/undefined', () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray('x')).toEqual(['x']);
    expect(toArray(['x', 'y'])).toEqual(['x', 'y']);
  });
  it('textOf reads string and #text', () => {
    expect(textOf('hi')).toBe('hi');
    expect(textOf({ '#text': 'yo', '@_a': '1' } as any)).toBe('yo');
    expect(textOf(undefined)).toBe('');
  });
  it('findFirst locates a nested element ignoring namespace prefixes at the path', () => {
    const o = parseXml('<Envelope><Body><ExecuteResponse><return><root><row><C>1</C></row></root></return></ExecuteResponse></Body></Envelope>');
    const row = findFirst(o, 'row') as any;
    expect(row).toBeDefined();
    expect(textOf(row.C)).toBe('1');
  });
});
