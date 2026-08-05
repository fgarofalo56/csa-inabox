/**
 * docs-grounding — the SHARED grounding contract for every docs-RAG answer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (#2929, answer-quality half)
 * ─────────────────────────────────────────────────────────────────────────────
 * The first eval run against a genuinely fresh index (run 30969867157, image
 * 30af2cee) split the residual failures cleanly in two:
 *
 *   • lakehouse / kql-database  — retrieve badly (corpus coverage).
 *   • data-agent / eventstream  — retrieve WELL (hit-rate 0.933 / 0.667) and
 *                                 still fail their pass-rate (0.267 / 0.333).
 *
 * Probing the live `/api/internal/copilot/eval-probe` for every golden row of
 * both surfaces showed the second group is an ANSWER-SYNTHESIS failure, and it
 * is not one bug but four, all of them prompt-shaped:
 *
 * 1. **Parity docs describe TWO products, and the prompt never said so.**
 *    Every `docs/fiab/parity/<slug>.md` is, by `.claude/rules/ui-parity.md`,
 *    literally `## Azure/Fabric feature inventory` (what the OTHER product does)
 *    followed by `## Loom coverage` (what WE do) — plus a fleet of
 *    `docs/fiab/*-parity-spec.md` files that are pure Fabric specs. The model
 *    read the inventory rows as statements about Loom:
 *      - `data-agent-013` ("can I pick tables from a schema tree?") answered
 *        **"Yes … a browsable schema tree"** — Loom's honest answer is *"not
 *        yet, it's a comma-separated input; the picker is a tracked gap."* A
 *        flat factual INVERSION that the grounding judge cannot catch, because
 *        the sentence really is in the excerpt.
 *      - `data-agent-004` answered with Fabric's "generated query expander
 *        (SQL/KQL/**DAX**)" instead of Loom's per-turn tools-used trace.
 *      - `eventstream-010` answered only Fabric's portal-only toggle and
 *        dropped Loom's "start/stop the job in the Stream Analytics editor".
 *
 * 2. **The anti-Fabric guardrail OVER-fired into denying documented features.**
 *    The old prompt asserted "no feature requires a Fabric capacity" as a fact
 *    about the world, so on `eventstream-008` ("can I publish my eventstream to
 *    Fabric?") the model answered **"You cannot publish your eventstream to
 *    Fabric"** — contradicting the retrieved doc, which describes exactly that
 *    opt-in publish path. "Never REQUIRED" and "cannot be done" are different
 *    claims; the prompt conflated them.
 *
 * 3. **Exact identifiers were paraphrased away.** Answers ran 70–200 chars and
 *    dropped the very token the question was about: `Cosmos`, `asa-sync`,
 *    `cURL`, `Foundry`, `SELECT`, the `tools[]` trace, `GROUP BY`, and digits
 *    ("up to **five** data sources" where the doc says 5). Worse than cosmetic
 *    on `data-agent-006`: the doc's guarantee is a SELECT/WITH **allowlist**,
 *    and the answer described an INSERT/UPDATE/DELETE **denylist** — a weaker
 *    and different security claim.
 *
 * 4. **Refusal preferred over a partial answer.** `data-agent-014` refused with
 *    "the documentation excerpts provided do not specify…" while
 *    `docs/fiab/parity/data-agent.md` sat in the context **twice**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT EVAL-GAMING — this module is on the SHIPPED path
 * ─────────────────────────────────────────────────────────────────────────────
 * The eval probe used to carry a PRIVATE copy of this prompt, so "fixing the
 * eval" and "fixing the product" were separable — which is exactly how a prompt
 * tweak becomes score-gaming. They are now the same text: the probe builds its
 * turn from {@link buildGroundedDocsMessages}, and the shipped Help Copilot
 * (`help-copilot-orchestrator`) injects the same {@link DOCS_GROUNDING_RULES}
 * into its system prompt. Every rule below was written against a real wrong
 * answer quoted above, not against a metric.
 *
 * Pure module: no Azure SDK, no config store, no I/O — unit-testable, and
 * importable from both the route and the orchestrator.
 */

/**
 * Characters of each retrieved chunk that count as EVIDENCE — the single source
 * of truth for both the answer prompt and the `preview` the evaluator hands the
 * judge.
 *
 * Issue #2585 P3: these were 1500 and 300 respectively, so the judge was asked
 * "is this claim supported by the excerpts?" while holding 20% of the text the
 * model actually answered from. Any claim drawn from characters 301–1500 looked
 * ungrounded to the judge even when it was perfectly grounded, which made
 * `groundingAvg` untrustworthy in both directions. One constant, both call
 * sites — they cannot drift apart again.
 */
export const EVIDENCE_CHARS = 1500;

/** One retrieved doc chunk as the answer prompt sees it. */
export interface DocExcerpt {
  path: string;
  heading?: string | null;
  content: string;
}

/**
 * The grounding rules every docs-RAG answer must follow. Injected verbatim into
 * BOTH the eval probe's single-turn prompt and the shipped Help Copilot's
 * system prompt, so the two cannot drift.
 *
 * Each rule cites the concrete failure it was written for (see the module
 * header). Keep them imperative and short — this text is prepended to every
 * turn, so prose here is paid for on every request.
 */
export const DOCS_GROUNDING_RULES = [
  'GROUNDING RULES (follow all of them):',
  '1. PARITY DOCS DESCRIBE TWO PRODUCTS. Excerpts from docs/fiab/parity/*.md and any *-parity-spec.md ' +
    'compare CSA Loom against another product. A section, column, or row labelled "Azure/Fabric feature inventory", ' +
    '"Fabric", "Power BI", or "Source UI" states what the OTHER product does — it is background, NOT a claim about ' +
    'CSA Loom. Only "Loom coverage", "Backend per control", and rows marked built/honest-gate/MISSING (✅ ⚠️ ❌) ' +
    'state what CSA Loom does. When the two disagree, answer with what LOOM does. If Loom\'s honest answer is ' +
    '"not yet — that is a tracked gap", say that; never report the other product\'s capability as Loom\'s.',
  '2. FABRIC IS NEVER REQUIRED, BUT IT IS NOT FORBIDDEN. No CSA Loom capability REQUIRES a Microsoft Fabric ' +
    'capacity or a Power BI workspace — every one has an Azure-native default (Event Hubs, Stream Analytics, ADX, ' +
    'Synapse, ADLS, AI Foundry). That is not the same as "Loom cannot interoperate with Fabric": where the excerpts ' +
    'describe an OPT-IN Fabric or Power BI publish/backend, say it exists and that it is opt-in. Never deny a ' +
    'capability the excerpts document in order to sound Azure-native.',
  '3. KEEP EXACT IDENTIFIERS VERBATIM. Carry the excerpt\'s own names and values into the answer: route and API ' +
    'paths (/api/..., asa-sync), environment variables (LOOM_EVENTHUB_NAMESPACE), tab/field/button labels, the ' +
    'backing Azure service or store (Cosmos, Event Hubs, Stream Analytics, Foundry), SQL/KQL keywords (SELECT, ' +
    'WITH, GROUP BY), and every limit or count as DIGITS ("5 data sources", not "five"). Prefer the doc\'s wording ' +
    'over a synonym. An answer that paraphrases the identifier away is a worse answer, and a guarantee restated ' +
    'loosely (an allowlist described as a denylist) is a wrong answer.',
  '4. NAME THE MECHANISM, DO NOT ONLY DESCRIBE IT. When the excerpts give a mechanism, artifact, or component a ' +
    'name — a per-turn trace, an LLM-as-judge, a SELECT/WITH allowlist, a named route or tab — use that name in ' +
    'the answer and then explain it. Reuse the excerpt\'s own noun; do not swap in a generic paraphrase of what it ' +
    'does ("response history" for a trace, "an accuracy score" for an LLM-as-judge).',
  '5. ENUMERATE EVERY OPTION. For where / which / how many / what-are questions, list ALL the options the excerpts ' +
    'give — every publish target, source type, destination, and operator — not just the first one you find.',
  '6. PARTIAL BEATS REFUSAL. Answer with whatever the excerpts DO support and name the specific part they do not ' +
    'cover. Refuse outright only when no retrieved excerpt is relevant to the question at all.',
].join('\n');

/**
 * Render the retrieved chunks as the numbered evidence block both the answer
 * prompt and the judge see. Each chunk is capped at {@link EVIDENCE_CHARS}.
 */
export function renderDocExcerpts(excerpts: DocExcerpt[]): string {
  if (!excerpts.length) return '(no documentation excerpts were retrieved)';
  return excerpts
    .map((e, i) => `[${i + 1}] ${e.path}${e.heading ? ` — ${e.heading}` : ''}\n${e.content.slice(0, EVIDENCE_CHARS)}`)
    .join('\n\n');
}

/**
 * The full docs-RAG system prompt: identity + the grounding rules + the
 * evidence block. Used by the eval probe; the shipped Help Copilot composes the
 * same {@link DOCS_GROUNDING_RULES} into its own (tool-calling) system prompt.
 */
export function buildGroundedDocsSystemPrompt(excerpts: DocExcerpt[]): string {
  return (
    'You are the CSA Loom help Copilot. CSA Loom is an Azure-native analytics platform and its own product — ' +
    'describe every feature as a CSA Loom feature, naming the real Azure services behind it. ' +
    'Answer the question grounded ONLY in the documentation excerpts provided.\n\n' +
    `${DOCS_GROUNDING_RULES}\n\n` +
    `Documentation excerpts:\n${renderDocExcerpts(excerpts)}`
  );
}

/** Grounded single-turn messages — the docs-RAG shape the evaluator judges. */
export function buildGroundedDocsMessages(
  question: string,
  excerpts: DocExcerpt[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: buildGroundedDocsSystemPrompt(excerpts) },
    { role: 'user', content: question },
  ];
}
