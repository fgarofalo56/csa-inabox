/**
 * WS-10.5 — Parity Autopilot (BTB-12): the PURE half.
 *
 * Playwright capture → vision-model diff vs the ~432 parity docs → `plan-model`
 * (proposed fix) → `gh issue` filing on a schedule. This module owns the parts
 * that are unit-testable WITHOUT a model, a browser, or GitHub:
 *
 *   1. {@link parseParityDoc}      — a parity doc (docs/fiab/parity/<slug>.md) →
 *                                    a structured {@link ParityInventory}: the
 *                                    surface title, its live route (declared as
 *                                    `Route:` when present), the source-UI line,
 *                                    and every capability row with a normalized
 *                                    status (built / honest-gate / missing).
 *   2. {@link expectedBuiltRows}   — the rows a live surface MUST visibly show
 *                                    (status === 'built'). These are the claims
 *                                    the vision model is asked to verify.
 *   3. {@link buildVisionDiffMessages} / {@link parseVisionDiff} — the vision
 *                                    prompt (screenshot + the built-row claims)
 *                                    and the strict-JSON verdict parser that
 *                                    turns per-row present/absent decisions into
 *                                    a gap list.
 *   4. {@link buildFixPlanMessages} / {@link parseFixPlan} — the `plan-model`
 *                                    prompt + parser: a gap → a proposed
 *                                    remediation plan (summary + ordered steps).
 *   5. {@link shapeGapIssue} / {@link gapIssueFingerprint} — the GitHub issue
 *                                    title/body/labels for a filed gap, plus the
 *                                    stable fingerprint the filer dedupes on.
 *
 * The runtime halves (real AOAI vision call + real GitHub filing + real Cosmos
 * ledger) live in `parity-vision.ts`, `parity-issue.ts`, and the BFF route. No
 * mocks, no `return []` — per no-vaporware.md the only non-functional states are
 * the honest gates surfaced by those runtime halves (no AOAI vision deployment;
 * no GitHub token). This file has NO Azure / network / fs dependency.
 */

import type { AoaiChatMessage } from '@/lib/azure/aoai-model-contract';

/** The GitHub label every auto-filed parity gap carries. */
export const PARITY_AUTOPILOT_LABEL = 'parity-autopilot';

/** Normalized status of a parity-doc capability row. */
export type ParityStatus = 'built' | 'honest-gate' | 'missing' | 'unknown';

/** One capability row parsed from a parity doc's coverage table. */
export interface ParityRow {
  /** The row number as written in the doc (e.g. "1"), or a synthesized index. */
  num: string;
  /** The capability text (the "what") — never empty. */
  capability: string;
  /** Normalized coverage status. */
  status: ParityStatus;
  /** The notes / backend cell, when present. */
  notes?: string;
}

/** A parsed parity doc. */
export interface ParityInventory {
  /** File slug (e.g. "report"). */
  slug: string;
  /** The `# <title>` heading text. */
  title: string;
  /** The live console route to capture, when the doc declares a `Route:` line. */
  route?: string;
  /** The `Source UI:` line, when present (for issue context). */
  source?: string;
  /** Every parsed capability row. */
  rows: ParityRow[];
}

/** A single capability the vision model judged absent on the live surface. */
export interface ParityGap {
  num: string;
  capability: string;
  notes?: string;
  /** The vision model's one-line evidence for why it judged the row absent. */
  evidence: string;
}

/** Per-row vision verdict (present/absent on the captured surface). */
export interface ParityVerdict {
  num: string;
  capability: string;
  present: boolean;
  evidence: string;
}

/** A `plan-model` remediation step. */
export interface FixPlanStep {
  title: string;
  detail?: string;
}

/** A `plan-model` proposed fix for one gap. */
export interface FixPlan {
  summary: string;
  steps: FixPlanStep[];
  /** Repo-relative files the model thinks are involved (best-effort, optional). */
  suggestedFiles?: string[];
  /** Rough effort estimate the model offers ('S' | 'M' | 'L'), when given. */
  effort?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Parse a parity doc.
// ───────────────────────────────────────────────────────────────────────────

/** Map a raw status cell to a normalized {@link ParityStatus}. */
export function normalizeStatus(raw: string): ParityStatus {
  const s = (raw || '').trim().toLowerCase();
  if (!s) return 'unknown';
  // missing / not built — checked FIRST so "not built" / "not installed" are not
  // captured by the "built" substring test below.
  if (
    s.includes('missing') ||
    s.includes('todo') ||
    s.includes('not built') ||
    s.includes('not installed') ||
    s === 'no' ||
    s.includes('❌')
  )
    return 'missing';
  // honest infra-gate / partial
  if (
    s.includes('honest') ||
    s.includes('gate') ||
    s.includes('partial') ||
    s.includes('preview') ||
    s.includes('⚠')
  )
    return 'honest-gate';
  // built / present
  if (/(^|[^a-z])(built|done|shipped|complete|yes)([^a-z]|$)/.test(s) || s.includes('✅')) return 'built';
  return 'unknown';
}

/** True when a markdown line is a table row (`| … |`) that is not a separator. */
function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  // separator row: only |, -, :, spaces
  if (/^\|[\s:|-]+$/.test(t)) return false;
  return true;
}

/** Split a markdown table row into trimmed cell strings (no leading/trailing empties). */
function splitCells(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|');
  return cells.map((c) => c.trim());
}

/**
 * Parse a parity doc markdown into a {@link ParityInventory}.
 *
 * Pure + defensive: the ~432 docs vary in table shape, so we recognize a
 * capability row by the presence of a status cell (built / honest-gate /
 * missing) anywhere in the row rather than by a fixed column index. The
 * capability text is the richest non-status, non-numeric cell to the LEFT of the
 * status cell (falling back to the first non-numeric cell). Rows with no status
 * cell (pure inventory tables like "Power BI feature inventory") are skipped so
 * they never become false "expected" claims.
 */
export function parseParityDoc(md: string, slug: string): ParityInventory {
  const lines = md.split(/\r?\n/);

  let title = slug;
  let route: string | undefined;
  let source: string | undefined;
  for (const line of lines) {
    const h = line.match(/^#(.+)$/);
    if (h && title === slug) title = h[1].trim();
    const r = line.match(/^\s*(?:Live\s+)?Route:\s*`?([^`\s]+)`?/i);
    if (r && !route) {
      const cand = r[1].trim();
      if (cand.startsWith('/')) route = cand;
    }
    const s = line.match(/^[ \t]*Source(?:[ \t]*UI)?:(.+)$/i);
    if (s && !source) source = s[1].trim();
    // Some docs embed the route inside a URL like /admin/foo in a metadata line.
  }

  const rows: ParityRow[] = [];
  let autoIdx = 0;
  for (const line of lines) {
    if (!isTableRow(line)) continue;
    const cells = splitCells(line);
    if (cells.length < 2) continue;

    // Skip header rows (a cell literally named "Status"/"Capability"/"#").
    const lowered = cells.map((c) => c.toLowerCase());
    if (lowered.includes('status') || lowered.includes('capability') || lowered.some((c) => c === '#' || c === 'capability / control')) {
      continue;
    }

    // Find the status cell: the first cell whose normalized status is not 'unknown'
    // AND is short enough to be a status token (not a prose notes cell).
    let statusIdx = -1;
    let status: ParityStatus = 'unknown';
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.length > 24) continue; // prose cell, not a status token
      const norm = normalizeStatus(cell);
      if (norm !== 'unknown') {
        statusIdx = i;
        status = norm;
        break;
      }
    }
    if (statusIdx < 0) continue; // no status cell → not a coverage row

    // Capability = the richest non-numeric cell to the left of the status cell,
    // else the first non-numeric cell anywhere.
    const isNumericOnly = (c: string) => /^#?\d+$/.test(c.replace(/[.)]/g, '').trim());
    let capability = '';
    for (let i = statusIdx - 1; i >= 0; i--) {
      if (!isNumericOnly(cells[i]) && cells[i]) {
        capability = cells[i];
        break;
      }
    }
    if (!capability) {
      capability = cells.find((c) => c && !isNumericOnly(c) && normalizeStatus(c) === 'unknown') || '';
    }
    if (!capability) continue;

    // num = a numeric cell before the capability, else a running index.
    let num = '';
    for (const c of cells) {
      if (isNumericOnly(c)) {
        num = c.replace(/[#.)]/g, '').trim();
        break;
      }
    }
    if (!num) num = String(++autoIdx);

    // notes = the first cell to the RIGHT of status that has prose.
    let notes: string | undefined;
    for (let i = statusIdx + 1; i < cells.length; i++) {
      if (cells[i]) {
        notes = cells[i];
        break;
      }
    }

    rows.push({ num, capability: capability.replace(/`/g, ''), status, notes });
  }

  return { slug, title, route, source, rows };
}

/** The rows a live surface MUST visibly show (status === 'built'). */
export function expectedBuiltRows(inv: ParityInventory): ParityRow[] {
  return inv.rows.filter((r) => r.status === 'built');
}

/** Resolve the route to capture: an explicit override wins, else the doc's `Route:`. */
export function resolveSurfaceRoute(inv: ParityInventory, override?: string | null): string | null {
  const o = (override || '').trim();
  if (o.startsWith('/')) return o;
  if (inv.route && inv.route.startsWith('/')) return inv.route;
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Vision diff prompt + parser.
// ───────────────────────────────────────────────────────────────────────────

/** Cap on how many built rows we send to one vision turn (keeps the prompt bounded). */
export const MAX_VISION_ROWS = 40;

/**
 * Build the AOAI vision chat messages: a system instruction + a user turn whose
 * content is a multimodal array `[ {type:'text', …}, {type:'image_url', …} ]`.
 * The image is passed as a data URL so the model receives the exact captured
 * pixels — the same screenshot the PR receipt carries.
 */
export function buildVisionDiffMessages(args: {
  inventory: Pick<ParityInventory, 'title' | 'slug' | 'source'>;
  rows: ParityRow[];
  imageDataUrl: string;
}): AoaiChatMessage[] {
  const rows = args.rows.slice(0, MAX_VISION_ROWS);
  const rowList = rows.map((r) => `${r.num}. ${r.capability}`).join('\n');
  const system = [
    'You are a meticulous UI parity auditor for the CSA Loom data platform.',
    'You are given ONE screenshot of a Loom surface and a numbered list of',
    'capabilities its parity doc claims are BUILT (present and functional).',
    'For EACH numbered capability, decide whether it is VISIBLY present in the',
    'screenshot — a tab, button, panel, field, grid, chip, or control that would',
    'let a user perform it. Judge only what is visible; do not assume.',
    '',
    'Be conservative: mark present=false ONLY when the capability is clearly',
    'absent from the visible surface (no control, empty pane, error banner, or a',
    'sign-in / crash page). A capability behind a visible tab or menu counts as',
    'present. When unsure, mark present=true (avoid false gaps).',
    '',
    'Return STRICT JSON only, no prose:',
    '{ "verdicts": [ { "num": string, "present": boolean, "evidence": string } ] }',
    'where evidence is a short (<=140 char) reason citing what you saw.',
  ].join('\n');

  const userText = [
    `Surface: ${args.inventory.title} (slug: ${args.inventory.slug})`,
    args.inventory.source ? `Parity source: ${args.inventory.source}` : '',
    '',
    'Capabilities claimed BUILT — verify each is visible in the screenshot:',
    rowList,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: args.imageDataUrl } },
      ],
    },
  ];
}

/** The loose shape the vision model returns before validation. */
interface RawVision {
  verdicts?: unknown;
}

/**
 * Parse the vision model reply into per-row verdicts + the derived gap list.
 * Pure + defensive: unknown nums are dropped; rows the model omitted default to
 * present=true (conservative — a silent row is NOT reported as a gap). A gap is a
 * built row the model explicitly marked present=false.
 */
export function parseVisionDiff(
  raw: RawVision | null | undefined,
  rows: ParityRow[],
): { verdicts: ParityVerdict[]; gaps: ParityGap[] } {
  const byNum = new Map(rows.map((r) => [String(r.num), r]));
  const rawVerdicts = Array.isArray(raw?.verdicts) ? (raw!.verdicts as any[]) : [];
  const seen = new Map<string, { present: boolean; evidence: string }>();
  for (const v of rawVerdicts) {
    if (!v || typeof v !== 'object') continue;
    const num = String(v.num ?? '').trim();
    if (!num || !byNum.has(num)) continue;
    const present = v.present !== false; // default present unless explicitly false
    const evidence = String(v.evidence ?? '').trim().slice(0, 200);
    seen.set(num, { present, evidence });
  }

  const verdicts: ParityVerdict[] = [];
  const gaps: ParityGap[] = [];
  for (const r of rows) {
    const key = String(r.num);
    const hit = seen.get(key);
    const present = hit ? hit.present : true; // omitted → conservative present
    const evidence = hit?.evidence || (hit ? '' : 'not evaluated by the model (defaulted present)');
    verdicts.push({ num: key, capability: r.capability, present, evidence });
    if (!present) {
      gaps.push({ num: key, capability: r.capability, notes: r.notes, evidence });
    }
  }
  return { verdicts, gaps };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. plan-model prompt + parser.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the `plan-model` messages: given one gap (a built-claimed capability the
 * vision model found absent), ask the reasoning tier for a concrete remediation
 * plan. Emits strict JSON so {@link parseFixPlan} can normalize it.
 */
export function buildFixPlanMessages(gap: ParityGap, inv: Pick<ParityInventory, 'title' | 'slug' | 'source'>): AoaiChatMessage[] {
  const system = [
    'You are the CSA Loom platform engineer. A parity-audit vision pass found a',
    'capability that the surface\'s parity doc claims is BUILT but which is NOT',
    'visible on the live surface. Propose a concrete, minimal remediation plan to',
    'restore parity (either build/expose the missing control, or — if the doc is',
    'wrong — correct the parity doc). Prefer the smallest change that closes the',
    'gap. Do NOT invent files; only suggest paths you are confident about.',
    '',
    'Return STRICT JSON only, no prose:',
    '{ "summary": string, "steps": [ { "title": string, "detail": string } ],',
    '  "suggestedFiles": string[], "effort": "S"|"M"|"L" }',
  ].join('\n');
  const user = [
    `Surface: ${inv.title} (slug: ${inv.slug})`,
    inv.source ? `Parity source: ${inv.source}` : '',
    `Missing capability #${gap.num}: ${gap.capability}`,
    gap.notes ? `Doc notes: ${gap.notes}` : '',
    `Vision evidence: ${gap.evidence}`,
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The loose shape the plan model returns before validation. */
interface RawPlan {
  summary?: unknown;
  steps?: unknown;
  suggestedFiles?: unknown;
  effort?: unknown;
}

/** Cap on plan steps so one gap can't emit an unbounded plan. */
export const MAX_PLAN_STEPS = 8;

/** Normalize a plan-model reply into a {@link FixPlan}. Pure + defensive. */
export function parseFixPlan(raw: RawPlan | null | undefined): FixPlan {
  const summary = String(raw?.summary ?? '').trim() || 'No plan summary returned.';
  const rawSteps = Array.isArray(raw?.steps) ? (raw!.steps as any[]) : [];
  const steps: FixPlanStep[] = [];
  for (const s of rawSteps.slice(0, MAX_PLAN_STEPS)) {
    if (typeof s === 'string') {
      const t = s.trim();
      if (t) steps.push({ title: t });
      continue;
    }
    if (s && typeof s === 'object') {
      const title = String(s.title ?? '').trim();
      const detail = String(s.detail ?? '').trim() || undefined;
      if (title) steps.push({ title, detail });
    }
  }
  const suggestedFiles = Array.isArray(raw?.suggestedFiles)
    ? (raw!.suggestedFiles as any[]).map((f) => String(f).trim()).filter(Boolean).slice(0, 12)
    : undefined;
  const effortRaw = String(raw?.effort ?? '').trim().toUpperCase();
  const effort = effortRaw === 'S' || effortRaw === 'M' || effortRaw === 'L' ? effortRaw : undefined;
  return { summary, steps, suggestedFiles: suggestedFiles?.length ? suggestedFiles : undefined, effort };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Issue shaping + fingerprint (dedupe).
// ───────────────────────────────────────────────────────────────────────────

/**
 * A stable fingerprint for a gap — `slug#num`. The filer embeds this as a hidden
 * marker in the issue body so a later run can find + skip an already-open issue
 * for the same gap (idempotent scheduled filing).
 */
export function gapIssueFingerprint(slug: string, num: string): string {
  return `parity-autopilot:${slug}#${num}`;
}

/** The hidden HTML-comment marker line carrying the fingerprint. */
export function fingerprintMarker(fp: string): string {
  return `<!-- ${fp} -->`;
}

export interface ShapedIssue {
  title: string;
  body: string;
  labels: string[];
  fingerprint: string;
}

/**
 * Shape the GitHub issue for one gap + its proposed plan. Pure — the filer
 * (parity-issue.ts) POSTs this verbatim. The body carries the fingerprint marker
 * for dedupe, the vision evidence, and the plan-model steps.
 */
export function shapeGapIssue(args: {
  inventory: Pick<ParityInventory, 'title' | 'slug' | 'source' | 'route'>;
  gap: ParityGap;
  plan: FixPlan;
  runMeta?: { capturedAt?: string; theme?: string; url?: string; deployment?: string };
}): ShapedIssue {
  const { inventory, gap, plan, runMeta } = args;
  const fp = gapIssueFingerprint(inventory.slug, gap.num);
  const title = `[parity-autopilot] ${inventory.slug}: "${gap.capability}" not visible on live surface`;
  const stepLines = plan.steps.length
    ? plan.steps.map((s, i) => `${i + 1}. **${s.title}**${s.detail ? ` — ${s.detail}` : ''}`).join('\n')
    : '_(no steps proposed)_';
  const body = [
    fingerprintMarker(fp),
    `**Surface**: ${inventory.title} (\`${inventory.slug}\`)`,
    inventory.route ? `**Route**: \`${inventory.route}\`` : '',
    inventory.source ? `**Parity source**: ${inventory.source}` : '',
    `**Parity doc**: \`docs/fiab/parity/${inventory.slug}.md\` row #${gap.num}`,
    '',
    '## Gap',
    `The parity doc claims capability **#${gap.num} — ${gap.capability}** is *built*, but the`,
    'Parity Autopilot vision pass did not find it on the live surface.',
    '',
    `> **Vision evidence:** ${gap.evidence || '(none)'}`,
    gap.notes ? `\n> **Doc notes:** ${gap.notes}` : '',
    '',
    '## Proposed plan (auto-generated by `plan-model`)',
    plan.summary,
    '',
    stepLines,
    plan.suggestedFiles?.length ? `\n**Suggested files:** ${plan.suggestedFiles.map((f) => `\`${f}\``).join(', ')}` : '',
    plan.effort ? `\n**Rough effort:** ${plan.effort}` : '',
    '',
    '---',
    '_Filed automatically by the WS-10.5 Parity Autopilot (Playwright capture → AOAI vision diff → `plan-model`). ' +
      'The plan is a proposal — verify before acting; the doc itself may be the thing that is stale (see `check-parity-doc-freshness.mjs`)._',
    runMeta
      ? `\n<sub>run: captured ${runMeta.capturedAt ?? '?'} · theme ${runMeta.theme ?? '?'} · vision ${runMeta.deployment ?? '?'}${runMeta.url ? ` · ${runMeta.url}` : ''}</sub>`
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { title, body, labels: [PARITY_AUTOPILOT_LABEL], fingerprint: fp };
}
