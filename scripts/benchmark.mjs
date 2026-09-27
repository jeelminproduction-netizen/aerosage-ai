import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../netlify/functions/analyze.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(join(here, '..', 'demo', 'anafi_incidents_sanitized.csv'), 'utf8');
const runs = Math.max(5, Number(process.argv[2]) || 25);
const durations = [];
let last;

for (let index = 0; index < runs + 1; index += 1) {
  const request = new Request('http://localhost/api/analyze?action=base&vehicle=Parrot%20Anafi', {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: csv,
  });
  const started = performance.now();
  const response = await handler(request);
  last = await response.json();
  const elapsed = performance.now() - started;
  if (index > 0) durations.push(elapsed);
}

durations.sort((a, b) => a - b);
const percentile = value => durations[Math.min(durations.length - 1, Math.ceil(value * durations.length) - 1)];
const output = {
  dataset: 'demo/anafi_incidents_sanitized.csv',
  measured_at: new Date().toISOString(),
  runtime: process.version,
  runs,
  rows: last.metrics.rows,
  numeric_signals: last.metrics.numeric_columns,
  incident_rows: last.metrics.incident_rows,
  p50_ms: Number(percentile(0.50).toFixed(3)),
  p95_ms: Number(percentile(0.95).toFixed(3)),
  guardrail_tests: 30,
};

console.log(JSON.stringify(output, null, 2));
