/**
 * Deterministic Stream Analytics job name for an eventstream item.
 *
 * ONE source of truth for the name `standUpEventstreamAzure` creates and for the
 * name the delete/teardown path derives when `state.asaJobName` was never
 * recorded (the auto-bind seed path discards the stand-up result, so the ref can
 * be missing even though the job exists). The name comes from the Cosmos item id
 * only, so the same item always maps to the same job: re-provisioning re-binds
 * (ARM PUT is create-or-update) and teardown can find it with no stored ref.
 *
 * Dependency-free on purpose: importable from tests that mock the ASA client.
 */
export function asaJobNameForItem(id: string | undefined | null): string {
  const slug = (id || '').slice(0, 8).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return slug ? `asa-loom-${slug}` : 'asa-loom';
}
