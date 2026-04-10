// k6 load test for the AI Enrichment Function HTTP trigger.
//
// Run:
//   k6 run tests/load/k6_ai_enrichment.js \
//     --env BASE_URL=https://<function-app>.azurewebsites.net \
//     --env FUNCTION_KEY=$FUNCTION_KEY \
//     --vus 50 --duration 2m
//
// Thresholds enforce the same acceptance targets documented in
// tests/load/README.md, so the run exits non-zero on regression.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
const FUNCTION_KEY = __ENV.FUNCTION_KEY;

if (!BASE_URL) {
  throw new Error('BASE_URL env var is required');
}
if (!FUNCTION_KEY) {
  throw new Error('FUNCTION_KEY env var is required');
}

export const options = {
  // Ramp 0 -> 50 VUs, hold 2 min, ramp down.
  stages: [
    { duration: '30s', target: 50 },
    { duration: '2m', target: 50 },
    { duration: '20s', target: 0 },
  ],
  // Fail the run if any of these thresholds are breached.
  thresholds: {
    http_req_failed: ['rate<0.01'],          // <1% error rate
    http_req_duration: ['p(95)<1500', 'p(99)<3000'],
    'enrich_latency': ['p(95)<1500'],
    'enrich_errors': ['rate<0.01'],
  },
};

const enrichLatency = new Trend('enrich_latency');
const enrichErrors = new Rate('enrich_errors');

const SAMPLE_TEXTS = [
  'The quick brown fox jumps over the lazy dog. This is a short sample for language and sentiment detection.',
  'Customer reported a positive experience with the new onboarding flow, completing signup in under two minutes.',
  'Invoice INV-2026-04-123 for $4,780.42 was processed on 2026-04-10 against account ACCT-7788 for customer Jane Doe.',
  "Le service client a été exceptionnel. Je recommande cette entreprise à tous mes amis et collègues.",
];

export default function () {
  const payload = JSON.stringify({
    text: SAMPLE_TEXTS[Math.floor(Math.random() * SAMPLE_TEXTS.length)],
  });
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-functions-key': FUNCTION_KEY,
    },
    tags: { name: 'POST /api/enrich' },
  };

  const res = http.post(`${BASE_URL}/api/enrich`, payload, params);

  enrichLatency.add(res.timings.duration);
  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response has no error field': (r) => {
      try {
        return !('error' in JSON.parse(r.body));
      } catch (_) {
        return false;
      }
    },
  });
  enrichErrors.add(!ok);

  // Every 10th iteration, hit /api/health as a cheap liveness probe.
  if (Math.random() < 0.1) {
    http.get(`${BASE_URL}/api/health`, { tags: { name: 'GET /api/health' } });
  }

  sleep(Math.random() * 2 + 1);
}
