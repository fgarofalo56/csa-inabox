/**
 * Managed-identity credential for the MAF app. Mirrors the Console's
 * `ChainedTokenCredential(ManagedIdentityCredential, DefaultAzureCredential)`
 * pattern so the same UAMI (set via AZURE_CLIENT_ID) authenticates AOAI calls.
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

const clientId = process.env.AZURE_CLIENT_ID || process.env.LOOM_UAMI_CLIENT_ID;

export const credential: TokenCredential = clientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();
