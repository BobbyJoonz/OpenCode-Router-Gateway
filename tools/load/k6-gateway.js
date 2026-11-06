/**
 * k6 load test for the OpenAI-compatible gateway.
 *
 *   k6 run tools/load/k6-gateway.js \
 *     -e BASE_URL=https://api.example.com/v1 \
 *     -e API_KEY=sk-or-... \
 *     -e MODEL=gpt-4o-mini \
 *     -e VUS=50 -e DURATION=10m
 *
 * Acceptance (Scenario B):
 *   http_req_failed < 0.1%
 *   no 5xx from the gateway itself
 *   gateway process RSS growth < 5% over the run
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000/v1';
const API_KEY = __ENV.API_KEY || '';
const MODEL = __ENV.MODEL || 'gpt-4o-mini';
const VUS = parseInt(__ENV.VUS || '50', 10);
const DURATION = __ENV.DURATION || '10m';

const gatewayErrors = new Rate('gateway_5xx');
const completionLatency = new Trend('completion_latency_ms');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    gateway_5xx: ['rate<0.001'],
    completion_latency_ms: ['p(95)<15000']
  }
};

export default function () {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: LOAD_OK' }],
    max_tokens: 16
  });

  const res = http.post(`${BASE_URL}/chat/completions`, payload, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`
    },
    timeout: '60s'
  });

  completionLatency.add(res.timings.duration);
  gatewayErrors.add(res.status >= 500);

  check(res, {
    'status is 200 or a deliberate 4xx/429': (r) => r.status === 200 || r.status === 429 || (r.status >= 400 && r.status < 500),
    'no 5xx from the gateway': (r) => r.status < 500,
    'body is JSON': (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    }
  });

  sleep(0.2);
}
