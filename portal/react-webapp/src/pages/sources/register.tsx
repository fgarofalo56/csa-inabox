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
import { useRegisterSource } from '@/hooks/useApi';
import type { SourceRegistration, DataQualityRule } from '@/types';
import {
  StepSourceType,
  StepConnection,
  StepSchema,
  StepIngestion,
  StepQuality,
  StepReview,
} from '@/components/register';

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
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    trigger,
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
    await mutation.mutateAsync(data);
    router.push('/sources');
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

        {mutation.isError && (
          <div className="rounded-md bg-red-50 border border-red-200 p-4">
            <p className="text-sm text-red-700">
              Registration failed:{' '}
              {(mutation.error as Error)?.message || 'An unexpected error occurred. Please try again.'}
            </p>
          </div>
        )}

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
