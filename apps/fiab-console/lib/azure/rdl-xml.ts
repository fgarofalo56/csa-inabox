/**
 * rdl-xml.ts — a small, dependency-free XML parser tuned for RDL / XMLA.
 *
 * WHY A HAND-ROLLED PARSER
 * ------------------------
 * The paginated-report renderer runs on the Node.js BFF route and needs to read
 * the structure of an RDL (Report Definition Language) document — a well-formed
 * XML file produced by Power BI Report Builder / SSRS — and the XMLA rowset XML
 * returned by Azure Analysis Services. Pulling in a third-party XML library is
 * not an option in this deployment (the prod dependency tree is locked and
 * `fast-xml-parser` is only present transitively in the pnpm store, not
 * resolvable from the app), so this module implements a focused, correct parser
 * with zero runtime dependencies. It handles the XML subset RDL/XMLA actually
 * use: elements, attributes (single/double quoted), text, CDATA, comments, the
 * XML declaration, DOCTYPE/PI, self-closing tags, and the five predefined +
 * numeric character entities.
 *
 * OUTPUT SHAPE (fast-xml-parser-compatible)
 * -----------------------------------------
 *   <Report><Body><ReportItems/></Body></Report>
 *     →  { Report: { Body: { ReportItems: '' } } }
 *
 *   - An element with ONLY text and no attributes/children becomes the text
 *     string directly (so `node.DataType` is `'String'`, not `{ '#text': … }`).
 *   - An element with attributes/children becomes an object; attributes are
 *     keyed `@_Name`, text under `#text`, child elements under their tag name.
 *   - A tag that repeats under the same parent becomes an array. Callers must
 *     therefore normalise with `toArray()` before iterating (a single
 *     `<ReportParameter>` is an object; two or more is an array).
 *
 * This is parsing, not rendering — no mocks, no placeholder data.
 */

export type XmlValue = string | XmlObject | Array<string | XmlObject>;
export interface XmlObject {
  [key: string]: XmlValue;
}

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

/** Decode the predefined XML entities + numeric (&#NN; / &#xNN;) references. */
export function decodeXmlEntities(input: string): string {
  if (input.indexOf('&') === -1) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return whole;
    }
  });
}

/** Parse the inside of an opening tag into a name + attribute map. */
function parseStartTag(raw: string): { name: string; attrs: Record<string, string> } {
  const trimmed = raw.trim();
  const nameMatch = trimmed.match(/^([^\s/>]+)/);
  const name = nameMatch ? nameMatch[1] : trimmed;
  const attrs: Record<string, string> = {};
  const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  const rest = trimmed.slice(name.length);
  while ((m = attrRe.exec(rest)) !== null) {
    const key = m[1];
    const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : '');
    attrs[key] = decodeXmlEntities(val);
  }
  return { name, attrs };
}

/** Tokenise the document into a synthetic `#root` element tree. */
function tokenize(xml: string): El {
  const root: El = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: El[] = [root];
  const n = xml.length;
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < n) {
    if (xml[i] === '<') {
      if (xml.startsWith('<!--', i)) {
        const e = xml.indexOf('-->', i);
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', i)) {
        const e = xml.indexOf(']]>', i);
        top().text += xml.slice(i + 9, e < 0 ? n : e); // CDATA is literal — no entity decode
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (xml.startsWith('<?', i)) {
        const e = xml.indexOf('?>', i);
        i = e < 0 ? n : e + 2;
        continue;
      }
      if (xml.startsWith('<!', i)) {
        // DOCTYPE or other declaration — skip to matching '>'
        const e = xml.indexOf('>', i);
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (xml[i + 1] === '/') {
        // closing tag
        const e = xml.indexOf('>', i);
        if (stack.length > 1) stack.pop();
        i = e < 0 ? n : e + 1;
        continue;
      }
      // opening tag
      const e = xml.indexOf('>', i);
      if (e < 0) break;
      let raw = xml.slice(i + 1, e);
      const selfClose = raw.endsWith('/');
      if (selfClose) raw = raw.slice(0, -1);
      const { name, attrs } = parseStartTag(raw);
      const el: El = { name, attrs, children: [], text: '' };
      top().children.push(el);
      if (!selfClose) stack.push(el);
      i = e + 1;
    } else {
      const e = xml.indexOf('<', i);
      const chunk = xml.slice(i, e < 0 ? n : e);
      if (chunk.trim()) top().text += decodeXmlEntities(chunk);
      i = e < 0 ? n : e;
    }
  }
  return root;
}

/** Convert an element tree node into the fast-xml-parser-compatible value. */
function elToValue(el: El): string | XmlObject {
  const hasChildren = el.children.length > 0;
  const hasAttrs = Object.keys(el.attrs).length > 0;
  if (!hasChildren && !hasAttrs) {
    return el.text;
  }
  const obj: XmlObject = {};
  for (const [k, v] of Object.entries(el.attrs)) obj[`@_${k}`] = v;
  if (el.text) obj['#text'] = el.text;
  for (const child of el.children) {
    const val = elToValue(child);
    const existing = obj[child.name];
    if (existing === undefined) {
      obj[child.name] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      obj[child.name] = [existing, val];
    }
  }
  return obj;
}

/**
 * Parse an XML string into a `{ rootTag: value }` object (fast-xml-parser
 * compatible). Returns `{}` for empty / unparseable input.
 */
export function parseXml(input: string): XmlObject {
  if (!input || typeof input !== 'string') return {};
  const root = tokenize(input);
  const doc = root.children[0];
  if (!doc) return {};
  return { [doc.name]: elToValue(doc) };
}

/** Normalise an fast-xml-parser value (object | array | undefined) to an array. */
export function toArray<T = unknown>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Read the text content of a node regardless of whether it is a string or object. */
export function textOf(v: XmlValue | undefined): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return textOf(v[0]);
  const t = (v as XmlObject)['#text'];
  return typeof t === 'string' ? t : '';
}

/**
 * Depth-first search for the FIRST element named `key` anywhere in the tree.
 * Used to locate the XMLA `<row>` set inside the SOAP/Execute envelope without
 * hard-coding the SOAP namespace prefix (which varies by AAS endpoint).
 */
export function findFirst(node: XmlValue | undefined, key: string): XmlValue | undefined {
  if (node === undefined || node === null || typeof node === 'string') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirst(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = node as XmlObject;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    if (k.startsWith('@_') || k === '#text') continue;
    const found = findFirst(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}
