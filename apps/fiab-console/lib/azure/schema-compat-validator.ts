/**
 * Avro structural schema-compatibility validator — pure, zero-dependency.
 *
 * Implements the exact compatibility rules that the Azure Event Hubs Schema
 * Registry (and Confluent Schema Registry) enforce server-side, so Loom's
 * Cosmos-backed `event-schema-set` editor can BLOCK incompatible registrations
 * BEFORE persisting — no external registry required. When a real Event Hubs
 * Schema Registry schema group IS configured (LOOM_EH_SCHEMA_GROUP), the
 * version route delegates to the service's own PUT-time enforcement instead;
 * this validator is the always-available Azure-native default path.
 *
 * ── Rules (per Avro spec + EH SR / Confluent compatibility model) ───────────
 * Compatibility is checked field-by-field between the LATEST registered schema
 * (the "reader" or "writer", depending on direction) and the proposed new one:
 *
 *  BACKWARD — a consumer using the NEW schema can read data written with the
 *             OLD schema.
 *    • Deleting a field is OK (the new reader simply ignores it).
 *    • Adding a field is OK ONLY if it has a `default` (old data has no value
 *      for it, so the reader must supply the default).
 *    • Changing a field's type to an incompatible type is a violation.
 *
 *  FORWARD  — a consumer using the OLD schema can read data written with the
 *             NEW schema.
 *    • Adding a field is OK (the old reader ignores the unknown field).
 *    • Deleting a field is OK ONLY if it had a `default` in the OLD schema
 *      (old reader needs a value when new data omits it).
 *    • Changing a field's type to an incompatible type is a violation.
 *
 *  FULL     — BACKWARD and FORWARD simultaneously. Effectively: every added
 *             field needs a default AND every removed field needed a default.
 *
 *  NONE     — no check; always compatible.
 *
 * Type-change rule: two field types are "compatible" when they are identical,
 * OR they form an Avro-promotable pair (int→long→float→double, string↔bytes).
 * Anything else (e.g. string→int, record→array) is a breaking change.
 *
 * ── Format scope ────────────────────────────────────────────────────────────
 * EH SR only performs schema evolution/compatibility checks for **Avro**.
 * JSON Schema and Protobuf groups are created with `None` compatibility, so for
 * those formats this validator returns compatible:true (no Avro rules applied),
 * matching the real service's behavior — never a false block.
 *
 * Pure (no I/O, no Azure credentials) → fully unit-testable in vitest.
 */

export type CompatMode = 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE';

export type SchemaFormat = 'AVRO' | 'JSON' | 'PROTOBUF';

export interface CompatResult {
  /** True when the new schema satisfies the requested compatibility mode. */
  compatible: boolean;
  /** Human-readable breaking-change descriptions (empty when compatible). */
  violations: string[];
}

interface AvroField {
  name: string;
  type: unknown;
  hasDefault: boolean;
}

/**
 * Avro numeric/byte type-promotion graph. A writer type can be read as any
 * type it promotes TO (per the Avro spec "Schema Resolution" rules).
 */
const PROMOTIONS: Record<string, string[]> = {
  int: ['int', 'long', 'float', 'double'],
  long: ['long', 'float', 'double'],
  float: ['float', 'double'],
  double: ['double'],
  string: ['string', 'bytes'],
  bytes: ['bytes', 'string'],
};

/** Normalize a field `type` value to a comparable primitive-type label. */
function typeLabel(t: unknown): string {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    // Union — sort member labels so ['null','string'] === ['string','null'].
    return `union<${t.map(typeLabel).sort().join('|')}>`;
  }
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>;
    if (typeof o.type === 'string') {
      // Named/complex type — include name for records/enums/fixed so two
      // differently-named records aren't considered the same type.
      if (o.name) return `${o.type}:${String(o.name)}`;
      if (o.items) return `array<${typeLabel(o.items)}>`;
      if (o.values) return `map<${typeLabel(o.values)}>`;
      return String(o.type);
    }
  }
  return JSON.stringify(t);
}

/**
 * Is a value written under `writerType` readable under `readerType`?
 * Identical labels always pass; otherwise check the Avro promotion graph for
 * primitive pairs.
 */
function typesCompatible(writerType: unknown, readerType: unknown): boolean {
  const w = typeLabel(writerType);
  const r = typeLabel(readerType);
  if (w === r) return true;
  const promotable = PROMOTIONS[w];
  return Array.isArray(promotable) && promotable.includes(r);
}

/** Parse an Avro record schema's top-level fields. Throws on invalid JSON. */
function parseFields(schemaJson: string, which: 'old' | 'new'): AvroField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson);
  } catch (e) {
    throw new Error(`${which} schema is not valid JSON: ${(e as Error).message}`);
  }
  const root = parsed as Record<string, unknown>;
  const rawFields = root?.fields;
  if (!Array.isArray(rawFields)) {
    // Non-record Avro (primitive/enum/array root) has no fields to evolve.
    return [];
  }
  return rawFields.map((f) => {
    const fo = (f || {}) as Record<string, unknown>;
    return {
      name: String(fo.name ?? ''),
      type: fo.type,
      // `default` may legitimately be null/0/false — presence is what matters.
      hasDefault: Object.prototype.hasOwnProperty.call(fo, 'default'),
    };
  });
}

/**
 * Check Avro structural compatibility of `newSchemaJson` against
 * `oldSchemaJson` under `mode`. The Cosmos-backed default path uses this to
 * gate registration; EH SR enforces the same rules server-side when configured.
 *
 * `format` lets the caller short-circuit non-Avro formats (JSON/Protobuf),
 * which EH SR does not evolution-check — those always return compatible.
 */
export function checkAvroCompat(
  oldSchemaJson: string,
  newSchemaJson: string,
  mode: CompatMode,
  format: SchemaFormat = 'AVRO',
): CompatResult {
  if (mode === 'NONE') return { compatible: true, violations: [] };
  // EH SR only evolution-checks Avro; JSON/Protobuf groups are None-compat.
  if (format !== 'AVRO') return { compatible: true, violations: [] };

  let oldFields: AvroField[];
  let newFields: AvroField[];
  try {
    oldFields = parseFields(oldSchemaJson, 'old');
    newFields = parseFields(newSchemaJson, 'new');
  } catch (e) {
    return { compatible: false, violations: [(e as Error).message] };
  }

  const violations: string[] = [];
  const oldByName = new Map(oldFields.map((f) => [f.name, f]));
  const newByName = new Map(newFields.map((f) => [f.name, f]));

  const checkBackward = mode === 'BACKWARD' || mode === 'FULL';
  const checkForward = mode === 'FORWARD' || mode === 'FULL';

  // Added fields: present in NEW, absent in OLD.
  for (const nf of newFields) {
    if (oldByName.has(nf.name)) continue;
    if (checkBackward && !nf.hasDefault) {
      violations.push(
        `field '${nf.name}' was added without a default value — a consumer on the new schema cannot read old data (BACKWARD)`,
      );
    }
    // FORWARD permits added fields (old reader ignores them) — no violation.
  }

  // Removed fields: present in OLD, absent in NEW.
  for (const of of oldFields) {
    if (newByName.has(of.name)) continue;
    if (checkForward && !of.hasDefault) {
      violations.push(
        `field '${of.name}' was removed but had no default in the old schema — a consumer on the old schema cannot read new data (FORWARD)`,
      );
    }
    // BACKWARD permits removed fields (new reader ignores them) — no violation.
  }

  // Retained fields: type changes must be promotion-compatible in BOTH
  // directions that are being enforced.
  for (const nf of newFields) {
    const of = oldByName.get(nf.name);
    if (!of) continue;
    // BACKWARD: new reader reads old writer → old type must promote to new.
    if (checkBackward && !typesCompatible(of.type, nf.type)) {
      violations.push(
        `field '${nf.name}' changed type from ${typeLabel(of.type)} to ${typeLabel(nf.type)} (not BACKWARD-compatible)`,
      );
    }
    // FORWARD: old reader reads new writer → new type must promote to old.
    if (checkForward && !typesCompatible(nf.type, of.type)) {
      violations.push(
        `field '${nf.name}' changed type from ${typeLabel(of.type)} to ${typeLabel(nf.type)} (not FORWARD-compatible)`,
      );
    }
  }

  // De-dupe (FULL can flag the same field twice from both directions).
  const unique = Array.from(new Set(violations));
  return { compatible: unique.length === 0, violations: unique };
}
