/**
 * Source Registration Page — Multi-step wizard for data source onboarding.
 */

import React, { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useRegisterSource } from '@/hooks/useApi';
import type { SourceRegistration, SourceType, IngestionMode, ClassificationLevel } from '@/types';

const SOURCE_TYPES: { value: SourceType; label: string; category: string }[] = [
  { value: 'azure_sql', label: 'Azure SQL Database', category: 'Database' },
  { value: 'synapse', label: 'Synapse Analytics', category: 'Database' },
  { value: 'cosmos_db', label: 'Cosmos DB', category: 'Database' },
  { value: 'postgresql', label: 'PostgreSQL', category: 'Database' },
  { value: 'mysql', label: 'MySQL', category: 'Database' },
  { value: 'oracle', label: 'Oracle', category: 'Database' },
  { value: 'adls_gen2', label: 'ADLS Gen2', category: 'Storage' },
  { value: 'blob_storage', label: 'Blob Storage', category: 'Storage' },
  { value: 'sftp', label: 'SFTP', category: 'Storage' },
  { value: 'sharepoint', label: 'SharePoint', category: 'Storage' },
  { value: 'rest_api', label: 'REST API', category: 'API' },
  { value: 'odata', label: 'OData', category: 'API' },
  { value: 'event_hub', label: 'Event Hub', category: 'Streaming' },
  { value: 'iot_hub', label: 'IoT Hub', category: 'Streaming' },
  { value: 'kafka', label: 'Kafka', category: 'Streaming' },
  { value: 'databricks', label: 'Databricks', category: 'Compute' },
];

const STEPS = [
  { id: 'type', title: 'Source Type', description: 'Select your data source' },
  { id: 'connection', title: 'Connection', description: 'Configure connectivity' },
  { id: 'schema', title: 'Schema', description: 'Define data schema' },
  { id: 'ingestion', title: 'Ingestion', description: 'Set schedule and mode' },
  { id: 'quality', title: 'Quality', description: 'Data quality rules' },
  { id: 'review', title: 'Review', description: 'Confirm and submit' },
];

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <nav aria-label="Progress" className="mb-8">
      <ol className="flex items-center">
        {STEPS.map((step, index) => (
          <li
            key={step.id}
            className={`relative ${index !== STEPS.length - 1 ? 'flex-1' : ''}`}
          >
            <div className="flex items-center">
              <span
                className={`
                  flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium
                  ${
                    index < currentStep
                      ? 'bg-brand-600 text-white'
                      : index === currentStep
                        ? 'border-2 border-brand-600 text-brand-600'
                        : 'border-2 border-gray-300 text-gray-500'
                  }
                `}
              >
                {index < currentStep ? '\u2713' : index + 1}
              </span>
              {index !== STEPS.length - 1 && (
                <div
                  className={`h-0.5 w-full ${
                    index < currentStep ? 'bg-brand-600' : 'bg-gray-300'
                  }`}
                />
              )}
            </div>
            <span className="mt-2 block text-xs text-gray-500">
              {step.title}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SourceTypeStep({
  selectedType,
  onSelect,
}: {
  selectedType?: SourceType;
  onSelect: (type: SourceType) => void;
}) {
  const categories = [...new Set(SOURCE_TYPES.map((s) => s.category))];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Select Data Source Type
      </h2>
      {categories.map((category) => (
        <div key={category}>
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-3">
            {category}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {SOURCE_TYPES.filter((s) => s.category === category).map(
              (source) => (
                <button
                  key={source.value}
                  type="button"
                  onClick={() => onSelect(source.value)}
                  className={`
                    p-4 rounded-lg border-2 text-left transition-colors
                    ${
                      selectedType === source.value
                        ? 'border-brand-600 bg-brand-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }
                  `}
                >
                  <span className="text-sm font-medium text-gray-900">
                    {source.label}
                  </span>
                </button>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConnectionStep({
  sourceType,
  register,
}: {
  sourceType: SourceType;
  register: ReturnType<typeof useForm>['register'];
}) {
  const isDatabase = ['azure_sql', 'synapse', 'postgresql', 'mysql', 'oracle'].includes(sourceType);
  const isStorage = ['adls_gen2', 'blob_storage', 'sftp', 'sharepoint'].includes(sourceType);
  const isApi = ['rest_api', 'odata'].includes(sourceType);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Connection Details
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Source Name
          </label>
          <input
            {...register('name', { required: true })}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., USDA Crop Yields"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Domain
          </label>
          <input
            {...register('domain', { required: true })}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., agriculture, transportation"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            {...register('description')}
            rows={3}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="Describe this data source..."
          />
        </div>

        {isDatabase && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Host / Server
              </label>
              <input
                {...register('connection.host', { required: true })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="server.database.windows.net"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Port
              </label>
              <input
                {...register('connection.port', { valueAsNumber: true })}
                type="number"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="1433"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Database
              </label>
              <input
                {...register('connection.database', { required: true })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Schema
              </label>
              <input
                {...register('connection.schema')}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="dbo"
              />
            </div>
          </>
        )}

        {isStorage && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Container / Path
              </label>
              <input
                {...register('connection.container', { required: true })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="bronze/usda/crop-yields"
              />
            </div>
          </>
        )}

        {isApi && (
          <>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700">
                API URL
              </label>
              <input
                {...register('connection.api_url', { required: true })}
                type="url"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="https://api.example.gov/v1/data"
              />
            </div>
          </>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Authentication
          </label>
          <select
            {...register('connection.authentication_method')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          >
            <option value="managed_identity">Managed Identity</option>
            <option value="service_principal">Service Principal</option>
            <option value="key_vault">Key Vault Secret</option>
            <option value="api_key">API Key</option>
            <option value="oauth2">OAuth 2.0</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Classification
          </label>
          <select
            {...register('classification')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          >
            <option value="public">Public</option>
            <option value="internal">Internal</option>
            <option value="confidential">Confidential</option>
            <option value="restricted">Restricted</option>
            <option value="cui">CUI (Controlled Unclassified)</option>
            <option value="fouo">FOUO (For Official Use Only)</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Key Vault Secret Name
          </label>
          <input
            {...register('connection.key_vault_secret_name')}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="source-connection-string"
          />
        </div>
      </div>
    </div>
  );
}

function IngestionStep({
  register,
}: {
  register: ReturnType<typeof useForm>['register'];
}) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Ingestion Configuration
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Ingestion Mode
          </label>
          <select
            {...register('ingestion.mode')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          >
            <option value="full">Full Load</option>
            <option value="incremental">Incremental</option>
            <option value="cdc">Change Data Capture (CDC)</option>
            <option value="streaming">Streaming</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Schedule (cron)
          </label>
          <input
            {...register('ingestion.schedule_cron')}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="0 */6 * * * (every 6 hours)"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Batch Size
          </label>
          <input
            {...register('ingestion.batch_size', { valueAsNumber: true })}
            type="number"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="10000"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Timeout (minutes)
          </label>
          <input
            {...register('ingestion.timeout_minutes', { valueAsNumber: true })}
            type="number"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="60"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Target Format
          </label>
          <select
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
          <label className="block text-sm font-medium text-gray-700">
            Landing Zone
          </label>
          <input
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

export default function RegisterSourcePage() {
  const [step, setStep] = useState(0);
  const { register, handleSubmit, watch, setValue } = useForm<SourceRegistration>({
    defaultValues: {
      ingestion: { mode: 'full' },
      target: { format: 'delta', container: 'bronze', path_pattern: '' },
      classification: 'internal',
      quality_rules: [],
      tags: {},
    },
  });
  const mutation = useRegisterSource();
  const selectedType = watch('source_type');

  const onSubmit = async (data: SourceRegistration) => {
    try {
      await mutation.mutateAsync(data);
      // Redirect to source list on success
      window.location.href = '/sources';
    } catch (error) {
      console.error('Registration failed:', error);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Register Data Source
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Onboard a new data source to the platform
        </p>
      </div>

      <StepIndicator currentStep={step} />

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          {step === 0 && (
            <SourceTypeStep
              selectedType={selectedType}
              onSelect={(type) => setValue('source_type', type)}
            />
          )}
          {step === 1 && (
            <ConnectionStep sourceType={selectedType} register={register} />
          )}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-gray-900">
                Schema Definition
              </h2>
              <p className="text-gray-500">
                Schema will be auto-detected during provisioning. You can
                optionally define columns manually.
              </p>
              <div className="bg-gray-50 rounded-lg p-8 text-center">
                <p className="text-gray-400">
                  Schema auto-detection will run when the source is provisioned.
                </p>
              </div>
            </div>
          )}
          {step === 3 && <IngestionStep register={register} />}
          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-gray-900">
                Data Quality Rules
              </h2>
              <p className="text-gray-500">
                Define quality gates that will be checked after each ingestion.
              </p>
              <div className="bg-gray-50 rounded-lg p-8 text-center">
                <p className="text-gray-400">
                  Default quality rules (freshness, completeness, schema
                  conformance) will be applied automatically.
                </p>
              </div>
            </div>
          )}
          {step === 5 && (
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
                  {selectedType || 'Not set'}
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
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex justify-between">
          <button
            type="button"
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            Previous
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep(Math.min(STEPS.length - 1, step + 1))}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700"
            >
              Next
            </button>
          ) : (
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-6 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {mutation.isPending ? 'Registering...' : 'Register Source'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
