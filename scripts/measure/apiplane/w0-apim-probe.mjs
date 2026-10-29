#!/usr/bin/env node
/**
 * w0-apim-probe.mjs - the MEASUREMENT INSTRUMENT for the W0 spike of the Loom
 * API & AI Gateway Plane (PRPs/active/loom-api-gateway-plane/
 * apigw-W00-measurement-spike.md, items W0-1, W0-2, W0-3, W0-4, W0-6, W0-7).
 * No product code. It is run by .github/workflows/apiplane-w0-gov-probe.yml
 * (Azure Government / GCC-High, GitHub-hosted runner) and
 * .github/workflows/apiplane-w0-commercial-probe.yml (Commercial, in-VNet pool
 * runner), never from a workstation (cloud-parity.md: Gov facts come from an
 * Actions run). The same code runs in both clouds; only the endpoints differ.
 *
 *   node scripts/measure/apiplane/w0-apim-probe.mjs \
 *        --cloud commercial|gov --family telemetry|policies|mcp|identity|latency|foundry \
 *        [--apim-name <name>] [--out <dir>] [--runner in-vnet|hosted] [--latency-poll-seconds <n>]
 *   node scripts/measure/apiplane/w0-apim-probe.mjs --aggregate <dir> --expect <family,...> --cloud <c> [--summary-file <path>]
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ A RESULT
 * ---------------------------------------------------------------------------
 * One JSON (`<cloud>-<family>.json`) and one markdown file per family, both run
 * through scripts/ci/_azure-redact.mjs. Every cell has exactly one verdict from a
 * CLOSED set:
 *   measured                      a value, with the HTTP status quoted
 *   not-measured:<reason>         STRUCTURAL: no-gateway-in-boundary,
 *                                 gateway-unreachable-from-runner,
 *                                 api-version-unsupported-in-boundary,
 *                                 boundary-not-exercised, no-in-boundary-runner
 *   unknown:<reason>              permission:<role>@<scope-kind>, transient-exhausted,
 *                                 tooling-error, plus two additions the brief implied
 *                                 without naming: workspace-not-discovered, not-located
 * A 401/403 is unknown:permission naming the role needed - NEVER "no". A 2xx whose
 * GET-back lacks the element is `measured: rejected (silently dropped)`.
 *
 * EXIT CODES (per family)
 *   0  every control passed (or could not run, recorded as an unknown cell) and
 *      every REQUIRED cell is measured or not-measured
 *   2  a CONTROL FAILED, or the script crashed, or the gateway was ambiguous / the
 *      cloud did not match: the instrument is INVALID and no cell of that family is
 *      publishable
 *   3  a REQUIRED cell is unknown, or scratch objects were left behind
 * Required: everything in telemetry, policies and mcp (and every cleanup cell).
 * identity, latency and foundry may be unknown / not-measured with exit 0: the PRP
 * says an unreadable Graph is unknown, and the Gov gateway is VNet-internal
 * (platform/fiab/bicep/modules/admin-plane/apim.bicep sets virtualNetworkType
 * 'Internal'), so a GitHub-hosted runner cannot reach its data plane.
 *
 * ---------------------------------------------------------------------------
 * RULES THIS INSTRUMENT FOLLOWS (assertion-design.md applied to a measurement tool)
 * ---------------------------------------------------------------------------
 * - DISCOVER, DO NOT ASSUME. It lists the APIM instances in the logged-in
 *   subscription. One: use it. Zero and no --apim-name: every family is
 *   not-measured:no-gateway-in-boundary and says how many it saw. More than one and
 *   no --apim-name: fail closed (exit 2) listing the NAMES. A NAMED gateway
 *   (--apim-name) that is not found exactly once - including an empty subscription -
 *   fails closed too (exit 2, discovery state named-not-found): the operator said
 *   it exists, so its absence is a failure, not "no gateway in the boundary". It prints names,
 *   resource group, SKU and state only - never a subscription id, tenant id,
 *   resource id, key, token or IP address (this repo is PUBLIC and Actions logs and
 *   artifacts are world-readable).
 * - A MEASUREMENT THAT CANNOT FAIL IS NOT A MEASUREMENT. Every family carries a
 *   positive control (and policies a negative one); see each _w0-<family>.mjs. A
 *   failed control makes the family INVALID.
 * - SCRATCH OBJECTS are all named `w0-apiplane-*`, are swept before and after a
 *   family (the second sweep in `finally`), EVERY delete goes through
 *   deleteScratch() and EVERY PUT through a helper that starts with
 *   assertScratchName(); both throw on any other name before a request is built.
 *   The family ends by LISTING leftovers (`cleanup` cell).
 * - WRITES ARE GATED ON SERVICE STATE. The write families (policies, mcp, latency)
 *   do not start while the selected APIM is not in provisioningState Succeeded:
 *   every cell is unknown:transient-exhausted with the state as evidence (exit 3)
 *   and nothing is written, not even the sweep. A 409 / 412 on a write is never
 *   `rejected` either: only a validation answer (400 / 422) is a verdict on a body.
 * - NEVER discard stderr or a result: no `2>/dev/null`, no `|| true`, no
 *   continue-on-error on a measurement step (deploy-integrity.md R6/R7).
 * - The bearer token comes from `az account get-access-token` via execFile (no
 *   shell), is never printed, written, or placed in an error, and is only ever sent
 *   to the origin it was minted for.
 *
 * ---------------------------------------------------------------------------
 * GROUNDING - Microsoft Learn, public pages fetched with curl on 2026-10-29
 * ---------------------------------------------------------------------------
 * Every request body, policy attribute set and api-version is from the page named
 * in the header of the module that uses it:
 *   _w0-core.mjs       named-value / policy-fragment / API REST, endpoints per cloud
 *   _w0-telemetry.mjs  diagnostic settings, Log Analytics tables, query API
 *   _w0-policies.mjs   the seven policy reference pages
 *   _w0-mcp.mjs        API create (type mcp), list filter, MCP server pages
 *   _w0-identity.mjs   Microsoft Graph servicePrincipal / application / appRoleAssignment
 *   _w0-latency.mjs    named values, return-response, set-body
 *   _w0-foundry.mjs    CognitiveServices models / accounts, Claude on Foundry
 * NOT GROUNDED IN A LEARN REST PAGE (listed here so nobody reads it as grounded):
 *   - the Microsoft.Insights diagnosticSettingsCategories LIST: every Learn REST URL
 *     tried returned 404; it is grounded in the CLI page for
 *     `az monitor diagnostic-settings categories list` only.
 *   - the exact error text APIM returns for an unknown policy element or attribute:
 *     Learn does not publish it, so the attribute-vs-element classifier is a regex
 *     over the message and the VERBATIM message is always kept next to the verdict.
 *   - what `mcpProperties` looks like after APIM creates a passthrough MCP API
 *     (the PRP says so itself): it is recorded as observed.
 * ALL FIXTURES IN THE TESTS ARE LABELLED "SYNTHETIC (from Learn example), not
 * observed". The first live Commercial run is the real validation, and this tool's
 * output (verbatim request bodies, statuses, error codes and messages) is meant to
 * make a wrong request body diagnosable from the run artifact.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookupCb } from 'node:dns';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  API, CLOUDS, FAMILIES, WRITE_FAMILIES, computeExit, createClient, deepSanitize, listAll, notMeasured, quote,
  reasonForFailure, registerSecret, sanitize, sanitizeBlock, unknown, verdictText, writeGate,
} from './_w0-core.mjs';
import * as telemetry from './_w0-telemetry.mjs';
import * as policies from './_w0-policies.mjs';
import * as mcp from './_w0-mcp.mjs';
import * as identity from './_w0-identity.mjs';
import * as latency from './_w0-latency.mjs';
import * as foundry from './_w0-foundry.mjs';

export const SCHEMA = 'apiplane-w0-probe/1';
const MODULES = { telemetry, policies, mcp, identity, latency, foundry };
const execFileP = promisify(execFile);

export class UsageError extends Error {}

/**
 * Which Actions run produced a result, from the runner's own variables, so every artifact and
 * the receipt quote their run id (the PRP's receipts name the run). Only these five variables
 * are read; nothing else from the environment is ever copied into an output.
 */
export function runContext(env) {
  const pick = (k) => (typeof env?.[k] === 'string' && env[k] !== '' ? env[k] : null);
  const sha = pick('GITHUB_SHA');
  return {
    runId: pick('GITHUB_RUN_ID'), attempt: pick('GITHUB_RUN_ATTEMPT'), workflow: pick('GITHUB_WORKFLOW'),
    ref: pick('GITHUB_REF_NAME'), sha: sha ? sha.slice(0, 12) : null,
  };
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

const APIM_NAME_RE = /^[a-zA-Z](?:[a-zA-Z0-9-]{0,48}[a-zA-Z0-9])?$/;

/**
 * A path flag may be absolute or relative, but never climbs out with a ".." segment (either slash
 * style) and never carries a NUL byte. The values come from the operator or the workflow, not from
 * a dispatch input; this closes the traversal class at the one place they enter (Snyk javascript/PT).
 */
function sanitizePathArg(flag, value) {
  if (value.includes('\0') || value.split(/[\\/]+/).includes('..')) {
    throw new UsageError(`${flag} must not contain '..' segments or NUL bytes`);
  }
  return value;
}

export function parseArgs(argv) {
  const o = { cloud: null, family: null, apimName: null, out: join('temp', 'apiplane-w0'), runner: 'hosted', latencyPollSeconds: 900, aggregate: null, expect: null, summaryFile: null };
  const known = new Set(['--cloud', '--family', '--apim-name', '--out', '--runner', '--latency-poll-seconds', '--aggregate', '--expect', '--summary-file']);
  for (let i = 0; i < argv.length; i += 1) {
    let key = argv[i];
    let value;
    const eq = key.indexOf('=');
    if (eq > 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (!known.has(key)) throw new UsageError(`unknown argument '${sanitize(argv[i], 60)}'`);
    if (value === undefined) { i += 1; value = argv[i]; }
    if (value === undefined || value === '') throw new UsageError(`${key} needs a value`);
    switch (key) {
      case '--cloud': o.cloud = value; break;
      case '--family': o.family = value; break;
      case '--apim-name': o.apimName = value; break;
      case '--out': o.out = sanitizePathArg('--out', value); break;
      case '--runner': o.runner = value; break;
      case '--latency-poll-seconds': o.latencyPollSeconds = Number(value); break;
      case '--aggregate': o.aggregate = sanitizePathArg('--aggregate', value); break;
      case '--expect': o.expect = value; break;
      default: o.summaryFile = sanitizePathArg('--summary-file', value);
    }
  }
  if (!Object.hasOwn(CLOUDS, String(o.cloud))) throw new UsageError(`--cloud must be one of ${Object.keys(CLOUDS).join('|')}`);
  if (!['in-vnet', 'hosted'].includes(o.runner)) throw new UsageError('--runner must be in-vnet|hosted');
  if (o.aggregate) {
    if (!o.expect) throw new UsageError('--aggregate needs --expect <family,...>');
    const wanted = o.expect.split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length === 0 || wanted.some((f) => !FAMILIES.includes(f))) throw new UsageError(`--expect must list families from ${FAMILIES.join(',')}`);
    o.expect = wanted;
    return o;
  }
  if (!FAMILIES.includes(String(o.family))) throw new UsageError(`--family must be one of ${FAMILIES.join('|')}`);
  if (o.apimName !== null && !APIM_NAME_RE.test(o.apimName)) throw new UsageError('--apim-name is not a valid APIM service name');
  // The cap is spent TWICE by the latency family (value A, then value B), so its worst case is 2 x cap. 1800 keeps 2 x cap + the
  // rest of the job under the workflows' timeout-minutes 90 (a test derives that from the files): a timeout kill SKIPS the
  // `finally` sweep and would leave the scratch API and named value live on the gateway. Both prechecks carry the same bound.
  if (!Number.isInteger(o.latencyPollSeconds) || o.latencyPollSeconds < 30 || o.latencyPollSeconds > 1800) {
    throw new UsageError('--latency-poll-seconds must be an integer from 30 to 1800');
  }
  return o;
}

// ---------------------------------------------------------------------------
// real dependencies (everything the tests replace)
// ---------------------------------------------------------------------------

/**
 * `az` is launched with execFile and NO shell, so no argument is re-parsed and the
 * token never passes through a command line. This targets the Linux Actions
 * runners; on a Windows workstation `az` is a .cmd shim that execFile cannot start
 * without a shell, and Gov must not be measured from a workstation anyway.
 */
export function realDeps() {
  const az = async (args) => {
    try {
      const { stdout } = await execFileP('az', args, { maxBuffer: 4 * 1024 * 1024, timeout: 90_000 });
      return stdout;
    } catch (err) {
      throw new Error(`az ${args[0]} ${args[1] ?? ''} failed: ${sanitize(err?.stderr || err?.message || 'no output', 300)}`);
    }
  };
  return {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    azAccount: async () => {
      const out = await az(['account', 'show', '--query', '{environmentName:environmentName, subscriptionId:id}', '-o', 'json']);
      const j = JSON.parse(out);
      return { environmentName: j.environmentName, subscriptionId: j.subscriptionId };
    },
    getToken: async (audience) => {
      const out = await az(['account', 'get-access-token', '--resource', audience, '--query', 'accessToken', '-o', 'tsv']);
      const token = out.trim();
      if (!token) throw new Error(`az returned an empty token for audience ${audience}`);
      registerSecret(token);
      return token;
    },
    dnsLookup: (host) => new Promise((res, rej) => dnsLookupCb(host, { all: true }, (e, addrs) => (e ? rej(e) : res(addrs.map((a) => a.address))))),
    idGen: () => randomBytes(4).toString('hex'),
    env: process.env,
    fs: { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync },
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

// ---------------------------------------------------------------------------
// APIM discovery (R3)
// ---------------------------------------------------------------------------

function toApim(item) {
  const m = /^\/subscriptions\/[^/]+\/resourcegroups\/([^/]+)\//i.exec(String(item?.id || ''));
  const p = item?.properties || {};
  return {
    name: item?.name,
    resourceGroup: m ? m[1] : null,
    resourceId: item?.id,
    sku: item?.sku?.name,
    capacity: item?.sku?.capacity,
    provisioningState: p.provisioningState,
    location: item?.location,
    virtualNetworkType: p.virtualNetworkType,
    publicNetworkAccess: p.publicNetworkAccess,
    gatewayUrl: p.gatewayUrl,
  };
}

/** The ONLY view of an APIM that may be printed: names, resource group, SKU, state. */
export function publicApim(a) {
  if (!a) return null;
  const host = (() => { try { return new URL(a.gatewayUrl).hostname; } catch { return ''; } })();
  return {
    name: a.name, resourceGroup: a.resourceGroup, sku: a.sku, capacity: a.capacity ?? null,
    provisioningState: a.provisioningState ?? null, location: a.location ?? null,
    virtualNetworkType: a.virtualNetworkType ?? null, publicNetworkAccess: a.publicNetworkAccess ?? null,
    gatewayHostKind: /\.azure-api\.(net|us)$/i.test(host) ? 'default-azure-api-host' : 'custom-host',
  };
}

export async function discoverApim(ctx, apimName) {
  const url = `${ctx.cloud.arm}/subscriptions/${encodeURIComponent(ctx.subscriptionId)}/providers/Microsoft.ApiManagement/service?api-version=${API.apim}`;
  const r = await listAll(ctx, url);
  if (!r.ok) return { state: 'error', res: r.last };
  const all = r.items.map(toApim).filter((a) => typeof a.name === 'string' && a.resourceId);
  const names = all.map((a) => a.name).sort();
  if (apimName) {
    const hit = all.filter((a) => a.name.toLowerCase() === apimName.toLowerCase());
    if (hit.length === 1) return { state: 'one', apim: { ...hit[0], httpStatus: r.last.status }, seen: all.length };
    // A NAMED gateway that is not found exactly once fails closed - including an EMPTY subscription. The operator
    // asserted that this gateway exists; "no gateway in the boundary" is the honest answer only to a question that
    // named none. `matched` is kept so the note can say how many matched (0, or 2+ if a listing repeated a name).
    return { state: 'named-not-found', seen: all.length, names, matched: hit.length };
  }
  if (all.length === 0) return { state: 'zero', seen: 0 };
  if (all.length === 1) return { state: 'one', apim: { ...all[0], httpStatus: r.last.status }, seen: 1 };
  return { state: 'many', seen: all.length, names };
}

// ---------------------------------------------------------------------------
// one family run
// ---------------------------------------------------------------------------

function placeholders(family, make) {
  return MODULES[family].CELL_IDS.map((cid) => make(cid));
}

/** Run one family and return the full result object (never throws). */
export async function runFamilyProbe(opts, deps) {
  const cloud = CLOUDS[opts.cloud];
  const requests = [];
  const acc = { cells: [], controls: [] };
  const result = {
    schema: SCHEMA, cloud: cloud.name, family: opts.family, runner: opts.runner, run: runContext(deps.env),
    startedAt: deps.nowIso(), finishedAt: null, status: 'COMPLETED',
    apim: null, discovery: null, controls: [], cells: [], requests, notes: [],
    valid: true, exitCode: 0,
  };
  let crashed = false;
  let hardStop = false;
  try {
    const account = await deps.azAccount();
    // Refuse before the first read when the logged-in cloud is not the one asked for.
    if (account.environmentName !== cloud.azEnvironment) {
      throw new Error(`cloud mismatch: --cloud ${cloud.name} needs az environment ${cloud.azEnvironment} but az reports '${sanitize(account.environmentName, 40)}'; refusing before any read`);
    }
    const ctx = {
      cloud, runner: opts.runner, subscriptionId: account.subscriptionId, apim: null,
      clock: { now: deps.now }, sleep: deps.sleep, idGen: deps.idGen, dnsLookup: deps.dnsLookup,
      options: { latencyPollSeconds: opts.latencyPollSeconds },
      client: createClient({ fetchImpl: deps.fetch, getToken: deps.getToken, sleep: deps.sleep, clock: { now: deps.now }, cloud, requestLog: requests }),
    };
    const disc = await discoverApim(ctx, opts.apimName);
    result.discovery = { state: disc.state, seen: disc.seen ?? null, names: disc.names ?? null };
    if (disc.state === 'one') {
      ctx.apim = disc.apim;
      result.apim = publicApim(disc.apim);
      // A WRITE family does not start against a service that is not in provisioningState Succeeded: every cell is
      // unknown:transient-exhausted with the state as evidence (required, so exit 3), and NOTHING is written - not even the sweep.
      const gate = WRITE_FAMILIES.includes(opts.family) ? writeGate(disc.apim) : null;
      if (gate) {
        result.notes.push(`${opts.family}: ${gate.note}`);
        acc.cells.push(...placeholders(opts.family, (cid) => unknown(cid, 'transient-exhausted', { evidence: { provisioningState: gate.provisioningState, note: gate.note } })));
      } else {
        await MODULES[opts.family].run(ctx, acc);
      }
    } else if (disc.state === 'zero') {
      // Reachable ONLY with no --apim-name: a named gateway that is absent is 'named-not-found' (see discoverApim).
      acc.cells.push(...placeholders(opts.family, (cid) => notMeasured(cid, 'no-gateway-in-boundary', { evidence: { apimInstancesSeen: disc.seen } })));
    } else if (disc.state === 'error') {
      const reason = reasonForFailure(disc.res, { role: 'Reader', scope: 'subscription' }) ?? 'tooling-error';
      acc.cells.push(...placeholders(opts.family, (cid) => unknown(cid, reason, { evidence: { note: 'the APIM instances could not be listed', ...quote(disc.res) } })));
    } else {
      hardStop = true;
      result.status = disc.state === 'many' ? 'AMBIGUOUS-GATEWAY' : 'NAMED-GATEWAY-NOT-FOUND';
      const names = disc.names.length ? disc.names.join(', ') : '(none)';
      // The note must be TRUE (deploy-integrity.md R7): it says how many matched, so "matched none" is never printed over a
      // listing that repeated the name, and an empty subscription is named as such rather than as "none of the 0".
      let note;
      if (disc.state === 'many') note = `${disc.seen} APIM instances are in this subscription and --apim-name was not given: refusing to guess. Names: ${names}`;
      else if (disc.seen === 0) note = `--apim-name was given but this subscription holds no APIM instance (a named gateway that is absent is a failure, not "no gateway in the boundary"). Names: ${names}`;
      else if (disc.matched === 0) note = `--apim-name matched none of the ${disc.seen} APIM instances in this subscription. Names: ${names}`;
      else note = `--apim-name matched ${disc.matched} of the ${disc.seen} APIM instances in this subscription (exactly 1 is required). Names: ${names}`;
      result.notes.push(note);
    }
  } catch (err) {
    crashed = true;
    result.status = 'CRASHED';
    result.notes.push(`crashed: ${sanitize(err?.message ?? err, 600)}`);
  }
  result.finishedAt = deps.nowIso();

  // A cell the family never produced is UNKNOWN, never absent.
  if (!hardStop) {
    const have = new Set(acc.cells.map((c) => c.id));
    for (const cid of MODULES[opts.family].CELL_IDS) {
      if (!have.has(cid)) acc.cells.push(unknown(cid, 'tooling-error', { evidence: { note: 'not produced: the family stopped before this cell (a control failed or the run crashed)' } }));
    }
  }
  result.cells = acc.cells;
  result.controls = acc.controls;
  result.exitCode = hardStop ? 2 : computeExit({ cells: acc.cells, controls: acc.controls, crashed });
  result.valid = result.exitCode !== 2;
  if (!result.valid) result.notes.push('INVALID: a control failed or the instrument crashed. NO cell of this family is publishable.');
  if (result.apim === null && result.status === 'COMPLETED') result.notes.push(`no gateway was selected (${result.discovery?.state})`);
  return result;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const cellCount = (cells, v) => cells.filter((c) => c.verdict === v).length;
// Backslash FIRST, then pipe: escaping only the pipe turns an input of backslash-pipe into two backslashes and a REAL
// column delimiter, so a hostile cell could add a column (CodeQL js/incomplete-sanitization).
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function evidenceLine(cell) {
  const ev = cell.evidence && typeof cell.evidence === 'object' ? { ...cell.evidence } : {};
  // the pasted category list is rendered whole under the table, not truncated in a cell
  delete ev.pastedCategoryNames;
  const keys = Object.keys(ev);
  if (keys.length === 0) return '';
  const text = JSON.stringify(ev);
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

/** One family as markdown (input is already sanitized JSON; sanitized again, idempotently). */
export function renderFamilyMarkdown(r) {
  const out = [];
  out.push(`### ${r.cloud} / ${r.family} - exit ${r.exitCode}${r.valid ? '' : ' - INVALID, cells NOT publishable'}`);
  out.push('');
  if (r.apim) {
    out.push(`APIM \`${r.apim.name}\` (resource group \`${r.apim.resourceGroup}\`): SKU ${r.apim.sku} x${r.apim.capacity ?? '?'}, state ${r.apim.provisioningState ?? '?'}, location ${r.apim.location ?? '?'}, virtualNetworkType ${r.apim.virtualNetworkType ?? 'n/a'}, publicNetworkAccess ${r.apim.publicNetworkAccess ?? 'n/a'}; runner ${r.runner}.`);
  } else {
    out.push(`No gateway selected (${r.discovery?.state ?? 'n/a'}; APIM instances seen: ${r.discovery?.seen ?? 'n/a'}); runner ${r.runner}.`);
  }
  for (const n of r.notes || []) out.push(`> ${n}`);
  out.push('');
  if (r.controls.length) {
    out.push('| control | status | detail |', '|---|---|---|');
    for (const c of r.controls) out.push(`| ${esc(c.id)} | ${esc(c.status)} | ${esc(c.detail)} |`);
    out.push('');
  }
  out.push('| cell | verdict | evidence |', '|---|---|---|');
  for (const c of r.cells) out.push(`| ${esc(c.id)} | ${esc(verdictText(c))} | ${esc(evidenceLine(c))} |`);
  const pasted = r.cells.filter((c) => c.evidence && Array.isArray(c.evidence.pastedCategoryNames));
  for (const c of pasted) {
    out.push('', `Pasted category list for \`${c.id}\` (the full list, not a yes): ${c.evidence.pastedCategoryNames.join(', ') || '(empty)'}`);
  }
  out.push('', `Requests logged: ${r.requests.length}. Cells: ${cellCount(r.cells, 'measured')} measured, ${cellCount(r.cells, 'not-measured')} not-measured, ${cellCount(r.cells, 'unknown')} unknown.`);
  return `${out.join('\n')}\n`;
}

/** Merge $dir/*.json into one receipt. Returns { markdown, exitCode, missing, results }. */
export function buildReceipt({ results, expect, cloud, generatedAt, run = runContext({}) }) {
  const byFamily = new Map(results.map((r) => [r.family, r]));
  const missing = expect.filter((f) => !byFamily.has(f));
  const failing = results.filter((r) => r.exitCode !== 0);
  const runLine = run.runId
    ? `Actions run ${run.runId} (attempt ${run.attempt ?? '?'}) of ${run.workflow ?? 'workflow'} on ${run.ref ?? '?'} at ${run.sha ?? '?'}.`
    : 'Not an Actions run (no GITHUB_RUN_ID): a local invocation.';
  const lines = [`## Loom API plane W0 probe - ${cloud}`, '', `Generated ${generatedAt}. ${runLine} Redacted: names, resource groups, SKUs and states only.`, ''];
  lines.push('| family | exit | valid | measured | not-measured | unknown |', '|---|---|---|---|---|---|');
  for (const f of expect) {
    const r = byFamily.get(f);
    lines.push(r
      ? `| ${f} | ${r.exitCode} | ${r.valid} | ${cellCount(r.cells, 'measured')} | ${cellCount(r.cells, 'not-measured')} | ${cellCount(r.cells, 'unknown')} |`
      : `| ${f} | MISSING | - | - | - | - |`);
  }
  lines.push('');
  if (missing.length) lines.push(`**FAILED: no artifact from ${missing.join(', ')} - that family never wrote a result (it crashed or never ran).**`, '');
  if (failing.length) lines.push(`**FAILED: ${failing.map((r) => `${r.family}=${r.exitCode}`).join(', ')}.** 2 = a control failed or the script crashed (family INVALID); 3 = a required cell is unknown or scratch objects remain.`, '');
  for (const f of expect) { const r = byFamily.get(f); if (r) lines.push(renderFamilyMarkdown(r)); }
  let exitCode = 0;
  if (missing.length || failing.some((r) => r.exitCode === 2)) exitCode = 2;
  else if (failing.length) exitCode = 3;
  // The results were read from files: treat them as untrusted and redact the whole document again.
  return { markdown: sanitizeBlock(lines.join('\n')), exitCode, missing };
}

export function aggregate(opts, deps) {
  const dir = resolve(opts.aggregate);
  const cloud = opts.cloud;
  const results = [];
  for (const name of deps.fs.readdirSync(dir).filter((n) => n.startsWith(`${cloud}-`) && n.endsWith('.json')).sort()) {
    let parsed;
    try { parsed = JSON.parse(deps.fs.readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (parsed?.schema === SCHEMA && parsed.cloud === cloud) results.push(parsed);
  }
  const rec = buildReceipt({ results, expect: opts.expect, cloud, generatedAt: deps.nowIso(), run: runContext(deps.env) });
  deps.fs.writeFileSync(join(dir, 'receipt.md'), rec.markdown);
  if (opts.summaryFile) deps.fs.appendFileSync(opts.summaryFile, `${rec.markdown}\n`);
  deps.log(`receipt: ${results.length} family result(s), exit ${rec.exitCode}${rec.missing.length ? `, MISSING ${rec.missing.join(',')}` : ''}`);
  return rec.exitCode;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/** Parse, run, write. Returns the process exit code; never calls process.exit. */
export async function runProbe(argv, deps) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) { deps.log(`usage error: ${err.message}`); return 2; }
    throw err;
  }
  if (opts.aggregate) return aggregate(opts, deps);

  const result = deepSanitize(await runFamilyProbe(opts, deps), 4000);
  const out = resolve(opts.out);
  deps.fs.mkdirSync(out, { recursive: true });
  const base = join(out, `${opts.cloud}-${opts.family}`);
  deps.fs.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
  deps.fs.writeFileSync(`${base}.md`, renderFamilyMarkdown(result));
  deps.log(`${result.cloud}/${result.family}: exit ${result.exitCode}${result.valid ? '' : ' (INVALID: not publishable)'}`);
  for (const c of result.cells) deps.log(`  ${c.id} => ${sanitize(verdictText(c), 400)}`);
  for (const c of result.controls) deps.log(`  control ${c.id}: ${c.status}`);
  for (const n of result.notes) deps.log(`  note: ${sanitize(n, 600)}`);
  return result.exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runProbe(process.argv.slice(2), realDeps()).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`w0-apim-probe crashed: ${sanitize(err?.stack ?? err, 1200)}\n`); process.exitCode = 2; },
  );
}
