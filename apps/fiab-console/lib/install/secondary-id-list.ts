/**
 * `secondaryIds` LIST-VALUED KEY CODEC — #3920.
 *
 * `ProvisionResult.secondaryIds` is a `Record<string, string>`, so every
 * list-valued outcome key (`seededTables`, `folders`, `synapseViews`,
 * `shortcutsActive`, …) has to be flattened to one string. Until this module
 * they were all `array.join(',')`, and every reader was `String(v).split(',')`.
 *
 * WHY THAT IS WRONG, MEASURED RATHER THAN ASSUMED. The values in those lists
 * are Loom table / folder / view names derived from user-supplied display
 * names, and the sanitizer they pass through (`safeAdlsRelPath` in
 * `lib/azure/backing-name.ts`) is STRUCTURAL, not charset-based: it normalises
 * separators and drops `.`/`..`/empty segments and nothing else. A `,` in a
 * table name therefore survives into the recorded value, so a lakehouse with a
 * table called `Sales, EMEA` records `seededTables: 'Sales, EMEA'` and every
 * reader splits it into the two names `Sales` and `EMEA` — neither of which
 * exists. `lakehouse.ts` already stated exactly this in the comment above
 * `seedCsvPaths` (which it encodes as JSON for that reason) and called the
 * sibling keys' comma join a "latent flaw". This module closes it.
 *
 * ENCODING. `encodeIdList` emits a JSON array (`["a","b"]`) — the same
 * self-delimiting shape `seedCsvPaths` already uses, so a separator inside a
 * value is escaped by the JSON writer rather than colliding with the
 * delimiter.
 *
 * DECODING IS BACKWARD-COMPATIBLE, and must stay that way: items provisioned
 * before this change carry the legacy `a,b` form in Cosmos, and Cosmos is not
 * migrated. `decodeIdList` therefore reads the JSON form when the value looks
 * like a JSON array and falls back to the legacy comma split otherwise. The
 * legacy branch keeps the legacy AMBIGUITY (that is what the old data means —
 * we cannot recover the intent of a stored `a,b`); it is the new writes that
 * are unambiguous.
 *
 * Deliberately dependency-free so BOTH the server provisioner and the client
 * editor can import it without pulling an Azure SDK into the browser bundle.
 */

/** Encode a list of ids/names into a single `secondaryIds` string value. */
export function encodeIdList(values: readonly string[]): string {
  return JSON.stringify(values.map((v) => String(v)));
}

/**
 * Decode a `secondaryIds` list value written by `encodeIdList` OR by the
 * legacy `join(',')` form. Returns `[]` for absent/blank/unparseable values —
 * a reader asks "which tables were seeded", and "the value is not a list I can
 * read" answers that with "none I can name", never with a fabricated entry.
 */
export function decodeIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch {
      // Not valid JSON despite the leading `[`. Fall through to the legacy
      // split rather than throwing — a malformed value must not sink a render.
    }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
