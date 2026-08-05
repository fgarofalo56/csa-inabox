/**
 * docs-grounding — the shared docs-RAG grounding contract (#2929, answer half).
 *
 * These tests assert the SPECIFIC rules that were written against SPECIFIC
 * wrong answers observed live on image 30af2cee (see the module header for the
 * quoted failures). Each `it` names the failure it defends, so a future
 * simplification of the prompt cannot silently drop a rule that a real eval
 * regression paid for.
 */
import { describe, it, expect } from 'vitest';
import {
  DOCS_GROUNDING_RULES,
  EVIDENCE_CHARS,
  renderDocExcerpts,
  buildGroundedDocsSystemPrompt,
  buildGroundedDocsMessages,
} from '../docs-grounding';

describe('docs-grounding — the evidence block', () => {
  it('numbers each excerpt and labels it path — heading', () => {
    const out = renderDocExcerpts([
      { path: 'docs/fiab/parity/data-agent.md', heading: 'C. Build / test loop', content: 'alpha' },
      { path: 'docs/fiab/parity/eventstream.md', heading: null, content: 'beta' },
    ]);
    expect(out).toContain('[1] docs/fiab/parity/data-agent.md — C. Build / test loop\nalpha');
    expect(out).toContain('[2] docs/fiab/parity/eventstream.md\nbeta');
  });

  it('caps every excerpt at EVIDENCE_CHARS — the judge sees the same slice the model answered from (#2585 P3)', () => {
    const out = renderDocExcerpts([{ path: 'p', content: 'x'.repeat(EVIDENCE_CHARS + 500) }]);
    expect(out).toContain('x'.repeat(EVIDENCE_CHARS));
    expect(out).not.toContain('x'.repeat(EVIDENCE_CHARS + 1));
  });

  it('says so explicitly when nothing was retrieved, rather than emitting an empty block', () => {
    expect(renderDocExcerpts([])).toBe('(no documentation excerpts were retrieved)');
  });
});

describe('docs-grounding — the rules the eval failures paid for', () => {
  it('rule 1 — parity docs describe TWO products (data-agent-013 answered "Yes, a browsable schema tree" when Loom\'s honest answer is "not yet, tracked gap")', () => {
    expect(DOCS_GROUNDING_RULES).toMatch(/Azure\/Fabric feature inventory/);
    expect(DOCS_GROUNDING_RULES).toMatch(/Loom coverage/);
    expect(DOCS_GROUNDING_RULES).toMatch(/OTHER product/);
    expect(DOCS_GROUNDING_RULES).toMatch(/tracked gap/);
  });

  it('rule 2 — "never required" is NOT "cannot be done" (eventstream-008 answered "You cannot publish your eventstream to Fabric", contradicting the retrieved doc)', () => {
    expect(DOCS_GROUNDING_RULES).toMatch(/OPT-IN Fabric or Power BI publish/);
    expect(DOCS_GROUNDING_RULES).toMatch(/Never deny a capability the excerpts document/);
  });

  it('rule 3 — exact identifiers survive (Cosmos / asa-sync / cURL / Foundry were paraphrased away), and counts stay digits ("5 data sources", not "five")', () => {
    expect(DOCS_GROUNDING_RULES).toMatch(/KEEP EXACT IDENTIFIERS VERBATIM/);
    expect(DOCS_GROUNDING_RULES).toMatch(/5 data sources/);
    expect(DOCS_GROUNDING_RULES).toMatch(/DIGITS/);
    // data-agent-006: the doc's SELECT/WITH allowlist was restated as an
    // INSERT/UPDATE/DELETE denylist — a weaker, different security claim.
    expect(DOCS_GROUNDING_RULES).toMatch(/allowlist described as a denylist/);
  });

  it('rule 4 — name the mechanism (a per-turn trace became "response history"; an LLM-as-judge became "an accuracy score")', () => {
    expect(DOCS_GROUNDING_RULES).toMatch(/NAME THE MECHANISM/);
    expect(DOCS_GROUNDING_RULES).toMatch(/generic paraphrase/);
  });

  it('rule 5 — enumerate every option (data-agent-007 named only M365 Copilot and dropped Foundry Agent Service)', () => {
    expect(DOCS_GROUNDING_RULES).toMatch(/ENUMERATE EVERY OPTION/);
    expect(DOCS_GROUNDING_RULES).toMatch(/not just the first one/);
  });

  it('rule 6 — a partial answer beats a refusal (data-agent-014 refused with the right doc in context TWICE)', () => {
    expect(DOCS_GROUNDING_RULES).toMatch(/PARTIAL BEATS REFUSAL/);
    expect(DOCS_GROUNDING_RULES).toMatch(/Refuse outright only when no retrieved excerpt is relevant/);
  });

  it('does NOT assert the over-broad claim that produced the eventstream-008 denial', () => {
    // The old prompt stated "no feature requires a Fabric capacity or Power BI
    // workspace" as a bare fact, and the model generalized it into "you cannot
    // publish to Fabric". The replacement must keep the requirement clause
    // ("REQUIRES") bound to its contrast, never standing alone as a prohibition.
    expect(DOCS_GROUNDING_RULES).not.toMatch(/Fabric backends are strictly opt-in\.\s*Answer/);
    expect(DOCS_GROUNDING_RULES).toMatch(/NEVER REQUIRED, BUT IT IS NOT FORBIDDEN/);
  });
});

describe('docs-grounding — prompt assembly', () => {
  it('the system prompt carries the rules AND the evidence, in that order', () => {
    const sys = buildGroundedDocsSystemPrompt([{ path: 'docs/a.md', content: 'evidence-body' }]);
    expect(sys.indexOf('GROUNDING RULES')).toBeGreaterThan(-1);
    expect(sys.indexOf('Documentation excerpts:')).toBeGreaterThan(sys.indexOf('GROUNDING RULES'));
    expect(sys).toContain('evidence-body');
  });

  it('builds a system + user pair with the question verbatim', () => {
    const msgs = buildGroundedDocsMessages('How many data sources can a data agent have?', []);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1]).toEqual({ role: 'user', content: 'How many data sources can a data agent have?' });
  });

  it('grounds ONLY in the excerpts — the instruction the whole harness assumes', () => {
    expect(buildGroundedDocsSystemPrompt([])).toMatch(/grounded ONLY in the documentation excerpts/);
  });
});
