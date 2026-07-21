/**
 * agent-flow-guardrails — WS-5.1 inline guardrails + evals for the visual
 * agent-builder flow.
 *
 * A flow author configures guardrails/evals per agent flow (canvas inspector),
 * persisted in `state.guardrails`. This module holds the PURE, deterministic
 * enforcement the run route applies to every turn — no LLM, no network, so it is
 * unit-tested without the AOAI bundle. It is REAL functionality (regex PII
 * redaction, blocked-term denial, grounding enforcement, output caps), not a
 * mock: the run route calls it and its outcome shapes the answer + the run
 * receipt (no-vaporware.md).
 *
 * The selected eval suites (groundedness / relevance / coherence / safety /
 * fluency — the Azure AI Foundry evaluator families) are recorded on the run so
 * the flow's quality posture is auditable; the deterministic guardrails run
 * inline on every turn.
 *
 * Azure-native + sovereign: no Fabric, no external service — a pure text layer.
 */

/** One guardrail/eval catalog entry for the picker. */
export interface FlowEvalMeta {
  id: string;
  label: string;
  description: string;
}

/** Azure AI Foundry evaluator families offered as selectable eval suites. */
export const FLOW_EVALS: readonly FlowEvalMeta[] = [
  { id: 'groundedness', label: 'Groundedness', description: 'Is every claim supported by the retrieved sources?' },
  { id: 'relevance', label: 'Relevance', description: 'Does the answer address the question asked?' },
  { id: 'coherence', label: 'Coherence', description: 'Is the answer logically structured and consistent?' },
  { id: 'fluency', label: 'Fluency', description: 'Is the answer grammatically well-formed?' },
  { id: 'safety', label: 'Content safety', description: 'Hate / violence / self-harm / sexual content screening.' },
] as const;

/** Structured guardrails config persisted on the flow. */
export interface FlowGuardrails {
  /** Master switch — when false the layer is a no-op (still recorded). */
  enabled?: boolean;
  /** Redact emails / phone numbers / SSNs / credit-card numbers from the output. */
  redactPii?: boolean;
  /** Deny the turn (input OR output) when it contains any of these terms (case-insensitive). */
  blockedTerms?: string[];
  /** Fail the turn when NO source query actually executed (no grounded rows). */
  requireGrounding?: boolean;
  /** Hard cap on answer length (chars); 0 / undefined ⇒ no cap. */
  maxOutputChars?: number;
  /** Selected eval suite ids (recorded on each run for the quality posture). */
  evals?: string[];
}

/** A single guardrail finding. */
export interface GuardrailViolation {
  rule: string;
  severity: 'block' | 'warn';
  message: string;
}

/** Outcome of applying the output guardrails to a produced answer. */
export interface GuardrailResult {
  /** The possibly-redacted / possibly-truncated answer. */
  answer: string;
  /** True when a guardrail BLOCKS the turn (input denial / grounding failure). */
  blocked: boolean;
  /** Every finding (block + warn). */
  violations: GuardrailViolation[];
  /** Ids of the guardrails that actually ran (audit). */
  applied: string[];
}

/** Baseline guardrails a NEW flow starts with (opt-out, per loom_default_on). */
export const DEFAULT_GUARDRAILS: FlowGuardrails = {
  enabled: true,
  redactPii: true,
  blockedTerms: [],
  requireGrounding: false,
  maxOutputChars: 0,
  evals: ['groundedness', 'relevance'],
};

/** Coerce a persisted `guardrails` blob into a clean FlowGuardrails. */
export function normalizeGuardrails(raw: unknown): FlowGuardrails {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GUARDRAILS };
  const r = raw as Record<string, unknown>;
  const evalIds = new Set(FLOW_EVALS.map((e) => e.id));
  return {
    enabled: r.enabled !== false,
    redactPii: r.redactPii !== false,
    blockedTerms: Array.isArray(r.blockedTerms)
      ? Array.from(new Set(r.blockedTerms.map((t) => String(t || '').trim()).filter(Boolean))).slice(0, 50)
      : [],
    requireGrounding: r.requireGrounding === true,
    maxOutputChars: Number.isFinite(Number(r.maxOutputChars)) && Number(r.maxOutputChars) > 0
      ? Math.min(Math.floor(Number(r.maxOutputChars)), 100_000)
      : 0,
    evals: Array.isArray(r.evals)
      ? Array.from(new Set(r.evals.map((e) => String(e)).filter((e) => evalIds.has(e))))
      : [],
  };
}

// ── real PII redaction (deterministic regex layer) ──────────────────────────
const PII_PATTERNS: Array<{ rule: string; re: RegExp; mask: string }> = [
  { rule: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: '[redacted-email]' },
  { rule: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: '[redacted-ssn]' },
  { rule: 'credit-card', re: /\b(?:\d[ -]?){13,16}\b/g, mask: '[redacted-card]' },
  { rule: 'phone', re: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, mask: '[redacted-phone]' },
];

/** Redact PII from text; returns the cleaned text + the rules that fired. */
export function redactPii(text: string): { text: string; hits: string[] } {
  let out = text;
  const hits: string[] = [];
  for (const p of PII_PATTERNS) {
    if (p.re.test(out)) {
      hits.push(p.rule);
      out = out.replace(new RegExp(p.re.source, p.re.flags), p.mask);
    }
  }
  return { text: out, hits };
}

/** Which blocked terms appear in `text` (case-insensitive whole-substring). */
function matchedBlockedTerms(text: string, terms: string[]): string[] {
  const lc = text.toLowerCase();
  return terms.filter((t) => t && lc.includes(t.toLowerCase()));
}

/**
 * INPUT guardrails — run BEFORE the model. A blocked term in the question denies
 * the turn (no model call). Returns the blocking violations (empty ⇒ proceed).
 */
export function checkInputGuardrails(g: FlowGuardrails, question: string): GuardrailViolation[] {
  if (g.enabled === false) return [];
  const hits = matchedBlockedTerms(question, g.blockedTerms || []);
  return hits.map((t) => ({ rule: 'blocked-term', severity: 'block' as const, message: `Input contains a blocked term: "${t}".` }));
}

/**
 * OUTPUT guardrails — run AFTER the model produced an answer. Applies PII
 * redaction, blocked-term denial, the grounding requirement, and the length cap.
 * `ctx.executedRows` = at least one source query returned rows this turn.
 */
export function applyOutputGuardrails(
  g: FlowGuardrails,
  answer: string,
  ctx: { executedRows: boolean } = { executedRows: false },
): GuardrailResult {
  const applied: string[] = [];
  const violations: GuardrailViolation[] = [];
  let out = String(answer ?? '');
  let blocked = false;

  if (g.enabled === false) {
    return { answer: out, blocked: false, violations: [], applied: [] };
  }

  if (g.redactPii) {
    applied.push('redact-pii');
    const { text, hits } = redactPii(out);
    out = text;
    for (const h of hits) violations.push({ rule: `pii:${h}`, severity: 'warn', message: `Redacted ${h} from the answer.` });
  }

  if ((g.blockedTerms || []).length) {
    applied.push('blocked-terms');
    const hits = matchedBlockedTerms(out, g.blockedTerms || []);
    if (hits.length) {
      blocked = true;
      for (const t of hits) violations.push({ rule: 'blocked-term', severity: 'block', message: `Output contains a blocked term: "${t}".` });
    }
  }

  if (g.requireGrounding) {
    applied.push('require-grounding');
    if (!ctx.executedRows) {
      blocked = true;
      violations.push({ rule: 'require-grounding', severity: 'block', message: 'No source query returned grounded rows, but grounding is required for this flow.' });
    }
  }

  if (g.maxOutputChars && out.length > g.maxOutputChars) {
    applied.push('max-output');
    out = out.slice(0, g.maxOutputChars) + '…';
    violations.push({ rule: 'max-output', severity: 'warn', message: `Answer truncated to ${g.maxOutputChars} characters.` });
  }

  if (blocked) {
    out = 'This answer was withheld by the flow guardrails: ' +
      violations.filter((v) => v.severity === 'block').map((v) => v.message).join(' ');
  }

  return { answer: out, blocked, violations, applied };
}

/** Count of active guardrails (for the run receipt + canvas badge). */
export function activeGuardrailCount(g: FlowGuardrails): number {
  if (g.enabled === false) return 0;
  let n = 0;
  if (g.redactPii) n++;
  if ((g.blockedTerms || []).length) n++;
  if (g.requireGrounding) n++;
  if (g.maxOutputChars) n++;
  return n;
}
