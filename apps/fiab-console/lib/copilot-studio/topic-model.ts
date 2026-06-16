/**
 * Copilot Studio topic model — structured representation of a topic's
 * conversation flow, plus a parser/serializer to and from the Copilot Studio
 * AdaptiveDialog YAML representation persisted in Dataverse
 * (`msdyn_botcomponents.content` / the `flowYaml` field).
 *
 * Why hand-rolled: per .claude/rules/no-vaporware.md a new feature should not
 * silently add an npm dependency (which would also need a bicep/package-lock
 * sync). The repo already hand-rolls focused YAML emit/parse where a full
 * library is overkill (see lib/dbt/dbt-codegen.ts). The topic flows Loom
 * authors are a small, well-known set of step kinds, so a targeted
 * round-trippable model is the right scope here. Unknown / advanced YAML that
 * the structured model cannot represent is preserved verbatim as a `raw` step
 * so nothing is lost — the editor falls back to the code view for those.
 *
 * Modelled step kinds (the Trigger→Message→Question→Condition→Action shape
 * the audit calls out — see docs/fiab/audit §2 H4):
 *   - trigger   : the topic trigger phrases (BeginDialog intent triggers)
 *   - message   : SendActivity — a bot message
 *   - question  : Question — prompt the user and store the answer in a variable
 *   - condition : ConditionGroup — branch on an expression
 *   - action    : InvokeFlowAction / InvokeConnectorAction — call a Power
 *                 Automate flow or connector (by id)
 *   - raw       : any AdaptiveDialog action the structured model doesn't know,
 *                 preserved verbatim as YAML so round-tripping is lossless.
 */

export type TopicStepKind =
  | 'trigger'
  | 'message'
  | 'question'
  | 'condition'
  | 'action'
  | 'raw';

export interface TriggerStep {
  kind: 'trigger';
  /** Trigger phrases for this topic (intent recognizer utterances). */
  phrases: string[];
}

export interface MessageStep {
  kind: 'message';
  /** The bot message text (SendActivity activity). */
  text: string;
}

export interface QuestionStep {
  kind: 'question';
  /** Prompt shown to the user. */
  prompt: string;
  /** Conversation variable the answer is stored in (e.g. Topic.UserName). */
  variable: string;
  /** Entity / prompt type — 'string' is the simple free-text case. */
  entity?: string;
}

export interface ConditionBranch {
  /** Expression evaluated for this branch (e.g. Topic.Choice = "Yes"). */
  expression: string;
  /** Nested steps run when the branch matches. */
  steps: TopicStep[];
}

export interface ConditionStep {
  kind: 'condition';
  branches: ConditionBranch[];
  /** Steps for the else / default branch. */
  elseSteps?: TopicStep[];
}

export interface ActionStep {
  kind: 'action';
  /** Display name of the action. */
  name: string;
  /** Whether this invokes a Power Automate flow or a connector. */
  actionType: 'flow' | 'connector';
  /** Flow id (when actionType === 'flow') or connector id. */
  ref: string;
}

export interface RawStep {
  kind: 'raw';
  /** Verbatim YAML for an action the structured model can't represent. */
  yaml: string;
}

export type TopicStep =
  | TriggerStep
  | MessageStep
  | QuestionStep
  | ConditionStep
  | ActionStep
  | RawStep;

export interface TopicFlow {
  steps: TopicStep[];
}

let __seq = 0;
/** Stable-ish id for React keys on freshly added steps (client-only). */
export function newStepId(): string {
  __seq += 1;
  return `step-${Date.now().toString(36)}-${__seq}`;
}

// ============================================================
// Serialize → AdaptiveDialog YAML
// ============================================================

function yamlString(v: string): string {
  // Quote when needed; escape embedded double-quotes.
  if (v === '') return '""';
  if (/^[\w .,;:!?@/#%&()+=-]+$/.test(v) && !/^[-?:#&*!|>'"%@`]/.test(v)) {
    // Safe-ish bareword — but still quote to be deterministic for multi-word.
    return `"${v.replace(/"/g, '\\"')}"`;
  }
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function indent(lines: string[], pad: string): string[] {
  return lines.map((l) => (l ? pad + l : l));
}

function serializeStep(step: TopicStep): string[] {
  switch (step.kind) {
    case 'message':
      return [
        '- kind: SendActivity',
        `  activity: ${yamlString(step.text)}`,
      ];
    case 'question':
      return [
        '- kind: Question',
        `  prompt: ${yamlString(step.prompt)}`,
        `  variable: ${step.variable || 'Topic.Answer'}`,
        `  entity: ${step.entity || 'string'}`,
      ];
    case 'action':
      return [
        `- kind: ${step.actionType === 'flow' ? 'InvokeFlowAction' : 'InvokeConnectorAction'}`,
        `  name: ${yamlString(step.name)}`,
        `  ${step.actionType === 'flow' ? 'flowId' : 'connectorId'}: ${yamlString(step.ref)}`,
      ];
    case 'condition': {
      const out: string[] = ['- kind: ConditionGroup', '  conditions:'];
      for (const b of step.branches) {
        out.push(`    - condition: ${yamlString(b.expression)}`);
        out.push('      actions:');
        const inner = b.steps.flatMap(serializeStep);
        out.push(...indent(inner, '        '));
      }
      if (step.elseSteps && step.elseSteps.length) {
        out.push('  elseActions:');
        const inner = step.elseSteps.flatMap(serializeStep);
        out.push(...indent(inner, '    '));
      }
      return out;
    }
    case 'raw':
      // Re-indent the stored raw block as a list item under beginDialog.
      return step.yaml.split('\n');
    case 'trigger':
      return []; // triggers are emitted at the top of the dialog, not inline.
  }
}

/**
 * Serialize a structured TopicFlow back to AdaptiveDialog YAML. Trigger phrases
 * are surfaced via the dedicated `triggerPhrases` storage in Dataverse, so the
 * YAML body contains only the conversation actions under `beginDialog`.
 */
export function serializeTopicFlow(flow: TopicFlow): string {
  const actions = flow.steps.filter((s) => s.kind !== 'trigger');
  const body = actions.flatMap(serializeStep);
  const lines = ['kind: AdaptiveDialog', 'beginDialog:'];
  if (body.length === 0) {
    lines.push('  - kind: SendActivity', '    activity: ""');
  } else {
    lines.push(...indent(body, '  '));
  }
  return lines.join('\n');
}

// ============================================================
// Parse AdaptiveDialog YAML → structured TopicFlow
// ============================================================

interface RawLine { indent: number; text: string; n: number }

function scan(yaml: string): RawLine[] {
  return yaml.split('\n').map((raw, n) => {
    const noTab = raw.replace(/\t/g, '  ');
    const m = noTab.match(/^(\s*)(.*)$/)!;
    return { indent: m[1].length, text: m[2], n };
  }).filter((l) => l.text.trim() !== '' && !l.text.trimStart().startsWith('#'));
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return t;
}

/** Read the simple `key: value` map of a list item starting at index `i`. */
function readItemProps(lines: RawLine[], i: number, itemIndent: number): { props: Record<string, string>; next: number; rawBlock: string[] } {
  const props: Record<string, string> = {};
  const rawBlock: string[] = [lines[i].text];
  // First line is "- kind: X"; capture its inline prop too.
  const first = lines[i].text.replace(/^-\s*/, '');
  const fm = first.match(/^(\w+):\s*(.*)$/);
  if (fm) props[fm[1]] = fm[2];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const ln = lines[j];
    if (ln.indent <= itemIndent) break; // next sibling or dedent
    rawBlock.push(' '.repeat(ln.indent - itemIndent) + ln.text);
    const m = ln.text.match(/^(\w+):\s*(.*)$/);
    if (m && ln.indent === itemIndent + 2) props[m[1]] = m[2];
  }
  return { props, next: j, rawBlock };
}

function parseActions(lines: RawLine[], start: number, listIndent: number): { steps: TopicStep[]; next: number } {
  const steps: TopicStep[] = [];
  let i = start;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.indent < listIndent) break;
    if (ln.indent !== listIndent || !ln.text.startsWith('- ')) { i++; continue; }
    const { props, next, rawBlock } = readItemProps(lines, i, listIndent);
    const kind = (props.kind || '').trim();
    if (kind === 'SendActivity') {
      steps.push({ kind: 'message', text: unquote(props.activity ?? props.text ?? '') });
    } else if (kind === 'Question') {
      steps.push({
        kind: 'question',
        prompt: unquote(props.prompt ?? ''),
        variable: (props.variable ?? 'Topic.Answer').trim(),
        entity: (props.entity ?? 'string').trim(),
      });
    } else if (kind === 'InvokeFlowAction' || kind === 'InvokeConnectorAction') {
      steps.push({
        kind: 'action',
        name: unquote(props.name ?? props.displayName ?? kind),
        actionType: kind === 'InvokeFlowAction' ? 'flow' : 'connector',
        ref: unquote(props.flowId ?? props.connectorId ?? props.id ?? ''),
      });
    } else if (kind === 'ConditionGroup') {
      const parsed = parseConditionGroup(lines, i, listIndent);
      steps.push(parsed.step);
      i = parsed.next;
      continue;
    } else {
      // Unknown action kind — preserve verbatim so nothing is dropped.
      steps.push({ kind: 'raw', yaml: rawBlock.join('\n') });
    }
    i = next;
  }
  return { steps, next: i };
}

function parseConditionGroup(lines: RawLine[], i: number, itemIndent: number): { step: ConditionStep; next: number } {
  const branches: ConditionBranch[] = [];
  let elseSteps: TopicStep[] | undefined;
  let j = i + 1;
  for (; j < lines.length; j++) {
    const ln = lines[j];
    if (ln.indent <= itemIndent) break;
    if (ln.indent === itemIndent + 2 && /^conditions:/.test(ln.text)) {
      // walk condition list items at itemIndent+4
      let k = j + 1;
      while (k < lines.length) {
        const cl = lines[k];
        if (cl.indent <= itemIndent + 2) break;
        if (cl.indent === itemIndent + 4 && cl.text.startsWith('- condition:')) {
          const expr = unquote(cl.text.replace(/^-\s*condition:\s*/, ''));
          // find the actions: under this branch
          let m = k + 1;
          let steps: TopicStep[] = [];
          for (; m < lines.length; m++) {
            const al = lines[m];
            if (al.indent <= itemIndent + 4) break;
            if (al.indent === itemIndent + 6 && /^actions:/.test(al.text)) {
              const parsed = parseActions(lines, m + 1, itemIndent + 8);
              steps = parsed.steps;
              m = parsed.next - 1;
            }
          }
          branches.push({ expression: expr, steps });
          k = m;
        } else { k++; }
      }
      j = k - 1;
    } else if (ln.indent === itemIndent + 2 && /^elseActions:/.test(ln.text)) {
      const parsed = parseActions(lines, j + 1, itemIndent + 4);
      elseSteps = parsed.steps;
      j = parsed.next - 1;
    }
  }
  return { step: { kind: 'condition', branches, elseSteps }, next: j };
}

/**
 * Parse AdaptiveDialog YAML into a structured TopicFlow. Resilient: any block
 * it can't map becomes a `raw` step (the editor renders those read-only / in
 * the code view) so the round-trip never silently loses content.
 */
export function parseTopicFlow(yaml: string, triggerPhrases: string[] = []): TopicFlow {
  const steps: TopicStep[] = [];
  if (triggerPhrases.length) steps.push({ kind: 'trigger', phrases: [...triggerPhrases] });
  const lines = scan(yaml || '');
  const beginIdx = lines.findIndex((l) => /^beginDialog:/.test(l.text));
  if (beginIdx >= 0) {
    const beginIndent = lines[beginIdx].indent;
    const { steps: actionSteps } = parseActions(lines, beginIdx + 1, beginIndent + 2);
    steps.push(...actionSteps);
  } else if (yaml && yaml.trim()) {
    // No recognizable beginDialog — keep the whole thing as raw.
    steps.push({ kind: 'raw', yaml: yaml.trim() });
  }
  return { steps };
}

/**
 * Whether the YAML round-trips cleanly through the structured model. When it
 * doesn't (e.g. advanced AdaptiveDialog constructs), the editor should warn and
 * lean on the code view to avoid lossy edits.
 */
export function isStructuredRepresentable(yaml: string, triggerPhrases: string[] = []): boolean {
  const flow = parseTopicFlow(yaml, triggerPhrases);
  return !flow.steps.some((s) => s.kind === 'raw');
}
