/**
 * /catalog/domains — consolidated into the single canonical Domains surface at
 * /admin/domains (full domain CRUD + delegated settings + workspace assignment,
 * written through 1:1 to Microsoft Purview collections and Databricks Unity
 * Catalog — no Microsoft Fabric required). This route is preserved as a redirect
 * so existing links never 404.
 */
import { redirect } from 'next/navigation';

export default function CatalogDomainsRedirect() {
  redirect('/admin/domains');
}
