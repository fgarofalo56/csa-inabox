/**
 * Input resolution + SHELL-FREE process execution for POST /api/setup/wire-existing.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The wire-existing route used to build its Azure resource-group coordinate by
 * concatenating two request fields:
 *
 *     const dlzRg = `rg-csa-loom-dlz-${dlz.domainName}-${body.location}`;
 *
 * and then interpolated that string into THREE command strings handed to
 * `execSync()`. `execSync` runs its argument through `/bin/sh -c`, so the shell
 * — not the route — decided where the command ended. A `;`, `$(…)`, a backtick
 * or a newline anywhere in `domainName` / `location` / `subscriptionId` was
 * parsed as shell syntax and executed as the console process.
 *
 * The fix is structural, in three independent layers. Escaping and denylists are
 * deliberately NOT among them — both are bypass-prone and both leave the shell
 * in the loop:
 *
 *   L1 — NO SHELL. Every child process is started with {@link spawnSync} on an
 *        argv ARRAY with `shell: false`. Values ride in `env`, never inside a
 *        command string, so there is no grammar in which a metacharacter could
 *        be re-parsed. This is the load-bearing control: it holds even if L2 and
 *        L3 are wrong.
 *   L2 — RESOLVE, DON'T ACCEPT. The resource-group name is never built from
 *        request text. {@link resolveSelectedDlzs} matches the caller's
 *        selection against the DLZ resource groups Azure Resource Graph actually
 *        returns, and every downstream consumer uses the AZURE-RETURNED `rg`
 *        string. A resource group that does not exist cannot be named, so the
 *        request cannot introduce a coordinate of its own invention. This is an
 *        EXISTENCE proof, NOT a per-caller entitlement check — see
 *        {@link scanDeployedDlzs} for which identity the scan actually runs as.
 *   L3 — STRICT ALLOW-LISTS. {@link isSubscriptionId}, {@link isAzureLocation},
 *        {@link isDlzDomainName} and {@link isSafeResourceGroupName} accept only
 *        the character sets Azure itself permits. Anything else is refused with
 *        400 before a token is acquired or a process is spawned.
 *
 * A NOTE ON THE PARAMETER PASSING BUG THIS ALSO FIXES
 * ---------------------------------------------------
 * The old call was `bash <script> SUB=<x> DLZ_RG=<y>`. `KEY=VALUE` placed AFTER
 * a command name is a positional ARGUMENT, not an assignment — assignments only
 * bind when they PRECEDE the command. Both scripts read `SUB="${SUB:-…}"` and
 * `DLZ_RG="${DLZ_RG:-…}"`, i.e. from the ENVIRONMENT, and neither reads `$1`/`$2`
 * at all. So the caller's values were silently discarded and the scripts ran
 * against their hard-coded defaults. Verified:
 *
 *     $ bash probe.sh SUB=real-sub DLZ_RG=real-rg
 *     argv=[SUB=real-sub DLZ_RG=real-rg] SUB=DEFAULT_SUB DLZ_RG=DEFAULT_RG
 *     $ SUB=real-sub DLZ_RG=real-rg bash probe.sh
 *     argv=[] SUB=real-sub DLZ_RG=real-rg
 *
 * Passing through `env` is therefore both the safe form AND the only form these
 * scripts have ever actually read.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { armBase } from '@/lib/azure/cloud-endpoints';

// ───────────────────────────────────────────────────────────────────────────
// L3 — strict allow-lists
//
// Each pattern is anchored at BOTH ends and admits only characters Azure itself
// permits for that field. None of the sets contain a shell metacharacter, a
// quote, whitespace, or a line terminator, so a value that passes cannot carry
// shell syntax even if it later reached a shell by mistake.
// ───────────────────────────────────────────────────────────────────────────

/** Canonical 8-4-4-4-12 GUID. Azure subscription ids are always this shape. */
export const SUBSCRIPTION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Azure region short name — lower-case letters and digits only
 * (`eastus2`, `usgovvirginia`, `centralus`). Never punctuated.
 */
export const AZURE_LOCATION_RE = /^[a-z][a-z0-9]{1,39}$/;

/**
 * DLZ domain segment. It is embedded in a resource-group name, so it is limited
 * to the alphanumeric-plus-hyphen set: must start and end alphanumeric.
 */
export const DLZ_DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Resource-group name. Azure allows alphanumerics, `_`, `.`, `-` (and
 * parentheses, which Loom never emits and which are excluded here), 1-90 chars,
 * and forbids a trailing period. Applied to the AZURE-RETURNED name as a
 * belt-and-braces check before it is handed to a child process.
 */
export const AZURE_RG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,88}$/;

export function isSubscriptionId(v: unknown): v is string {
  return typeof v === 'string' && SUBSCRIPTION_ID_RE.test(v);
}

export function isAzureLocation(v: unknown): v is string {
  return typeof v === 'string' && AZURE_LOCATION_RE.test(v);
}

export function isDlzDomainName(v: unknown): v is string {
  return typeof v === 'string' && DLZ_DOMAIN_RE.test(v);
}

export function isSafeResourceGroupName(v: unknown): v is string {
  return (
    typeof v === 'string' && AZURE_RG_NAME_RE.test(v) && !v.endsWith('.')
  );
}

// ───────────────────────────────────────────────────────────────────────────
// L2 — resolve the resource group from deployment state
// ───────────────────────────────────────────────────────────────────────────

/** A DLZ resource group that Azure Resource Graph actually returned. */
export interface DiscoveredDlz {
  subscriptionId: string;
  domainName: string;
  region: string;
  /** The resource-group name AS AZURE REPORTS IT — never client-supplied text. */
  rg: string;
}

/** What the caller asked to wire. Both fields are untrusted request input. */
export interface RequestedDlz {
  subscriptionId: string;
  domainName: string;
}

/** Parse `rg-csa-loom-dlz-<domain>-<region>` → { domainName, region }. */
export function parseDlzRg(rg: string): { domainName: string; region: string } | null {
  const m = /^rg-csa-loom-dlz-(.+)-([a-z0-9]+)$/i.exec(rg);
  if (!m) return null;
  return { domainName: m[1], region: m[2] };
}

/**
 * Enumerate the CSA Loom DLZ resource groups visible to `token`, via Azure
 * Resource Graph, paging through `$skipToken` so a tenant with more than one
 * page lists fully rather than silently truncating.
 *
 * Resource Graph honours the RBAC of whichever identity `token` belongs to — the
 * signed-in user when OBO is available, otherwise the Console UAMI (see
 * `getArmTokenPreferUser` in `lib/auth/obo.ts`, which falls back). So this is
 * NOT a per-caller entitlement check, and must not be documented as one.
 *
 * What it DOES guarantee, which is the property L2 rests on, is that every name
 * returned is one AZURE REPORTED for a resource group that actually exists. The
 * request cannot introduce a coordinate of its own construction. That holds
 * regardless of which of the two identities the scan ran as.
 *
 * NOTE: this mirrors the scan in `app/api/setup/existing-dlzs/route.ts`, which
 * is what populates the wizard's picker. The two are intentionally kept in step;
 * folding that route onto this helper is a worthwhile follow-up but is outside
 * the blast radius of the security fix this module exists for.
 */
export async function scanDeployedDlzs(token: string): Promise<DiscoveredDlz[]> {
  const arm = armBase();
  const dlzs: DiscoveredDlz[] = [];
  let skipToken: string | undefined;
  do {
    const res = await fetch(
      `${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            "ResourceContainers | where type == 'microsoft.resources/subscriptions/resourcegroups' " +
            "| where name startswith 'rg-csa-loom-dlz-' " +
            '| project name, subscriptionId, location ' +
            '| order by name asc',
          options: { $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) },
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Resource Graph ${res.status}: ${t.slice(0, 200)}`);
    }
    const j: any = await res.json();
    for (const row of (j?.data || []) as any[]) {
      const parsed = parseDlzRg(row.name);
      if (!parsed) continue;
      dlzs.push({
        subscriptionId: row.subscriptionId,
        domainName: parsed.domainName,
        region: parsed.region || row.location || '',
        rg: row.name,
      });
    }
    skipToken = j?.$skipToken || undefined;
  } while (skipToken);
  return dlzs;
}

/** Outcome of matching one requested DLZ against discovered estate state. */
export type ResolvedDlz =
  | { ok: true; requested: RequestedDlz; discovered: DiscoveredDlz }
  | { ok: false; requested: RequestedDlz; reason: string };

/**
 * Match each requested `(subscriptionId, domainName)` pair against the DLZs
 * Resource Graph returned, and hand back the Azure-reported resource group.
 *
 * A request that names a DLZ which does not exist (or which this caller cannot
 * see) resolves to `ok: false` and NEVER produces a resource-group string — so
 * no unresolvable value can travel onward toward a child process.
 */
export function resolveSelectedDlzs(
  requested: RequestedDlz[],
  discovered: DiscoveredDlz[],
): ResolvedDlz[] {
  return requested.map((req) => {
    const hit = discovered.find(
      (d) =>
        d.subscriptionId.toLowerCase() === req.subscriptionId.toLowerCase() &&
        d.domainName.toLowerCase() === req.domainName.toLowerCase(),
    );
    if (!hit) {
      return {
        ok: false as const,
        requested: req,
        reason:
          'No Data Landing Zone with that domain exists in that subscription, or the ' +
          'identity the discovery scan ran as could not see it. That is the signed-in ' +
          'user when their ARM consent is available, otherwise the Console UAMI — grant ' +
          'Reader on the subscription to whichever applies and retry.',
      };
    }
    // Belt and braces: the name came from Azure, but it is about to cross a
    // process boundary, so it is re-checked against the allow-list regardless.
    if (!isSafeResourceGroupName(hit.rg)) {
      return {
        ok: false as const,
        requested: req,
        reason: 'The discovered resource-group name failed resource-name validation.',
      };
    }
    return { ok: true as const, requested: req, discovered: hit };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// L1 — shell-free process execution
// ───────────────────────────────────────────────────────────────────────────

/**
 * The wiring scripts this route is permitted to run. A fixed two-entry
 * allow-list of BASENAMES: the script to run is chosen by the route, never
 * named by the request, so no path traversal or arbitrary-script selection is
 * reachable from the network.
 */
export const WIRE_SCRIPTS = {
  grantRbac: 'grant-navigator-rbac.sh',
  patchEnv: 'patch-navigator-env.sh',
} as const;

export type WireScript = (typeof WIRE_SCRIPTS)[keyof typeof WIRE_SCRIPTS];

/** Wall-clock ceiling for a single wiring script. */
export const WIRE_SCRIPT_TIMEOUT_MS = Number(process.env.LOOM_WIRE_SCRIPT_TIMEOUT_MS) || 300_000;

export interface WireScriptResult {
  ok: boolean;
  /** Process exit code, or null when the process never started / was killed. */
  status: number | null;
  /** Honest, specific description of what happened. Never a bare stack trace. */
  reason: string;
  stderr?: string;
}

/** Directory holding the wiring scripts; overridable for tests + alternate layouts. */
export function wireScriptsDir(): string {
  return process.env.LOOM_WIRE_SCRIPTS_DIR || path.join(process.cwd(), 'scripts', 'csa-loom');
}

/**
 * Run one wiring script with NO SHELL.
 *
 * `spawnSync(cmd, args, { shell: false })` hands `args` to the OS exec call as a
 * pre-split argv vector. There is no shell to parse the values, so `;`, `$(…)`,
 * backticks, quotes, newlines and every other metacharacter are inert data —
 * whatever `vars` contains, it can only ever become the VALUE of an environment
 * variable, never a command.
 *
 * `shell: false` is already the default; it is stated explicitly because it is
 * the control this function exists to enforce, and an explicit flag is what a
 * reviewer (and a guard script) can actually see.
 *
 * Values are passed in `env` because that is what these scripts read — see the
 * module header on the positional-vs-environment bug this replaces.
 */
export function runWireScript(
  script: WireScript,
  vars: Record<string, string>,
  opts: { timeoutMs?: number } = {},
): WireScriptResult {
  // Reject anything not on the allow-list, even though the type already pins it
  // — this is the last line before a process is created.
  const allowed = Object.values(WIRE_SCRIPTS) as string[];
  if (!allowed.includes(script)) {
    return { ok: false, status: null, reason: `Refused: '${script}' is not an allowed wiring script.` };
  }

  const scriptPath = path.join(wireScriptsDir(), script);
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      status: null,
      reason:
        `The wiring script '${script}' is not present in this deployment ` +
        `(looked in ${wireScriptsDir()}). The console runtime image ships the Next.js ` +
        `standalone build only, so RBAC/env wiring must be run from CI or a workstation ` +
        `with the repo and the az CLI available.`,
    };
  }

  // Every value is validated by the caller (L3) and carries no shell meaning
  // here regardless, because no shell is involved.
  const r = spawnSync('bash', [scriptPath], {
    shell: false,
    env: { ...process.env, ...vars },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? WIRE_SCRIPT_TIMEOUT_MS,
    stdio: 'pipe',
    windowsHide: true,
  });

  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        status: null,
        reason:
          `Could not start 'bash' to run '${script}'. The console runtime image does not ` +
          `include a bash shell or the az CLI, so this wiring step cannot run in-process.`,
      };
    }
    return { ok: false, status: null, reason: `Failed to run '${script}': ${code ?? r.error.message}` };
  }

  if (r.signal) {
    return {
      ok: false,
      status: null,
      reason: `'${script}' was terminated by ${r.signal} (timeout is ${opts.timeoutMs ?? WIRE_SCRIPT_TIMEOUT_MS}ms).`,
      stderr: typeof r.stderr === 'string' ? r.stderr.slice(0, 2000) : undefined,
    };
  }

  const status = r.status ?? null;
  return {
    ok: status === 0,
    status,
    reason: status === 0 ? `'${script}' completed successfully.` : `'${script}' exited ${status}.`,
    stderr: typeof r.stderr === 'string' ? r.stderr.slice(0, 2000) : undefined,
  };
}
