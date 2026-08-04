/**
 * The distribution guard (Phase 5, deliverable #1). Parses the shipped
 * `.github/workflows/publish-loom-vscode.yml` and proves the publish path is
 * FORK-SAFE: every step that actually publishes (`vsce publish` / `ovsx publish`)
 * is gated on BOTH a version tag push AND its own token secret being present, and
 * the GitHub-Release attach is tag-gated. A fork PR (no tag, no secrets) can
 * therefore never publish.
 *
 * MUTATION-PROOF: delete the `env.VSCE_PAT != ''` (or `env.OVSX_PAT != ''`) guard
 * from a publish step, or drop the tag guard, and these assertions go RED.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(dir, '../../../.github/workflows/publish-loom-vscode.yml');

interface Step {
  name: string;
  if: string;
  body: string;
}

/** Minimal step splitter for the single-job workflow (steps start at 6-space `- name:`/`- uses:`). */
function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  let cur: Step | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, ''); // tolerate CRLF checkouts
    if (/^ {6}- (name|uses):/.test(line)) {
      if (cur) steps.push(cur);
      cur = { name: '', if: '', body: `${line}\n` };
      const nm = line.match(/- name:\s*(.*)$/);
      if (nm) cur.name = nm[1].trim();
    } else if (cur) {
      cur.body += `${line}\n`;
      const ifm = line.match(/^\s*if:\s*(.*)$/);
      if (ifm && !cur.if) cur.if = ifm[1].trim();
    }
  }
  if (cur) steps.push(cur);
  return steps;
}

const TAG_GUARD = "startsWith(github.ref, 'refs/tags/loom-vscode-v')";

describe('publish-loom-vscode.yml is fork-safe', () => {
  const text = fs.readFileSync(workflowPath, 'utf8');
  const steps = parseSteps(text);

  it('the workflow exists and is tag- + PR-triggered', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    expect(text).toContain("- 'loom-vscode-v*'");
    expect(text).toContain('pull_request:');
    expect(text).toContain("- 'apps/loom-vscode/**'");
  });

  it('the VS Marketplace publish step is gated on push + tag + VSCE_PAT present', () => {
    const step = steps.find((s) => s.body.includes('vsce publish'));
    expect(step, 'a `vsce publish` step must exist').toBeTruthy();
    expect(step!.if).toContain("github.event_name == 'push'");
    expect(step!.if).toContain(TAG_GUARD);
    // The token-presence guard — the mutation-proof assertion.
    expect(step!.if).toContain("env.VSCE_PAT != ''");
  });

  it('the Open VSX publish step is gated on push + tag + OVSX_PAT present', () => {
    const step = steps.find((s) => s.body.includes('ovsx publish'));
    expect(step, 'an `ovsx publish` step must exist').toBeTruthy();
    expect(step!.if).toContain("github.event_name == 'push'");
    expect(step!.if).toContain(TAG_GUARD);
    expect(step!.if).toContain("env.OVSX_PAT != ''");
  });

  it('the GitHub-Release attach step is tag-gated (never on a PR/fork)', () => {
    const step = steps.find((s) => s.body.includes('gh release create'));
    expect(step, 'a `gh release create` step must exist').toBeTruthy();
    expect(step!.if).toContain("github.event_name == 'push'");
    expect(step!.if).toContain(TAG_GUARD);
  });

  it('NO publishing command runs unconditionally (every one is guarded)', () => {
    for (const step of steps) {
      const publishes = /vsce publish|ovsx publish|gh release (create|upload)/.test(step.body);
      if (!publishes) continue;
      // Every publishing step must carry a tag guard in its own `if:`.
      expect(step.if, `step "${step.name}" publishes without an if-guard`).not.toBe('');
      expect(step.if).toContain(TAG_GUARD);
    }
    // Token-publish steps additionally require the secret-presence guard.
    for (const step of steps) {
      if (step.body.includes('vsce publish')) expect(step.if).toContain("env.VSCE_PAT != ''");
      if (step.body.includes('ovsx publish')) expect(step.if).toContain("env.OVSX_PAT != ''");
    }
  });
});
