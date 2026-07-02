/**
 * /governance/sensitivity — consolidated into the single canonical Sensitivity
 * labels surface at /admin/sensitivity-labels (Loom-native label taxonomy:
 * define / manage / auto-apply). This route is preserved as a redirect so
 * existing links never 404.
 */
import { redirect } from 'next/navigation';

export default function GovernanceSensitivityRedirect() {
  redirect('/admin/sensitivity-labels');
}
