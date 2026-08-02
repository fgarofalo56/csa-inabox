#!/usr/bin/env node
/**
 * Resolve WHICH Front Door endpoint backs the URL a roll is about to validate,
 * so the cache purge addresses a real resource instead of an assumed name.
 *
 * WHY THIS EXISTS (#2828). `loom-roll-and-validate.yml` documented purging Front
 * Door as step 2 of its contract ("so we don't validate a cached old page") and
 * had never purged anything:
 *
 *     FD_PROFILE=$(az afd profile list -g "$RG" --query "[0].name" -o tsv)   # discovered
 *     az afd endpoint purge --profile-name "$FD_PROFILE" -g "$RG" \
 *       --endpoint-name loom-console  ...  || true                          # ASSUMED
 *
 * The real endpoint carries a per-deployment suffix (`loom-console-<suffix>`),
 * so every call failed `ResourceNotFound`, and `|| true` discarded the verdict
 * inside a step that then reported success. Same class as #2819 / #2775: a
 * control that runs, fails, and reads green.
 *
 * The naive fix — swapping the literal for `az afd endpoint list --query
 * "[0].name"` — moves the same brittleness one line over. A profile can hold
 * several endpoints, and "the first one" is not a fact about which one serves
 * the URL under test. So the selection here is a MATCH, not an index:
 *
 *   1. `endpoint-host`  — an endpoint whose own hostName IS the probed host.
 *   2. `custom-domain`  — a custom domain routed to an endpoint whose hostName
 *                         IS the probed host. This is the live shape: the roll
 *                         probes the vanity domain, which no endpoint hostName
 *                         ever equals, so without this hop the primary path
 *                         could never match in the estate it exists to serve.
 *   3. `sole-endpoint`  — exactly ONE endpoint exists across every profile in
 *                         the resource group. Not an index: with one candidate
 *                         there is nothing to choose wrongly. This covers a
 *                         probe against the ACA host directly, or a vanity
 *                         domain that is not wired to a route yet.
 *
 * Anything else is `unresolved` — an UNKNOWN, reported as one. Two or more
 * endpoints and none matching is precisely when guessing is wrong, and that is
 * the state the caller must refuse rather than paper over.
 *
 * A resource group with no AFD profile at all is `not-applicable`: Front Door
 * is opt-in in this platform (`frontDoorEnabled`, default off), so "no profile"
 * is a legitimate estate shape and not a failure.
 *
 * WHETHER THE PURGE IS LOAD-BEARING AT ALL (#2828 follow-up). The purge is
 * submitted with `--no-wait`, i.e. SUBMITTED, not COMPLETED — and per Microsoft
 * Learn a purge "can take up to 10 minutes to propagate across all Azure Front
 * Door POP locations", which no `sleep` in a roll will ever outlast. That is
 * only an exposure if Front Door is caching the pages the roll validates, and
 * whether it is caching is a fact about the ROUTE, not an assumption to carry:
 *
 *   - a route with `cacheConfiguration: null` does not cache at all (Front Door
 *     answers every request `X-Cache: CONFIG_NOCACHE`), so the purge clears an
 *     empty cache and validation cannot read a stale page no matter when it runs;
 *   - a route WITH `cacheConfiguration` can cache, and then "submitted" is a
 *     genuinely weaker guarantee than the workflow's comment claims.
 *
 * So the caller feeds the per-endpoint count of cache-enabled routes in, and
 * this module reports `caching` alongside the target. The caller then pays for
 * awaiting the purge only in the state where awaiting buys something. Unknown is
 * treated as `on` by the caller, never as `off`: the whole point of #2828 is
 * that absence of evidence was read as evidence of success.
 *
 * INPUT is a TAB-separated record stream on stdin (produced by the `az afd
 * ... list` calls in the workflow), deliberately not JSON so the shell side
 * stays free of a `jq` dependency and every field is trivially inspectable:
 *
 *     profile <TAB> PROFILE
 *     endpoint<TAB> PROFILE <TAB> ENDPOINT <TAB> HOSTNAME
 *     domain  <TAB> PROFILE <TAB> ENDPOINT <TAB> CUSTOM-DOMAIN-HOSTNAME
 *     cache   <TAB> PROFILE <TAB> ENDPOINT <TAB> N-ROUTES-WITH-CACHING-ENABLED
 *
 * Note what is NOT in that stream: ARM resource ids. This repo is public, and
 * `az afd route list --query "[].customDomains[].id"` returns ids containing the
 * subscription. The caller basenames them before they ever reach here.
 *
 * OUTPUT is KEY=VALUE lines on stdout (state/profile/endpoint/via/caching/detail)
 * plus a human-readable diagnostic on stderr. The exit code is 0 for every
 * well-formed input: this module reports the state, the caller decides the policy.
 *
 * Run the tests: node --test scripts/ci/__tests__/fd-resolve-purge-target.test.mjs
 */

/** Lowercased host of `url`, or '' if it cannot be parsed. Scheme optional. */
export function hostOf(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Parse the TAB-separated record stream into `[{name, endpoints:[{name, hostName,
 * domains:[...], cachedRoutes}]}]`. Unknown record kinds and blank lines are
 * ignored; an `endpoint`/`domain`/`cache` record naming a profile we have not
 * seen still creates it, so a truncated stream degrades to fewer candidates
 * rather than a crash.
 *
 * `cachedRoutes` is the number of routes on that endpoint with caching enabled,
 * or `null` when the stream carried no `cache` record for it. `null` means WE DO
 * NOT KNOW and is never collapsed into 0 — a failed `az` query must not read as
 * "caching is off", which is the #2828 mistake in miniature.
 */
export function parseRecords(text) {
  const profiles = new Map();
  const profileFor = (name) => {
    if (!profiles.has(name)) profiles.set(name, { name, endpoints: new Map() });
    return profiles.get(name);
  };
  const endpointFor = (profileName, endpointName) => {
    const p = profileFor(profileName);
    if (!p.endpoints.has(endpointName)) {
      p.endpoints.set(endpointName, { name: endpointName, hostName: '', domains: [], cachedRoutes: null });
    }
    return p.endpoints.get(endpointName);
  };

  for (const line of String(text ?? '').split('\n')) {
    const row = line.replace(/\r$/, '');
    if (!row.trim()) continue;
    const [kind, a, b, c] = row.split('\t');
    if (kind === 'profile') {
      if (a) profileFor(a);
    } else if (kind === 'endpoint') {
      if (!a || !b) continue;
      const ep = endpointFor(a, b);
      ep.hostName = ep.hostName || (c || '');
    } else if (kind === 'domain') {
      if (!a || !b || !c) continue;
      const ep = endpointFor(a, b);
      if (!ep.domains.includes(c)) ep.domains.push(c);
    } else if (kind === 'cache') {
      if (!a || !b) continue;
      // Only a clean non-negative integer counts. Anything else (empty string
      // from a failed query, 'null', a stray word) stays UNKNOWN.
      if (!/^\d+$/.test(String(c ?? '').trim())) continue;
      endpointFor(a, b).cachedRoutes = Number(String(c).trim());
    }
  }

  return [...profiles.values()].map((p) => ({ name: p.name, endpoints: [...p.endpoints.values()] }));
}

/**
 * Classify an endpoint's route caching from its `cachedRoutes` count.
 * `'unknown'` is deliberately distinct from `'off'` — see parseRecords.
 */
export function cachingStateOf(cachedRoutes) {
  if (typeof cachedRoutes !== 'number' || !Number.isFinite(cachedRoutes)) return 'unknown';
  return cachedRoutes > 0 ? 'on' : 'off';
}

/**
 * Decide which (profile, endpoint) pair to purge for `url`, and whether that
 * endpoint's routes cache at all.
 *
 * @returns {{state:'resolved'|'not-applicable'|'unresolved', profile?:string,
 *            endpoint?:string, via?:string, caching:'on'|'off'|'unknown',
 *            detail:string, candidates:Array}}
 */
export function resolvePurgeTarget({ url, profiles }) {
  const host = hostOf(url);
  const list = Array.isArray(profiles) ? profiles : [];

  const candidates = [];
  for (const p of list) {
    for (const ep of p.endpoints || []) {
      candidates.push({
        profile: p.name,
        endpoint: ep.name,
        hostName: (ep.hostName || '').toLowerCase(),
        domains: (ep.domains || []).map((d) => String(d).toLowerCase()),
        cachedRoutes: typeof ep.cachedRoutes === 'number' ? ep.cachedRoutes : null,
      });
    }
  }

  if (list.length === 0) {
    return {
      state: 'not-applicable',
      caching: 'unknown',
      detail: 'no Front Door profile in the resource group — Front Door is opt-in, nothing to purge',
      candidates,
    };
  }

  if (!host) {
    return {
      state: 'unresolved',
      caching: 'unknown',
      detail: `could not parse a host from the probed URL ${JSON.stringify(String(url ?? ''))}`,
      candidates,
    };
  }

  if (candidates.length === 0) {
    return {
      state: 'unresolved',
      caching: 'unknown',
      detail:
        `Front Door profile(s) ${list.map((p) => p.name).join(', ')} exist but expose NO endpoint — ` +
        'a profile without an endpoint cannot serve or cache this URL, so the estate is misconfigured',
      candidates,
    };
  }

  const byHost = candidates.filter((c) => c.hostName === host);
  if (byHost.length === 1) {
    return { state: 'resolved', ...pick(byHost[0], 'endpoint-host', `endpoint hostName == ${host}`), candidates };
  }
  if (byHost.length > 1) {
    return {
      state: 'unresolved',
      caching: 'unknown',
      detail: `${byHost.length} endpoints claim hostName ${host} — ambiguous, refusing to guess`,
      candidates,
    };
  }

  const byDomain = candidates.filter((c) => c.domains.includes(host));
  if (byDomain.length === 1) {
    return {
      state: 'resolved',
      ...pick(byDomain[0], 'custom-domain', `custom domain ${host} is routed to this endpoint`),
      candidates,
    };
  }
  if (byDomain.length > 1) {
    return {
      state: 'unresolved',
      caching: 'unknown',
      detail: `custom domain ${host} is routed to ${byDomain.length} endpoints — ambiguous, refusing to guess`,
      candidates,
    };
  }

  if (candidates.length === 1) {
    return {
      state: 'resolved',
      ...pick(
        candidates[0],
        'sole-endpoint',
        `no endpoint hostName or routed custom domain matches ${host}, but exactly one endpoint exists in the ` +
          'resource group, so there is nothing to choose wrongly',
      ),
      candidates,
    };
  }

  return {
    state: 'unresolved',
    caching: 'unknown',
    detail:
      `no endpoint hostName and no routed custom domain matches ${host}, and ${candidates.length} endpoints ` +
      'exist — picking one would be a guess',
    candidates,
  };
}

function pick(c, via, detail) {
  return { profile: c.profile, endpoint: c.endpoint, via, detail, caching: cachingStateOf(c.cachedRoutes) };
}

/** Render the candidate inventory for a human reading a failed run. */
export function formatCandidates(candidates) {
  if (!candidates.length) return '  (none)';
  return candidates
    .map((c) => {
      const dom = c.domains.length ? ` domains=[${c.domains.join(', ')}]` : '';
      return `  profile=${c.profile} endpoint=${c.endpoint} host=${c.hostName || '(none)'}${dom}` +
        ` caching=${cachingStateOf(c.cachedRoutes)}`;
    })
    .join('\n');
}

/* ------------------------------- CLI ---------------------------------- */

async function main(argv) {
  const { readFileSync } = await import('node:fs');
  const urlIdx = argv.indexOf('--url');
  const url = urlIdx >= 0 ? argv[urlIdx + 1] : '';
  const inIdx = argv.indexOf('--input');

  let text = '';
  try {
    text = inIdx >= 0 ? readFileSync(argv[inIdx + 1], 'utf8') : readFileSync(0, 'utf8');
  } catch {
    text = '';
  }

  const profiles = parseRecords(text);
  const r = resolvePurgeTarget({ url, profiles });

  process.stdout.write(
    [
      `state=${r.state}`,
      `profile=${r.profile ?? ''}`,
      `endpoint=${r.endpoint ?? ''}`,
      `via=${r.via ?? ''}`,
      `caching=${r.caching}`,
      `detail=${r.detail}`,
      '',
    ].join('\n'),
  );

  process.stderr.write(
    `[fd-resolve] probed host: ${hostOf(url) || '(unparseable)'}\n` +
      `[fd-resolve] state: ${r.state} — ${r.detail}\n` +
      `[fd-resolve] route caching on the resolved endpoint: ${r.caching}\n` +
      `[fd-resolve] endpoints found:\n${formatCandidates(r.candidates)}\n`,
  );
}

// Run main() only when executed as a script, never when imported by the tests.
const invokedDirectly = await (async () => {
  try {
    const { pathToFileURL } = await import('node:url');
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await main(process.argv.slice(2));
}
