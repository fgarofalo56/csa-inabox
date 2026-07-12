/**
 * Unit tests for the in-product update pre-flight + apply orchestration.
 *
 * These exercise the REAL gate logic (already-up-to-date, no release,
 * images-not-published, arm-not-configured) and the per-app roll reporting,
 * with the network/ARM dependencies injected — so the honesty guarantees in
 * no-vaporware.md (never fake success; name exactly what's missing) are
 * proven without touching Azure or ghcr.
 */
import { describe, it, expect } from 'vitest';
import {
  preflight,
  applyRoll,
  compareVersions,
  tagToImageVersion,
  imageRef,
  LOOM_APPS,
  type UpdateDeps,
  type GhRelease,
  type PreflightOk,
} from '../update-apply';

function release(tag: string, extra: Partial<GhRelease> = {}): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: '2026-06-16T00:00:00Z',
    html_url: `https://github.com/x/y/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    ...extra,
  };
}

function baseDeps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    listReleases: async () => [release('csa-inabox-v0.43.1')],
    headImage: async () => 200,
    armConfig: () => ({ configured: true, missing: [] }),
    currentVersion: '0.42.0',
    ...over,
  };
}

describe('version helpers', () => {
  it('strips the tag prefix + v to the bare image version', () => {
    expect(tagToImageVersion('csa-inabox-v0.43.1')).toBe('0.43.1');
    expect(tagToImageVersion('v1.2.3')).toBe('1.2.3');
    expect(tagToImageVersion('0.1.0')).toBe('0.1.0');
  });

  it('compares versions across tag/prefix forms', () => {
    expect(compareVersions('0.42.0', 'csa-inabox-v0.43.1')).toBe(-1);
    expect(compareVersions('csa-inabox-v0.43.1', '0.43.1')).toBe(0);
    expect(compareVersions('v0.43.2', 'csa-inabox-v0.43.1')).toBe(1);
  });

  it('builds the public image ref', () => {
    expect(imageRef(LOOM_APPS[0], 'fgarofalo56', '0.43.1'))
      .toBe('ghcr.io/fgarofalo56/loom-mcp:0.43.1');
  });
});

describe('preflight gates', () => {
  it('gates when ARM is not configured, naming the missing env', async () => {
    const pre = await preflight(baseDeps({
      armConfig: () => ({ configured: false, missing: ['LOOM_SUBSCRIPTION_ID'] }),
    }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('arm-not-configured');
    expect(pre.missingEnv).toContain('LOOM_SUBSCRIPTION_ID');
  });

  it('gates when there is no stable upstream release', async () => {
    const pre = await preflight(baseDeps({
      listReleases: async () => [release('csa-inabox-v0.44.0', { prerelease: true })],
    }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('no-upstream-release');
  });

  it('gates when already up to date (current >= target)', async () => {
    const pre = await preflight(baseDeps({ currentVersion: '0.43.1' }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('already-up-to-date');
  });

  it('gates with the exact missing images when not all are published', async () => {
    const pre = await preflight(baseDeps({
      headImage: async (ref) => (ref.includes('loom-console') ? 404 : 200),
    }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('images-not-published');
    expect(pre.missingImages?.length).toBe(1);
    expect(pre.missingImages?.[0].app).toBe('loom-console');
    expect(pre.missingImages?.[0].status).toBe(404);
  });

  it('treats a network error on the manifest HEAD as missing (status 0)', async () => {
    const pre = await preflight(baseDeps({
      headImage: async () => { throw new Error('ENOTFOUND'); },
    }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('images-not-published');
    expect(pre.missingImages?.length).toBe(LOOM_APPS.length);
  });

  it('green-lights with a full per-app plan when everything checks out', async () => {
    const pre = await preflight(baseDeps());
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error('expected ok');
    expect(pre.imageVersion).toBe('0.43.1');
    expect(pre.plan.length).toBe(LOOM_APPS.length);
    expect(pre.plan.every((p) => p.toImage.endsWith(':0.43.1'))).toBe(true);
    // console is rolled last so the operator's session survives the longest.
    expect(pre.plan[pre.plan.length - 1].acaName).toBe('loom-console');
  });

  it('gates requires-infra-redeploy when the running deployment is missing a manifest-required env', async () => {
    // The real COMPAT_MANIFEST floor requires LOOM_COSMOS_ACCOUNT at 0.45.0.
    // Update 0.44.0 -> 0.45.0 with that env NOT present must block, not roll.
    const pre = await preflight(baseDeps({
      currentVersion: '0.44.0',
      listReleases: async () => [release('csa-inabox-v0.45.0')],
      envPresent: (n) => n === 'LOOM_SUBSCRIPTION_ID' || n === 'LOOM_ADMIN_RG', // LOOM_COSMOS_ACCOUNT missing
      infraVersion: '0.45.0',
    }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('requires-infra-redeploy');
    expect(pre.missingRequiredEnv?.map((e) => e.name)).toContain('LOOM_COSMOS_ACCOUNT');
    expect(pre.message).toMatch(/re-deploy/i);
  });

  it('proceeds past the compat gate when all manifest-required env is present', async () => {
    const pre = await preflight(baseDeps({
      currentVersion: '0.44.0',
      listReleases: async () => [release('csa-inabox-v0.45.0')],
      envPresent: () => true, // every required env present
      infraVersion: '0.45.0',
    }));
    expect(pre.ok).toBe(true);
  });

  it('skips the compat gate entirely when envPresent is not wired (back-compat)', async () => {
    // Existing callers that do not inject envPresent keep their old behavior.
    const pre = await preflight(baseDeps({
      currentVersion: '0.44.0',
      listReleases: async () => [release('csa-inabox-v0.45.0')],
    }));
    expect(pre.ok).toBe(true);
  });
});

describe('registry-aware image resolution (the real "button never worked" fix)', () => {
  it('rolls each app to its OWN registry (private ACR) at the new tag, not public ghcr', async () => {
    // The bug: the updater hard-probed ghcr.io/<owner>/loom-* images that a
    // locked-down tenant never published, so pre-flight always gated. With
    // resolveImage returning the app's current ACR registry + new tag, the plan
    // targets the registry the app already pulls from — no ghcr dependency.
    const probed: string[] = [];
    const pre = await preflight(baseDeps({
      resolveImage: async (app, imageVersion) => `myacr.azurecr.io/${app.image}:${imageVersion}`,
      headImage: async (ref) => { probed.push(ref); return 200; },
    }));
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error('expected ok');
    expect(pre.plan.every((p) => p.toImage.startsWith('myacr.azurecr.io/'))).toBe(true);
    expect(pre.plan.every((p) => p.toImage.endsWith(':0.43.1'))).toBe(true);
    // NOTHING was probed against public ghcr.
    expect(probed.every((r) => r.startsWith('myacr.azurecr.io/'))).toBe(true);
    expect(probed.some((r) => r.startsWith('ghcr.io/'))).toBe(false);
  });

  it("falls back to the public ghcr ref when resolveImage returns null", async () => {
    const pre = await preflight(baseDeps({
      resolveImage: async () => null, // cannot resolve the current registry
    }));
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error('expected ok');
    expect(pre.plan.every((p) => p.toImage.startsWith('ghcr.io/'))).toBe(true);
  });

  it("excludes apps that resolve to 'skip' (not deployed on this boundary) from probe + plan", async () => {
    const pre = await preflight(baseDeps({
      resolveImage: async (app, imageVersion) =>
        app.acaName === 'loom-copilot-maf' ? 'skip' : `myacr.azurecr.io/${app.image}:${imageVersion}`,
    }));
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error('expected ok');
    expect(pre.plan.length).toBe(LOOM_APPS.length - 1);
    expect(pre.plan.some((p) => p.acaName === 'loom-copilot-maf')).toBe(false);
    expect(pre.probes.some((p) => p.app === 'loom-copilot-maf')).toBe(false);
  });

  it('gates images-not-published against the ACTUAL resolved ref when the ACR tag is missing', async () => {
    const pre = await preflight(baseDeps({
      resolveImage: async (app, imageVersion) => `myacr.azurecr.io/${app.image}:${imageVersion}`,
      headImage: async (ref) => (ref.includes('loom-console') ? 404 : 200),
    }));
    expect(pre.ok).toBe(false);
    if (pre.ok) throw new Error('expected gate');
    expect(pre.reason).toBe('images-not-published');
    expect(pre.missingImages?.[0].ref).toBe('myacr.azurecr.io/loom-console:0.43.1');
    // The gate message no longer misdiagnoses this as "CI still publishing".
    expect(pre.message).not.toMatch(/publish-ghcr-images\.yml/);
  });

  it('a resolveImage that throws degrades to the ghcr fallback (never crashes pre-flight)', async () => {
    const pre = await preflight(baseDeps({
      resolveImage: async () => { throw new Error('ARM GET blew up'); },
    }));
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error('expected ok');
    expect(pre.plan.every((p) => p.toImage.startsWith('ghcr.io/'))).toBe(true);
  });
});

describe('applyRoll', () => {
  const plan: PreflightOk['plan'] = [
    { app: 'loom-mcp', acaName: 'loom-mcp', toImage: 'ghcr.io/x/loom-mcp:0.43.1' },
    { app: 'loom-console', acaName: 'loom-console', toImage: 'ghcr.io/x/loom-console:0.43.1' },
  ];

  it('reports real per-app status and allSucceeded when every roll returns', async () => {
    const { results, allSucceeded } = await applyRoll(plan, async (acaName, image) => ({
      fromImage: `acr/${acaName}:old`, toImage: image, provisioningState: 'Succeeded',
    }));
    expect(allSucceeded).toBe(true);
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(results[0].fromImage).toBe('acr/loom-mcp:old');
  });

  it('maps an async 202 (Updating) to status "updating", still counted as not-failed', async () => {
    const { results, allSucceeded } = await applyRoll(plan, async (_n, image) => ({
      fromImage: '', toImage: image, provisioningState: 'Updating',
    }));
    expect(allSucceeded).toBe(true);
    expect(results.every((r) => r.status === 'updating')).toBe(true);
  });

  it('captures a per-app failure verbatim and does NOT fake success', async () => {
    const { results, allSucceeded } = await applyRoll(plan, async (acaName, image) => {
      if (acaName === 'loom-console') throw new Error('ImagePullBackOff: manifest unknown');
      return { fromImage: '', toImage: image, provisioningState: 'Succeeded' };
    });
    expect(allSucceeded).toBe(false);
    const consoleRes = results.find((r) => r.app === 'loom-console')!;
    expect(consoleRes.status).toBe('failed');
    expect(consoleRes.error).toMatch(/ImagePullBackOff/);
  });

  it('skips apps not deployed on this boundary instead of failing them', async () => {
    const { results, allSucceeded } = await applyRoll(
      plan,
      async (_n, image) => ({ fromImage: '', toImage: image, provisioningState: 'Succeeded' }),
      { appExists: async (acaName) => acaName !== 'loom-mcp' },
    );
    expect(allSucceeded).toBe(true);
    expect(results.find((r) => r.app === 'loom-mcp')!.status).toBe('skipped');
    expect(results.find((r) => r.app === 'loom-console')!.status).toBe('succeeded');
  });
});
