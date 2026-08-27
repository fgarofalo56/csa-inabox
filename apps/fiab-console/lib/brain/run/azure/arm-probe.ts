/**
 * LOOM BRAIN W10 — the REAL estate probe: ARG discovery, then a per-resource ARM
 * GET for power state (#3936).
 *
 * READ-ONLY, AND STRUCTURALLY SO. Two Azure verbs are reachable from this
 * module and both are reads:
 *
 *     POST {arm}/providers/Microsoft.ResourceGraph/resources   (a query)
 *     GET  {arm}{resourceId}?api-version=...                   (a read)
 *
 * There is no ARM verb here that can create, scale, start, stop or delete
 * anything. PRP §1 decision 1 is recommend-only, and the measured reason is
 * blast radius: of the 13 Container App environments visible across these
 * subscriptions, ONE is Loom's.
 *
 * ── WHY TWO READS AND NOT ONE ──────────────────────────────────────────────
 * Resource Graph is the right tool for DISCOVERY and the WRONG tool for STATE.
 * MEASURED 2026-08-22: the activity log recorded
 * `Microsoft.Synapse/workspaces/sqlPools/pause/action -> Succeeded @ 20:22:14`
 * while ARG kept reporting that same pool `Online` afterwards. ARG is a
 * REPLICATED INDEX; its recency is not a guarantee, and "what is indexed" is not
 * "what is serving". A scheduler that read state from ARG would call a genuinely
 * paused estate OK, run its detectors over it, and report liveness conclusions
 * about resources that are switched off.
 *
 * The type system carries that decision: `armPowerReading()` (the only
 * constructor of an `ArmPowerReading`) demands the ARM api-version used, and
 * nothing in a Resource Graph row can supply one.
 *
 * ── R7: EVERY FAILURE SAYS WHAT IT ESTABLISHED ─────────────────────────────
 * There is no `catch { return [] }` anywhere in this file, and no `2>/dev/null`
 * equivalent. A failure becomes a {@link ProbeFailure} carrying its stage, its
 * classification, the HTTP status (or `null` when NO exchange completed) and the
 * response body verbatim. An empty result set is returned only when Azure
 * actually returned zero rows — and even that is RED, because it cannot be told
 * apart from an identity that can see nothing.
 *
 * ── CLOUD INVARIANCE ───────────────────────────────────────────────────────
 * The ARM host and the token audience come from arguments, never from a literal,
 * so the same code runs in Commercial, GCC, GCC-High, IL5 and DoD
 * (`cloud-parity.md`). NOTE HONESTLY: that is an argument from construction, not
 * a receipt — see the PR body for which boundaries were actually executed.
 */

import { armPowerReading, type ArmPowerReading, type EstatePowerState } from '../../../estate/pause-state';
import { ScanIdentityError } from './scan-credential';
import type { EstateProbe } from '../ports';
import type { ProbeFailure, ProbeResult } from '../model';

/** ARG's server-side page ceiling. Requesting more does not raise it. */
const PAGE_SIZE = 1000;

/**
 * Hard stop on pagination. At 1000 rows/page this admits 50,000 resources — two
 * orders of magnitude above the measured estate — while making a `$skipToken`
 * loop that never terminates a BOUNDED failure rather than a hung run.
 * Exhausting it is reported as a failure, never treated as the end of the data.
 */
const MAX_PAGES = 50;

const RESOURCE_GRAPH_API = '2022-10-01';

/**
 * The ARM api-version used to read each type's power state, and where in the
 * response the state lives.
 *
 * A type absent from this table cannot yield a reading, so it is NOT discovered
 * either — see {@link SCOPED_TYPES}. Adding a type here without adding it to the
 * query (or the reverse) would make `discovered !== readings.length` and trip
 * `InconsistentProbeError`, which is the intended failure: the two lists are one
 * decision expressed twice, and they are asserted to agree in
 * `../__tests__/arm-probe.test.ts`.
 */
export const POWER_READERS: Readonly<
  Record<string, { readonly apiVersion: string; readonly read: (body: unknown) => EstatePowerState }>
> = {
  'microsoft.app/containerapps': {
    apiVersion: '2024-03-01',
    read: (body) => containerAppState(body),
  },
};

/** The ARM types this probe ranges over. Keys of {@link POWER_READERS}. */
export const SCOPED_TYPES: readonly string[] = Object.keys(POWER_READERS);

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * A Container App's power state, from its ARM body.
 *
 * `properties.runningStatus` is the live signal: `Running`, `Stopped`,
 * `Progressing`, … Everything this function cannot map lands on `Unknown`, which
 * is a FIRST-CLASS state, not a fallback for convenience — `Unknown !== Online`
 * and `Unknown !== Paused`, and the classifier fails closed on it rather than
 * calling the estate paused.
 */
export function containerAppState(body: unknown): EstatePowerState {
  const props = obj(obj(body)?.properties);
  const running = props?.runningStatus;
  if (typeof running === 'string') {
    const s = running.toLowerCase();
    if (s === 'running') return 'Online';
    if (s === 'stopped') return 'Stopped';
    if (s === 'progressing' || s === 'processing') return 'Scaling';
    if (s === 'suspended') return 'Paused';
  }
  return 'Unknown';
}

/** Minimal fetch shape. Injected so the probe is testable without a network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface ArmEstateProbeOptions {
  /** ARM host, e.g. `https://management.azure.com`. NEVER a literal in code. */
  readonly armBase: string;
  /** Token audience/scope for that host. */
  readonly armScope: string;
  /** Returns a bearer token, or null when one could not be acquired. */
  readonly getToken: (scope: string) => Promise<string | null>;
  readonly fetchImpl: FetchLike;
  /**
   * Restrict discovery to one estate by its `loom-estate-id` tag.
   *
   * MEASURED 2026-08-24 against the live Commercial estate: ZERO of the 63
   * container apps carry that tag. So a probe scoped by tag alone finds nothing
   * and the lane goes red every night — the "gate that always fails" twin of the
   * failure this design exists to avoid. Do NOT cure that by widening ownership
   * to a tag that IS present (`CSA_Loom`, `csa-loom`, `loom-band`, `loom-item`):
   * none of them is estate-scoped, so none can tell two Loom estates apart, and
   * a wrong ownership inference on this estate reaches non-Loom Container App
   * environments. Use {@link resourceGroups} instead — a resource group the
   * platform deploys into is EVIDENCE, not an inference.
   */
  readonly estateTag?: string;
  /**
   * Restrict discovery to named resource groups.
   *
   * THE SCOPE THAT ACTUALLY WORKS TODAY. The admin-plane RG is deterministic and
   * created by the platform deploy, so "these resources are Loom's" is
   * established rather than guessed.
   *
   * Note the deliberate asymmetry with the GRAPH: the graph ranges over every
   * readable subscription (PRP §1 decision 4 — reports cover ALL subscriptions),
   * while the POWER probe is narrow. That is not an inconsistency. If the probe
   * ranged as widely as the graph, "the estate is paused" would depend on 34
   * non-Loom container apps — of the 13 managed environments visible here, ONE
   * is Loom's — and the operator's blog being up would keep the Loom scan
   * running against a switched-off estate.
   */
  readonly resourceGroups?: readonly string[];
  /** Subscriptions to scope the query to. Omitted = every readable subscription. */
  readonly subscriptions?: readonly string[];
}

interface ArgRow {
  readonly id?: unknown;
  readonly type?: unknown;
}

/**
 * Classify a thrown fetch error.
 *
 * A thrown error means NO HTTP exchange completed, so the status is `null` — the
 * difference between "Azure said no" and "Azure was never asked". Both would
 * read as a falsy status if this collapsed them to 0.
 */
function networkFailure(stage: ProbeFailure['stage'], target: string, err: unknown): ProbeFailure {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    stage,
    target,
    classification: 'network',
    httpStatus: null,
    detail: `${detail} (no HTTP exchange completed)`,
  };
}

function httpFailure(
  stage: ProbeFailure['stage'],
  target: string,
  status: number,
  body: string,
): ProbeFailure {
  return {
    stage,
    target,
    classification: status === 401 || status === 403 ? 'auth' : 'arm-error',
    httpStatus: status,
    detail: body.slice(0, 600),
  };
}

/**
 * A value that could not be safely placed in a Kusto query literal.
 *
 * THROWN, never escaped-and-continued. See {@link assertKustoLiteralSafe}.
 */
export class UnsafeQueryScopeError extends Error {
  constructor(kind: string, value: string, why: string) {
    super(
      `refusing to build the discovery query: the ${kind} ${JSON.stringify(value)} ${why}. ` +
        'This value is REJECTED rather than escaped. The Azure Resource Graph REST API has no ' +
        'parameter binding — `QueryRequest` carries only a query string — so a literal is the ' +
        'only construction available, and hand-rolled quote-doubling next to the query is the ' +
        'exact pattern `scripts/ci/check-sql-quoting.mjs` exists to prevent. Every value this ' +
        'query interpolates has a documented, RESTRICTIVE character set, so validating is both ' +
        'available and strictly stronger than escaping: an input that cannot contain a quote ' +
        'cannot break out of one.',
    );
    this.name = 'UnsafeQueryScopeError';
  }
}

/**
 * ARM resource-group names: letters, digits, `_`, `-`, `.`, `(`, `)`, and
 * Unicode word characters; 1–90 chars; may not end in `.`.
 *
 * Deliberately NARROWER than the ARM rule (ASCII only): this lane's scope comes
 * from a workflow env var naming Loom's own admin-plane groups, and a Unicode
 * homoglyph in that position would be a finding in itself.
 */
const RESOURCE_GROUP_NAME = /^[A-Za-z0-9_()\-.]{1,90}$/;

/**
 * The `loom-estate-id` tag VALUE.
 *
 * Azure tag values permit almost anything, so unlike a resource-group name this
 * one is not constrained by the platform — it is constrained HERE, to the shape
 * the deploy actually stamps. A tag value outside it is refused rather than
 * escaped, which keeps every interpolated value provably quote-free.
 */
const ESTATE_TAG_VALUE = /^[A-Za-z0-9_:\-.]{1,128}$/;

/**
 * Prove a value cannot terminate a Kusto string literal.
 *
 * Rejects on the pattern AND, independently, on the presence of a quote or a
 * backslash — belt and braces, so a future widening of the pattern cannot
 * silently re-admit the character that matters. The second check is not
 * redundant defence-in-depth theatre; it is the assertion that survives an edit
 * to the first.
 */
export function assertKustoLiteralSafe(kind: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new UnsafeQueryScopeError(kind, value, `does not match ${String(pattern)}`);
  }
  if (/['"\\\r\n]/.test(value)) {
    throw new UnsafeQueryScopeError(
      kind,
      value,
      'contains a quote, a backslash or a newline even though it matched the allowed pattern — ' +
        'the pattern has been widened and no longer guarantees what this check assumes',
    );
  }
  return value;
}

/** Build the discovery query. Exported so a finding can cite what it ranged over. */
export function discoveryQuery(opts?: {
  readonly estateTag?: string;
  readonly resourceGroups?: readonly string[];
}): string {
  const typeClause = SCOPED_TYPES.map((t) => `type =~ '${t}'`).join(' or ');
  const lines = ['Resources', `| where ${typeClause}`];
  if (opts?.estateTag !== undefined && opts.estateTag !== '') {
    // Tag comparison is case-sensitive on the VALUE in ARG, and the deploy
    // stamps it verbatim, so it is compared verbatim rather than normalized —
    // a normalizing comparison here would silently widen ownership.
    const tag = assertKustoLiteralSafe('estate tag', opts.estateTag, ESTATE_TAG_VALUE);
    lines.push(`| where tags['loom-estate-id'] == '${tag}'`);
  }
  if (opts?.resourceGroups !== undefined && opts.resourceGroups.length > 0) {
    // `in~` is the case-INSENSITIVE membership operator. ARM resource-group
    // names are case-insensitive and Azure returns them in inconsistent casing,
    // so a case-sensitive comparison here would silently drop resources and
    // shrink the examined population.
    const list = opts.resourceGroups
      .map((g) => `'${assertKustoLiteralSafe('resource group', g, RESOURCE_GROUP_NAME)}'`)
      .join(', ');
    lines.push(`| where resourceGroup in~ (${list})`);
  }
  lines.push('| project id, type', '| order by id asc');
  return lines.join('\n');
}

/**
 * The production probe.
 *
 * Never throws for a reachability problem — a failure is DATA so the classifier
 * can name it and the operator gets a reason rather than a stack trace
 * (`deploy-integrity.md` R6). A genuine defect (a malformed reader table, say)
 * may still throw, and should.
 */
export class ArmEstateProbe implements EstateProbe {
  constructor(private readonly opts: ArmEstateProbeOptions) {}

  async probe(): Promise<ProbeResult> {
    const base = this.opts.armBase.replace(/\/+$/, '');
    const scopeParts = [SCOPED_TYPES.join(', ')];
    scopeParts.push(
      this.opts.estateTag ? `tagged loom-estate-id='${this.opts.estateTag}'` : 'ALL tags',
    );
    scopeParts.push(
      this.opts.resourceGroups?.length
        ? `in resource group(s) ${this.opts.resourceGroups.join(', ')}`
        : 'in ALL resource groups',
    );
    scopeParts.push(
      this.opts.subscriptions?.length
        ? `across ${this.opts.subscriptions.length} named subscription(s)`
        : 'across every readable subscription',
    );
    const scopeText = scopeParts.join(', ');

    let token: string | null;
    try {
      token = await this.opts.getToken(this.opts.armScope);
    } catch (err) {
      // ── AN IDENTITY REFUSAL IS NOT A REACHABILITY FAILURE (R7) ───────────
      // MEASURED by running the compiled CLI: a `ScanIdentityError` fell into
      // the arm below and was classified `network`, so the verdict read
      // "could not reach Azure … network-failed" for a run that had reached
      // Azure perfectly well, minted a token, and REFUSED IT because it belonged
      // to the wrong principal. That is exactly the conflation this module's
      // header forbids — and it would send an engineer to check DNS and
      // firewalls for what is an env-var placement in a workflow file.
      //
      // `ports.ts` draws the line: a probe MUST NOT throw for a REACHABILITY
      // failure, and "an unexpected defect may still throw, and should". A run
      // authenticating as a principal it did not declare is a defect in the run,
      // not a fact about the estate, so it propagates and lands on the CLI's
      // exit 1 — "a defect in the scan, not a verdict about the estate".
      if (err instanceof ScanIdentityError) throw err;
      return {
        readings: [],
        failures: [networkFailure('discovery', 'token acquisition', err)],
        discovered: 0,
        scope: scopeText,
      };
    }
    if (token === null || token === '') {
      return {
        readings: [],
        failures: [
          {
            stage: 'discovery',
            target: 'token acquisition',
            classification: 'auth',
            httpStatus: null,
            // R7 — states exactly what happened. It does NOT claim there are no
            // resources, because nothing was asked.
            detail:
              `no ARM token was issued for scope '${this.opts.armScope}'; NO query was ` +
              'issued, so nothing is known about the estate.',
          },
        ],
        discovered: 0,
        scope: scopeText,
      };
    }

    const discovered = await this.discover(base, token);
    if (discovered.failures.length > 0) {
      return {
        readings: [],
        failures: discovered.failures,
        discovered: discovered.rows.length,
        scope: scopeText,
      };
    }

    const readings: ArmPowerReading[] = [];
    const failures: ProbeFailure[] = [];
    for (const row of discovered.rows) {
      const armId = typeof row.id === 'string' ? row.id : '';
      const armType = (typeof row.type === 'string' ? row.type : '').toLowerCase();
      const reader = POWER_READERS[armType];
      if (armId === '' || reader === undefined) {
        // Discovery and the reader table disagreed. Reported as a FAILURE rather
        // than skipped: a silently skipped resource shrinks the examined
        // population, which is this repo's dominant evasion class (PRP §3.8).
        failures.push({
          stage: 'power-read',
          target: armId || '<row with no id>',
          classification: 'arm-error',
          httpStatus: null,
          detail:
            `discovery returned type '${armType}' which has no entry in POWER_READERS. ` +
            'The discovery query and the reader table are one decision expressed twice ' +
            'and they have drifted; no power state could be established for this resource.',
        });
        continue;
      }

      const url = `${base}${armId}?api-version=${reader.apiVersion}`;
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.opts.fetchImpl(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        });
      } catch (err) {
        failures.push(networkFailure('power-read', armId, err));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        failures.push(httpFailure('power-read', armId, res.status, body));
        continue;
      }
      const json = await res.json();
      readings.push(
        armPowerReading({
          resourceId: armId,
          powerState: reader.read(json),
          armApiVersion: reader.apiVersion,
        }),
      );
    }

    return { readings, failures, discovered: discovered.rows.length, scope: scopeText };
  }

  private async discover(
    base: string,
    token: string,
  ): Promise<{ rows: readonly ArgRow[]; failures: readonly ProbeFailure[] }> {
    const rows: ArgRow[] = [];
    let skipToken: string | undefined;
    let pages = 0;
    let totalRecords: number | null = null;

    for (;;) {
      if (pages >= MAX_PAGES) {
        return {
          rows,
          failures: [
            {
              stage: 'discovery',
              target: 'Microsoft.ResourceGraph/resources',
              classification: 'arm-error',
              httpStatus: null,
              detail:
                `pagination hit the ${MAX_PAGES}-page cap with a $skipToken still ` +
                `outstanding after ${rows.length} row(s). The estate is INCOMPLETE and no ` +
                'verdict may be drawn from it.',
            },
          ],
        };
      }

      const body: Record<string, unknown> = {
        query: discoveryQuery({
          ...(this.opts.estateTag !== undefined ? { estateTag: this.opts.estateTag } : {}),
          ...(this.opts.resourceGroups !== undefined
            ? { resourceGroups: this.opts.resourceGroups }
            : {}),
        }),
        options: {
          resultFormat: 'objectArray',
          $top: PAGE_SIZE,
          ...(skipToken ? { $skipToken: skipToken } : {}),
        },
        ...(this.opts.subscriptions?.length ? { subscriptions: this.opts.subscriptions } : {}),
      };

      const url = `${base}/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API}`;
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.opts.fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return { rows, failures: [networkFailure('discovery', 'Microsoft.ResourceGraph/resources', err)] };
      }
      if (!res.ok) {
        const text = await res.text();
        return {
          rows,
          failures: [
            httpFailure(
              'discovery',
              `Microsoft.ResourceGraph/resources (page ${pages + 1})`,
              res.status,
              text,
            ),
          ],
        };
      }

      const json = (await res.json()) as {
        data?: unknown;
        totalRecords?: unknown;
        $skipToken?: unknown;
      };
      const page = Array.isArray(json.data)
        ? json.data.filter((r): r is ArgRow => typeof r === 'object' && r !== null)
        : [];
      rows.push(...page);
      pages += 1;
      if (totalRecords === null && typeof json.totalRecords === 'number') {
        totalRecords = json.totalRecords;
      }

      const next = typeof json.$skipToken === 'string' ? json.$skipToken : '';
      if (!next || page.length === 0) break;
      skipToken = next;
    }

    // ARG's own count is the cross-check. A collector that ignores the token
    // gets a plausible-looking partial estate and then reports reachability over
    // it — every node in the unread remainder found with zero inbound edges, a
    // page-boundary artifact rendered as a fleet of unreachable services.
    if (totalRecords !== null && totalRecords !== rows.length) {
      return {
        rows,
        failures: [
          {
            stage: 'discovery',
            target: 'Microsoft.ResourceGraph/resources',
            classification: 'arm-error',
            httpStatus: null,
            detail:
              `Resource Graph reported totalRecords=${totalRecords} but ${rows.length} row(s) ` +
              'were read across ' +
              `${pages} page(s). The estate is INCOMPLETE; refusing to form a verdict over a ` +
              'partial population.',
          },
        ],
      };
    }

    return { rows, failures: [] };
  }
}
