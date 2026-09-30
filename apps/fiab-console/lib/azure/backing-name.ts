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
 *
 * ONE EXCEPTION: lakehouse storage roots. A lakehouse root is a DATA directory,
 * and its contents belong to exactly one Loom item, so two same-name lakehouses
 * must not resolve to one directory. New lakehouses therefore get an item-unique
 * root from {@link lakehouseItemRootPath} (display name + item id), and the
 * directory carries an ownership marker ({@link LAKEHOUSE_OWNER_METADATA_KEY}).
 * {@link lakehouseRootPath} stays as the name-only root that items created
 * before {@link LAKEHOUSE_ITEM_ROOT_SINCE} (and the installer) already use —
 * existing roots are not moved.
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

/**
 * The ITEM-UNIQUE root of a lakehouse created on or after
 * {@link LAKEHOUSE_ITEM_ROOT_SINCE}: `lakehouses/<name>--<itemId>`.
 *
 * Why this shape, and not the name-only {@link lakehouseRootPath}:
 *   - Display names are neither unique nor stable (two items may share one, and
 *     an item can be renamed), so a root derived from the name alone would be
 *     shared by every same-name lakehouse. The full item id makes it unique.
 *   - The name part is FLATTENED to a single segment (`/` becomes `-`), so every
 *     item root is exactly one level under `lakehouses/` and no item root can
 *     ever sit inside another one.
 *   - The name is kept as a prefix so the directory is still recognisable in
 *     Storage Explorer next to the Loom item (auto-bind-by-default §2), and the
 *     exact mapping is recorded in the item's state (`lakehouseRoot`).
 *
 * `itemId` alone is the root when the name sanitizes to nothing.
 */
export function lakehouseItemRootPath(displayName: string, itemId: string): string {
  const flat = safeAdlsRelPath(displayName).replace(/\//g, '-');
  return `${LAKEHOUSE_ROOT_PREFIX}${flat ? `${flat}--${itemId}` : itemId}`;
}

/**
 * Is `root` a path of the shape a lakehouse root takes — `lakehouses/<sanitised
 * segments>`, a fixpoint of {@link safeAdlsRelPath}? Anything else is not a root
 * Loom wrote.
 */
export function isLakehouseRootShape(root: string): boolean {
  if (!root.startsWith(LAKEHOUSE_ROOT_PREFIX)) return false;
  if (root.length <= LAKEHOUSE_ROOT_PREFIX.length) return false;
  return safeAdlsRelPath(root) === root;
}

/**
 * Is `root` this item's own item root — `lakehouses/<name>--<itemId>` or
 * `lakehouses/<itemId>`, one segment, as {@link lakehouseItemRootPath} builds?
 */
export function isLakehouseItemRootOf(root: string, itemId: string): boolean {
  if (!itemId || !isLakehouseRootShape(root)) return false;
  const seg = root.slice(LAKEHOUSE_ROOT_PREFIX.length);
  if (seg.includes('/')) return false;
  return seg === itemId || seg.endsWith(`--${itemId}`);
}

/**
 * ADLS directory-metadata key naming the Loom item that owns a lakehouse root.
 * ADLS metadata keys are case-insensitive and are returned lower-cased, so the
 * key is lower-case here and is read case-insensitively.
 */
export const LAKEHOUSE_OWNER_METADATA_KEY = 'loomitemid';

/**
 * Lakehouses created before this instant may keep files under a name-only root
 * they never recorded, so the resolver also looks for one there
 * ({@link lakehouseRootPath}). This is the ONLY thing the instant decides: a
 * RECORDED root is honoured whatever the item's age, so an item created by an
 * older build after this instant keeps the root it recorded. An item whose
 * `createdAt` is missing or unparsable is treated as created before it, which
 * only ever adds the name-only root to what is probed.
 */
export const LAKEHOUSE_ITEM_ROOT_SINCE = '2026-09-29T00:00:00.000Z';

/** Was this lakehouse created on or after {@link LAKEHOUSE_ITEM_ROOT_SINCE}? */
export function lakehouseUsesItemRoot(createdAt: unknown): boolean {
  if (typeof createdAt !== 'string') return false;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && t >= Date.parse(LAKEHOUSE_ITEM_ROOT_SINCE);
}

/**
 * The item fields that say where a lakehouse's files are. Read by the resolver
 * (before it adopts an unmarked name root) and by the readiness check
 * `lib/admin/env-checks/lakehouse-shared-roots.ts`, so both compare the same thing.
 */
export interface LakehouseRootFacts {
  id: string;
  /** The item's workspace (its Cosmos partition), for links and for writes. */
  workspaceId?: unknown;
  displayName?: unknown;
  createdAt?: unknown;
  /** state._recycled — truthy for a recycled item, whose files remain until purge. */
  recycled?: unknown;
  /** state.lakehouseRoot / state.adlsContainer — the binding auto-bind records. */
  lakehouseRoot?: unknown;
  adlsContainer?: unknown;
  /** state.storageAccount — an explicit external account. */
  storageAccount?: unknown;
  /** state.provisioning.secondaryIds.{adlsRoot,container,rootPath} — the installer's stamp. */
  provAdlsRoot?: unknown;
  provContainer?: unknown;
  provRootPath?: unknown;
}

/** Where one lakehouse's files are, as far as its item record says. */
export interface LakehouseRootLocation {
  id: string;
  /** '' = the primary Loom account; null = not known from the record (matches any). */
  account: string | null;
  /** null = not recorded; the resolver would probe for it (matches any). */
  container: string | null;
  segments: string[];
  /** true when read from a recorded binding, false when derived from the name. */
  recorded: boolean;
}

function factStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function rootSegments(p: string): string[] {
  return p.split('/').map((s) => s.trim()).filter(Boolean);
}

/**
 * The root a lakehouse item uses: the installer's stamp, else the recorded
 * auto-bind binding, else the root the resolver would look for — the name-only
 * root for an item created before {@link LAKEHOUSE_ITEM_ROOT_SINCE} (it may have
 * files there from before item roots existed), the item root otherwise.
 *
 * A recorded root counts whatever the item's age, exactly as the resolver
 * treats it: an item created by an older build keeps the name-only root it
 * recorded.
 */
export function lakehouseRootLocation(f: LakehouseRootFacts): LakehouseRootLocation | null {
  const id = factStr(f.id);
  if (!id) return null;
  const explicitAccount = factStr(f.storageAccount).toLowerCase();
  const stamped = factStr(f.provAdlsRoot).match(/^abfss:\/\/([^@]+)@[^/]+\/(.*)$/i);
  if (stamped) {
    // The stamped URI names the account, but whether that is the primary one is
    // not knowable here, so it is compared as "any account".
    return { id, account: null, container: stamped[1], segments: rootSegments(stamped[2]), recorded: true };
  }
  const provContainer = factStr(f.provContainer);
  const provRoot = factStr(f.provRootPath);
  if (provContainer && provRoot) {
    return { id, account: explicitAccount, container: provContainer, segments: rootSegments(provRoot), recorded: true };
  }
  const boundRoot = factStr(f.lakehouseRoot);
  if (boundRoot) {
    return { id, account: explicitAccount, container: factStr(f.adlsContainer) || null, segments: rootSegments(boundRoot), recorded: true };
  }
  const name = factStr(f.displayName);
  const derived = lakehouseUsesItemRoot(f.createdAt) ? lakehouseItemRootPath(name, id) : lakehouseRootPath(name, id);
  return { id, account: explicitAccount, container: null, segments: rootSegments(derived), recorded: false };
}

/**
 * Do two lakehouse roots share files? Same account and container (an unknown
 * one matches any), and one root's segments are a prefix of the other's —
 * `lakehouses/Sales` overlaps `lakehouses/Sales/2024`, not `lakehouses/Sales-archive`.
 */
export function lakehouseRootsOverlap(a: LakehouseRootLocation, b: LakehouseRootLocation): boolean {
  if (a.account !== null && b.account !== null && a.account !== b.account) return false;
  if (a.container !== null && b.container !== null && a.container !== b.container) return false;
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) if (a.segments[i] !== b.segments[i]) return false;
  return true;
}

/**
 * The lakehouse `state` keys that record WHERE its data lives. They are written
 * only by the server (auto-bind and the resolver's persist), never by a request
 * body: see `app/api/items/_lib/server-derived-scope.ts`.
 */
export const LAKEHOUSE_SERVER_OWNED_STATE_KEYS = ['lakehouseRoot', 'adlsContainer', 'ownedContainers'] as const;

/**
 * The lakehouse `state` keys a NEW item never takes from the state it was
 * created with: the storage location keys above, plus the installer's receipt
 * (`provisioning`, whose `secondaryIds` name a container and root) and an
 * explicit account (`storageAccount`). Every one of them says where an item's
 * files are, so when a create copies state from somewhere else (a template, a
 * bundle, a promoted or branched item) they describe the SOURCE item's location,
 * not the new one's. The new item gets its own root from auto-bind or the
 * installer instead. Stripped by `createOwnedItem`, by the auto-bind create hook
 * and by the bundle import's create arm.
 */
export const LAKEHOUSE_CREATE_CLEARED_STATE_KEYS = [
  ...LAKEHOUSE_SERVER_OWNED_STATE_KEYS,
  'provisioning',
  'storageAccount',
] as const;

/**
 * `state` without {@link LAKEHOUSE_CREATE_CLEARED_STATE_KEYS} (and any `extra`
 * keys), plus the names that were present and removed. Pure; never mutates.
 */
export function withoutLakehouseCreateState(
  state: Record<string, unknown> | null | undefined,
  extra: readonly string[] = [],
): { state: Record<string, unknown>; removed: string[] } {
  const next: Record<string, unknown> = { ...(state && typeof state === 'object' ? state : {}) };
  const removed: string[] = [];
  for (const k of [...LAKEHOUSE_CREATE_CLEARED_STATE_KEYS, ...extra]) {
    if (Object.prototype.hasOwnProperty.call(next, k)) {
      delete next[k];
      removed.push(k);
    }
  }
  return { state: next, removed };
}

/**
 * The containers a NEW lakehouse root prefers, in order: `landing` (the raw
 * zone, a new lakehouse's natural home — the installer provisioner at
 * `lib/install/provisioners/lakehouse.ts` makes the same choice), then
 * `bronze`. Anything else configured follows in the order given.
 */
export const LAKEHOUSE_CONTAINER_PREFERENCE = ['landing', 'bronze'] as const;

/**
 * THE container decision for a lakehouse root (#4759) — ONE function, read by
 * both halves of the binding:
 *
 *   - `lakehouseAutoBind.preflight` (auto-bind-providers.ts) takes element [0]
 *     as the container it CREATES the root in;
 *   - `resolveLakehouseAbfss` (lakehouse-abfss.ts) walks the same order to FIND
 *     a root no binding was persisted for.
 *
 * #4759 was these two disagreeing: auto-bind created `landing/lakehouses/<n>`
 * while the resolver's fallback walked `KNOWN_CONTAINERS` and answered
 * `bronze`, so every freshly created lakehouse opened on a 404.
 *
 * It lives HERE, in a module with no imports, because the resolver is reached
 * from a dozen routes: importing it from the provider module would pull every
 * provider's backend into each of them (`docs/fiab/route-inventory.md`).
 *
 * Order: `pinned` (if configured), then {@link LAKEHOUSE_CONTAINER_PREFERENCE},
 * then every other configured container in the order given. Only CONFIGURED
 * containers are returned; an empty result means there is nowhere for a
 * lakehouse to live.
 */
export function lakehouseContainerOrder(
  configured: readonly string[],
  pinned?: string | null,
): string[] {
  const order: string[] = [];
  const push = (c: string | null | undefined) => {
    if (c && configured.includes(c) && !order.includes(c)) order.push(c);
  };
  push(pinned);
  for (const c of LAKEHOUSE_CONTAINER_PREFERENCE) push(c);
  for (const c of configured) push(c);
  return order;
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
