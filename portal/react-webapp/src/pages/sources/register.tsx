/**
 * Source Registration Page — Multi-step wizard for data source onboarding.
 *
 * Each step is implemented as a standalone component in
 * src/components/register/. This file orchestrates step navigation,
 * form state, and submission.
 */

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useForm } from 'react-hook-form';
import { useMsal } from '@azure/msal-react';
import { z } from 'zod';
import { useRegisterSource } from '@/hooks/useApi';
import { useToast } from '@/hooks/useToast';
import { Toast } from '@/components/Toast';
import type { SourceRegistration, DataQualityRule } from '@/types';
import {
  StepSourceType,
  StepConnection,
  StepSchema,
  StepIngestion,
  StepQuality,
  StepReview,
} from '@/components/register';

// ─── Zod validation schema for source registration ───────────────────────

const SOURCE_TYPES = [
  'azure_sql', 'synapse', 'cosmos_db', 'adls_gen2', 'blob_storage',
  'databricks', 'postgresql', 'mysql', 'oracle', 'rest_api',
  'odata', 'sftp', 'sharepoint', 'event_hub', 'iot_hub', 'kafka',
] as const;

const sourceRegistrationSchema = z.object({
  name: z
    .string()
    .min(3, 'Source name must be at least 3 characters')
    .max(128, 'Source name must be at most 128 characters')
    .regex(/^[a-zA-Z0-9_\-\s]+$/, 'Name may only contain letters, numbers, spaces, hyphens, and underscores'),
  source_type: z.enum(SOURCE_TYPES, { message: 'Please select a source type' }),
  description: z.string().max(1000, 'Description must be at most 1000 characters').optional(),
  domain: z.string().min(1, 'Domain is required').optional(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted', 'cui', 'fouo']),
  connection: z.object({
    host: z.string().min(1, 'Host is required').optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    database: z.string().optional(),
    schema_name: z.string().optional(),
    container: z.string().optional(),
    path: z.string().optional(),
    api_url: z.string().url('Must be a valid URL').optional(),
    authentication_method: z.string().optional(),
    key_vault_secret_name: z.string().optional(),
  }).optional(),
  schema_definition: z.object({
    auto_detect: z.boolean().optional(),
    table_name: z.string().optional(),
  }).optional(),
  ingestion: z.object({
    mode: z.enum(['full', 'incremental', 'cdc', 'streaming']),
    schedule_cron: z.string().optional(),
    batch_size: z.coerce.number().int().min(1).max(1_000_000).optional(),
    parallelism: z.coerce.number().int().min(1).max(64).optional(),
    max_retry_count: z.coerce.number().int().min(0).max(10).optional(),
    timeout_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  }),
  target: z.object({
    landing_zone: z.string(),
    container: z.string(),
    path_pattern: z.string(),
    format: z.enum(['delta', 'parquet', 'csv', 'json']),
  }),
  owner: z.object({
    name: z.string().min(1, 'Owner name is required'),
    email: z.string().email('Must be a valid email address'),
    team: z.string().optional(),
    cost_center: z.string().optional(),
  }).optional(),
  quality_rules: z.array(z.any()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * Inline Zod resolver for react-hook-form (avoids @hookform/resolvers dependency).
 * Parses form data against the schema and maps Zod errors to react-hook-form format.
 */
function zodResolver(schema: z.ZodType) {
  return async (values: Record<string, unknown>) => {
    const result = schema.safeParse(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }
    const fieldErrors: Record<string, { type: string; message: string }> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      if (!fieldErrors[path]) {
        fieldErrors[path] = { type: issue.code, message: issue.message };
      }
    }
    return { values: {}, errors: fieldErrors };
  };
}

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

export default function RegisterSourcePage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [qualityRules, setQualityRules] = useState<DataQualityRule[]>([]);
  const { toast, showToast, setOpen: setToastOpen } = useToast();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    trigger,
    setError,
    formState: { errors },
  } = useForm<SourceRegistration>({
    defaultValues: {
      ingestion: { mode: 'full' },
      target: { format: 'delta', container: 'bronze', path_pattern: '', landing_zone: '' },
      classification: 'internal',
      quality_rules: [],
      tags: {},
      schema_definition: { auto_detect: true },
    },
  });
  const mutation = useRegisterSource();
  const selectedType = watch('source_type');
  const { accounts } = useMsal();

  // Auto-populate owner from the active MSAL account
  useEffect(() => {
    const account = accounts[0];
    if (account) {
      setValue('owner.name', account.name ?? '');
      setValue('owner.email', account.username ?? '');
    }
  }, [accounts, setValue]);

  /** Validate the current step before advancing. Returns true if valid. */
  const validateStep = async (currentStep: number): Promise<boolean> => {
    switch (currentStep) {
      case 0:
        return !!selectedType;
      case 1:
        return trigger(['name', 'connection.host', 'connection.database', 'connection.container', 'connection.api_url']);
      case 2:
        return trigger(['schema_definition.auto_detect', 'schema_definition.table_name']);
      case 3:
        return trigger(['ingestion.mode', 'ingestion.schedule_cron', 'ingestion.batch_size']);
      case 4:
        return true;
      default:
        return true;
    }
  };

  const handleNext = async () => {
    const valid = await validateStep(step);
    if (valid) {
      setStep(Math.min(STEPS.length - 1, step + 1));
    }
  };

  const handleAddQualityRule = (rule: DataQualityRule) => {
    const updated = [...qualityRules, rule];
    setQualityRules(updated);
    setValue('quality_rules', updated);
  };

  const handleRemoveQualityRule = (index: number) => {
    const updated = qualityRules.filter((_, i) => i !== index);
    setQualityRules(updated);
    setValue('quality_rules', updated);
  };

  const onSubmit = async (data: SourceRegistration) => {
    data.quality_rules = qualityRules;

    // Run Zod validation before submission
    const result = sourceRegistrationSchema.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') as keyof SourceRegistration;
        if (path) {
          setError(path, { type: issue.code, message: issue.message });
        }
      }
      showToast('Please fix validation errors before submitting.', 'error');
      return;
    }

    try {
      await mutation.mutateAsync(data);
      showToast('Source registered successfully', 'success');
      // Allow toast to be visible briefly before navigating
      setTimeout(() => router.push('/sources'), 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.';
      showToast(`Registration failed: ${message}`, 'error');
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
            <StepSourceType
              selectedType={selectedType}
              onSelect={(type) => setValue('source_type', type)}
            />
          )}
          {step === 1 && (
            <StepConnection sourceType={selectedType} register={register} errors={errors} />
          )}
          {step === 2 && (
            <StepSchema register={register} watch={watch} setValue={setValue} />
          )}
          {step === 3 && (
            <StepIngestion register={register} watch={watch} errors={errors} />
          )}
          {step === 4 && (
            <StepQuality
              qualityRules={qualityRules}
              onAddRule={handleAddQualityRule}
              onRemoveRule={handleRemoveQualityRule}
            />
          )}
          {step === 5 && (
            <StepReview watch={watch} qualityRules={qualityRules} />
          )}
        </div>

        <Toast
          open={toast.open}
          onOpenChange={setToastOpen}
          message={toast.message}
          variant={toast.variant}
        />

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
              onClick={handleNext}
              disabled={step === 0 && !selectedType}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-md hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
