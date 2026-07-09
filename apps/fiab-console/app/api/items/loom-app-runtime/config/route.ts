/**
 * GET /api/items/loom-app-runtime/config
 *
 * Type-level (no per-tenant resource): returns the fixed runtime-template
 * catalog (Streamlit/Dash/Gradio/Flask/Express — dropdown source, no freeform
 * config) plus the deployment-wide infra status (whether LOOM_APPS_CAE_ID /
 * LOOM_APPS_ACR_LOGIN_SERVER + the UAMI role are wired). The editor renders its
 * full surface either way; when unconfigured it shows an honest MessageBar
 * naming the missing env + bicep module. Shared backend resolved by TYPE — auth
 * is signed-in + deployment RBAC (allowlisted in check-route-guards).
 */
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { LOOM_APP_TEMPLATES } from '@/lib/azure/loom-apps-runtime-templates';
import { loomAppsConfigStatus } from '@/lib/azure/loom-apps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const status = loomAppsConfigStatus();
    // Ship the template metadata + starter files so the editor can seed Monaco.
    const templates = LOOM_APP_TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      runtime: t.runtime,
      defaultPort: t.defaultPort,
      entryFile: t.entryFile,
      manifestFile: t.manifestFile,
      files: t.files,
    }));
    return apiOk({ templates, infra: status });
  } catch (e) {
    return apiServerError(e, 'failed to read Loom Apps config');
  }
}
