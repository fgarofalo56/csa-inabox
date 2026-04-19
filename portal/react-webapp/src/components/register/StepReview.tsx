/**
 * Step 6: Review & submit for the registration wizard.
 */

import React from 'react';
import type { UseFormWatch } from 'react-hook-form';
import type { SourceRegistration, DataQualityRule } from '@/types';

interface StepReviewProps {
  watch: UseFormWatch<SourceRegistration>;
  qualityRules: DataQualityRule[];
}

export default function StepReview({ watch, qualityRules }: StepReviewProps) {
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
