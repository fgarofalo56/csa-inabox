// PHI redaction rules (LHDS W2-5). Pure data + regexes; no I/O.
//
// DESIGN. Two kinds of rule:
//   - ALLOW-LIST rules (query strings, metric labels): everything is redacted/dropped
//     unless it is on a short list of known-safe names with a constrained value shape.
//     An unknown future search parameter therefore fails CLOSED.
//   - PATTERN rules (JSON keys, HAPI error messages, SSN/e-mail/DICOM shapes): known
//     PHI-bearing shapes. These can only catch what they were written for - see README.
export const REDACTED = '[REDACTED]';
export const REDACTED_MESSAGE = '[REDACTED-MESSAGE]';

// Search/format parameters that are safe to log, each with the value shape it may carry.
// A value outside the shape is redacted even for an allowed key, so `_count=<name>` cannot
// smuggle a value through.
export const QUERY_ALLOW = new Map([
  ['_count', /^\d{1,5}$/],
  ['_offset', /^\d{1,9}$/],
  ['_getpagesoffset', /^\d{1,9}$/],
  ['_total', /^(none|estimate|accurate)$/],
  ['_summary', /^(true|false|count|data|text)$/],
  ['_pretty', /^(true|false)$/],
  ['_format', /^(json|xml|ttl|application\/fhir\+json|application\/fhir\+xml)$/],
  ['_sort', /^-?[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/],
  ['_elements', /^[A-Za-z0-9_.,]{1,128}$/],
  ['_include', /^[A-Za-z0-9_.:*-]{1,96}$/],
  ['_revinclude', /^[A-Za-z0-9_.:*-]{1,96}$/],
]);

// Where a query string can sit inside a log line. Group 1 = the introducer, group 2 = an
// optional opening quote, group 3 = the query text (up to whitespace, a quote, or a closing
// bracket/brace).
//   Params[?_count=5&family=X]           HAPI access log
//   url.query=family=X&_count=5          OTel span / metric exemplar attribute (quoted or not)
//   https://host/fhir/Patient?family=X   url.full, referers, redirects
// The `[REDACTED]` alternative lets a second pass read its own output (idempotence): without
// it the closing `]` of a token would end the segment early.
export const QUERY_SEGMENT = /(url\.query=|\?)("?)((?:\[REDACTED\]|[^\s"\]}])*)/g;

// Keys whose value is PHI whenever they appear as a JSON key (e.g. a resource fragment echoed
// into a log line). Case-insensitive, whole quoted key only.
export const PHI_JSON_KEYS = [
  'family', 'given', 'prefix', 'suffix', 'text', 'birthDate', 'deceasedDateTime', 'value',
  'line', 'city', 'district', 'state', 'postalCode', 'country', 'display', 'name',
  'patientName', 'patientID', 'patientBirthDate', 'telecom', 'ssn', 'mrn', 'email', 'phone',
];
export const JSON_KEY_RULE = new RegExp(
  `("(?:${PHI_JSON_KEYS.join('|')})"\\s*:\\s*)(\\[[^\\]]*\\]|"(?:[^"\\\\]|\\\\.)*"|[^,}\\s]+)`,
  'gi',
);

// HAPI/Spring exception lines echo request content in the message ("Invalid attribute value
// "X""). The class and the HAPI-NNNN code are kept (they are what an operator needs); the
// rest of the message is dropped.
// Group 1 = prefix through the exception class, group 2 = the optional HAPI code.
export const REST_FAILURE_RULE = /(Failure during REST processing:\s*\S+:)\s*(?:(HAPI-\d+:)\s*)?.*$/;
export const HAPI_ECHO_RULE =
  /(HAPI-\d+:)(?=.*(?:Failed to parse|Invalid (?:attribute|element|content)|Unknown \w+ code|Unrecognized))\s*.*$/;

// Value-shaped identifiers.
export const SHAPE_RULES = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED-EMAIL]'],
  [/\bMRN[ :=#-]*[A-Za-z0-9-]{3,}/gi, '[REDACTED-MRN]'],
  [/\bDOB[ :=]+\S+/gi, '[REDACTED-DOB]'],
  // DICOM: tag form "(0010,0010) PN [DOE^JOHN]" and keyword form PatientName=... / PatientID=...
  [/\(0010,00(?:10|20|30|40)\)[^\n]*/g, '[REDACTED-DICOM-TAG]'],
  [/\b(PatientName|PatientID|PatientBirthDate)\s*[=:]\s*\S+/gi, '$1=[REDACTED]'],
];

// Attribute / label handling for structured telemetry.
// Keys whose mere presence means "body or header payload": dropped, never scrubbed.
export const DROP_KEY =
  /(^|[._-])(body|payload|content|parameters?|header|headers|cookie|authorization)([._-]|$)/i;
// Metric labels: deny by default. Only these survive (bounded cardinality, non-PHI).
export const METRIC_LABEL_ALLOW = new Set([
  'http.request.method', 'http.response.status_code', 'http.route', 'url.scheme',
  'network.protocol.name', 'network.protocol.version', 'server.address', 'server.port',
  'error.type', 'service.name', 'fhir.operation', 'fhir.resource_type', 'db.system',
  'db.operation', 'db.operation.name', 'status', 'result', 'outcome',
]);
