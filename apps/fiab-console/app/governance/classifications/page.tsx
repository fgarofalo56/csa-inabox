/**
 * /governance/classifications — consolidated into the single canonical
 * Classifications surface at /admin/classifications (Loom-native classification
 * rules: create / edit / delete + scan, no Microsoft Purview required). This
 * route is preserved as a redirect so existing links never 404.
 */
import { redirect } from 'next/navigation';

export default function GovernanceClassificationsRedirect() {
  redirect('/admin/classifications');
}
