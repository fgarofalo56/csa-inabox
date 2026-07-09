/**
 * copilot-personas-eventstream.ts — Eventstream inline Copilot builder config
 * (G1). Feeds the shared makeCopilotBuilderRoute so the Eventstream editor gets
 * a real AOAI-grounded "build my topology in natural language" pane with
 * checkpoint/restore safety.
 *
 * Azure-native DEFAULT (no-fabric-dependency.md): a CSA Loom Eventstream is an
 * Azure Event Hubs stream processed by Azure Stream Analytics. The topology
 * lives in the Loom-native Cosmos item.state ({ source, sink, sources[],
 * sinks[], transforms[] }) — this builder edits THAT (works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset; never contacts api.fabric.microsoft.com).
 *
 * Server-only config (imported by the assist route). No React, no Azure SDK
 * beyond the shared route helper's use of aoai-chat-client.
 */

import type {
  BuilderOp,
  CopilotBuilderConfig,
} from '@/app/api/items/_lib/copilot-builder-route';

/** The Loom-native eventstream topology doc (a subset of item.state). */
export interface EventstreamDoc {
  source?: Record<string, any>;
  sink?: Record<string, any>;
  sources: Array<Record<string, any>>;
  sinks: Array<Record<string, any>>;
  transforms: Array<Record<string, any>>;
}

/** Transform kinds the designer + SAQL compiler recognize. */
const TRANSFORM_KINDS = ['filter', 'aggregate', 'group-by', 'project', 'union', 'join', 'manage-fields', 'expand'] as const;
/** Destination (sink) kinds. */
const SINK_KINDS = ['kusto', 'lakehouse', 'eventhub', 'reflex', 'derivedStream'] as const;

function asArray(v: unknown): Array<Record<string, any>> {
  return Array.isArray(v) ? (v as Array<Record<string, any>>) : [];
}

function readDoc(state: Record<string, unknown>): EventstreamDoc {
  return {
    source: (state.source as Record<string, any>) || undefined,
    sink: (state.sink as Record<string, any>) || undefined,
    sources: asArray(state.sources),
    sinks: asArray(state.sinks),
    transforms: asArray(state.transforms),
  };
}

/** All source display names (single `source` + multi `sources[]`). */
function sourceNames(doc: EventstreamDoc): string[] {
  const out: string[] = [];
  if (doc.source?.name) out.push(String(doc.source.name));
  for (const s of doc.sources) if (s?.name) out.push(String(s.name));
  return [...new Set(out)];
}
function sinkNames(doc: EventstreamDoc): string[] {
  const out: string[] = [];
  if (doc.sink?.name) out.push(String(doc.sink.name));
  for (const s of doc.sinks) if (s?.name) out.push(String(s.name));
  return [...new Set(out)];
}
function transformNames(doc: EventstreamDoc): string[] {
  return doc.transforms.map((t) => String(t?.name || '')).filter(Boolean);
}

function groundingText(doc: EventstreamDoc): string {
  const lines: string[] = [];
  const srcs = sourceNames(doc);
  const snks = sinkNames(doc);
  lines.push(`SOURCES: ${srcs.length ? srcs.map((n, i) => `${n} (${(doc.source?.name === n ? doc.source?.kind : doc.sources.find((s) => s.name === n)?.kind) || 'eventhub'})`).join(', ') : '(none yet)'}`);
  lines.push(`TRANSFORMS: ${doc.transforms.length ? doc.transforms.map((t) => `${t.name} [${t.kind}]`).join(' → ') : '(none yet)'}`);
  lines.push(`DESTINATIONS: ${snks.length ? snks.join(', ') : '(none yet)'}`);
  return lines.join('\n');
}

function computeStats(doc: EventstreamDoc): Record<string, number> {
  return {
    sources: sourceNames(doc).length,
    transforms: doc.transforms.length,
    destinations: sinkNames(doc).length,
  };
}

const SYSTEM_PROMPT = `You translate a natural-language request into a STRUCTURED edit plan for a CSA Loom Eventstream topology.
CSA Loom is its OWN Azure product (Event Hubs + Azure Stream Analytics) — NOT Microsoft Fabric. Never mention Microsoft Fabric.
Respond with a JSON object ONLY: { "summary": "...", "ops": [ ... ] }. No prose, no code fence.
Each op is ONE of:
  { "kind": "add-transform", "transformKind": "filter|aggregate|group-by|project|union|join|manage-fields|expand", "name": "<new transform name>" }
  { "kind": "rename-transform", "from": "<existing transform name>", "to": "<new name>" }
  { "kind": "remove-transform", "name": "<existing transform name>" }
  { "kind": "add-destination", "sinkKind": "kusto|lakehouse|eventhub|reflex|derivedStream", "name": "<new destination name>" }
RULES:
 - Reference ONLY transform names that appear in the LIVE ITEM CONTEXT for rename/remove. Never invent an existing name.
 - New transform / destination names must be short, kebab-or-lower identifiers unique within the topology.
 - Map intent to the closest transform kind (e.g. "keep only errors" → filter; "count per minute" → aggregate; "join with X" → join).
 - If nothing valid can be done, return { "summary": "...", "ops": [] } explaining why in summary.`;

function badgeFor(kind: string): { badge: string; badgeColor: BuilderOp['badgeColor'] } {
  switch (kind) {
    case 'add-transform': return { badge: 'Add transform', badgeColor: 'brand' };
    case 'rename-transform': return { badge: 'Rename', badgeColor: 'informative' };
    case 'remove-transform': return { badge: 'Remove', badgeColor: 'danger' };
    case 'add-destination': return { badge: 'Add destination', badgeColor: 'success' };
    default: return { badge: kind, badgeColor: 'informative' };
  }
}

function normalizeOps(rawOps: unknown[], doc: EventstreamDoc): BuilderOp[] {
  const tNames = new Set(transformNames(doc));
  const ops: BuilderOp[] = [];
  for (const o of rawOps as any[]) {
    const kind = String(o?.kind || '').trim();
    if (kind === 'add-transform') {
      const tk = String(o?.transformKind || '').trim();
      const name = String(o?.name || '').trim();
      if (!name || !(TRANSFORM_KINDS as readonly string[]).includes(tk)) continue;
      if (tNames.has(name)) continue; // duplicate name
      ops.push({ kind, transformKind: tk, name, ...badgeFor(kind), describe: `Add ${tk} transform “${name}”` });
    } else if (kind === 'rename-transform') {
      const from = String(o?.from || '').trim();
      const to = String(o?.to || '').trim();
      if (!from || !to || from === to || !tNames.has(from) || tNames.has(to)) continue;
      ops.push({ kind, from, to, ...badgeFor(kind), describe: `Rename transform “${from}” → “${to}”` });
    } else if (kind === 'remove-transform') {
      const name = String(o?.name || '').trim();
      if (!name || !tNames.has(name)) continue;
      ops.push({ kind, name, ...badgeFor(kind), describe: `Remove transform “${name}”` });
    } else if (kind === 'add-destination') {
      const sk = String(o?.sinkKind || '').trim();
      const name = String(o?.name || '').trim();
      if (!name || !(SINK_KINDS as readonly string[]).includes(sk)) continue;
      if (sinkNames(doc).includes(name)) continue;
      ops.push({ kind, sinkKind: sk, name, ...badgeFor(kind), describe: `Add ${sk} destination “${name}”` });
    }
  }
  return ops;
}

function applyOps(doc: EventstreamDoc, ops: BuilderOp[], _state: Record<string, unknown>) {
  const transforms = doc.transforms.map((t) => ({ ...t }));
  const sinks = doc.sinks.map((s) => ({ ...s }));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const op of ops) {
    if (op.kind === 'add-transform') {
      if (transforms.some((t) => t.name === op.name)) { skipped.push(`Transform “${op.name}” already exists.`); continue; }
      transforms.push({ kind: String(op.transformKind), name: String(op.name) });
      applied.push(`Added ${op.transformKind} transform “${op.name}”.`);
    } else if (op.kind === 'rename-transform') {
      const idx = transforms.findIndex((t) => t.name === op.from);
      if (idx < 0) { skipped.push(`Transform “${op.from}” not found.`); continue; }
      if (transforms.some((t) => t.name === op.to)) { skipped.push(`A transform named “${op.to}” already exists.`); continue; }
      transforms[idx] = { ...transforms[idx], name: String(op.to) };
      applied.push(`Renamed transform “${op.from}” → “${op.to}”.`);
    } else if (op.kind === 'remove-transform') {
      const idx = transforms.findIndex((t) => t.name === op.name);
      if (idx < 0) { skipped.push(`Transform “${op.name}” not found.`); continue; }
      transforms.splice(idx, 1);
      applied.push(`Removed transform “${op.name}”.`);
    } else if (op.kind === 'add-destination') {
      if (sinks.some((s) => s.name === op.name)) { skipped.push(`Destination “${op.name}” already exists.`); continue; }
      sinks.push({ kind: String(op.sinkKind), name: String(op.name) });
      applied.push(`Added ${op.sinkKind} destination “${op.name}”.`);
    }
  }
  // Persist multi-sink array; keep single `sink` as the first sink for the
  // legacy designer read path.
  const patch: Record<string, unknown> = { transforms };
  if (sinks.length) { patch.sinks = sinks; patch.sink = doc.sink ?? sinks[0]; }
  return { patch, applied, skipped };
}

export const EVENTSTREAM_BUILDER_CONFIG: CopilotBuilderConfig<EventstreamDoc> = {
  itemType: 'eventstream',
  docKeys: ['source', 'sink', 'sources', 'sinks', 'transforms'],
  checkpointsKey: 'eventstreamCheckpoints',
  readDoc,
  computeStats,
  systemPrompt: SYSTEM_PROMPT,
  groundingText,
  normalizeOps,
  applyOps,
  maxCompletionTokens: 900,
};
