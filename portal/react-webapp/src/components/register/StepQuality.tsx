/**
 * Step 5: Data quality rules for the registration wizard.
 */

import React, { useState } from 'react';
import type { DataQualityRule } from '@/types';

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

interface StepQualityProps {
  qualityRules: DataQualityRule[];
  onAddRule: (rule: DataQualityRule) => void;
  onRemoveRule: (index: number) => void;
}

export default function StepQuality({ qualityRules, onAddRule, onRemoveRule }: StepQualityProps) {
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
