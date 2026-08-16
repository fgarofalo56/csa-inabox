/**
 * Unit tests for `lib/setup/wire-existing.ts` — the validation, resolution and
 * shell-free execution primitives behind POST /api/setup/wire-existing
 * (GHSA-fj7j-qq8g-hqj8).
 *
 * The route-level suite (`app/api/setup/__tests__/wire-existing-injection.test.ts`)
 * pins the end-to-end refusal behaviour. This file covers the branches that suite
 * cannot reach because it forces the "script is present" world — most importantly
 * the MISSING-SCRIPT branch, which is the one EVERY production request currently
 * takes: the console runtime image ships the Next.js standalone build only, with
 * no `scripts/` directory, no `bash` and no `az`.
 *
 * `existsSync` is NOT mocked here. The tests create a real temp directory and
 * inject it through `runWireScript`'s `opts.scriptsDir`, creating (or omitting)
 * a real file, so the presence check is exercised for real rather than asserted
 * against a stub. The seam is a function parameter rather than an env var on
 * purpose: a `LOOM_*` variable would be a platform contract bicep must emit, and
 * emitting one for a path that cannot run in the shipped image is exactly the
 * config `no-vaporware.md` forbids. Only `spawnSync` is stubbed — nothing is
 * ever executed, and no test contacts Azure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawnSyncMock = vi.fn(
  () => ({ status: 0, stdout: '', stderr: '', signal: null, error: undefined }) as any,
);
vi.mock('node:child_process', () => ({
  spawnSync: (...a: any[]) => spawnSyncMock(...a),
}));

import {
  AZURE_LOCATION_RE,
  DLZ_DOMAIN_RE,
  SUBSCRIPTION_ID_RE,
  WIRE_SCRIPTS,
  isAzureLocation,
  isDlzDomainName,
  isSafeResourceGroupName,
  isSubscriptionId,
  parseDlzRg,
  resolveSelectedDlzs,
  runWireScript,
  wireScriptsDir,
  type DiscoveredDlz,
} from '../wire-existing';

const GOOD_SUB = '11111111-2222-3333-4444-555555555555';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wire-'));
  spawnSyncMock.mockClear();
  spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '', signal: null, error: undefined } as any);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Create a real (empty) script file so the presence check passes. */
function placeScript(name: string) {
  fs.writeFileSync(path.join(tmpDir, name), '#!/usr/bin/env bash\n', 'utf8');
}

/**
 * `runWireScript` bound to this test's real temp directory. The directory is a
 * function parameter, not an env var — see the file header.
 */
function run(
  script: any,
  vars: Record<string, string> = {},
  opts: { timeoutMs?: number } = {},
) {
  return runWireScript(script, vars, { ...opts, scriptsDir: tmpDir });
}

describe('L3 allow-lists', () => {
  it('accepts canonical values', () => {
    expect(isSubscriptionId(GOOD_SUB)).toBe(true);
    expect(isSubscriptionId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
    expect(isAzureLocation('eastus2')).toBe(true);
    expect(isAzureLocation('usgovvirginia')).toBe(true);
    expect(isDlzDomainName('finance')).toBe(true);
    expect(isDlzDomainName('supply-chain')).toBe(true);
    expect(isDlzDomainName('a')).toBe(true);
    expect(isSafeResourceGroupName('rg-csa-loom-dlz-finance-eastus2')).toBe(true);
  });

  it('rejects every shell metacharacter class, in every field', () => {
    const payloads = ['x;y', 'x$(y)', 'x`y`', 'x\ny', 'x|y', 'x&&y', 'x>y', "x'y", 'x y', 'x"y', 'x\\y', 'x$y'];
    for (const p of payloads) {
      expect(isDlzDomainName(p)).toBe(false);
      expect(isAzureLocation(p)).toBe(false);
      expect(isSubscriptionId(`${GOOD_SUB}${p}`)).toBe(false);
      expect(isSafeResourceGroupName(`rg-csa-loom-dlz-${p}`)).toBe(false);
    }
  });

  it('is anchored at both ends — a valid substring does not smuggle a payload through', () => {
    expect(isSubscriptionId(`prefix${GOOD_SUB}`)).toBe(false);
    expect(isSubscriptionId(`${GOOD_SUB}\n${GOOD_SUB}`)).toBe(false);
    // A trailing newline is the classic anchor bypass when `$` is used without `\z`.
    expect(isAzureLocation('eastus\n')).toBe(false);
    expect(isDlzDomainName('finance\n')).toBe(false);
    expect(SUBSCRIPTION_ID_RE.source.startsWith('^')).toBe(true);
    expect(AZURE_LOCATION_RE.source.endsWith('$')).toBe(true);
    expect(DLZ_DOMAIN_RE.source.endsWith('$')).toBe(true);
  });

  it('rejects non-strings and structural edge cases', () => {
    for (const v of [undefined, null, 42, {}, [], true]) {
      expect(isSubscriptionId(v)).toBe(false);
      expect(isAzureLocation(v)).toBe(false);
      expect(isDlzDomainName(v)).toBe(false);
      expect(isSafeResourceGroupName(v)).toBe(false);
    }
    expect(isDlzDomainName('')).toBe(false);
    expect(isDlzDomainName('-leading')).toBe(false);
    expect(isDlzDomainName('trailing-')).toBe(false);
    // Azure forbids a trailing period on a resource-group name.
    expect(isSafeResourceGroupName('rg-csa-loom-dlz-finance.')).toBe(false);
    expect(isSafeResourceGroupName('a'.repeat(91))).toBe(false);
  });
});

describe('parseDlzRg', () => {
  it('splits domain and region', () => {
    expect(parseDlzRg('rg-csa-loom-dlz-finance-eastus2')).toEqual({ domainName: 'finance', region: 'eastus2' });
  });

  it('keeps a hyphenated domain intact (greedy match stops at the final segment)', () => {
    expect(parseDlzRg('rg-csa-loom-dlz-supply-chain-eastus2')).toEqual({
      domainName: 'supply-chain',
      region: 'eastus2',
    });
  });

  it('returns null for a name that is not a Loom DLZ resource group', () => {
    expect(parseDlzRg('rg-something-else')).toBeNull();
    expect(parseDlzRg('rg-csa-loom-admin-eastus2')).toBeNull();
    expect(parseDlzRg('')).toBeNull();
  });
});

describe('resolveSelectedDlzs', () => {
  const discovered: DiscoveredDlz[] = [
    { subscriptionId: GOOD_SUB, domainName: 'finance', region: 'eastus2', rg: 'rg-csa-loom-dlz-finance-eastus2' },
  ];

  it('resolves a match to the Azure-reported resource group', () => {
    const [r] = resolveSelectedDlzs([{ subscriptionId: GOOD_SUB, domainName: 'finance' }], discovered);
    expect(r.ok).toBe(true);
    expect(r.ok && r.discovered.rg).toBe('rg-csa-loom-dlz-finance-eastus2');
  });

  it('matches case-insensitively on both coordinates', () => {
    const [r] = resolveSelectedDlzs(
      [{ subscriptionId: GOOD_SUB.toUpperCase(), domainName: 'FINANCE' }],
      discovered,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a domain that exists in a DIFFERENT subscription', () => {
    const [r] = resolveSelectedDlzs(
      [{ subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', domainName: 'finance' }],
      discovered,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/No Data Landing Zone/);
  });

  it('refuses an unknown domain and produces NO resource-group string', () => {
    const results = resolveSelectedDlzs([{ subscriptionId: GOOD_SUB, domainName: 'nope' }], discovered);
    expect(results[0].ok).toBe(false);
    expect(JSON.stringify(results[0])).not.toContain('rg-csa-loom-dlz');
  });

  it('refuses even an AZURE-RETURNED name that fails the allow-list (belt and braces)', () => {
    // Resource Graph should never emit this, but L3 is applied to its output
    // anyway because that string is about to cross a process boundary.
    const hostile: DiscoveredDlz[] = [
      { subscriptionId: GOOD_SUB, domainName: 'finance', region: 'eastus2', rg: 'rg-csa-loom-dlz-finance;id' },
    ];
    const [r] = resolveSelectedDlzs([{ subscriptionId: GOOD_SUB, domainName: 'finance' }], hostile);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/resource-name validation/);
  });

  it('resolves each selection independently — one bad entry does not sink the others', () => {
    const results = resolveSelectedDlzs(
      [
        { subscriptionId: GOOD_SUB, domainName: 'finance' },
        { subscriptionId: GOOD_SUB, domainName: 'missing' },
      ],
      discovered,
    );
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe('runWireScript — the branch every production request takes', () => {
  it('reports honestly and spawns NOTHING when the script is absent from the image', () => {
    // tmpDir is empty: this is the real state of the console runtime image.
    const r = run(WIRE_SCRIPTS.grantRbac, { SUB: GOOD_SUB, DLZ_RG: 'rg-x' });

    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.reason).toMatch(/cannot perform .* in-process/);
    // States that nothing changed, and names WHERE it looked.
    expect(r.reason).toMatch(/Nothing was changed/);
    expect(r.reason).toContain(tmpDir);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('states the limitation without instructing the operator to run anything', () => {
    // auto-bind-by-default.md §5: work the platform should perform is the
    // platform's to perform. A message handing the operator a script to run by
    // hand is a defect, and `check-platform-runs-it-not-you` gates on it.
    const r = run(WIRE_SCRIPTS.grantRbac, {});
    expect(r.reason).not.toMatch(/\brun\s+(?:it|this|the\s+(?:script|command))\b/i);
    expect(r.reason).not.toMatch(/you (?:must|should|need to|can)\b/i);
    expect(r.reason).not.toMatch(/\baz\s+(?:login|role|containerapp)\b/);
  });

  it('does not claim a cause it did not establish (deploy-integrity R7)', () => {
    const r = run(WIRE_SCRIPTS.patchEnv, {});
    // It must not assert a permission or Azure failure — it only knows the file is missing.
    expect(r.reason).not.toMatch(/permission|denied|unauthorized|Azure rejected/i);
  });
});

describe('runWireScript — execution shape', () => {
  it('uses an argv array with shell:false and passes values via env', () => {
    placeScript(WIRE_SCRIPTS.grantRbac);
    const r = run(WIRE_SCRIPTS.grantRbac, { SUB: GOOD_SUB, DLZ_RG: 'rg-csa-loom-dlz-finance-eastus2' });

    expect(r.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as unknown as [string, string[], any];
    expect(cmd).toBe('bash');
    expect(args).toEqual([path.join(tmpDir, WIRE_SCRIPTS.grantRbac)]);
    expect(opts.shell).toBe(false);
    expect(opts.env.SUB).toBe(GOOD_SUB);
    expect(opts.env.DLZ_RG).toBe('rg-csa-loom-dlz-finance-eastus2');
    // No value appears in argv — there is no command string at all.
    expect(args.join(' ')).not.toContain(GOOD_SUB);
  });

  it('inherits process.env rather than replacing it, so PATH survives', () => {
    placeScript(WIRE_SCRIPTS.patchEnv);
    run(WIRE_SCRIPTS.patchEnv, { SUB: GOOD_SUB });
    const opts = (spawnSyncMock.mock.calls[0] as any)[2];
    expect(opts.env.PATH ?? opts.env.Path).toBeDefined();
  });

  it('refuses a script name that is not on the allow-list, without spawning', () => {
    placeScript('evil.sh');
    const r = run('evil.sh' as any, { SUB: GOOD_SUB });

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not an allowed wiring script/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('refuses a traversal attempt in the script name, without spawning', () => {
    const r = run('../../../../bin/sh' as any, { SUB: GOOD_SUB });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not an allowed wiring script/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('runWireScript — failure classification', () => {
  it('explains ENOENT as "no bash in this image" rather than surfacing the errno', () => {
    placeScript(WIRE_SCRIPTS.grantRbac);
    const err: NodeJS.ErrnoException = Object.assign(new Error('spawnSync bash ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ status: null, signal: null, error: err, stdout: '', stderr: '' } as any);

    const r = run(WIRE_SCRIPTS.grantRbac, { SUB: GOOD_SUB });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.reason).toMatch(/does not include a bash shell/);
  });

  it('reports a non-ENOENT spawn error without inventing a cause', () => {
    placeScript(WIRE_SCRIPTS.grantRbac);
    const err: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    spawnSyncMock.mockReturnValue({ status: null, signal: null, error: err, stdout: '', stderr: '' } as any);

    const r = run(WIRE_SCRIPTS.grantRbac, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('EACCES');
  });

  it('reports a timeout kill as a signal, not as a clean failure', () => {
    placeScript(WIRE_SCRIPTS.patchEnv);
    spawnSyncMock.mockReturnValue({ status: null, signal: 'SIGTERM', error: undefined, stdout: '', stderr: 'partial' } as any);

    const r = run(WIRE_SCRIPTS.patchEnv, {}, { timeoutMs: 1234 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/terminated by SIGTERM/);
    expect(r.reason).toContain('1234');
  });

  it('passes the timeout through to spawnSync so a hung script cannot wedge the request', () => {
    placeScript(WIRE_SCRIPTS.patchEnv);
    run(WIRE_SCRIPTS.patchEnv, {}, { timeoutMs: 5000 });
    expect((spawnSyncMock.mock.calls[0] as any)[2].timeout).toBe(5000);
  });

  it('treats a non-zero exit as failure and reports the code', () => {
    placeScript(WIRE_SCRIPTS.grantRbac);
    spawnSyncMock.mockReturnValue({ status: 3, signal: null, error: undefined, stdout: '', stderr: 'boom' } as any);

    const r = run(WIRE_SCRIPTS.grantRbac, {});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(3);
    expect(r.reason).toMatch(/exited 3/);
    expect(r.stderr).toBe('boom');
  });

  it('bounds captured stderr so a noisy script cannot flood the response', () => {
    placeScript(WIRE_SCRIPTS.grantRbac);
    spawnSyncMock.mockReturnValue({ status: 1, signal: null, error: undefined, stdout: '', stderr: 'x'.repeat(10_000) } as any);

    const r = run(WIRE_SCRIPTS.grantRbac, {});
    expect(r.stderr!.length).toBe(2000);
  });
});

describe('wireScriptsDir', () => {
  it('is the canonical repo path and reads NO environment variable', () => {
    // Pinned deliberately: an earlier revision made this configurable via a
    // LOOM_* variable, which check-env-sync rejected because every LOOM_* the
    // console reads is a platform contract bicep must emit. Setting the old name
    // must have no effect — if someone reintroduces the env read, this fails.
    //
    // The name is assembled at runtime and set through bracket notation ON
    // PURPOSE. check-env-sync scans `apps/fiab-console/{app,lib}` — which
    // includes this __tests__ directory — with /process\.env\.(LOOM_[A-Z0-9_]+)/,
    // and it does NOT strip comments or distinguish a read from a write. Writing
    // the literal here would re-introduce the very violation this test exists to
    // prevent, and the guard would fail on its own regression test. Do not
    // "simplify" this back to a dotted literal.
    const legacyVar = ['LOOM', 'WIRE', 'SCRIPTS', 'DIR'].join('_');
    process.env[legacyVar] = tmpDir;
    try {
      expect(wireScriptsDir()).toBe(path.join(process.cwd(), 'scripts', 'csa-loom'));
      expect(wireScriptsDir()).not.toBe(tmpDir);
    } finally {
      delete process.env[legacyVar];
    }
  });

  it('is overridden per call through opts.scriptsDir, not globally', () => {
    placeScript(WIRE_SCRIPTS.grantRbac);
    const r = run(WIRE_SCRIPTS.grantRbac, {});
    expect(r.ok).toBe(true);
    expect((spawnSyncMock.mock.calls[0] as any)[1][0]).toBe(path.join(tmpDir, WIRE_SCRIPTS.grantRbac));
  });
});
