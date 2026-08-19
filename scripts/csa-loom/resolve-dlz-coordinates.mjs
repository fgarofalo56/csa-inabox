#!/usr/bin/env node
/**
 * resolve-dlz-coordinates.mjs — DISCOVER the Data Landing Zone. Never assume it.
 *
 * WHY (deploy-integrity.md R4/R5/R6/R7, auto-bind-by-default.md §5)
 *
 *   `csa-loom-post-deploy-bootstrap.yml` derives every DLZ-scoped coordinate it
 *   uses from two workflow inputs:
 *
 *     DLZ_RG  = rg-csa-loom-dlz-<dlz_domain>-<region>      (dlz_domain default: "single")
 *     DLZ_SUB = <dlz_subscription>  or, empty, the ADMIN subscription
 *
 *   Both defaults describe ONE estate shape: a single-subscription deploy whose
 *   landing zone was stamped by main.bicep's `useSingleDlz` branch. Every OTHER
 *   supported shape — a `dlz-attach` landing zone, a multi-sub estate, any
 *   domain name that is not the literal `single` — silently produces a resource
 *   group name that does not exist, and the callers pass neither input:
 *
 *     full-app-deploy-commercial.yml   dlz_domain: single, no dlz_subscription
 *     deploy-fiab-{commercial,gcc,gcch,il5}.yml
 *                                      dlz_subscription only, no dlz_domain
 *
 *   Measured on the live Commercial estate (run 31243230253, 2026-08-08): 25 of
 *   27 jobs green, then
 *
 *     ERROR: (ResourceGroupNotFound) Resource group
 *            'rg-csa-loom-dlz-single-centralus' could not be found.
 *
 *   The landing zone is `rg-csa-loom-dlz-default-centralus`, in a DIFFERENT
 *   subscription from the admin plane. The bootstrap itself is fine — dispatched
 *   by hand with the right coordinates it went green (run 31239422563, 22+ real
 *   steps). The CALLER passed coordinates nobody had established.
 *
 *   Consequence: on any multi-sub estate the deploy's day-one wiring — MSAL app
 *   registration, Purview roles, Synapse grants, Databricks SCIM, the Synapse
 *   managed private endpoint — never ran as PART of the deploy. It only ever
 *   worked when a human ran it separately. Per auto-bind-by-default.md §5, a
 *   value the platform could have determined must not be asked for.
 *
 * WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT (R7)
 *
 *   It establishes, from Azure Resource Graph across every subscription the
 *   deploy identity can read: which `rg-csa-loom-dlz-<domain>-<region>` resource
 *   groups exist, which subscription each is in, and which Synapse / Databricks
 *   workspaces live inside the chosen one.
 *
 *   It does NOT establish that a landing zone is absent when the read fails, and
 *   it does not pick one when several match. "Could not determine" and "not
 *   present" are different answers with different exit codes, and neither is
 *   ever rendered as the other — the class of bug this repo has hit repeatedly
 *   (a `2>/dev/null` turning a permission denial into a confident negative).
 *
 * WHY THE WORKSPACE NAMES ARE DISCOVERED TOO
 *
 *   The RG's domain segment and the workspace names' domain segment are NOT the
 *   same string. main.bicep's single-sub branch puts `domainName: 'default'`
 *   into `rg-csa-loom-dlz-single-<loc>`, so that estate holds
 *   `syn-loom-default-<loc>`; a multi-sub DLZ named `finance` holds
 *   `syn-loom-finance-<loc>` in `rg-csa-loom-dlz-finance-<loc>`. Deriving the
 *   workspace name from the RG name (or from a hardcoded `default`) is right for
 *   exactly two of those three cases. So both are read from the estate.
 *
 * USAGE
 *   node scripts/csa-loom/resolve-dlz-coordinates.mjs \
 *     --region centralus --admin-subscription <sub> \
 *     [--dlz-subscription <sub>] [--dlz-domain <domain>] \
 *     [--github-env "$GITHUB_ENV"] [--json]
 *
 *   Exit: 0 resolved | 1 no candidate | 2 usage | 3 could not read | 4 ambiguous.
 *
 *   Subscription ids are written to --github-env (a file) and NEVER to stdout;
 *   the human rendering names subscriptions by role ("the admin subscription" /
 *   "a different subscription"), per this repo's log-hygiene rule.
 *
 * Tests: node --test scripts/csa-loom/__tests__/resolve-dlz-coordinates.test.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = Object.freeze({
  RESOLVED: 0,
  NOT_FOUND: 1,
  USAGE: 2,
  UNREADABLE: 3,
  AMBIGUOUS: 4,
});

/**
 * Every Loom DLZ resource group the identity can see, tenant-wide. `resources` /
 * `resourcecontainers` in Resource Graph span every subscription the caller can
 * read, which is the only reason a cross-subscription landing zone is visible at
 * all: the bootstrap logs in to the ADMIN subscription.
 */
export const DLZ_RG_QUERY = [
  'resourcecontainers',
  "| where type =~ 'microsoft.resources/subscriptions/resourcegroups'",
  "| where name startswith 'rg-csa-loom-dlz-'",
  '| project name, subscriptionId, location',
].join(' ');

/** Synapse + Databricks workspaces, tenant-wide; filtered to the chosen DLZ here. */
export const WORKSPACES_QUERY = [
  'resources',
  "| where type =~ 'microsoft.synapse/workspaces' or type =~ 'microsoft.databricks/workspaces'",
  '| project name, type, resourceGroup, subscriptionId',
].join(' ');

export const DLZ_RG_PREFIX = 'rg-csa-loom-dlz-';

/**
 * `rg-csa-loom-dlz-<domain>-<region>` → `<domain>`, or null when the name is not
 * a DLZ group for this region.
 *
 * The domain may be EMPTY: the live Gov `dlz-attach` estate is
 * `rg-csa-loom-dlz--usgovvirginia` (see scripts/csa-loom/gov-dlz-grants.sh), so
 * '' is a real answer and must not be conflated with "no match" (null).
 */
export function domainOfDlzRg(rgName, region) {
  if (!region) return null;
  const name = String(rgName ?? '').toLowerCase();
  const suffix = `-${String(region).toLowerCase()}`;
  if (!name.startsWith(DLZ_RG_PREFIX)) return null;
  if (!name.endsWith(suffix)) return null;
  const end = name.length - suffix.length;
  // `rg-csa-loom-dlz-centralus` — the prefix running straight into the region
  // with no separating dash of its own — is not a DLZ group name. Without this
  // check `slice(start > end)` would quietly return '' and report it as the
  // empty-domain estate, which is a DIFFERENT (and real) shape.
  if (end < DLZ_RG_PREFIX.length) return null;
  return name.slice(DLZ_RG_PREFIX.length, end);
}

export const eqi = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * The Azure CLI binary. Linux/macOS (every CI runner this project uses) get a
 * real executable and `shell: false`. Windows ships `az.cmd`, which Node 20+
 * refuses to spawn without a shell (EINVAL). `LOOM_AZ_BIN` overrides both.
 */
export function azBinary() {
  if (process.env.LOOM_AZ_BIN) return process.env.LOOM_AZ_BIN;
  return process.platform === 'win32' ? 'az.cmd' : 'az';
}

export function azGraphRunner(query) {
  // The KQL goes through the CLI's `@file` argument loading rather than inline:
  // on Windows `az.cmd` is spawned through cmd.exe, which reads the `|` of a KQL
  // pipeline as a shell pipe. Same reasoning as preflight-private-dns-links.mjs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dlz-resolve-'));
  const qf = path.join(dir, 'query.kql');
  fs.writeFileSync(qf, query, 'utf8');
  const args = ['graph', 'query', '-q', `@${qf}`, '--first', '1000', '-o', 'json'];
  const bin = azBinary();
  try {
    const res = spawnSync(bin, args, {
      encoding: 'utf8',
      shell: /\.(cmd|bat)$/i.test(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (res.error) return { status: 127, stdout: '', stderr: res.error.message };
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * stderr is kept and reported. It is never merged into the value and never sent
 * to /dev/null: the CLI writes its preview-extension banner there, and both
 * discarding it (losing the diagnosis) and capturing it into the answer
 * (contaminating it) are defects this repo has shipped before.
 */
function readGraph(run, query) {
  const res = run(query);
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(0, 3).join(' ');
    return { ok: false, reason: `az graph query exited ${res.status}: ${detail || '<no output>'}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || 'null');
  } catch (e) {
    return { ok: false, reason: `az graph query returned output that is not JSON: ${e.message}` };
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(rows)) {
    return { ok: false, reason: 'az graph query returned no `data` array; nothing is asserted about the estate.' };
  }
  return { ok: true, rows };
}

/**
 * Pick a workspace inside the chosen DLZ.
 *
 * Preference order: the exact convention name for this DLZ's domain, then the
 * exact convention name for `default` (main.bicep's single-sub branch names the
 * RG `single` but the workspaces `default`), then any `<prefix>-loom-*`, then a
 * sole workspace of that type whatever it is called. More than one plausible
 * candidate and no convention match is reported rather than guessed.
 */
export function pickWorkspace(rows, { prefix, domain, region }) {
  if (rows.length === 0) return { name: null, how: 'none' };
  if (rows.length === 1) return { name: rows[0].name, how: 'sole' };
  const byName = new Map(rows.map((r) => [String(r.name).toLowerCase(), r.name]));
  const exact = byName.get(`${prefix}-loom-${domain}-${region}`.toLowerCase());
  if (exact) return { name: exact, how: 'convention' };
  const asDefault = byName.get(`${prefix}-loom-default-${region}`.toLowerCase());
  if (asDefault) return { name: asDefault, how: 'convention-default' };
  const looms = rows.filter((r) => String(r.name).toLowerCase().startsWith(`${prefix}-loom-`));
  if (looms.length === 1) return { name: looms[0].name, how: 'prefix' };
  return { name: null, how: 'ambiguous', candidates: rows.map((r) => r.name).sort() };
}

/**
 * @returns {{status:'resolved'|'not-found'|'ambiguous'|'unreadable', …}}
 */
export function resolveDlzCoordinates({
  region,
  adminSubscription,
  dlzSubscription = null,
  dlzDomain = null,
  run = azGraphRunner,
}) {
  const base = {
    region,
    dlzSubscription: null,
    dlzResourceGroup: null,
    dlzDomain: null,
    crossSubscription: null,
    synapseWorkspace: null,
    databricksWorkspace: null,
    notes: [],
    candidates: [],
    reason: null,
  };

  const groups = readGraph(run, DLZ_RG_QUERY);
  if (!groups.ok) return { ...base, status: 'unreadable', reason: groups.reason };

  const all = groups.rows.map((r) => ({
    name: r.name,
    subscriptionId: r.subscriptionId,
    location: r.location,
    domain: domainOfDlzRg(r.name, region),
  }));

  let matched = all.filter((r) => r.domain !== null);
  const seenRegionless = all.length;

  // Explicit overrides NARROW the discovered set — they never bypass it, so an
  // override naming something that does not exist fails loudly instead of
  // producing the same phantom resource-group name this script exists to remove.
  const filters = [];
  if (dlzDomain !== null && dlzDomain !== undefined && dlzDomain !== '') {
    matched = matched.filter((r) => eqi(r.domain, dlzDomain));
    filters.push(`--dlz-domain "${dlzDomain}"`);
  }
  if (dlzSubscription) {
    matched = matched.filter((r) => eqi(r.subscriptionId, dlzSubscription));
    filters.push('--dlz-subscription (supplied)');
  }

  if (matched.length === 0) {
    const regions = [...new Set(all.map((r) => String(r.location ?? '').toLowerCase()).filter(Boolean))].sort();
    return {
      ...base,
      status: 'not-found',
      candidates: all.map((r) => r.name).sort(),
      notes: filters,
      reason:
        `Azure Resource Graph was read successfully and returned ${seenRegionless} resource group(s) named ` +
        `${DLZ_RG_PREFIX}* across every subscription this identity can read, and none of them ` +
        (filters.length
          ? `matched region "${region}" together with ${filters.join(' and ')}.`
          : `matched region "${region}".`) +
        (regions.length ? ` Regions seen: ${regions.join(', ')}.` : ''),
    };
  }

  if (matched.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      candidates: matched.map((r) => r.name).sort(),
      notes: filters,
      reason:
        `${matched.length} landing zones match region "${region}" and this bootstrap wires exactly one. ` +
        'Nothing was chosen.',
    };
  }

  const chosen = matched[0];

  const workspaces = readGraph(run, WORKSPACES_QUERY);
  if (!workspaces.ok) {
    // The RG is known, but the workspaces are not. Reporting the RG while
    // silently falling back to a convention workspace name would assert
    // something unestablished, so this fails with the rest.
    return { ...base, status: 'unreadable', reason: workspaces.reason };
  }
  const inChosen = (t) =>
    workspaces.rows.filter(
      (r) =>
        eqi(r.type, t) && eqi(r.resourceGroup, chosen.name) && eqi(r.subscriptionId, chosen.subscriptionId),
    );

  const notes = [];
  const syn = pickWorkspace(inChosen('microsoft.synapse/workspaces'), {
    prefix: 'syn',
    domain: chosen.domain,
    region,
  });
  const dbx = pickWorkspace(inChosen('microsoft.databricks/workspaces'), {
    prefix: 'adb',
    domain: chosen.domain,
    region,
  });

  // A missing workspace is a real, supported estate (loomSynapseEnabled=false /
  // loomDatabricksEnabled=false), so it is a NOTE, not a failure — but the
  // convention name is emitted only with that fact stated, never silently.
  const conventional = (prefix) => `${prefix}-loom-${chosen.domain || 'default'}-${region}`;
  let synapseWorkspace = syn.name;
  if (!syn.name) {
    synapseWorkspace = conventional('syn');
    notes.push(
      syn.how === 'ambiguous'
        ? `${inChosen('microsoft.synapse/workspaces').length} Synapse workspaces in ${chosen.name} and none matches the Loom naming convention (${syn.candidates.join(', ')}); falling back to the convention name "${synapseWorkspace}", which may not exist.`
        : `no Synapse workspace exists in ${chosen.name}; the convention name "${synapseWorkspace}" is emitted so the Synapse steps report a real miss rather than acting on a different DLZ.`,
    );
  }
  let databricksWorkspace = dbx.name;
  if (!dbx.name) {
    databricksWorkspace = conventional('adb');
    notes.push(
      dbx.how === 'ambiguous'
        ? `${inChosen('microsoft.databricks/workspaces').length} Databricks workspaces in ${chosen.name} and none matches the Loom naming convention (${dbx.candidates.join(', ')}); falling back to "${databricksWorkspace}".`
        : `no Databricks workspace exists in ${chosen.name}; the SCIM / Unity Catalog steps will skip (they already no-op on an unresolvable workspace).`,
    );
  }

  return {
    ...base,
    status: 'resolved',
    dlzSubscription: chosen.subscriptionId,
    dlzResourceGroup: chosen.name,
    dlzDomain: chosen.domain,
    crossSubscription: !eqi(chosen.subscriptionId, adminSubscription),
    synapseWorkspace,
    databricksWorkspace,
    synapseHow: syn.how,
    databricksHow: dbx.how,
    notes,
    candidates: [chosen.name],
  };
}

/** KEY=VALUE lines for `$GITHUB_ENV`. Only reached on status==='resolved'. */
export function githubEnvLines(result) {
  return [
    `DLZ_SUB=${result.dlzSubscription}`,
    `DLZ_RG=${result.dlzResourceGroup}`,
    `DLZ_DOMAIN=${result.dlzDomain}`,
    `SYNAPSE_WS=${result.synapseWorkspace}`,
    `DBX_WS=${result.databricksWorkspace}`,
  ];
}

/** Human rendering. NEVER contains a subscription id — role words only. */
export function render(result) {
  if (result.status === 'unreadable') {
    return (
      'DLZ discovery: COULD NOT READ the estate, so NOTHING is asserted about whether a Data Landing Zone ' +
      `exists — this is not a finding of "no DLZ". ${result.reason} Fix the read and re-run: the deploy ` +
      'identity needs Reader over the subscription that holds the landing zone (the bootstrap logs in to ' +
      'the ADMIN subscription, and a cross-subscription DLZ is invisible without it), and the ' +
      '`resource-graph` Azure CLI extension must be installed. This step is not being skipped.'
    );
  }
  if (result.status === 'not-found') {
    return [
      `DLZ discovery: no landing zone found for region "${result.region}". ${result.reason}`,
      '',
      'What to check, in order:',
      `  1. Was a landing zone ever deployed in ${result.region}? A hub-only (topology=tenant) deploy stamps`,
      '     no DLZ until `dlz-attach` runs — there is genuinely nothing to bootstrap yet.',
      '  2. Does the deploy identity hold Reader on the DLZ subscription? Resource Graph returns only',
      '     subscriptions it can read, so a cross-sub DLZ silently drops out of the result set.',
      '  3. If the group exists under a non-standard name, pass it explicitly:',
      '     `dlz_domain` (the <domain> in rg-csa-loom-dlz-<domain>-<region>) and `dlz_subscription`.',
      result.candidates.length
        ? `  Groups seen (any region): ${result.candidates.join(', ')}`
        : `  No ${DLZ_RG_PREFIX}* group exists in any readable subscription.`,
    ].join('\n');
  }
  if (result.status === 'ambiguous') {
    return [
      `DLZ discovery: AMBIGUOUS — ${result.reason}`,
      `  Candidates: ${result.candidates.join(', ')}`,
      '',
      'Nothing was assumed. Re-run naming the one to bootstrap via the `dlz_domain` input (the <domain>',
      'segment of rg-csa-loom-dlz-<domain>-<region>), and `dlz_subscription` if two domains collide across',
      'subscriptions. Each landing zone is bootstrapped by its own run.',
    ].join('\n');
  }
  const where = result.crossSubscription
    ? 'in a subscription DIFFERENT from the admin plane (cross-subscription estate)'
    : 'in the same subscription as the admin plane (single-subscription estate)';
  const how = (h) =>
    ({
      sole: 'the only one in the group',
      convention: 'matched the Loom naming convention',
      'convention-default': 'matched the Loom naming convention for a `default`-named workspace set',
      prefix: 'the only *-loom-* workspace in the group',
    })[h] ?? 'not discovered';
  return [
    `DLZ discovery: resolved "${result.dlzResourceGroup}" (domain "${result.dlzDomain}") ${where}.`,
    `  Synapse:    ${result.synapseWorkspace} (${how(result.synapseHow)})`,
    `  Databricks: ${result.databricksWorkspace} (${how(result.databricksHow)})`,
    ...result.notes.map((n) => `  Note: ${n}`),
  ].join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    region: null,
    adminSubscription: null,
    dlzSubscription: null,
    dlzDomain: null,
    githubEnv: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--region') out.region = argv[++i];
    else if (a === '--admin-subscription') out.adminSubscription = argv[++i];
    else if (a === '--dlz-subscription') out.dlzSubscription = argv[++i];
    else if (a === '--dlz-domain') out.dlzDomain = argv[++i];
    else if (a === '--github-env') out.githubEnv = argv[++i];
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export function exitCodeFor(status) {
  return status === 'resolved'
    ? EXIT.RESOLVED
    : status === 'not-found'
      ? EXIT.NOT_FOUND
      : status === 'ambiguous'
        ? EXIT.AMBIGUOUS
        : EXIT.UNREADABLE;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`resolve-dlz-coordinates: ${e.message}\n`);
    process.exit(EXIT.USAGE);
  }
  if (!args.region) {
    process.stderr.write('resolve-dlz-coordinates: --region is required.\n');
    process.exit(EXIT.USAGE);
  }
  const result = resolveDlzCoordinates(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(result)}\n`);
  }
  // DLZ_STATUS IS WRITTEN ON EVERY MEASURED PATH, not just `resolved` (#3703
  // review). Callers classify our exit code, and `not-found` is EXIT 1 — but
  // node also exits 1 on an uncaught throw or a module-load failure (rename this
  // file and the caller gets 1). Without a positive marker, a crash that
  // measured NOTHING is indistinguishable from a genuine "Resource Graph was
  // read and no landing zone matched", and the caller renders the crash as that
  // measurement. deploy-integrity.md R7: if we did not establish it, we do not
  // say it. A consumer that requires DLZ_STATUS in this file cannot be fooled by
  // an exit code alone.
  if (args.githubEnv) {
    const lines = result.status === 'resolved' ? githubEnvLines(result) : [];
    fs.appendFileSync(args.githubEnv, `${[...lines, `DLZ_STATUS=${result.status}`].join('\n')}\n`, 'utf8');
  }
  process.exit(exitCodeFor(result.status));
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  // An uncaught throw would exit 1 — the code that means "not-found", a genuine
  // negative a caller is entitled to continue on. Classify it as UNREADABLE (3)
  // instead: we did not read the estate, so we must not report a verdict about
  // it. `process.exit` inside main() is unaffected; it does not throw.
  try {
    main();
  } catch (e) {
    process.stderr.write(
      `resolve-dlz-coordinates: UNCAUGHT ${e && e.stack ? e.stack : e}\n` +
      'Nothing was established about this estate. Exiting UNREADABLE (3) rather than 1, because 1 means ' +
      '"Resource Graph was read and nothing matched" and the caller is entitled to continue on that.\n',
    );
    process.exit(EXIT.UNREADABLE);
  }
}
