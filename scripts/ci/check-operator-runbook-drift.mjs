#!/usr/bin/env node
/**
 * GUARDRAIL: operator-runbook-drift  (merge-blocker)
 * ---------------------------------------------------------------------------
 * RULE (#3375): `docs/fiab/operator-interactive-setup.md` must not instruct the
 *   operator to perform an action the PLATFORM already performs.
 *
 * WHY THIS EXISTS
 *
 *   The runbook told operators to click three things that were, by then, either
 *   automated or unnecessary:
 *
 *     - assign the Power Platform Administrator role in the admin portal — the
 *       doc's OWN tail recorded that this had already been done via Microsoft
 *       Graph, naming the role template id;
 *     - register the Dataverse Application User by hand — the bootstrap already
 *       called `dataverse-add-appuser.sh`;
 *     - `POST /api/admin/bootstrap-catalogs` from the browser dev console.
 *
 *   Under `.claude/rules/auto-bind-by-default.md` §5 and `ux-baseline.md` G2 an
 *   instruction for an action the platform can take is a defect, not a helpful
 *   note. Deleting the three paragraphs closes the instances; this guard closes
 *   the CLASS, because a runbook re-acquires prose easily and silently.
 *
 * BIDIRECTIONAL — this is the point, not a bonus
 *
 *   Each rule pairs a FORBIDDEN instruction in the doc with EVIDENCE that the
 *   automation performing it still exists. Both directions fail:
 *
 *     (a) the doc re-acquires the instruction        -> FAIL
 *     (b) the automation is deleted/renamed away     -> FAIL
 *
 *   (b) matters more than (a). Without it, ripping the Graph role-assignment
 *   step out of the bootstrap would leave a doc that correctly says nothing and
 *   a platform that does nothing — a silent regression to a WORSE state than
 *   the runbook it replaced, and one no other gate in this repo would notice.
 *
 * CANNOT PASS VACUOUSLY
 *
 *   A guard whose population can drop to zero (a renamed doc, a moved workflow,
 *   a regex that stops matching) would exit 0 having measured nothing — the
 *   exact failure mode recorded in `csa_loom_gates_that_measure_nothing`. Three
 *   defences, all hard errors:
 *
 *     1. Every path this guard reads MUST exist. A missing doc/workflow/route
 *        is a failure, never a skip.
 *     2. An EMBEDDED CONTROL (`selfTest`) runs on every invocation: synthetic
 *        text that MUST trip every forbidden-instruction rule, and synthetic
 *        empty automation that MUST trip every evidence rule. If any control
 *        fails to trip, the guard exits non-zero and says so — a broken
 *        detector can never report a clean estate.
 *     3. Rule count is asserted non-zero.
 *
 * Run: node scripts/ci/check-operator-runbook-drift.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

export const RUNBOOK = 'docs/fiab/operator-interactive-setup.md';
export const BOOTSTRAP = '.github/workflows/csa-loom-post-deploy-bootstrap.yml';
export const WORKLOADS_ROUTE = 'apps/fiab-console/app/api/workloads-catalog/route.ts';

/**
 * Each rule: an action the platform performs, the prose that must NOT reappear
 * in the runbook, and the evidence that the automation still exists.
 *
 * `forbidden` matches only when EVERY pattern in the group is present on the
 * same line (or, for `nearby`, within the same section) — a bare mention of
 * "Power Platform Administrator" while EXPLAINING that the bootstrap assigns it
 * is legitimate and must not trip.
 */
export const RULES = [
  {
    id: 'pp-admin-role',
    what: 'Power Platform Administrator directory role assignment',
    // Portal click-path prose. "Roles and administrators" is the Entra/PPAC
    // role-assignment blade — in THIS runbook there is no legitimate reason to
    // narrate it, and the original click-path spread the blade name and the
    // role name across two numbered lines, so matching either alone is what
    // makes the detector catch the real shape.
    forbidden: [
      { all: [/roles and administrators/i] },
      { all: [/power platform administrator/i, /\b(assign|add assignments?|add\b.*\brole)\b/i] },
    ],
    evidence: {
      file: BOOTSTRAP,
      all: [
        /roleManagement\/directory\/roleAssignments/,
        /11648597-926c-4cf3-9c36-bcebb0ba8dcc/,
      ],
      missing:
        'the bootstrap no longer assigns the Power Platform Administrator directory role via Graph. ' +
        'Either restore that step, or this guard is now protecting an automation that does not exist.',
    },
  },
  {
    id: 'dataverse-app-user',
    what: 'Dataverse Application User registration',
    forbidden: [
      { all: [/application users?/i, /new app user/i] },
      { all: [/\+\s*new app user/i] },
    ],
    evidence: {
      file: BOOTSTRAP,
      all: [/dataverse-add-appuser\.sh/],
      missing:
        'the bootstrap no longer invokes scripts/csa-loom/dataverse-add-appuser.sh. ' +
        'Restore it, or the Dataverse Application User is registered by nobody.',
    },
  },
  {
    id: 'catalog-dev-console-post',
    what: 'curated catalog seeding (apps + workloads)',
    forbidden: [
      { all: [/bootstrap-catalogs/i, /(dev|developer)\s*(tools?|console)/i] },
      { all: [/bootstrap-catalogs/i, /from the browser/i] },
    ],
    evidence: {
      file: WORKLOADS_ROUTE,
      all: [/WORKLOAD_SEEDS/],
      missing:
        'GET /api/workloads-catalog no longer carries its seed-derived backstop, so a fresh ' +
        'tenant renders an EMPTY workloads catalog again and the dev-console POST would be needed.',
    },
  },
  {
    id: 'fabric-tenant-toggle',
    what: 'Fabric / Power BI tenant-settings click-path (opt-in — it belongs in tenant-admin-walkthroughs.md)',
    // no-fabric-dependency.md: presenting the opt-in toggles as interactive
    // setup frames an opt-in backend as a day-one prerequisite.
    //
    // Matches unambiguous CLICK-PATH markers only — the Fabric admin-portal
    // URL, a "Tenant settings" navigation step, or a "-> Enabled" toggle
    // directive. NAMING the setting while pointing at the opt-in doc carries
    // none of these and must stay legal, otherwise this guard would force the
    // runbook to be silent about where the opt-in lives.
    forbidden: [
      { all: [/app\.fabric\.microsoft\.com/i] },
      { all: [/tenant settings/i, /service principals|developer settings/i] },
      { all: [/(→|->)\s*\*{0,2}Enabled/i, /service principals|power bi apis/i] },
    ],
    evidence: null, // relocation, not automation — nothing to keep alive.
  },
];

/** Lines of `text` that trip `rule`, as {line, snippet}. */
export function violations(text, rule) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const group of rule.forbidden) {
      if (group.all.every((re) => re.test(line))) {
        out.push({ line: i + 1, snippet: line.trim().slice(0, 160) });
        break;
      }
    }
  }
  return out;
}

/** True when every evidence pattern is present in `text`. */
export function hasEvidence(text, evidence) {
  if (!evidence) return true;
  return evidence.all.every((re) => re.test(text));
}

function read(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) {
    return { ok: false, abs, text: '' };
  }
  return { ok: true, abs, text: fs.readFileSync(abs, 'utf8') };
}

/**
 * EMBEDDED CONTROL. Returns [] when every detector demonstrably fires on text
 * that must trip it and stays silent on text that must not.
 */
export function selfTest() {
  const failures = [];

  const mustTrip = {
    'pp-admin-role': 'Left nav -> Settings -> Roles and administrators, find the Power Platform Administrator row.',
    'dataverse-app-user': 'Users + permissions > Application users > + New app user > search the client id.',
    'catalog-dev-console-post': 'POST /api/admin/bootstrap-catalogs from the browser dev console.',
    'fabric-tenant-toggle': 'Left nav -> Tenant settings -> find "Service principals can use Fabric APIs".',
  };
  // Prose that legitimately NAMES an automated or relocated action while
  // explaining that the platform performs it (or where the opt-in lives) must
  // stay clean — otherwise the guard would force the doc to be silent about
  // what the bootstrap does.
  const mustNotTrip = [
    'Power Platform Administrator directory role is assigned to the Console UAMI by the bootstrap.',
    'The bootstrap runs scripts/csa-loom/dataverse-add-appuser.sh on every run.',
    'Both catalogs self-seed on first read; no bootstrap-catalogs call is required.',
    'The Fabric tenant toggle is documented in tenant-admin-walkthroughs.md as an opt-in.',
    'tenant toggle ("Service principals can use Fabric APIs"), the Power BI',
    'together with the LOOM_BI_BACKEND / LOOM_<ITEM>_BACKEND=fabric switches.',
  ];

  for (const rule of RULES) {
    const probe = mustTrip[rule.id];
    if (!probe) {
      failures.push(`CONTROL: rule "${rule.id}" has no embedded probe — it is unproven.`);
      continue;
    }
    if (violations(probe, rule).length === 0) {
      failures.push(`CONTROL: rule "${rule.id}" did NOT fire on its own probe text — the detector is broken.`);
    }
    for (const clean of mustNotTrip) {
      if (violations(clean, rule).length > 0) {
        failures.push(`CONTROL: rule "${rule.id}" fired on legitimate prose: ${clean}`);
      }
    }
    if (rule.evidence && hasEvidence('', rule.evidence)) {
      failures.push(`CONTROL: rule "${rule.id}" reported evidence present in EMPTY text — the probe cannot fail.`);
    }
  }
  return failures;
}

export function main() {
  const problems = [];

  if (RULES.length === 0) {
    console.error('operator-runbook-drift: ZERO rules — this guard would measure nothing.');
    return 1;
  }

  const control = selfTest();
  if (control.length > 0) {
    console.error('operator-runbook-drift: EMBEDDED CONTROL FAILED — the guard cannot be trusted.');
    for (const c of control) console.error(`  ${c}`);
    return 1;
  }

  const doc = read(RUNBOOK);
  if (!doc.ok) {
    console.error(`operator-runbook-drift: ${RUNBOOK} does not exist. A renamed/removed runbook must not silently pass.`);
    return 1;
  }

  for (const rule of RULES) {
    const hits = violations(doc.text, rule);
    for (const h of hits) {
      problems.push(
        `${RUNBOOK}:${h.line} re-acquires an instruction for "${rule.what}" ` +
          `(rule ${rule.id}) — the platform performs this. \n      ${h.snippet}`,
      );
    }
    if (rule.evidence) {
      const src = read(rule.evidence.file);
      if (!src.ok) {
        problems.push(`${rule.evidence.file} does not exist — cannot confirm "${rule.what}" is still automated.`);
        continue;
      }
      if (!hasEvidence(src.text, rule.evidence)) {
        problems.push(`${rule.evidence.file}: ${rule.evidence.missing}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error('operator-runbook-drift: FAIL');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error('  An action the platform performs must not be an instruction the operator follows');
    console.error('  (.claude/rules/auto-bind-by-default.md §5, ux-baseline.md G2).');
    return 1;
  }

  console.log(
    `operator-runbook-drift: OK — ${RULES.length} rules checked against ${RUNBOOK}; ` +
      `${RULES.filter((r) => r.evidence).length} automations confirmed still present; embedded control passed.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
