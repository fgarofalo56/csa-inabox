/**
 * discovery.live.ts — REAL Azure receipt for the multi-subscription adoption scan.
 *
 * Runs the SHIPPED scanner (`scanForAdoptionCandidates` + `liveTransport`)
 * against a real tenant. Not a CI gate: `vitest.live.config.ts` is the only
 * config that includes this path, and it is never invoked by a workflow.
 *
 *   export LOOM_LIVE_ARM_TOKEN="$(az account get-access-token \
 *       --resource https://management.azure.com --query accessToken -o tsv)"
 *   node_modules/.bin/vitest run --config vitest.live.config.ts
 *
 * Fails — never skips — without a token, so a green run always means real
 * Azure answered. Commercial only; Gov is verified through GitHub Actions.
 *
 * Nothing identifying is printed: subscription ids are shown as their first
 * segment only, and resource ids are redacted to their last two path segments.
 */
import { describe, it, expect } from 'vitest';
import {
  scanForAdoptionCandidates,
  liveTransport,
  listVisibleSubscriptions,
} from '@/lib/deploy/discovery-scanner';
import { redactArmId } from '@/lib/deploy/discovery-model';

const TOKEN = process.env.LOOM_LIVE_ARM_TOKEN || '';
/** A syntactically valid GUID that is not a real subscription in any tenant. */
const NOT_A_SUBSCRIPTION = '00000000-0000-0000-0000-000000000000';

function short(id: string): string {
  return id ? `${id.slice(0, 8)}…` : '(none)';
}

describe('LIVE: multi-subscription adoption discovery', () => {
  it('has an ARM token (fails rather than skipping — a skipped probe is not a receipt)', () => {
    expect(
      TOKEN.length,
      'LOOM_LIVE_ARM_TOKEN is unset. Export a real ARM token before running the live probe.',
    ).toBeGreaterThan(100);
  });

  it('scans every visible subscription and returns a complete, honest ledger', async () => {
    const creds = { userToken: TOKEN, uamiToken: null };
    const visible = await listVisibleSubscriptions(liveTransport, TOKEN);
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;

    const out = await scanForAdoptionCandidates({}, creds, liveTransport);
    expect(out.ok).toBe(true);
    if (!out.ok) {
      throw new Error(`scan failed: ${out.code} — ${out.established}`);
    }

    const r = out.result;
    // eslint-disable-next-line no-console
    console.log('\n--- LIVE RECEIPT: coverage ledger ---');
    for (const s of r.subscriptions) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${short(s.subscriptionId)}  ${s.status.padEnd(12)} tier=${s.credentialTier} ` +
          `matches=${s.matchedResources}  "${s.displayName}"`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  SUMMARY: ${r.summary}`);

    // Every REQUESTED subscription appears exactly once — the ledger is built
    // from the request, not from the rows.
    expect(r.subscriptions.length).toBe(visible.subscriptions.length);
    expect(new Set(r.subscriptions.map((s) => s.subscriptionId)).size).toBe(r.subscriptions.length);
    for (const s of r.subscriptions) expect(s.established.length).toBeGreaterThan(10);

    // eslint-disable-next-line no-console
    console.log('\n--- LIVE RECEIPT: candidates per service ---');
    for (const svc of r.services) {
      const line =
        `  ${svc.serviceKey.padEnd(16)} ${String(svc.candidates.length).padStart(3)} candidate(s)  ` +
        `→ ${svc.recommendation}${svc.noCandidateOutcome ? ` (${svc.noCandidateOutcome})` : ''}`;
      // eslint-disable-next-line no-console
      console.log(line);
      for (const c of svc.candidates.slice(0, 2)) {
        // eslint-disable-next-line no-console
        console.log(
          `        ${redactArmId(c.id)}  ${c.location}  sku=${c.sku.name || '-'}/${c.sku.tier || '-'}  ` +
            `net=${c.networkPosture} pe=${c.privateEndpointCount}` +
            (c.hierarchicalNamespace === undefined ? '' : ` hns=${c.hierarchicalNamespace}`) +
            (c.looksLoomOwned ? ' [loom-owned]' : ''),
        );
      }
    }

    // Real Azure, real rows: this tenant is not empty, so at least one service
    // must have found something. A scan that returns nothing everywhere would
    // mean the query or the mapping is broken, not that the estate is bare.
    const totalCandidates = r.services.reduce((n, s) => n + s.candidates.length, 0);
    expect(totalCandidates, 'live scan found zero candidates across the whole tenant').toBeGreaterThan(0);

    // Every candidate carries the coordinates the plan and the RBAC grant need.
    for (const svc of r.services) {
      for (const c of svc.candidates) {
        expect(c.id).toContain('/subscriptions/');
        expect(c.subscriptionId).toBeTruthy();
        expect(c.resourceGroup).toBeTruthy();
        expect(c.serviceKey).toBe(svc.serviceKey);
      }
    }
  });

  it('reports an UNREADABLE subscription as no-access — never as scanned-with-zero', async () => {
    // The whole point. Ask for every real subscription PLUS one that cannot
    // exist. Resource Graph answers 200 and silently omits the bogus scope; the
    // scanner must still say it could not read it.
    const visible = await listVisibleSubscriptions(liveTransport, TOKEN);
    expect(visible.ok).toBe(true);
    if (!visible.ok) return;
    const scope = [...visible.subscriptions.map((s) => s.subscriptionId), NOT_A_SUBSCRIPTION];

    const out = await scanForAdoptionCandidates({ subscriptions: scope }, { userToken: TOKEN, uamiToken: null }, liveTransport);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const bogus = out.result.subscriptions.find((s) => s.subscriptionId === NOT_A_SUBSCRIPTION);
    expect(bogus, 'the unreadable subscription is missing from the ledger entirely').toBeTruthy();
    expect(bogus!.status).toBe('no-access');
    expect(bogus!.matchedResources).toBe(0);

    // eslint-disable-next-line no-console
    console.log('\n--- LIVE RECEIPT: unreadable subscription ---');
    // eslint-disable-next-line no-console
    console.log(`  ${short(NOT_A_SUBSCRIPTION)}  status=${bogus!.status}`);
    // eslint-disable-next-line no-console
    console.log(`  established: ${bogus!.established}`);
    // eslint-disable-next-line no-console
    console.log(`  SUMMARY: ${out.result.summary}`);

    // …and every service with no candidate must now be UNCERTAIN rather than
    // confidently reporting "none exist".
    const empties = out.result.services.filter((s) => s.candidates.length === 0 && s.cls !== 'create-only');
    for (const s of empties) {
      expect(s.noCandidateOutcome).toBe('could-not-look');
      expect(s.uncertain).toBe(true);
    }
    expect(out.result.summary).toContain('could NOT be read');
  });
});
