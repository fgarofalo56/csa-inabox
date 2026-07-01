/**
 * /governance/domains — consolidated into the single canonical Domains surface
 * at /admin/domains (the Fabric-parity management surface with full CRUD,
 * delegated settings, workspace assignment, and Purview/Unity mirroring). This
 * route is preserved as a redirect so existing links never 404.
 */
import { redirect } from 'next/navigation';

export default function GovernanceDomainsRedirect() {
  redirect('/admin/domains');
}
