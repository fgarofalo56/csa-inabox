/**
 * #4097 round 2 — A BUNDLE MAY NOT DECLARE A DESTINATION THE PLATFORM CANNOT
 * HONOUR.
 *
 * WHY THIS FILE EXISTS, AND WHY `activator-receiver-reachability.test.ts` IS
 * NOT ENOUGH.
 *
 * That file asserts the RUNTIME property: an installed activator always reaches
 * a human. #4105 made that true by falling back to the installing operator's own
 * address when the bundle names nothing deliverable. The fallback is correct —
 * and it made that assertion UNFALSIFIABLE. A reviewer injected a brand-new
 * bundle activator whose destination was an unexpanded `${…}` template and the
 * whole suite stayed green, because the fallback rescued it exactly as it
 * rescues the eleven real ones. An assertion the fix satisfies unconditionally
 * cannot distinguish a good bundle from a broken one; that silence was the
 * finding.
 *
 * So this file asserts the ORTHOGONAL property, the one the fallback cannot
 * fake: WHAT THE BUNDLE ITSELF DECLARED.
 *
 * The class of defect, stated once so the control can be keyed to it rather
 * than to any particular spelling of it:
 *
 *   > A bundle puts a VALUE in a field that is a notification DESTINATION, and
 *   > that value can never receive a notification.
 *
 * Note what is NOT in that class. A bundle that declares only an INTENT — a
 * Teams channel name, a Key Vault secret name — asserts no destination at all.
 * Content bundles are generic; they cannot know a tenant's Teams webhook or its
 * ops mailbox, so naming the intent and letting the platform bind the installing
 * operator is the correct design (auto-bind-by-default.md). Eight of the eleven
 * shipped activators are that shape and are fine. The three that are not put a
 * literal `https://${sentinelWorkspace}…` in `config.url` and a fabricated
 * `…@csa.example.com` in `config.recipients` — places that do not exist.
 *
 * HOW THE CONTROL IS KEYED. Every assertion below routes through the platform's
 * OWN binder (`normalizeActivatorAction`) and its structured per-field verdict.
 * The test contains no list of bad spellings: it never greps for `${`, for
 * `example.com`, or for anything else. Whatever the binder rejects is a
 * violation, so a spelling nobody has thought of yet — `{{mustache}}`, `%VAR%`,
 * `foo.invalid`, a bare hostname, an `ftp://` scheme, a 2-digit phone number, a
 * half-declared Logic App, an object where a URL belongs — is caught the day it
 * is written, with no edit to this file.
 *
 * And because a control over a clean population proves nothing, §4 drives the
 * SAME classifier over a synthetic action at EVERY destination field and
 * requires each one to be caught. If someone weakens the binder so it stops
 * rejecting, §4 goes red even while every real bundle is fine.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── the ARM boundary — the ONLY thing mocked, so the REAL derivation runs ────
const upsertActionGroup = vi.fn(async (_i: any) => '/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/actionGroups/ag');
vi.mock('@/lib/azure/monitor-client', () => ({
  MonitorNotConfiguredError: class extends Error { missing: string[]; constructor(m: string[]) { super('not configured'); this.missing = m; } },
  MonitorError: class extends Error { status: number; constructor(m: string, s = 500) { super(m); this.status = s; } },
  upsertActionGroup: (i: any) => upsertActionGroup(i),
  upsertScheduledQueryRule: vi.fn(async () => ({})),
  patchScheduledQueryRule: vi.fn(async () => undefined),
  deleteScheduledQueryRule: vi.fn(async () => undefined),
  queryLogs: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
  listAlertHistory: vi.fn(async () => []),
}));
vi.mock('@/lib/azure/kusto-client', () => ({
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
  normalizeClusterUri: (v?: string) => v,
  defaultDatabase: () => 'db',
}));

import {
  DESTINATION_FIELDS,
  declaredDestinationFields,
  destinationPath,
  normalizeActivatorAction,
  rejectedDestinations,
} from '../_activator-receivers';
import { createMonitorActivatorRule } from '@/lib/azure/activator-monitor';
import { listBundleIds, getBundle } from '@/lib/apps/content-bundles';

const LA = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law';

interface BundleRule { appId: string; displayName: string; ruleName: string; action: any; }

/**
 * Every activator RULE in every registered content bundle — the population, not
 * a sample, and enumerated from the registry so a bundle added tomorrow is in
 * scope without editing this file.
 */
async function allBundleActivatorRules(): Promise<BundleRule[]> {
  const out: BundleRule[] = [];
  for (const appId of listBundleIds()) {
    const bundle = await getBundle(appId);
    for (const item of bundle?.items || []) {
      if (item.itemType !== 'activator') continue;
      const content: any = item.content;
      const rules = content?.rule ? [content.rule] : Array.isArray(content?.rules) ? content.rules : [];
      for (const r of rules) {
        out.push({ appId, displayName: item.displayName, ruleName: r?.name || '(unnamed)', action: r?.action });
      }
    }
  }
  return out;
}

/**
 * The binder's verdict on what the BUNDLE declared, with NO fallback address
 * available. Passing `[]` is the whole point: it removes the rescue that makes
 * the runtime assertion unfalsifiable, so what remains is the bundle's own
 * content and nothing else.
 */
function classify(action: any) {
  return normalizeActivatorAction(action, []);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('#4097 §1 the population is real', () => {
  it('the DESTINATION SURFACE is non-empty and covers every receiver kind', () => {
    // §2 and §4 both iterate DESTINATION_FIELDS. An emptied or narrowed surface
    // would make §4 generate ZERO tests and §2 find ZERO fields to judge —
    // a green run that measured nothing. Pin the surface itself.
    expect(DESTINATION_FIELDS.length, 'the destination surface was emptied').toBeGreaterThanOrEqual(12);
    expect(new Set(DESTINATION_FIELDS.map((d) => d.kind))).toEqual(new Set(['email', 'webhook', 'sms', 'logicApp']));
    // Both halves of the ARM-read surface must be represented: a top-level
    // `action.*` field and a nested `action.config.*` one.
    expect(new Set(DESTINATION_FIELDS.map((d) => d.at))).toEqual(new Set(['action', 'config']));
  });

  it('enumerates activator rules from the registry (a zero population proves nothing)', async () => {
    const rules = await allBundleActivatorRules();
    expect(rules.length, 'no activator rules enumerated — the registry walk is broken, not the bundles').toBeGreaterThanOrEqual(8);
    // Every enumerated rule must actually carry an action; a rule shape this
    // walk cannot read would silently drop out of every assertion below.
    const actionless = rules.filter((r) => !r.action || typeof r.action !== 'object');
    expect(actionless.map((r) => `${r.appId}/${r.displayName}`), 'enumerated a rule with no readable action').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#4097 §2 no shipped bundle declares a destination that cannot receive', () => {
  it('every destination VALUE any bundle activator declares is one the platform can bind', async () => {
    const rules = await allBundleActivatorRules();
    const violations: string[] = [];
    for (const r of rules) {
      for (const d of rejectedDestinations(classify(r.action))) {
        violations.push(`${r.appId} / ${r.displayName} / ${r.ruleName}: ${d.path} = '${d.value}' — ${d.why}`);
      }
    }
    expect(
      violations,
      'A bundle named a place an alert is supposed to arrive, and that place does not exist.\n' +
        'The install will silently notify the installing operator instead of the destination the bundle promised.\n' +
        'Fix the bundle: either supply a value the platform can deliver to, or declare the INTENT in a\n' +
        'non-destination field (config.channel / config.webhookSecretName) and let the platform bind.\n\n' +
        violations.join('\n'),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#4097 §3 nothing a bundle declares is dropped in silence', () => {
  it('the declared-field reader actually reads (a blind one makes the check below vacuous)', () => {
    // §3's conservation check iterates whatever declaredDestinationFields()
    // returns. If that returned nothing it would find nothing missing and pass
    // while measuring nothing — so pin it against an action carrying one field
    // of every kind, at both levels.
    const declared = declaredDestinationFields({
      kind: 'x',
      recipients: ['a@contoso.com'],
      config: { url: 'https://a.contoso.com/x', phoneNumber: '+15551234567', logicAppResourceId: '/x', callbackUrl: 'https://b.contoso.com/cb', to: 'b@contoso.com' },
    });
    expect(declared).toEqual(
      expect.arrayContaining([
        'action.recipients',
        'action.config.url',
        'action.config.phoneNumber',
        'action.config.logicAppResourceId',
        'action.config.callbackUrl',
        'action.config.to',
      ]),
    );
    // …and does not hallucinate fields that are absent.
    expect(declaredDestinationFields({ kind: 'teams', config: { channel: 'Ops' } })).toEqual([]);
  });

  it('every destination field present on a bundle action gets exactly one verdict', async () => {
    const rules = await allBundleActivatorRules();
    const dropped: string[] = [];
    for (const r of rules) {
      const declared = declaredDestinationFields(r.action);
      const accounted = new Set(classify(r.action).destinations.map((d) => d.path));
      for (const path of declared) {
        if (!accounted.has(path)) dropped.push(`${r.appId} / ${r.displayName}: ${path} declared but never classified`);
      }
    }
    expect(dropped, dropped.join('\n')).toEqual([]);
  });

  it('a value of ANY type in a destination field is accounted for — not just a string', () => {
    // The shape that used to escape: `config.url` holding a non-string fell
    // through both branches, so it produced no receiver, no message, and no
    // record that the bundle had asked for one.
    for (const value of [{ href: 'https://x.test/y' }, 42, [], '', true]) {
      const norm = classify({ kind: 'webhook', config: { url: value } });
      const paths = norm.destinations.map((d) => d.path);
      expect(paths, `config.url = ${JSON.stringify(value)} vanished without a verdict`).toContain('action.config.url');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * THE EMBEDDED POSITIVE CONTROL. §2 passing over a clean population is
 * indistinguishable from §2 having stopped watching. This drives the same
 * classifier at EVERY destination field and requires each to be caught, so the
 * control's own teeth are pinned independently of what the bundles happen to
 * contain today. Parametrized over DESTINATION_FIELDS — a field added to the
 * surface is covered here automatically.
 */
describe('#4097 §4 the classifier can actually see the defect, at every field', () => {
  /** Undeliverable values, one per receiver kind. NOT a catalogue of the
   *  spellings we look for — the binder never sees this list; these are just
   *  inputs chosen to be obviously unreachable. */
  const UNDELIVERABLE: Record<string, unknown> = {
    // Reserved TLD, NO placeholder — isolates the reserved-domain clause.
    email: 'nobody@csa.invalid',
    // Placeholder at an otherwise PERFECTLY REAL host — isolates the
    // unexpanded-template clause. A probe carrying both would be caught by
    // either one, so removing one clause would still look watched.
    webhook: 'https://${unexpanded}.contoso.com/hook',
    // 'ext-9' rather than a digitless string ON PURPOSE: a digitless value is
    // rejected by ANY implementation, so it could not tell a real bound from a
    // removed one. This one carries a digit, so it discriminates — it is wired
    // as a live SMS receiver to "9" the moment the E.164 length bound is lost.
    sms: 'ext-9',
    logicApp: '${unexpanded}',
  };

  for (const d of DESTINATION_FIELDS) {
    const path = destinationPath(d.at, d.field);
    it(`rejects an undeliverable value at ${path}`, () => {
      const value = UNDELIVERABLE[d.kind];
      // The Logic App receiver needs BOTH halves present before it can be
      // judged at all; supply the partner so the field under test is the
      // variable, not the pair's completeness.
      const partner =
        d.kind === 'logicApp'
          ? d.field === 'logicAppResourceId'
            ? { callbackUrl: 'https://contoso.logic.azure.com/cb' }
            : { logicAppResourceId: '/subscriptions/s/…/workflows/wf' }
          : {};
      const action =
        d.at === 'action' ? { kind: 'email', [d.field]: value, config: {} } : { kind: 'webhook', config: { ...partner, [d.field]: value } };

      const rejected = rejectedDestinations(classify(action)).map((r) => r.path);
      expect(rejected, `${path} accepted a value that can never deliver`).toContain(path);
    });

    it(`accepts a deliverable value at ${path}`, () => {
      // The other half of the control: a classifier that rejects EVERYTHING is
      // as useless as one that rejects nothing, and would pass the test above.
      const good: Record<string, unknown> = {
        email: 'ops@contoso.com',
        webhook: 'https://contoso.webhook.office.com/webhookb2/abc',
        sms: '+15551234567',
        logicApp: d.field === 'logicAppResourceId' ? '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf' : 'https://contoso.logic.azure.com/cb',
      };
      const partner =
        d.kind === 'logicApp'
          ? d.field === 'logicAppResourceId'
            ? { callbackUrl: 'https://contoso.logic.azure.com/cb' }
            : { logicAppResourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf' }
          : {};
      const action =
        d.at === 'action'
          ? { kind: 'email', [d.field]: good[d.kind], config: {} }
          : { kind: 'webhook', config: { ...partner, [d.field]: good[d.kind] } };

      const norm = classify(action);
      const bound = norm.destinations.filter((x) => x.verdict === 'bound').map((x) => x.path);
      expect(bound, `${path} refused a value that can plainly deliver`).toContain(path);
      expect(rejectedDestinations(norm).map((r) => r.path)).not.toContain(path);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * ANTI-DRIFT. `_activator-receivers.ts` MIRRORS field lists that are
 * module-private inside `lib/azure/activator-monitor.ts`. A mirror can drift in
 * two directions and both are silent:
 *
 *   - the derivation STOPS reading a mirrored field → the binder reports a
 *     destination as bound, no fallback is applied because it thinks it bound
 *     one, and ARM receives an action group with zero receivers. §5a.
 *   - the derivation STARTS reading a field the mirror lacks → an undeliverable
 *     value is neither scrubbed nor disclosed and reaches ARM. §5b.
 *
 * Both are checked BEHAVIOURALLY against the real derivation, never by reading
 * the mirror back to itself.
 */
// ─────────────────────────────────────────────────────────────────────────────
/**
 * An INTENT the platform cannot mint (a Teams channel, a Key Vault secret
 * holding the real webhook URL) is a legitimate thing for a generic bundle to
 * declare — but the install then binds someone ELSE (the operator) in its
 * place. That substitution must never be silent, whatever the action calls
 * itself. This was keyed to `action.kind === 'teams'`, which meant the two
 * Sentinel activators — `kind: 'webhook'` with a secret reference — had their
 * intent swapped out with no word about it anywhere.
 */
describe('#4097 §4b an intent the platform cannot mint is disclosed, whatever the action kind', () => {
  for (const kind of ['teams', 'webhook', 'logicapp', undefined, '']) {
    it(`kind=${JSON.stringify(kind)} — a bare secret reference is named in the unbound list`, () => {
      const action: any = { config: { webhookSecretName: 'SENTINEL_DCE_INGESTION_URL' } };
      if (kind !== undefined) action.kind = kind;
      const norm = classify(action);
      expect(
        norm.unbound.join(' | '),
        `an action of kind ${JSON.stringify(kind)} named a destination the platform cannot mint and said nothing`,
      ).toContain('SENTINEL_DCE_INGESTION_URL');
    });
  }

  it('every shipped bundle activator that binds nothing still SAYS what it wanted', async () => {
    const rules = await allBundleActivatorRules();
    const silent: string[] = [];
    for (const r of rules) {
      const norm = classify(r.action);
      if (norm.bound.length === 0 && norm.unbound.length === 0) {
        silent.push(`${r.appId} / ${r.displayName}: binds nothing and explains nothing`);
      }
    }
    expect(silent, silent.join('\n')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#4097 §5a every mirrored destination field really does produce a receiver', () => {
  async function derive(action: any) {
    upsertActionGroup.mockClear();
    process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
    await createMonitorActivatorRule('Drift Probe', {
      name: 'drift', condition: { property: 'v', operator: '>', value: 0 }, action, sourceKind: 'log-analytics',
    } as any);
    const put = upsertActionGroup.mock.calls.at(-1)?.[0] as any;
    return {
      emails: (put?.emails || []).length,
      webhooks: (put?.webhookReceivers || []).length,
      sms: (put?.smsReceivers || []).length,
      logicApps: (put?.logicAppReceivers || []).length,
    };
  }

  const GOOD: Record<string, unknown> = {
    email: 'ops@contoso.com',
    webhook: 'https://contoso.webhook.office.com/webhookb2/abc',
    sms: '+15551234567',
    logicApp: 'x',
  };

  for (const d of DESTINATION_FIELDS) {
    const path = destinationPath(d.at, d.field);
    it(`${path} — the real Azure Monitor derivation yields a ${d.kind} receiver`, async () => {
      let action: any;
      if (d.kind === 'logicApp') {
        action = { kind: 'logicapp', config: { logicAppResourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Logic/workflows/wf', callbackUrl: 'https://contoso.logic.azure.com/cb' } };
      } else if (d.at === 'action') {
        action = { kind: 'email', [d.field]: GOOD[d.kind] };
      } else {
        action = { kind: 'webhook', config: { [d.field]: GOOD[d.kind] } };
      }

      // A LIFTED field is one the derivation does NOT read; the binder moves it
      // into a field that IS read. So the honest assertion for those is that the
      // LIFT still lands, which is the property that would break on drift.
      const effective = d.lifted ? normalizeActivatorAction(action, []).action : action;
      const got = await derive(effective);
      expect(
        got[d.kind === 'logicApp' ? 'logicApps' : d.kind === 'webhook' ? 'webhooks' : d.kind === 'sms' ? 'sms' : 'emails'],
        `the mirror lists ${path} as a ${d.kind} destination, but the real derivation produced no such receiver from it — ` +
          'lib/azure/activator-monitor.ts has drifted from the mirror in _activator-receivers.ts',
      ).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('#4097 §5b the mirror covers every field the real derivation reads', () => {
  /** The four receiver-deriving functions, read from the module's own source. */
  function derivationSource(): string {
    const p = fileURLToPath(new URL('../../../azure/activator-monitor.ts', import.meta.url));
    return readFileSync(p, 'utf8');
  }

  /** Field names the derivation reads off `action` / `cfg`, extracted from the
   *  bodies of the four rule*Receivers helpers. */
  function fieldsReadByDerivation(src: string): string[] {
    const fns = ['ruleEmails', 'ruleWebhooks', 'ruleSmsReceivers', 'ruleLogicAppReceivers'];
    const found = new Set<string>();
    for (const fn of fns) {
      const start = src.indexOf(`function ${fn}(`);
      if (start < 0) continue;
      const next = src.indexOf('\nfunction ', start + 1);
      const body = src.slice(start, next < 0 ? src.length : next);
      for (const m of body.matchAll(/\b(?:action|cfg)\??\.(?:config\??\.)?([A-Za-z_][A-Za-z0-9_]*)/g)) found.add(m[1]);
      for (const m of body.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) found.add(m[1]);
    }
    return Array.from(found);
  }

  it('the extractor actually reads the module (a silent zero would pass vacuously)', () => {
    const src = derivationSource();
    expect(src.length, 'activator-monitor.ts source not readable from the test').toBeGreaterThan(1000);
    const fields = fieldsReadByDerivation(src);
    expect(fields.length, 'extracted no field names — the helper names changed and this control stopped watching').toBeGreaterThanOrEqual(8);
    // Pin the extractor to something it MUST find, so a regex that silently
    // stops matching is caught rather than reported as "nothing to check".
    expect(fields).toContain('recipients');
    expect(fields).toContain('serviceUri');
  });

  it('any extracted field that CHANGES what the derivation emits is mirrored', async () => {
    const src = derivationSource();
    const mirrored = new Set(DESTINATION_FIELDS.map((d) => d.field));
    const candidates = fieldsReadByDerivation(src).filter((f) => !mirrored.has(f));

    // For each unmirrored name the derivation mentions, ask the ONLY question
    // that matters: does putting a value there change what ARM receives? If it
    // does, it is a destination and the mirror is missing it. If it does not,
    // it is a modifier (`countryCode`) or an unrelated token and is correctly
    // absent — no exclusion list to stuff.
    const probes = ['ops@contoso.com', 'https://contoso.webhook.office.com/webhookb2/abc', '+15551234567'];
    const missing: string[] = [];
    for (const field of candidates) {
      for (const probe of probes) {
        for (const at of ['action', 'config'] as const) {
          upsertActionGroup.mockClear();
          process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID = LA;
          const action: any = at === 'action' ? { kind: 'x', [field]: probe, config: {} } : { kind: 'x', config: { [field]: probe } };
          await createMonitorActivatorRule('Drift Probe', {
            name: 'drift', condition: { property: 'v', operator: '>', value: 0 }, action, sourceKind: 'log-analytics',
          } as any);
          const put = upsertActionGroup.mock.calls.at(-1)?.[0] as any;
          const n = (put?.emails || []).length + (put?.webhookReceivers || []).length + (put?.smsReceivers || []).length + (put?.logicAppReceivers || []).length;
          if (n > 0) missing.push(`${at === 'action' ? 'action' : 'action.config'}.${field} (probe '${probe}')`);
        }
      }
    }
    expect(
      Array.from(new Set(missing)),
      'lib/azure/activator-monitor.ts now derives a receiver from a field the mirror in\n' +
        '_activator-receivers.ts does not list, so a value there is neither scrubbed nor disclosed:\n' +
        Array.from(new Set(missing)).join('\n'),
    ).toEqual([]);
  });
});
