/**
 * copilot-personas-mirrored-database.ts — Mirrored Database inline Copilot
 * builder config (G1). NL → structured edits to the set of mirrored tables,
 * grounded on the mirror's real source (type/server/database) + current table
 * list in item.state.
 *
 * Azure-native (no-fabric-dependency.md): a CSA Loom mirrored database is ADF CDC
 * / Synapse Link copying a source into Bronze Delta on ADLS — no Microsoft
 * Fabric mirroring. This builder edits the Loom-native mirror config
 * (item.state.tables[]) with checkpoint/restore; the editor's mirror pane +
 * /state snapshot path consume it.
 */

import type { BuilderOp, CopilotBuilderConfig } from '@/app/api/items/_lib/copilot-builder-route';

interface MirrorTable { schema: string; table: string }
export interface MirroredDbDoc {
  sourceType: string;
  server: string;
  database: string;
  tables: MirrorTable[];
}

function readDoc(state: Record<string, unknown>): MirroredDbDoc {
  const tables = Array.isArray(state.tables)
    ? (state.tables as any[]).filter((t) => t?.schema && t?.table).map((t) => ({ schema: String(t.schema), table: String(t.table) }))
    : [];
  return {
    sourceType: String(state.sourceType || ''),
    server: String(state.server || ''),
    database: String(state.database || ''),
    tables,
  };
}

function computeStats(doc: MirroredDbDoc): Record<string, number> {
  return { tables: doc.tables.length };
}

function groundingText(doc: MirroredDbDoc): string {
  const lines: string[] = [];
  lines.push(`SOURCE: ${doc.sourceType || '(unset)'}${doc.server ? ` @ ${doc.server}` : ''}${doc.database ? ` / ${doc.database}` : ''}`);
  lines.push(`MIRRORED TABLES: ${doc.tables.length ? doc.tables.map((t) => `${t.schema}.${t.table}`).join(', ') : '(none yet)'}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You translate a natural-language request into STRUCTURED edits to the set of tables a CSA Loom mirrored database replicates.
CSA Loom is its OWN Azure product (ADF CDC / Synapse Link → Bronze Delta) — NOT Microsoft Fabric mirroring. Never mention Microsoft Fabric.
Respond with a JSON object ONLY: { "summary": "...", "ops": [ ... ] }. No prose, no code fence.
Each op is ONE of:
  { "kind": "add-table", "schema": "<schema>", "table": "<table>" }
  { "kind": "remove-table", "schema": "<schema>", "table": "<table>" }
RULES:
 - For remove-table, reference ONLY a schema.table already in MIRRORED TABLES. Never invent an existing mirrored table.
 - For add-table, use the schema/table names the user names; default schema to "dbo" for SQL sources when unspecified.
 - If nothing valid can be done, return { "summary": "...", "ops": [] } explaining why.`;

function badgeFor(kind: string): { badge: string; badgeColor: BuilderOp['badgeColor'] } {
  return kind === 'add-table' ? { badge: 'Add table', badgeColor: 'success' } : { badge: 'Remove table', badgeColor: 'danger' };
}

function normalizeOps(rawOps: unknown[], doc: MirroredDbDoc): BuilderOp[] {
  const existing = new Set(doc.tables.map((t) => `${t.schema}.${t.table}`.toLowerCase()));
  const seen = new Set<string>();
  const ops: BuilderOp[] = [];
  for (const o of rawOps as any[]) {
    const kind = String(o?.kind || '').trim();
    const schema = String(o?.schema || '').trim();
    const table = String(o?.table || '').trim();
    if (!schema || !table) continue;
    const key = `${schema}.${table}`.toLowerCase();
    if (kind === 'add-table') {
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      ops.push({ kind, schema, table, ...badgeFor(kind), describe: `Mirror table ${schema}.${table}` });
    } else if (kind === 'remove-table') {
      if (!existing.has(key)) continue;
      ops.push({ kind, schema, table, ...badgeFor(kind), describe: `Stop mirroring ${schema}.${table}` });
    }
  }
  return ops;
}

function applyOps(doc: MirroredDbDoc, ops: BuilderOp[]) {
  const tables = doc.tables.map((t) => ({ ...t }));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const op of ops) {
    const schema = String(op.schema);
    const table = String(op.table);
    const key = `${schema}.${table}`.toLowerCase();
    if (op.kind === 'add-table') {
      if (tables.some((t) => `${t.schema}.${t.table}`.toLowerCase() === key)) { skipped.push(`${schema}.${table} is already mirrored.`); continue; }
      tables.push({ schema, table });
      applied.push(`Added ${schema}.${table} to the mirror set.`);
    } else if (op.kind === 'remove-table') {
      const idx = tables.findIndex((t) => `${t.schema}.${t.table}`.toLowerCase() === key);
      if (idx < 0) { skipped.push(`${schema}.${table} is not in the mirror set.`); continue; }
      tables.splice(idx, 1);
      applied.push(`Removed ${schema}.${table} from the mirror set.`);
    }
  }
  return { patch: { tables }, applied, skipped };
}

export const MIRRORED_DATABASE_BUILDER_CONFIG: CopilotBuilderConfig<MirroredDbDoc> = {
  itemType: 'mirrored-database',
  docKeys: ['tables'],
  checkpointsKey: 'mirroredDatabaseCheckpoints',
  readDoc,
  computeStats,
  systemPrompt: SYSTEM_PROMPT,
  groundingText,
  normalizeOps,
  applyOps,
  maxCompletionTokens: 700,
};
