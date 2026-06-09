/**
 * Slash-command parser + registry — the single source of truth for the Loom
 * Copilot slash commands (`/explain`, `/fix`, `/comments`, `/optimize`).
 *
 * This is pure TypeScript: no Azure SDK, no React, no fetch — so it is trivially
 * unit-testable and importable from both the client (CopilotChatPane slash menu,
 * SqlCopilotEditor toolbar) and server (BFF mode validation, orchestrator tool
 * descriptions). It encodes ONE fixed allowlist of commands (per
 * loom-no-freeform-config: no free-form command injection — a leading token that
 * is not one of the four known commands parses to `null`, never a new command).
 *
 * The parser regex is the same one CopilotChatPane already used inline; lifting
 * it here removes the duplication and lets a unit test pin the contract:
 *   parseSlashCommand('/explain SELECT 1') → { command:'explain', arg:'SELECT 1', raw }
 *   parseSlashCommand('/unknown foo')      → null   (not in the allowlist)
 *   parseSlashCommand('hello')             → null   (no leading slash)
 *
 * `producesCode` marks the commands whose result is runnable code that must go
 * through the approval-diff / Apply affordance before it replaces the user's
 * code (fix / comments / optimize). `explain` returns prose only.
 */

export type SlashCommandName = 'explain' | 'fix' | 'comments' | 'optimize';

/** The FIXED allowlist. Nothing outside this set can ever parse to a command. */
export const KNOWN_COMMANDS = ['explain', 'fix', 'comments', 'optimize'] as const;

export interface ParsedSlashCommand {
  /** One of the four known commands. */
  command: SlashCommandName;
  /** Everything after the command token and its trailing whitespace (may be ''). */
  arg: string;
  /** The original, untrimmed input string. */
  raw: string;
}

export interface SlashCommandDef {
  command: SlashCommandName;
  /** Display label including the leading slash, e.g. '/explain'. */
  label: string;
  /** One-line help shown in the slash menu / tooltip. */
  help: string;
  /**
   * True when this command produces runnable code (fix / comments / optimize)
   * that should be routed through the approval-diff / Apply affordance before it
   * overwrites the user's code. `explain` is false — it returns prose only.
   */
  producesCode: boolean;
}

/**
 * The slash-command registry — the single source of truth for labels, help, and
 * whether each command produces code. Personas (copilot-personas.ts) select a
 * subset of these; the UI never hard-codes the list.
 */
export const SLASH_COMMAND_REGISTRY: readonly SlashCommandDef[] = [
  {
    command: 'explain',
    label: '/explain',
    help: 'Explain what the selected code or query does, in plain language',
    producesCode: false,
  },
  {
    command: 'fix',
    label: '/fix',
    help: 'Fix the error in the current cell or query using the real error text',
    producesCode: true,
  },
  {
    command: 'comments',
    label: '/comments',
    help: 'Add inline comments to the selected code, preserving its logic',
    producesCode: true,
  },
  {
    command: 'optimize',
    label: '/optimize',
    help: 'Rewrite the selection for performance with engine-specific hints',
    producesCode: true,
  },
];

/** Type guard: is `s` one of the four known command names? */
export function isKnownCommand(s: string): s is SlashCommandName {
  return (KNOWN_COMMANDS as readonly string[]).includes(s);
}

/**
 * Parse a leading slash command from a user input string.
 *
 * Returns `null` when the input does not start with a `/<knownCommand>` token —
 * i.e. plain text, or a `/foo` that is not in the fixed allowlist. The command
 * match is case-insensitive on the token; `arg` preserves the original casing
 * and is the remainder after the command and its following whitespace.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (typeof input !== 'string') return null;
  // ^/(word)\b<ws>(rest) — `s` flag so a multi-line arg (e.g. a pasted query)
  // is captured whole. Same shape the chat pane used inline.
  const m = input.match(/^\/(\w+)\b[ \t]*([\s\S]*)$/);
  if (!m) return null;
  const command = m[1].toLowerCase();
  if (!isKnownCommand(command)) return null;
  return { command, arg: m[2] ?? '', raw: input };
}

/**
 * True when the slash-command menu should be open: the input is a bare `/` or
 * starts with `/` and contains no whitespace yet (the user is still typing the
 * command token). Once a space is typed the command is "committed" and the menu
 * closes — matching the CopilotChatPane behaviour.
 */
export function isSlashMenuOpen(input: string): boolean {
  return input.startsWith('/') && !/\s/.test(input);
}

/**
 * Filter the registry to the commands whose label prefix-matches the partial
 * input the user has typed so far (e.g. `/ex` → [explain]). Used to drive the
 * slash menu. Pass the raw input; non-slash input yields an empty list.
 */
export function matchSlashCommands(input: string): SlashCommandDef[] {
  if (!isSlashMenuOpen(input)) return [];
  const q = input.toLowerCase();
  return SLASH_COMMAND_REGISTRY.filter((c) => c.label.startsWith(q) || q === '/');
}

/** Look up a single registry entry by command name. */
export function getSlashCommand(command: SlashCommandName): SlashCommandDef {
  const def = SLASH_COMMAND_REGISTRY.find((c) => c.command === command);
  // Registry is exhaustive over SlashCommandName, so this is always defined.
  return def as SlashCommandDef;
}
