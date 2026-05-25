import { redirect } from 'next/navigation';

/**
 * /items - no item picked. Bounce to /workspaces. The + New item
 * dialog is what actually creates items, and editor URLs always
 * include both /[type] and /[id].
 */
export default function ItemsLanding() {
  redirect('/workspaces');
}
