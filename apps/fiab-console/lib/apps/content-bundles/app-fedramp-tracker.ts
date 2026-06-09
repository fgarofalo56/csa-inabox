// FedRAMP Compliance Tracker bundle — NIST 800-53 control scorecard + Sentinel/ADX-backed
// compliance-events KQL dashboard. Sourced from examples/cybersecurity/.
import type { AppBundle, StatusRule } from './types';

// Shared per-family status rules: On Track ≥ 90% controls implemented, At Risk
// ≥ 75%, otherwise Behind. Applied to each control family; the parent rolls up
// via worst-child (Min) aggregation.
const NIST_FAMILY_STATUS_RULES: StatusRule[] = [
  { operator: '>=', threshold: 90, metricKind: 'value', status: 'on-track' },
  { operator: '>=', threshold: 75, metricKind: 'value', status: 'at-risk' },
];

const bundle: AppBundle = {
  appId: 'app-fedramp-tracker',
  intro:
    '# FedRAMP Compliance Tracker\n\n' +
    'Continuous monitoring of NIST 800-53 Rev 5 control implementation across Loom-deployed ' +
    'services. The scorecard tracks 13 control families (AC, AU, AT, CM, CP, IA, IR, MP, RA, ' +
    'SA, SC, SI, SR) with a "% controls implemented" metric and current maturity. The KQL ' +
    'dashboard sits over a Sentinel-backed ADX cluster and surfaces alert volume, MITRE ' +
    'technique distribution, MTTD, top-risk users, and live compliance posture from the ' +
    'medallion cyber pipeline (`bronze.stg_sentinel_alerts` -> `silver.fct_security_alerts` ' +
    '-> `gold.rpt_compliance_posture`).\n\n' +
    '> Targets are FedRAMP-aligned (Moderate baseline by default; flip to High by setting ' +
    '`LOOM_FEDRAMP_BASELINE=high`). Sample current values reflect a representative agency ' +
    'mid-ATO maturity — replace with live evidence from your CMDB + Sentinel workspace.',
  sourceDocs: [
    'examples/cybersecurity/README.md',
    'examples/cybersecurity/contracts/sentinel-alerts.yaml',
    'examples/cybersecurity/domains/bronze/stg_sentinel_alerts.sql',
    'examples/cybersecurity/domains/silver/dim_mitre_techniques.sql',
    'examples/cybersecurity/domains/silver/fct_security_alerts.sql',
    'examples/cybersecurity/domains/gold/rpt_compliance_posture.sql',
    'examples/cybersecurity/domains/gold/rpt_threat_landscape.sql',
    'examples/cybersecurity/notebooks/03-kql-threat-hunting.py',
  ],
  items: [
    {
      itemType: 'scorecard',
      displayName: 'NIST 800-53 Control Families — FedRAMP Moderate',
      description:
        '13 NIST 800-53 Rev 5 control families with FedRAMP Moderate-baseline implementation ' +
        'targets. Each OKR tracks "% controls implemented" against the FedRAMP Moderate ' +
        'baseline. Current values are sample mid-ATO maturity — wire to the live evidence ' +
        'source (e.g., the gold.rpt_compliance_posture table) before relying on them.',
      learnDoc: 'examples/cybersecurity',
      content: {
        kind: 'scorecard',
        okrs: [
          {
            id: 'nist-overall',
            name: 'NIST 800-53 Overall Compliance',
            description:
              'Aggregate FedRAMP Moderate compliance score rolled up from all 13 NIST 800-53 control families using worst-child (Min) aggregation — the parent reflects the weakest-link family, the standard compliance-scorecard semantic. Status: On Track ≥ 90, At Risk ≥ 75, otherwise Behind.',
            metric: '% controls implemented',
            target: 100,
            rollupMethod: 'min',
            statusRules: [
              { operator: '>=', threshold: 90, metricKind: 'value', status: 'on-track' },
              { operator: '>=', threshold: 75, metricKind: 'value', status: 'at-risk' },
            ],
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-AC',
            name: 'AC — Access Control',
            description:
              'NIST 800-53 AC family. Account management, access enforcement, information flow enforcement, separation of duties, least privilege, unsuccessful logon attempts, system use notification, session lock, concurrent session control, remote access. FedRAMP Moderate baseline: 25 controls including AC-2, AC-3, AC-4, AC-6, AC-7, AC-17.',
            metric: '% controls implemented',
            target: 100,
            current: 92,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-AU',
            name: 'AU — Audit and Accountability',
            description:
              'NIST 800-53 AU family. Event logging, content of audit records, audit record storage, response to audit logging process failures, audit review/analysis/reporting, time stamps, protection of audit information, non-repudiation, audit record retention. FedRAMP Moderate baseline: 14 controls including AU-2, AU-3, AU-6, AU-9, AU-11, AU-12.',
            metric: '% controls implemented',
            target: 100,
            current: 88,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-AT',
            name: 'AT — Awareness and Training',
            description:
              'NIST 800-53 AT family. Literacy training and awareness, role-based training, training records, contacts with security groups and associations. FedRAMP Moderate baseline: 4 controls including AT-2, AT-3, AT-4.',
            metric: '% controls implemented',
            target: 100,
            current: 95,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-CM',
            name: 'CM — Configuration Management',
            description:
              'NIST 800-53 CM family. Baseline configuration, configuration change control, security impact analysis, access restrictions for change, configuration settings, least functionality, information system component inventory, configuration management plan, software usage restrictions, user-installed software. FedRAMP Moderate baseline: 11 controls including CM-2, CM-6, CM-7, CM-8.',
            metric: '% controls implemented',
            target: 100,
            current: 84,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-CP',
            name: 'CP — Contingency Planning',
            description:
              'NIST 800-53 CP family. Contingency plan, contingency training, contingency plan testing, alternate storage site, alternate processing site, telecommunications services, system backup, system recovery and reconstitution. FedRAMP Moderate baseline: 10 controls including CP-2, CP-4, CP-6, CP-7, CP-9, CP-10.',
            metric: '% controls implemented',
            target: 100,
            current: 81,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-IA',
            name: 'IA — Identification and Authentication',
            description:
              'NIST 800-53 IA family. Identification and authentication (organizational users), device identification and authentication, identifier management, authenticator management, authenticator feedback, cryptographic module authentication, identification and authentication (non-organizational users). FedRAMP Moderate baseline: 12 controls including IA-2 (with phishing-resistant MFA), IA-4, IA-5, IA-8.',
            metric: '% controls implemented',
            target: 100,
            current: 90,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-IR',
            name: 'IR — Incident Response',
            description:
              'NIST 800-53 IR family. Incident response training, incident response testing, incident handling, incident monitoring, incident reporting, incident response assistance, incident response plan, information spillage response. FedRAMP Moderate baseline: 10 controls including IR-2, IR-4, IR-6, IR-8.',
            metric: '% controls implemented',
            target: 100,
            current: 86,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-MP',
            name: 'MP — Media Protection',
            description:
              'NIST 800-53 MP family. Media access, media marking, media storage, media transport, media sanitization, media use. FedRAMP Moderate baseline: 7 controls including MP-2, MP-3, MP-6, MP-7.',
            metric: '% controls implemented',
            target: 100,
            current: 93,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-RA',
            name: 'RA — Risk Assessment',
            description:
              'NIST 800-53 RA family. Security categorization, risk assessment, vulnerability monitoring and scanning, risk response, criticality analysis, threat hunting. FedRAMP Moderate baseline: 5 controls including RA-2, RA-3, RA-5 (continuous vulnerability scanning).',
            metric: '% controls implemented',
            target: 100,
            current: 79,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-SA',
            name: 'SA — System and Services Acquisition',
            description:
              'NIST 800-53 SA family. Allocation of resources, system development life cycle, acquisition process, system documentation, security and privacy engineering principles, external system services, developer configuration management, developer testing and evaluation, supply chain risk management. FedRAMP Moderate baseline: 12 controls including SA-4, SA-8, SA-9, SA-11.',
            metric: '% controls implemented',
            target: 100,
            current: 82,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-SC',
            name: 'SC — System and Communications Protection',
            description:
              'NIST 800-53 SC family. Separation of system and user functionality, security function isolation, denial-of-service protection, boundary protection, transmission confidentiality and integrity, cryptographic key establishment and management, cryptographic protection, collaborative computing devices, public key infrastructure certificates, mobile code, voice over internet protocol. FedRAMP Moderate baseline: 20 controls including SC-7, SC-8, SC-12, SC-13, SC-28.',
            metric: '% controls implemented',
            target: 100,
            current: 87,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-SI',
            name: 'SI — System and Information Integrity',
            description:
              'NIST 800-53 SI family. Flaw remediation, malicious code protection, system monitoring, security alerts/advisories/directives, security and privacy function verification, software/firmware/information integrity, spam protection, information input validation, error handling, information management and retention, memory protection. FedRAMP Moderate baseline: 17 controls including SI-2, SI-3, SI-4, SI-7.',
            metric: '% controls implemented',
            target: 100,
            current: 89,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
          {
            id: 'nist-SR',
            name: 'SR — Supply Chain Risk Management',
            description:
              'NIST 800-53 SR family. Supply chain risk management plan, acquisition strategies/tools/methods, supply chain controls and processes, provenance, supplier assessments and reviews, notification agreements, tamper resistance and detection, inspection of systems or components, component authenticity. FedRAMP Moderate baseline: 8 controls including SR-2, SR-3, SR-5, SR-6, SR-11.',
            metric: '% controls implemented',
            target: 100,
            current: 78,
            parentId: 'nist-overall',
            statusRules: NIST_FAMILY_STATUS_RULES,
            otherwiseStatus: 'behind',
          },
        ],
      },
    },
    {
      itemType: 'kql-dashboard',
      displayName: 'Compliance Events Dashboard',
      description:
        'Sentinel-backed ADX dashboard. 7 tiles surfacing alert volume, open incidents, ' +
        'MTTD, MITRE technique distribution, daily trend, top risk users, and live ' +
        'compliance posture from `gold.rpt_compliance_posture`. Queries are KQL against ' +
        'the cybersecurity medallion tables registered as ADX external tables.',
      learnDoc: 'examples/cybersecurity',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          {
            title: 'Total alerts (last 24h)',
            viz: 'card',
            kql:
              "bronze.stg_sentinel_alerts\n" +
              "| where time_generated > ago(24h)\n" +
              "| summarize TotalAlerts = dcount(alert_id)",
          },
          {
            title: 'Open high/critical incidents',
            viz: 'card',
            kql:
              "silver.fct_security_alerts\n" +
              "| where time_generated > ago(30d)\n" +
              "| where severity_level >= 3\n" +
              "| where status in ('New', 'InProgress', 'Investigating')\n" +
              "| summarize OpenIncidents = dcount(alert_id)",
          },
          {
            title: 'Mean time to detect (minutes)',
            viz: 'card',
            kql:
              "silver.fct_security_alerts\n" +
              "| where time_generated > ago(30d)\n" +
              "| extend detect_delay_min = datetime_diff('minute', processed_at, time_generated)\n" +
              "| summarize MTTD_minutes = round(avg(detect_delay_min), 1)",
          },
          {
            title: 'Alerts by MITRE technique (top 15, 30d)',
            viz: 'bar',
            kql:
              "silver.fct_security_alerts\n" +
              "| where time_generated > ago(30d)\n" +
              "| where isnotempty(technique_id)\n" +
              "| join kind=leftouter (silver.dim_mitre_techniques) on technique_id\n" +
              "| summarize AlertCount = dcount(alert_id), AvgRisk = round(avg(composite_risk_score), 2)\n" +
              "    by technique_id, technique_name, tactic_name\n" +
              "| top 15 by AlertCount desc\n" +
              "| project technique_id, technique_name, tactic_name, AlertCount, AvgRisk",
          },
          {
            title: 'Alert trend — daily (30d, severity stacked)',
            viz: 'line',
            kql:
              "silver.fct_security_alerts\n" +
              "| where time_generated > ago(30d)\n" +
              "| summarize AlertCount = dcount(alert_id)\n" +
              "    by bin(time_generated, 1d), severity_label\n" +
              "| order by time_generated asc\n" +
              "| render timechart with (kind=stacked, ytitle='Alerts per day')",
          },
          {
            title: 'Top 10 risk users (30d)',
            viz: 'table',
            kql:
              "silver.fct_security_alerts\n" +
              "| where time_generated > ago(30d)\n" +
              "| where array_length(account_entities) > 0\n" +
              "| mv-expand entity = account_entities\n" +
              "| extend user_principal = tostring(entity.Name)\n" +
              "| summarize\n" +
              "    AlertCount = dcount(alert_id),\n" +
              "    MaxRisk = max(composite_risk_score),\n" +
              "    AvgRisk = round(avg(composite_risk_score), 2),\n" +
              "    Tactics = make_set(tactic_name, 8),\n" +
              "    LastAlert = max(time_generated)\n" +
              "    by user_principal\n" +
              "| top 10 by AvgRisk desc",
          },
          {
            title: 'Compliance posture by NIST control family (30d)',
            viz: 'pie',
            kql:
              "gold.rpt_compliance_posture\n" +
              "| summarize\n" +
              "    ControlsAtRisk = countif(compliance_status == 'At Risk'),\n" +
              "    ControlsNeedingReview = countif(compliance_status == 'Needs Review'),\n" +
              "    ControlsMonitored = countif(compliance_status == 'Monitored'),\n" +
              "    ControlsNoActivity = countif(compliance_status == 'No Activity')\n" +
              "    by control_family_id, control_family_name\n" +
              "| order by ControlsAtRisk desc, ControlsNeedingReview desc",
          },
          {
            title: 'Top 10 remediation priorities (30d)',
            viz: 'table',
            kql:
              "gold.rpt_compliance_posture\n" +
              "| where alert_count_30d > 0\n" +
              "| project\n" +
              "    control_family_id,\n" +
              "    control_id,\n" +
              "    control_name,\n" +
              "    associated_tactic,\n" +
              "    alert_count_30d,\n" +
              "    max_severity,\n" +
              "    avg_risk_score,\n" +
              "    compliance_status,\n" +
              "    remediation_priority,\n" +
              "    latest_alert\n" +
              "| top 10 by remediation_priority desc",
          },
        ],
      },
    },
  ],
};

export default bundle;
