import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../netlify/functions/analyze.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const csv = readFileSync(join(here, '..', 'demo', 'anafi_incidents_sanitized.csv'), 'utf8');
const response = await handler(new Request('http://localhost/api/analyze?action=base&vehicle=Parrot%20Anafi', {
  method: 'POST',
  headers: { 'content-type': 'text/csv' },
  body: csv,
}));
const report = await response.json();
const probe = report.validation_probe;
const magnetic = report.evidence_provenance?.authoritative_signals?.find(item => item.field === 'magneto_episodes');
const replayResponse = await handler(new Request(`http://localhost/api/analyze?action=replay&vehicle=Parrot%20Anafi&expected=${report.deterministic_replay?.verdict_sha256 || ''}`, {
  method: 'POST',
  headers: { 'content-type': 'text/csv' },
  body: csv,
}));
const replay = await replayResponse.json();

const valid = response.ok
  && replayResponse.ok
  && probe?.hypothesis === 'Magnetic disturbance'
  && probe?.proposed_confidence === 0.88
  && probe?.verdict === 'REJECTED'
  && magnetic?.values?.every(value => value === 0)
  && /^[a-f0-9]{64}$/.test(report.evidence_manifest?.csv_sha256 || '')
  && /^[a-f0-9]{64}$/.test(report.deterministic_replay?.verdict_sha256 || '')
  && replay.replay_verification?.status === 'MATCH';

console.log(`Evidence SHA-256: ${report.evidence_manifest?.csv_sha256 || 'missing'}`);
console.log(`Ruleset: ${report.evidence_manifest?.guardrail_ruleset || 'missing'}`);
console.log(`Hypothesis: ${probe?.hypothesis || 'missing'} — ${Math.round((probe?.proposed_confidence || 0) * 100)}%`);
console.log(`Telemetry: ${probe?.telemetry_evidence || 'missing'}`);
console.log(`Rule: ${probe?.rule || 'missing'}`);
console.log(`Verdict: ${probe?.verdict || 'missing'}`);
console.log(`Deterministic verdict SHA-256: ${report.deterministic_replay?.verdict_sha256 || 'missing'}`);
console.log(`Replay: ${replay.replay_verification?.status || 'missing'} — ${replay.replay_verification?.statement || 'missing'}`);

if (!valid) {
  console.error('FAIL: deterministic verdict could not be reproduced.');
  process.exit(1);
}

console.log('PASS: deterministic verdict reproduced from the committed demo CSV.');
