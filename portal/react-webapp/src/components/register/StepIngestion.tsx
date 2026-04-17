/**
 * Step 4: Ingestion configuration for the registration wizard.
 */

import React from 'react';
import type { UseFormRegister, UseFormWatch, FieldErrors } from 'react-hook-form';
import type { SourceRegistration } from '@/types';

interface StepIngestionProps {
  register: UseFormRegister<SourceRegistration>;
  watch: UseFormWatch<SourceRegistration>;
  errors: FieldErrors<SourceRegistration>;
}

export default function StepIngestion({ register, watch, errors }: StepIngestionProps) {
  const ingestionMode = watch('ingestion.mode');

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Ingestion Configuration
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label htmlFor="ingestion-mode" className="block text-sm font-medium text-gray-700">
            Ingestion Mode <span className="text-red-500">*</span>
          </label>
          <select
            id="ingestion-mode"
            {...register('ingestion.mode', { required: 'Ingestion mode is required' })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          >
            <option value="">Select mode...</option>
            <option value="full">Full Load</option>
            <option value="incremental">Incremental</option>
            <option value="cdc">Change Data Capture (CDC)</option>
            <option value="streaming">Streaming</option>
          </select>
          {errors.ingestion?.mode && (
            <p className="mt-1 text-sm text-red-600">{errors.ingestion.mode.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="ingestion-schedule" className="block text-sm font-medium text-gray-700">
            Schedule (cron){' '}
            {(ingestionMode === 'incremental' || ingestionMode === 'full') && (
              <span className="text-red-500">*</span>
            )}
          </label>
          <input
            id="ingestion-schedule"
            {...register('ingestion.schedule_cron', {
              validate: (value: string) => {
                if ((ingestionMode === 'incremental' || ingestionMode === 'full') && !value) {
                  return 'Schedule is required for this ingestion mode';
                }
                return true;
              },
            })}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="0 */6 * * * (every 6 hours)"
          />
          {errors.ingestion?.schedule_cron && (
            <p className="mt-1 text-sm text-red-600">{errors.ingestion.schedule_cron.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="ingestion-batch-size" className="block text-sm font-medium text-gray-700">
            Batch Size
          </label>
          <input
            id="ingestion-batch-size"
            {...register('ingestion.batch_size', {
              valueAsNumber: true,
              validate: (value: number) => {
                if (value != null && value !== 0 && value < 1) {
                  return 'Batch size must be greater than 0';
                }
                return true;
              },
            })}
            type="number"
            min="1"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="10000"
          />
          {errors.ingestion?.batch_size && (
            <p className="mt-1 text-sm text-red-600">{errors.ingestion.batch_size.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="ingestion-timeout" className="block text-sm font-medium text-gray-700">
            Timeout (minutes)
          </label>
          <input
            id="ingestion-timeout"
            {...register('ingestion.timeout_minutes', { valueAsNumber: true })}
            type="number"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="60"
          />
        </div>
        <div>
          <label htmlFor="ingestion-target-format" className="block text-sm font-medium text-gray-700">
            Target Format
          </label>
          <select
            id="ingestion-target-format"
            {...register('target.format')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          >
            <option value="delta">Delta Lake</option>
            <option value="parquet">Parquet</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <div>
          <label htmlFor="ingestion-landing-zone" className="block text-sm font-medium text-gray-700">
            Landing Zone
          </label>
          <input
            id="ingestion-landing-zone"
            {...register('target.landing_zone')}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="dlz-001"
          />
        </div>
      </div>
    </div>
  );
}
