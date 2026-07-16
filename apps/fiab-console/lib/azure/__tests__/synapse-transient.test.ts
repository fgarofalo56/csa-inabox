import { describe, it, expect } from 'vitest';
import { classifyTransientSynapseError } from '../synapse-transient';

describe('classifyTransientSynapseError', () => {
  it('classifies serverless cold-start signatures', () => {
    expect(classifyTransientSynapseError('Login timeout expired')?.code).toBe('synapse_cold_start');
    expect(classifyTransientSynapseError('Connection was closed by the remote host (ESOCKET)')?.code).toBe('synapse_cold_start');
  });

  it('classifies storage RBAC propagation signatures', () => {
    expect(classifyTransientSynapseError('Cannot bulk load. Operating system error code 5 (Access is denied.)')?.code).toBe('storage_propagating');
    expect(classifyTransientSynapseError("Content of directory on path 'https://x.dfs.core.windows.net/c/p/' cannot be listed")?.code).toBe('storage_propagating');
  });

  it('classifies not-yet-visible files', () => {
    expect(classifyTransientSynapseError("Cannot bulk load because the file 'x.csv' does not exist")?.code).toBe('file_not_ready');
  });

  it('returns null for real SQL errors so they surface verbatim', () => {
    expect(classifyTransientSynapseError("Incorrect syntax near 'SELCT'")).toBeNull();
    expect(classifyTransientSynapseError('')).toBeNull();
  });

  it('strips HTML before matching (gateway error pages)', () => {
    expect(classifyTransientSynapseError('<html><body>403 Forbidden</body></html>')?.code).toBe('storage_propagating');
  });
});
