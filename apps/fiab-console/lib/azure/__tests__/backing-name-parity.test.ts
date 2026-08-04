/**
 * BACKING-NAME PARITY — the install-time provisioner and the open-time
 * auto-bind provider must compute the SAME Azure name for the same Loom item.
 *
 * WHY THIS IS A CORRECTNESS TEST, NOT A STYLE TEST
 * ------------------------------------------------
 * Auto-bind's step 5 is "probe the target name; attach if present, create if
 * absent". If the auto-bind provider's name differs by even one character from
 * the name the installer's provisioner used, the probe misses the installer's
 * object and auto-bind CREATES A DUPLICATE beside it — two ADF pipelines, two
 * ADX databases, two Event Hubs, two lakehouse roots, with the Loom item
 * silently pointed at the empty one. Before this change five independent copies
 * of those mappings existed (adf-pipeline.ts, synapse-pipeline.ts, kql-db.ts,
 * eventstream-standup.ts, lakehouse.ts), so the divergence was one careless edit
 * away.
 *
 * The fix is structural: every call site now goes through the SAME function in
 * `lib/azure/backing-name`. These tests assert the mapping's OBSERVABLE
 * properties against literal expected strings computed by hand from the Azure
 * naming rules — not against a re-implementation of the function under test,
 * which would only prove the code equals itself.
 *
 * The historical inputs below are the ones that actually distinguish the
 * variants: run-collapsing vs single-character replacement, edge trimming vs
 * none, path-shaped vs name-shaped, and the differing fallback strings.
 *
 * MUTATION PROOF (2026-08-04) — these guards were verified by re-introducing
 * the exact divergences they exist to stop:
 *
 *   d) Replace `lakehouseAutoBind.backingNameFor`'s `lakehouseRootPath(...)`
 *      call with a plausible-looking inline charset sanitizer
 *      (`'lakehouses/' + displayName.replace(/[^A-Za-z0-9._-]+/g,'-')`). 1 RED:
 *      "the AUTO-BIND provider computes the installer's root, not a look-alike"
 *      — which is precisely the duplicate-root bug, since that expression maps
 *      "Demo lakehouse" to `Demo-lakehouse` while the installer wrote
 *      `Demo lakehouse`.
 *   e) Replace `pipelineBackend`'s `DEFAULT_PIPELINE_RUNTIME`-derived fallback
 *      with a literal `'synapse'`. 2 RED:
 *      "a slug-less data-pipeline binds the editor's DEFAULT_PIPELINE_RUNTIME
 *       backend" and "LOOM_PIPELINE_BACKEND=fabric never selects a Fabric
 *       backing" — i.e. the create path would provision into Synapse while the
 *      editor talks to ADF.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeBackingName,
  safePipelineName,
  safeAdxDatabaseName,
  safeAdlsRelPath,
  lakehouseRootPath,
  PIPELINE_NAME_RULES,
  EVENT_HUB_NAME_RULES,
  ADX_DATABASE_NAME_RULES,
} from '@/lib/azure/backing-name';
import { safeHubName } from '@/lib/azure/eventstream-standup';
import { lakehouseAutoBind, AUTO_BIND_PROVIDERS } from '@/lib/azure/auto-bind-providers';
import type { AutoBindContext } from '@/lib/azure/auto-bind';
import { DEFAULT_PIPELINE_RUNTIME } from '@/lib/components/pipeline/types';

describe('pipeline names — the historical safePipelineName behaviour, preserved', () => {
  it.each([
    // [displayName, expected]
    ['orders', 'orders'],
    ['ingest_orders', 'ingest_orders'],
    ['ingest-orders', 'ingest-orders'],
    // Runs of disallowed characters COLLAPSE to one '-' (the `+` quantifier).
    ['Daily Orders → Bronze', 'Daily-Orders-Bronze'],
    ['a   b', 'a-b'],
    // Leading/trailing replacement characters are trimmed.
    ['  orders  ', 'orders'],
    ['...orders...', 'orders'],
    // Case is preserved (ADF pipeline names are case-sensitive).
    ['Orders', 'Orders'],
  ])('safePipelineName(%j) === %j', (input, expected) => {
    expect(safePipelineName(input, 'loom-adf-pipeline')).toBe(expected);
  });

  it('truncates at 140 and does not leave a trailing separator', () => {
    const name = safePipelineName(`${'a'.repeat(139)} tail`, 'loom-adf-pipeline');
    expect(name.length).toBeLessThanOrEqual(140);
    expect(name.endsWith('-')).toBe(false);
  });

  it('preserves each provisioner’s OWN fallback for an unsanitizable name', () => {
    // This is the reason the fallback is a parameter rather than baked into the
    // shared rule object: the two provisioners shipped different strings, and
    // unifying them would have renamed an existing object.
    expect(safePipelineName('###', 'loom-adf-pipeline')).toBe('loom-adf-pipeline');
    expect(safePipelineName('###', 'loom-synapse-pipeline')).toBe('loom-synapse-pipeline');
  });

  it('matches the bind route’s NAME_RE, so an auto-bound name is also hand-bindable', () => {
    const NAME_RE = /^[A-Za-z0-9_-]{1,140}$/;
    for (const input of ['orders', 'Daily Orders → Bronze', '  spaced  ', 'ünïcødé', '###']) {
      expect(NAME_RE.test(safePipelineName(input, 'loom-adf-pipeline'))).toBe(true);
    }
  });
});

describe('ADX database names — the historical kql-db behaviour, preserved', () => {
  it.each([
    ['orders', 'orders'],
    // SINGLE-character replacement (no `+`): "a  b" → "a__b", NOT "a_b".
    // This quirk is load-bearing — every database the installer already created
    // carries it, so "fixing" it would orphan them.
    ['a  b', 'a__b'],
    ['Daily Orders', 'Daily_Orders'],
    // NO edge trimming: a leading disallowed char becomes a leading '_'.
    [' orders', '_orders'],
    ['orders ', 'orders_'],
  ])('safeAdxDatabaseName(%j) === %j', (input, expected) => {
    expect(safeAdxDatabaseName(input)).toBe(expected);
  });

  it('truncates at 50 and falls back to loomdb', () => {
    expect(safeAdxDatabaseName('x'.repeat(80))).toHaveLength(50);
    expect(safeAdxDatabaseName('')).toBe('loomdb');
  });
});

describe('Event Hub names — eventstream-standup and auto-bind are ONE function', () => {
  it.each([
    ['orders', 'orders'],
    ['Daily Orders', 'daily-orders'],   // lower-cased
    ['a   b', 'a-b'],                   // runs collapse
    ['  orders  ', 'orders'],           // edges trimmed
  ])('safeHubName(%j) === %j', (input, expected) => {
    expect(safeHubName(input)).toBe(expected);
  });

  it('safeHubName IS the shared mapping — not a look-alike copy', () => {
    // Property-style: for a spread of inputs, the exported provisioner helper
    // and the shared rule must agree. If someone re-inlines a local copy in
    // eventstream-standup, this goes red.
    for (const input of ['orders', 'Daily Orders → Bronze', '', '###', 'A'.repeat(300), 'Ünïcødé Hub']) {
      expect(safeHubName(input)).toBe(sanitizeBackingName(input, EVENT_HUB_NAME_RULES).name);
    }
  });

  it('falls back to loom-eventstream and truncates at 200', () => {
    expect(safeHubName('###')).toBe('loom-eventstream');
    expect(safeHubName('a'.repeat(300))).toHaveLength(200);
  });
});

describe('lakehouse roots — a displayName cannot escape the lakehouses/ prefix', () => {
  it.each([
    // [displayName, expected relative path]
    // Spaces SURVIVE — ADLS permits them and the installer has always kept
    // them, so flattening them here would compute a different root.
    ['Demo lakehouse', 'Demo lakehouse'],
    // A multi-segment name stays multi-segment (again: installer behaviour).
    ['a/b/c', 'a/b/c'],
    // Backslashes normalise to the ADLS separator.
    ['a\\b', 'a/b'],
    // Traversal segments are DROPPED, not escaped — this is the containment
    // guarantee, and it is structural rather than charset-based.
    ['../../etc/passwd', 'etc/passwd'],
    ['a/../b', 'a/b'],
    ['./a', 'a'],
    // Nothing nameable left → empty, which lakehouseRootPath replaces with the
    // item id rather than collapsing onto a shared directory.
    ['..', ''],
    ['/', ''],
    ['', ''],
  ])('safeAdlsRelPath(%j) === %j', (input, expected) => {
    const rel = safeAdlsRelPath(input);
    expect(rel).toBe(expected);
    // No segment of the result can walk up out of `lakehouses/`.
    expect(rel.split('/').every((s) => s !== '.' && s !== '..')).toBe(true);
    expect(rel.startsWith('/')).toBe(false);
    expect(rel.endsWith('/')).toBe(false);
  });

  it('an unnameable lakehouse falls back to its item id, never to a shared root', () => {
    expect(lakehouseRootPath('..', 'item-guid')).toBe('lakehouses/item-guid');
    expect(lakehouseRootPath('', 'item-guid')).toBe('lakehouses/item-guid');
    // Two different unnameable lakehouses do NOT collide.
    expect(lakehouseRootPath('..', 'a')).not.toBe(lakehouseRootPath('..', 'b'));
  });

  it('the root always stays under the lakehouses/ prefix', () => {
    for (const input of ['../../etc/passwd', '..', '/', '\\..\\..', 'Demo lakehouse', '  ..  ']) {
      const root = lakehouseRootPath(input, 'item-guid');
      expect(root.startsWith('lakehouses/')).toBe(true);
      // Resolve the path the way a filesystem would: no segment may pop out.
      let depth = 0;
      for (const seg of root.split('/')) {
        if (seg === '..') depth--;
        else if (seg && seg !== '.') depth++;
        expect(depth).toBeGreaterThan(-1);
      }
    }
  });

  it('the AUTO-BIND provider computes the installer’s root, not a look-alike', () => {
    // The parity that matters: `lakehouse.ts` builds its root with
    // `lakehouseRootPath(displayName, cosmosItemId)`. If the provider ever
    // stops calling the same function, an installed lakehouse gets a SECOND
    // root on first open and the editor lands on the empty one.
    for (const displayName of ['Demo lakehouse', 'a/b/c', '../../etc/passwd', '..', 'Ünïcødé Lake']) {
      const ctx = {
        itemId: 'item-guid',
        itemType: 'lakehouse',
        displayName,
        workspaceId: 'ws-1',
        state: {},
      };
      expect(lakehouseAutoBind.backingNameFor(ctx).name)
        .toBe(lakehouseRootPath(displayName, 'item-guid'));
    }
  });
});

describe('pipeline backend — the CREATE path must pick the backend the EDITOR opens', () => {
  /**
   * The other half of the duplicate-object hazard, and one the name mappings
   * cannot catch. `POST /api/workspaces/<id>/items` auto-binds with NO route
   * slug, so the provider registry has to guess a backend. A `data-pipeline`
   * item then OPENS `DataPipelineEditor`, which starts on
   * `DEFAULT_PIPELINE_RUNTIME` ('adf') and delegates to `AdfPipelineEditor`.
   *
   * If create guessed Synapse, the item would be born with a Synapse pipeline
   * while its editor talks exclusively to ADF — an empty canvas plus an orphan
   * object in the other service. That is the exact #2942 symptom, arrived at
   * from a different direction, so it is asserted here rather than left to a
   * comment.
   */
  const ctx = (over: Partial<AutoBindContext> = {}): AutoBindContext => ({
    itemId: 'item-1', itemType: 'data-pipeline', displayName: 'orders', workspaceId: 'ws-1', state: {}, ...over,
  });

  const claimsOf = (c: AutoBindContext) =>
    AUTO_BIND_PROVIDERS.filter((p) => p.itemTypes.includes(c.itemType) && p.claims?.(c) === true)
      .map((p) => p.provider);

  const withEnv = <T,>(value: string | undefined, fn: () => T): T => {
    const prev = process.env.LOOM_PIPELINE_BACKEND;
    if (value === undefined) delete process.env.LOOM_PIPELINE_BACKEND;
    else process.env.LOOM_PIPELINE_BACKEND = value;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.LOOM_PIPELINE_BACKEND;
      else process.env.LOOM_PIPELINE_BACKEND = prev;
    }
  };

  it('a slug-less data-pipeline binds the editor’s DEFAULT_PIPELINE_RUNTIME backend', () => {
    withEnv(undefined, () => {
      expect(claimsOf(ctx())).toEqual([`${DEFAULT_PIPELINE_RUNTIME}-pipeline`]);
    });
  });

  it('the route slug still wins over the create-time default', () => {
    withEnv(undefined, () => {
      expect(claimsOf(ctx({ slugHint: 'adf-pipeline' }))).toEqual(['adf-pipeline']);
      expect(claimsOf(ctx({ slugHint: 'synapse-pipeline' }))).toEqual(['synapse-pipeline']);
    });
  });

  it('LOOM_PIPELINE_BACKEND overrides the create-time default', () => {
    withEnv('synapse', () => expect(claimsOf(ctx())).toEqual(['synapse-pipeline']));
    withEnv('adf', () => expect(claimsOf(ctx())).toEqual(['adf-pipeline']));
  });

  it('LOOM_PIPELINE_BACKEND=fabric never selects a Fabric backing (no-fabric-dependency)', () => {
    withEnv('fabric', () => {
      // Falls through to the Azure-native default rather than gating.
      expect(claimsOf(ctx())).toEqual([`${DEFAULT_PIPELINE_RUNTIME}-pipeline`]);
    });
  });

  it('EXACTLY ONE provider ever claims a data-pipeline — never two, never none', () => {
    for (const env of [undefined, 'adf', 'synapse', 'fabric', 'nonsense']) {
      withEnv(env, () => {
        for (const slug of [undefined, 'adf-pipeline', 'synapse-pipeline']) {
          expect(claimsOf(ctx({ slugHint: slug }))).toHaveLength(1);
        }
      });
    }
  });
});

describe('sanitizeBackingName — the determinism contract', () => {
  const rulesets = [
    ['pipeline', PIPELINE_NAME_RULES],
    ['event hub', EVENT_HUB_NAME_RULES],
    ['adx database', ADX_DATABASE_NAME_RULES],
  ] as const;

  const inputs = ['orders', 'Daily Orders → Bronze', '', '###', '  padded  ', 'a'.repeat(500), 'Ünïcødé'];

  it.each(rulesets)('%s: same input → same output, every time', (_label, rules) => {
    for (const input of inputs) {
      const a = sanitizeBackingName(input, rules);
      const b = sanitizeBackingName(input, rules);
      expect(b).toEqual(a);
    }
  });

  it.each(rulesets)('%s: never exceeds the service length limit', (_label, rules) => {
    for (const input of inputs) {
      expect(sanitizeBackingName(input, rules).name.length).toBeLessThanOrEqual(rules.maxLength);
    }
  });

  it.each(rulesets)('%s: never returns an empty name', (_label, rules) => {
    for (const input of inputs) {
      expect(sanitizeBackingName(input, rules).name.length).toBeGreaterThan(0);
    }
  });

  it('reports `sanitized` iff the name actually changed', () => {
    expect(sanitizeBackingName('orders', PIPELINE_NAME_RULES).sanitized).toBe(false);
    expect(sanitizeBackingName('Daily Orders', PIPELINE_NAME_RULES).sanitized).toBe(true);
  });

  it('reports `usedFallback` only when sanitization emptied the name', () => {
    expect(sanitizeBackingName('orders', PIPELINE_NAME_RULES).usedFallback).toBe(false);
    expect(sanitizeBackingName('###', PIPELINE_NAME_RULES).usedFallback).toBe(true);
  });

  it('tolerates a non-string displayName rather than throwing', () => {
    // `WorkspaceItem.displayName` is typed string, but Cosmos documents are not
    // schema-enforced and this runs on every item open.
    expect(sanitizeBackingName(undefined as unknown as string, PIPELINE_NAME_RULES).name)
      .toBe(PIPELINE_NAME_RULES.fallback);
  });
});
