// Behaviour tests for scripts/csa-loom/preflight-image-tags.sh.
//
// The preflight is the guard that stops an adoption deploy from repointing a
// LIVE Container App (Gov `loom-unity`, today) at an image tag that is not in
// the registry — which would replace a running revision with one that cannot
// pull, i.e. take the live Gov catalog down.
//
// Every `az` call is served by a STUB on PATH, so these tests make no Azure
// calls, need no credentials, and assert the decision table directly:
//
//   RG absent                                   -> 0   (from-scratch, nothing adopted)
//   RG present, app absent                      -> 0   (greenfield, two-phase image path)
//   app LIVE + tag present                      -> 0   (safe adoption)
//   app LIVE + tag MISSING                      -> 1   (the outage this prevents)
//   app LIVE + registry unreadable + --no-lease -> 1   (never deploy blind)
//   LOOM_SKIP_IMAGE_PREFLIGHT=true              -> 0   (emergency valve, warns)
//
// Skips automatically when a POSIX shell is unavailable (bare Windows shell),
// so it is a no-op rather than a false failure off-Linux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'preflight-image-tags.sh');

const shAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

// A stand-in `az` whose answers are driven by FAKE_* env vars.
//
// #3090 — THE STUB MUST MODEL `az`, NOT THE CALLER. The per-ref lookup now goes
// through the shared three-state checker (scripts/ci/resolve-acr-digest.sh),
// which calls `az acr repository show … -o json` and parses the "digest" field,
// and which establishes ABSENCE only from the registry's real not-found wording
// (via the canonical failure taxonomy). This stub used to echo a bare
// `sha256:deadbeef` and exit 1 SILENTLY on a miss — shapes that matched the old
// `--query digest -o tsv` call and nothing else. Against the real contract that
// is (a) an unparseable success and (b) an unclassifiable failure, i.e. UNPROVEN
// for every case, which is precisely the "fixtures that model the code instead
// of reality" trap. It now emits the JSON `az` really returns and the verbatim
// ResourceNotFoundError text it really prints.
const AZ_STUB = `#!/usr/bin/env bash
case "$1 $2" in
  "group show")      [ "\${FAKE_RG_EXISTS:-true}" = "true" ] && exit 0 || exit 1 ;;
  "containerapp list") for a in \${FAKE_LIVE_APPS:-}; do echo "$a"; done; exit 0 ;;
  "acr list")        echo "\${FAKE_ACR:-acrloomgov}"; exit 0 ;;
  "acr show")        echo "\${FAKE_ACR:-acrloomgov}.azurecr.us"; exit 0 ;;
  "acr login")       [ "\${FAKE_DATAPLANE_UP:-true}" = "true" ] && exit 0 || exit 1 ;;
  "acr repository")
    case "$3" in
      list) [ "\${FAKE_DATAPLANE_UP:-true}" = "true" ] && exit 0 || exit 1 ;;
      show)
        img=""; prev=""
        for a in "$@"; do [ "$prev" = "--image" ] && img="$a"; prev="$a"; done
        if [ "\${FAKE_DATAPLANE_UP:-true}" != "true" ]; then
          echo "denied: client with IP '20.1.2.3' is not allowed access." >&2; exit 1
        fi
        case " \${FAKE_TAGS:-} " in
          *" $img "*) printf '{\\n  "digest": "sha256:deadbeef",\\n  "name": "%s"\\n}\\n' "\${img##*:}"; exit 0 ;;
        esac
        # The verbatim wording az emits for a manifest that is not there.
        echo "ResourceNotFoundError: The manifest '\${img##*:}' does not exist for the repository '\${img%%:*}' in the registry '\${FAKE_ACR:-acrloomgov}'." >&2
        exit 1 ;;
      show-tags) echo "\${FAKE_REPO_TAGS:-}"; exit 0 ;;
    esac ;;
esac
exit 0
`;

let stubDir = '';
if (shAvailable) {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-preflight-'));
  const azPath = path.join(stubDir, 'az');
  fs.writeFileSync(azPath, AZ_STUB, { mode: 0o755 });
}

function preflight(env, args = ['--rg', 'rg-csa-loom-admin-usgovvirginia', '--require', 'loom-unity:v0.1']) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTIONS: '',
      LOOM_SKIP_IMAGE_PREFLIGHT: 'false',
      // Zero-latency retry budget. The resolver's backoff maths is proven by
      // scripts/ci/test-resolve-acr-digest.sh; this suite is about the VERDICT,
      // and a real backoff here would add minutes per negative case.
      LOOM_PREFLIGHT_ATTEMPTS: '1',
      LOOM_PREFLIGHT_ABSENT_ATTEMPTS: '1',
      LOOM_PREFLIGHT_BACKOFF_SECONDS: '0',
      ...env,
    },
  });
}

test('from-scratch: the resource group does not exist yet => pass (nothing is being adopted)', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_RG_EXISTS: 'false' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /does not exist yet/);
});

test('greenfield: the Container App is not deployed yet => pass (two-phase image path)', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_LIVE_APPS: 'loom-console', FAKE_TAGS: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /greenfield, nothing adopted/);
});

test('adoption: the app is LIVE and the tag resolves => pass, and the digest is in the receipt', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_LIVE_APPS: 'loom-console loom-unity', FAKE_TAGS: 'loom-unity:v0.1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is LIVE .* ADOPTS it/);
  assert.match(r.stdout, /preflight OK — loom-unity:v0\.1 resolves to sha256:deadbeef/);
});

test('adoption: the app is LIVE and the tag is MISSING => FAIL LOUDLY (this is the outage)', { skip: !shAvailable }, () => {
  const r = preflight({
    FAKE_LIVE_APPS: 'loom-console loom-unity',
    FAKE_TAGS: 'loom-unity:abc123',
    FAKE_REPO_TAGS: 'abc123 latest',
  });
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /IMAGE PREFLIGHT FAILED/);
  // The remediation must name the producer AND the exact tag to build.
  assert.match(out, /gov-build-images\.yml/);
  assert.match(out, /apps=loom-unity, tag=v0\.1/);
  // And it must show what IS there, so the operator can see the tag skew.
  assert.match(out, /abc123 latest/);
});

test('adoption: the registry is unreadable and the firewall may not be touched => FAIL (never deploy blind)', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_LIVE_APPS: 'loom-unity', FAKE_DATAPLANE_UP: 'false' }, [
    '--rg', 'rg-csa-loom-admin-usgovvirginia',
    '--require', 'loom-unity:v0.1',
    '--no-lease',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /could not be verified|not reachable from this host/);
});

test('emergency valve: LOOM_SKIP_IMAGE_PREFLIGHT=true passes but WARNS about the consequence', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_LIVE_APPS: 'loom-unity', FAKE_TAGS: '', LOOM_SKIP_IMAGE_PREFLIGHT: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /SKIPPING the adopted-image preflight/);
});

test('the Container App name may differ from the repository name (repo:tag@app)', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_LIVE_APPS: 'loom-maps-tiles', FAKE_TAGS: 'loom-maps-tileserver:v1' }, [
    '--rg', 'rg-csa-loom-admin-usgovvirginia',
    '--require', 'loom-maps-tileserver:v1@loom-maps-tiles',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /loom-maps-tileserver:v1 resolves/);
});

test('a malformed --require is a usage error, not a silent pass', { skip: !shAvailable }, () => {
  const r = preflight({ FAKE_LIVE_APPS: 'loom-unity' }, [
    '--rg', 'rg-csa-loom-admin-usgovvirginia',
    '--require', 'loom-unity',
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /malformed --require/);
});
