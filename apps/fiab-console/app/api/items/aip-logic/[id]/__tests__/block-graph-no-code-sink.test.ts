/**
 * PREMISE PIN for the CodeQL js/bad-code-sanitization dismissals (#571, #572).
 *
 * THE ALERTS
 *   #571  _block-graph.ts:426 col 221-236  → `asText(r.value)`
 *   #572  _block-graph.ts:433 col  89-175  → `sub.ok ? sub.output : …`
 *   Both: "Code construction depends on an improperly sanitized value."
 *
 * THE DATAFLOW, read off the analysis SARIF rather than guessed:
 *   source  `JSON.stringify(v)`   _block-graph.ts:246  (inside `asText`)
 *           `JSON.stringify(raw)` _block-graph.ts:241  (inside `coerceOut`)
 *           `JSON.stringify(src)` _block-graph.ts:382  (transformOp json-stringify)
 *   sink    the template literals at :426 and :433 — the ones that read
 *             `ontology-function(<type>.<prop>) = <value>`
 *             `execute-function(<name>) = <output>`
 *
 * WHY IT IS A FALSE POSITIVE
 *   The rule pairs "value sanitized with JSON.stringify" (correct — `asText`
 *   does exactly that for objects) with "value used to construct CODE". The
 *   second half is where it misfires: those two template literals are not code.
 *   They are HUMAN-READABLE tool-result lines, pushed onto `textParts`, joined
 *   with newlines, and appended to an Azure OpenAI chat message at :536 plus
 *   echoed into the debugger's `step.prompt` field. CodeQL classifies them as a
 *   code-construction site because the literal text is shaped like a call —
 *   `name(args) = value`. Nothing evaluates them.
 *
 * WHAT THIS TEST GUARDS
 *   That premise is a property of the module, not a law. If anyone ever adds a
 *   dynamic-code sink to the aip-logic engine — `eval`, `new Function`, `vm`,
 *   a shell exec — the dismissal silently becomes wrong and those two
 *   interpolations become a real code-injection path. This makes that a test
 *   failure at the moment it is introduced instead of a finding nobody
 *   re-derives.
 *
 * NOT IN SCOPE (stated so it is not mistaken for a clean bill of health):
 *   `tools.text` DOES reach an LLM prompt, and it carries warehouse row values
 *   and sibling-function output. That is a prompt-injection surface. It is a
 *   different problem with a different fix, and it is not what these two
 *   alerts describe.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const AIP_LOGIC_DIR = path.resolve(__dirname, '..');

/** Dynamic-code sinks. Any of these makes the #571/#572 dismissal invalid. */
const CODE_SINKS: Array<[RegExp, string]> = [
  [/(?<![.\w])eval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function('],
  [/\bFunction\s*\(\s*['"`]/, 'Function("…")'],
  [/\bvm\.(?:run|compile|Script)/, 'node:vm'],
  [/\brequire\s*\(\s*['"]node:vm['"]\s*\)|from\s+['"]node:vm['"]/, "import 'node:vm'"],
  [/\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(/, 'child_process'],
  [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout("string")'],
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Blank out comments + quoted strings so a mention in prose is not a hit. */
function stripNonCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${' '.repeat(Math.max(0, m.length - 2))}'`)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`);
}

describe('aip-logic block-graph engine — no dynamic-code sink (premise of CodeQL #571/#572)', () => {
  const files = sourceFiles(AIP_LOGIC_DIR);

  it('finds the engine module (the scan is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('_block-graph.ts'))).toBe(true);
  });

  it('contains no eval / Function / vm / shell-exec sink', () => {
    const hits: string[] = [];
    for (const f of files) {
      const code = stripNonCode(fs.readFileSync(f, 'utf8'));
      for (const [re, label] of CODE_SINKS) {
        if (re.test(code)) hits.push(`${path.relative(AIP_LOGIC_DIR, f)} → ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the flagged interpolations still feed a prompt, not an interpreter', () => {
    const src = fs.readFileSync(path.join(AIP_LOGIC_DIR, '_block-graph.ts'), 'utf8');
    // `textParts` is the array both flagged template literals push onto. Its
    // ONLY consumer must remain the joined `text` that becomes the chat
    // question — if a second consumer appears, re-derive the dismissal.
    const consumers = src.match(/tools\.text/g) || [];
    expect(consumers.length).toBeGreaterThan(0);
    expect(src).toMatch(/return \{ results, text: textParts\.join\('\\n'\) \}/);
    expect(src).toMatch(/chatGrounded\(cfg, \[\], question/);
  });
});
