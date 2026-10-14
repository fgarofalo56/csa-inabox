import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loomServerCredential } from './aca-managed-identity';
import { aasSuffix } from './cloud-endpoints';

export interface AasDiscoveryResult {
  servable: boolean;
  probed: boolean;
  detail: string;
}

/** Discovery only: no environment-selected server/model or mutation. */
export async function probeAasServer(serverUri: string, serverName: string): Promise<AasDiscoveryResult> {
  const unknown = (detail: string, probed = false): AasDiscoveryResult => ({
    servable: false, probed, detail: `AAS readiness is unverified: ${detail}`,
  });
  let uri: URL;
  try { uri = new URL(serverUri); } catch { return unknown('ARM returned no valid server connection URI.'); }
  const suffix = aasSuffix();
  if (!['asazure.windows.net', 'asazure.usgovcloudapi.net'].includes(suffix)
    || uri.protocol !== 'asazure:' || uri.username || uri.password || uri.port || uri.search || uri.hash
    || !uri.hostname.endsWith(`.${suffix}`)
    || !/^[a-z0-9-]+$/.test(uri.hostname.slice(0, -(suffix.length + 1)))
    || !/^[a-zA-Z0-9-]+$/.test(serverName)
    || uri.pathname.toLowerCase() !== `/${serverName.toLowerCase()}`) {
    return unknown('ARM connection URI does not match the verified server and cloud.');
  }
  let token;
  try {
    // AAS resource audience contains a literal '*', not a server placeholder.
    token = await loomServerCredential.getToken(`https://*.${suffix}/.default`, {
      abortSignal: AbortSignal.timeout(15_000),
    });
  } catch { return unknown('the console could not obtain an AAS access token.'); }
  if (!token || !token.token || token.expiresOnTimestamp <= Date.now() || token.token.length > 24_000) {
    return unknown('the console did not obtain a usable AAS access token.');
  }
  return new Promise((resolve) => {
    let finished = false;
    let output = '';
    const child = spawn(join(process.cwd(), 'tools', 'aas-probe', 'aas-probe'), [], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      // Do not inherit credentials, configuration, or loader overrides.
      env: { NODE_ENV: 'production', DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    });
    const finish = (result: AasDiscoveryResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(unknown('XMLA discovery timed out.', true)), 20_000);
    child.on('error', () => finish(unknown('the packaged XMLA client could not start.')));
    child.stdin.on('error', () => finish(unknown('the XMLA client input channel failed.')));
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 4096) finish(unknown('the XMLA client returned an oversized response.', true));
    });
    child.on('close', (code) => {
      if (finished) return;
      try {
        const result = JSON.parse(output) as { ok?: boolean; catalogCount?: number };
        if (code === 0 && result.ok === true && Number.isSafeInteger(result.catalogCount)
          && result.catalogCount! >= 0) {
          finish({ servable: true, probed: true,
            detail: `${serverName} answered server-level XMLA catalog discovery (${result.catalogCount} visible catalogs); model-query readiness was not tested.` });
          return;
        }
      } catch { /* Never expose stdout or exception text: it may contain a token. */ }
      finish(unknown('XMLA discovery did not succeed; access, connectivity, and server readiness were not established.', true));
    });
    child.stdin.end(JSON.stringify({ ServerUri: serverUri, Token: token.token,
      ExpiresOnTimestamp: token.expiresOnTimestamp }));
  });
}
