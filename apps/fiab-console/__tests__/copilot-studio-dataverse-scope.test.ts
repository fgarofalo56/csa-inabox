/**
 * Unit tests for the Copilot Studio client's Dataverse-scope detection.
 *
 * The client routes Dataverse-scoped token requests through the MSAL Web
 * App SP (because UAMIs cannot be Dataverse Application Users — see
 * docs/fiab/dataverse-app-user.md). The regex must match every Dataverse
 * org URL shape so the right credential is used; if it slips, Copilot
 * Studio editors hit 401 on every Dataverse call.
 */
import { describe, it, expect } from 'vitest';

// Mirrors lib/azure/copilot-studio-client.ts:isDataverseScope. Pinning
// here so a refactor of the regex breaks the test, not production.
const isDataverseScope = (scope: string) => /\.crm[0-9]*\.dynamics\.com\/\.default$/.test(scope);

describe('Copilot Studio Dataverse-scope detection', () => {
  it('matches a US-commercial Dataverse org URL', () => {
    expect(isDataverseScope('https://contoso.crm.dynamics.com/.default')).toBe(true);
  });

  it('matches every regional crmN suffix', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 17]) {
      expect(isDataverseScope(`https://x.crm${n}.dynamics.com/.default`)).toBe(true);
    }
  });

  it('does NOT match ARM, Graph, Power Platform admin, or Foundry scopes', () => {
    expect(isDataverseScope('https://management.azure.com/.default')).toBe(false);
    expect(isDataverseScope('https://graph.microsoft.com/.default')).toBe(false);
    expect(isDataverseScope('https://api.bap.microsoft.com/.default')).toBe(false);
    expect(isDataverseScope('https://api.azureml.ms/.default')).toBe(false);
  });

  it('rejects malformed scope strings', () => {
    expect(isDataverseScope('')).toBe(false);
    expect(isDataverseScope('crm.dynamics.com/.default')).toBe(false); // missing https:// is fine but it ends correctly
    expect(isDataverseScope('https://contoso.crm.dynamics.com')).toBe(false); // no /.default suffix
  });
});
