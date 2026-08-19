#!/usr/bin/env node
/**
 * resolve-dns-inbound-allocation.mjs — DISCOVER how the hub's DNS Private
 * Resolver INBOUND endpoint is addressed, and export it so the ARM apply names
 * the value the live resource actually holds.
 *
 * ── THE DEFECT THIS REMOVES (#3754) ─────────────────────────────────────────
 *
 * On `Microsoft.Network/dnsResolvers/inboundEndpoints`, BOTH the allocation
 * method and the static address are IMMUTABLE. ARM rejects any deployment
 * naming a value that differs from the one the endpoint was created with, and
 * that rejection kills the whole nested `network` template — and with it every
 * unrelated change in the same `az deployment sub create`.
 *
 * network.bicep has now been broken by a hard-coded literal in BOTH directions,
 * and the second break was caused by the fix for the first:
 *
 *   * `Static` + a computed address was the original. The live COMMERCIAL
 *     endpoint had been created Dynamic, so every Commercial deploy failed with
 *     `ipAllocationMethod=Static, existingIpAllocationMethod=Dynamic` (#2775).
 *   * #2881 therefore hard-coded `Dynamic` to match Commercial. The live
 *     GCC-High endpoint was created by the EARLIER template and holds Static, so
 *     the exact mirror image — `ipAllocationMethod=Dynamic,
 *     existingIpAllocationMethod=Static` — has failed every `deploy-fiab-gcch`
 *     run since (run 32126019475, ARM leaf on `admin-plane`).
 *
 * Each literal was measured, correct for its own estate, and wrong for the
 * other. Pinning it per boundary in a `.bicepparam` would only relocate the
 * guess. deploy-integrity.md R5.3 says the same thing in general terms —
 * "validate the chosen existing resource is actually usable", never assume.
 *
 * ── ONE VALUE, NOT TWO ──────────────────────────────────────────────────────
 *
 * A Static endpoint is fully described by its address; a Dynamic one by the
 * absence of one. So this emits a single `LOOM_DNS_INBOUND_STATIC_IP` — the
 * live address when the method is Static, empty otherwise — which the bicep
 * parameter of the same name consumes directly. Nothing is derived: an earlier
 * revision computed the Static address from the subnet layout, which was sound
 * reasoning and still an inference, and `privateIpAddress` is immutable too, so
 * being wrong would only have swapped this failure for the identical one about
 * a different field.
 *
 * ── THE THREE OUTCOMES, AND WHY THE THIRD IS NOT THE SECOND ─────────────────
 *
 *   discovered  the endpoint exists → export what it holds.
 *   greenfield  az returned a DEFINITE absence signal (ResourceNotFound /
 *               ResourceGroupNotFound / ParentResourceNotFound) → nothing is
 *               being converged on, so the deploy CREATES a dynamically-
 *               allocated endpoint, exactly as it has since #2881.
 *   refuse      anything else — an RBAC denial, a throttle, a network failure,
 *               an exit 0 whose payload has no allocation method, or a Static
 *               endpoint that reports no address. UNKNOWN is NOT absence.
 *               Collapsing the two is precisely the R7 defect ("I could not
 *               read it" rendered as "it does not exist") that
 *               `2>/dev/null || echo ""` produced elsewhere in this repo, so
 *               this exits non-zero with the raw stderr attached.
 *
 * Usage:
 *   node scripts/ci/resolve-dns-inbound-allocation.mjs \
 *     --subscription <sub-id> --rg rg-csa-loom-admin-<loc> --location <loc>
 *
 * Tests: node --test scripts/ci/__tests__/estate-preflight.test.mjs
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { definiteAbsenceCode } from './_arm-absence.mjs';

/** What a greenfield estate gets: no static address ⇒ dynamic allocation.
 *  Must equal the `dnsResolverInboundStaticIp` default in
 *  platform/fiab/bicep/modules/admin-plane/network.bicep — a drift here would
 *  silently propose a change to an immutable property on greenfield. Asserted
 *  by scripts/ci/__tests__/estate-preflight.test.mjs. */
export const GREENFIELD_DEFAULT = '';

/**
 * PURE. Decide what an `az resource show` attempt established.
 *
 * @param {{ok: boolean, stdout: string, stderr: string}} attempt
 * @returns {{decision: 'discovered'|'greenfield'|'refuse', value: string|null, reason: string}}
 *   `value` is the STATIC address to pass to bicep, or '' for dynamic allocation.
 */
export function classifyDnsInboundRead(attempt) {
  const stderr = String(attempt?.stderr ?? '');
  if (!attempt?.ok) {
    const hit = definiteAbsenceCode(stderr);
    if (hit) {
      return {
        decision: 'greenfield',
        value: GREENFIELD_DEFAULT,
        reason:
          `az reported ${hit}, a definite absence — there is no inbound endpoint to converge on, so this ` +
          'deploy CREATES one with dynamic allocation, exactly as every estate has had since #2881.',
      };
    }
    return {
      decision: 'refuse',
      value: null,
      reason:
        'the read did NOT complete, so whether an inbound endpoint exists — and how it is addressed — is ' +
        'UNKNOWN, not absent. Refusing rather than proposing a change to an immutable property on a guess.',
    };
  }

  let payload;
  try {
    payload = JSON.parse(attempt.stdout);
  } catch {
    return {
      decision: 'refuse',
      value: null,
      reason: 'az exited 0 but its output was not JSON, so nothing about the live endpoint was established.',
    };
  }

  const config = payload?.properties?.ipConfigurations?.[0];
  const method = config?.privateIpAllocationMethod;
  if (typeof method !== 'string' || method === '') {
    return {
      decision: 'refuse',
      value: null,
      reason:
        'the inbound endpoint EXISTS but its payload carries no ipConfigurations[0].privateIpAllocationMethod. ' +
        'Defaulting here would propose a change to an immutable property on a resource whose current value ' +
        'was never read.',
    };
  }

  if (method === 'Dynamic') {
    return {
      decision: 'discovered',
      value: '',
      reason: "the live inbound endpoint is dynamically allocated, so no static address is pinned.",
    };
  }

  if (method === 'Static') {
    const address = config?.privateIpAddress;
    if (typeof address !== 'string' || address === '') {
      return {
        decision: 'refuse',
        value: null,
        reason:
          'the live inbound endpoint reports Static allocation but no privateIpAddress. Deploying Static ' +
          'without the address it actually holds would fail on the SAME immutability rule, one field over.',
      };
    }
    return {
      decision: 'discovered',
      value: address,
      reason: `the live inbound endpoint is statically allocated at ${address}.`,
    };
  }

  return {
    decision: 'refuse',
    value: null,
    reason:
      `the live endpoint reports privateIpAllocationMethod='${method}', which is neither Dynamic nor Static. ` +
      'What the template should send for it is UNKNOWN.',
  };
}

/** PURE. The ARM id of the hub resolver's inbound endpoint. */
export function inboundEndpointId({ subscription, rg, location }) {
  return (
    `/subscriptions/${subscription}/resourceGroups/${rg}` +
    `/providers/Microsoft.Network/dnsResolvers/dnspr-loom-${location}/inboundEndpoints/inbound`
  );
}

// ── I/O shell ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

/**
 * Read the endpoint. `az` is invoked WITHOUT a shell (the resource id is built
 * from workflow-supplied values) and its stderr is CAPTURED, never discarded —
 * the classifier above needs the error code to tell absence from unreadable.
 */
function readInboundEndpoint(id) {
  try {
    const stdout = execFileSync(
      'az',
      ['resource', 'show', '--ids', id, '--api-version', '2022-07-01', '-o', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? e?.message ?? e),
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = ['subscription', 'rg', 'location'].filter((k) => !args[k]);
  if (missing.length) {
    console.log(
      `::error::resolve-dns-inbound-allocation: missing required argument(s) --${missing.join(' --')}. ` +
        'Without them the endpoint id cannot be built, so nothing can be read.',
    );
    process.exit(1);
  }

  const id = inboundEndpointId(args);
  const attempt = readInboundEndpoint(id);
  const verdict = classifyDnsInboundRead(attempt);

  if (verdict.decision === 'refuse') {
    console.log(
      `::error::Could not establish how the DNS Private Resolver inbound endpoint is addressed — ${verdict.reason} ` +
        'Its allocation method and static address are both IMMUTABLE, so deploying on a guess fails the WHOLE ' +
        'admin-plane template (#3754). ' +
        `REMEDIATION: confirm the deploy service principal holds Reader on ${args.rg}, then re-run; to override ` +
        'deliberately, pass --parameters dnsResolverInboundStaticIp=<address, or empty for dynamic> matching ' +
        `properties.ipConfigurations[0] at ${id}.`,
    );
    if (attempt.stderr) {
      console.log('--- raw az stderr (first 20 lines) ---');
      console.log(attempt.stderr.split('\n').slice(0, 20).join('\n'));
    }
    process.exit(1);
  }

  console.log(
    `[dns-inbound-alloc] ${verdict.decision}: ${verdict.reason} → ` +
      `dnsResolverInboundStaticIp='${verdict.value}'`,
  );

  const envFile = process.env.GITHUB_ENV;
  if (envFile) appendFileSync(envFile, `LOOM_DNS_INBOUND_STATIC_IP=${verdict.value}\n`);
  else console.log(`LOOM_DNS_INBOUND_STATIC_IP=${verdict.value}`);
}

// Only run when executed directly, so the pure functions above can be imported
// by the unit tests without touching az.
if (process.argv[1] && process.argv[1].endsWith('resolve-dns-inbound-allocation.mjs')) main();
