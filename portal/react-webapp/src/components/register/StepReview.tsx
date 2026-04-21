/**
 * Step 6: Review & submit for the registration wizard.
 *
 * CSA-0124(13): adds a "Validation summary" panel that enumerates any
 * fields currently failing validation and points the user back to the
 * originating wizard step. The intent is to prevent blind submission
 * with lurking errors — the Register button stays enabled so users can
 * still force-submit, but the summary makes it obvious which step owns
 * each issue.
 */

import React from 'react';
import type { FieldErrors, UseFormWatch } from 'react-hook-form';
import type { SourceRegistration, DataQualityRule } from '@/types';

interface StepReviewProps {
  watch: UseFormWatch<SourceRegistration>;
  qualityRules: DataQualityRule[];
  /** react-hook-form `formState.errors`. Required for the validation panel. */
  errors?: FieldErrors<SourceRegistration>;
  /**
   * Jump-to-step callback — used by the validation summary's "Fix" links.
   * Accepts the 0-based index of the step that owns the invalid field.
   */
  onJumpToStep?: (stepIndex: number) => void;
}

/** Dotted paths we expect to see reported by react-hook-form. */
type FieldPath =
  | 'name'
  | 'source_type'
  | 'description'
  | 'domain'
  | 'classification'
  | `connection.${string}`
  | `schema_definition.${string}`
  | `ingestion.${string}`
  | `target.${string}`
  | `owner.${string}`;

/** A single error surfaced in the validation panel. */
interface FlatError {
  path: string;
  message: string;
  /** Which wizard step index owns this field? */
  stepIndex: number;
  stepTitle: string;
}

const STEP_FOR_PREFIX: Array<{ prefix: string; index: number; title: string }> = [
  { prefix: 'source_type', index: 0, title: 'Source Type' },
  { prefix: 'connection', index: 1, title: 'Connection' },
  { prefix: 'name', index: 1, title: 'Connection' },
  { prefix: 'domain', index: 1, title: 'Connection' },
  { prefix: 'description', index: 1, title: 'Connection' },
  { prefix: 'classification', index: 1, title: 'Connection' },
  { prefix: 'schema_definition', index: 2, title: 'Schema' },
  { prefix: 'ingestion', index: 3, title: 'Ingestion' },
  { prefix: 'target', index: 3, title: 'Ingestion' },
  { prefix: 'quality_rules', index: 4, title: 'Quality' },
  { prefix: 'owner', index: 5, title: 'Owner' },
];

function locateStep(path: string): { index: number; title: string } {
  const match = STEP_FOR_PREFIX.find(({ prefix }) =>
    path === prefix || path.startsWith(`${prefix}.`),
  );
  return match
    ? { index: match.index, title: match.title }
    : { index: 6, title: 'Review' };
}

/**
 * Walk the nested react-hook-form errors object and produce a flat list of
 * {path, message, step} entries. react-hook-form stores each error as
 * `{ type, message, ref }` at the leaf node, so we detect a leaf by the
 * presence of `.message` on an object.
 */
function flattenErrors(
  errors: FieldErrors<SourceRegistration> | undefined,
  prefix = '',
): FlatError[] {
  if (!errors || typeof errors !== 'object') return [];
  const out: FlatError[] = [];
  for (const [key, value] of Object.entries(errors)) {
    if (!value || typeof value !== 'object') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    // Leaf error nodes have a `.message` string and (usually) a `.type`.
    // react-hook-form may also include `.ref`. We treat any object with a
    // string `.message` as a leaf.
    const maybeMessage = (value as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.length > 0) {
      const step = locateStep(path);
      out.push({
        path,
        message: maybeMessage,
        stepIndex: step.index,
        stepTitle: step.title,
      });
      // Don't descend into the same node once we've captured the message.
      continue;
    }
    // Recurse into nested objects (react-hook-form nests `connection`,
    // `owner`, etc. so their leaf errors look like `owner.email`).
    out.push(
      ...flattenErrors(
        value as FieldErrors<SourceRegistration>,
        path,
      ),
    );
  }
  return out;
}

function ValidationSummary({
  errors,
  onJumpToStep,
}: {
  errors?: FieldErrors<SourceRegistration>;
  onJumpToStep?: (stepIndex: number) => void;
}) {
  const items = React.useMemo(() => flattenErrors(errors), [errors]);
  const summaryId = 'review-validation-summary';

  if (items.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-md border border-green-200 bg-green-50 p-4"
      >
        <p className="text-sm font-medium text-green-800">
          All required fields are filled in. Ready to submit.
        </p>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={summaryId}
      className="rounded-md border border-red-200 bg-red-50 p-4"
    >
      <h3 id={summaryId} className="text-sm font-semibold text-red-800">
        Validation summary — {items.length} issue{items.length === 1 ? '' : 's'} to resolve
      </h3>
      <p className="mt-1 text-xs text-red-700">
        Fix the fields below before submitting. Each link jumps back to the
        step where the field originates.
      </p>
      <ul className="mt-3 space-y-1 text-sm text-red-800">
        {items.map((item) => (
          <li key={item.path} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-1 h-1.5 w-1.5 rounded-full bg-red-500" />
            <span className="flex-1">
              <code className="text-xs text-red-900">{item.path}</code>
              <span className="mx-1 text-red-600">—</span>
              <span>{item.message}</span>
            </span>
            {onJumpToStep ? (
              <button
                type="button"
                onClick={() => onJumpToStep(item.stepIndex)}
                aria-label={`Fix ${item.path} on the ${item.stepTitle} step`}
                className="text-xs font-medium text-red-700 underline hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 rounded"
              >
                Fix in {item.stepTitle}
              </button>
            ) : (
              <span className="text-xs text-red-600">in {item.stepTitle}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function StepReview({ watch, qualityRules, errors, onJumpToStep }: StepReviewProps) {
  const ownerName = watch('owner.name') || 'Not set';
  const ownerEmail = watch('owner.email') || 'Not set';
  const ownerTeam = watch('owner.team') || 'Not set';
  const ownerCostCenter = watch('owner.cost_center') || 'Not set';
  // `data_product` is a UI-only owner field (see StepOwner). Cast through
  // unknown because the shared contract does not declare it.
  const ownerDataProduct =
    ((watch as unknown as (n: string) => string | undefined)('owner.data_product')) || 'Not set';

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">
        Review & Submit
      </h2>

      {/* CSA-0124(13): validation summary at the TOP so it's the first
          thing reviewers see. Green when clean, red with jump-links when
          there are outstanding issues. */}
      <ValidationSummary errors={errors} onJumpToStep={onJumpToStep} />

      <div className="bg-gray-50 rounded-lg p-6 space-y-3">
        <p>
          <span className="font-medium">Source:</span>{' '}
          {watch('name') || 'Not set'}
        </p>
        <p>
          <span className="font-medium">Type:</span>{' '}
          {watch('source_type') || 'Not set'}
        </p>
        <p>
          <span className="font-medium">Domain:</span>{' '}
          {watch('domain') || 'Not set'}
        </p>
        <p>
          <span className="font-medium">Classification:</span>{' '}
          {watch('classification')}
        </p>
        <p>
          <span className="font-medium">Ingestion Mode:</span>{' '}
          {watch('ingestion.mode')}
        </p>
        <p>
          <span className="font-medium">Target Format:</span>{' '}
          {watch('target.format')}
        </p>
        <p>
          <span className="font-medium">Quality Rules:</span>{' '}
          {qualityRules.length > 0
            ? `${qualityRules.length} rule(s) configured`
            : 'Default rules will be applied'}
        </p>
        <p>
          <span className="font-medium">Schema:</span>{' '}
          {watch('schema_definition.auto_detect')
            ? 'Auto-detect'
            : 'Manual configuration'}
        </p>
      </div>

      <h3 className="text-base font-semibold text-gray-900 pt-2">Owner</h3>
      <div className="bg-gray-50 rounded-lg p-6 space-y-3" data-testid="review-owner">
        <p>
          <span className="font-medium">Name:</span> {ownerName}
        </p>
        <p>
          <span className="font-medium">Email:</span> {ownerEmail}
        </p>
        <p>
          <span className="font-medium">Team:</span> {ownerTeam}
        </p>
        <p>
          <span className="font-medium">Cost Center:</span> {ownerCostCenter}
        </p>
        <p>
          <span className="font-medium">Data Product:</span> {ownerDataProduct}
        </p>
      </div>
    </div>
  );
}

// Re-export for tests / other consumers that want the validation helpers.
export { ValidationSummary, flattenErrors };
export type { FieldPath, FlatError };
