/**
 * Step 2: Connection details for the registration wizard.
 */

import React from 'react';
import type { UseFormRegister, FieldErrors, UseFormSetValue } from 'react-hook-form';
import type { SourceRegistration, SourceType } from '@/types';

interface StepConnectionProps {
  sourceType: SourceType;
  register: UseFormRegister<SourceRegistration>;
  errors: FieldErrors<SourceRegistration>;
  setValue: UseFormSetValue<SourceRegistration>;
}

export default function StepConnection({ sourceType, register, errors, setValue }: StepConnectionProps) {
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
          <label htmlFor="connection-name" className="block text-sm font-medium text-gray-700">
            Source Name <span className="text-red-500">*</span>
          </label>
          <input
            id="connection-name"
            {...register('name', { required: 'Source name is required' })}
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="e.g., USDA Crop Yields"
          />
          {errors.name && (
            <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="connection-domain" className="block text-sm font-medium text-gray-700">
            Domain
          </label>
          <input
            id="connection-domain"
            {...register('domain', {
              // CSA-0118: lowercase-on-blur matches the backend regex so
              // "Finance" auto-normalizes to "finance" instead of failing
              // validation after submit.
              onBlur: (event: React.FocusEvent<HTMLInputElement>) => {
                const normalized = event.target.value.trim().toLowerCase();
                if (normalized !== event.target.value) {
                  setValue('domain', normalized, { shouldValidate: true });
                }
              },
            })}
            type="text"
            inputMode="text"
            autoCapitalize="none"
            spellCheck={false}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="lowercase, e.g. agriculture, transportation, finance"
            aria-describedby="connection-domain-hint"
          />
          <p id="connection-domain-hint" className="mt-1 text-xs text-gray-500">
            Lowercase letters, numbers, and hyphens only. Must start with a letter.
          </p>
          {errors.domain && (
            <p className="mt-1 text-sm text-red-600">
              {String(errors.domain.message ?? 'Invalid domain')}
            </p>
          )}
        </div>
        <div className="col-span-2">
          <label htmlFor="connection-description" className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            id="connection-description"
            {...register('description')}
            rows={3}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-brand-500 focus:ring-brand-500"
            placeholder="Describe this data source..."
          />
        </div>

        {isDatabase && (
          <>
            <div>
              <label htmlFor="connection-host" className="block text-sm font-medium text-gray-700">
                Host / Server <span className="text-red-500">*</span>
              </label>
              <input
                id="connection-host"
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
              <label htmlFor="connection-port" className="block text-sm font-medium text-gray-700">
                Port
              </label>
              <input
                id="connection-port"
                {...register('connection.port', { valueAsNumber: true })}
                type="number"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="1433"
              />
            </div>
            <div>
              <label htmlFor="connection-database" className="block text-sm font-medium text-gray-700">
                Database <span className="text-red-500">*</span>
              </label>
              <input
                id="connection-database"
                {...register('connection.database', { required: 'Database is required' })}
                type="text"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
              />
              {errors.connection?.database && (
                <p className="mt-1 text-sm text-red-600">{errors.connection.database.message}</p>
              )}
            </div>
            <div>
              <label htmlFor="connection-schema-name" className="block text-sm font-medium text-gray-700">
                Schema
              </label>
              <input
                id="connection-schema-name"
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
              <label htmlFor="connection-container" className="block text-sm font-medium text-gray-700">
                Container / Path <span className="text-red-500">*</span>
              </label>
              <input
                id="connection-container"
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
              <label htmlFor="connection-api-url" className="block text-sm font-medium text-gray-700">
                API URL <span className="text-red-500">*</span>
              </label>
              <input
                id="connection-api-url"
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
          <label htmlFor="connection-auth-method" className="block text-sm font-medium text-gray-700">
            Authentication
          </label>
          <select
            id="connection-auth-method"
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
          <label htmlFor="connection-classification" className="block text-sm font-medium text-gray-700">
            Classification
          </label>
          <select
            id="connection-classification"
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
          <label htmlFor="connection-kv-secret" className="block text-sm font-medium text-gray-700">
            Key Vault Secret Name
          </label>
          <input
            id="connection-kv-secret"
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
