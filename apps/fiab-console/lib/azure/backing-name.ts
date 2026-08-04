/**
 * BACKING-OBJECT NAMING — the single deterministic law that maps a Loom item's
 * `displayName` onto the NAME of its Azure backing object.
 *
 * Why this module exists (and why it has ZERO imports).
 * -----------------------------------------------------
 * `.claude/rules/auto-bind-by-default.md` §2: *"The backing Azure object carries
 * the SAME display name as the Loom item (sanitized only where the service's
 * naming rules force it — and then deterministically, and recorded in the item's
 * state so the mapping is inspectable, never guessed)."*
 *
 * Before this module, FIVE independent copies of the mappings auto-bind depends
 * on existed — each provisioner rolled its own inline `.replace(...)`:
 *
 *   lib/install/provisioners/adf-pipeline.ts      safePipelineName()
 *   lib/install/provisioners/synapse-pipeline.ts  safePipelineName()   (a copy)
 *   lib/install/provisioners/kql-db.ts            inline in the handler
 *   lib/azure/eventstream-standup.ts              safeHubName()
 *   lib/install/provisioners/lakehouse.ts         safeRelPath()
 *
 * (Other provisioners — notebook, ml-model, ai-search, databricks-job — carry
 * their own inline sanitizers too. Those are NOT moved here: auto-bind does not
 * back those item types, so there is no second computer of the same name to keep
 * in step, and moving them would be churn without a correctness payoff. This
 * module holds exactly the mappings that TWO code paths must agree on.)
 *
 * That duplication is not cosmetic — it is a CORRECTNESS hazard for auto-bind.
 * The install-time provisioner and the open-time auto-bind engine must compute
 * the SAME name for the same item, or auto-bind will "attach-if-exists" against
 * a name the provisioner never created and CREATE A DUPLICATE backing object
 * beside the real one. Sharing one function makes that impossible BY
 * CONSTRUCTION rather than by a test that re-implements its own subject.
 *
 * Zero imports is deliberate: every provisioner and `auto-bind.ts` import this,
 * and `auto-bind.ts` is itself imported by routes that provisioners can reach.
 * A dependency-free leaf cannot participate in an import cycle.
 *
 * DETERMINISM CONTRACT. `sanitizeBackingName` is a pure function of
 * (displayName, rules). Same input → same output, in every process, forever.
 * It never consults the clock, a random source, the item id, or the estate. A
 * name is therefore reproducible from the Loom displayName alone, which is what
 * makes the mapping inspectable rather than guessed.
 *
 * COLLISION SEMANTICS (deliberate, per the rule). Two Loom items with the same
 * displayName sanitize to the same backing name and therefore BIND TO THE SAME
 * Azure object. That is the operator's stated intent — "mapped and named exactly
 * the same as it is in Loom" plus attach-if-exists. We do NOT append an item-id
 * suffix to disambiguate, because that would break the "named exactly the same"
 * half of the rule and make the name unguessable from the Loom UI. The binding
 * record written by the auto-bind engine records `sourceName` alongside
 * `backingName`, so a shared backing object is always visible on the item.
 */

/** How one Azure service's naming rules constrain a Loom displayName. */
export interface BackingNameRules {
  /**
   * Global regex matching every character (or run of characters) the service
   * does NOT permit. Whether it collapses runs is encoded in the pattern
   * itself (`+` collapses, no quantifier does not) — the existing provisioners
   * differ on this and both behaviours must be reproducible exactly.
   */
  disallowed: RegExp;
  /** What each match of `disallowed` becomes. */
  replacement: string;
  /**
   * Characters trimmed from BOTH ends after replacement — each character of
   * this string is trimmable. '' / absent = no trim.
   */
  trimChars?: string;
  /** Lower-case the name (Event Hubs entity names are case-insensitive). */
  lowercase?: boolean;
  /** Hard truncation length imposed by the service. */
  maxLength: number;
  /** Used verbatim when sanitization leaves nothing (e.g. displayName '###'). */
  fallback: string;
}

export interface BackingName {
  /** The name to use in Azure. */
  name: string;
  /**
   * True when `name !== displayName` — i.e. the service's rules forced a
   * change. Recorded on the item so the divergence is inspectable.
   */
  sanitized: boolean;
  /** True when sanitization emptied the name and `rules.fallback` was used. */
  usedFallback: boolean;
}

/** Trim any of `chars` from both ends (no regex, no escaping). */
function trimEdges(s: string, chars: string): string {
  if (!chars) return s;
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

/**
 * Map a Loom `displayName` onto a legal Azure backing-object name under
 * `rules`. Pure and deterministic — see the DETERMINISM CONTRACT above.
 *
 * Order of operations matters and is fixed: lower-case → replace disallowed →
 * trim edges → truncate → trim edges again → fallback. The second trim exists
 * because truncation can expose a trailing replacement character (e.g. a 140th
 * character that is a `-`), which several services reject.
 */
export function sanitizeBackingName(displayName: string, rules: BackingNameRules): BackingName {
  const source = typeof displayName === 'string' ? displayName : '';
  let n = source;
  if (rules.lowercase) n = n.toLowerCase();
  n = n.replace(rules.disallowed, rules.replacement);
  n = trimEdges(n, rules.trimChars ?? '');
  if (n.length > rules.maxLength) n = n.slice(0, rules.maxLength);
  n = trimEdges(n, rules.trimChars ?? '');
  const usedFallback = n.length === 0;
  if (usedFallback) n = rules.fallback;
  return { name: n, sanitized: n !== source, usedFallback };
}

// ---------------------------------------------------------------------------
// The per-service rule sets.
//
// Each of these REPRODUCES the sanitizer that its provisioner already shipped,
// character for character, so that adopting this module changes no existing
// name. The provisioners now import these instead of re-implementing them.
// ---------------------------------------------------------------------------

/**
 * ADF + Synapse pipeline names. Azure allows letters, digits, `_` and `-`, up
 * to 140 characters. Runs of disallowed characters COLLAPSE to a single `-`
 * (the `+` quantifier), matching `safePipelineName` in both pipeline
 * provisioners and the `NAME_RE` the bind route validates against.
 */
export const PIPELINE_NAME_RULES: BackingNameRules = {
  disallowed: /[^A-Za-z0-9_-]+/g,
  replacement: '-',
  trimChars: '-',
  maxLength: 140,
  fallback: 'loom-pipeline',
};

/**
 * Event Hubs entity names — lower-cased, letters/digits/`.`/`_`/`-`, 256 max
 * (we keep the 200 the existing `safeHubName` uses so an auto-bind attach
 * resolves the hub the eventstream provisioner already created).
 */
export const EVENT_HUB_NAME_RULES: BackingNameRules = {
  disallowed: /[^a-z0-9._-]+/g,
  replacement: '-',
  trimChars: '-',
  lowercase: true,
  maxLength: 200,
  fallback: 'loom-eventstream',
};

/**
 * Azure Data Explorer database names. NOTE the single-character (NOT `+`)
 * replacement and the ABSENCE of edge-trimming: this reproduces
 * `kql-db.ts`'s shipped `displayName.replace(/[^A-Za-z0-9_]/g, '_').slice(0,50)`
 * exactly, including its quirk that `"a  b"` becomes `"a__b"` rather than
 * `"a_b"`. Changing it would silently orphan every ADX database the installer
 * has already created.
 */
export const ADX_DATABASE_NAME_RULES: BackingNameRules = {
  disallowed: /[^A-Za-z0-9_]/g,
  replacement: '_',
  maxLength: 50,
  fallback: 'loomdb',
};

/**
 * The ADLS Gen2 relative path a Loom `displayName` maps to.
 *
 * This is NOT a `BackingNameRules` charset mapping, and deliberately so. A
 * lakehouse root is a PATH, not a single name: `lib/install/provisioners/
 * lakehouse.ts` has always mapped `"a/b"` to the two-level `a/b`, and it keeps
 * spaces (`"Demo lakehouse"` stays `"Demo lakehouse"` — ADLS permits both).
 * A charset rule cannot express that, and a charset rule that flattened `/` to
 * `-` would compute a DIFFERENT root than the installer's, so an auto-bind
 * attach would miss the installer's directory and create a second lakehouse
 * root beside it with the user's data in the wrong one.
 *
 * So this is the installer's own `safeRelPath`, moved here verbatim and now
 * imported by BOTH call sites. Its containment guarantee is structural, not
 * charset-based: it normalises `\` to `/`, splits on `/`, trims each segment,
 * and DROPS every empty, `.`, and `..` segment — so no traversal can survive to
 * take a lakehouse root outside its `lakehouses/` prefix, and `".."` reduces to
 * the empty string (which `lakehouseRootPath` then replaces with the item id).
 */
export function safeAdlsRelPath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** Every Loom lakehouse's Delta root lives under this prefix in its container. */
export const LAKEHOUSE_ROOT_PREFIX = 'lakehouses/';

/**
 * The container-relative root directory of a lakehouse. THE one definition —
 * `lakehouse.ts`'s provisioner and `auto-bind-providers.lakehouseAutoBind` both
 * call this, so a lakehouse that was installed and then opened resolves to the
 * same directory rather than gaining a second one.
 *
 * `itemId` is the fallback for a displayName that sanitizes to nothing (`".."`,
 * `"///"`, `""`), matching the installer's `|| input.cosmosItemId`. It keeps the
 * root unique and inspectable instead of collapsing every unnameable lakehouse
 * onto one shared directory.
 */
export function lakehouseRootPath(displayName: string, itemId: string): string {
  return `${LAKEHOUSE_ROOT_PREFIX}${safeAdlsRelPath(displayName) || itemId}`;
}

// ---------------------------------------------------------------------------
// Named wrappers — THE call sites.
//
// These exist so the install-time provisioner and the open-time auto-bind
// provider are LITERALLY THE SAME FUNCTION CALL, fallback string included. The
// fallback matters: `adf-pipeline.ts` fell back to 'loom-adf-pipeline' and
// `synapse-pipeline.ts` to 'loom-synapse-pipeline', so a shared rule object
// with one baked-in fallback would have quietly changed the name for any item
// whose displayName sanitizes to empty — creating a second backing object next
// to the one the installer had already made. Parameterising the fallback keeps
// every existing name byte-identical.
// ---------------------------------------------------------------------------

/**
 * ADF / Synapse pipeline name for a Loom displayName. `fallback` MUST match
 * the caller's historical value ('loom-adf-pipeline' / 'loom-synapse-pipeline')
 * so an auto-bind attach resolves the object the provisioner created.
 */
export function safePipelineName(displayName: string, fallback: string): string {
  return sanitizeBackingName(displayName, { ...PIPELINE_NAME_RULES, fallback }).name;
}

/** ADX database name for a Loom displayName (kql-db provisioner's mapping). */
export function safeAdxDatabaseName(displayName: string): string {
  return sanitizeBackingName(displayName, ADX_DATABASE_NAME_RULES).name;
}
