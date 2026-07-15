/**
 * Contract tests for handleSecurityError (the /api/admin/security/** error →
 * HTTP mapper). Focus: the Purview 403 "Not authorized to access account" must
 * become an HONEST GATE (403 + code:'purview_not_authorized' + structured hint)
 * so the panel renders the NotConfiguredBar with the Data Map role remediation,
 * never a raw 403. (audit-t125)
 */
import { describe, it, expect } from 'vitest';
import { handleSecurityError } from '../_lib/error-handling';
import { PurviewError, PurviewNotConfiguredError, notConfiguredHint } from '@/lib/azure/purview-client';

describe('handleSecurityError — Purview', () => {
  it('maps a 403 PurviewError to an honest gate (403 + purview_not_authorized + hint)', async () => {
    const res = handleSecurityError(new PurviewError(403, { error: 'Not authorized to access account' }));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('purview_not_authorized');
    expect(j.status).toBe(403);
    // The structured hint drives the NotConfiguredBar remediation.
    expect(j.hint).toBeTruthy();
    expect(j.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
    expect(Array.isArray(j.hint.rolesRequired)).toBe(true);
    expect(j.hint.followUp).toMatch(/Data Curator|Data Reader/);
    expect(j.hint.followUp).toContain('grant-purview-datamap-role.sh');
  });

  it('maps a 401 PurviewError to the same honest gate', async () => {
    const res = handleSecurityError(new PurviewError(401, null));
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.code).toBe('purview_not_authorized');
    expect(j.hint.followUp).toContain('401');
  });

  it('still propagates a 404 PurviewError as a client error (no gate)', async () => {
    const res = handleSecurityError(new PurviewError(404, null));
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.code).toBe('purview_client_error');
    expect(j.hint).toBeUndefined();
  });

  it('maps a 5xx PurviewError to a 502 upstream error', async () => {
    const res = handleSecurityError(new PurviewError(503, null));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.code).toBe('purview_upstream_error');
  });

  it('maps PurviewNotConfiguredError to 503 + purview_not_configured + hint', async () => {
    const res = handleSecurityError(new PurviewNotConfiguredError(notConfiguredHint('LOOM_PURVIEW_ACCOUNT')));
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('purview_not_configured');
    expect(j.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
  });

  it('does NOT mistake a scan-plane payload 403 (OperationNotAllowed) for a role gate', async () => {
    // Live-proven: registering an Azure source whose properties carry an
    // endpoint but no resourceId answers 403 OperationNotAllowed. That is a
    // request problem, not a missing Data Map role.
    const res = handleSecurityError(new PurviewError(
      403,
      { error: { code: 'OperationNotAllowed', message: 'Azure data source registration requires a valid resourceId when an endpoint is specified.' } },
      'OperationNotAllowed: Azure data source registration requires a valid resourceId when an endpoint is specified.',
    ));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.code).toBe('purview_client_error');
    expect(j.error).toContain('requires a valid resourceId');
    expect(j.hint).toBeUndefined();
  });

  it('propagates a 409 DataSource_Duplicate with the real message (auto-add "exists" path)', async () => {
    const res = handleSecurityError(new PurviewError(
      409,
      { error: { code: 'DataSource_Duplicate', message: 'A data source already exists for this target: lake.dfs.core.windows.net' } },
      'DataSource_Duplicate: A data source already exists for this target: lake.dfs.core.windows.net',
    ));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.code).toBe('purview_client_error');
    expect(j.error).toContain('already exists for this target');
  });
});
