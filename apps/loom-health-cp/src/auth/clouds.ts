// Per-cloud hosts for the Authorization Server (security.md A5). Mirrors
// apps/fiab-console/lib/azure/cloud-endpoints.ts (a separate package, so the
// values are mirrored and pinned by test/auth-core.test.ts). GCC is public-cloud
// Azure under a government-community identity.

import type { Cloud } from '../config.js';

export const GRAPH_BY_CLOUD: Record<Cloud, string> = {
  commercial: 'graph.microsoft.com',
  gcc: 'graph.microsoft.com',
  'gcc-high': 'graph.microsoft.us',
  il5: 'graph.microsoft.us',
  dod: 'dod-graph.microsoft.us',
};

export const KEYVAULT_SUFFIX_BY_CLOUD: Record<Cloud, string> = {
  commercial: 'vault.azure.net',
  gcc: 'vault.azure.net',
  'gcc-high': 'vault.usgovcloudapi.net',
  il5: 'vault.usgovcloudapi.net',
  dod: 'vault.usgovcloudapi.net',
};

export const graphScope = (c: Cloud): string => `https://${GRAPH_BY_CLOUD[c]}/.default`;
export const keyVaultScope = (c: Cloud): string => `https://${KEYVAULT_SUFFIX_BY_CLOUD[c]}/.default`;
