/**
 * Step 1: Source Type selection for the registration wizard.
 */

import React from 'react';
import type { SourceType } from '@/types';

export const SOURCE_TYPES: { value: SourceType; label: string; category: string }[] = [
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

interface StepSourceTypeProps {
  selectedType?: SourceType;
  onSelect: (type: SourceType) => void;
}

export default function StepSourceType({ selectedType, onSelect }: StepSourceTypeProps) {
  // Array.from() instead of [...new Set(...)] because tsconfig.json targets
  // es5 (the spread-Set form requires --downlevelIteration or es2015+).
  const categories = Array.from(new Set(SOURCE_TYPES.map((s) => s.category)));

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
