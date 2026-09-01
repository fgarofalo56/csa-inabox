/**
 * NO CONTROL ON THIS SURFACE CAN MUTATE AZURE.
 *
 * PRP §1 decision 1 makes the Brain recommend-only, and the reason is measured
 * blast radius: of the Container App environments visible across these
 * subscriptions, most are NOT Loom's — the operator's blog, Sentinel, two Atlas
 * estates, and more. An autonomous mutation on a wrong ownership inference
 * destroys someone else's production.
 *
 * "Recommend-only" is easy to claim and easy to lose. Someone adds an "Apply"
 * button in six months, it looks helpful, and review does not catch it because
 * nothing fails. So it is asserted THREE ways, each of which fails
 * independently:
 *
 *   A. BEHAVIOURAL — render the surface with real findings, click EVERY control,
 *      and assert that the only network call any of them makes is the review
 *      POST, and that its body carries no imperative verb.
 *   B. LABELS — enumerate every rendered button and fail on any mutation verb
 *      in its accessible name. An "Apply" that is added later trips this even
 *      if nobody wires it up yet.
 *   C. SOURCE — scan the Brain's own modules for an ARM write. This one carries
 *      an EMBEDDED CONTROL: the same scanner is run over a synthetic violation
 *      and must flag it. A source scanner with nothing to find is green and
 *      blind, which is the single most repeated failure in this repo.
 *
 * (C) exists because (A) and (B) only see what is rendered. A mutation reachable
 * from a keyboard shortcut, an effect, or a route the UI does not link would
 * pass both.
 *
 * ── RESCOPE, #4242 (explicit contract amendment, not an evasion) ───────────
 * Execution now exists — behind the SEPARATE perform route this repo's own
 * doc-blocks always said it would live behind. The contract this file asserts
 * is therefore, precisely:
 *
 *   1. NO MUTATION CONTROL ON AN UNGUARDED FINDING: the review surface itself
 *      still renders no Apply/Delete/Scale control and still reaches only the
 *      review POST (the walks in A and B are UNCHANGED — they must stay green
 *      as-is until the guarded Perform UI lands with its own controls and its
 *      own tests).
 *   2. THE PERFORM POST IS THE ONLY MUTATION PATH: the executors live in
 *      `lib/brain-actions/**` — DELIBERATELY outside `lib/brain` and outside
 *      the roots scanned below, so the Brain's own tree stays honestly
 *      write-free — and the perform route in the scanned tree DELEGATES to
 *      them, carrying no inline Azure verb, behind server-re-derived guards
 *      (fresh snapshot, complete collection, fresh ownership tag read,
 *      non-vacuous detector, fresh ARM GET, staged two-step confirm).
 *
 * The P4 type invariants (`_ProposalsCannotSelfApprove` / `_ProposalsCannotMutate`)
 * and `assertInertRemediation` are untouched: a FINDING still cannot be an
 * action. Performing is a separate record about a finding, never a field on one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { Recommendations } from '@/app/admin/brain/recommendations';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import { collection } from './estate-fixture';

const snapshot = snapshotFromCollection(collection());

function wrap(ui: ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

// ---------------------------------------------------------------------------
// A + B — the rendered surface
// ---------------------------------------------------------------------------

/**
 * Verbs that would indicate a control does something to Azure.
 *
 * `Copy` and `Show on graph` are deliberately NOT here: copying a proposed diff
 * to the clipboard and panning a canvas are not mutations. `Refresh` is not
 * here either — it re-reads.
 */
const MUTATION_VERBS = [
  'apply',
  'execute',
  'run now',
  'delete',
  'remove',
  'scale',
  'stop',
  'start',
  'restart',
  'deploy',
  'provision',
  'destroy',
  'terminate',
  'fix it',
  'remediate',
];

describe('B — no rendered control carries a mutation verb', () => {
  it('the fixture rendered findings (otherwise this scan is vacuous)', () => {
    expect(snapshot.findings.length).toBeGreaterThan(0);
  });

  it('enumerates every interactive control and finds no mutation verb', () => {
    const { container } = wrap(
      <Recommendations findings={snapshot.findings} onFocusNode={() => {}} />,
    );

    // NOT just `getAllByRole('button')`. A mutation control added as a link, a
    // submit input, or a menu item would pass a button-only scan — and "add it
    // as an <a>" is exactly the narrow evasion that gets through a guard scoped
    // to one element type. Query the DOM for every interactive element instead.
    const controls = Array.from(
      container.querySelectorAll(
        'button, a[href], input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="menuitem"]',
      ),
    );

    // POPULATION: if this were 0 the scan would pass having examined nothing.
    expect(controls.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const c of controls) {
      const label = `${c.textContent ?? ''} ${c.getAttribute('aria-label') ?? ''} ${
        c.getAttribute('href') ?? ''
      }`.toLowerCase();
      for (const verb of MUTATION_VERBS) {
        if (label.includes(verb)) offenders.push(`${label.trim().slice(0, 80)} (matched '${verb}')`);
      }
    }
    expect(offenders, `mutation-verb control(s) on the Brain surface: ${offenders.join('; ')}`)
      .toEqual([]);
  });

  it('there are no forms that could POST anywhere', () => {
    // A <form action=...> needs no button label at all and would evade the scan
    // above entirely.
    const { container } = wrap(
      <Recommendations findings={snapshot.findings} onFocusNode={() => {}} />,
    );
    const forms = Array.from(container.querySelectorAll('form[action]'));
    expect(forms.map((f) => f.getAttribute('action'))).toEqual([]);
  });

  it('THE CONTROL FOR THIS SCAN: the same matcher flags a synthetic Apply button', () => {
    // Without this, a matcher with a typo'd verb list would report a clean
    // surface forever and nothing would say so.
    const label = 'apply change'.toLowerCase();
    expect(MUTATION_VERBS.some((v) => label.includes(v))).toBe(true);
  });

  it('renders the recommend-only banner so the guarantee is stated to the operator', () => {
    wrap(<Recommendations findings={snapshot.findings} onFocusNode={() => {}} />);
    expect(screen.getByTestId('recommend-only-banner').textContent).toContain(
      'Nothing on this page changes anything in Azure',
    );
  });
});

describe('A — the control walk makes no mutating call', () => {
  it('Approve reaches ONLY the review endpoint, with a review decision', async () => {
    const calls: Array<{ id: string; decision: string }> = [];
    const owned = snapshot.findings.filter((f) => f.ownershipConfirmed);
    const findings = owned.length > 0 ? owned : snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));

    wrap(
      <Recommendations
        findings={findings}
        onFocusNode={() => {}}
        submitDecision={async (id, decision) => {
          calls.push({ id, decision });
          return { ok: true };
        }}
      />,
    );

    const approve = screen.getAllByTestId('approve');
    expect(approve.length).toBeGreaterThan(0);
    fireEvent.click(approve[0]!);

    await waitFor(() => expect(calls.length).toBe(1));
    // The ONLY verb the surface can send. `apply`/`execute` are rejected at the
    // route (asserted in authz-mutation.test.ts) and unreachable from here.
    expect(['approved', 'dismissed']).toContain(calls[0]!.decision);
  });

  it('after a decision the surface says nothing in Azure changed', async () => {
    const findings = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));
    wrap(
      <Recommendations
        findings={findings}
        onFocusNode={() => {}}
        submitDecision={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(screen.getAllByTestId('approve')[0]!);
    await waitFor(() => {
      expect(screen.getAllByTestId('decision-recorded')[0]!.textContent).toContain(
        'Nothing in Azure was changed',
      );
    });
  });

  it('a finding with UNESTABLISHED ownership offers no approve control at all', () => {
    const unowned = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: false }));
    wrap(<Recommendations findings={unowned} onFocusNode={() => {}} />);
    // Reported — reports cover all subscriptions...
    expect(screen.getAllByTestId('finding-card').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('ownership-withheld').length).toBeGreaterThan(0);
    // ...but not approvable.
    expect(screen.queryAllByTestId('approve')).toHaveLength(0);
    expect(screen.queryAllByTestId('dismiss')).toHaveLength(0);
  });

  it('the proposed change is rendered as TEXT to copy, never executed', () => {
    const findings = snapshot.findings.map((f) => ({ ...f, ownershipConfirmed: true }));
    wrap(<Recommendations findings={findings} onFocusNode={() => {}} />);

    // The proposal is VISIBLE BY DEFAULT (#4241 defect 10) — no expansion
    // needed. This is itself an assertion: a card whose actual proposed change
    // is hidden behind a drawer is the hierarchy defect that shipped.
    const pres = screen.getAllByTestId('proposed-change');
    expect(pres.length).toBeGreaterThan(0);
    // It is a <pre>, not a form action, an href, or a button.
    expect(pres[0]!.tagName.toLowerCase()).toBe('pre');

    // The accordion header still exists and says the change is NOT applied.
    const headers = screen.getAllByRole('button', { name: /Proposed change/i });
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]!.textContent).toContain('not applied');

    // Evidence is still collapsed by default — expand it, so the behavioral
    // walk keeps one accordion toggle and confirms the toggle renders text
    // rather than doing anything.
    const evidence = screen.getAllByRole('button', { name: /Evidence/i });
    expect(evidence.length).toBeGreaterThan(0);
    fireEvent.click(evidence[0]!);
    expect(screen.getAllByText(/What the code established/).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C — the source scan, with its embedded control
// ---------------------------------------------------------------------------

/**
 * An ARM write, as it would actually appear.
 *
 * ── A WEAKNESS THIS SCANNER HAD, AND HOW IT WAS FOUND ──────────────────────
 * The first version keyed on `method: 'X'` FOLLOWED BY an ARM path. It reported
 * the Brain clean — correctly, but by accident: the one real Azure call in the
 * tree (`arg-collect.ts`) writes the URL FIRST and the method second, so the
 * pattern simply never reached it. A violation written in that same, entirely
 * ordinary order would have been invisible.
 *
 * Passing is not evidence when the pattern cannot see the code. So the rules
 * below are ORDER-INDEPENDENT, and the genuinely-mutating verbs (PUT / PATCH /
 * DELETE) are banned outright rather than only near an ARM path — there is no
 * legitimate reason for any of them to appear in a read-only analysis surface.
 *
 * POST needs a narrower rule because two legitimate POSTs exist: the Resource
 * Graph QUERY endpoint (POST is how ARG accepts a query; the endpoint has no
 * mutating operation) and the Brain's own review-decision route. Both are
 * named explicitly, so adding a third POST anywhere trips this.
 */
interface MutationRule {
  readonly name: string;
  readonly find: (src: string) => boolean;
}

const MUTATING_VERB = /method:\s*['"`](PUT|PATCH|DELETE)['"`]/i;
const POST_CALL = /method:\s*['"`]POST['"`]/i;
const POST_CALL_G = /method:\s*['"`]POST['"`]/gi;
const ALLOWED_POST_TARGETS = [
  'providers/Microsoft.ResourceGraph/resources', // ARG query API — no mutating op
  '/api/admin/brain/proposals', // the Brain's own review-decision route
  // #4242 — THE ONE SANCTIONED MUTATION PATH. Guarded by the four-layer design:
  // the executors live in lib/brain-actions/** (outside lib/brain and outside
  // this scan's roots), the route delegates (asserted below — it carries no
  // inline ARM verb), every guard is re-derived server-side at execute time,
  // and destructive classes stage a two-step confirm. A client POSTing here is
  // invoking that guarded path, not writing to Azure itself.
  '/api/admin/brain/perform',
];

/**
 * The POST rule is bound to the CALL SITE, not the file (#4246 review — a
 * measured bypass). The first version tested `src.includes(target)` over the
 * WHOLE file, so any file whose doc-block happened to contain an allow-token
 * (the perform route's header literally names `/api/admin/brain/perform`)
 * could carry an unrelated inline ARM POST-*action* — `…/containerApps/x/
 * restart`, `…/start`, `…/stop` are all POSTs — and stay green.
 *
 * Now the allowed target must appear WITHIN THE SAME CALL as the `method:
 * 'POST'` key: a 400-chars-back / 200-forwards window around the match, sized
 * from the real shapes in this tree (arg-collect.ts writes the URL ~100 chars
 * before the method; the review-route fetches are single-line). A doc-block
 * token elsewhere in the file no longer launders anything. The window is an
 * approximation of "same statement" — its own control below proves a
 * far-token + POST pair goes red.
 */
function postCallsOutsideAllowedTargets(src: string): number {
  let offenders = 0;
  for (const m of src.matchAll(POST_CALL_G)) {
    const at = m.index ?? 0;
    const window = src.slice(Math.max(0, at - 400), at + 200);
    if (!ALLOWED_POST_TARGETS.some((t) => window.includes(t))) offenders += 1;
  }
  return offenders;
}

const MUTATION_RULES: readonly MutationRule[] = [
  {
    name: 'mutating HTTP verb (PUT/PATCH/DELETE)',
    // Order-independent by construction: it does not care what is near it.
    find: (src) => MUTATING_VERB.test(src),
  },
  {
    name: 'POST whose own call site names no allowed target',
    // POST_CALL is the cheap pre-filter; the per-call window does the work.
    find: (src) => POST_CALL.test(src) && postCallsOutsideAllowedTargets(src) > 0,
  },
  {
    name: 'az CLI mutation',
    find: (src) => /\baz\s+(containerapp|resource|group|webapp)\s+(update|delete|create|scale|stop|start)\b/i.test(src),
  },
  {
    name: 'ARM write helper',
    find: (src) => /\barm(Put|Patch|Delete|Post)\s*\(/.test(src),
  },
  {
    name: 'Azure SDK mutation call',
    find: (src) => /\.(beginCreateOrUpdate|beginDelete|createOrUpdate|deleteMethod)\s*\(/.test(src),
  },
];

function scanForMutations(source: string): string[] {
  return MUTATION_RULES.filter((r) => r.find(source)).map((r) => r.name);
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('C — the Brain source contains no Azure write', () => {
  const roots = [
    join(process.cwd(), 'app', 'admin', 'brain'),
    join(process.cwd(), 'app', 'api', 'admin', 'brain'),
  ];
  const files = roots.flatMap((r) => collectFiles(r));

  it('THE CONTROL: the scanner flags a synthetic ARM write, in EITHER order', () => {
    // This runs FIRST on purpose. A scanner over a clean tree returns [] whether
    // it works or not; this is the only evidence that a real violation would be
    // caught. Every rule gets its own synthetic violation, so one broken rule is
    // visible rather than masked by the others.
    expect(scanForMutations(`await fetch(url, { method: 'DELETE' })`)).not.toEqual([]);
    expect(scanForMutations(`await fetch(url, { method: 'PATCH' })`)).not.toEqual([]);
    expect(scanForMutations(`await exec('az containerapp update --min-replicas 0')`)).not.toEqual([]);
    expect(scanForMutations(`await armPut(id, body)`)).not.toEqual([]);
    expect(scanForMutations(`await client.beginCreateOrUpdate(rg, name, body)`)).not.toEqual([]);
    expect(scanForMutations(`await fetch('https://x/api/scale', { method: 'POST' })`)).not.toEqual([]);
  });

  it('ORDER INDEPENDENCE: a write with the URL written first is still caught', () => {
    // The bug the first version of this scanner had. `arg-collect.ts` writes the
    // URL first and the method second — an entirely ordinary style — and the
    // original `method-then-path` pattern could not see that shape at all. It
    // reported the Brain clean for the wrong reason.
    const urlFirst = `
      const res = await doFetch(
        \`\${base}/subscriptions/x/providers/Microsoft.App/containerApps/y?api-version=2024-03-01\`,
        { method: 'PATCH', body: JSON.stringify({ properties: {} }) },
      );`;
    expect(scanForMutations(urlFirst)).not.toEqual([]);
  });

  it('THE CONTROL for the call-site binding: a doc-block allow-token does NOT launder a distant POST', () => {
    // The reviewer's measured bypass on #4246: perform/route.ts's header
    // legitimately names /api/admin/brain/perform, and under the old
    // file-scoped rule that token exempted an inline ARM POST-action appended
    // hundreds of lines later. Reconstruct exactly that shape — allow-token
    // far away, ARM restart POST at the end — and require it flagged.
    const probe =
      `// BFF — POST /api/admin/brain/perform — delegates to lib/brain-actions\n` +
      `${'// padding line to separate the doc-block from the call site\n'.repeat(12)}` +
      `const r = await doFetch(\n` +
      `  \`\${base}/subscriptions/x/resourceGroups/y/providers/Microsoft.App/containerApps/z/restart?api-version=2024-03-01\`,\n` +
      `  { method: 'POST' },\n` +
      `);`;
    expect(scanForMutations(probe)).not.toEqual([]);
    // And the pre-filter alone would have passed it — the window is what bites.
    expect(ALLOWED_POST_TARGETS.some((t) => probe.includes(t))).toBe(true);
  });

  it('and does NOT flag the two legitimate POSTs', () => {
    // A scanner that flags everything is as useless as one that flags nothing.
    expect(
      scanForMutations(
        `await doFetch(\`\${base}/providers/Microsoft.ResourceGraph/resources\`, { method: 'POST' })`,
      ),
    ).toEqual([]);
    expect(
      scanForMutations(`await fetch('/api/admin/brain/proposals', { method: 'POST' })`),
    ).toEqual([]);
  });

  it('examined a non-empty set of Brain source files', () => {
    // POPULATION. A scan over zero files is green and blind.
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('finds no mutation in any Brain module', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const hits = scanForMutations(readFileSync(f, 'utf8'));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join(', ')}`);
    }
    expect(offenders, `Azure write found in the Brain: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('#4242: the perform route is IN the walked set and carries NO inline Azure verb', () => {
    // The perform route is the one sanctioned mutation path, and the contract
    // is that it DELEGATES: its executors live in lib/brain-actions/**,
    // deliberately outside these roots and outside lib/brain, behind the
    // server-re-derived guard chain. If someone inlines an ARM write into the
    // route file itself, the walk above goes red — this spec additionally
    // proves the file is actually in the walked population (a route that moved
    // out of the scanned roots would otherwise pass silently) and that it
    // still imports the guarded orchestrator rather than an ARM client.
    const performRoute = files.find((f) =>
      f.includes(join('api', 'admin', 'brain', 'perform', 'route.ts')),
    );
    expect(performRoute, 'perform/route.ts must be inside the scanned roots').toBeDefined();
    const src = readFileSync(performRoute!, 'utf8');
    expect(scanForMutations(src)).toEqual([]);
    expect(src).toContain("@/lib/brain-actions/perform");
  });

  it('the only Azure call in the Brain is the Resource Graph QUERY', () => {
    const arg = readFileSync(
      join(process.cwd(), 'app', 'api', 'admin', 'brain', '_lib', 'arg-collect.ts'),
      'utf8',
    );
    // It IS a POST — Resource Graph's query endpoint is POST — so the shape
    // check above cannot distinguish it from a write by method alone. The
    // distinguishing fact is the PATH: /providers/Microsoft.ResourceGraph/resources
    // is a query API with no mutating operation.
    expect(arg).toContain('providers/Microsoft.ResourceGraph/resources');
    expect(arg).not.toMatch(/method:\s*['"`](PUT|PATCH|DELETE)['"`]/);
  });
});

describe('P4 — a proposal cannot declare itself an action', () => {
  it('every remediation pins requiresHumanApproval and mutatesAzure', () => {
    expect(snapshot.findings.length).toBeGreaterThan(0);
    for (const f of snapshot.findings) {
      expect(f.remediation.kind).toBe('proposal');
      expect(f.remediation.requiresHumanApproval).toBe(true);
      expect(f.remediation.mutatesAzure).toBe(false);
    }
  });
});
