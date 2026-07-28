import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/model-fabric — kept as a stable deep link (IA-04).
 *
 * The closed-loop promote/demote Model Fabric is now the "Model Fabric" TAB of
 * the AI operations hub. ModelFabricPanel is unchanged — moved, not rewritten.
 */
export default function ModelFabricRedirect() {
  redirect('/admin/ai-operations?tab=fabric');
}
