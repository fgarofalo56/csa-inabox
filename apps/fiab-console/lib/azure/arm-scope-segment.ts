/**
 * ARM resource-id segment handling for role-assignment scopes.
 *
 * A role-assignment scope is an ARM resource id assembled from caller-supplied
 * names (a container, a resource group, an account). Each name must be exactly
 * ONE path segment of that id, so every segment is validated and then
 * percent-encoded before it is placed in the id:
 *
 *   - empty, `.` and `..` are refused (they would collapse or climb the path);
 *   - a literal `/` or `\` is refused (it would add a segment);
 *   - a percent-encoded `/`, `\` or `.` (`%2f`, `%5c`, `%2e`, any case) is
 *     refused, because ARM decodes the path before routing it;
 *   - `?`, `#`, whitespace and control characters are refused (they would end
 *     the path or change how it is parsed).
 *
 * Dependency-free so it can be unit-tested without the Azure SDK.
 */

export class ArmScopeSegmentError extends Error {
  constructor(label: string, value: string, reason: string) {
    super(`Invalid ${label} ${JSON.stringify(value)} for a role-assignment scope: ${reason}.`);
    this.name = 'ArmScopeSegmentError';
  }
}

const ENCODED_SEPARATOR = /%(2f|5c|2e)/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[/\\?#\s\u0000-\u001f\u007f]/;

/**
 * Validate `value` as a single ARM resource-id segment and return it
 * percent-encoded. Throws {@link ArmScopeSegmentError} when it is not one.
 */
export function armScopeSegment(value: unknown, label: string): string {
  const s = typeof value === 'string' ? value : '';
  if (!s) throw new ArmScopeSegmentError(label, s, 'it is empty');
  if (s === '.' || s === '..') throw new ArmScopeSegmentError(label, s, 'it is a relative path segment');
  if (ENCODED_SEPARATOR.test(s)) {
    throw new ArmScopeSegmentError(label, s, 'it contains an encoded path separator or dot');
  }
  if (FORBIDDEN_CHARS.test(s)) {
    throw new ArmScopeSegmentError(label, s, 'it must be a single path segment');
  }
  return encodeURIComponent(s);
}

/** A GUID-shaped role-assignment name. */
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const CONTAINER_ROLE_ASSIGNMENT_ID = new RegExp(
  '^/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\\.Storage/storageAccounts/([^/]+)'
    + `/blobServices/default/containers/([^/]+)/providers/Microsoft\\.Authorization/roleAssignments/(${GUID})$`,
  'i',
);

/**
 * Validate a role-assignment ARM id before it is revoked: it must be a
 * container-scoped role assignment on storage account `account`, every segment
 * must pass {@link armScopeSegment}, and the account must match (case-
 * insensitively, as ARM compares it). Returns the id unchanged.
 */
export function assertContainerRoleAssignmentId(id: unknown, account: string): string {
  const s = typeof id === 'string' ? id : '';
  const m = CONTAINER_ROLE_ASSIGNMENT_ID.exec(s);
  if (!m) {
    throw new ArmScopeSegmentError(
      'role-assignment id', s,
      'it is not a container-scoped Storage role assignment',
    );
  }
  const [, sub, rg, acct, container] = m;
  armScopeSegment(sub, 'subscription id');
  armScopeSegment(rg, 'resource group');
  armScopeSegment(acct, 'storage account');
  armScopeSegment(container, 'container');
  if (acct.toLowerCase() !== account.toLowerCase()) {
    throw new ArmScopeSegmentError(
      'role-assignment id', s,
      `it is not on the configured storage account "${account}"`,
    );
  }
  return s;
}
