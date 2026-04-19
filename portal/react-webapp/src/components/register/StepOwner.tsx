/**
 * Step 5: Owner information for the registration wizard.
 *
 * Captures the required `owner.team` field that the backend rejects without
 * (see portal/shared/api/models/source.py::OwnerInfo). The `name` and
 * `email` fields are auto-populated from the active MSAL account (read-only
 * in the UI) and `cost_center` / `data_product` are optional.
 */

import React from 'react';
import type { UseFormRegister, UseFormWatch, FieldErrors } from 'react-hook-form';
import type { SourceRegistration } from '@/types';

interface StepOwnerProps {
  register: UseFormRegister<SourceRegistration>;
  watch: UseFormWatch<SourceRegistration>;
  errors: FieldErrors<SourceRegistration>;
}

export default function StepOwner({ register, watch, errors }: StepOwnerProps) {
  // Primary identity fields (name/email) come from MSAL via setValue in the
  // parent. Display-only to prevent accidental edits to the authenticated
  // identity while still sending the values with the submission.
  const ownerName = watch('owner.name') ?? '';
  const ownerEmail = watch('owner.email') ?? '';

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Owner Information
      </h2>
      <p className="text-sm text-gray-500">
        The data source owner is the point of contact for access requests,
        quality alerts, and lifecycle decisions. Name and email are taken from
        your sign-in — provide the owning team so the platform knows who is
        accountable.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label htmlFor="owner-name" className="block text-sm font-medium text-gray-700">
            Owner Name
          </label>
          <input
            id="owner-name"
            type="text"
            value={ownerName}
            readOnly
            aria-readonly="true"
            className="mt-1 block w-full rounded-md border-gray-300 bg-gray-50 text-gray-700 shadow-sm"
          />
          <p className="mt-1 text-xs text-gray-500">From your sign-in account.</p>
          {/* Keep the value registered so it is submitted with the form. */}
          <input type="hidden" {...register('owner.name')} />
        </div>
        <div>
          <label htmlFor="owner-email" className="block text-sm font-medium text-gray-700">
            Owner Email
          </label>
          <input
            id="owner-email"
            type="email"
            value={ownerEmail}
            readOnly
            aria-readonly="true"
            className="mt-1 block w-full rounded-md border-gray-300 bg-gray-50 text-gray-700 shadow-sm"
          />
          <p className="mt-1 text-xs text-gray-500">From your sign-in account.</p>
          <input type="hidden" {...register('owner.email')} />
        </div>
        <div>
          <label htmlFor="owner-team" className="block text-sm font-medium text-gray-700">
            Team <span className="text-red-500">*</span>
          </label>
          <input
            id="owner-team"
            type="text"
            maxLength={128}
            {...register('owner.team', { required: 'Team is required' })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., Data Platform Engineering"
            aria-required="true"
            aria-invalid={errors.owner?.team ? 'true' : 'false'}
          />
          {errors.owner?.team && (
            <p className="mt-1 text-sm text-red-600" role="alert">
              {errors.owner.team.message}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="owner-cost-center" className="block text-sm font-medium text-gray-700">
            Cost Center
          </label>
          <input
            id="owner-cost-center"
            type="text"
            maxLength={64}
            {...register('owner.cost_center')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., CC-12345"
          />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="owner-data-product" className="block text-sm font-medium text-gray-700">
            Data Product
          </label>
          <input
            id="owner-data-product"
            type="text"
            maxLength={128}
            // `owner.data_product` is a UI-only field; the shared contract
            // does not declare it so we cast register through any. When the
            // backend adds the field we can remove the cast.
            {...(register as unknown as (name: string) => object)('owner.data_product')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., Crop Yield Analytics"
          />
          <p className="mt-1 text-xs text-gray-500">
            Optional — the data product this source contributes to.
          </p>
        </div>
      </div>
    </div>
  );
}
