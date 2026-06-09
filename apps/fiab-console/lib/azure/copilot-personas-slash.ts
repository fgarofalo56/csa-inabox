/**
 * copilot-personas-slash.ts — which slash commands are available in which Loom
 * editor surface. This is the authority behind the acceptance criterion
 * "commands unavailable in a persona are hidden (not stubbed)": every Copilot
 * surface asks `getPersonaCommands(<persona>)` for its visible commands rather
 * than hard-coding a list, so a command that a surface cannot honestly fulfil
 * simply does not render — no greyed-out button, no "coming soon" tooltip
 * (per ui-parity.md + no-vaporware.md).
 *
 * Pure data + a couple of pure helpers — no Azure SDK, no React — so it is
 * importable from both client editors and server routes/tests.
 *
 * Lives in its own module (separate from copilot-personas.ts) so its
 * PersonaId / PersonaDef / PERSONAS / getPersona symbols don't collide with the
 * chips + activator + agent-config persona registries in copilot-personas.ts.
 *
 * Per-persona rationale:
 *  - notebook       — the CopilotChatPane in the notebook editor. All four
 *                     commands are fully implemented by /api/copilot/notebook-assist
 *                     (real AOAI, live Delta schema, real cell error capture).
 *  - sql-warehouse  — the SqlCopilotEditor shared by the SQL warehouse family
 *                     (warehouse / synapse-dedicated / synapse-serverless /
 *                     databricks-sql-warehouse). All four commands are
 *                     implemented by /api/items/[type]/[id]/assist — including
 *                     a real EXPLAIN plan for /optimize where the engine exposes
 *                     one (SET SHOWPLAN_TEXT for Synapse T-SQL, EXPLAIN for
 *                     Databricks Spark SQL).
 *  - kql-queryset   — the KQL Queryset assist edge. KQL has no standard EXPLAIN
 *                     plan surface and the Loom KQL assist implements only
 *                     explain + fix, so comments + optimize are HIDDEN here — not
 *                     stubbed. Hiding them is the correct behaviour per the
 *                     acceptance criteria.
 *  - cross-item     — the cross-item CopilotConsoleView (orchestrator). All four
 *                     commands are exposed as registered tools (sql_explain /
 *                     sql_fix / sql_comments / sql_optimize) the model can call.
 */

import {
  SLASH_COMMAND_REGISTRY,
  type SlashCommandDef,
  type SlashCommandName,
} from '@/lib/copilot/slash-commands';

export type PersonaId = 'notebook' | 'sql-warehouse' | 'kql-queryset' | 'cross-item';

export interface PersonaDef {
  id: PersonaId;
  label: string;
  /** Which slash commands are available (and therefore visible) in this persona. */
  commands: SlashCommandName[];
  /** Human label of the underlying engine family (used in optimize-hint copy). */
  engine?: string;
}

export const PERSONAS: readonly PersonaDef[] = [
  {
    id: 'notebook',
    label: 'Notebook Copilot',
    commands: ['explain', 'fix', 'comments', 'optimize'],
    engine: 'Spark / Python notebook',
  },
  {
    id: 'sql-warehouse',
    label: 'Warehouse Copilot',
    commands: ['explain', 'fix', 'comments', 'optimize'],
    engine: 'SQL warehouse',
  },
  {
    id: 'kql-queryset',
    label: 'KQL Queryset Copilot',
    // KQL exposes no standard EXPLAIN plan and the assist edge implements only
    // explain + fix — comments + optimize are hidden here, not stubbed.
    commands: ['explain', 'fix'],
    engine: 'Kusto (KQL)',
  },
  {
    id: 'cross-item',
    label: 'Cross-item Copilot',
    commands: ['explain', 'fix', 'comments', 'optimize'],
    engine: 'multi-service',
  },
];

const PERSONA_BY_ID: Record<PersonaId, PersonaDef> = PERSONAS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<PersonaId, PersonaDef>,
);

/** Look up a persona by id. */
export function getPersona(personaId: PersonaId): PersonaDef {
  return PERSONA_BY_ID[personaId];
}

/**
 * Return the SLASH_COMMAND_REGISTRY entries available in a persona, in registry
 * order. Commands not in the persona's set are omitted entirely (hidden, not
 * stubbed) — this is what every Copilot surface renders.
 */
export function getPersonaCommands(personaId: PersonaId): SlashCommandDef[] {
  const persona = PERSONA_BY_ID[personaId];
  if (!persona) return [];
  const allowed = new Set<SlashCommandName>(persona.commands);
  return SLASH_COMMAND_REGISTRY.filter((c) => allowed.has(c.command));
}

/** True when a given command is available in a given persona. */
export function personaHasCommand(personaId: PersonaId, command: SlashCommandName): boolean {
  const persona = PERSONA_BY_ID[personaId];
  return !!persona && persona.commands.includes(command);
}
