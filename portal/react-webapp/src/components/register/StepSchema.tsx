/**
 * Step 3: Schema definition for the registration wizard.
 */

import React from 'react';
import type { UseFormRegister, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import type { SourceRegistration } from '@/types';

interface StepSchemaProps {
  register: UseFormRegister<SourceRegistration>;
  watch: UseFormWatch<SourceRegistration>;
  setValue: UseFormSetValue<SourceRegistration>;
}

export default function StepSchema({ register, watch, setValue }: StepSchemaProps) {
  const autoDetect = watch('schema_definition.auto_detect');

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Schema Definition
      </h2>
      <p className="text-gray-500">
        Configure how the schema for this data source should be determined.
      </p>

      {/* Auto-detect toggle */}
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="auto-detect"
          {...register('schema_definition.auto_detect')}
          className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
        />
        <label htmlFor="auto-detect" className="text-sm font-medium text-gray-700">
          Auto-detect schema during provisioning
        </label>
      </div>

      {!autoDetect && (
        <div className="space-y-4">
          <div>
            <label htmlFor="schema-table-name" className="block text-sm font-medium text-gray-700">
              Table Name <span className="text-red-500">*</span>
            </label>
            <input
              id="schema-table-name"
              {...register('schema_definition.table_name', {
                validate: (value: string | undefined) => {
                  if (!autoDetect && !value) return 'Table name is required when auto-detect is off';
                  return true;
                },
              })}
              type="text"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
              placeholder="e.g., dbo.crop_yields"
            />
          </div>

          <div>
            <label htmlFor="schema-watermark-column" className="block text-sm font-medium text-gray-700">
              Watermark Column
            </label>
            <input
              id="schema-watermark-column"
              {...register('schema_definition.watermark_column')}
              type="text"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
              placeholder="e.g., updated_at"
            />
            <p className="mt-1 text-xs text-gray-400">
              Used for incremental ingestion to track changes.
            </p>
          </div>

          <div>
            <label htmlFor="schema-primary-key" className="block text-sm font-medium text-gray-700">
              Primary Key Columns
            </label>
            <input
              id="schema-primary-key"
              {...register('schema_definition.primary_key_csv')}
              type="text"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
              placeholder="e.g., id, composite_key_col (comma-separated)"
            />
            <p className="mt-1 text-xs text-gray-400">
              Comma-separated list of primary key column names.
            </p>
          </div>
        </div>
      )}

      {autoDetect && (
        <div className="bg-gray-50 rounded-lg p-8 text-center">
          <p className="text-gray-400">
            Schema auto-detection will run when the source is provisioned.
          </p>
        </div>
      )}
    </div>
  );
}
