/**
 * Source Registration Page — Multi-step wizard for data source onboarding.
 */

import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRegisterSource } from '@/hooks/useApi';
import type { SourceRegistration, SourceType, DataQualityRule } from '@/types';

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

const QUALITY_RULE_TYPES = [
  { value: 'not_null', label: 'Not Null' },
  { value: 'unique', label: 'Unique' },
  { value: 'range', label: 'Range Check' },
  { value: 'regex', label: 'Regex Pattern' },
  { value: 'freshness', label: 'Freshness' },
  { value: 'completeness', label: 'Completeness' },
] as const;

const SEVERITY_OPTIONS = [
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
] as const;

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
  errors,
}: {
  sourceType: SourceType;
  register: ReturnType<typeof useForm>['register'];
  errors: Record<string, any>;
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
            Source Name <span className="text-red-500">*</span>
          </label>
          <input
            {...register('source_name', { required: 'Source name is required' })}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., USDA Crop Yields"
          />
          {errors.source_name && (
            <p className="mt-1 text-sm text-red-600">{errors.source_name.message}</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Domain
          </label>
          <input
            {...register('domain')}
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
                Host / Server <span className="text-red-500">*</span>
              </label>
              <input
                {...register('connection.host', { required: 'Host is required' })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="server.database.windows.net"
              />
              {errors.connection?.host && (
                <p className="mt-1 text-sm text-red-600">{errors.connection.host.message}</p>
              )}
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
                Database <span className="text-red-500">*</span>
              </label>
              <input
                {...register('connection.database', { required: 'Database is required' })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
              />
              {errors.connection?.database && (
                <p className="mt-1 text-sm text-red-600">{errors.connection.database.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Schema
              </label>
              <input
                {...register('connection.schema_name')}
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
                Container / Path <span className="text-red-500">*</span>
              </label>
              <input
                {...register('connection.container', { required: 'Container is required' })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="bronze/usda/crop-yields"
              />
              {errors.connection?.container && (
                <p className="mt-1 text-sm text-red-600">{errors.connection.container.message}</p>
              )}
            </div>
          </>
        )}

        {isApi && (
          <>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700">
                API URL <span className="text-red-500">*</span>
              </label>
              <input
                {...register('connection.api_url', { required: 'API URL is required' })}
                type="url"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="https://api.example.gov/v1/data"
              />
              {errors.connection?.api_url && (
                <p className="mt-1 text-sm text-red-600">{errors.connection.api_url.message}</p>
              )}
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

function SchemaStep({
  register,
  watch,
  setValue,
}: {
  register: ReturnType<typeof useForm>['register'];
  watch: ReturnType<typeof useForm>['watch'];
  setValue: ReturnType<typeof useForm>['setValue'];
}) {
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
            <label className="block text-sm font-medium text-gray-700">
              Table Name <span className="text-red-500">*</span>
            </label>
            <input
              {...register('schema_definition._table_name', {
                validate: (value: string) => {
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
            <label className="block text-sm font-medium text-gray-700">
              Watermark Column
            </label>
            <input
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
            <label className="block text-sm font-medium text-gray-700">
              Primary Key Columns
            </label>
            <input
              {...register('schema_definition._primary_key_csv')}
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

function IngestionStep({
  register,
  watch,
  errors,
}: {
  register: ReturnType<typeof useForm>['register'];
  watch: ReturnType<typeof useForm>['watch'];
  errors: Record<string, any>;
}) {
  const ingestionMode = watch('ingestion.mode');

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Ingestion Configuration
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Ingestion Mode <span className="text-red-500">*</span>
          </label>
          <select
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
          <label className="block text-sm font-medium text-gray-700">
            Schedule (cron){' '}
            {(ingestionMode === 'incremental' || ingestionMode === 'full') && (
              <span className="text-red-500">*</span>
            )}
          </label>
          <input
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
          <label className="block text-sm font-medium text-gray-700">
            Batch Size
          </label>
          <input
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
            <option value="avro">Avro</option>
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

function QualityRulesStep({
  qualityRules,
  onAddRule,
  onRemoveRule,
}: {
  qualityRules: DataQualityRule[];
  onAddRule: (rule: DataQualityRule) => void;
  onRemoveRule: (index: number) => void;
}) {
  const [ruleName, setRuleName] = useState('');
  const [ruleType, setRuleType] = useState<DataQualityRule['rule_type']>('not_null');
  const [column, setColumn] = useState('');
  const [severity, setSeverity] = useState<DataQualityRule['severity']>('warning');
  const [addError, setAddError] = useState('');

  const handleAdd = () => {
    if (!ruleName.trim()) {
      setAddError('Rule name is required');
      return;
    }
    setAddError('');
    onAddRule({
      rule_name: ruleName.trim(),
      rule_type: ruleType,
      column: column.trim() || undefined,
      parameters: {},
      severity,
    });
    setRuleName('');
    setColumn('');
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-900">
        Data Quality Rules
      </h2>
      <p className="text-gray-500">
        Define quality gates that will be checked after each ingestion.
        Default rules (freshness, completeness, schema conformance) are applied automatically.
      </p>

      {/* Existing rules */}
      {qualityRules.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700">Configured Rules</h3>
          {qualityRules.map((rule, index) => (
            <div
              key={`${rule.rule_name}-${index}`}
              className="flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-4 py-2"
            >
              <div className="flex items-center gap-3 text-sm">
                <span className="font-medium text-gray-900">{rule.rule_name}</span>
                <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                  {rule.rule_type}
                </span>
                {rule.column && (
                  <span className="text-gray-500">on {rule.column}</span>
                )}
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    rule.severity === 'critical'
                      ? 'bg-red-100 text-red-700'
                      : rule.severity === 'error'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-yellow-100 text-yellow-700'
                  }`}
                >
                  {rule.severity}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onRemoveRule(index)}
                className="text-sm text-red-600 hover:text-red-800"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add rule form */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
        <h3 className="text-sm font-medium text-gray-700">Add Quality Rule</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600">Rule Name</label>
            <input
              type="text"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm focus:border-brand-500 focus:ring-brand-500"
              placeholder="e.g., email_not_null"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Rule Type</label>
            <select
              value={ruleType}
              onChange={(e) => setRuleType(e.target.value as DataQualityRule['rule_type'])}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
            >
              {QUALITY_RULE_TYPES.map((rt) => (
                <option key={rt.value} value={rt.value}>{rt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Column (optional)</label>
            <input
              type="text"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm focus:border-brand-500 focus:ring-brand-500"
              placeholder="e.g., email"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600">Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as DataQualityRule['severity'])}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm text-sm"
            >
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
        {addError && <p className="text-sm text-red-600">{addError}</p>}
        <button
          type="button"
          onClick={handleAdd}
          className="px-4 py-2 text-sm font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded-md hover:bg-brand-100"
        >
          + Add Rule
        </button>
      </div>
    </div>
  );
}

export default function RegisterSourcePage() {
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
      tags: [],
      schema_definition: { auto_detect: true },
    },
  });
  const mutation = useRegisterSource();
  const selectedType = watch('source_type');

  /** Validate the current step before advancing. Returns true if valid. */
  const validateStep = async (currentStep: number): Promise<boolean> => {
    switch (currentStep) {
      case 0:
        // Step 0: Source type must be selected
        return !!selectedType;
      case 1:
        // Step 1: Trigger validation for connection fields
        return trigger(['source_name', 'connection.host', 'connection.database', 'connection.container', 'connection.api_url']);
      case 2:
        // Step 2: Schema — auto-detect or table name required
        return trigger(['schema_definition.auto_detect', 'schema_definition._table_name']);
      case 3:
        // Step 3: Ingestion validation
        return trigger(['ingestion.mode', 'ingestion.schedule_cron', 'ingestion.batch_size']);
      case 4:
        // Step 4: Quality rules — always valid (rules are optional)
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
    try {
      data.quality_rules = qualityRules;
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
            <ConnectionStep sourceType={selectedType} register={register} errors={errors} />
          )}
          {step === 2 && (
            <SchemaStep register={register} watch={watch} setValue={setValue} />
          )}
          {step === 3 && (
            <IngestionStep register={register} watch={watch} errors={errors} />
          )}
          {step === 4 && (
            <QualityRulesStep
              qualityRules={qualityRules}
              onAddRule={handleAddQualityRule}
              onRemoveRule={handleRemoveQualityRule}
            />
          )}
          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-xl font-semibold text-gray-900">
                Review & Submit
              </h2>
              <div className="bg-gray-50 rounded-lg p-6 space-y-3">
                <p>
                  <span className="font-medium">Source:</span>{' '}
                  {watch('source_name') || 'Not set'}
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
