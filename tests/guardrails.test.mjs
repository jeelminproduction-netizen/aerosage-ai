import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = process.env.AEROSAGE_ANALYZE_PATH || join(here, '..', 'netlify', 'functions', 'analyze.mjs');
let source = readFileSync(sourcePath, 'utf8');
source = source.replace(/export\s+default\s+async\s*\(req\)\s*=>\s*\{/, 'async function __aerosageHandler(req) {');
if (/\bexport\s+default\b/.test(source)) {
  throw new Error('Could not instrument analyze.mjs for guardrail tests. The handler signature changed.');
}
source += `\n;globalThis.__AEROSAGE_TEST_API__ = { deriveEvidenceGuardrails, hypothesisDomain, applyEvidenceGuardrails, deterministicReport };`;
const sandbox = {};
vm.createContext(sandbox);
new vm.Script(source, { filename: sourcePath }).runInContext(sandbox);
const { deriveEvidenceGuardrails, hypothesisDomain, applyEvidenceGuardrails, deterministicReport } = sandbox.__AEROSAGE_TEST_API__;

function incidentPacket(values = {}) {
  return {
    incident_rows: [{
      row_index: 42,
      score: 10,
      reasons: ['cutout_episodes=1', 'emergency_state=1'],
      values: {
        cutout_episodes: 1,
        magneto_episodes: 0,
        angle_episodes: 0,
        critical_batt_episodes: 0,
        low_batt_episodes: 0,
        battery_min_pct: 38,
        wifi_weakest_dbm: -67,
        sat_median: 12,
        ...values,
      },
    }],
    metrics: { anomaly_count: 4, numeric_columns: 9, incident_rows: 1 },
  };
}

function checkedReport(packet, causes, risk = 'critical', confidence = 0.9) {
  packet.evidence_guardrails = deriveEvidenceGuardrails(packet);
  const fallback = deterministicReport(packet);
  const report = {
    ...fallback,
    risk_level: risk,
    confidence,
    likely_causes: causes.map(c => ({ ...c })),
  };
  return applyEvidenceGuardrails(report, packet, fallback);
}

test('targets the explicit cut-out row', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.deepEqual(Array.from(g.target_rows), [42]);
});

test('blocks magnetic disturbance when magneto_episodes=0', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.ok(g.blocked_domains.includes('magnetic'));
});

test('blocks attitude explanation when angle_episodes=0', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.ok(g.blocked_domains.includes('attitude'));
});

test('caps unsupported battery depletion at 25%', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.confidence_caps.battery_depletion, 0.25);
});

test('caps radio-link loss at 30% when Wi-Fi is not severely weak', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.confidence_caps.radio, 0.30);
});

test('caps GPS loss at 25% when satellite count is healthy', () => {
  const g = deriveEvidenceGuardrails(incidentPacket());
  assert.equal(g.confidence_caps.gps, 0.25);
});

test('removes a high-confidence magnetic hallucination', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.88, why: 'Compass interference may have caused the event.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.72, why: 'Motor telemetry shows a cut-out.' },
  ]);
  assert.equal(out.likely_causes.some(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'magnetic'), false);
  assert.ok(out.guardrail_filtered >= 1);
});

test('removes an unsupported attitude hallucination', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Attitude instability', confidence: 0.82, why: 'A sudden tilt may have caused shutdown.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit motor cut-out.' },
  ]);
  assert.equal(out.likely_causes.some(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'attitude'), false);
});

test('post-validation reduces battery depletion confidence to the telemetry cap', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Battery depletion', confidence: 0.91, why: 'The battery may have been exhausted.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ]);
  const cause = out.likely_causes.find(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'battery');
  assert.equal(cause.confidence, 0.25);
});

test('post-validation reduces radio-loss confidence to the telemetry cap', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Radio link loss', confidence: 0.89, why: 'Signal loss may have triggered the event.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ]);
  const cause = out.likely_causes.find(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'radio');
  assert.equal(cause.confidence, 0.30);
});

test('post-validation reduces GPS-loss confidence to the telemetry cap', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'GPS loss', confidence: 0.86, why: 'GNSS failure may have caused loss of control.' },
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ]);
  const cause = out.likely_causes.find(c => hypothesisDomain(`${c.cause} ${c.why}`) === 'gps');
  assert.equal(cause.confidence, 0.25);
});

test('restores propulsion evidence if the AI proposes only unsupported causes', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Magnetic disturbance', confidence: 0.95, why: 'Compass interference.' },
    { cause: 'Attitude instability', confidence: 0.90, why: 'Orientation failure.' },
  ]);
  assert.equal(hypothesisDomain(`${out.likely_causes[0].cause} ${out.likely_causes[0].why}`), 'propulsion');
  assert.equal(out.likely_causes[0].confidence, 0.94);
});

test('does not allow AI output to downgrade a critical deterministic risk', () => {
  const out = checkedReport(incidentPacket(), [
    { cause: 'Propulsion / motor cut-out event', confidence: 0.70, why: 'Explicit cut-out.' },
  ], 'medium', 0.40);
  assert.equal(out.risk_level, 'critical');
  assert.ok(out.confidence >= 0.92);
});

test('allows magnetic hypotheses when telemetry actually reports magnetic episodes', () => {
  const packet = incidentPacket({ magneto_episodes: 2 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.blocked_domains.includes('magnetic'), false);
});

test('does not cap battery depletion when a low-battery episode is present', () => {
  const packet = incidentPacket({ low_batt_episodes: 1 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.confidence_caps.battery_depletion, undefined);
});

test('does not cap radio loss when Wi-Fi crosses the severe threshold', () => {
  const packet = incidentPacket({ wifi_weakest_dbm: -85 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.confidence_caps.radio, undefined);
});

test('does not cap GPS loss when satellite count is poor', () => {
  const packet = incidentPacket({ sat_median: 4 });
  const g = deriveEvidenceGuardrails(packet);
  assert.equal(g.confidence_caps.gps, undefined);
});
